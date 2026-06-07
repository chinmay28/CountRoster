// All-in-one verification: boot the core in-process, seed data, serve the built
// PWA, and screenshot it at mobile + desktop viewports. Single foreground
// process (no backgrounded server) so nothing gets reaped mid-run.
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import express from 'express';
import { boot } from '../apps/server/dist/boot.js';
import { buildApp } from '../apps/server/dist/app.js';
import { chromium } from 'playwright';

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const WEB_DIST = resolve('apps/web/dist');
const OUT = '/tmp/shots';
const EXE = process.env.CR_CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
mkdirSync(OUT, { recursive: true });

const DB = '/tmp/cr-verify.sqlite';

function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function seed(core) {
  const g = await core.groups.create({ name: 'Health', sort_order: 0 });
  const mk = (i) => core.trackers.create(i);
  const water = await mk({ name: 'Water', kind: 'number', unit: 'cups', color: '#4ECDC4', default_value: 1, reset_period: 'daily', target: 8 });
  const push = await mk({ name: 'Pushups', kind: 'count', color: '#f9844a', default_value: 10, reset_period: 'daily' });
  const coffee = await mk({ name: 'Coffee', kind: 'count', color: '#8d6e63', default_value: 1, reset_period: 'daily', target: 3 });
  const spend = await mk({ name: 'Spending', kind: 'number', unit: '$', color: '#e63946', default_value: 5, reset_period: 'monthly', target: 300 });
  await mk({ name: 'Mood', kind: 'count', color: '#9b5de5', default_value: 1, reset_period: 'never' });
  for (const t of [water, push, coffee]) await core.groups.addTracker(g.id, t.id);
  for (let d = 0; d < 14; d++) {
    const dt = new Date();
    dt.setDate(dt.getDate() - d);
    dt.setHours(9, 30, 0, 0);
    const iso = dt.toISOString().replace('Z', '-07:00');
    await core.entries.log(water.id, { value: rand(3, 8), occurred_at: iso });
    await core.entries.log(push.id, { value: rand(10, 40), occurred_at: iso });
    await core.entries.log(coffee.id, { value: rand(1, 3), occurred_at: iso });
    await core.entries.log(spend.id, { value: rand(5, 45), occurred_at: iso });
  }
  await core.notes.create({ tracker_id: water.id, body: 'Felt great after the morning run.' });
  return { waterId: water.id };
}

async function settle(page) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(700);
}

async function main() {
  if (existsSync(DB)) {
    const { rmSync } = await import('node:fs');
    rmSync(DB);
  }
  const { core, adapter, schemaVersion } = await boot(DB);
  console.log('booted core, schema v' + schemaVersion);
  const { waterId } = await seed(core);
  console.log('seeded, water=' + waterId);

  const app = buildApp(core, { fileSource: { path: adapter.path } });
  app.use(express.static(WEB_DIST));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api')) return next();
    res.sendFile(join(WEB_DIST, 'index.html'));
  });
  const server = await new Promise((res) => {
    const s = app.listen(PORT, '127.0.0.1', () => res(s));
  });
  console.log('listening on ' + BASE);

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
  server.close();
  adapter.close();
  console.log('DONE');
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
