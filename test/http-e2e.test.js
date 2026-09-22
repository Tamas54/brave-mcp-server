// Végponttól végpontig a VALÓDI HTTP-szerveren át (gyerekprocessz, /mcp JSON-RPC):
//  * SZIGORÚ egress-mód (NODE_ENV=production — a teszt-kivétel flagje hiába van
//    beállítva, NEM kapcsolhat be): a helyi szerver és a szerver saját portja
//    elérhetetlen a brave_page-ből, a brave_scrape-ből és a lapon belüli fetch-ből;
//  * napló-redakció: sem Authorization/Cookie, sem beírt szöveg, script, jelszó,
//    query-string nem kerül a naplóba;
//  * kill-switch (BRAVE_EGRESS_FILTER=0): a régi viselkedés visszaáll.
// Böngésző nélkül kimarad; a publikus részek hálózat nélkül kimaradnak.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser, startFixture, hasNetwork } from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browserPath = findBrowser();
const skip = !browserPath && 'nincs böngésző (BRAVE_PATH)';

async function freePort() {
  const s = net.createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise(r => s.close(r));
  return p;
}

// A szervert IDEIGLENES cwd-ből indítjuk: ott nincs key.pem/cert.pem (→ sima
// HTTP, mint a Docker-image-ben) és nincs .env.
async function startServer(extraEnv = {}) {
  const port = await freePort();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bmcp-e2e-'));
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('RAILWAY_') || k.startsWith('BRAVE_')) delete env[k];
  Object.assign(env, {
    PORT: String(port), HEADLESS: 'true', BRAVE_PATH: browserPath,
    BRAVE_WATCHDOG_DISABLED: 'true', NODE_ENV: 'production',
    BRAVE_PAGE_PROFILE_DIR: path.join(cwd, 'profiles'),
    ...extraEnv,
  });
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'dual-server.js'), '--http-only'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    try {
      const r = await fetch(`${base}/tools`);
      if (r.ok) break;
    } catch (_) { /* még indul */ }
    await new Promise(r => setTimeout(r, 200));
  }
  let seq = 0;
  const call = async (name, args, headers = {}) => {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method: 'tools/call', params: { name, arguments: args } }),
    });
    const j = await r.json();
    if (j.error) return { rpcError: j.error };
    const text = j.result.content[0].text;
    try { return JSON.parse(text); } catch (_) { return { raw: text }; }
  };
  const stop = async () => {
    child.kill('SIGTERM');
    await new Promise(r => { child.once('exit', r); setTimeout(r, 8000); });
    fs.rmSync(cwd, { recursive: true, force: true });
  };
  return { base, port, call, stop, log: () => log };
}

test('HTTP e2e — szigorú egress + napló-redakció', { skip, timeout: 180000 }, async (t) => {
  const fx = await startFixture({ '/': 'LOCAL-SECRET-CONTENT', '/x': 'LOCAL-SECRET-CONTENT' });
  // A teszt-kivétel flagje SZÁNDÉKOSAN be van állítva: NODE_ENV=production
  // mellett NEM kapcsolhat be (hármas zár).
  const srv = await startServer({ BRAVE_EGRESS_ALLOW_TEST_LOOPBACK: '1' });
  t.after(async () => { await srv.stop(); await fx.close(); });

  // tools/list: a régi 12 tool változatlanul + brave_page
  const list = await (await fetch(`${srv.base}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'tools/list' }),
  })).json();
  const names = list.result.tools.map(x => x.name);
  for (const n of ['brave_navigate', 'brave_marked_snapshot', 'brave_scrape', 'brave_crawl', 'brave_search', 'brave_login',
    'brave_session_action', 'brave_list_sessions', 'brave_clear_sessions', 'brave_visual_captcha', 'brave_mouse_control',
    'brave_visual_inspect', 'brave_page']) {
    assert.ok(names.includes(n), `hiányzó tool: ${n}`);
  }

  // brave_page → a helyi szerver és a SAJÁT port tiltva
  const secretHeaders = { Authorization: 'Bearer AUTH-SECRET-123', Cookie: 'sid=COOKIE-SECRET-456', 'X-Client-Id': 'e2e-test' };
  const p1 = await srv.call('brave_page', {
    url: `http://127.0.0.1:${fx.port}/x?token=QUERY-SECRET-789`,
    actions: [{ type: 'write', text: 'TYPED-SECRET-abc' }, { type: 'executeJavascript', script: '/*SCRIPT-SECRET-def*/ 1' }],
  }, secretHeaders);
  assert.equal(p1.ok, false);
  assert.match(p1.blocked.reason, /blocked_ip:127\.0\.0\.1/);
  const p2 = await srv.call('brave_page', { url: `http://localhost:${srv.port}/health` });
  assert.match(p2.blocked.reason, /blocked_hostname/);

  // brave_scrape (a meglévő tool) → strukturált egress_blocked, a titok nem jön át
  const s1 = await srv.call('brave_scrape', { url: `http://127.0.0.1:${fx.port}/` });
  assert.equal(s1.error, 'egress_blocked');
  assert.equal(s1.content_usable, false);
  assert.ok(!JSON.stringify(s1).includes('LOCAL-SECRET'));
  const s2 = await srv.call('brave_scrape', { url: 'http://169.254.169.254/latest/meta-data/', auto_fallback: true });
  assert.equal(s2.error, 'egress_blocked', 'auto_fallback se eszkaláljon belső célra (webclaw/flaresolverr)');
  const s3 = await srv.call('brave_scrape', { url: 'file:///proc/self/environ' });
  assert.equal(s3.error, 'egress_blocked');
  assert.ok(!JSON.stringify(s3).includes('PATH='));

  // brave_login jelszava sem kerülhet naplóba
  await srv.call('brave_login', { site: 'custom', customUrl: `http://127.0.0.1:${fx.port}/`, credentials: { username: 'u', password: 'PW-SECRET-xyz' } });

  if (await hasNetwork()) {
    const pub = await srv.call('brave_page', {
      url: 'https://example.com/?q=QUERY-SECRET-789',
      formats: ['text'],
      actions: [{
        type: 'executeJavascript',
        script: `return Promise.all([${fx.port}, ${srv.port}].map(p => fetch("http://127.0.0.1:" + p + "/").then(r => r.status + ":" + r.headers.get("x-brave-egress-blocked"), e => "ERR")))`,
      }],
    });
    assert.equal(pub.ok, true, pub.error);
    assert.match(pub.text, /Example Domain/);
    for (const v of pub.action_results[0].js_result) assert.match(v, /^403:blocked_ip:127\.0\.0\.1$/);
  }

  // Napló: egy sor/kérés, host igen — titok, query, törzs, fejléc NEM.
  const log = srv.log();
  for (const secret of ['AUTH-SECRET-123', 'COOKIE-SECRET-456', 'QUERY-SECRET-789', 'TYPED-SECRET-abc', 'SCRIPT-SECRET-def', 'PW-SECRET-xyz', 'LOCAL-SECRET']) {
    assert.ok(!log.includes(secret), `titok a naplóban: ${secret}`);
  }
  assert.match(log, /\[mcp\] rid=[0-9a-f]{8} id=\d+ method=tools\/call tool=brave_page host=127\.0\.0\.1 client=e2e-test status=200 ms=\d+/);
  assert.ok(!/MCP Headers|MCP Request:/.test(log), 'a régi teljes-törzs/fejléc napló eltűnt');

  // /health: egress-telemetria
  const h = await (await fetch(`${srv.base}/health`)).json();
  assert.equal(h.egress.enabled, true);
  assert.equal(h.egress.test_loopback, false, 'NODE_ENV=production mellett a teszt-kivétel NEM él');
  assert.ok(h.egress.blocked >= 3);
  assert.equal(h.page_sessions.sessions, 0);
});

test('HTTP e2e — kill-switch BRAVE_EGRESS_FILTER=0 visszaadja a régi viselkedést', { skip, timeout: 120000 }, async (t) => {
  const fx = await startFixture({ '/': '<title>legacy local</title><p>LEGACY-LOCAL-REACHABLE</p>' });
  const srv = await startServer({ BRAVE_EGRESS_FILTER: '0' });
  t.after(async () => { await srv.stop(); await fx.close(); });
  const r = await srv.call('brave_scrape', { url: `http://127.0.0.1:${fx.port}/` });
  assert.match(r.text || '', /LEGACY-LOCAL-REACHABLE/);
  const h = await (await fetch(`${srv.base}/health`)).json();
  assert.equal(h.egress.enabled, false);
});
