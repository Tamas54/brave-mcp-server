// TF-evasions (TINYFISH PARITY 2.9, 2026-10-07).
//
// 1. rész (böngésző nélkül): a persona tiszta függvényei (GREASE a mért
//    Chrome/Brave értékekre, a fork hibáinak HIÁNYA), a kapcsoló, a puppeteer-
//    extra evasion-metszés, az indítási argumentumok, a vendorolt fork-fájlok
//    sértetlensége és a 3 visszalépés hiánya, a lapszkript globális-mentessége.
// 2. rész (valódi böngésző + HTTP-szerver, mint a http-e2e): a jeldetektor-
//    fixtúra a brave_scrape default/stealth szintjén — BE: a persona-jelek
//    zöldek; KI: a régi viselkedés bitre változatlan (Chrome/120 UA, statikus
//    stealth-fejlécek). Böngésző nélkül kimarad.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { findBrowser, startFixture } from './helpers.js';
import { probeRoutes, parseProbe } from './fixtures/stealth-probe.js';
import {
  buildPersona, brandList, greasedBrand, webglForUA, osFromUA, brandFor, parseLanguages,
} from '../src/stealth/tf-evasions/persona.js';
import {
  tfEvasionsEnabled, tfConfig, tfHealth, tfLaunchOptions, pruneSupersededEvasions, TF_SUPERSEDED_PE_EVASIONS,
} from '../src/stealth/tf-evasions/index.js';
import { buildPageScript, vendorBody } from '../src/stealth/tf-evasions/page-script.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

// ─── 1. Tiszta részek ────────────────────────────────────────────────

test('kapcsoló: alapból KI, csak explicit igaz értékre BE', () => {
  for (const v of [undefined, '', '0', 'false', 'off', 'no', 'igen']) {
    assert.equal(tfEvasionsEnabled({ STEALTH_TF_EVASIONS: v }), false, String(v));
  }
  for (const v of ['1', 'true', 'TRUE', 'on', 'yes', ' 1 ']) {
    assert.equal(tfEvasionsEnabled({ STEALTH_TF_EVASIONS: v }), true, v);
  }
  assert.deepEqual(tfHealth({}), { enabled: false });
  // Alapértékek = a mért legjobb kombináció (STEALTH_AB.md): host + native.
  const c = tfConfig({});
  assert.equal(c.osMode, 'host');
  assert.equal(c.webgl, 'native');
  assert.deepEqual(c.languages, ['en-US', 'en']);
  const c2 = tfConfig({ STEALTH_TF_PERSONA_OS: 'ua', STEALTH_TF_WEBGL: 'mask', STEALTH_TF_LANGUAGES: 'de-DE,de;q=0.9' });
  assert.equal(c2.osMode, 'ua');
  assert.equal(c2.webgl, 'mask');
  assert.equal(tfConfig({ STEALTH_TF_PERSONA_OS: 'valami', STEALTH_TF_WEBGL: 'x' }).osMode, 'host');
  assert.deepEqual(c2.languages, ['de-DE', 'de']);
  const h = tfHealth({ STEALTH_TF_EVASIONS: '1' });
  assert.equal(h.enabled, true);
  assert.deepEqual(h.superseded_pe_evasions, [...TF_SUPERSEDED_PE_EVASIONS]);
});

test('GREASE: a Chromium mai algoritmusa (mért és ismert verziókra)', () => {
  // Mérve 2026-10-07: Brave 1.96 / Chrome 154 natív navigator.userAgentData.brands.
  assert.deepEqual(brandList(154, 'Brave', '154'), [
    { brand: 'Chromium', version: '154' }, { brand: 'Brave', version: '154' }, { brand: 'Not A(Brand', version: '99' }]);
  assert.deepEqual(brandList(154, 'Google Chrome', '154'), [
    { brand: 'Chromium', version: '154' }, { brand: 'Google Chrome', version: '154' }, { brand: 'Not A(Brand', version: '99' }]);
  // Ismert valódi Chrome-értékek (sec-ch-ua).
  assert.deepEqual(brandList(120, 'Google Chrome', '120'), [
    { brand: 'Not_A Brand', version: '8' }, { brand: 'Chromium', version: '120' }, { brand: 'Google Chrome', version: '120' }]);
  assert.deepEqual(brandList(124, 'Google Chrome', '124').map(b => b.brand), ['Chromium', 'Google Chrome', 'Not-A.Brand']);
  // fullVersionList: a GREASE-verzió négytagú (mérve: "99.0.0.0").
  const full = brandList(154, 'Google Chrome', '154.0.8037.57');
  assert.deepEqual(full[2], { brand: 'Not A(Brand', version: '99.0.0.0' });
  assert.equal(greasedBrand(154).brand, 'Not A(Brand');
  // A puppeteer-extra elavult alakja („;Not A Brand") nem jöhet ki.
  assert.ok(!brandList(154, 'Google Chrome', '154').some(b => b.brand.startsWith(';')));
});

test('persona: koherens, determinisztikus, a fork hibái nélkül', () => {
  const win = buildPersona({ uaHint: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) … Chrome/120.0.0.0', browserVersion: 'Chrome/154.0.8037.98', brand: 'Brave' });
  assert.equal(win.os, 'Windows');
  assert.equal(win.platform, 'Win32');                     // NEM "Win64" (fork-hiba)
  assert.equal(win.userAgentMetadata.platform, 'Windows');
  assert.match(win.userAgent, /^Mozilla\/5\.0 \(Windows NT 10\.0; Win64; x64\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/154\.0\.0\.0 Safari\/537\.36$/);
  assert.equal(win.userAgentMetadata.fullVersion, '154.0.0.0');   // Brave: redukált (mérve)
  assert.deepEqual(win.userAgentMetadata.brands.map(b => b.brand), ['Chromium', 'Brave', 'Not A(Brand']);
  assert.equal(win.acceptLanguage, 'en-US,en');            // q-érték NÉLKÜL (mérve: q-val kettőzött fejléc)
  assert.ok(!/;q=/.test(win.acceptLanguage));
  assert.match(win.webgl.renderer, /Direct3D11/);
  assert.ok(!/Apple|OpenGL Engine/.test(win.webgl.renderer));

  const lin = buildPersona({ uaHint: 'Mozilla/5.0 (X11; Linux x86_64)', browserVersion: 'Chrome/154.0.8037.57', brand: 'Google Chrome' });
  assert.equal(lin.platform, 'Linux x86_64');               // NEM "Linux x86_x64" (fork-hiba)
  assert.equal(lin.userAgentMetadata.platform, 'Linux');
  assert.equal(lin.userAgentMetadata.fullVersion, '154.0.8037.57');  // Chrome: valódi teljes verzió
  assert.match(lin.webgl.renderer, /Mesa/);

  const mac = buildPersona({ uaHint: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', browserVersion: 'Chrome/154.0.1.2' });
  assert.equal(mac.platform, 'MacIntel');
  assert.equal(mac.userAgentMetadata.platform, 'macOS');
  assert.match(mac.webgl.renderer, /Apple M1/);

  // Determinizmus: ugyanaz a bemenet → ugyanaz a persona (a fork hívásonként sorsolt).
  const a = buildPersona({ uaHint: 'Windows', browserVersion: 'Chrome/154.0.8037.98' });
  const b = buildPersona({ uaHint: 'Windows', browserVersion: 'Chrome/154.0.8037.98' });
  assert.deepEqual(a, b);
  // host-mód: a gazdagép OS-e, a kért UA-tól függetlenül.
  assert.equal(buildPersona({ uaHint: 'Windows', browserVersion: 'Chrome/154.0.0.0', osMode: 'host', platform: 'linux' }).os, 'Linux');
  // Nyelvek: a fejléc és a JS EGY forrásból, q-értékek nélkül.
  assert.deepEqual(parseLanguages('en-US,en;q=0.9, hu;q=0.8,en'), ['en-US', 'en', 'hu']);
  assert.equal(buildPersona({ uaHint: 'Windows', browserVersion: 'Chrome/154.0.0.0', languages: 'en-US,en;q=0.9,hu;q=0.8' }).acceptLanguage, 'en-US,en,hu');
});

test('persona: OS- és márkafelismerés', () => {
  assert.equal(osFromUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'Windows');
  assert.equal(osFromUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), 'macOS');
  assert.equal(osFromUA('Mozilla/5.0 (X11; Linux x86_64)'), 'Linux');
  assert.equal(osFromUA('valami'), 'Windows');
  assert.equal(brandFor('/usr/bin/brave-browser', {}), 'Brave');
  assert.equal(brandFor('/snap/bin/brave', {}), 'Brave');
  assert.equal(brandFor('/usr/bin/google-chrome', {}), 'Google Chrome');
  assert.equal(brandFor('/usr/bin/chromium', {}), null);
  assert.equal(brandFor('/usr/bin/brave-browser', { STEALTH_TF_BRAND: 'Google Chrome' }), 'Google Chrome');
  assert.equal(webglForUA('Mozilla/5.0 (Linux; Android 14; Pixel 8)').vendor, 'Google Inc. (Qualcomm)');
});

test('puppeteer-extra: CSAK a 4 felváltott evasion esik ki, a többi marad', () => {
  const StealthPlugin = require('puppeteer-extra-plugin-stealth');
  const s = StealthPlugin();
  const before = new Set(s.enabledEvasions);
  pruneSupersededEvasions(s);
  for (const e of TF_SUPERSEDED_PE_EVASIONS) assert.ok(!s.enabledEvasions.has(e), e);
  for (const e of before) if (!TF_SUPERSEDED_PE_EVASIONS.includes(e)) assert.ok(s.enabledEvasions.has(e), `kiesett: ${e}`);
  // A webdriver/chrome.app/plugins evasionök (a fork 3 visszalépésének helyes
  // megfelelői) a puppeteer-extra-ból maradnak.
  for (const e of ['navigator.webdriver', 'chrome.app', 'navigator.plugins', 'iframe.contentWindow']) assert.ok(s.enabledEvasions.has(e), e);
});

test('indítási argumentumok: érvényes --lang, --accept-lang, persona --user-agent, LANG', () => {
  const base = { executablePath: '/x/brave', args: ['--no-sandbox', '--lang=en-US,en', '--window-size=1920,1080'] };
  const o = tfLaunchOptions(base, { env: { STEALTH_TF_PERSONA_OS: 'ua' }, major: '154' });
  assert.ok(!o.args.includes('--lang=en-US,en'));
  assert.equal(o.args.filter(a => a.startsWith('--lang=')).length, 1);
  assert.ok(o.args.includes('--lang=en-US'));
  assert.ok(o.args.includes('--accept-lang=en-US,en'));
  assert.ok(o.args.includes('--no-sandbox') && o.args.includes('--window-size=1920,1080'));
  const ua = o.args.find(a => a.startsWith('--user-agent='));
  assert.match(ua, /Windows NT 10\.0.*Chrome\/154\.0\.0\.0 Safari/);
  assert.equal(o.env.LANG, 'en_US.UTF-8');
  assert.deepEqual(base.args, ['--no-sandbox', '--lang=en-US,en', '--window-size=1920,1080']); // a bemenet érintetlen
  // Verzió nélkül nincs --user-agent (nem találgatunk); az alap host-módban a gazdagép OS-e.
  assert.ok(!tfLaunchOptions(base, { env: {}, major: null }).args.some(a => a.startsWith('--user-agent=')));
  if (process.platform === 'linux') {
    assert.match(tfLaunchOptions(base, { env: {}, major: '154' }).args.find(a => a.startsWith('--user-agent=')), /X11; Linux x86_64/);
  }
});

test('vendorolt fork-fájlok: bájtra azonosak a forrással, a 3 visszalépés NINCS átvéve', () => {
  // sha256 a tf-playwright-stealth @ b1206e7 fájljaira (THIRD_PARTY_NOTICES.md).
  const expected = {
    'utils.js': '5da4900381a4c45fce9db88993834ad812c3a193d76e95b2a112b15ce40f047a',
    'webgl.vendor.js': 'a14f0cab3b5e2bac9afd4ed22e4976d5e9d412b878e7a8f57fa919e06fe55b60',
  };
  const dir = path.join(ROOT, 'src', 'stealth', 'tf-evasions', 'vendor');
  assert.deepEqual(fs.readdirSync(dir).sort(), Object.keys(expected).sort());
  for (const [f, h] of Object.entries(expected)) {
    assert.equal(createHash('sha256').update(vendorBody(f)).digest('hex'), h, f);
  }
  const notices = fs.readFileSync(path.join(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8');
  for (const h of Object.values(expected)) assert.ok(notices.includes(h), `a NOTICES-ból hiányzik: ${h}`);
  for (const c of ['b1206e7ed847bf02d3aa895c3e09da02db4fd3bd', '43f7433057906945b1648179304d7dbd8eb10874', 'Copyright (c) 2020 ASAS1314', 'Copyright (c) 2019 berstend']) {
    assert.ok(notices.includes(c), `a NOTICES-ból hiányzik: ${c}`);
  }
  const script = buildPageScript();
  assert.ok(!/delete Object\.getPrototypeOf\(navigator\)\.webdriver/.test(script), 'webdriver-delete visszalépés');
  assert.ok(!/hasPlugins\s*=\s*false/.test(script), 'hasPlugins=false visszalépés');
  assert.ok(!/window\.chrome\s*=\s*\{/.test(script), 'window.chrome felülírás visszalépés');
});

test('lapszkript: egyetlen IIFE, nem szivárogtat globálist, WebGL nélkül sem dob', () => {
  const script = buildPageScript();
  assert.ok(script.startsWith('(() => {') && script.trimEnd().endsWith('})();'));
  // Böngésző-API-k nélküli környezet: semmi nem dobhat kifelé, és nem marad
  // `utils` / `opts` / `getParameterProxyHandler` a globálison.
  const ctx = vm.createContext({ navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0)' } });
  vm.runInContext(script, ctx);
  for (const k of ['utils', 'opts', 'getParameterProxyHandler', 'addProxy']) assert.equal(k in ctx, false, k);
  // Minimális WebGL-makett: a proxy a persona-értéket adja, a natív hívás előbb lefut.
  let nativeCalls = 0;
  function WebGLRenderingContext() {}
  WebGLRenderingContext.prototype.getParameter = function getParameter(p) { nativeCalls++; return `native-${p}`; };
  function WebGL2RenderingContext() {}
  WebGL2RenderingContext.prototype.getParameter = function getParameter(p) { nativeCalls++; return `native2-${p}`; };
  const ctx2 = vm.createContext({ navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }, WebGLRenderingContext, WebGL2RenderingContext });
  vm.runInContext(script, ctx2);
  const gl = new WebGLRenderingContext();
  assert.equal(gl.getParameter(37445), 'Google Inc. (Intel)');
  assert.match(gl.getParameter(37446), /^ANGLE \(Intel, .*Direct3D11/);
  assert.equal(gl.getParameter(7936), 'native-7936');
  assert.equal(nativeCalls, 3);
  assert.equal('utils' in ctx2, false);
});

// ─── 2. Valódi böngésző + HTTP-szerver ──────────────────────────────

const browserPath = findBrowser();
const skip = !browserPath && 'nincs böngésző (BRAVE_PATH)';

async function freePort() {
  const s = net.createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise(r => s.close(r));
  return p;
}

async function startServer(extraEnv) {
  const port = await freePort();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bmcp-tf-'));
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('RAILWAY_') || k.startsWith('BRAVE_') || k.startsWith('STEALTH_TF_')) delete env[k];
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
  let seq = 0;
  const scrape = async (args) => {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method: 'tools/call', params: { name: 'brave_scrape', arguments: args } }),
    });
    const j = await r.json();
    assert.ok(!j.error, JSON.stringify(j.error));
    return JSON.parse(j.result.content[0].text);
  };
  const health = async () => (await fetch(`${base}/health`)).json();
  const stop = async () => {
    child.kill('SIGTERM');
    await new Promise(r => { child.once('exit', r); setTimeout(r, 8000); });
    fs.rmSync(cwd, { recursive: true, force: true });
  };
  return { scrape, health, stop, log: () => log };
}

const ok = (p, k) => assert.equal(p.results[k]?.bot, false, `${k}: ${JSON.stringify(p.results[k])}`);

test('e2e BE (STEALTH_TF_EVASIONS=1, alapértékek): a persona-jelek zöldek mindkét szinten', { skip, timeout: 120000 }, async (t) => {
  const fx = await startFixture(probeRoutes());
  const srv = await startServer({ STEALTH_TF_EVASIONS: '1' });
  t.after(async () => { await srv.stop(); await fx.close(); });

  const h = await srv.health();
  assert.equal(h.stealth_tf?.enabled, true, JSON.stringify(h.stealth_tf));
  assert.equal(h.stealth_tf.persona_os, 'host');
  assert.equal(h.stealth_tf.webgl, 'native');

  for (const stealth of [false, true]) {
    const r = await srv.scrape({ url: `${fx.base}/probe`, stealth, waitTime: 800 });
    const p = parseProbe(r.text);
    assert.ok(p, `nincs probe-eredmény (stealth=${stealth}): ${String(r.text).slice(0, 200)}`);
    for (const k of ['webdriver_value', 'ua_headless_token', 'ua_header_vs_js', 'platform_vs_ua', 'uad_brands_nonempty',
      'uad_major_vs_ua', 'uad_platform_vs_ua', 'ch_header_vs_uad', 'languages_vs_accept_language', 'language_vs_languages0',
      'webgl_renderer_vs_ua_os', 'worker_ua_vs_main', 'worker_platform_vs_main', 'worker_languages_vs_main',
      'worker_hardwareConcurrency_vs_main', 'worker_webgl_vs_main',
      'subresource_accept', 'subresource_upgrade_insecure', 'global_leaks', 'getters_look_native']) {
      ok(p, k);
    }
    // A UA verziója a futó böngészőé (nem a régi Chrome/120).
    assert.ok(!/Chrome\/120\./.test(p.results.uad_major_vs_ua.v), p.results.uad_major_vs_ua.v);
  }
});

test('e2e BE, fork-mód (PERSONA_OS=ua, WEBGL=mask): a vendorolt webgl.vendor élesben fut, OS-konzisztens', { skip, timeout: 120000 }, async (t) => {
  const fx = await startFixture(probeRoutes());
  const srv = await startServer({ STEALTH_TF_EVASIONS: '1', STEALTH_TF_PERSONA_OS: 'ua', STEALTH_TF_WEBGL: 'mask' });
  t.after(async () => { await srv.stop(); await fx.close(); });
  const h = await srv.health();
  assert.equal(h.stealth_tf.persona_os, 'ua');
  assert.equal(h.stealth_tf.webgl, 'mask');
  // default szint: Windows-persona → ANGLE/Direct3D renderer, natívnak látszó getParameter.
  const p = parseProbe((await srv.scrape({ url: `${fx.base}/probe`, stealth: false, waitTime: 800 })).text);
  assert.ok(p, 'nincs probe-eredmény');
  if (p.results.webgl_available.v === true) {
    assert.equal(p.results.webgl_vendor.v, 'Google Inc. (Intel)');
    assert.match(String(p.results.webgl_renderer_software.v), /Direct3D11/);
    ok(p, 'webgl_renderer_vs_ua_os');
  }
  for (const k of ['platform_vs_ua', 'uad_platform_vs_ua', 'uad_brands_nonempty', 'global_leaks', 'getters_look_native']) ok(p, k);
  assert.match(p.results.platform_vs_ua.v, /^Win32 /);
});

test('e2e KI (alap): a régi viselkedés változatlan — Chrome/120, statikus stealth-fejlécek', { skip, timeout: 120000 }, async (t) => {
  const fx = await startFixture(probeRoutes());
  const srv = await startServer({});
  t.after(async () => { await srv.stop(); await fx.close(); });

  const h = await srv.health();
  assert.deepEqual(h.stealth_tf, { enabled: false });

  const d = parseProbe((await srv.scrape({ url: `${fx.base}/probe`, stealth: false, waitTime: 800 })).text);
  assert.ok(d, 'nincs probe-eredmény (default)');
  assert.match(d.results.uad_major_vs_ua.v, /vs UA 120$/);           // a fix Chrome/120 UA marad
  assert.equal(d.results.uad_brands_nonempty.bot, true);              // metadata nélküli setUserAgent (régi jel)
  const s = parseProbe((await srv.scrape({ url: `${fx.base}/probe`, stealth: true, waitTime: 800 })).text);
  assert.ok(s, 'nincs probe-eredmény (stealth)');
  assert.equal(s.results.subresource_accept.bot, true);               // a statikus Accept-fejléc marad
  assert.match(s.results.languages_vs_accept_language.v, /hu$/);      // …és az en-US,en;q=0.9,hu;q=0.8
});
