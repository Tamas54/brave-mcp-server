// W2 végponttól végpontig a VALÓDI HTTP-szerveren át (gyerekprocessz, /mcp):
//  * /health kimondja a challenge-, humanize-, hálózati- és megoldó-állapotot;
//    a megoldó kulcs nélkül inaktív, kulccsal aktív — a kulcs sem a /health-ben,
//    sem a naplóban nem jelenik meg;
//  * a brave_scrape MCP-válaszában ott a `challenge` mező (a tools.js a hívás-
//    határidőn belül tartja a kivárást);
//  * egress nélkül (kill-switch) is van WebRTC-zár, STEALTH_WEBRTC=native kikapcsolja.
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browserPath = findBrowser();
const skip = !browserPath && 'nincs böngésző (BRAVE_PATH)';
const KEY = 'W2-SECRET-KEY-31415926';

async function freePort() {
  const s = net.createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise(r => s.close(r));
  return p;
}

async function startServer(extraEnv) {
  const port = await freePort();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bmcp-w2-'));
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(RAILWAY_|BRAVE_|STEALTH_|CHALLENGE_|CAPTCHA_SOLVER|HUMANIZE)/.test(k)) delete env[k];
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
  const scrape = async (args) => {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'brave_scrape', arguments: args } }),
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

test('HTTP: /health alapállapot — challenge-kivárás BE, solve KI, humanize KI, megoldó inaktív (oka kimondva)', { skip, timeout: 120000 }, async (t) => {
  const fx = await startFixture(challengeRoutes());
  const srv = await startServer({ CAPTCHA_SOLVER_PROVIDER: 'capsolver' });
  t.after(async () => { await srv.stop(); await fx.close(); });
  const h = await srv.health();
  assert.equal(h.challenge.wait, true);
  assert.equal(h.challenge.wait_ms, 15000);
  assert.equal(h.challenge.solve, false);
  assert.equal(h.humanize.enabled, false);
  assert.equal(h.captcha_solver.active, false);
  assert.deepEqual(h.captcha_solver.providers.map(p => [p.name, p.active, p.reason]), [['capsolver', false, 'no_key']]);
  assert.equal(h.captcha_solver.purpose_gate, 'read');
  assert.match(h.stealth_net.webrtc, /disable_non_proxied_udp/);
  assert.equal(h.stealth_net.web_security, true);
  // a brave_scrape MCP-válasza: challenge-mező
  const r = await srv.scrape({ url: `${fx.base}/cf?d=1500`, waitUntil: 'domcontentloaded' });
  assert.equal(r.challenge?.type, 'cloudflare_interstitial', JSON.stringify(r).slice(0, 300));
  assert.equal(r.challenge.passed, true);
  assert.equal(r.content_usable, true);
});

test('HTTP: kulccsal aktív megoldó + flagek — a kulcs sem a /health-ben, sem a naplóban; egress KI → WebRTC-zár', { skip, timeout: 120000 }, async (t) => {
  const srv = await startServer({
    CAPTCHA_SOLVER_PROVIDER: 'capsolver,echolot', CAPTCHA_SOLVER_KEY: KEY, CHALLENGE_SOLVE: '1', HUMANIZE: '1',
    BRAVE_EGRESS_FILTER: '0',
  });
  t.after(async () => { await srv.stop(); });
  const h = await srv.health();
  assert.equal(h.captcha_solver.active, true);
  assert.deepEqual(h.captcha_solver.order, ['capsolver', 'echolot']);
  assert.equal(h.captcha_solver.providers[0].active, true);
  assert.equal(h.captcha_solver.providers[1].registered, false);   // a másik sáv modulja még nincs meg
  assert.equal(h.challenge.solve, true);
  assert.equal(h.humanize.enabled, true);
  assert.equal(h.stealth_net.webrtc, 'disable_non_proxied_udp');
  assert.ok(!JSON.stringify(h).includes(KEY));
  assert.ok(!srv.log().includes(KEY));
});

test('WebRTC-zár flagjei: egress mellett nem duplikál, egress nélkül zár, native kikapcsolja', async () => {
  process.env.BRAVE_WATCHDOG_DISABLED = 'true';
  const { BraveController } = await import('../src/brave-controller.js');
  assert.deepEqual(BraveController._webrtcBlockArgs(true, {}), []);
  assert.deepEqual(BraveController._webrtcBlockArgs(false, {}), [
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--webrtc-ip-handling-policy=disable_non_proxied_udp']);
  assert.deepEqual(BraveController._webrtcBlockArgs(false, { STEALTH_WEBRTC: 'native' }), []);
});
