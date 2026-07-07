// All-in-one verification: launch the Go server binary against a throwaway
// DB, seed data over the REST API (exactly what the UI does), and screenshot
// the served PWA at mobile + desktop viewports.
//
// Prereqs: `npm run build` (web dist + server binary) — or set CR_SERVER_BIN.
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const SERVER_BIN = process.env.CR_SERVER_BIN || resolve('server/bin/countroster');
const WEB_DIST = resolve('apps/web/dist');
const OUT = '/tmp/shots';
const EXE = process.env.CR_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
mkdirSync(OUT, { recursive: true });

const DB = '/tmp/cr-verify.sqlite';

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    ...(body !== undefined
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : undefined;
}

async function seed() {
  const g = await api('POST', '/api/groups', { name: 'Health', sort_order: 0 });
  const mk = (i) => api('POST', '/api/trackers', i);
  const water = await mk({ name: 'Water', kind: 'number', unit: 'cups', color: '#4ECDC4', default_value: 1, reset_period: 'daily', target: 8 });
  const push = await mk({ name: 'Pushups', kind: 'count', color: '#f9844a', default_value: 10, reset_period: 'daily' });
  const coffee = await mk({ name: 'Coffee', kind: 'count', color: '#8d6e63', default_value: 1, reset_period: 'daily', target: 3 });
  const spend = await mk({ name: 'Spending', kind: 'number', unit: '$', color: '#e63946', default_value: 5, reset_period: 'monthly', target: 300 });
  await mk({ name: 'Mood', kind: 'count', color: '#9b5de5', default_value: 1, reset_period: 'never' });
  for (const t of [water, push, coffee]) {
    await api('POST', `/api/groups/${g.id}/trackers`, { tracker_id: t.id });
  }
  for (let d = 0; d < 14; d++) {
    const dt = new Date();
    dt.setDate(dt.getDate() - d);
    dt.setHours(9, 30, 0, 0);
    const iso = dt.toISOString().replace('Z', '-07:00');
    for (const [t, lo, hi] of [[water, 3, 8], [push, 10, 40], [coffee, 1, 3], [spend, 5, 45]]) {
      await api('POST', `/api/trackers/${t.id}/entries`, { value: rand(lo, hi), occurred_at: iso });
    }
  }
  await api('POST', '/api/notes', { tracker_id: water.id, body: 'Felt great after the morning run.' });
  return { waterId: water.id };
}

async function waitForHealth() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server never became healthy');
}

async function settle(page) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(700);
}

async function main() {
  if (!existsSync(SERVER_BIN)) {
    throw new Error(`no server binary at ${SERVER_BIN} — run: npm run build:server`);
  }
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) {
    if (existsSync(f)) rmSync(f);
  }
  const server = spawn(SERVER_BIN, [], {
    env: { ...process.env, COUNTROSTER_DB: DB, PORT: String(PORT), HOST: '127.0.0.1', WEB_DIST },
    stdio: 'inherit',
  });
  try {
    await waitForHealth();
    console.log('server healthy on ' + BASE);
    const { waterId } = await seed();
    console.log('seeded, water=' + waterId);

    const browser = await chromium.launch({ executablePath: EXE, headless: true });

    const mobile = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
    });
    const m = await mobile.newPage();
    await m.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await settle(m);
    await m.screenshot({ path: `${OUT}/mobile-home.png` });
    console.log('shot: mobile-home');

    await m.locator('.tracker-card__log-toggle').first().click();
    await m.waitForTimeout(400);
    await m.screenshot({ path: `${OUT}/mobile-card-log.png` });
    console.log('shot: mobile-card-log');

    await m.goto(`${BASE}/trackers/${waterId}`, { waitUntil: 'domcontentloaded' });
    await settle(m);
    await m.screenshot({ path: `${OUT}/mobile-detail.png`, fullPage: true });
    console.log('shot: mobile-detail');

    await m.goto(`${BASE}/groups`, { waitUntil: 'domcontentloaded' });
    await settle(m);
    await m.screenshot({ path: `${OUT}/mobile-groups.png` });
    console.log('shot: mobile-groups');
    await mobile.close();

    const desktop = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const d = await desktop.newPage();
    await d.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await settle(d);
    await d.screenshot({ path: `${OUT}/desktop-home.png` });
    console.log('shot: desktop-home');
    await desktop.close();

    await browser.close();
    console.log('DONE');
  } finally {
    server.kill('SIGTERM');
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
