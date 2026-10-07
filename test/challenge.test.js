// JS-challenge kivárás + checkbox-kattintás + clearance-újrahasznosítás (W2, 2026-10-07).
//
// 1. rész (böngésző nélkül): a felismerő pozitív/negatív esetei, a clearance-
//    süti szűrő, a konfiguráció.
// 2. rész (valódi böngésző + 127.0.0.1-es fixtúrák, teszt-kivétellel): a
//    scrape-út kivár / átjut / kimondja, ha nem jutott át; flag mögött a
//    Turnstile-checkboxra VALÓDI (isTrusted), emberi mozdulattal kattint; a
//    megnyert clearance egy friss böngészőben is átvisz; határidő-tudatos.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findBrowser, startFixture } from './helpers.js';
import { challengeRoutes } from './fixtures/challenge-pages.js';

const browserPath = findBrowser();
// A clearance-tár a cwd/.sessions-be ír → ideiglenes cwd (a repó tiszta marad).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'challenge-test-'));
process.chdir(tmp);
Object.assign(process.env, {
  NODE_ENV: 'test',
  BRAVE_EGRESS_ALLOW_TEST_LOOPBACK: '1',
  HEADLESS: 'true',
  BRAVE_WATCHDOG_DISABLED: 'true',
  BRAVE_PAGE_PROFILE_DIR: path.join(tmp, 'profiles'),
});
for (const k of Object.keys(process.env)) {
  if (k.startsWith('RAILWAY_') || k.startsWith('CHALLENGE_') || k.startsWith('CAPTCHA_SOLVER') || k === 'HUMANIZE') delete process.env[k];
}
if (browserPath) process.env.BRAVE_PATH = browserPath;

const { detectChallengeHtml, clearanceCookies, challengeConfig, challengeHealth } = await import('../src/challenge.js');
const skip = !browserPath && 'nincs böngésző (BRAVE_PATH)';

// ─── 1. Tiszta részek ────────────────────────────────────────────────────
test('felismerő: Cloudflare / DataDome / PerimeterX / Imperva / Akamai / kapuk', () => {
  const t = (h) => detectChallengeHtml(h)?.type ?? null;
  assert.equal(t('<title>Just a moment...</title><script>window._cf_chl_opt={cType: \'non-interactive\'}</script>'), 'cloudflare_interstitial');
  const m = detectChallengeHtml('<html><script>window._cf_chl_opt={cvId:"3",cType: \'managed\'}</script></html>');
  assert.equal(m.ctype, 'managed');
  assert.equal(m.interactive, true);
  assert.equal(t('<div id="challenge-running">Checking your browser before accessing x.com</div>'), 'cloudflare_interstitial');
  assert.equal(t('<script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1?ray=1"></script>'), 'cloudflare_interstitial');
  // lokalizált cím + challenge-platform
  assert.equal(t('<title>Egy pillanat…</title><script src="/cdn-cgi/challenge-platform/h/b/x"></script>'), 'cloudflare_interstitial');
  assert.equal(t('<title>Egy pillanat…</title><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>'), null);
  assert.equal(t('<title>Egy pillanat...</title><form class="cf-chl" action="?__cf_chl_f_tk=1"></form>'), 'cloudflare_interstitial');
  const blk = detectChallengeHtml('<div id="cf-error-details"><h1>Sorry, you have been blocked</h1><span class="cf-error-code">1020</span></div>');
  assert.deepEqual([blk.type, blk.block], ['cloudflare_block', true]);
  assert.equal(t("<script>var dd={'rt':'i','cid':'x','t':'fe','host':'geo.captcha-delivery.com'}</script>"), 'datadome_interstitial');
  assert.equal(t("<script>var dd={'rt':'c','cid':'x','t':'fe','host':'geo.captcha-delivery.com'}</script>"), 'datadome_captcha');
  assert.equal(t("<script>var dd={'rt':'c','cid':'x','t':'bv','host':'geo.captcha-delivery.com'}</script>"), 'datadome_block');
  assert.equal(t('<title>Access to this page has been denied</title><div id="px-captcha"></div>'), 'perimeterx');
  assert.equal(t('<script>window._pxAppId="PX1"</script><p>Press &amp; Hold to confirm</p>'), 'perimeterx');
  assert.equal(t('<iframe src="/_Incapsula_Resource?SWUDNSAI=1"></iframe>'), 'imperva_interstitial');
  assert.equal(t('Request unsuccessful. Incapsula incident ID: 123'), 'imperva_block');
  assert.equal(t('<script src="/_sec/cp_challenge/sec-cpt-int-4-3.js"></script>'), 'akamai_challenge');
  assert.equal(t('<html><body><form><div class="cf-turnstile" data-sitekey="0x4AAA"></div></form><script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script></body></html>'), 'turnstile_gate');
  assert.equal(t('<form><div class="g-recaptcha" data-sitekey="6Lc"></div></form>'), 'recaptcha_gate');
  assert.equal(t('<form><div class="h-captcha" data-sitekey="abc"></div></form>'), 'hcaptcha_gate');
});

test('felismerő: NEM challenge — normál CF-lap (jsd-szkript, Ray ID), hosszú cikk widgettel, üres', () => {
  const long = '<p>' + 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(60) + '</p>';
  assert.equal(detectChallengeHtml('<title>News</title>' + long +
    '<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script><footer>Cloudflare Ray ID: 8a1b · Performance &amp; security by Cloudflare</footer>'), null);
  // A cikk alján ülő Turnstile/reCAPTCHA-űrlap nem kapu.
  assert.equal(detectChallengeHtml('<article>' + long + '</article><div class="cf-turnstile" data-sitekey="0x4"></div><script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>'), null);
  assert.equal(detectChallengeHtml('<article>' + long + '</article><div class="g-recaptcha" data-sitekey="6L"></div>'), null);
  // a Turnstile api.js widget-elem nélkül (átengedett CF-lap) nem kapu
  assert.equal(detectChallengeHtml('<title>Done</title><h1>You bypassed the Cloudflare challenge! :D</h1><script src="https://challenges.cloudflare.com/turnstile/v0/api.js"></script>'), null);
  // invisible reCAPTCHA v3 szkript önmagában semmi
  assert.equal(detectChallengeHtml('<div id="app"></div><script src="https://www.google.com/recaptcha/api.js?render=6L"></script>'), null);
  assert.equal(detectChallengeHtml(''), null);
  assert.equal(detectChallengeHtml(null), null);
  // „Just a moment" egy cikk SZÖVEGÉBEN (cím nélkül) nem jel
  assert.equal(detectChallengeHtml('<title>Blog</title>' + long + '<p>Just a moment... said the narrator.</p>'), null);
});

test('clearance-sütik: csak az átengedő sütik, lejártak nélkül; konfiguráció', () => {
  const now = 1_000_000;
  const out = clearanceCookies([
    { name: 'cf_clearance', value: 'a', expires: now + 3600 },
    { name: 'cf_clearance', value: 'old', expires: now - 10 },
    { name: 'datadome', value: 'b', expires: -1 },
    { name: '_px3', value: 'c' },
    { name: 'sessionid', value: 'SECRET' },
    { name: '_ga', value: 'x' },
  ], now);
  assert.deepEqual(out.map(c => c.value), ['a', 'b', 'c']);
  assert.deepEqual(challengeConfig({}), { waitMs: 15000, interactiveWaitMs: 5000, pollMs: 500, busyWaitMs: 5000, solve: false, clearanceTtlMs: 1500000 });
  assert.equal(challengeConfig({ CHALLENGE_WAIT_MS: '0' }).waitMs, 0);
  assert.equal(challengeConfig({ CHALLENGE_WAIT_MS: '999999' }).waitMs, 60000);
  assert.equal(challengeConfig({ CHALLENGE_SOLVE: '1' }).solve, true);
  assert.equal(challengeHealth({ CHALLENGE_WAIT_MS: '0' }).clearance_reuse, false);
});

// ─── 2. Valódi böngésző ──────────────────────────────────────────────────
let fx, c;
test.before(async () => {
  if (!browserPath) return;
  fx = await startFixture(challengeRoutes());
  const { BraveController } = await import('../src/brave-controller.js');
  c = new BraveController();
  await c.initialize();
});
test.after(async () => {
  if (c) await c.close();
  if (fx) await fx.close();
  process.chdir(os.tmpdir());
  fs.rmSync(tmp, { recursive: true, force: true });
});

const withEnv = async (env, fn) => {
  const old = {};
  for (const [k, v] of Object.entries(env)) { old[k] = process.env[k]; process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
};

test('CF interstitial (default szint): kivár, átjut, a tartalom használható; a clearance mentve', { skip, timeout: 60000 }, async () => {
  const t0 = Date.now();
  const r = await c.scrape(`${fx.base}/cf?d=2500`, { waitUntil: 'domcontentloaded' });
  const ms = Date.now() - t0;
  assert.ok(r.challenge, JSON.stringify(r).slice(0, 300));
  assert.equal(r.challenge.type, 'cloudflare_interstitial');
  assert.equal(r.challenge.ctype, 'non-interactive');
  assert.equal(r.challenge.passed, true);
  assert.ok(r.challenge.waited_ms >= 2000 && r.challenge.waited_ms < 12000, `waited_ms=${r.challenge.waited_ms}`);
  assert.ok(r.challenge.navigations >= 1);
  assert.equal(r.cf_status, 'cleared_attempt_1');
  assert.equal(r.content_usable, true, r.block_reason);
  assert.match(r.markdown, /ARTICLE-CONTENT-OK/);
  assert.ok(ms < 15000, `${ms} ms`);
  const saved = JSON.parse(fs.readFileSync(path.join(tmp, '.sessions', '_clearance_127.0.0.1.json'), 'utf8'));
  assert.deepEqual(saved.cookies.map(x => `${x.name}=${x.value}`), ['cf_clearance=cf-ok']);
  assert.match(saved.ua, /Mozilla\/5\.0/);
});

test('clearance-újrahasznosítás: FRISS böngésző a mentett sütivel + UA-val challenge nélkül jut át', { skip, timeout: 60000 }, async () => {
  // Egyszerre egy böngésző: a régit zárjuk, a friss lesz a további tesztek böngészője.
  const { BraveController } = await import('../src/brave-controller.js');
  await c.close();
  c = new BraveController();
  await c.initialize();
  const t0 = Date.now();
  const r = await c.scrape(`${fx.base}/cf?d=2500`, { waitUntil: 'domcontentloaded' });
  assert.equal(r.challenge, undefined, JSON.stringify(r.challenge));
  assert.match(r.markdown, /ARTICLE-CONTENT-OK/);
  assert.ok(Date.now() - t0 < 5000);
});

test('sosem átengedő interstitial: passed:false a kereten belül, content_usable:false, block_reason', { skip, timeout: 60000 }, async () => {
  const r = await withEnv({ CHALLENGE_WAIT_MS: '3000' }, () => c.scrape(`${fx.base}/cf-never`, { waitUntil: 'domcontentloaded' }));
  assert.equal(r.challenge.type, 'cloudflare_interstitial');
  assert.equal(r.challenge.passed, false);
  assert.ok(r.challenge.waited_ms >= 2500 && r.challenge.waited_ms < 5000, `waited_ms=${r.challenge.waited_ms}`);
  assert.equal(r.content_usable, false);
  assert.equal(r.block_reason, 'challenge:cloudflare_interstitial');
  assert.equal(r.cf_status, 'blocked');
});

test('DataDome interstitial átjut; PerimeterX rövid várakozás; CF-tiltás azonnal; normál lap 0 többlet', { skip, timeout: 90000 }, async () => {
  const dd = await c.scrape(`${fx.base}/dd?d=1500`, { waitUntil: 'domcontentloaded' });
  assert.equal(dd.challenge.type, 'datadome_interstitial');
  assert.equal(dd.challenge.passed, true);
  assert.match(dd.markdown, /ARTICLE-CONTENT-OK/);

  const px = await withEnv({ CHALLENGE_INTERACTIVE_WAIT_MS: '1500' }, () => c.scrape(`${fx.base}/px`, { waitUntil: 'domcontentloaded' }));
  assert.equal(px.challenge.type, 'perimeterx');
  assert.equal(px.challenge.interactive, true);
  assert.equal(px.challenge.passed, false);
  assert.ok(px.challenge.waited_ms < 3500, `waited_ms=${px.challenge.waited_ms}`);
  assert.equal(px.block_reason, 'challenge:perimeterx');

  const blk = await c.scrape(`${fx.base}/cf-block`, { waitUntil: 'domcontentloaded' });
  assert.equal(blk.challenge.type, 'cloudflare_block');
  assert.equal(blk.challenge.blocked, true);
  assert.equal(blk.challenge.passed, false);
  assert.ok(blk.challenge.waited_ms < 500);

  const t0 = Date.now();
  const n = await c.scrape(`${fx.base}/normal`, { waitUntil: 'domcontentloaded' });
  assert.equal(n.challenge, undefined);
  assert.equal(n.content_usable, true);
  assert.ok(Date.now() - t0 < 4000);
});

test('Turnstile: CHALLENGE_SOLVE nélkül nem kattint (nem jut át); vele valódi, emberi mozdulatú kattintás → átjut', { skip, timeout: 90000 }, async (t) => {
  const no = await withEnv({ CHALLENGE_WAIT_MS: '4000' }, () => c.scrape(`${fx.base}/ts`, { waitUntil: 'domcontentloaded' }));
  assert.equal(no.challenge.type, 'cloudflare_interstitial');
  assert.equal(no.challenge.ctype, 'managed');
  assert.equal(no.challenge.passed, false);
  assert.equal(no.challenge.solve, undefined);

  const yes = await withEnv({ CHALLENGE_SOLVE: '1' }, () => c.scrape(`${fx.base}/ts`, { waitUntil: 'domcontentloaded' }));
  assert.equal(yes.challenge.passed, true, JSON.stringify(yes.challenge));
  assert.equal(yes.challenge.solve.attempted, true);
  assert.equal(yes.challenge.solve.target, 'turnstile');
  assert.ok(yes.challenge.solve.clicks >= 1);
  assert.match(yes.markdown, /ARTICLE-CONTENT-OK/);
  const info = (yes.text.match(/TS_INFO (.*?) Paragraph/) || [])[1] || '';
  t.diagnostic(`TS_INFO ${info} · solve=${JSON.stringify(yes.challenge.solve)}`);
  assert.match(info, /trusted=true/, info);
  const mainMoves = Number((info.match(/main_moves=(\d+)/) || [])[1]);
  const frameMoves = Number((info.match(/frame_moves=(\d+)/) || [])[1]);
  const pressMs = Number((info.match(/press_ms=(\d+)/) || [])[1]);
  // Emberi pálya: sok egéresemény a célig (nem egyetlen teleport), valódi gombnyomás-idő.
  assert.ok(mainMoves + frameMoves >= 5, info);
  assert.ok(pressMs >= 25, info);
});

test('Turnstile: a „Verifying…" alatt NEM kattint — csak a megjelenő checkboxra (egyszer)', { skip, timeout: 60000 }, async (t) => {
  // Az előző teszt clearance-e (böngésző-sütitár + clearance-tár) ne vigye át.
  const page = await c.newPage();
  await page.deleteCookie({ name: 'cf_clearance', url: fx.base }).catch(() => {});
  await page.close();
  fs.rmSync(path.join(tmp, '.sessions', '_clearance_127.0.0.1.json'), { force: true });
  const r = await withEnv({ CHALLENGE_SOLVE: '1' }, () => c.scrape(`${fx.base}/ts?show=4500`, { waitUntil: 'domcontentloaded' }));
  assert.equal(r.challenge.passed, true, JSON.stringify(r.challenge));
  assert.equal(r.challenge.solve.clicks, 1);
  const info = (r.text.match(/TS_INFO (.*?) Paragraph/) || [])[1] || '';
  t.diagnostic(`TS_INFO ${info}`);
  assert.match(info, /trusted=true/);
  assert.match(info, /early_clicks=0/);
  assert.ok(r.challenge.waited_ms >= 4500, `waited_ms=${r.challenge.waited_ms}`);
});

test('megoldó-horog: aktív szolgáltatóval a Turnstile-kapu tokenje befecskendezve → átjut; purpose≠read → nem hív', { skip, timeout: 60000 }, async () => {
  const { registerProvider } = await import('../src/captcha/provider.js');
  const { handleChallenge, detectChallengeHtml: det } = await import('../src/challenge.js');
  const calls = [];
  const off = registerProvider('fakets', { kinds: ['turnstile'], solve: async (req) => {
    calls.push({ kind: req.kind, purpose: req.purpose, sitekey: req.meta.sitekey, hasPage: !!req.page });
    return { ok: true, answer: 'FAKE-TOKEN-1', cost_usd: 0 };
  } });
  try {
    const r = await withEnv({ CAPTCHA_SOLVER_PROVIDER: 'fakets' }, () => c.scrape(`${fx.base}/gate`, { waitUntil: 'domcontentloaded' }));
    assert.equal(r.challenge.type, 'turnstile_gate');
    assert.equal(r.challenge.passed, true, JSON.stringify(r.challenge));
    assert.equal(r.challenge.solver.provider, 'fakets');
    assert.equal(r.challenge.solver.inject, 'callback');
    assert.match(r.text, /GATE_TOKEN FAKE-TOKEN-1/);
    assert.deepEqual(calls, [{ kind: 'turnstile', purpose: 'read', sitekey: '0x4AAAAAAAGateFixtureKey0', hasPage: true }]);

    // Ugyanaz a kezelő NEM olvasási céllal: a szolgáltató nem hívódik, nem kattint.
    const page = await c.newPage();
    try {
      await page.goto(`${fx.base}/gate?x=1`, { waitUntil: 'domcontentloaded' });
      await page.deleteCookie({ name: 'cf_clearance' });
      await page.reload({ waitUntil: 'domcontentloaded' });
      const first = det(await page.content());
      assert.equal(first.type, 'turnstile_gate');
      const { info } = await withEnv({ CAPTCHA_SOLVER_PROVIDER: 'fakets', CHALLENGE_SOLVE: '1' }, () =>
        handleChallenge(page, first, { waitMs: 1500, interactiveWaitMs: 1500, pollMs: 300, solve: true, purpose: 'interact', human: c._humanInput() }));
      assert.equal(info.passed, false);
      assert.equal(info.solver, undefined);
      assert.equal(info.solve, undefined);
      assert.equal(calls.length, 1);
    } finally { await page.close(); }
  } finally { off(); }
});

test('határidő: a crawl-oldal határideje a kivárást is vágja', { skip, timeout: 30000 }, async () => {
  const t0 = Date.now();
  let r = null, err = null;
  try {
    r = await c.scrape(`${fx.base}/cf-never`, { waitUntil: 'domcontentloaded', deadlineTs: Date.now() + 2500 });
  } catch (e) { err = e; }
  const ms = Date.now() - t0;
  assert.ok(ms < 4500, `${ms} ms`);
  if (r) { assert.equal(r.challenge?.passed, false); assert.equal(r.challenge?.cut, 'deadline'); }
  else assert.match(String(err?.message), /page_deadline_exceeded/);
});

test('terhelés: ha mások várnak a scrape-kapura, a kivárás CHALLENGE_BUSY_WAIT_MS után elengedi a slotot', { skip, timeout: 30000 }, async () => {
  const { handleChallenge, detectChallengeHtml: det } = await import('../src/challenge.js');
  const page = await c.newPage();
  try {
    await page.goto(`${fx.base}/cf-never`, { waitUntil: 'domcontentloaded' });
    const t0 = Date.now();
    const { info } = await handleChallenge(page, det(await page.content()), {
      waitMs: 10000, pollMs: 200, purpose: 'read', busy: () => true, busyWaitMs: 1000,
    });
    assert.equal(info.passed, false);
    assert.equal(info.cut, 'busy');
    assert.ok(Date.now() - t0 < 2500, `${Date.now() - t0} ms`);
  } finally { await page.close(); }
});

test('CHALLENGE_WAIT_MS=0: a régi út (nincs kivárás, nincs challenge-mező)', { skip, timeout: 30000 }, async () => {
  const t0 = Date.now();
  const r = await withEnv({ CHALLENGE_WAIT_MS: '0' }, () => c.scrape(`${fx.base}/cf-never`, { waitUntil: 'domcontentloaded' }));
  assert.equal(r.challenge, undefined);
  assert.equal(r.cf_status, 'skipped');
  assert.ok(Date.now() - t0 < 4000);
});
