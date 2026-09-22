// ════════════════════════════════════════════════════════════════════
//  EGRESS-SZŰRŐ — 2026-09-22 (brave-mcp SSRF-védelem)
// ════════════════════════════════════════════════════════════════════
// MIÉRT: a Chromium eddig MAGA oldotta fel a DNS-t, így bármely lap (vagy egy
// rosszindulatú hívó URL-je) elérte a 127.0.0.1-et — benne a Chromium SAJÁT
// DevTools-portját és a szerver saját portját —, a felhő-metadata címet
// (169.254.169.254) és a belső hálót (Railway *.railway.internal = fd12::/16),
// DNS-rebindinggel is. A szerveren nincs valódi auth, tehát ez bárkinek nyitva
// állt, aki ismeri az URL-t.
//
// HOGYAN: folyamaton belüli forward proxy a 127.0.0.1 egy véletlen portján.
// A Chrome `--proxy-server` + `--proxy-bypass-list=<-loopback>` flaggel MINDEN
// forgalmát ide küldi (a `<-loopback>` nélkül a localhostot megkerülné!). A
// proxy MAGA oldja fel a hostot (A + AAAA), elutasít minden nem-publikus IP-t,
// és a MÁR ELLENŐRZÖTT IP-re csatlakozik — soha nem old fel újra, így a DNS
// rebinding (ellenőrzéskor publikus, csatlakozáskor belső cím) strukturálisan
// lehetetlen.
//
// A tiltólista az Echolot Python-őrével (echolot_ssrf.py `_ip_is_blocked` +
// echolot_engine/fetch.py `_ip_blocked` / `_embedded_v4`) egyezik, azzal a két
// szigorítással, amit a feladat előír: multicast (224/4, ff00::/8) és minden
// 2000::/3-on kívüli IPv6 is tiltott (a Python is_global a multicastot
// „globálisnak" mondja).
//
// Kill-switch: BRAVE_EGRESS_FILTER=0 → nincs proxy, a régi viselkedés.
// Teszt-kivétel: BRAVE_EGRESS_ALLOW_TEST_LOOPBACK=1 CSAK akkor él, ha
// NODE_ENV=test ÉS nincs egyetlen RAILWAY_* env sem (a Dockerfile
// NODE_ENV=production-t állít, a Railway RAILWAY_*-okat injektál → élesben
// véletlenül sem kapcsolható be).

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns';

export const BLOCK_HEADER = 'x-brave-egress-blocked';
export const ERROR_HEADER = 'x-brave-egress-error';

// ── IPv4 tiltólista (CIDR) ───────────────────────────────────────────
// = Python ipaddress is_private ∪ 100.64/10 (CGNAT) ∪ 192.0.0.0/24 egészben ∪
//   multicast 224/4 (a feladat szigorítása). A 240/4 lefedi a 255.255.255.255-öt.
const V4_BLOCKED = [
  ['0.0.0.0', 8, 'this_network'],
  ['10.0.0.0', 8, 'private'],
  ['100.64.0.0', 10, 'cgnat'],
  ['127.0.0.0', 8, 'loopback'],
  ['169.254.0.0', 16, 'link_local'],
  ['172.16.0.0', 12, 'private'],
  ['192.0.0.0', 24, 'ietf_protocol'],
  ['192.0.2.0', 24, 'documentation'],
  ['192.168.0.0', 16, 'private'],
  ['198.18.0.0', 15, 'benchmark'],
  ['198.51.100.0', 24, 'documentation'],
  ['203.0.113.0', 24, 'documentation'],
  ['224.0.0.0', 4, 'multicast'],
  ['240.0.0.0', 4, 'reserved'],
].map(([a, bits, label]) => {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { net: (v4ToInt(a) & mask) >>> 0, mask, label };
});

// ── IPv6: allowlist-szemlélet ────────────────────────────────────────
// 1) Ha IPv4 van beágyazva (::ffff:0:0/96 mapped, 64:ff9b::/96 NAT64,
//    ::/96 compatible, 2002::/16 6to4, 2001::/32 Teredo) → a BEÁGYAZOTT v4
//    dönt (NAT64-átjárón a 64:ff9b::7f00:1 = 127.0.0.1!).
// 2) Egyébként csak a 2000::/3 (global unicast) engedett, azon belül is tiltva
//    a speciális tartományok. Így a ::, ::1, fc00::/7 (ULA — a Railway belső
//    hálója!), fe80::/10, fec0::/10, ff00::/8, 100::/64, 64:ff9b:1::/48 mind
//    kiesik, anélkül hogy egyenként felsorolnánk őket.
const V6_BLOCKED_IN_GLOBAL = [
  ['2001::', 23, 'ietf_protocol'],     // (a Teredo 2001::/32-t az 1. pont már elbírálta)
  ['2001:db8::', 32, 'documentation'],
  ['3fff::', 20, 'documentation'],
].map(([a, bits, label]) => {
  const n = parseV6(a);
  const mask = ((1n << BigInt(bits)) - 1n) << BigInt(128 - bits);
  return { net: n & mask, mask, label };
});
const V6_GLOBAL_MASK = ((1n << 3n) - 1n) << 125n;
const V6_GLOBAL_NET = parseV6('2000::') & V6_GLOBAL_MASK;

// Név-szintű tiltás (a Python _BLOCKED_HOSTNAMES + RFC 6761 *.localhost).
const BLOCKED_HOSTNAMES = new Set([
  'metadata.google.internal', 'metadata', 'instance-data',
  'metadata.goog', 'localhost', 'localhost.localdomain',
]);

// Hop-by-hop fejlécek — a proxy nem adja tovább őket (RFC 7230 6.1).
const HOP_BY_HOP = new Set([
  'connection', 'proxy-connection', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

export function v4ToInt(s) {
  const p = String(s).split('.');
  if (p.length !== 4) return null;
  let n = 0;
  for (const x of p) {
    if (!/^\d{1,3}$/.test(x)) return null;
    const v = Number(x);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

function intToV4(n) {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

// IPv6 → 128 bites BigInt (zóna-azonosító levágva), vagy null.
export function parseV6(s) {
  s = String(s).split('%')[0];
  if (!net.isIPv6(s)) return null;
  let tail4 = null;
  const m = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (m) {
    tail4 = v4ToInt(m[2]);
    if (tail4 === null) return null;
    s = m[1] + '0:0';
  }
  const dbl = s.split('::');
  if (dbl.length > 2) return null;
  const head = dbl[0] ? dbl[0].split(':') : [];
  let groups;
  if (dbl.length === 2) {
    const tail = dbl[1] ? dbl[1].split(':') : [];
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...Array(fill).fill('0'), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  let n = 0n;
  for (const g of groups) n = (n << 16n) | BigInt(parseInt(g || '0', 16));
  if (tail4 !== null) n = (n & ~0xffffffffn) | BigInt(tail4);
  return n;
}

// Az IPv6-ba ágyazott IPv4-ek (a Python _embedded_v4 mintájára), string-listaként.
// A Teredónál a SZERVER- és a (XOR-olt) KLIENS-címet is visszaadjuk — a Python
// csak a klienst nézi; mi mindkettőt (szigorúbb, élő forgalomban irreleváns).
export function embeddedV4(n) {
  const low = Number(n & 0xffffffffn) >>> 0;
  if ((n >> 32n) === 0xffffn) return [intToV4(low)];                    // ::ffff:a.b.c.d
  if ((n >> 32n) === 0x0064ff9b0000000000000000n) return [intToV4(low)]; // 64:ff9b::/96
  if ((n >> 32n) === 0n && n > 1n) return [intToV4(low)];                // ::a.b.c.d
  if ((n >> 112n) === 0x2002n) {                                          // 6to4
    return [intToV4(Number((n >> 80n) & 0xffffffffn) >>> 0)];
  }
  if ((n >> 96n) === 0x20010000n) {                                       // Teredo
    const server = Number((n >> 64n) & 0xffffffffn) >>> 0;
    const client = (~low) >>> 0;
    return [intToV4(server), intToV4(client)];
  }
  return null;
}

// Egy IP tiltott-e. Visszaad: null (engedett) | címke (tiltott, miért).
// allowTestLoopback: CSAK a teszt-harness kapcsolja (lásd testLoopbackAllowed).
export function classifyIp(ip, { allowTestLoopback = false } = {}) {
  const s = String(ip || '').split('%')[0];
  const fam = net.isIP(s);
  if (fam === 4) {
    const n = v4ToInt(s);
    if (n === null) return 'unparseable';
    if (allowTestLoopback && (n >>> 24) === 127) return null;
    for (const r of V4_BLOCKED) {
      if (((n & r.mask) >>> 0) === r.net) return r.label;
    }
    return null;
  }
  if (fam === 6) {
    const n = parseV6(s);
    if (n === null) return 'unparseable';
    if (allowTestLoopback && n === 1n) return null;
    const emb = embeddedV4(n);
    if (emb) {
      for (const v4 of emb) {
        const lbl = classifyIp(v4, { allowTestLoopback });
        if (lbl) return `embedded_v4_${lbl}`;
      }
      return null;
    }
    if ((n & V6_GLOBAL_MASK) !== V6_GLOBAL_NET) {
      if (n === 1n) return 'loopback';
      if (n === 0n) return 'unspecified';
      const top8 = Number(n >> 120n);
      const top10 = Number(n >> 118n);
      if (top8 === 0xff) return 'multicast';
      if ((top8 & 0xfe) === 0xfc) return 'unique_local';
      if (top10 === (0xfe80 >> 6)) return 'link_local';
      if (top10 === (0xfec0 >> 6)) return 'site_local';
      return 'not_global_unicast';
    }
    for (const r of V6_BLOCKED_IN_GLOBAL) {
      if ((n & r.mask) === r.net) return r.label;
    }
    return null;
  }
  return 'unparseable';
}

// A teszt-loopback-kivétel HÁRMAS zárral: explicit flag + NODE_ENV=test +
// nincs RAILWAY_* env. Élesben (Dockerfile NODE_ENV=production, Railway-env)
// így véletlenül sem kapcsolódhat be.
export function testLoopbackAllowed(env = process.env) {
  if (env.BRAVE_EGRESS_ALLOW_TEST_LOOPBACK !== '1') return false;
  if (env.NODE_ENV !== 'test') return false;
  if (Object.keys(env).some(k => k.startsWith('RAILWAY_'))) return false;
  return true;
}

export function egressFilterEnabled(env = process.env) {
  return String(env.BRAVE_EGRESS_FILTER ?? '1').trim() !== '0';
}

function stripBrackets(h) {
  h = String(h || '');
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}

// Napló-biztos URL-alak: CSAK a host (a query/útvonal személyes adat lehet).
export function hostOnly(u) {
  try { return new URL(String(u)).hostname || '-'; } catch (_) { return '-'; }
}

// Szabad szövegben (hibaüzenet) a query-stringek kitakarása naplózás előtt.
export function redactUrls(s) {
  return String(s ?? '').replace(/\b((?:https?|wss?|ftp|file):\/\/[^\s?#'"]*)[?#][^\s'"]*/gi, '$1?…');
}

export class EgressBlockedError extends Error {
  constructor(reason) {
    super(`egress_blocked:${reason}`);
    this.name = 'EgressBlockedError';
    this.code = 'EGRESS_BLOCKED';
    this.egressReason = reason;
  }
}

// ════════════════════════════════════════════════════════════════════
//  EgressGuard — feloldás + ítélet + proxy + biztonságos Node-oldali fetch
// ════════════════════════════════════════════════════════════════════
export class EgressGuard {
  constructor({
    allowTestLoopback = false,
    resolver = null,          // teszt-injekció: async (host) => [{address, family}]
    cacheTtlMs = parseInt(process.env.BRAVE_EGRESS_DNS_CACHE_MS || '30000', 10),
    connectTimeoutMs = parseInt(process.env.BRAVE_EGRESS_CONNECT_TIMEOUT_MS || '10000', 10),
    idleTimeoutMs = parseInt(process.env.BRAVE_EGRESS_IDLE_TIMEOUT_MS || '300000', 10),
    dnsTimeoutMs = 4000,
  } = {}) {
    this.allowTestLoopback = !!allowTestLoopback;
    this._resolverFn = resolver;
    this._cacheTtlMs = Math.max(0, cacheTtlMs);
    this._connectTimeoutMs = connectTimeoutMs;
    this._idleTimeoutMs = idleTimeoutMs;
    this._dnsTimeoutMs = dnsTimeoutMs;
    this._cache = new Map();      // host → {exp, res}
    this._inflight = new Map();   // host → Promise (thundering-herd ellen)
    this._blocks = [];            // gyűrűpuffer: {ts, host, port, reason}
    this._lastLogByHost = new Map();
    this._resolver = new dns.promises.Resolver({ timeout: dnsTimeoutMs, tries: 2 });
    this.server = null;
    this.port = null;
    this._sockets = new Set();    // minden proxy-socket (kliens + upstream) — close()-kor lőjük
    this.stats = { allowed: 0, blocked: 0, dns_fail: 0, connect_fail: 0, tunnels_open: 0 };
    if (this.allowTestLoopback) {
      console.warn('[egress] ⚠️ TESZT-MÓD: a 127.0.0.0/8 és ::1 ENGEDETT (BRAVE_EGRESS_ALLOW_TEST_LOOPBACK=1, NODE_ENV=test)');
    }
  }

  classify(ip) {
    return classifyIp(ip, { allowTestLoopback: this.allowTestLoopback });
  }

  // Host → {ok, ips:[{address,family}], reason, kind:'blocked'|'dns'|null}
  // Az IP-literált nem oldjuk fel, csak megítéljük. MINDEN feloldott cím
  // publikus kell legyen (a Python-őr mintájára: egyetlen belső cím = tiltás).
  async resolveHost(hostRaw) {
    const host = stripBrackets(hostRaw).toLowerCase().replace(/\.$/, '');
    if (!host) return { ok: false, ips: [], reason: 'no_host', kind: 'blocked' };
    const fam = net.isIP(host.split('%')[0]);
    if (fam) {
      const lbl = this.classify(host);
      if (lbl) return { ok: false, ips: [], reason: `blocked_ip:${host}`, kind: 'blocked' };
      return { ok: true, ips: [{ address: host.split('%')[0], family: fam }], reason: 'ok', kind: null };
    }
    if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.localhost')) {
      return { ok: false, ips: [], reason: 'blocked_hostname', kind: 'blocked' };
    }
    const now = Date.now();
    const c = this._cache.get(host);
    if (c && c.exp > now) return c.res;
    if (this._inflight.has(host)) return this._inflight.get(host);
    const p = this._resolveUncached(host).then((res) => {
      const ttl = res.kind === 'dns' ? Math.min(this._cacheTtlMs, 5000) : this._cacheTtlMs;
      if (ttl > 0) {
        if (this._cache.size > 4000) this._cache.delete(this._cache.keys().next().value);
        this._cache.set(host, { exp: Date.now() + ttl, res });
      }
      return res;
    }).finally(() => this._inflight.delete(host));
    this._inflight.set(host, p);
    return p;
  }

  async _resolveUncached(host) {
    let addrs = [];
    try {
      if (this._resolverFn) {
        addrs = (await this._resolverFn(host)) || [];
      } else {
        const [a4, a6] = await Promise.allSettled([
          this._resolver.resolve4(host),
          this._resolver.resolve6(host),
        ]);
        if (a4.status === 'fulfilled') addrs.push(...a4.value.map(address => ({ address, family: 4 })));
        if (a6.status === 'fulfilled') addrs.push(...a6.value.map(address => ({ address, family: 6 })));
        if (!addrs.length) {
          // Tartalék: getaddrinfo (/etc/hosts, különleges resolv-beállítás).
          // Ugyanúgy MINDEN címet megítélünk.
          addrs = await withTimeout(
            dns.promises.lookup(host, { all: true, verbatim: true }),
            this._dnsTimeoutMs, 'dns.lookup',
          ).catch(() => []);
        }
      }
    } catch (e) {
      addrs = [];
    }
    if (!addrs.length) return { ok: false, ips: [], reason: 'dns_resolution_failed', kind: 'dns' };
    for (const a of addrs) {
      const lbl = this.classify(a.address);
      if (lbl) return { ok: false, ips: [], reason: `blocked_ip:${a.address}`, kind: 'blocked' };
    }
    // IPv4 előre: a konténer-egress IPv6-a nem garantált.
    const ips = [...addrs].sort((x, y) => (x.family || 4) - (y.family || 4));
    return { ok: true, ips, reason: 'ok', kind: null };
  }

  // URL-szintű ítélet (séma + host). {ok, reason, kind, host, port, ips}
  async vetUrl(url) {
    let u;
    try { u = new URL(String(url).trim()); } catch (_) {
      return { ok: false, reason: 'bad_url', kind: 'blocked', host: null };
    }
    const scheme = u.protocol.replace(/:$/, '').toLowerCase();
    if (!['http', 'https', 'ws', 'wss'].includes(scheme)) {
      return { ok: false, reason: `scheme_not_allowed:${scheme || 'none'}`, kind: 'blocked', host: u.hostname };
    }
    const host = stripBrackets(u.hostname);
    const port = u.port ? parseInt(u.port, 10) : (scheme === 'https' || scheme === 'wss' ? 443 : 80);
    const r = await this.resolveHost(host);
    return { ...r, host, port };
  }

  recordBlock(host, port, reason) {
    this.stats.blocked++;
    this._blocks.push({ ts: Date.now(), host: String(host || '').toLowerCase(), port, reason });
    if (this._blocks.length > 300) this._blocks.splice(0, this._blocks.length - 300);
    // Napló-árvíz ellen host-onként max 1 sor / 10 s. CSAK host+ok, sosem URL.
    const now = Date.now();
    const last = this._lastLogByHost.get(host) || 0;
    if (now - last > 10000) {
      this._lastLogByHost.set(host, now);
      if (this._lastLogByHost.size > 1000) this._lastLogByHost.clear();
      console.warn(`[egress] BLOCK host=${host} port=${port} reason=${reason}`);
    }
  }

  // A hostra `since` óta rögzített legutóbbi tiltás oka (a toolok ezzel
  // csatolják a Chrome ERR_TUNNEL_CONNECTION_FAILED hibáját a valódi okhoz).
  recentBlockFor(host, since = 0) {
    const h = stripBrackets(String(host || '')).toLowerCase();
    for (let i = this._blocks.length - 1; i >= 0; i--) {
      const b = this._blocks[i];
      if (b.ts < since) break;
      if (b.host === h) return b.reason;
    }
    return null;
  }

  // Sorban próbálja az ELLENŐRZÖTT IP-ket (újrafeloldás NINCS).
  _connectVetted(ips, port) {
    return new Promise((resolve, reject) => {
      let i = 0;
      let lastErr = null;
      const tryNext = () => {
        if (i >= ips.length) return reject(lastErr || new Error('connect_failed'));
        const { address } = ips[i++];
        const sock = net.connect({ host: address, port });
        const t = setTimeout(() => {
          sock.destroy(new Error(`connect timeout ${address}`));
        }, this._connectTimeoutMs);
        sock.once('connect', () => {
          clearTimeout(t);
          sock.removeAllListeners('error');
          this._track(sock);
          // Upstream idle-plafon: a félbehagyott keep-alive/stream ne szivárogjon.
          sock.setTimeout(this._idleTimeoutMs, () => sock.destroy());
          resolve(sock);
        });
        sock.once('error', (e) => { clearTimeout(t); lastErr = e; sock.destroy(); tryNext(); });
      };
      tryNext();
    });
  }

  _track(sock) {
    this._sockets.add(sock);
    sock.once('close', () => this._sockets.delete(sock));
  }

  // ── Proxy ─────────────────────────────────────────────────────────
  async startProxy() {
    if (this.server) return this.port;
    const server = http.createServer((req, res) => {
      this._onProxyRequest(req, res).catch(() => {
        try { if (!res.headersSent) { res.writeHead(502); } res.end(); } catch (_) {}
      });
    });
    server.on('connect', (req, sock, head) => {
      this._onConnect(req, sock, head).catch(() => { try { sock.destroy(); } catch (_) {} });
    });
    server.on('upgrade', (req, sock, head) => {
      this._onUpgrade(req, sock, head).catch(() => { try { sock.destroy(); } catch (_) {} });
    });
    server.on('connection', (sock) => this._track(sock));
    server.on('clientError', (err, sock) => {
      try { sock.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); } catch (_) {}
    });
    server.keepAliveTimeout = 30000;
    server.headersTimeout = 35000;
    server.requestTimeout = 0; // hosszú letöltések/streamek: a tunnel idle-timeout véd
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    server.unref();
    this.server = server;
    this.port = server.address().port;
    console.log(`[egress] proxy fut: 127.0.0.1:${this.port} (tiltott: loopback/privát/link-local/CGNAT/metadata/ULA/multicast + beágyazott v4)`);
    return this.port;
  }

  async close() {
    const s = this.server;
    this.server = null;
    if (!s) return;
    for (const sock of this._sockets) { try { sock.destroy(); } catch (_) {} }
    this._sockets.clear();
    await new Promise((resolve) => {
      s.close(() => resolve());
      try { s.closeAllConnections?.(); } catch (_) {}
      setTimeout(resolve, 1000).unref();
    });
  }

  _rejectSocket(sock, status, headerName, reason) {
    const text = status === 403 ? 'Forbidden' : 'Bad Gateway';
    const body = `brave-mcp egress filter: ${reason}\n`;
    try {
      sock.end(
        `HTTP/1.1 ${status} ${text}\r\n${headerName}: ${reason}\r\n` +
        `Content-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n` +
        `Connection: close\r\n\r\n${body}`,
      );
    } catch (_) {}
  }

  async _onConnect(req, clientSock, head) {
    clientSock.on('error', () => {});
    // CONNECT host:port — IPv6-literál [..]:port alakban jön.
    let host, port;
    const m = String(req.url || '').match(/^\[?([^\]]*?)\]?:(\d+)$/);
    if (m) { host = m[1]; port = parseInt(m[2], 10); }
    if (!host || !port || port < 1 || port > 65535) {
      return this._rejectSocket(clientSock, 403, BLOCK_HEADER, 'bad_connect_target');
    }
    const r = await this.resolveHost(host);
    if (!r.ok) {
      if (r.kind === 'dns') {
        this.stats.dns_fail++;
        return this._rejectSocket(clientSock, 502, ERROR_HEADER, r.reason);
      }
      this.recordBlock(host, port, r.reason);
      return this._rejectSocket(clientSock, 403, BLOCK_HEADER, r.reason);
    }
    let up;
    try {
      up = await this._connectVetted(r.ips, port);
    } catch (e) {
      this.stats.connect_fail++;
      return this._rejectSocket(clientSock, 502, ERROR_HEADER, 'connect_failed');
    }
    if (clientSock.destroyed) { up.destroy(); return; }
    this.stats.allowed++;
    this.stats.tunnels_open++;
    let closed = false;
    const done = () => {
      if (closed) return;
      closed = true;
      this.stats.tunnels_open--;
      up.destroy();
      clientSock.destroy();
    };
    up.on('error', done); up.on('close', done);
    clientSock.on('close', done);
    up.setTimeout(this._idleTimeoutMs, done);
    clientSock.setTimeout(this._idleTimeoutMs, done);
    clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) up.write(head);
    up.pipe(clientSock);
    clientSock.pipe(up);
  }

  _filterHeaders(raw) {
    const conn = [];
    for (let i = 0; i < raw.length; i += 2) {
      if (raw[i].toLowerCase() === 'connection') conn.push(...raw[i + 1].toLowerCase().split(',').map(x => x.trim()));
    }
    const out = [];
    for (let i = 0; i < raw.length; i += 2) {
      const k = raw[i].toLowerCase();
      if (HOP_BY_HOP.has(k) || conn.includes(k)) continue;
      out.push(raw[i], raw[i + 1]);
    }
    return out;
  }

  async _onProxyRequest(req, res) {
    // Csak abszolút-URI http:// kérés proxyzható; a közvetlen (origin-form)
    // kérés a proxy portjára NEM kiszolgálható.
    let u;
    try { u = new URL(req.url); } catch (_) { u = null; }
    if (!u || u.protocol !== 'http:') {
      res.writeHead(400, { 'content-type': 'text/plain', [ERROR_HEADER]: 'not_a_proxy_request' });
      return res.end('brave-mcp egress proxy: absolute http:// URI required\n');
    }
    const host = stripBrackets(u.hostname);
    const port = u.port ? parseInt(u.port, 10) : 80;
    const r = await this.resolveHost(host);
    if (!r.ok) {
      if (r.kind === 'dns') {
        this.stats.dns_fail++;
        res.writeHead(502, { 'content-type': 'text/plain', 'cache-control': 'no-store', [ERROR_HEADER]: r.reason });
        return res.end(`brave-mcp egress filter: ${r.reason}\n`);
      }
      this.recordBlock(host, port, r.reason);
      res.writeHead(403, { 'content-type': 'text/plain', 'cache-control': 'no-store', [BLOCK_HEADER]: r.reason });
      return res.end(`Blocked by brave-mcp egress filter: ${r.reason}\n`);
    }
    let sock;
    try {
      sock = await this._connectVetted(r.ips, port);
    } catch (e) {
      this.stats.connect_fail++;
      res.writeHead(502, { 'content-type': 'text/plain', [ERROR_HEADER]: 'connect_failed' });
      return res.end('brave-mcp egress filter: connect_failed\n');
    }
    this.stats.allowed++;
    const headers = this._filterHeaders(req.rawHeaders);
    const upReq = http.request({
      method: req.method,
      path: (u.pathname || '/') + (u.search || ''),
      headers,
      setHost: false,
      // A már ELLENŐRZÖTT IP-re nyitott socket. (agent NEM adható meg: az
      // `agent: false` új Agentet hoz létre, ami a createConnection-t figyelmen
      // kívül hagyva a `host`-ra — alapból localhostra! — csatlakozna.)
      createConnection: () => sock,
    });
    upReq.setTimeout(this._idleTimeoutMs, () => upReq.destroy(new Error('idle timeout')));
    upReq.on('response', (upRes) => {
      try {
        res.writeHead(upRes.statusCode || 502, upRes.statusMessage, this._filterHeaders(upRes.rawHeaders));
      } catch (_) {
        res.writeHead(502); res.end(); upRes.destroy(); return;
      }
      upRes.pipe(res);
      upRes.on('error', () => res.destroy());
    });
    upReq.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain', [ERROR_HEADER]: 'upstream_error' });
        res.end('brave-mcp egress filter: upstream_error\n');
      } else {
        res.destroy();
      }
    });
    res.on('close', () => { if (!res.writableFinished) upReq.destroy(); });
    req.pipe(upReq);
  }

  // Sima ws:// abszolút-URI upgrade (a Chrome ws-t CONNECT-tel tunnelez, de
  // más kliens küldhet ilyet is) — azonos ítélet, nyers továbbítás.
  async _onUpgrade(req, clientSock, head) {
    clientSock.on('error', () => {});
    let u;
    try { u = new URL(req.url); } catch (_) { u = null; }
    if (!u || !['http:', 'ws:'].includes(u.protocol)) {
      return this._rejectSocket(clientSock, 403, BLOCK_HEADER, 'bad_upgrade_target');
    }
    const host = stripBrackets(u.hostname);
    const port = u.port ? parseInt(u.port, 10) : 80;
    const r = await this.resolveHost(host);
    if (!r.ok) {
      if (r.kind === 'dns') return this._rejectSocket(clientSock, 502, ERROR_HEADER, r.reason);
      this.recordBlock(host, port, r.reason);
      return this._rejectSocket(clientSock, 403, BLOCK_HEADER, r.reason);
    }
    let up;
    try { up = await this._connectVetted(r.ips, port); } catch (e) {
      return this._rejectSocket(clientSock, 502, ERROR_HEADER, 'connect_failed');
    }
    this.stats.allowed++;
    const raw = req.rawHeaders;
    let headStr = `${req.method} ${(u.pathname || '/') + (u.search || '')} HTTP/1.1\r\n`;
    for (let i = 0; i < raw.length; i += 2) {
      const k = raw[i].toLowerCase();
      if (k === 'proxy-connection' || k === 'proxy-authorization') continue;
      headStr += `${raw[i]}: ${raw[i + 1]}\r\n`;
    }
    headStr += '\r\n';
    const done = () => { up.destroy(); clientSock.destroy(); };
    up.on('error', done); up.on('close', done); clientSock.on('close', done);
    up.setTimeout(this._idleTimeoutMs, done);
    up.write(headStr);
    if (head && head.length) up.write(head);
    up.pipe(clientSock);
    clientSock.pipe(up);
  }

  // ── Biztonságos Node-oldali fetch ─────────────────────────────────
  // A szerver saját (nem böngészős) letöltéseihez: minden hop (redirect is)
  // ugyanazon az ítéleten megy át, és az ELLENŐRZÖTT IP-re csatlakozik
  // (lookup-override → nincs újrafeloldás, rebinding-biztos). IP-literálnál a
  // Node nem hív lookupot — ezért a vetUrl előtte külön is ítél.
  async safeFetch(url, { method = 'GET', headers = {}, body = null, timeoutMs = 15000, maxBytes = 4 * 1024 * 1024, maxRedirects = 5 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let cur = String(url);
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const v = await this.vetUrl(cur);
      if (!v.ok) {
        if (v.kind === 'dns') throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${v.host}`), { code: 'ENOTFOUND' });
        this.recordBlock(v.host, v.port, v.reason);
        throw new EgressBlockedError(v.reason);
      }
      const u = new URL(cur);
      if (!['http:', 'https:'].includes(u.protocol)) throw new EgressBlockedError(`scheme_not_allowed:${u.protocol}`);
      const vetted = v.ips;
      const lookup = (hostname, opts, cb) => {
        if (typeof opts === 'function') { cb = opts; opts = {}; }
        if (opts && opts.all) return cb(null, vetted.map(a => ({ address: a.address, family: a.family })));
        return cb(null, vetted[0].address, vetted[0].family);
      };
      const lib = u.protocol === 'https:' ? https : http;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('safeFetch timeout');
      const resp = await new Promise((resolve, reject) => {
        const rq = lib.request(u, { method, headers, lookup, timeout: remaining }, (res) => {
          const chunks = [];
          let size = 0;
          res.on('data', (c) => {
            size += c.length;
            if (size > maxBytes) { res.destroy(new Error('safeFetch: response too large')); return; }
            chunks.push(c);
          });
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
          res.on('error', reject);
        });
        rq.on('timeout', () => rq.destroy(new Error('safeFetch timeout')));
        rq.on('error', reject);
        if (body) rq.write(body);
        rq.end();
      });
      if ([301, 302, 303, 307, 308].includes(resp.status) && resp.headers.location) {
        cur = new URL(resp.headers.location, cur).toString();
        if (resp.status === 303) { method = 'GET'; body = null; }
        continue;
      }
      return {
        ok: resp.status >= 200 && resp.status < 300,
        status: resp.status,
        headers: resp.headers,
        url: cur,
        text: async () => resp.body.toString('utf8'),
        json: async () => JSON.parse(resp.body.toString('utf8')),
      };
    }
    throw new Error('safeFetch: too many redirects');
  }

  health() {
    return {
      enabled: true,
      test_loopback: this.allowTestLoopback,
      proxy_up: !!this.server,
      ...this.stats,
      dns_cache: this._cache.size,
    };
  }
}

function withTimeout(promise, ms, label) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timeout`)), ms); }),
  ]).finally(() => clearTimeout(t));
}

// A Chrome launch-flagjei az egress-szűrőhöz.
export function chromeEgressArgs(port) {
  return [
    `--proxy-server=http://127.0.0.1:${port}`,
    // A Chrome a localhostot/loopbacket ALAPBÓL megkerüli a proxyn — a
    // `<-loopback>` ezt a kivételt törli, így a 127.0.0.1 is a proxyhoz megy
    // (és ott elbukik).
    '--proxy-bypass-list=<-loopback>',
    // WebRTC: csak proxyzott UDP (a nem proxyzott UDP megkerülné a szűrőt).
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--webrtc-ip-handling-policy=disable_non_proxied_udp',
    // QUIC (UDP) sose menjen a proxy mellett.
    '--disable-quic',
  ];
}
