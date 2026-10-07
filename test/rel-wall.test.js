// rel-wall (2026-10-08): a W2 („falon át") és a C2 (saját CAPTCHA-megoldó)
// összefésülésének koordinátori döntései, végponttól végpontig.
//
// 1. ÁTFEDÉS — reCAPTCHA v2 / hCaptcha-kapun (amit a W2 felismerője is lát), ha a
//    C2 megoldó engedélyezett és az út olvasási: a W2 NEM kattint és NEM vár, a
//    vezérlés azonnal a C2 solveOnReadPath-é. Cloudflare/Turnstile: a W2-é marad
//    (a C2 nem hív). Kikapcsolt C2: a W2 régi viselkedése.
// 3. IDŐKERET — az egyszeri purpose:"read" brave_page CAPTCHA-kezeléskor a
//    READ_CHALLENGE_TIMEOUT_MS plafonig nyúlhat; a VALÓDI HTTP-szerveren át
//    (/mcp → tool-timeout → brave_page határidő → ScrapeGate → Node-szerver) a
//    hívás túléli a TOOL_CALL_TIMEOUT_MS-t, és a válasz kimondja a plafont.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser, startFixture } from './helpers.js';
import { challengeRoutes } from './fixtures/challenge-pages.js';
import { startCaptchaFixtures, startFakeEngine } from './captcha-fixtures.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browserPath = findBrowser();
const skip = !browserPath && 'nincs böngésző (BRAVE_PATH)';
const TOKEN = 'relwall-test-token-0123456789abcdef01234567';

// A clearance-tár a cwd/.sessions-be ír → ideiglenes cwd (a repó tiszta marad).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'relwall-test-'));
process.chdir(tmp);
for (const k of Object.keys(process.env)) {
  if (/^(RAILWAY_|CHALLENGE_|CAPTCHA_|HUMANIZE|READ_CHALLENGE_)/.test(k)) delete process.env[k];
}
Object.assign(process.env, {
  NODE_ENV: 'test',
  BRAVE_EGRESS_ALLOW_TEST_LOOPBACK: '1',
  HEADLESS: 'true',
  BRAVE_WATCHDOG_DISABLED: 'true',
  BRAVE_PAGE_PROFILE_DIR: path.join(tmp, 'profiles'),
  CAPTCHA_SOLVER_ENABLED: '1',
  CAPTCHA_ENGINE_TOKEN: TOKEN,
  CAPTCHA_MAX_SOLVES_PER_HOUR: '1000',
  CAPTCHA_COST_CAP_USD_DAY: '100',
  // terhelt gépen (párhuzamos tesztfájlok) se a keret döntsön — a sorrendet
  // teszteljük; a valódi plafon-láncot a HTTP-teszt méri saját env-vel
  TOOL_CALL_TIMEOUT_MS: '60000',
  CAPTCHA_SOLVE_BUDGET_MS: '50000',
});
if (browserPath) process.env.BRAVE_PATH = browserPath;

const { captchaHandoff, handleChallenge, detectChallengeHtml } = await import('../src/challenge.js');
const { _setHumanOverride } = await import('../src/captcha/read-path.js');

// Gyors C2-bevitel (a C2 saját tesztjeivel azonos); a W2 a SAJÁT kezét
// (HumanInput) használja — azon kémkedünk.
const fastHuman = {
  move: (p, x, y) => p.mouse.move(x, y),
  click: (p, x, y) => p.mouse.click(x, y),
  type: (p, t) => p.keyboard.type(t),
  async clickHandle(p, h) {
    await h.evaluate((e) => e.scrollIntoView({ block: 'center' })).catch(() => {});
    const b = await h.boundingBox();
    if (!b) return false;
    await p.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    return true;
  },
};

const withEnv = async (env, fn) => {
  const old = {};
  for (const [k, v] of Object.entries(env)) { old[k] = process.env[k]; process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
};

// ─── tiszta rész ──────────────────────────────────────────────────────────
test('átadási szabály: CSAK reCAPTCHA v2 / hCaptcha-kapu + bekapcsolt C2 + olvasási út', () => {
  const T = (type) => ({ type, vendor: 'x', interactive: true, block: false });
  const on = { solverEnabled: true, purpose: 'read' };
  assert.equal(captchaHandoff(T('recaptcha_gate'), on), true);
  assert.equal(captchaHandoff(T('hcaptcha_gate'), on), true);
  for (const t of ['turnstile_gate', 'cloudflare_interstitial', 'datadome_captcha', 'perimeterx', 'imperva_interstitial', 'akamai_challenge']) {
    assert.equal(captchaHandoff(T(t), on), false, t);
  }
  assert.equal(captchaHandoff(T('recaptcha_gate'), { solverEnabled: false, purpose: 'read' }), false);
  assert.equal(captchaHandoff(T('recaptcha_gate'), { solverEnabled: true, purpose: 'interact' }), false);
  assert.equal(captchaHandoff(T('recaptcha_gate'), { solverEnabled: true }), false);
  assert.equal(captchaHandoff(null, on), false);
});

// ─── valódi böngésző ──────────────────────────────────────────────────────
let eng, cfx, wfx, c;
test.before(async () => {
  _setHumanOverride(fastHuman);
  eng = await startFakeEngine({ token: TOKEN });
  process.env.CAPTCHA_ENGINE_URL = eng.url;
  if (!browserPath) return;
  cfx = await startCaptchaFixtures();
  wfx = await startFixture(challengeRoutes());
  const { BraveController } = await import('../src/brave-controller.js');
  c = new BraveController();
  await c.initialize();
});
test.after(async () => {
  _setHumanOverride(null);
  if (c) await c.close();
  if (cfx) await cfx.close();
  if (wfx) await wfx.close();
  if (eng) await eng.close();
  process.chdir(os.tmpdir());
  fs.rmSync(tmp, { recursive: true, force: true });
});

// A W2 kattintásai a böngésző „kezén" (HumanInput.clickBox / click) — kémkedés.
function spyW2(ctl) {
  const h = ctl._humanInput();
  const n = { clickBox: 0, click: 0 };
  const ob = h.clickBox, oc = h.click;
  h.clickBox = async function (...a) { n.clickBox++; return ob.apply(this, a); };
  h.click = async function (...a) { n.click++; return oc.apply(this, a); };
  return { clicks: () => n.clickBox + n.click, restore: () => { h.clickBox = ob; h.click = oc; } };
}

test('SORREND: reCAPTCHA-kapu (a W2 is felismeri) + C2 → azonnal a C2 old meg; a W2 nem kattint, nem vár', { skip, timeout: 90000 }, async () => {
  const spy = spyW2(c);
  try {
    const n = eng.calls.length;
    const r = await withEnv({ CHALLENGE_SOLVE: '1' }, () => c.scrape(`${cfx.main}/rc-wall?mode=static&sitekey=1`, {}));
    assert.equal(r.challenge?.type, 'recaptcha_gate', JSON.stringify(r.challenge));
    assert.equal(r.challenge.handoff, 'captcha_solver');
    assert.equal(r.challenge.waited_ms, 0);
    assert.equal(r.challenge.solve, undefined);          // a W2 checkbox-ága nem indult
    assert.equal(spy.clicks(), 0, 'a W2 kattintott');
    assert.equal(r.captcha?.status, 'solved', JSON.stringify(r.captcha));
    assert.equal(r.captcha.vendor, 'recaptcha');
    assert.ok(eng.calls.length > n, 'a C2 nem hívta az engine-t');
    assert.equal(r.challenge.passed, true);
    assert.equal(r.cf_status, 'cleared_attempt_1');
    assert.ok(!String(r.block_reason || '').startsWith('challenge:'), r.block_reason);
    assert.match(r.markdown, /SECRET-RC-CONTENT/);
  } finally { spy.restore(); }
});

test('SORREND: hCaptcha-kapu (a W2 is felismeri) + C2 → a C2 old meg; a W2 nem kattint', { skip, timeout: 90000 }, async () => {
  const spy = spyW2(c);
  try {
    const n = eng.calls.length;
    const r = await withEnv({ CHALLENGE_SOLVE: '1' }, () => c.scrape(`${cfx.main}/hc-wall?sitekey=1`, {}));
    assert.equal(r.challenge?.type, 'hcaptcha_gate', JSON.stringify(r.challenge));
    assert.equal(r.challenge.handoff, 'captcha_solver');
    assert.equal(r.challenge.waited_ms, 0);
    assert.equal(spy.clicks(), 0);
    assert.equal(r.captcha?.status, 'solved', JSON.stringify(r.captcha));
    assert.equal(r.captcha.vendor, 'hcaptcha');
    assert.ok(eng.calls.length > n);
    assert.equal(r.challenge.passed, true);
    assert.match(r.markdown, /SECRET-HC-CONTENT/);
  } finally { spy.restore(); }
});

test('SORREND: Cloudflare-lap Turnstile-lel + C2 bekapcsolva → a W2 kezeli (valódi kattintás), a C2 nem hív', { skip, timeout: 90000 }, async () => {
  const spy = spyW2(c);
  try {
    const n = eng.calls.length;
    const r = await withEnv({ CHALLENGE_SOLVE: '1' }, () => c.scrape(`${wfx.base}/ts`, { waitUntil: 'domcontentloaded' }));
    assert.equal(r.challenge?.type, 'cloudflare_interstitial', JSON.stringify(r.challenge));
    assert.equal(r.challenge.handoff, undefined);
    assert.equal(r.challenge.passed, true, JSON.stringify(r.challenge));
    assert.ok(r.challenge.solve?.clicks >= 1);
    assert.ok(spy.clicks() >= 1, 'a W2 nem kattintott');
    assert.equal(r.captcha, undefined, JSON.stringify(r.captcha));
    assert.equal(eng.calls.length, n, 'a C2 engine-hívást indított a CF-lapon');
    assert.match(r.markdown, /ARTICLE-CONTENT-OK/);
  } finally { spy.restore(); }
});

test('C2 kikapcsolva: a reCAPTCHA-kapu a W2-é marad (régi viselkedés: rövid kivárás, nincs átadás, nincs engine-hívás)', { skip, timeout: 60000 }, async () => {
  const n = eng.calls.length;
  const r = await withEnv({ CAPTCHA_SOLVER_ENABLED: '', CHALLENGE_INTERACTIVE_WAIT_MS: '1500' },
    () => c.scrape(`${cfx.main}/rc-wall?mode=static&sitekey=1`, {}));
  assert.equal(r.challenge?.type, 'recaptcha_gate');
  assert.equal(r.challenge.handoff, undefined);
  assert.equal(r.challenge.passed, false);
  assert.ok(r.challenge.waited_ms >= 1000, `waited_ms=${r.challenge.waited_ms}`);
  assert.equal(r.captcha, undefined);
  assert.equal(r.block_reason, 'challenge:recaptcha_gate');
  assert.equal(eng.calls.length, n);
});

test('kivárás közben kapuvá váló lap: a W2 a ciklusból is átad (kattintás nélkül); purpose≠read → nincs átadás', { skip, timeout: 60000 }, async () => {
  const page = await c.newPage();
  const clicks = { n: 0 };
  const human = { clickBox: async () => { clicks.n++; return {}; }, click: async () => { clicks.n++; }, idle: async () => {} };
  try {
    await page.goto(`${cfx.main}/rc-wall?mode=static&sitekey=1`, { waitUntil: 'load' });
    assert.equal(detectChallengeHtml(await page.content())?.type, 'recaptcha_gate');
    // a hívó még interstitialnek látta (mint egy „Just a moment" utáni kapu-lapnál)
    const first = { type: 'cloudflare_interstitial', vendor: 'cloudflare', interactive: true, block: false };
    const t0 = Date.now();
    const { info } = await handleChallenge(page, first, { waitMs: 8000, pollMs: 200, purpose: 'read', solve: true, human, captchaHandoff: true });
    assert.equal(info.handoff, 'captcha_solver');
    assert.equal(info.final_type, 'recaptcha_gate');
    assert.equal(info.passed, false);
    assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
    assert.equal(clicks.n, 0);
    // nem olvasási út: a szabály nem él (a W2 a régi módon, kattintás nélkül vár)
    const { info: i2 } = await handleChallenge(page, detectChallengeHtml(await page.content()),
      { waitMs: 800, interactiveWaitMs: 800, pollMs: 200, purpose: 'interact', solve: true, human, captchaHandoff: true });
    assert.equal(i2.handoff, undefined);
    assert.equal(clicks.n, 0);
  } finally { await page.close(); }
});

// ─── HTTP-lánc: a magasabb plafon a valódi szerveren át ──────────────────
async function freePort() {
  const s = net.createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise(r => s.close(r));
  return p;
}

async function startServer(extraEnv) {
  const port = await freePort();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bmcp-relwall-'));
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(RAILWAY_|BRAVE_|STEALTH_|CHALLENGE_|CAPTCHA_|HUMANIZE|TOOL_|READ_CHALLENGE_)/.test(k)) delete env[k];
  }
  Object.assign(env, {
    PORT: String(port), HEADLESS: 'true', BRAVE_PATH: browserPath, BRAVE_WATCHDOG_DISABLED: 'true',
    NODE_ENV: 'test', BRAVE_EGRESS_ALLOW_TEST_LOOPBACK: '1', BRAVE_PAGE_PROFILE_DIR: path.join(cwd, 'profiles'),
    ...extraEnv,
  });
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'dual-server.js'), '--http-only'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    try { if ((await fetch(`${base}/tools`)).ok) break; } catch (_) { /* indul */ }
    await new Promise(r => setTimeout(r, 200));
  }
  const call = async (name, args) => {
    const t = Date.now();
    const r = await fetch(`${base}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    const j = await r.json();
    return { status: r.status, ms: Date.now() - t, error: j.error, result: j.result ? JSON.parse(j.result.content[0].text) : null };
  };
  const health = async () => (await fetch(`${base}/health`)).json();
  const stop = async () => {
    child.kill('SIGTERM');
    await new Promise(r => { child.once('exit', r); setTimeout(r, 8000); });
    fs.rmSync(cwd, { recursive: true, force: true });
  };
  return { call, health, stop, log: () => log };
}

test('HTTP-lánc: egyszeri purpose:"read" brave_page a TOOL_CALL_TIMEOUT_MS-on TÚL is választ ad (READ_CHALLENGE_TIMEOUT_MS), és kimondja; timeout_ms köt', { skip, timeout: 150000 }, async (t) => {
  const srv = await startServer({
    TOOL_CALL_TIMEOUT_MS: '9000', READ_CHALLENGE_TIMEOUT_MS: '60000',
    CAPTCHA_SOLVER_ENABLED: '1', CAPTCHA_ENGINE_URL: eng.url, CAPTCHA_ENGINE_TOKEN: TOKEN,
    CAPTCHA_MAX_SOLVES_PER_HOUR: '1000', CAPTCHA_COST_CAP_USD_DAY: '100',
  });
  t.after(async () => { eng.behavior.delayMs = 0; await srv.stop(); });
  const h = await srv.health();
  assert.deepEqual(h.read_challenge_timeout, { active: true, ms: 60000, base_ms: 9000 });

  // az engine minden válasza 9,5 s → a megoldás biztosan túlnyúlik a 9 s-os alapon
  eng.behavior.delayMs = 9500;
  const n = eng.calls.length;
  const a = await srv.call('brave_page', { url: `${cfx.main}/rc-wall?mode=static`, purpose: 'read', formats: ['html'] });
  t.diagnostic(`read-hívás: status=${a.status} ms=${a.ms} captcha=${JSON.stringify(a.result?.captcha)} rct=${JSON.stringify(a.result?.read_challenge_timeout)}`);
  assert.equal(a.status, 200, JSON.stringify(a.error));
  assert.ok(!a.error, JSON.stringify(a.error));
  assert.ok(a.ms > 9000, `${a.ms} ms — nem nyúlt túl az alapon, a teszt nem bizonyít`);
  assert.equal(a.result.captcha?.status, 'solved', JSON.stringify(a.result.captcha));
  assert.equal(a.result.ok, true, JSON.stringify(a.result.warnings));
  const { beyond_base_ms: beyond, ...rct } = a.result.read_challenge_timeout || {};
  assert.deepEqual(rct, { used: true, env: 'READ_CHALLENGE_TIMEOUT_MS', ceiling_ms: 60000, deadline_ms: 58800, base_deadline_ms: 7800 });
  assert.equal(beyond, a.result.elapsed_ms - 7800);
  assert.ok(beyond > 0);
  assert.ok(a.result.warnings.some(w => /^read_challenge_timeout_used: deadline 58800ms/.test(w)));
  assert.match(a.result.html, /SECRET-RC-CONTENT/);
  assert.ok(eng.calls.length > n);

  // a hívó timeout_ms-e köt: 6 s-nál nincs kinyújtás, a megoldó nem kezd bele
  eng.behavior.delayMs = 0;
  const m = eng.calls.length;
  const b = await srv.call('brave_page', { url: `${cfx.main}/rc-wall?mode=static`, purpose: 'read', formats: ['html'], timeout_ms: 6000 });
  assert.equal(b.status, 200);
  assert.equal(b.result.read_challenge_timeout, undefined);
  assert.ok(b.result.captcha === undefined || b.result.captcha.status === 'skipped', JSON.stringify(b.result.captcha));
  assert.ok(b.ms < 9000, `${b.ms} ms`);
  assert.equal(eng.calls.length, m);

  // CAPTCHA nélküli lap: a read-hívás sem nyúlik (nincs read_challenge_timeout)
  const p = await srv.call('brave_page', { url: `${cfx.main}/plain`, purpose: 'read', formats: ['text'] });
  assert.equal(p.result.ok, true);
  assert.equal(p.result.read_challenge_timeout, undefined);
  assert.equal(p.result.captcha, undefined);
});
