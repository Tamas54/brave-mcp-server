// Egress-proxy — végpontteszt böngésző NÉLKÜL (nyers HTTP/CONNECT kliensekkel).
// A publikus részek (example.com) hálózat híján kimaradnak (skip).
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { EgressGuard, EgressBlockedError, BLOCK_HEADER } from '../src/egress.js';
import { startFixture, hasNetwork } from './helpers.js';

// Nyers CONNECT a proxyn át; visszaadja a státuszsort + fejléceket + a socketet.
function rawConnect(proxyPort, target) {
  return new Promise((resolve, reject) => {
    const s = net.connect(proxyPort, '127.0.0.1', () => {
      s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    let buf = '';
    const onData = (d) => {
      buf += d.toString('latin1');
      const i = buf.indexOf('\r\n\r\n');
      if (i >= 0) {
        s.off('data', onData);
        const head = buf.slice(0, i);
        const status = parseInt(head.split(' ')[1], 10);
        resolve({ status, head: head.toLowerCase(), sock: s, rest: buf.slice(i + 4) });
      }
    };
    s.on('data', onData);
    s.on('error', reject);
    setTimeout(() => reject(new Error('rawConnect timeout')), 15000).unref();
  });
}

// Abszolút-URI (proxy-alakú) sima HTTP GET.
function proxyGet(proxyPort, url) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: proxyPort, method: 'GET', path: url, headers: { host: new URL(url).host } }, (res) => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('proxy: loopback / metadata / belső cél 403 + marker-fejléc, a titok NEM jön át', async (t) => {
  const fx = await startFixture({ '/': 'SECRET-LOCAL-CONTENT' });
  const g = new EgressGuard();
  const port = await g.startProxy();
  t.after(async () => { await g.close(); await fx.close(); });

  const r1 = await proxyGet(port, `http://127.0.0.1:${fx.port}/`);
  assert.equal(r1.status, 403);
  assert.match(r1.headers[BLOCK_HEADER], /blocked_ip:127\.0\.0\.1/);
  assert.ok(!r1.body.includes('SECRET'));

  const r2 = await proxyGet(port, `http://localhost:${fx.port}/`);
  assert.equal(r2.status, 403);
  assert.equal(r2.headers[BLOCK_HEADER], 'blocked_hostname');

  const r3 = await proxyGet(port, 'http://169.254.169.254/latest/meta-data/');
  assert.equal(r3.status, 403);

  for (const target of [`127.0.0.1:${fx.port}`, `[::1]:${fx.port}`, '10.1.2.3:443', '169.254.169.254:80', `[::ffff:127.0.0.1]:${fx.port}`]) {
    const c = await rawConnect(port, target);
    assert.equal(c.status, 403, target);
    assert.ok(c.head.includes(BLOCK_HEADER), target);
    c.sock.destroy();
  }
  assert.ok(g.recentBlockFor('127.0.0.1', 0));
  assert.ok(g.stats.blocked >= 7);
});

test('proxy: közvetlen (nem-proxy) kérés a proxy portjára 400', async (t) => {
  const g = new EgressGuard();
  const port = await g.startProxy();
  t.after(() => g.close());
  const r = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/' }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(r, 400);
});

test('proxy: DNS-rebinding-biztos — az ELLENŐRZÖTT IP-re csatlakozik, nem old fel újra', async (t) => {
  const fx = await startFixture({ '/': 'REBIND-TARGET' });
  // Teszt-mód: a 127.0.0.1 engedett (ez a "publikus" szerepét játssza), a
  // második feloldás belső címet adna. Cache kikapcsolva → minden ítélet friss.
  let calls = 0;
  const g = new EgressGuard({
    allowTestLoopback: true,
    cacheTtlMs: 0,
    resolver: async () => {
      calls++;
      return calls === 1 ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '10.255.255.1', family: 4 }];
    },
  });
  const port = await g.startProxy();
  t.after(async () => { await g.close(); await fx.close(); });

  const c = await rawConnect(port, `rebind.test:${fx.port}`);
  assert.equal(c.status, 200, 'első ítélet: engedett');
  assert.equal(calls, 1, 'a csatlakozáshoz NEM volt második feloldás');
  // A tunnelen át a valódi (ellenőrzött) szerver válaszol.
  c.sock.write(`GET / HTTP/1.1\r\nHost: rebind.test\r\nConnection: close\r\n\r\n`);
  const body = await new Promise((resolve) => {
    let b = c.rest;
    c.sock.on('data', d => { b += d.toString(); });
    c.sock.on('close', () => resolve(b));
  });
  assert.ok(body.includes('REBIND-TARGET'));

  const c2 = await rawConnect(port, `rebind.test:${fx.port}`);
  assert.equal(c2.status, 403, 'második feloldás belső címet adott → tiltás');
  assert.match(c2.head, /blocked_ip:10\.255\.255\.1/);
  c2.sock.destroy();
});

test('proxy: sima HTTP-kérés az ELLENŐRZÖTT IP-re megy (regresszió: az `agent:false` localhost:80-ra csatlakozott)', async (t) => {
  const fx = await startFixture({ '/p': (req, res) => { res.writeHead(200, { 'x-seen-host': req.headers.host }); res.end('PLAIN-OK'); } });
  const g = new EgressGuard({ allowTestLoopback: true, resolver: async () => [{ address: '127.0.0.1', family: 4 }] });
  const port = await g.startProxy();
  t.after(async () => { await g.close(); await fx.close(); });
  const r = await proxyGet(port, `http://plain.test:${fx.port}/p`);
  assert.equal(r.status, 200);
  assert.equal(r.body, 'PLAIN-OK');
  assert.equal(r.headers['x-seen-host'], `plain.test:${fx.port}`, 'a Host fejléc változatlan');
});

test('proxy: DNS-hiba 502 (nem tiltás-marker)', async (t) => {
  const g = new EgressGuard({ resolver: async () => [] });
  const port = await g.startProxy();
  t.after(() => g.close());
  const c = await rawConnect(port, 'nope.invalid:443');
  assert.equal(c.status, 502);
  assert.ok(!c.head.includes(BLOCK_HEADER));
  c.sock.destroy();
});

test('safeFetch: loopback tiltva; redirect belső címre a 2. hopon tiltva', async (t) => {
  const fx = await startFixture({
    '/r': (req, res) => { res.writeHead(302, { location: 'http://10.0.0.1/secret' }); res.end(); },
    '/ok': 'fine',
  });
  t.after(() => fx.close());
  const strict = new EgressGuard();
  await assert.rejects(strict.safeFetch(`http://127.0.0.1:${fx.port}/ok`), EgressBlockedError);
  const testMode = new EgressGuard({ allowTestLoopback: true });
  const ok = await testMode.safeFetch(`http://127.0.0.1:${fx.port}/ok`);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), 'fine');
  await assert.rejects(testMode.safeFetch(`http://127.0.0.1:${fx.port}/r`), (e) => {
    assert.ok(e instanceof EgressBlockedError);
    assert.match(e.egressReason, /blocked_ip:10\.0\.0\.1/);
    return true;
  });
});

test('proxy + safeFetch: publikus cél (example.com) átmegy', async (t) => {
  if (!(await hasNetwork())) return t.skip('nincs hálózat');
  const g = new EgressGuard();
  const port = await g.startProxy();
  t.after(() => g.close());
  const c = await rawConnect(port, 'example.com:443');
  assert.equal(c.status, 200);
  c.sock.destroy();
  const r = await proxyGet(port, 'http://example.com/');
  assert.ok([200, 301, 302].includes(r.status), `status ${r.status}`);
  const f = await g.safeFetch('https://example.com/');
  assert.equal(f.status, 200);
  assert.match(await f.text(), /Example Domain/);
});
