// ════════════════════════════════════════════════════════════════════
//  brave_page — 2026-09-22 (Echolot Engine Firecrawl-paritás, B sáv)
// ════════════════════════════════════════════════════════════════════
// MIÉRT: az Echolot Engine-nek VALÓDI böngésző kell (screenshot, kattintás,
// űrlap, PDF, JS), Firecrawl-nevű actionökkel. A szerződés (KONTRAKTUS.md,
// „brave-mcp ÚJ tool: brave_page") rögzíti a be- és kimenetet — a neveket és
// alakokat NEM változtatjuk, csak additív mezőket adunk (error, action-szintű
// url/status/js_type/clicked).
//
// Biztonsági alapelvek (a szerveren NINCS valódi auth → mindenki elérheti):
//  * Minden hívás / munkamenet SAJÁT inkognitó BrowserContext — a scrape-sáv
//    sütijeihez, a brave_login munkameneteihez és egymáshoz nem fér hozzá.
//  * Csak http/https navigáció (a hívó URL-je, a navigate action ÉS a lapon
//    belüli navigáció is); a forgalom az egress-proxyn megy (loopback/belső háló
//    tiltva, lásd egress.js).
//  * executeJavascript CSAK a lap kontextusában (page.evaluate) — Node-oldali
//    eval/Function SOHA.
//  * Letöltés tiltva (downloadBehavior: deny), felugró ablak zárva.
//  * A munkamenet NEM tart concurrency-slotot a hívások között (csak a
//    kontextust); a hívás a meglévő ScrapeGate-permitet kéri, és a 25 s-os
//    TOOL_CALL_TIMEOUT alatt SAJÁT határidővel ér véget (részleges eredmény +
//    warning, nem a külső 504).
//  * Napló: sosem írunk ki beírt szöveget, scriptet, teljes URL-t, session-id-t.

import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { BLOCK_HEADER } from './egress.js';

const envInt = (k, d) => {
  const v = parseInt(process.env[k] ?? '', 10);
  return Number.isFinite(v) ? v : d;
};

function limitsFromEnv() {
  return {
    maxSessions: Math.max(1, envInt('BRAVE_PAGE_MAX_SESSIONS', 4)),
    idleTtlMs: Math.max(1000, envInt('BRAVE_PAGE_IDLE_TTL_MS', 300000)),
    absTtlMs: Math.max(1000, envInt('BRAVE_PAGE_ABS_TTL_MS', 30 * 60 * 1000)),
    maxProfiles: Math.max(1, envInt('BRAVE_PAGE_MAX_PROFILES', 50)),
    profileMaxBytes: envInt('BRAVE_PAGE_PROFILE_MAX_BYTES', 5 * 1024 * 1024),
    screenshotMaxB64: envInt('BRAVE_PAGE_SCREENSHOT_MAX_B64', 1500000),
    fullPageMaxHeight: envInt('BRAVE_PAGE_FULLPAGE_MAX_HEIGHT', 10000),
    pdfMaxB64: envInt('BRAVE_PAGE_PDF_MAX_B64', 5000000),
    htmlMaxChars: envInt('BRAVE_PAGE_MAX_HTML_CHARS', 2000000),
    textMaxChars: envInt('BRAVE_PAGE_MAX_TEXT_CHARS', 500000),
    jsResultMaxChars: envInt('BRAVE_PAGE_MAX_JS_RESULT_CHARS', 262144),
    maxLinks: 2000,
    maxActions: 50,
    maxScreenshotsPerCall: 6,
    maxPdfsPerCall: 3,
    toolTimeoutMs: envInt('TOOL_CALL_TIMEOUT_MS', 25000),
    sweepIntervalMs: envInt('BRAVE_PAGE_SWEEP_INTERVAL_MS', 15000),
  };
}

const DESKTOP_VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 1, isMobile: false, hasTouch: false };
const MOBILE_VIEWPORT = { width: 412, height: 915, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true };
const PDF_FORMATS = new Set(['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'Letter', 'Legal', 'Tabloid', 'Ledger']);
// A lap URL-je ezek közül lehet (utólagos ellenőrzés minden action után).
// chrome-error: = a Chrome saját hibalapja (sikertelen navigáció), nem tartalom.
const PAGE_SCHEMES_OK = new Set(['http', 'https', 'about', 'blob', 'chrome-error']);
// Hop-by-hop / proxy / keret-fejlécek: a hívó nem állíthatja (a Chrome amúgy is
// elutasítaná, vagy a proxy-ítéletet kerülné meg).
const FORBIDDEN_HEADERS = new Set([
  'host', 'connection', 'proxy-connection', 'proxy-authorization', 'keep-alive',
  'content-length', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'expect',
]);

// block_ads: egyszerű hirdetés/tracker host-lista (utótag-egyezés). A
// scrape-sáv DIET listájának bővített változata — a brave_page képeket NEM
// blokkol (screenshot kell), csak a reklám/követő hostokat.
const AD_HOSTS = [
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'google-analytics.com',
  'googletagmanager.com', 'googletagservices.com', 'adservice.google.com', 'pagead2.googlesyndication.com',
  'amazon-adsystem.com', 'adnxs.com', 'criteo.com', 'criteo.net', 'taboola.com', 'outbrain.com',
  'scorecardresearch.com', 'quantserve.com', 'quantcount.com', 'hotjar.com', 'hotjar.io', 'mixpanel.com',
  'segment.io', 'segment.com', 'chartbeat.com', 'chartbeat.net', 'gemius.pl', 'moatads.com',
  'pubmatic.com', 'rubiconproject.com', 'openx.net', 'casalemedia.com', 'adsrvr.org',
  'smartadserver.com', 'teads.tv', 'yieldmo.com', 'bidswitch.net', '3lift.com', 'sharethrough.com',
  'media.net', 'zemanta.com', 'connect.facebook.net', 'bat.bing.com', 'clarity.ms', 'nr-data.net',
  'adform.net', 'adroll.com', 'doubleverify.com', 'adsafeprotected.com', 'everesttech.net',
  'demdex.net', 'omtrdc.net', 'krxd.net', 'bluekai.com', 'exelator.com', 'rlcdn.com', 'tapad.com',
  'agkn.com', 'mathtag.com', 'contextweb.com', 'spotxchange.com', 'springserve.com', 'lijit.com',
  'sonobi.com', 'advertising.com', 'serving-sys.com', 'flashtalking.com', 'snap.licdn.com',
  'ads.linkedin.com', 'ads-twitter.com', 'static.ads-twitter.com', 'analytics.tiktok.com',
  'onetag-sys.com', 'richaudience.com', 'improvedigital.com', 'adition.com', 'yandex.ru/ads',
];

function isAdHost(host) {
  host = String(host || '').toLowerCase();
  for (const d of AD_HOSTS) {
    if (host === d || host.endsWith('.' + d)) return true;
  }
  return false;
}

function hostOf(u) {
  try { return new URL(String(u)).hostname; } catch (_) { return ''; }
}

function schemeOf(u) {
  const s = String(u || '');
  const i = s.indexOf(':');
  return i > 0 ? s.slice(0, i).toLowerCase() : '';
}

// Warningban a query-t levágjuk (a hívó saját adata, de rövidebb és nem szivárog
// a naplóba, ha valaki mégis kiírná).
function shortUrl(u) {
  try { const x = new URL(String(u)); return `${x.protocol}//${x.host}${x.pathname}`; } catch (_) { return String(u).slice(0, 80); }
}

function clampInt(v, lo, hi, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

const sleep = (ms) => new Promise(r => setTimeout(r, Math.max(0, ms)));

class BudgetError extends Error {
  constructor(label) { super(`deadline_exceeded:${label}`); this.name = 'BudgetError'; }
}

function bounded(promise, ms, label) {
  let t;
  return Promise.race([
    promise,
    new Promise((_, rej) => { t = setTimeout(() => rej(new BudgetError(label)), Math.max(1, ms)); }),
  ]).finally(() => clearTimeout(t));
}

function capStr(s, max) {
  if (typeof s !== 'string') return { value: s, cut: false };
  return s.length > max ? { value: s.slice(0, max), cut: true } : { value: s, cut: false };
}

// ════════════════════════════════════════════════════════════════════
//  Profil-tár (Firecrawl `profile`): storageState = sütik + localStorage
// ════════════════════════════════════════════════════════════════════
// A név a hívó névtere (<owner>:<név>), nem értelmezzük; a fájlnév a név
// SHA-256-ja (útvonal-injekció ellen). LRU max BRAVE_PAGE_MAX_PROFILES.
// Tárolás a konténer diszkjén — deploykor elveszhet (doksi szerint vállalt).
export class ProfileStore {
  constructor(dir, max, maxBytes) {
    this.dir = dir;
    this.max = max;
    this.maxBytes = maxBytes;
    this.index = null;          // key → {lastUsed}
    this.locks = new Map();     // key → holder (a mentő munkamenet)
  }

  key(name) { return crypto.createHash('sha256').update(String(name)).digest('hex'); }

  async _init() {
    if (this.index) return;
    this.index = new Map();
    try {
      await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
      for (const f of await fs.readdir(this.dir)) {
        if (!/^[0-9a-f]{64}\.json$/.test(f)) continue;
        try {
          const st = await fs.stat(path.join(this.dir, f));
          this.index.set(f.slice(0, 64), { lastUsed: st.mtimeMs });
        } catch (_) { /* közben törölték */ }
      }
    } catch (_) { /* nem írható dir → a mentés hibát ad, a betöltés null */ }
  }

  size() { return this.index ? this.index.size : 0; }

  async load(name) {
    await this._init();
    const k = this.key(name);
    try {
      const raw = await fs.readFile(path.join(this.dir, `${k}.json`), 'utf8');
      const data = JSON.parse(raw);
      if (data.name !== name) return null; // hash-ütközés / idegen fájl
      this.index.set(k, { lastUsed: Date.now() });
      return data;
    } catch (_) {
      return null;
    }
  }

  async save(name, state) {
    await this._init();
    const k = this.key(name);
    const body = JSON.stringify({ name, saved_at: new Date().toISOString(), ...state });
    if (Buffer.byteLength(body) > this.maxBytes) {
      throw new Error(`profile_too_large (${Buffer.byteLength(body)} > ${this.maxBytes} bytes)`);
    }
    const file = path.join(this.dir, `${k}.json`);
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fs.writeFile(tmp, body, { mode: 0o600 });
    await fs.rename(tmp, file);
    this.index.set(k, { lastUsed: Date.now() });
    await this._evict();
  }

  async _evict() {
    while (this.index.size > this.max) {
      let oldestK = null, oldest = Infinity;
      for (const [k, v] of this.index) {
        if (this.locks.has(k)) continue;
        if (v.lastUsed < oldest) { oldest = v.lastUsed; oldestK = k; }
      }
      if (!oldestK) break;
      this.index.delete(oldestK);
      try { await fs.unlink(path.join(this.dir, `${oldestK}.json`)); } catch (_) {}
    }
  }

  // „Only one saving session is allowed at a time" (Firecrawl) — egy profilt
  // egyszerre csak EGY munkamenet ment; a többi csak olvas (warninggal).
  tryLock(name, holder) {
    const k = this.key(name);
    const cur = this.locks.get(k);
    if (cur && cur !== holder) return false;
    this.locks.set(k, holder);
    return true;
  }

  unlock(name, holder) {
    const k = this.key(name);
    if (this.locks.get(k) === holder) this.locks.delete(k);
  }
}

// ════════════════════════════════════════════════════════════════════
//  Munkamenet-kezelő
// ════════════════════════════════════════════════════════════════════
export class PageSessionManager {
  constructor(controller) {
    this.c = controller;
    this.limits = limitsFromEnv();
    this.sessions = new Map();     // id → sess
    this._reserved = 0;            // épp létrejövő, megtartandó munkamenetek (limit-verseny ellen)
    this.tombstones = new Map();   // id → ok (pl. browser_recycled) — pontos hibaüzenethez
    const dir = process.env.BRAVE_PAGE_PROFILE_DIR || path.join(process.cwd(), '.sessions', 'page-profiles');
    this.profiles = new ProfileStore(dir, this.limits.maxProfiles, this.limits.profileMaxBytes);
    this._sweeper = setInterval(() => { this._sweep().catch(() => {}); }, this.limits.sweepIntervalMs);
    this._sweeper.unref();
  }

  size() { return this.sessions.size; }

  health() {
    return {
      sessions: this.sessions.size,
      max_sessions: this.limits.maxSessions,
      profiles: this.profiles.size(),
    };
  }

  _tomb(id, reason) {
    this.tombstones.set(id, reason);
    if (this.tombstones.size > 200) this.tombstones.delete(this.tombstones.keys().next().value);
  }

  // A böngésző újraindult / meghalt → a kontextusok vele haltak. Nem várunk a
  // (halott) close()-ra, csak könyvelünk.
  dropAll(reason) {
    for (const [id, s] of this.sessions) {
      this._tomb(id, reason);
      if (s.profile?.save) this.profiles.unlock(s.profile.name, id);
    }
    this.sessions.clear();
  }

  async shutdown() {
    clearInterval(this._sweeper);
    const all = [...this.sessions.keys()];
    await Promise.allSettled(all.map(id => this._closeSession(id, 'shutdown', { save: true })));
  }

  async _sweep() {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (s.busy) continue;
      const idle = now - s.lastUsed > this.limits.idleTtlMs;
      const old = now - s.createdAt > this.limits.absTtlMs;
      if (idle || old) {
        await this._closeSession(id, idle ? 'idle_ttl_expired' : 'absolute_ttl_expired', { save: true });
      }
    }
  }

  async _closeSession(id, reason, { save = false } = {}) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    this._tomb(id, reason);
    if (save && s.profile?.save) {
      try { await bounded(this._saveProfile(s), 4000, 'profile_save'); } catch (_) { /* best effort */ }
    }
    if (s.profile?.save) this.profiles.unlock(s.profile.name, id);
    try { await bounded(s.ctx.close(), 5000, 'ctx_close'); } catch (_) { /* a recycle úgyis takarít */ }
  }

  // ── Profil: betöltés / mentés ───────────────────────────────────────
  async _captureOrigin(s) {
    if (!s.profile) return;
    try {
      const origin = await bounded(s.page.evaluate(() => location.origin), 1500, 'origin');
      if (!/^https?:\/\//.test(origin)) return;
      const entries = await bounded(s.page.evaluate(() => {
        const out = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          out.push([k, localStorage.getItem(k)]);
        }
        return out;
      }), 2000, 'localStorage');
      s.origins.set(origin, entries);
    } catch (_) { /* opaque origin / tiltott storage — kihagyjuk */ }
  }

  async _saveProfile(s) {
    await this._captureOrigin(s);
    const raw = await s.ctx.cookies();
    const cookies = raw.map(c => {
      const o = {
        name: c.name, value: c.value, domain: c.domain, path: c.path,
        secure: !!c.secure, httpOnly: !!c.httpOnly,
      };
      if (c.sameSite) o.sameSite = c.sameSite;
      if (!c.session && typeof c.expires === 'number' && c.expires > 0) o.expires = c.expires;
      return o;
    });
    await this.profiles.save(s.profile.name, { cookies, origins: Object.fromEntries(s.origins) });
  }

  // ── Egress-előszűrés (gyors, beszédes hiba navigáció előtt) ─────────
  async _precheck(url) {
    const sch = schemeOf(url);
    if (sch !== 'http' && sch !== 'https') return { blocked: `scheme_not_allowed:${sch || 'none'}` };
    let u;
    try { u = new URL(url); } catch (_) { return { error: 'bad_url' }; }
    if (!u.hostname) return { error: 'bad_url' };
    if (!this.c._egressEnabled) return {};
    const g = await this.c._ensureEgress();
    const v = await g.vetUrl(url);
    if (v.ok) return {};
    if (v.kind === 'dns') return { error: 'dns_resolution_failed' };
    g.recordBlock(v.host, v.port, v.reason);
    return { blocked: v.reason };
  }

  // ── Lap-előkészítés (egyszer, a munkamenet létrejöttekor) ───────────
  async _setupPage(s, args, warn) {
    const page = s.page;
    // Párbeszédablakok automatikus lezárása (különben az alert örökre fog).
    page.on('dialog', (d) => {
      s.cur?.dialogs.push(d.type());
      (d.type() === 'beforeunload' ? d.accept() : d.dismiss()).catch(() => {});
    });
    // Egress-tiltás csatolása a hívás gyűjtőjéhez.
    page.on('requestfailed', (req) => {
      const cur = s.cur;
      if (!cur) return;
      const err = req.failure()?.errorText || '';
      const isMain = req.isNavigationRequest() && req.frame() === page.mainFrame();
      if (/ERR_TUNNEL_CONNECTION_FAILED/.test(err) && this.c._egress) {
        const h = hostOf(req.url());
        const reason = this.c._egress.recentBlockFor(h, cur.t0);
        if (reason) {
          if (isMain) cur.mainBlocked = reason;
          else cur.subBlocked.set(h, reason);
        }
      }
    });
    page.on('response', (res) => {
      const cur = s.cur;
      if (!cur) return;
      let blockedReason = null;
      try { blockedReason = res.headers()[BLOCK_HEADER] || null; } catch (_) {}
      const req = res.request();
      const isMain = req.isNavigationRequest() && req.frame() === page.mainFrame();
      if (isMain) cur.lastMainStatus = res.status();
      if (blockedReason) {
        if (isMain) cur.mainBlocked = blockedReason;
        else cur.subBlocked.set(hostOf(res.url()), blockedReason);
      }
    });
    page.on('request', (req) => {
      const cur = s.cur;
      if (cur && req.isNavigationRequest() && req.frame() === page.mainFrame()) cur.mainNavCount++;
    });
    page.on('framenavigated', (fr) => {
      if (s.cur && fr === page.mainFrame()) s.cur.mainNavCount++;
    });
    // Felugró ablakok: zárjuk (a hívó a navigate actionnel mehet oda).
    s.ctx.on('targetcreated', async (t) => {
      try {
        if (t.type() !== 'page' || t === page.target()) return;
        s.cur?.popups.push(shortUrl(t.url()));
        const p = await t.page();
        // Rövid türelmi idő: a stealth-plugin evasion-jei még futhatnak a lapon;
        // azonnali zárásnál az ő (nem várt) CDP-hívásuk dobna.
        if (p && p !== page) setTimeout(() => { p.close().catch(() => {}); }, 300);
      } catch (_) { /* már zárt */ }
    });

    await this._applyPerCallSettings(s, args, warn, true);
  }

  async _ensureInterception(s) {
    if (s.intercepting) return;
    s.intercepting = true;
    const page = s.page;
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      try {
        if (req.isInterceptResolutionHandled && req.isInterceptResolutionHandled()) return;
        const url = req.url();
        const sch = schemeOf(url);
        if (req.isNavigationRequest() && !['http', 'https', 'about', 'blob', 'data'].includes(sch)) {
          s.cur?.schemeBlocked.push(sch);
          return req.abort('blockedbyclient');
        }
        if (s.state.blockAds && (sch === 'http' || sch === 'https') && isAdHost(hostOf(url))) {
          if (s.cur) s.cur.adsBlocked++;
          return req.abort('blockedbyclient');
        }
        return req.continue();
      } catch (_) {
        try { req.continue(); } catch (__) { /* már kezelt */ }
      }
    });
  }

  // Hívásonként is állítható beállítások: mobile, headers, locale, timezone,
  // block_ads. (A munkamenet első hívásakor a default-ok is beállnak.)
  async _applyPerCallSettings(s, args, warn, first) {
    const page = s.page;
    const has = (k) => Object.prototype.hasOwnProperty.call(args, k) && args[k] !== undefined && args[k] !== null;
    let uaDirty = false;

    if (first || has('block_ads')) {
      s.state.blockAds = has('block_ads') ? !!args.block_ads : true;
      if (s.state.blockAds) await this._ensureInterception(s);
    }

    if (first || has('mobile')) {
      const mobile = has('mobile') ? !!args.mobile : false;
      if (first || mobile !== s.state.mobile) {
        s.state.mobile = mobile;
        s.viewport = { ...(mobile ? MOBILE_VIEWPORT : DESKTOP_VIEWPORT) };
        await page.setViewport(s.viewport);
        uaDirty = true;
      }
    }

    let acceptLang = null;
    if (has('locale')) {
      const loc = String(args.locale);
      if (/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(loc)) {
        try {
          if (!s.cdp) s.cdp = await page.createCDPSession();
          await s.cdp.send('Emulation.setLocaleOverride', {});
          await s.cdp.send('Emulation.setLocaleOverride', { locale: loc.replace(/-/g, '_') });
        } catch (e) {
          warn(`locale_override_failed: ${String(e.message).slice(0, 80)}`);
        }
        const base = loc.split('-')[0];
        acceptLang = base !== loc ? `${loc},${base};q=0.9` : loc;
        s.state.locale = loc;
        s.state.acceptLanguage = base !== loc ? `${loc},${base}` : loc;
        uaDirty = true;
        {
          // navigator.language(s) — a lap JS-e ezt olvassa (az Accept-Language
          // fejléc csak a szervernek szól). Nyelvváltáskor a régi script megy.
          if (s.localeScript) {
            try { await page.removeScriptToEvaluateOnNewDocument(s.localeScript); } catch (_) {}
          }
          const reg = await page.evaluateOnNewDocument((l) => {
            try {
              const langs = [l, l.split('-')[0]].filter((x, i, a) => a.indexOf(x) === i);
              Object.defineProperty(Navigator.prototype, 'language', { get: () => langs[0], configurable: true });
              Object.defineProperty(Navigator.prototype, 'languages', { get: () => langs, configurable: true });
            } catch (e) { /* nem kritikus */ }
          }, loc);
          s.localeScript = reg?.identifier || null;
        }
      } else {
        warn('locale_invalid: ignored');
      }
    }

    if (has('timezone')) {
      try {
        await page.emulateTimezone(String(args.timezone));
        s.state.timezone = String(args.timezone);
      } catch (e) {
        warn('timezone_invalid: ignored');
      }
    }

    if (has('headers') || acceptLang) {
      const hdrs = {};
      if (acceptLang) hdrs['Accept-Language'] = acceptLang;
      if (has('headers') && typeof args.headers === 'object' && !Array.isArray(args.headers)) {
        let n = 0, bytes = 0;
        for (const [k, v] of Object.entries(args.headers)) {
          const lk = String(k).toLowerCase();
          if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(k) || FORBIDDEN_HEADERS.has(lk) || lk.startsWith('proxy-') || lk.startsWith('sec-')) {
            warn(`header_dropped: ${String(k).slice(0, 40)}`);
            continue;
          }
          const val = String(v ?? '');
          if (/[\r\n]/.test(val)) { warn(`header_dropped: ${String(k).slice(0, 40)}`); continue; }
          n++; bytes += k.length + val.length;
          if (n > 50 || bytes > 16384) { warn('headers_truncated: max 50 headers / 16 KB'); break; }
          hdrs[k] = val;
        }
      }
      s.state.headers = { ...(s.state.headers || {}), ...hdrs };
      await page.setExtraHTTPHeaders(s.state.headers);
    }

    if (uaDirty) await this._applyUA(s);
  }

  // UA / Accept-Language felülírás a lap FŐ CDP-munkamenetén, a stealth-plugin
  // user-agent-override evasion-jével azonos alakban (Windows-maszk desktopon,
  // „greased" brand-lista). MIÉRT kell: a stealth a lap létrejöttekor maga is
  // küld egy Network.setUserAgentOverride-ot acceptLanguage='en-US,en'-nel, ami
  // az Accept-Language-et a setExtraHTTPHeaders ELLENÉRE felülírja (mérve), és
  // ASZINKRON (await nélkül) érkezik — ezért navigáció előtt újra alkalmazzuk.
  async _applyUA(s) {
    if (!s.state.mobile && !s.state.acceptLanguage) return;
    const { full, major } = await this._browserVersion();
    const seed = parseInt(major, 10) || 0;
    const order = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]][seed % 6];
    const esc = [' ', ' ', ';'];
    const brands = [];
    brands[order[0]] = { brand: `${esc[order[0]]}Not${esc[order[1]]}A${esc[order[2]]}Brand`, version: '99' };
    brands[order[1]] = { brand: 'Chromium', version: String(seed) };
    brands[order[2]] = { brand: 'Google Chrome', version: String(seed) };
    let o;
    if (s.state.mobile) {
      o = {
        userAgent: `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`,
        platform: 'Android',
        userAgentMetadata: { brands, fullVersion: full, platform: 'Android', platformVersion: '14', architecture: '', model: 'Pixel 8', mobile: true },
      };
    } else {
      let ua = await this._desktopUA();
      if (ua.includes('Linux') && !ua.includes('Android')) ua = ua.replace(/\(([^)]+)\)/, '(Windows NT 10.0; Win64; x64)');
      o = {
        userAgent: ua,
        platform: 'Win32',
        userAgentMetadata: { brands, fullVersion: full, platform: 'Windows', platformVersion: '10.0', architecture: 'x86', model: '', mobile: false },
      };
    }
    o.acceptLanguage = s.state.acceptLanguage || 'en-US,en';
    const client = typeof s.page._client === 'function' ? s.page._client() : null;
    try {
      if (client) await client.send('Network.setUserAgentOverride', o);
      else await s.page.setUserAgent(o.userAgent, o.userAgentMetadata);
    } catch (_) { /* lap közben zárult */ }
  }

  async _browserVersion() {
    if (this._verCache) return this._verCache;
    let full = '130.0.0.0';
    try {
      const v = await this.c.browser.version();
      const m = String(v).match(/(\d+\.\d+\.\d+\.\d+)/);
      if (m) full = m[1];
    } catch (_) {}
    this._verCache = { full, major: full.split('.')[0] };
    return this._verCache;
  }

  async _desktopUA() {
    let ua = '';
    try { ua = await this.c.browser.userAgent(); } catch (_) {}
    return String(ua || '').replace('HeadlessChrome/', 'Chrome/');
  }

  // ── Navigáció (a hívó URL-je és a navigate action) ──────────────────
  async _goto(s, url, deadline, reserveMs, warn) {
    const pre = await this._precheck(url);
    if (pre.blocked) return { ok: false, blocked: pre.blocked };
    if (pre.error) return { ok: false, error: pre.error };
    if (s.profile) await this._captureOrigin(s);
    const budget = deadline - Date.now() - reserveMs;
    if (budget < 300) return { ok: false, error: 'deadline_exceeded' };
    s.cur.mainBlocked = null;
    // A stealth-plugin a lap létrejöttekor ASZINKRON (await nélkül) küldi a
    // saját UA-felülírását — ha az a miénk UTÁN ér be, a mobil UA / nyelv
    // elveszne. Navigáció előtt újra rátesszük (1 CDP-hívás, csak ha kell).
    await this._applyUA(s);
    let resp = null;
    try {
      resp = await s.page.goto(url, { waitUntil: 'load', timeout: Math.min(budget, 20000) });
    } catch (e) {
      if (s.cur.mainBlocked) return { ok: false, blocked: s.cur.mainBlocked };
      if (e?.name === 'TimeoutError' || /timeout/i.test(String(e?.message))) {
        // A DOM többnyire megvan (nehéz lap, lógó tracker) — folytatjuk, jelölve.
        warn('load_timeout: continuing with the partially loaded page');
        return { ok: true, status: s.cur.lastMainStatus };
      }
      return { ok: false, error: `navigation_failed: ${String(e?.message || e).split('\n')[0].slice(0, 160)}` };
    }
    if (s.cur.mainBlocked) return { ok: false, blocked: s.cur.mainBlocked };
    const status = resp ? resp.status() : s.cur.lastMainStatus;
    return { ok: true, status };
  }

  // Minden action után: a lap nem kerülhetett nem-http(s) sémára.
  async _schemeGuard(s) {
    const u = s.page.url();
    const sch = schemeOf(u);
    if (!PAGE_SCHEMES_OK.has(sch)) {
      try { await bounded(s.page.goto('about:blank'), 3000, 'blank'); } catch (_) {}
      return `scheme_not_allowed:${sch}`;
    }
    return null;
  }

  // Input-action után: ha navigációt indított, megvárjuk a loadot (korlátosan).
  async _settleAfterInput(s, fn, deadline, reserveMs, warn) {
    const before = s.cur.mainNavCount;
    const rem = deadline - Date.now() - reserveMs;
    const navP = s.page.waitForNavigation({ waitUntil: 'load', timeout: Math.max(300, Math.min(rem, 15000)) })
      .then(() => 'nav', () => 'navfail');
    await bounded(fn(), Math.max(300, rem), 'action');
    await sleep(Math.min(400, Math.max(0, deadline - Date.now() - reserveMs)));
    if (s.cur.mainNavCount > before) {
      const r = await bounded(navP, Math.max(300, deadline - Date.now() - reserveMs), 'navigation').catch(() => 'navfail');
      if (r === 'navfail') warn('navigation_after_action_incomplete');
    }
  }

  // ── Screenshot (JPEG, minőség-lépcső, magasság-plafon) ──────────────
  async _screenshot(s, opts, deadline, warn) {
    const page = s.page;
    const L = this.limits;
    opts = opts && typeof opts === 'object' ? opts : {};
    if (opts.viewport && typeof opts.viewport === 'object') {
      const w = clampInt(opts.viewport.width, 200, 3840, s.viewport.width);
      const h = clampInt(opts.viewport.height, 200, 4320, s.viewport.height);
      s.viewport = { ...s.viewport, width: w, height: h };
      await page.setViewport(s.viewport);
    }
    const q0 = clampInt(opts.quality, 1, 100, 80);
    // fullPage: a dokumentum méretére vágott clip (magasság-plafonnal) — így a
    // lekicsinyítés (scale) is a teljes lapra vonatkozik, nem a viewportra.
    let fullClip = null;
    if (opts.fullPage) {
      const dims = await bounded(page.evaluate(() => ({
        h: Math.max(document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0),
        w: Math.max(document.documentElement?.scrollWidth || 0, window.innerWidth || 0),
      })), 2000, 'dims').catch(() => null);
      const w = Math.max(1, Math.min(dims?.w || s.viewport.width, 3840));
      let h = Math.max(1, dims?.h || s.viewport.height);
      if (h > L.fullPageMaxHeight) {
        warn(`screenshot_height_capped: ${h}px → ${L.fullPageMaxHeight}px`);
        h = L.fullPageMaxHeight;
      }
      fullClip = { x: 0, y: 0, width: w, height: h };
    }
    const qualities = [...new Set([q0, Math.min(q0, 60), Math.min(q0, 40), Math.min(q0, 25)])];
    const shoot = async (quality, scale) => {
      const o = { type: 'jpeg', quality, encoding: 'base64' };
      // FIGYELEM (mérve, Chrome 152): a clip.scale CSAK captureBeyondViewport:true
      // mellett kicsinyít — false mellett a kimenet teljes méretű marad.
      if (fullClip) {
        o.clip = { ...fullClip, scale };
        o.captureBeyondViewport = true;       // clip = dokumentum-koordináta
      } else if (scale !== 1) {
        const off = await bounded(page.evaluate(() => [window.scrollX, window.scrollY]), 1500, 'scroll').catch(() => [0, 0]);
        o.clip = { x: off[0], y: off[1], width: s.viewport.width, height: s.viewport.height, scale };
        o.captureBeyondViewport = true;
      } else {
        o.captureBeyondViewport = false;
      }
      const rem = deadline - Date.now() - 300;
      if (rem < 300) throw new BudgetError('screenshot');
      return bounded(page.screenshot(o), rem, 'screenshot');
    };
    for (const q of qualities) {
      const b64 = await shoot(q, 1);
      if (b64.length <= L.screenshotMaxB64) {
        if (q !== q0) warn(`screenshot_quality_reduced: ${q0} → ${q} (cap ${L.screenshotMaxB64} b64 chars)`);
        return `data:image/jpeg;base64,${b64}`;
      }
    }
    for (const [scale, q] of [[0.5, Math.min(q0, 40)], [0.25, Math.min(q0, 40)], [0.25, Math.min(q0, 20)]]) {
      const b64 = await shoot(q, scale);
      if (b64.length <= L.screenshotMaxB64) {
        warn(`screenshot_downscaled: scale ${scale}, quality ${q} (cap ${L.screenshotMaxB64} b64 chars)`);
        return `data:image/jpeg;base64,${b64}`;
      }
    }
    throw new Error('screenshot_too_large');
  }

  // Szöveg szerinti elemkeresés (a lapban): előbb a kattintható elemek, aztán
  // bármely elem, aminek a SAJÁT szövege egyezik; a legkisebb (legspecifikusabb) nyer.
  async _findByText(page, text) {
    const handle = await page.evaluateHandle((needle) => {
      const norm = (x) => String(x || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const want = norm(needle);
      if (!want) return null;
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
      };
      const clickable = Array.from(document.querySelectorAll(
        'a, button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], input[type="submit"], input[type="button"], label, summary, [onclick]'
      ));
      const txt = (el) => norm(el.innerText || el.value || el.getAttribute('aria-label') || '');
      let best = null;
      for (const el of clickable) {
        const t = txt(el);
        if (!t || !visible(el)) continue;
        if (t === want) return el;
        if (t.includes(want) && (!best || t.length < txt(best).length)) best = el;
      }
      if (best) return best;
      const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
      let node;
      while ((node = walker.nextNode())) {
        const own = Array.from(node.childNodes).filter(n => n.nodeType === 3).map(n => n.textContent).join(' ');
        if (norm(own).includes(want) && visible(node)) return node;
      }
      return null;
    }, text);
    const el = handle.asElement();
    if (!el) { await handle.dispose(); return null; }
    return el;
  }

  async _clickHandle(el) {
    try {
      await el.click();
    } catch (e) {
      // Nem látható / takart elem: DOM-szintű click (a Firecrawl is ezt teszi).
      await el.evaluate((n) => n.click());
    }
  }

  async _runAction(s, a, deadline, reserveMs, warn, counters) {
    const page = s.page;
    const type = a && typeof a === 'object' ? String(a.type || '') : '';
    const r = { type, ok: false };
    const rem = () => deadline - Date.now() - reserveMs;
    if (rem() < 200) { r.error = 'deadline_exceeded'; return r; }
    switch (type) {
      case 'wait': {
        const ms = a.milliseconds !== undefined ? clampInt(a.milliseconds, 0, 120000, 0) : null;
        if (a.selector) {
          const t = Math.max(100, Math.min(rem(), ms || rem()));
          await page.waitForSelector(String(a.selector), { timeout: t });
        } else if (ms !== null) {
          if (ms > rem()) warn(`wait_truncated: ${ms}ms → ${Math.max(0, rem())}ms`);
          await sleep(Math.min(ms, rem()));
        } else {
          r.error = 'wait requires milliseconds or selector';
          return r;
        }
        break;
      }
      case 'click': {
        if (a.selector && a.all) {
          const els = await page.$$(String(a.selector));
          let n = 0;
          await this._settleAfterInput(s, async () => {
            for (const el of els) {
              if (rem() < 200) break;
              try { await this._clickHandle(el); n++; } catch (_) { /* elem közben eltűnt */ }
            }
          }, deadline, reserveMs, warn);
          r.clicked = n;
        } else if (a.selector) {
          const el = await page.waitForSelector(String(a.selector), { timeout: Math.max(100, Math.min(rem(), 10000)) });
          await this._settleAfterInput(s, () => this._clickHandle(el), deadline, reserveMs, warn);
          r.clicked = 1;
        } else if (typeof a.text === 'string' && a.text.trim()) {
          const el = await bounded(this._findByText(page, a.text), Math.max(200, rem()), 'find_text');
          if (!el) { r.error = 'no element matches text'; return r; }
          await this._settleAfterInput(s, () => this._clickHandle(el), deadline, reserveMs, warn);
          r.clicked = 1;
        } else if (Number.isFinite(Number(a.x)) && Number.isFinite(Number(a.y))) {
          await this._settleAfterInput(s, () => page.mouse.click(Number(a.x), Number(a.y)), deadline, reserveMs, warn);
          r.clicked = 1;
        } else {
          r.error = 'click requires selector, text or x/y';
          return r;
        }
        break;
      }
      case 'write': {
        if (typeof a.text !== 'string') { r.error = 'write requires text'; return r; }
        let text = a.text;
        if (text.length > 20000) { text = text.slice(0, 20000); warn('write_truncated: max 20000 chars'); }
        if (a.selector) {
          const el = await page.waitForSelector(String(a.selector), { timeout: Math.max(100, Math.min(rem(), 10000)) });
          await el.focus();
        }
        if (text.length <= 1000) {
          await bounded(page.keyboard.type(text), Math.max(200, rem()), 'write');
        } else {
          // Hosszú szöveg: egy lépésben (Input.insertText), karakterenként lassú lenne.
          await bounded(page.keyboard.sendCharacter(text), Math.max(200, rem()), 'write');
          warn('write_inserted_at_once: text > 1000 chars');
        }
        break;
      }
      case 'press': {
        if (typeof a.key !== 'string' || !a.key) { r.error = 'press requires key'; return r; }
        await this._settleAfterInput(s, () => page.keyboard.press(a.key), deadline, reserveMs, warn);
        break;
      }
      case 'scroll': {
        const dir = a.direction === 'up' ? -1 : 1;
        const amount = a.amount !== undefined ? clampInt(a.amount, 1, 100000, 0) : Math.round(s.viewport.height * 0.9);
        const dy = dir * amount;
        if (a.selector) {
          const ok = await page.$eval(String(a.selector), (el, d) => { el.scrollBy(0, d); return true; }, dy).catch(() => false);
          if (!ok) { r.error = 'scroll selector not found'; return r; }
        } else {
          await page.evaluate((d) => window.scrollBy(0, d), dy);
        }
        await sleep(Math.min(250, Math.max(0, rem())));   // lazy-load esélye
        break;
      }
      case 'screenshot': {
        if (++counters.screenshots > this.limits.maxScreenshotsPerCall) {
          r.error = `screenshot limit: max ${this.limits.maxScreenshotsPerCall} per call`;
          return r;
        }
        r.screenshot = await this._screenshot(s, a, deadline - reserveMs, warn);
        break;
      }
      case 'scrape': {
        const html = await bounded(page.content(), Math.max(200, rem()), 'scrape');
        const c = capStr(html, this.limits.htmlMaxChars);
        if (c.cut) warn(`action_scrape_html_truncated: ${html.length} → ${this.limits.htmlMaxChars} chars`);
        r.html = c.value;
        r.url = page.url();
        break;
      }
      case 'executeJavascript': {
        if (typeof a.script !== 'string' || !a.script.trim()) { r.error = 'executeJavascript requires script'; return r; }
        if (a.script.length > 100000) { r.error = 'script too long (max 100000 chars)'; return r; }
        // CSAK a lap kontextusában (Runtime.evaluate a lapban). Ha a script
        // `return`-t használ, függvénytestként futtatjuk (Firecrawl-szokás).
        const expr = /\breturn\b/.test(a.script) ? `(async () => {\n${a.script}\n})()` : a.script;
        let value;
        await this._settleAfterInput(s, async () => { value = await page.evaluate(expr); }, deadline, reserveMs, warn);
        let json;
        try { json = JSON.stringify(value); } catch (_) { json = undefined; }
        if (json !== undefined && json.length > this.limits.jsResultMaxChars) {
          warn(`js_result_dropped: ${json.length} > ${this.limits.jsResultMaxChars} chars`);
          value = null;
        }
        r.js_result = value === undefined ? null : value;
        r.js_type = value === null ? 'null' : typeof value;
        break;
      }
      case 'generatePDF':
      case 'pdf': {
        if (++counters.pdfs > this.limits.maxPdfsPerCall) {
          r.error = `pdf limit: max ${this.limits.maxPdfsPerCall} per call`;
          return r;
        }
        const format = PDF_FORMATS.has(a.format) ? a.format : 'Letter';
        if (a.format && !PDF_FORMATS.has(a.format)) warn(`pdf_format_invalid: using Letter`);
        const scale = Math.min(2, Math.max(0.1, Number.isFinite(Number(a.scale)) ? Number(a.scale) : 1));
        const t = Math.max(300, rem());
        const buf = await bounded(page.pdf({ format, landscape: !!a.landscape, scale, printBackground: true, timeout: t }), t, 'pdf');
        const b64 = Buffer.from(buf).toString('base64');
        if (b64.length > this.limits.pdfMaxB64) {
          r.error = `pdf_too_large: ${b64.length} > ${this.limits.pdfMaxB64} b64 chars`;
          return r;
        }
        r.pdf = `data:application/pdf;base64,${b64}`;
        break;
      }
      case 'navigate': {
        if (typeof a.url !== 'string' || !a.url) { r.error = 'navigate requires url'; return r; }
        const g = await this._goto(s, a.url, deadline, reserveMs, warn);
        if (g.blocked) { r.error = 'egress_blocked'; r.blocked = { reason: g.blocked }; return r; }
        if (!g.ok) { r.error = g.error; return r; }
        r.url = s.page.url();
        r.status = g.status ?? null;
        break;
      }
      default:
        r.error = `unknown action type: ${type.slice(0, 40) || '(none)'}`;
        return r;
    }
    r.ok = true;
    return r;
  }

  // ── Fő belépési pont ────────────────────────────────────────────────
  async run(args) {
    const t0 = Date.now();
    const L = this.limits;
    args = args && typeof args === 'object' ? args : {};
    const reqTimeout = clampInt(args.timeout_ms, 1000, L.toolTimeoutMs, L.toolTimeoutMs);
    // A külső TOOL_CALL_TIMEOUT alatt SAJÁT határidő (részleges eredmény > 504).
    const deadline = t0 + Math.min(reqTimeout, L.toolTimeoutMs - 1200);
    const out = {
      ok: false, session_id: null,
      url: typeof args.url === 'string' ? args.url : null,
      final_url: null, status: null, title: null,
      html: null, text: null, links: null, screenshot: null,
      action_results: [], blocked: null, warnings: [], elapsed_ms: 0,
      error: null,
    };
    const warn = (w) => { if (out.warnings.length < 100) out.warnings.push(String(w)); };
    const finish = () => { out.elapsed_ms = Date.now() - t0; return out; };
    const fail = (err) => { out.error = err; return finish(); };

    const sid = typeof args.session_id === 'string' && args.session_id ? args.session_id : null;
    const url = typeof args.url === 'string' && args.url.trim() ? args.url.trim() : null;
    if (!sid && !url) return fail('url_required');
    const actions = Array.isArray(args.actions) ? args.actions : [];
    if (args.actions !== undefined && !Array.isArray(args.actions)) return fail('actions_must_be_array');
    if (actions.length > L.maxActions) return fail(`too_many_actions: max ${L.maxActions}`);

    // formats: string VAGY {type:'screenshot', fullPage, quality, viewport}
    let screenshotOpts = args.screenshot && typeof args.screenshot === 'object' ? args.screenshot : {};
    const fmts = new Set();
    const rawFormats = Array.isArray(args.formats) ? args.formats : ['html'];
    for (const f of rawFormats) {
      const name = typeof f === 'string' ? f : (f && typeof f === 'object' ? String(f.type || '') : '');
      if (['html', 'text', 'links', 'screenshot'].includes(name)) {
        fmts.add(name);
        if (name === 'screenshot' && typeof f === 'object') screenshotOpts = { ...screenshotOpts, ...f };
      } else {
        warn(`unknown_format_ignored: ${String(name).slice(0, 30)}`);
      }
    }
    const reserveMs = fmts.has('screenshot') ? 3000 : 1500;

    // Egress-előszűrés a fő URL-re (gyors, beszédes blocked-válasz).
    if (url) {
      const pre = await this._precheck(url);
      if (pre.blocked) { out.blocked = { reason: pre.blocked }; return fail('egress_blocked'); }
      if (pre.error) return fail(pre.error);
    }

    if (this.c._breakerOpen && this.c._breakerOpen()) return fail('brave_down');

    // Munkamenet feloldása / helyfoglalás (a slot-kérés ELŐTT, hogy egy foglalt
    // munkamenet ne tartson feleslegesen concurrency-slotot).
    let s = null;
    let keep = false;
    let reserved = false;
    if (sid) {
      s = this.sessions.get(sid);
      if (!s) {
        const why = this.tombstones.get(sid);
        return fail(why ? `session_lost:${why}` : 'session_not_found');
      }
      if (s.busy) return fail('session_busy');
      s.busy = true;
      keep = true;
    } else {
      keep = !!args.keep_session && !args.close;
      if (keep) {
        if (this.sessions.size + this._reserved >= L.maxSessions) {
          return fail(`too_many_sessions: max ${L.maxSessions} (close one or wait for idle TTL ${Math.round(L.idleTtlMs / 1000)}s)`);
        }
        this._reserved++;
        reserved = true;
      }
    }

    let permit = false;
    try {
      const gateWait = deadline - Date.now() - reserveMs;
      try {
        await this.c._scrapeGate.acquire(Math.max(300, gateWait));
        permit = true;
      } catch (_) {
        return fail('busy: concurrency limit reached, retry later');
      }

      if (!s) {
        const createP = this._createSession(args, keep, warn);
        try {
          s = await bounded(createP, Math.max(1000, deadline - Date.now() - reserveMs), 'create_session');
        } catch (e) {
          // Határidő után is létrejöhet a kontextus → akkor azonnal zárjuk
          // (különben gazdátlanul szivárogna).
          createP.then((late) => {
            if (late.profile?.save) this.profiles.unlock(late.profile.name, late.id);
            late.ctx.close().catch(() => {});
          }, () => {});
          return fail(`session_create_failed: ${String(e.message).slice(0, 120)}`);
        }
        s.busy = true;
      } else {
        try {
          await this._applyPerCallSettings(s, args, warn, false);
        } catch (e) {
          warn(`settings_failed: ${String(e.message).slice(0, 80)}`);
        }
      }

      const cur = {
        t0, mainBlocked: null, subBlocked: new Map(), adsBlocked: 0, schemeBlocked: [],
        popups: [], dialogs: [], lastMainStatus: null, mainNavCount: 0,
      };
      s.cur = cur;
      const page = s.page;
      if (!out.url) out.url = page.url();

      let navOk = true;
      if (url) {
        const g = await this._goto(s, url, deadline, reserveMs, warn);
        if (g.blocked) { out.blocked = { reason: g.blocked }; navOk = false; out.error = 'egress_blocked'; }
        else if (!g.ok) { navOk = false; out.error = g.error; }
        else out.status = g.status ?? null;
      }

      if (navOk && args.wait_ms) {
        const w = clampInt(args.wait_ms, 0, 60000, 0);
        const avail = deadline - Date.now() - reserveMs;
        if (w > avail) warn(`wait_ms_truncated: ${w} → ${Math.max(0, avail)}`);
        await sleep(Math.min(w, Math.max(0, avail)));
      }

      // Actionök sorban; az első hiba után a többi kimarad (láthatóan).
      let actionsOk = true;
      const counters = { screenshots: 0, pdfs: 0 };
      for (let i = 0; i < actions.length; i++) {
        const a = actions[i];
        if (!navOk || !actionsOk || out.blocked) {
          out.action_results.push({ type: String(a?.type || ''), ok: false, error: 'skipped: an earlier step failed' });
          continue;
        }
        let r;
        try {
          r = await this._runAction(s, a, deadline, reserveMs, warn, counters);
        } catch (e) {
          r = { type: String(a?.type || ''), ok: false, error: String(e?.message || e).split('\n')[0].slice(0, 200) };
          if (e instanceof BudgetError) r.error = 'deadline_exceeded';
        }
        if (cur.mainBlocked && !out.blocked) {
          out.blocked = { reason: cur.mainBlocked };
          if (r.ok) { r.ok = false; r.error = 'egress_blocked'; }
        }
        if (r.blocked && !out.blocked) out.blocked = r.blocked;
        const bad = await this._schemeGuard(s).catch(() => null);
        if (bad) {
          out.blocked = { reason: bad };
          r.ok = false; r.error = 'egress_blocked';
        }
        if (!r.ok) actionsOk = false;
        out.action_results.push(r);
      }
      if (out.blocked && !out.error) out.error = 'egress_blocked';

      // Kimeneti formátumok — tiltott/hibás fő navigációnál nincs tartalom.
      const contentAllowed = navOk && !out.blocked;
      try { out.final_url = page.url(); } catch (_) {}
      if (contentAllowed) {
        const fr = Math.max(500, deadline - Date.now());
        try { out.title = await bounded(page.title(), Math.min(fr, 2000), 'title'); } catch (_) {}
        if (cur.lastMainStatus && out.status === null) out.status = cur.lastMainStatus;
        if (fmts.has('html')) {
          try {
            const html = await bounded(page.content(), Math.max(300, deadline - Date.now()), 'html');
            const c = capStr(html, L.htmlMaxChars);
            if (c.cut) warn(`html_truncated: ${html.length} → ${L.htmlMaxChars} chars`);
            out.html = c.value;
          } catch (e) { warn(`html_failed: ${String(e.message).slice(0, 80)}`); }
        }
        if (fmts.has('text')) {
          try {
            const t = await bounded(page.evaluate(() => (document.body ? document.body.innerText : '')), Math.max(300, deadline - Date.now()), 'text');
            const c = capStr(t, L.textMaxChars);
            if (c.cut) warn(`text_truncated: ${t.length} → ${L.textMaxChars} chars`);
            out.text = c.value;
          } catch (e) { warn(`text_failed: ${String(e.message).slice(0, 80)}`); }
        }
        if (fmts.has('links')) {
          try {
            const links = await bounded(page.evaluate(() => {
              const seen = new Set();
              const out = [];
              for (const a of document.querySelectorAll('a[href]')) {
                const h = a.href;
                if (/^https?:/i.test(h) && !seen.has(h)) { seen.add(h); out.push(h); }
              }
              return out;
            }), Math.max(300, deadline - Date.now()), 'links');
            if (links.length > L.maxLinks) warn(`links_truncated: ${links.length} → ${L.maxLinks}`);
            out.links = links.slice(0, L.maxLinks);
          } catch (e) { warn(`links_failed: ${String(e.message).slice(0, 80)}`); }
        }
        if (fmts.has('screenshot')) {
          try {
            out.screenshot = await this._screenshot(s, screenshotOpts, deadline, warn);
          } catch (e) {
            warn(`screenshot_failed: ${e instanceof BudgetError ? 'deadline_exceeded' : String(e.message).slice(0, 80)}`);
          }
        }
      }

      // Láthatóság: minden kizárás/vágás warningban.
      if (cur.subBlocked.size) {
        const list = [...cur.subBlocked.entries()].slice(0, 10).map(([h, r]) => `${h} (${r})`);
        warn(`egress_blocked_subresources: ${list.join(', ')}${cur.subBlocked.size > 10 ? ` +${cur.subBlocked.size - 10}` : ''}`);
      }
      if (cur.adsBlocked) warn(`block_ads: ${cur.adsBlocked} request(s) blocked`);
      if (cur.schemeBlocked.length) warn(`navigation_scheme_blocked: ${[...new Set(cur.schemeBlocked)].join(', ')}`);
      if (cur.popups.length) warn(`popup_closed: ${cur.popups.slice(0, 5).join(', ')}`);
      if (cur.dialogs.length) warn(`dialog_dismissed: ${cur.dialogs.slice(0, 5).join(', ')}`);
      if (Date.now() > deadline) warn('deadline_exceeded: partial result');

      out.ok = !out.error && actionsOk && navOk && !out.blocked;

      // Profil mentése (a hívás végén; a munkamenet zárásakor is).
      if (s.profile?.save) {
        try {
          await bounded(this._saveProfile(s), Math.max(1000, Math.min(4000, deadline + 1000 - Date.now())), 'profile_save');
        } catch (e) {
          warn(`profile_save_failed: ${String(e.message).slice(0, 100)}`);
        }
      }
      s.cur = null;

      const expired = Date.now() - s.createdAt > L.absTtlMs;
      if (keep && !args.close && !expired) {
        s.lastUsed = Date.now();
        if (!this.sessions.has(s.id)) this.sessions.set(s.id, s);
        out.session_id = s.id;
      } else {
        if (keep && expired) warn('session_closed: absolute TTL reached');
        const id = s.id;
        if (this.sessions.has(id)) {
          await this._closeSession(id, args.close ? 'closed_by_caller' : 'absolute_ttl_expired');
        } else {
          if (s.profile?.save) this.profiles.unlock(s.profile.name, id);
          // A zárás a hívás-határidőn belül maradjon (a külső 25 s-os timeout
          // előtt); ha nem fér bele, a háttérben fut tovább.
          const closeP = s.ctx.close().catch(() => {});
          try { await bounded(closeP, Math.max(300, Math.min(5000, deadline + 800 - Date.now())), 'ctx_close'); } catch (_) {}
        }
        s = null;
      }
      return finish();
    } catch (e) {
      out.ok = false;
      out.error = out.error || `internal_error: ${String(e?.message || e).split('\n')[0].slice(0, 160)}`;
      // Hibás állapotú munkamenetet nem tartunk meg.
      if (s) {
        const id = s.id;
        s.cur = null;
        if (this.sessions.has(id)) await this._closeSession(id, 'error').catch(() => {});
        else { try { await bounded(s.ctx.close(), 3000, 'ctx_close'); } catch (_) {} }
        s = null;
      }
      return finish();
    } finally {
      if (s) s.busy = false;
      if (reserved) this._reserved--;
      if (permit) this.c._scrapeGate.release();
    }
  }

  async _createSession(args, keep, warn) {
    const browser = await this.c.ensureBrowser();
    const ctx = await browser.createBrowserContext({ downloadBehavior: { policy: 'deny' } });
    const id = crypto.randomBytes(16).toString('hex');   // 128 bit
    const s = {
      id, ctx, page: null, keep, busy: false,
      createdAt: Date.now(), lastUsed: Date.now(),
      profile: null, origins: new Map(), state: {}, viewport: { ...DESKTOP_VIEWPORT },
      cur: null, cdp: null, intercepting: false,
    };
    try {
      if (args.profile !== undefined && args.profile !== null) {
        const p = args.profile;
        const name = p && typeof p === 'object' ? p.name : null;
        // A szerződés 1-128 karaktert mond a FELHASZNÁLÓI névre, de az engine
        // `<owner>:<név>` alakban küldi (k_<sha12>: + 128 = 143) → 256-ig engedünk
        // (a név úgyis SHA-256-tal kerül fájlnévbe).
        if (typeof name !== 'string' || name.length < 1 || name.length > 256) {
          warn('profile_invalid: name must be a 1-256 char string; ignored');
        } else {
          let save = p.save_changes ?? p.saveChanges ?? true;
          save = save !== false;
          if (save && !this.profiles.tryLock(name, id)) {
            warn('profile_locked: another session is saving this profile; opened read-only');
            save = false;
          }
          s.profile = { name, save };
          const stored = await this.profiles.load(name);
          if (stored) {
            if (Array.isArray(stored.cookies) && stored.cookies.length) {
              try { await ctx.setCookie(...stored.cookies); } catch (e) { warn(`profile_cookies_restore_failed: ${String(e.message).slice(0, 80)}`); }
            }
            if (stored.origins && typeof stored.origins === 'object') {
              for (const [o, entries] of Object.entries(stored.origins)) {
                if (Array.isArray(entries)) s.origins.set(o, entries);
              }
            }
          }
        }
      }
      s.page = await ctx.newPage();
      if (s.origins.size) {
        // localStorage-visszatöltés: a lap SAJÁT scriptjei előtt, originenként,
        // csak ha az adott origin tára még üres (friss kontextus).
        await s.page.evaluateOnNewDocument((data) => {
          try {
            const items = data[location.origin];
            if (!items || localStorage.length) return;
            for (const [k, v] of items) localStorage.setItem(k, v);
          } catch (e) { /* opaque origin */ }
        }, Object.fromEntries(s.origins));
      }
      await this._setupPage(s, args, warn);
      return s;
    } catch (e) {
      if (s.profile?.save) this.profiles.unlock(s.profile.name, id);
      try { await bounded(ctx.close(), 3000, 'ctx_close'); } catch (_) {}
      throw e;
    }
  }
}
