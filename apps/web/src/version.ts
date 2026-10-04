/**
 * The running client's version, `vYEAR.MONTH.PATCH` — a calendar version taken
 * from the commit it was built from: the month it was committed (UTC) and the
 * repository's commit count (so `v2026.10.512` is commit 512, from October).
 *
 * Inlined at build time by Vite's `define` (see vite.config.ts) from
 * scripts/version.mjs — the same source the Go binary is stamped from, so the
 * header and `/api/health` always agree. Patch `0` means a build without the
 * full git history (or no git at all).
 */
declare const __APP_VERSION__: string;

export const APP_VERSION: string = __APP_VERSION__;
