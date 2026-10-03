import { describe, it, expect, afterEach, vi } from 'vitest';
import { nativeBridge } from './platform.ts';
import { downloadBackup } from '../api/client.ts';

/**
 * A stand-in host: records requests and answers them the way the Android
 * shell does — asynchronously, through window.__countrosterNativeReply.
 */
function installHost(capabilities: string[], answer: (method: string, args: unknown) => [boolean, unknown]) {
  const sent: { method: string; args: unknown }[] = [];
  window.CountRosterNative = {
    capabilities: () => JSON.stringify(capabilities),
    postMessage: (json: string) => {
      const { id, method, args } = JSON.parse(json) as { id: number; method: string; args: unknown };
      sent.push({ method, args });
      const [ok, value] = answer(method, args);
      setTimeout(() => window.__countrosterNativeReply?.(id, ok, value), 0);
    },
  };
  return sent;
}

afterEach(() => {
  delete window.CountRosterNative;
  delete window.__countrosterNativeReply;
  vi.unstubAllGlobals();
});

describe('nativeBridge', () => {
  it('is null in a plain browser', () => {
    expect(nativeBridge()).toBeNull();
  });

  it('reports the capabilities the host declares', () => {
    installHost(['saveUrl'], () => [true, true]);
    const bridge = nativeBridge();
    expect(bridge?.has('saveUrl')).toBe(true);
    expect(bridge?.has('pinShortcut')).toBe(false);
  });

  it('round-trips requests and their replies', async () => {
    const sent = installHost(['saveUrl', 'pinShortcut'], (method) =>
      method === 'saveUrl' ? [true, false] : [true, true],
    );
    const bridge = nativeBridge()!;
    // Two in flight at once resolve to their own replies.
    const [saved, pinned] = await Promise.all([
      bridge.saveUrl('/api/backup/bundle', 'x.zip'),
      bridge.pinShortcut({ id: 't1', name: 'Water', color: '#00f' }),
    ]);
    expect(saved).toBe(false); // the user cancelled the picker
    expect(pinned).toBe(true);
    expect(sent).toEqual([
      { method: 'saveUrl', args: { path: '/api/backup/bundle', suggestedName: 'x.zip' } },
      { method: 'pinShortcut', args: { id: 't1', name: 'Water', color: '#00f' } },
    ]);
  });

  it('rejects with the host’s message, and refuses what it doesn’t offer', async () => {
    installHost(['saveUrl'], () => [false, 'No space left']);
    const bridge = nativeBridge()!;
    await expect(bridge.saveUrl('/a', 'b')).rejects.toThrow('No space left');
    await expect(bridge.pinShortcut({ id: 'x', name: 'y', color: 'z' })).rejects.toThrow();
  });

  it('survives a host with garbled capabilities', () => {
    window.CountRosterNative = { capabilities: () => 'nope', postMessage: () => {} };
    expect(nativeBridge()?.has('saveUrl')).toBe(false);
  });
});

describe('downloadBackup inside the app', () => {
  it('hands the URL to the app instead of fetching a blob', async () => {
    const sent = installHost(['saveUrl'], () => [true, true]);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await downloadBackup('/api/backup/bundle', 'countroster.countroster.zip');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sent).toEqual([
      {
        method: 'saveUrl',
        args: { path: '/api/backup/bundle', suggestedName: 'countroster.countroster.zip' },
      },
    ]);
  });
});
