#!/usr/bin/env node
/**
 * The one place the app's version number is assembled.
 *
 * Scheme: MAJOR.MINOR.PATCH, where PATCH is the repository's commit count —
 * every commit is a patch release, so `1.1.311` is the 311th commit on the
 * 1.1 line.
 *
 *   - MAJOR/MINOR are source constants, read out of
 *     server/internal/version/version.go so there is exactly one declaration
 *     of them in the tree. Bump them there.
 *   - PATCH comes from `git rev-list --count HEAD`, which only exists at build
 *     time: the Go binary gets it stamped in via -ldflags, the web bundle gets
 *     it inlined by Vite. Both call this file, so they can never disagree.
 *
 * Usage:
 *   node scripts/version.mjs            # print e.g. 1.1.50
 *   node scripts/version.mjs --patch    # print just the commit count
 *   import { appVersion } from './scripts/version.mjs'
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GO_VERSION_FILE = resolve(repoRoot, 'server/internal/version/version.go');

/** Read `Major`/`Minor` out of the Go source that declares them. */
function majorMinor() {
  const src = readFileSync(GO_VERSION_FILE, 'utf8');
  const read = (name) => {
    const m = new RegExp(`^\\s*${name}\\s*=\\s*(\\d+)\\s*$`, 'm').exec(src);
    if (!m) {
      throw new Error(`could not find ${name} in ${GO_VERSION_FILE}`);
    }
    return Number(m[1]);
  };
  return { major: read('Major'), minor: read('Minor') };
}

/**
 * The commit count on HEAD. Returns '0' when git can't answer — no repo (a
 * tarball or `COPY` without `.git`), or git missing. Patch 0 is the agreed
 * marker for an unstamped development build, matching the Go default.
 *
 * A shallow clone counts only the commits it fetched, so CI that builds
 * releases needs `fetch-depth: 0` for the number to mean anything.
 */
export function commitCount() {
  try {
    return execFileSync('git', ['rev-list', '--count', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '0';
  }
}

/** The full MAJOR.MINOR.PATCH version string. */
export function appVersion() {
  const { major, minor } = majorMinor();
  return `${major}.${minor}.${commitCount()}`;
}

// Invoked directly (by the build scripts), print rather than export.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.stdout.write(process.argv.includes('--patch') ? commitCount() : appVersion());
  process.stdout.write('\n');
}
