#!/usr/bin/env node
// Dependency-licence check and third-party notices for everything CountRoster
// ships: the Go binaries (server + mobile engine), the web client's
// production npm packages, and the Android shell's Gradle dependencies.
//
//   node scripts/licenses.mjs check            # fail on any non-permissive dependency
//   node scripts/licenses.mjs notices <file>   # check, then write the notices file
//
// The web build runs `notices` into apps/web/public/third-party-notices.txt,
// which the app links from the Data page. Policy and rationale: LICENSING.md.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  androidGroupLicense,
  classify,
  gradleDependencies,
  isAllowed,
  npmComponents,
  renderNotices,
} from './licenses-lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LICENSE_FILE = /^(licen[cs]e|copying|notice)/i;

function licenseTexts(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f))
    .sort((a, b) => a.length - b.length || a.localeCompare(b)) // LICENSE before LICENSE-3RD-PARTY…
    .map((f) => readFileSync(join(dir, f), 'utf8'));
}

function goComponents() {
  const server = join(root, 'server');
  const out = execFileSync(
    'go',
    ['list', '-deps', '-f', '{{with .Module}}{{.Path}}\t{{.Version}}\t{{.Dir}}\t{{.Main}}{{end}}', './cmd/countroster', './cmd/engine'],
    { cwd: server, encoding: 'utf8' },
  );
  const seen = new Map();
  for (const line of out.split('\n')) {
    const [path, version, dir, main] = line.split('\t');
    if (!path || main === 'true' || seen.has(path)) continue;
    const texts = licenseTexts(dir);
    seen.set(path, {
      section: 'Server and on-device engine (Go)',
      name: path,
      version,
      license: texts[0] ? classify(texts[0]) : null,
      texts,
    });
  }
  // From server/, so its go.mod's toolchain is the one asked — the one that builds.
  const goroot = execFileSync('go', ['env', 'GOROOT'], { cwd: server, encoding: 'utf8' }).trim();
  const std = licenseTexts(goroot);
  return [
    {
      section: 'Server and on-device engine (Go)',
      name: 'Go standard library',
      version: execFileSync('go', ['env', 'GOVERSION'], { cwd: server, encoding: 'utf8' }).trim(),
      license: std[0] ? classify(std[0]) : null,
      texts: std.slice(0, 1),
    },
    ...[...seen.values()].sort((a, b) => a.name.localeCompare(b.name)),
  ];
}

function webComponents() {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  return npmComponents(lock).map((c) => ({
    section: 'Web client (npm)',
    name: c.name,
    version: c.version,
    license: c.license,
    texts: licenseTexts(join(root, c.path)),
  }));
}

function androidComponents() {
  const gradle = readFileSync(join(root, 'apps/android/app/build.gradle.kts'), 'utf8');
  const apache = readFileSync(join(root, 'scripts/licenses/Apache-2.0.txt'), 'utf8');
  const deps = [...gradleDependencies(gradle), { group: 'org.jetbrains.kotlin', artifact: 'kotlin-stdlib', version: '' }];
  return deps.map((d) => {
    const known = androidGroupLicense(d.group);
    return {
      section: 'Android app (Gradle)',
      name: `${d.group}:${d.artifact}${known ? ` (${known.name})` : ''}`,
      version: d.version,
      license: known?.license ?? null,
      texts: known?.license === 'Apache-2.0' ? [apache] : [],
    };
  });
}

function collect() {
  const all = [...goComponents(), ...webComponents(), ...androidComponents()];
  const bad = all.filter((c) => !isAllowed(c.license));
  const missingText = all.filter((c) => c.texts.length === 0);
  return { all, bad, missingText };
}

function report({ all, bad, missingText }) {
  const counts = {};
  for (const c of all) counts[c.license ?? 'unknown'] = (counts[c.license ?? 'unknown'] ?? 0) + 1;
  console.log(`${all.length} shipped third-party components:`, counts);
  for (const c of bad) {
    console.error(`  NOT ALLOWED: ${c.section}: ${c.name} ${c.version} — ${c.license ?? 'unrecognized licence'}`);
  }
  for (const c of missingText) {
    console.error(`  NO LICENCE TEXT: ${c.section}: ${c.name} ${c.version}`);
  }
  if (bad.length || missingText.length) {
    console.error(
      '\nEvery shipped dependency must be permissive and carry its licence text, or the\n' +
        "project can't be dual-licensed (see LICENSING.md). Remove it, or get a review.",
    );
    return false;
  }
  return true;
}

const [cmd, out] = process.argv.slice(2);
if (cmd === 'check') {
  process.exit(report(collect()) ? 0 : 1);
} else if (cmd === 'notices' && out) {
  const result = collect();
  if (!report(result)) process.exit(1);
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(resolve(out), renderNotices(result.all));
  console.log(`wrote ${out}`);
} else {
  console.error('usage: licenses.mjs check | notices <file>');
  process.exit(2);
}
