// Egress-szűrő — egységtesztek (hálózat és böngésző NÉLKÜL).
// Futtatás: node --test test/
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyIp, embeddedV4, parseV6, EgressGuard, testLoopbackAllowed,
  egressFilterEnabled, hostOnly, redactUrls, chromeEgressArgs,
} from '../src/egress.js';

const BLOCKED = [
  // IPv4 — a Python-őr (echolot_ssrf / fetch._ip_blocked) + multicast
  '0.0.0.0', '0.1.2.3', '10.0.0.1', '10.255.255.255', '100.64.0.1', '100.127.255.255',
  '127.0.0.1', '127.1.2.3', '169.254.169.254', '172.16.0.1', '172.31.255.255',
  '192.0.0.1', '192.0.0.9', '192.0.2.1', '192.168.1.1', '198.18.0.1', '198.19.255.255',
  '198.51.100.7', '203.0.113.7', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255',
  // IPv6 alap
  '::', '::1', 'fc00::1', 'fd12:3456::10', 'fe80::1', 'fe80::1%eth0', 'fec0::1',
  'ff02::1', 'ff0e::1', '100::1', '2001:db8::1', '3fff::1', '64:ff9b:1::1', '5f00::1',
  // IPv6-ba ágyazott v4 — a BEÁGYAZOTT cím dönt
  '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:169.254.169.254',
  '64:ff9b::7f00:1', '64:ff9b::a9fe:a9fe', '64:ff9b::10.1.1.1',
  '::127.0.0.1', '::10.0.0.1', '::2',
  '2002:7f00:1::1', '2002:a00:1::1', '2002:a9fe:a9fe::1',
  '2001:0:4136:e378:8000:63bf:80ff:fffe',   // Teredo, kliens = 127.0.0.1
];

const ALLOWED = [
  '1.1.1.1', '8.8.8.8', '93.184.215.14', '100.63.255.255', '100.128.0.1', '172.15.255.255',
  '172.32.0.1', '198.17.255.255', '198.20.0.1', '223.255.255.255',
  '2606:4700:4700::1111', '2a00:1450:4001:80b::200e', '2001:4860:4860::8888',
  '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1',
  '2001:0:4136:e378:8000:63bf:f7f7:f7f7',   // Teredo, kliens = 8.8.8.8
];

test('classifyIp: tiltott címek (loopback, privát, link-local, CGNAT, metadata, ULA, multicast, beágyazott v4)', () => {
  for (const ip of BLOCKED) {
    assert.ok(classifyIp(ip), `tiltott kellene legyen: ${ip}`);
  }
});

test('classifyIp: publikus címek engedettek', () => {
  for (const ip of ALLOWED) {
    assert.equal(classifyIp(ip), null, `engedett kellene legyen: ${ip} (kapott: ${classifyIp(ip)})`);
  }
});

test('classifyIp: értelmezhetetlen → tiltott', () => {
  for (const x of ['', 'abc', '1.2.3', '1.2.3.256', '::g', null, undefined]) {
    assert.ok(classifyIp(x), `tiltott kellene legyen: ${x}`);
  }
});

test('parseV6 + embeddedV4', () => {
  assert.equal(parseV6('::1'), 1n);
  assert.equal(parseV6('::'), 0n);
  assert.equal(parseV6('::ffff:1.2.3.4'), (0xffffn << 32n) | 0x01020304n);
  assert.deepEqual(embeddedV4(parseV6('64:ff9b::7f00:1')), ['127.0.0.1']);
  assert.deepEqual(embeddedV4(parseV6('2002:c0a8:101::1')), ['192.168.1.1']);
  assert.deepEqual(embeddedV4(parseV6('2001:0:4136:e378:8000:63bf:80ff:fffe')), ['65.54.227.120', '127.0.0.1']);
  assert.equal(embeddedV4(parseV6('2606:4700::1111')), null);
  assert.equal(parseV6('1.2.3.4'), null);
});

test('testLoopbackAllowed: hármas zár (flag + NODE_ENV=test + nincs RAILWAY_*)', () => {
  assert.equal(testLoopbackAllowed({}), false);
  assert.equal(testLoopbackAllowed({ BRAVE_EGRESS_ALLOW_TEST_LOOPBACK: '1' }), false);
  assert.equal(testLoopbackAllowed({ BRAVE_EGRESS_ALLOW_TEST_LOOPBACK: '1', NODE_ENV: 'production' }), false);
  assert.equal(testLoopbackAllowed({ BRAVE_EGRESS_ALLOW_TEST_LOOPBACK: '1', NODE_ENV: 'test' }), true);
  assert.equal(testLoopbackAllowed({ BRAVE_EGRESS_ALLOW_TEST_LOOPBACK: '1', NODE_ENV: 'test', RAILWAY_ENVIRONMENT: 'production' }), false);
  assert.equal(testLoopbackAllowed({ BRAVE_EGRESS_ALLOW_TEST_LOOPBACK: 'true', NODE_ENV: 'test' }), false);
});

test('teszt-mód csak a loopbacket nyitja, a belső hálót nem', () => {
  const o = { allowTestLoopback: true };
  assert.equal(classifyIp('127.0.0.1', o), null);
  assert.equal(classifyIp('::1', o), null);
  assert.ok(classifyIp('10.0.0.1', o));
  assert.ok(classifyIp('169.254.169.254', o));
  assert.ok(classifyIp('fd12::1', o));
});

test('egressFilterEnabled: kill-switch csak explicit 0-ra', () => {
  assert.equal(egressFilterEnabled({}), true);
  assert.equal(egressFilterEnabled({ BRAVE_EGRESS_FILTER: '1' }), true);
  assert.equal(egressFilterEnabled({ BRAVE_EGRESS_FILTER: '0' }), false);
  assert.equal(egressFilterEnabled({ BRAVE_EGRESS_FILTER: ' 0 ' }), false);
});

test('vetUrl: séma, tiltott nevek, IP-literál alakok (a WHATWG URL kanonizál)', async () => {
  const g = new EgressGuard({ resolver: async () => [{ address: '93.184.215.14', family: 4 }] });
  const cases = {
    'file:///etc/passwd': /scheme_not_allowed:file/,
    'chrome://version': /scheme_not_allowed:chrome/,
    'data:text/html,hi': /scheme_not_allowed:data/,
    'javascript:alert(1)': /scheme_not_allowed:javascript/,
    'http://localhost:3000/': /blocked_hostname/,
    'http://foo.localhost/': /blocked_hostname/,
    'http://metadata.google.internal/': /blocked_hostname/,
    'http://127.0.0.1:9222/json': /blocked_ip:127\.0\.0\.1/,
    'http://2130706433/': /blocked_ip:127\.0\.0\.1/,
    'http://0x7f.1/': /blocked_ip:127\.0\.0\.1/,
    'http://127.1/': /blocked_ip:127\.0\.0\.1/,
    'http://[::1]:8080/': /blocked_ip:::1/,
    'http://[::ffff:169.254.169.254]/': /blocked_ip/,
    'http://169.254.169.254/latest/meta-data/': /blocked_ip/,
  };
  for (const [u, re] of Object.entries(cases)) {
    const v = await g.vetUrl(u);
    assert.equal(v.ok, false, u);
    assert.match(v.reason, re, `${u} → ${v.reason}`);
  }
  const ok = await g.vetUrl('https://example.com/x?y=1');
  assert.equal(ok.ok, true);
  assert.equal(ok.ips[0].address, '93.184.215.14');
});

test('resolveHost: EGYETLEN belső cím a válaszban is tiltás; üres válasz = DNS-hiba', async () => {
  const answers = {
    'mixed.test': [{ address: '1.1.1.1', family: 4 }, { address: '10.0.0.5', family: 4 }],
    'nat64.test': [{ address: '64:ff9b::a9fe:a9fe', family: 6 }],
    'ula.test': [{ address: 'fd12::10', family: 6 }],
    'empty.test': [],
    'pub.test': [{ address: '2606:4700::1111', family: 6 }, { address: '1.1.1.1', family: 4 }],
  };
  const g = new EgressGuard({ resolver: async (h) => answers[h] || [] });
  assert.match((await g.resolveHost('mixed.test')).reason, /blocked_ip:10\.0\.0\.5/);
  assert.match((await g.resolveHost('nat64.test')).reason, /blocked_ip:64:ff9b/);
  assert.match((await g.resolveHost('ula.test')).reason, /blocked_ip:fd12/);
  const e = await g.resolveHost('empty.test');
  assert.equal(e.ok, false); assert.equal(e.kind, 'dns');
  const p = await g.resolveHost('pub.test');
  assert.equal(p.ok, true);
  assert.equal(p.ips[0].family, 4, 'IPv4 előre rendezve');
});

test('hostOnly / redactUrls: a naplóba nem kerül query', () => {
  assert.equal(hostOnly('https://user:pw@example.com:8443/a/b?token=SECRET#x'), 'example.com');
  assert.equal(hostOnly('not a url'), '-');
  const msg = redactUrls('net::ERR_FAILED at https://x.test/p?q=SECRET&k=2 and http://y.test/#frag');
  assert.ok(!msg.includes('SECRET'));
  assert.ok(msg.includes('https://x.test/p?…'));
});

test('chromeEgressArgs: proxy + <-loopback> + WebRTC + QUIC', () => {
  const a = chromeEgressArgs(12345);
  assert.ok(a.includes('--proxy-server=http://127.0.0.1:12345'));
  assert.ok(a.includes('--proxy-bypass-list=<-loopback>'));
  assert.ok(a.includes('--force-webrtc-ip-handling-policy=disable_non_proxied_udp'));
  assert.ok(a.includes('--disable-quic'));
});
