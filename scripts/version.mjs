#!/usr/bin/env node
/**
 * The one place the app's version number is assembled.
 *
 * Scheme: vYEAR.MONTH.PATCH — a calendar version taken entirely from the
 * commit being built, never from the build clock:
 *
 *   - YEAR.MONTH is the month of HEAD's committer date, in UTC (the same
 *     reading Go makes of the vcs.time it embeds, so the two can't disagree
 *     at a month boundary). The version moves to a new month by itself, with
 *     the first commit made in it — nothing to bump.
 *   - PATCH is `git rev-list --count HEAD`, the repository's commit count, so
 *     every commit is a patch release and the number only ever grows (the
 *     Android versionCode relies on that).
 *
 * The same commit therefore always builds the same version, which is what
 * lets the release workflow refuse a tag that isn't its commit's version. The
 * month is not zero-padded; that keeps the string valid semver.
 *
 * Usage:
 *   node scripts/version.mjs            # print e.g. v2026.10.512
 *   node scripts/version.mjs --patch    # print just the commit count (512)
 *   node scripts/version.mjs --ldflags  # the -X flags that stamp the Go binary
 *   import { appVersion } from './scripts/version.mjs'
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GO_VERSION_PKG = 'github.com/chinmay28/countroster/server/internal/version';

/**
 * YEAR and MONTH of HEAD's committer date, in UTC — or 0.0 with no git to ask,
 * matching the Go binary's unstamped fallback.
 */
export function yearMonth() {
  const seconds = Number(git(['log', '-1', '--format=%ct', 'HEAD']));
  if (!Number.isFinite(seconds) || seconds <= 0) return { year: 0, month: 0 };
  const d = new Date(seconds * 1000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

/** Run git in the repo root; null if it fails (no repo, no git, old git). */
function git(args) {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * The commit count on HEAD, or '0' when it can't be known — no repo (a tarball,
 * or a `COPY` that skipped `.git`), no git, or a **shallow** clone.
 *
 * Shallow is the trap, and it's why this isn't a bare `rev-list`: a clone made
 * with `--depth 1` answers `rev-list --count HEAD` with `1`, which is not an
 * error and not obviously wrong — it just quietly ships a build calling itself
 * `v2026.10.1`. Refuse it. Patch 0 is the agreed "unstamped build" marker (it
 * matches the Go default), and a version ending in `.0` is visibly a
 * non-release rather than a plausible lie.
 *
 * Anything building a release therefore needs the full commit graph:
 * `fetch-depth: 0` on GitHub Actions, `--filter=blob:none` rather than
 * `--depth 1` for a cheap clone that still carries all of it.
 */
export function commitCount() {
  if (git(['rev-parse', '--is-shallow-repository']) === 'true') {
    process.emitWarning(
      'shallow git clone — the commit count is not the real one, reporting patch 0. ' +
        'Clone with --filter=blob:none (or fetch --unshallow) for a real version.',
    );
    return '0';
  }
  // A failed probe (git older than 2.15, or no repo at all) is not proof of
  // shallowness — fall through and let the count itself answer.
  return git(['rev-list', '--count', 'HEAD']) ?? '0';
}

/**
 * The full version string, `v`-prefixed to match how the project tags releases
 * (v2026.10.512). Must stay byte-identical to version.String() in the Go
 * package, which renders the values ldflags() stamps into it.
 */
export function appVersion() {
  const { year, month } = yearMonth();
  return `v${year}.${month}.${commitCount()}`;
}

/** The `go build -ldflags` value that stamps this version into the binary. */
export function ldflags() {
  const { year, month } = yearMonth();
  return [
    `-X ${GO_VERSION_PKG}.Year=${year}`,
    `-X ${GO_VERSION_PKG}.Month=${month}`,
    `-X ${GO_VERSION_PKG}.Patch=${commitCount()}`,
  ].join(' ');
}

// Invoked directly (by the build scripts), print rather than export.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2];
  process.stdout.write(arg === '--patch' ? commitCount() : arg === '--ldflags' ? ldflags() : appVersion());
  process.stdout.write('\n');
}
