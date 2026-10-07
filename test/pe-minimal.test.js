// „pe-minimál" stealth-mód (R2-E, P1-3, 2026-10-07) — STEALTH_PE_MINIMAL=1.
//
// Tiszta rész: a kapcsoló, a kivett / bent hagyott evasion-lista, a /health.
// e2e (böngészővel, helyi 127.0.0.1 fixtúrán, a valódi HTTP-szerveren át): a
// puppeteer-extra Proxy-shimjei (Function.prototype.toString, canPlayType)
// pe-minimálban NINCSENEK a lapon, a meglévő probe-jelek nem romlanak.
// A nyilvános detektorok A/B-je: scripts/stealth-ab.mjs (on / on_peminimal),
// eredmény: ~/recon/tinyfish/STEALTH_AB.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser, startFixture } from './helpers.js';
import { probeRoutes, parseProbe } from './fixtures/stealth-probe.js';
import { PE_MINIMAL_DISABLED, peMinimalEnabled, prunePeMinimal, peMinimalHealth } from '../src/stealth/pe-minimal.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

test('kapcsoló: alapból KI; a natívan jó shimek kivéve, a UA-felülírás / sourceurl / webdriver bent', () => {
  for (const v of [undefined, '', '0', 'false', 'off']) assert.equal(peMinimalEnabled({ STEALTH_PE_MINIMAL: v }), false);
  for (const v of ['1', 'true', 'on', 'yes']) assert.equal(peMinimalEnabled({ STEALTH_PE_MINIMAL: v }), true);
  assert.deepEqual(peMinimalHealth({}), { minimal: false });
  assert.deepEqual(peMinimalHealth({ STEALTH_PE_MINIMAL: '1' }).disabled_evasions, [...PE_MINIMAL_DISABLED]);

  const StealthPlugin = require('puppeteer-extra-plugin-stealth');
  const st = StealthPlugin();
  const all = new Set(st.enabledEvasions);
  for (const e of PE_MINIMAL_DISABLED) assert.ok(all.has(e), `ismeretlen evasion a listán: ${e}`);
  prunePeMinimal(st);
  const left = [...st.enabledEvasions].sort();
  for (const e of ['user-agent-override', 'sourceurl', 'defaultArgs', 'navigator.webdriver']) {
    assert.ok(left.includes(e), `bent kell maradnia: ${e}`);
  }
  for (const e of ['iframe.contentWindow', 'chrome.runtime', 'media.codecs']) assert.ok(!left.includes(e), e);
});

const browserPath = findBrowser();
const skip = !browserPath && 'nincs böngésző (BRAVE_PATH)';

// A pe `iframe.contentWindow` shimje a `document.createElement`-et SAJÁT
// tulajdonságként (Proxy) teszi a document-re — natívan az a prototípuson él.
// (A ciklikus-__proto__ trükköt a pe stripProxyFromErrors-a kifejezetten
// hamisítja, ezért nem az a mérce.) + a natív értékek, amik miatt nem kell shim.
const PROXY_ROUTE = `<!doctype html><title>pe</title><pre id="out">PENDING</pre><script>
  document.getElementById('out').textContent = 'PE=' + JSON.stringify({
    ownCreateElement: Object.prototype.hasOwnProperty.call(document, 'createElement'),
    vendor: navigator.vendor, plugins: navigator.plugins.length, webdriver: navigator.webdriver,
    chromeApp: !!(window.chrome && 'app' in window.chrome),
  });
</script>`;

async function freePort() {
  const s = net.createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise(r => s.close(r));
  return p;
}

async function startServer(extraEnv) {
  const port = await freePort();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bmcp-pe-'));
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('RAILWAY_') || k.startsWith('BRAVE_') || k.startsWith('STEALTH_TF_') || k.startsWith('STEALTH_PE_')) delete env[k];
  }
  Object.assign(env, {
    PORT: String(port), HEADLESS: 'true', BRAVE_PATH: browserPath, BRAVE_WATCHDOG_DISABLED: 'true',
    NODE_ENV: 'test', BRAVE_EGRESS_ALLOW_TEST_LOOPBACK: '1', BRAVE_PAGE_PROFILE_DIR: path.join(cwd, 'profiles'),
    ...extraEnv,
  });
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'dual-server.js'), '--http-only'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});
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
  return { scrape, health, stop };
}

const peOf = (text) => {
  const m = String(text || '').match(/PE=(\{.*\})/);
  return m ? JSON.parse(m[1]) : null;
};

test('e2e: TF alatt a pe-shimek Proxy-ja a lapon VAN, pe-minimálban NINCS — a probe-jelek nem romlanak', { skip, timeout: 180000 }, async (t) => {
  const fx = await startFixture({ ...probeRoutes(), '/pe': PROXY_ROUTE });
  const on = await startServer({ STEALTH_TF_EVASIONS: '1' });
  const pm = await startServer({ STEALTH_TF_EVASIONS: '1', STEALTH_PE_MINIMAL: '1' });
  t.after(async () => { await on.stop(); await pm.stop(); await fx.close(); });

  assert.deepEqual((await on.health()).stealth_pe, { minimal: false });
  const h = await pm.health();
  assert.equal(h.stealth_pe.minimal, true);
  assert.equal(h.stealth_tf.enabled, true);

  for (const stealth of [false, true]) {
    const a = peOf((await on.scrape({ url: `${fx.base}/pe`, stealth, waitTime: 300 })).text);
    const b = peOf((await pm.scrape({ url: `${fx.base}/pe`, stealth, waitTime: 300 })).text);
    assert.ok(a && b, 'nincs PE-eredmény');
    // a puppeteer-extra iframe.contentWindow-ja: document.createElement saját Proxy-tulajdonság
    assert.equal(a.ownCreateElement, true, JSON.stringify(a));
    assert.equal(b.ownCreateElement, false, JSON.stringify(b));
    // a natív értékek jók (ezért nem kell shim)
    assert.equal(b.vendor, 'Google Inc.');
    assert.ok(b.plugins > 0);
    assert.equal(b.webdriver, false);
    assert.equal(b.chromeApp, true);

    const p = parseProbe((await pm.scrape({ url: `${fx.base}/probe`, stealth, waitTime: 800 })).text);
    assert.ok(p, 'nincs probe-eredmény');
    for (const k of ['webdriver_value', 'ua_headless_token', 'ua_header_vs_js', 'platform_vs_ua', 'uad_brands_nonempty',
      'languages_vs_accept_language', 'global_leaks', 'getters_look_native']) {
      assert.equal(p.results[k]?.bot, false, `${k}: ${JSON.stringify(p.results[k])}`);
    }
  }
});
