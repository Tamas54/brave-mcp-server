// C2 — saját CAPTCHA-megoldó, böngésző-oldal (2026-10-07).
//
// Helyi fixture-lapok (test/captcha-fixtures.js): szimulált reCAPTCHA (statikus és
// dinamikus rács, hang-út, tiltott hang), hCaptcha (DOM-rács két lappal, vászon-
// pontok), szöveges és matekos fal; a hamis engine a C1/C3-szerződést játssza, és
// a beküldött KÉPERNYŐKÉPEKBŐL dönt (PNG-dekóder) — a csempe-kivágás és a sorrend
// így valódi ellenőrzés alatt áll.
//
// HATÁR-TESZTEK: a megoldó CSAK olvasási úton fut — brave_page-munkamenetben
// (session/keep_session), purpose nélküli brave_page-ben, belépő-űrlapon és
// tiltott (signup/…) URL-en NEM; a hamis engine ilyenkor egyetlen hívást sem kap.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findBrowser } from './helpers.js';
import { startCaptchaFixtures, startFakeEngine, fakeTextAnswer } from './captcha-fixtures.js';
import { normalizeTiles, normalizePoints } from '../src/captcha/grid.js';
import { solveMathExpr, isForbiddenUrl } from '../src/captcha/detect.js';
import echolotDefault, { engineSolve, echolotProvider, _resetLedger, costStatus } from '../src/captcha/echolot-provider.js';
import { solveOnReadPath, _resetRate, _setHumanOverride, _setProviderModule } from '../src/captcha/read-path.js';

// Gyors bevitel a hosszú fixture-tesztekhez (a valódi emberi egér a „human" jelű
// teszteken fut). Ugyanaz a felület, mint a pointer.js defaultHuman-je.
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
const humanTest = async (fn) => { _setHumanOverride(null); try { return await fn(); } finally { _setHumanOverride(fastHuman); } };

const browserPath = findBrowser();
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2-profiles-'));
const TOKEN = 'c2-test-token-0123456789abcdef0123456789';
Object.assign(process.env, {
  NODE_ENV: 'test',
  BRAVE_EGRESS_ALLOW_TEST_LOOPBACK: '1',
  HEADLESS: 'true',
  BRAVE_WATCHDOG_DISABLED: 'true',
  BRAVE_PAGE_PROFILE_DIR: profileDir,
  CAPTCHA_SOLVER_ENABLED: '1',
  CAPTCHA_ENGINE_TOKEN: TOKEN,
  CAPTCHA_MAX_SOLVES_PER_HOUR: '1000',
  CAPTCHA_COST_CAP_USD_DAY: '100',
  // terhelt gépen (párhuzamos tesztfájlok, több Chrome) se a keret döntsön:
  // a vezénylést teszteljük, nem a 25 s-os éles plafont
  TOOL_CALL_TIMEOUT_MS: '60000',
  CAPTCHA_SOLVE_BUDGET_MS: '50000',
});
delete process.env.CAPTCHA_SOLVER_PROVIDER;
delete process.env.CAPTCHA_RECAPTCHA_ORDER;
for (const k of Object.keys(process.env)) if (k.startsWith('RAILWAY_')) delete process.env[k];
if (browserPath) process.env.BRAVE_PATH = browserPath;

let fx; let eng; let c;
const skip = !browserPath && 'nincs böngésző (BRAVE_PATH)';

test.before(async () => {
  _setHumanOverride(fastHuman);
  eng = await startFakeEngine({ token: TOKEN });
  process.env.CAPTCHA_ENGINE_URL = eng.url;
  if (!browserPath) return;
  fx = await startCaptchaFixtures();
  const { BraveController } = await import('../src/brave-controller.js');
  c = new BraveController();
  await c.initialize();
});

test.after(async () => {
  if (c) await c.close();
  if (fx) await fx.close();
  if (eng) await eng.close();
  fs.rmSync(profileDir, { recursive: true, force: true });
});

const callsSince = (n) => eng.calls.slice(n);

// ── egység-tesztek ────────────────────────────────────────────────────────────

test('normalizeTiles: index-lista, szöveg, bool-tömb, határon kívüli kiszűrve', () => {
  assert.deepEqual(normalizeTiles({ tiles: [4, 0, 4, 9, -1, 2] }, 9), [0, 2, 4]);
  assert.deepEqual(normalizeTiles({ answer: '1, 3;5' }, 9), [1, 3, 5]);
  assert.deepEqual(normalizeTiles({ tiles: [true, false, true] }, 3), [0, 2]);
  assert.deepEqual(normalizeTiles({ tiles: 'x' }, 9), []);
  assert.deepEqual(normalizeTiles(null, 9), []);
});

test('normalizePoints: csak 0..1 közti pontok, max 12', () => {
  assert.deepEqual(normalizePoints({ points: [{ x: 0.5, y: 0.25 }, [0.1, 0.9], { x: 2, y: 0 }] }), [{ x: 0.5, y: 0.25 }, { x: 0.1, y: 0.9 }]);
  assert.equal(normalizePoints({ points: Array.from({ length: 20 }, () => [0.5, 0.5]) }).length, 12);
});

test('solveMathExpr: helyi számtan; isForbiddenUrl: szegmens-szintű', () => {
  assert.equal(solveMathExpr('7 + 5'), '12');
  assert.equal(solveMathExpr('9 − 4'), '5');
  assert.equal(solveMathExpr('3 x 4'), '12');
  assert.equal(solveMathExpr('8 / 3'), null);
  assert.equal(isForbiddenUrl('https://x.hu/signup/verify'), true);
  assert.equal(isForbiddenUrl('https://x.hu/login.php?next=/'), true);
  assert.equal(isForbiddenUrl('https://x.hu/news/ticket-prices-rise'), false);
  assert.equal(isForbiddenUrl('https://x.hu/blog/how-to-login-safely'), false);
});

test('engineSolve: Bearer-token, purpose mindig "read", költség-napló, 401 = végzetes', async () => {
  _resetLedger();
  const n = eng.calls.length;
  // a hívó „interact"-ot kér → a kliens akkor is "read"-et küld
  const r = await engineSolve({ kind: 'audio', audio: Buffer.from('xxANSWER:one two\n').toString('base64'), purpose: 'interact' });
  assert.equal(r.ok, true);
  assert.equal(r.answer, 'one two');
  assert.equal(callsSince(n)[0].purpose, 'read');
  assert.ok(costStatus().cost_usd >= 0.001);
  const bad = await engineSolve({ kind: 'text' }, { env: { ...process.env, CAPTCHA_ENGINE_TOKEN: 'wrong' } });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'engine_auth_401');
  assert.equal(bad.fatal, true);
  const none = await engineSolve({ kind: 'text' }, { env: { CAPTCHA_ENGINE_URL: '' } });
  assert.equal(none.error, 'engine_unconfigured');
});

test('engineSolve: napi költség-plafon → cost_cap_reached, hívás nélkül', async () => {
  _resetLedger();
  const env = { ...process.env, CAPTCHA_COST_CAP_USD_DAY: '0.0015' };
  const b = { kind: 'audio', audio: Buffer.from('ANSWER:one\n').toString('base64') };
  assert.equal((await engineSolve(b, { env })).ok, true);
  assert.equal((await engineSolve(b, { env })).ok, true);   // 0,002 ≥ 0,0015 → a következő tilos
  const n = eng.calls.length;
  const r = await engineSolve(b, { env });
  assert.equal(r.error, 'cost_cap_reached');
  assert.equal(eng.calls.length, n);
  _resetLedger();
});

test('engineSolve: nem támogatott fajta (501 / a C1 400 „kind must be") → unsupported + módváltás-jel', async () => {
  eng.behavior.unsupported.add('point');
  try {
    const r = await engineSolve({ kind: 'point', image_b64: 'AAAA' });
    assert.equal(r.ok, false);
    assert.match(r.error, /unsupported/);
    assert.equal(r.switchMode, true);
  } finally { eng.behavior.unsupported.delete('point'); }
  const r2 = await engineSolve({ kind: 'drag', image_b64: 'AAAA' });
  assert.match(r2.error, /unsupported/);
  assert.equal(r2.switchMode, true);
});

test('engineSolve: a C3 `success`-alakú hang-válasza is ok', async () => {
  const r = await engineSolve({ kind: 'audio', audio: Buffer.from('xxANSWER:nine one\n').toString('base64') });
  assert.equal(r.ok, true);
  assert.equal(r.answer, 'nine one');
});

test('a szolgáltató purpose:"read" nélkül semmit nem csinál (a lapot sem érinti)', async () => {
  let touched = false;
  const page = new Proxy({}, { get() { touched = true; return () => {}; } });
  for (const purpose of [undefined, 'interact', 'goal', 'READ']) {
    const r = await echolotProvider.solve({ kind: 'recaptcha_v2', page, purpose });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'purpose_not_allowed');
  }
  const rp = await solveOnReadPath(page, { purpose: 'interact' });
  assert.deepEqual(rp, { status: 'skipped', reason: 'purpose_not_read' });
  assert.equal(touched, false);
});

// ── böngészős tesztek: olvasási út ───────────────────────────────────────────

test('brave_scrape: reCAPTCHA statikus 3×3 rács (emberi egérrel) → megoldva, a fal mögötti tartalom jön', { skip }, async () => {
  const n = eng.calls.length;
  const r = await humanTest(() => c.scrape(`${fx.main}/rc-wall?mode=static`, {}));
  assert.equal(r.captcha?.status, 'solved', JSON.stringify(r.captcha));
  assert.equal(r.captcha.vendor, 'recaptcha');
  assert.equal(r.captcha.submit, 'submitted');
  assert.match(r.markdown, /SECRET-RC-CONTENT/);
  const calls = callsSince(n);
  assert.ok(calls.length >= 1);
  assert.equal(calls[0].kind, 'grid');
  // C1-szerződés: a rács képe + grid, csempe-lista NÉLKÜL
  assert.equal(calls[0].image, true);
  assert.equal(calls[0].tiles, 0);
  assert.deepEqual(calls[0].grid, { rows: 3, cols: 3 });
  assert.match(calls[0].instruction, /red squares/);
  assert.ok(calls.every(x => x.purpose === 'read' && x.op === 'scrape'));
  assert.match(calls[0].url, /\/rc-wall\?mode=static$/);
});

test('brave_scrape: reCAPTCHA DINAMIKUS rács → az új csempéket is újraküldi, megoldva', { skip }, async () => {
  const n = eng.calls.length;
  const r = await c.scrape(`${fx.main}/rc-wall?mode=dynamic`, {});
  assert.equal(r.captcha?.status, 'solved', JSON.stringify(r.captcha));
  assert.match(r.markdown, /SECRET-RC-CONTENT/);
  const calls = callsSince(n);
  assert.equal(calls[0].image, true);
  assert.equal(calls[0].meta.dynamic, true);
  // legalább egy újra-ellenőrzés: csak a kicserélt csempék mentek (subset)
  const re = calls.filter(x => Array.isArray(x.meta?.subset));
  assert.ok(re.length >= 1, 'nincs dinamikus újra-ellenőrzés');
  assert.ok(re.every(x => x.tiles === x.meta.subset.length && !x.image && x.grid === undefined));
});

test('brave_scrape: reCAPTCHA „Please try again" után új kör (több kör)', { skip }, async () => {
  const r = await c.scrape(`${fx.main}/rc-wall?mode=static&extra=1`, {});
  assert.equal(r.captcha?.status, 'solved', JSON.stringify(r.captcha));
  assert.equal(r.captcha.rounds, 2);
  assert.match(r.markdown, /SECRET-RC-CONTENT/);
});

test('brave_scrape: a feladvány-keret rossz válasz után ÚJRATÖLT (mérve a Google-on) → új kör, nem „page_changed"', { skip }, async () => {
  const r = await c.scrape(`${fx.main}/rc-wall?mode=reload`, {});
  assert.equal(r.captcha?.status, 'solved', JSON.stringify(r.captcha));
  assert.ok(r.captcha.rounds >= 2);
  assert.match(r.markdown, /SECRET-RC-CONTENT/);
});

test('brave_scrape: reCAPTCHA hang-út (CAPTCHA_RECAPTCHA_ORDER=audio) → C3-hívás, begépelve', { skip }, async () => {
  process.env.CAPTCHA_RECAPTCHA_ORDER = 'audio,image';
  try {
    const n = eng.calls.length;
    const r = await c.scrape(`${fx.main}/rc-wall?mode=static`, {});
    assert.equal(r.captcha?.status, 'solved', JSON.stringify(r.captcha));
    assert.match(r.markdown, /SECRET-RC-CONTENT/);
    const calls = callsSince(n);
    assert.deepEqual(calls.map(x => x.kind), ['audio']);
    assert.equal(calls[0].mime, 'audio/mpeg');
  } finally { delete process.env.CAPTCHA_RECAPTCHA_ORDER; }
});

test('brave_scrape: a kép-út nem támogatott (501) → átvált a hangra', { skip }, async () => {
  eng.behavior.unsupported.add('grid');
  try {
    const n = eng.calls.length;
    const r = await c.scrape(`${fx.main}/rc-wall?mode=static`, {});
    assert.equal(r.captcha?.status, 'solved', JSON.stringify(r.captcha));
    assert.deepEqual(callsSince(n).map(x => x.kind), ['grid', 'audio']);
  } finally { eng.behavior.unsupported.delete('grid'); }
});

test('brave_scrape: tiltott hang (doscaptcha) + nem támogatott kép → kimondott kudarc, nem lóg', { skip }, async () => {
  eng.behavior.unsupported.add('grid');
  process.env.CAPTCHA_RECAPTCHA_ORDER = 'audio,image';
  try {
    const r = await c.scrape(`${fx.main}/rc-wall?mode=blockaudio`, {});
    assert.equal(r.captcha?.status, 'failed');
    // a „Try again later” (doscaptcha) az egész reCAPTCHA-t lezárja → kimondott tiltás
    assert.match(r.captcha.error, /recaptcha_blocked|audio_blocked|unsupported/);
    assert.doesNotMatch(r.markdown, /SECRET/);
  } finally { eng.behavior.unsupported.delete('grid'); delete process.env.CAPTCHA_RECAPTCHA_ORDER; }
});

test('brave_scrape: azonnal átengedő jelölőnégyzet → feladvány és engine-hívás nélkül', { skip }, async () => {
  const n = eng.calls.length;
  const r = await c.scrape(`${fx.main}/rc-wall?mode=pass`, {});
  assert.equal(r.captcha?.status, 'solved', JSON.stringify(r.captcha));
  assert.equal(r.captcha.rounds, 0);
  assert.match(r.markdown, /SECRET-RC-CONTENT/);
  assert.equal(eng.calls.length, n);
});

test('brave_scrape: hCaptcha DOM-rács, két lap („Next" → „Verify") → megoldva', { skip }, async () => {
  const n = eng.calls.length;
  const r = await c.scrape(`${fx.main}/hc-wall?mode=grid`, {});
  assert.equal(r.captcha?.status, 'solved', JSON.stringify(r.captcha));
  assert.equal(r.captcha.vendor, 'hcaptcha');
  assert.match(r.markdown, /SECRET-HC-CONTENT/);
  const calls = callsSince(n);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(x => x.kind === 'grid' && x.image && x.grid?.rows === 3 && x.grid?.cols === 3 && x.meta.vendor === 'hcaptcha'));
});

test('brave_scrape: hCaptcha vászon („kattints a piros körökre") → kind:"point", megoldva', { skip }, async () => {
  const n = eng.calls.length;
  const r = await c.scrape(`${fx.main}/hc-wall?mode=canvas`, {});
  assert.equal(r.captcha?.status, 'solved', JSON.stringify(r.captcha));
  assert.match(r.markdown, /SECRET-HC-CONTENT/);
  assert.deepEqual(callsSince(n).map(x => x.kind), ['point']);
});

test('brave_scrape: szöveges kép-CAPTCHA (emberi gépeléssel; diéta → újratöltés), első rossz válasz után új kör', { skip }, async () => {
  eng.behavior.wrongFirst.add('text');
  const n = eng.calls.length;
  const r = await humanTest(() => c.scrape(`${fx.main}/text-wall`, {}));
  assert.equal(r.captcha?.status, 'solved', JSON.stringify(r.captcha));
  assert.equal(r.captcha.vendor, 'text');
  assert.equal(r.captcha.rounds, 2);
  assert.match(r.markdown, /SECRET-TEXT-CONTENT/);
  const calls = callsSince(n);
  assert.deepEqual(calls.map(x => x.kind), ['text', 'text']);
  assert.ok(calls.every(x => x.image && x.instruction === undefined));
});

test('brave_scrape: kép nélküli matekos kérdés → helyben, engine-hívás NÉLKÜL', { skip }, async () => {
  const n = eng.calls.length;
  const r = await c.scrape(`${fx.main}/math-wall`, {});
  assert.equal(r.captcha?.status, 'solved', JSON.stringify(r.captcha));
  assert.equal(r.captcha.kind, 'math_text');
  assert.match(r.markdown, /SECRET-MATH-CONTENT/);
  assert.equal(eng.calls.length, n);
});

test('brave_crawl: a bejárt oldal CAPTCHA-falát is átlépi (olvasási út)', { skip }, async () => {
  const r = await c.crawl(`${fx.main}/crawl-start`, { maxPages: 2, pageTimeoutMs: 30000, budgetMs: 60000 });
  const wall = r.results.find(x => /SECRET-TEXT-CONTENT/.test(x.markdown || ''));
  assert.ok(wall, JSON.stringify(r.results.map(x => ({ url: x.url, captcha: x.captcha }))));
  assert.equal(wall.captcha?.status, 'solved');
  assert.equal(eng.calls.at(-1).op, 'crawl');
});

test('brave_page egyszeri hívás purpose:"read"-del (engine fetch) → megoldva, warning-ban kimondva', { skip }, async () => {
  const r = await c.pageTool({ url: `${fx.main}/rc-wall?mode=static`, purpose: 'read', formats: ['html'] });
  assert.equal(r.ok, true, JSON.stringify(r.warnings));
  assert.equal(r.captcha?.status, 'solved');
  assert.ok(r.warnings.some(w => /^captcha_solved:recaptcha/.test(w)));
  assert.match(r.html, /SECRET-RC-CONTENT/);
});

// ── HATÁR: a megoldó itt NEM fut ──────────────────────────────────────────────

test('HATÁR: brave_page MUNKAMENET (keep_session / session_id) — purpose:"read"-del sem fut', { skip }, async () => {
  const n = eng.calls.length;
  const r1 = await c.pageTool({ url: `${fx.main}/text-wall`, purpose: 'read', keep_session: true, formats: ['html'] });
  assert.ok(r1.session_id);
  assert.equal(r1.captcha, undefined);
  assert.ok(r1.warnings.some(w => /captcha_solver_skipped: session path/.test(w)));
  assert.match(r1.html, /captcha-image/);
  const r2 = await c.pageTool({ session_id: r1.session_id, url: `${fx.main}/rc-wall?mode=static`, purpose: 'read', formats: ['html'] });
  assert.equal(r2.captcha, undefined);
  assert.doesNotMatch(r2.html, /SECRET/);
  await c.pageTool({ session_id: r1.session_id, close: true });
  assert.equal(eng.calls.length, n, 'munkamenetben a megoldó-végpont hívást kapott');
});

test('HATÁR: brave_page purpose nélkül (interact/goal-alak) — a megoldó nem fut', { skip }, async () => {
  const n = eng.calls.length;
  const r = await c.pageTool({ url: `${fx.main}/rc-wall?mode=static`, formats: ['html'],
    actions: [{ type: 'wait', milliseconds: 300 }] });
  assert.equal(r.captcha, undefined);
  assert.doesNotMatch(r.html, /SECRET/);
  assert.equal(eng.calls.length, n);
});

test('HATÁR: belépő-űrlapba ágyazott CAPTCHA → form_captcha, nincs megoldás', { skip }, async () => {
  const n = eng.calls.length;
  const r = await c.scrape(`${fx.main}/members/area`, {});
  assert.equal(r.captcha?.status, 'skipped');
  assert.equal(r.captcha.reason, 'form_captcha');
  assert.equal(eng.calls.length, n);
});

test('HATÁR: regisztrációs útvonal (/signup/…) → forbidden_url, nincs megoldás', { skip }, async () => {
  const n = eng.calls.length;
  const r = await c.scrape(`${fx.main}/signup/verify`, {});
  assert.equal(r.captcha?.status, 'skipped');
  assert.equal(r.captcha.reason, 'forbidden_url');
  assert.equal(eng.calls.length, n);
});

test('kikapcsolva (CAPTCHA_SOLVER_ENABLED üres): az út a régi — nincs captcha-mező, nincs hívás', { skip }, async () => {
  process.env.CAPTCHA_SOLVER_ENABLED = '';
  try {
    const n = eng.calls.length;
    const r = await c.scrape(`${fx.main}/rc-wall?mode=static`, {});
    assert.equal('captcha' in r, false);
    assert.equal(eng.calls.length, n);
    const p = await c.scrape(`${fx.main}/plain`, {});
    assert.equal('captcha' in p, false);
  } finally { process.env.CAPTCHA_SOLVER_ENABLED = '1'; }
});

test('bekapcsolva, CAPTCHA nélküli lapon: nincs captcha-mező, nincs hívás', { skip }, async () => {
  const n = eng.calls.length;
  const p = await c.scrape(`${fx.main}/plain`, {});
  assert.equal('captcha' in p, false);
  assert.equal(eng.calls.length, n);
});

test('cikk alatti widget (sok olvasható szöveg) → content_present, nincs megoldás', { skip }, async () => {
  const n = eng.calls.length;
  const r = await c.scrape(`${fx.main}/article-with-widget`, {});
  assert.equal(r.captcha?.status, 'skipped');
  assert.equal(r.captcha.reason, 'content_present');
  assert.equal(eng.calls.length, n);
});

test('láthatatlan v3-horgony: nem fal — nincs captcha-mező és nincs várakozás', { skip }, async () => {
  const t0 = Date.now();
  const r = await c.scrape(`${fx.main}/v3-page`, {});
  assert.equal('captcha' in r, false);
  assert.ok(Date.now() - t0 < 6000);
});

test('W2-bekötés: CAPTCHA_SOLVER_PROVIDER=<más> → a szöveges kép a provider.js láncán (read), a bevitel a miénk', { skip }, async () => {
  const seen = [];
  _setProviderModule({
    registerProvider: () => {},
    solveCaptcha: async (req) => {
      seen.push({ kind: req.kind, purpose: req.purpose, page: req.page, img: !!req.meta?.imageBase64, order: req.env?.CAPTCHA_SOLVER_PROVIDER });
      return { ok: true, answer: fakeTextAnswer(req.meta.imageBase64), provider: 'mock', cost_usd: 0.002 };
    },
  });
  process.env.CAPTCHA_SOLVER_PROVIDER = 'mock';
  try {
    const n = eng.calls.length;
    const r = await c.scrape(`${fx.main}/text-wall`, {});
    assert.equal(r.captcha?.status, 'solved', JSON.stringify(r.captcha));
    assert.match(r.markdown, /SECRET-TEXT-CONTENT/);
    assert.deepEqual(seen, [{ kind: 'text', purpose: 'read', page: null, img: true, order: 'mock' }]);
    assert.equal(eng.calls.length, n, 'a saját végpontot nem kellett hívni');
  } finally {
    delete process.env.CAPTCHA_SOLVER_PROVIDER;
    _setProviderModule(undefined);
  }
});

test('második sor: „echolot,mock" — a saját végpont nem tudja a szöveget → a W2-lánc (csak a többi név) oldja meg', { skip }, async () => {
  const seen = [];
  _setProviderModule({
    registerProvider: () => {},
    solveCaptcha: async (req) => { seen.push(req.env?.CAPTCHA_SOLVER_PROVIDER); return { ok: true, answer: fakeTextAnswer(req.meta.imageBase64), provider: 'mock' }; },
  });
  eng.behavior.unsupported.add('text');
  process.env.CAPTCHA_SOLVER_PROVIDER = 'echolot,mock';
  try {
    const n = eng.calls.length;
    const r = await c.scrape(`${fx.main}/text-wall`, {});
    assert.equal(r.captcha?.status, 'solved', JSON.stringify(r.captcha));
    assert.deepEqual(callsSince(n).map(x => x.kind), ['text']);   // előbb a saját (501)
    assert.deepEqual(seen, ['mock']);                               // aztán a lánc, echolot nélkül
  } finally {
    delete process.env.CAPTCHA_SOLVER_PROVIDER;
    eng.behavior.unsupported.delete('text');
    _setProviderModule(undefined);
  }
});

test('W2-felület: default export, kinds, configured, csak-válasz mód (lap nélkül), actions SOHA', async () => {
  assert.equal(echolotDefault, echolotProvider);
  for (const k of ['image_grid', 'text', 'math', 'audio']) assert.ok(echolotProvider.kinds.includes(k), k);
  assert.equal(echolotProvider.configured({ CAPTCHA_ENGINE_URL: '' }).ok, false);
  assert.equal(echolotProvider.configured({ CAPTCHA_ENGINE_URL: eng.url }).ok, true);
  const m = await echolotProvider.solve({ kind: 'math', meta: { text: 'What is 6 + 7?' }, purpose: 'read' });
  assert.equal(m.ok, true);
  assert.equal(m.answer, '13');
  const a = await echolotProvider.solve({ kind: 'audio', meta: { audioBase64: Buffer.from('xxANSWER:four two\n').toString('base64') }, purpose: 'read', env: process.env });
  assert.equal(a.answer, 'four two');
  assert.equal('actions' in a, false);
});

test('W2-felület: image_grid kérés NYITOTT feladványra (a W2 már kattintott) → a rácsot megoldja, actions nélkül', { skip }, async () => {
  const page = await c.newPage();
  try {
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(`${fx.main}/rc-wall?mode=static`, { waitUntil: 'load' });
    let anchor = null;
    for (let i = 0; i < 40 && !anchor; i++) { anchor = page.frames().find(f => /recaptcha\/api2\/anchor/.test(f.url())); if (!anchor) await new Promise(r => setTimeout(r, 100)); }
    await new Promise(r => setTimeout(r, 300));
    const h = await anchor.$('#recaptcha-anchor');
    await fastHuman.clickHandle(page, h);
    const r = await echolotDefault.solve({ kind: 'image_grid', page, meta: { vendor: 'recaptcha', human: fastHuman }, purpose: 'read', env: process.env });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal('actions' in r, false);
    assert.ok(Array.isArray(r.trace));
    assert.ok(r.trace.every(x => x.target !== 'recaptcha_checkbox'), 'a nyitott feladványnál nem kattint újra a jelölőnégyzetre');
  } finally { await page.close(); }
});

test('már átengedett jelölőnégyzet a fal-űrlapban → csak a beküldés (already_checked)', { skip }, async () => {
  const page = await c.newPage();
  try {
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(`${fx.main}/rc-wall?mode=pass`, { waitUntil: 'load' });
    let anchor = null;
    for (let i = 0; i < 40 && !anchor; i++) { anchor = page.frames().find(f => /recaptcha\/api2\/anchor/.test(f.url())); if (!anchor) await new Promise(r => setTimeout(r, 100)); }
    await new Promise(r => setTimeout(r, 300));
    await fastHuman.clickHandle(page, await anchor.$('#recaptcha-anchor'));
    await new Promise(r => setTimeout(r, 600));
    const n = eng.calls.length;
    const res = await solveOnReadPath(page, { purpose: 'read', deadlineTs: Date.now() + 20000 });
    assert.equal(res.status, 'solved', JSON.stringify(res));
    assert.equal(res.how, 'already_checked');
    assert.equal(res.submit, 'submitted');
    assert.match(await page.content(), /SECRET-RC-CONTENT/);
    assert.equal(eng.calls.length, n);
  } finally { await page.close(); }
});

test('brave_page szűk határidővel (timeout_ms) → a megoldó nem kezd bele: skipped/budget, kimondva', { skip }, async () => {
  const n = eng.calls.length;
  const r = await c.pageTool({ url: `${fx.main}/rc-wall?mode=static`, purpose: 'read', formats: ['html'], timeout_ms: 5000 });
  assert.ok(r.captcha === undefined || r.captcha.status === 'skipped', JSON.stringify(r.captcha));
  if (r.captcha) assert.equal(r.captcha.reason, 'budget');
  assert.equal(eng.calls.length, n);
});
