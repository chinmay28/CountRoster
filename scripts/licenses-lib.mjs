// The dependency-licence policy and the third-party notices, as small pure
// functions so they can be tested (scripts/licenses.test.mjs). The CLI is
// scripts/licenses.mjs. See LICENSING.md for why this matters: the
// maintainer can relicense only code the project owns, so every dependency
// that ships must be permissive.

/** Licences any shipped dependency may carry (SPDX ids). */
export const ALLOWED = new Set([
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  '0BSD',
  'Unlicense',
  'CC0-1.0',
  'BlueOak-1.0.0',
  'Zlib',
]);

/**
 * Is an SPDX expression allowed? "A OR B" needs one allowed side (the
 * recipient may choose it); "A AND B" needs both.
 */
export function isAllowed(expr) {
  if (!expr) return false;
  const e = expr.trim().replace(/^\((.*)\)$/, '$1');
  if (/\s+OR\s+/i.test(e)) return e.split(/\s+OR\s+/i).some(isAllowed);
  if (/\s+AND\s+/i.test(e)) return e.split(/\s+AND\s+/i).every(isAllowed);
  return ALLOWED.has(e);
}

/**
 * Identify a licence from its text — for Go modules, which declare no SPDX
 * id. Copyleft families are named so the failure says what was found; null
 * means "unrecognized", which fails the check too (a human should look).
 */
export function classify(text) {
  const t = text.replace(/\s+/g, ' ');
  if (/GNU AFFERO GENERAL PUBLIC LICENSE/i.test(t)) return 'AGPL';
  if (/GNU LESSER GENERAL PUBLIC LICENSE|GNU LIBRARY GENERAL PUBLIC/i.test(t)) return 'LGPL';
  if (/GNU GENERAL PUBLIC LICENSE/i.test(t)) return 'GPL';
  if (/Mozilla Public License/i.test(t)) return 'MPL';
  if (/Apache License,? Version 2\.0/i.test(t)) return 'Apache-2.0';
  if (/Permission is hereby granted, free of charge, to any person obtaining a copy/i.test(t)) return 'MIT';
  if (/Permission to use, copy, modify, and(?:\/or)? distribute this software for any purpose with or without fee is hereby granted/i.test(t)) {
    return /provided that the above copyright notice/i.test(t) ? 'ISC' : '0BSD';
  }
  if (/Redistribution and use in source and binary forms/i.test(t)) {
    return /Neither the name|names of its contributors may be used/i.test(t) ? 'BSD-3-Clause' : 'BSD-2-Clause';
  }
  if (/This is free and unencumbered software released into the public domain/i.test(t)) return 'Unlicense';
  return null;
}

/**
 * Production npm packages from a package-lock (v2/v3): everything not marked
 * dev, minus the workspaces themselves (links).
 */
export function npmComponents(lock) {
  const out = [];
  for (const [path, meta] of Object.entries(lock.packages ?? {})) {
    if (!path.includes('node_modules/') || meta.dev || meta.link) continue;
    out.push({
      name: path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length),
      version: meta.version ?? '',
      license: meta.license ?? null,
      path,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** What the Android shell links, from app/build.gradle.kts. */
export function gradleDependencies(buildGradle) {
  const out = [];
  for (const m of buildGradle.matchAll(/^\s*implementation\("([^":]+):([^":]+):([^"]+)"\)/gm)) {
    out.push({ group: m[1], artifact: m[2], version: m[3] });
  }
  return out;
}

/**
 * Licences of the Android shell's dependency groups. Gradle carries no
 * licence metadata the check can read offline, so groups are listed here; a
 * dependency from an unlisted group fails the check until someone looks.
 */
export const ANDROID_GROUP_LICENSES = [
  { prefix: 'androidx.', license: 'Apache-2.0', name: 'AndroidX (Android Jetpack)' },
  { prefix: 'org.jetbrains.kotlin', license: 'Apache-2.0', name: 'Kotlin standard library' },
  { prefix: 'org.jetbrains.kotlinx', license: 'Apache-2.0', name: 'Kotlin extensions' },
];

export function androidGroupLicense(group) {
  return ANDROID_GROUP_LICENSES.find((g) => group === g.prefix.replace(/\.$/, '') || group.startsWith(g.prefix)) ?? null;
}

/** Render the notices file. components: {section, name, version, license, texts[]} */
export function renderNotices(components) {
  const rule = '='.repeat(78);
  const lines = [
    'CountRoster — third-party software notices',
    '',
    'CountRoster is free software, licensed under the GNU Affero General Public',
    'License v3.0 (AGPL-3.0-only). Source: https://github.com/chinmay28/CountRoster',
    '(The maintainer may also distribute builds under other terms — see',
    'LICENSING.md in the source.)',
    '',
    'It includes the following third-party software, each under its own licence,',
    'reproduced below as those licences require.',
  ];
  let section = null;
  for (const c of components) {
    if (c.section !== section) {
      section = c.section;
      lines.push('', rule, `${section}`, rule);
    }
    lines.push('', `${c.name}${c.version ? ' ' + c.version : ''} — ${c.license}`, '-'.repeat(78));
    for (const text of c.texts) lines.push(text.trimEnd(), '');
  }
  return lines.join('\n') + '\n';
}
