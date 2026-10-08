// G2 (2026-10-08, A1 agent-mérés) — brave_page: JS-dialógus-politika + a JS-eredmény plafonja.
//
// A mért hibák: (1) a brave_page MINDEN megerősítő dialógust elutasított (a „JS Confirm → OK"
// feladat elvben megoldhatatlan volt, és a hívó csak egy warningot látott); (2) a
// BRAVE_PAGE_MAX_JS_RESULT_CHARS alapja (262 144) kisebb volt, mint az engine pillanatkép-
// szkriptjének vágása (800 000 jel) → minden nagy lap pillanatképe eldobódott.
//
// Böngészős teszt a helyi fixture-szerverrel (a brave-page.test.js mintájára: teszt-kivétel a
// loopbackre). Böngésző nélkül kimarad.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findBrowser, startFixture } from './helpers.js';

const browserPath = findBrowser();
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'g2-profiles-'));
Object.assign(process.env, {
  NODE_ENV: 'test',
  BRAVE_EGRESS_ALLOW_TEST_LOOPBACK: '1',
  HEADLESS: 'true',
  BRAVE_WATCHDOG_DISABLED: 'true',
  BRAVE_PAGE_PROFILE_DIR: profileDir,
});
for (const k of Object.keys(process.env)) if (k.startsWith('RAILWAY_')) delete process.env[k];
delete process.env.BRAVE_PAGE_MAX_JS_RESULT_CHARS;
if (browserPath) process.env.BRAVE_PATH = browserPath;

const ROUTES = {
  '/confirm': `<!doctype html><title>Confirm</title>
    <button id="c" onclick="document.getElementById('r').textContent = confirm('Biztosan?') ? 'OK' : 'Cancel'">c</button>
    <button id="p" onclick="document.getElementById('r').textContent = String(prompt('Neved?', 'alap'))">p</button>
    <div id="r">-</div>`,
  '/alert': `<!doctype html><title>Alert</title><script>alert('hi');document.title='after-alert'</script>`,
};

let fx, c;

test.before(async () => {
  if (!browserPath) return;
  fx = await startFixture(ROUTES);
  const { BraveController } = await import('../src/brave-controller.js');
  c = new BraveController();
  await c.initialize();
});

test.after(async () => {
  if (c) await c.close();
  if (fx) await fx.close();
  fs.rmSync(profileDir, { recursive: true, force: true });
});

const skip = !browserPath && 'nincs böngésző (BRAVE_PATH)';
const run = (args) => c.pageTool(args);
const eredmeny = (r) => r.action_results.find(a => a.type === 'executeJavascript')?.js_result;

test('dialógus: alapból dismiss (régi viselkedés), a kezelés az akció eredményében is látszik', { skip }, async () => {
  const r = await run({
    url: `${fx.base}/confirm`,
    actions: [{ type: 'click', selector: '#c' }, { type: 'executeJavascript', script: "document.getElementById('r').textContent" }],
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(eredmeny(r), 'Cancel');
  assert.ok(r.warnings.some(w => w === 'dialog_dismissed: confirm'), JSON.stringify(r.warnings));
  assert.deepEqual(r.action_results[0].dialogs, [{ type: 'confirm', action: 'dismiss', message: 'Biztosan?' }]);
  assert.deepEqual(r.dialogs, [{ type: 'confirm', action: 'dismiss', message: 'Biztosan?' }]);
  // a betöltéskor felbukkanó alert is (régi teszt-eset, változatlan figyelmeztetéssel)
  const al = await run({ url: `${fx.base}/alert` });
  assert.equal(al.title, 'after-alert');
  assert.ok(al.warnings.some(w => w.startsWith('dialog_dismissed')));
});

test('dialógus: dialog=accept → a confirm OK-t kap; a munkamenet megjegyzi a politikát', { skip }, async () => {
  const r = await run({
    url: `${fx.base}/confirm`, keep_session: true, dialog: 'accept',
    actions: [{ type: 'click', selector: '#c' }, { type: 'executeJavascript', script: "document.getElementById('r').textContent" }],
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(eredmeny(r), 'OK');
  assert.ok(r.warnings.some(w => w === 'dialog_accepted: confirm'), JSON.stringify(r.warnings));
  assert.ok(!r.warnings.some(w => w.startsWith('dialog_dismissed')), JSON.stringify(r.warnings));
  assert.equal(r.action_results[0].dialogs[0].action, 'accept');
  const sid = r.session_id;
  assert.ok(sid);
  try {
    // a következő hívás `dialog` nélkül: a munkamenet politikája (accept) marad; a prompt az
    // alapértékkel fogadódik el
    const r2 = await run({
      session_id: sid, keep_session: true,
      actions: [{ type: 'click', selector: '#p' }, { type: 'executeJavascript', script: "document.getElementById('r').textContent" }],
    });
    assert.equal(r2.ok, true, r2.error);
    assert.equal(eredmeny(r2), 'alap');
    assert.deepEqual(r2.action_results[0].dialogs, [{ type: 'prompt', action: 'accept', message: 'Neved?' }]);
    // visszaállítás dismiss-re ugyanabban a munkamenetben
    const r3 = await run({
      session_id: sid, keep_session: true, dialog: 'dismiss',
      actions: [{ type: 'click', selector: '#c' }, { type: 'executeJavascript', script: "document.getElementById('r').textContent" }],
    });
    assert.equal(eredmeny(r3), 'Cancel');
  } finally {
    await run({ session_id: sid, close: true });
  }
});

test('dialógus: érvénytelen politika → kimondott warning, a régi (dismiss) marad', { skip }, async () => {
  const r = await run({
    url: `${fx.base}/confirm`, dialog: 'yes',
    actions: [{ type: 'click', selector: '#c' }, { type: 'executeJavascript', script: "document.getElementById('r').textContent" }],
  });
  assert.ok(r.warnings.some(w => w.startsWith('dialog_policy_invalid')), JSON.stringify(r.warnings));
  assert.equal(eredmeny(r), 'Cancel');
});

test('js_result plafon: az alap 2 000 000 — egy 400 000 jeles eredmény (a régi 262 144 fölött) átmegy', { skip }, async () => {
  const r = await run({
    url: `${fx.base}/confirm`,
    actions: [{ type: 'executeJavascript', script: "'\"x'.repeat(200000)" }],
  });
  assert.equal(r.ok, true, r.error);
  assert.ok(!r.warnings.some(w => w.startsWith('js_result_dropped')), JSON.stringify(r.warnings));
  assert.equal(r.action_results[0].js_result.length, 400000);
  // a plafon fölött továbbra is kimondott eldobás (nem néma)
  const nagy = await run({
    url: `${fx.base}/confirm`,
    actions: [{ type: 'executeJavascript', script: "'x'.repeat(2100000)" }],
  });
  assert.equal(nagy.action_results[0].js_result, null);
  assert.ok(nagy.warnings.some(w => w.startsWith('js_result_dropped')), JSON.stringify(nagy.warnings));
});
