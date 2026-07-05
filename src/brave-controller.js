import { addExtra } from 'puppeteer-extra';
import rebrowserPuppeteer from 'rebrowser-puppeteer';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import TurndownService from 'turndown';
import * as cheerio from 'cheerio';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileP = promisify(execFile);

const require = createRequire(import.meta.url);

// ESM compatibility
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 2026-05-12 upgrade: a klasszikus `puppeteer` (v19) helyett `rebrowser-puppeteer`
// drop-in csere. Ugyanaz az API, de CDP-szintű leakeket is befedi (Runtime.enable
// detect, Source.URL stack, stb.) — jelentősen erősebb a 2024+ Cloudflare Turnstile
// és más viselkedés-elemző anti-bot pipeline-ok ellen. A StealthPlugin réteg
// FÖLÖTTE marad — a két javítás kumulált.
const puppeteer = addExtra(rebrowserPuppeteer);
puppeteer.use(StealthPlugin());

// 2026-07-01: SCRAPE-SÁV FÉK — concurrency-cap + böngésző-recycle. A Brave MCP
// megosztott instance-át az Echolot háttér-scrape-je folyamatosan terheli; fék
// nélkül a párhuzamos lapok RAM-spike-ot, a Chromium kúszó RSS-e pedig lassú
// OOM-ot okoz (megfigyelt ismétlődő crash, ~napi és rosszabb esetben óránkénti).
// A gate két dolgot ad: (1) max N egyidejű scrape-lap, (2) minden RECYCLE_AFTER
// scrape után — BIZTONSÁGOS ablakban, amikor egyedüli aktív scrape vagyunk — a
// böngésző teljes újraindítása, ami nullázza a felhalmozott Chromium-memóriát.
class ScrapeGate {
  constructor(controller, { max, recycleAfter, maxAgeMs }) {
    this._c = controller;
    this.max = Math.max(1, max);
    this.recycleAfter = Math.max(0, recycleAfter);
    // 2026-07-05: KOR-ALAPÚ recycle is — a scrape-számláló mellett a böngésző
    // életkora is küszöb (default 30 perc). Ritka-de-hosszú lapokkal (crawl,
    // FlareSolverr-render) a kúszó RSS scrape-count nélkül is felgyűlhet.
    this.maxAgeMs = Math.max(0, maxAgeMs || 0);
    this.active = 0;        // épp futó scrape-ek száma
    this.since = 0;         // scrape-ek száma a legutóbbi recycle óta
    this._waiters = [];     // permitre váró feloldók (FIFO)
  }
  _browserAged() {
    return !!(this.maxAgeMs && this._c.browser && this._c._browserLaunchTs &&
      (Date.now() - this._c._browserLaunchTs) > this.maxAgeMs);
  }
  async acquire() {
    if (this.active >= this.max) {
      await new Promise(res => this._waiters.push(res));
    }
    this.active++;
    // Recycle CSAK ha mi vagyunk az EGYETLEN aktív scrape (active===1) és
    // átléptük a scrape-count VAGY az életkor-küszöböt -> párhuzamos in-flight
    // scrape-et sose szakítunk meg. (Sustained max-terhelésnél a recycle a
    // következő lulire csúszik — az Echolot forgalma bursty, ezért ez a
    // gyakorlatban rendszeresen lefut. Idle-korosodást a watchdog fed le.)
    if (this.active === 1 &&
        ((this.recycleAfter && this.since >= this.recycleAfter) || this._browserAged())) {
      this.since = 0;
      try { await this._c._recycleBrowser(); } catch (e) { /* best-effort */ }
    }
  }
  release() {
    this.since++;
    this.active = Math.max(0, this.active - 1);
    const next = this._waiters.shift();
    if (next) next();
  }
}

// 2026-07-05: CIRCUIT BREAKER a scrape-sávra. Ha a böngésző-motor sorozatban
// hibázik (5 egymást követő browser-osztályú hiba), a breaker NYIT: minden
// hívó AZONNAL értelmes hibát kap ({error:"brave_down", retry_after:N})
// timeout-lógás helyett. 60 mp után half-open: EGYETLEN próbahívást enged át;
// siker → zár, hiba → újranyit. Csak browser-halál-osztályú hibákat számol
// (Protocol error / Target closed / navigation-hang) — egy-egy rossz URL
// (DNS-hiba, 404) NEM nyitja a breakert.
class CircuitBreaker {
  constructor({ threshold = 5, cooldownMs = 60000 } = {}) {
    this.threshold = Math.max(1, threshold);
    this.cooldownMs = Math.max(1000, cooldownMs);
    this.consecutiveFailures = 0;
    this.state = 'closed';        // closed | open | half_open
    this.openedAt = 0;
    this._probeInFlight = false;  // half-open: egyszerre csak 1 próbahívás
  }
  canPass() {
    if (this.state === 'closed') return true;
    if (this.state === 'open' && Date.now() - this.openedAt >= this.cooldownMs) {
      this.state = 'half_open';
    }
    if (this.state === 'half_open' && !this._probeInFlight) {
      this._probeInFlight = true;
      return true;
    }
    return false;
  }
  retryAfterSec() {
    const remaining = this.cooldownMs - (Date.now() - this.openedAt);
    return Math.max(1, Math.ceil(remaining / 1000));
  }
  recordSuccess() {
    this.consecutiveFailures = 0;
    this.state = 'closed';
    this._probeInFlight = false;
  }
  recordFailure() {
    this.consecutiveFailures++;
    this._probeInFlight = false;
    if (this.state === 'half_open' || this.consecutiveFailures >= this.threshold) {
      if (this.state !== 'open') {
        console.warn(`[breaker] NYIT — ${this.consecutiveFailures} egymást követő browser-hiba, ${Math.round(this.cooldownMs / 1000)}s cooldown`);
      }
      this.state = 'open';
      this.openedAt = Date.now();
    }
  }
}

export class BraveController {
  constructor() {
    this.browser = null;
    this._initPromise = null;   // ensureBrowser verseny-lock (egyszerre 1 launch)
    // 2026-07-01: IZOLÁLT INTERAKTÍV SÁV. A Brave MCP KÉT fogyasztót szolgál ki
    // EGY Chromiumon: (1) interaktív böngésző CLI-/web-Clausnak, (2) az Echolot
    // háttér-scrape-je. A régi getCurrentPage() a böngésző ÖSSZES lapja közül az
    // utolsót adta -> egy Echolot-scrape / YT-popup / target=_blank menet közben
    // "utolsó lap" lett, és a navigate/inspect/mouse arra ugrott (LAP-DRIFT). Fix:
    // az interaktív toolok saját BrowserContextben, egy KÖTÖTT lap-referencián
    // dolgoznak -> sose látják a scrape-sáv lapjait. A scrape-sáv változatlan.
    this._interactiveCtx = null;   // dedikált BrowserContext az interaktív agentnek
    this._interactivePage = null;  // kötött lap-referencia (NEM "utolsó lap")
    // Scrape-sáv fék (Echolot-terhelés → OOM ellen). Env-hangolható.
    // 2026-07-05: recycleAfter 60→50 (stabilizálási spec: max 50 scrape) +
    // kor-alapú küszöb (max 30 perc böngésző-élettartam).
    this._scrapeGate = new ScrapeGate(this, {
      max: parseInt(process.env.BRAVE_MAX_CONCURRENCY || '2', 10),
      recycleAfter: parseInt(process.env.BRAVE_RECYCLE_AFTER || '50', 10),
      maxAgeMs: parseInt(process.env.BRAVE_RECYCLE_MAX_AGE_MIN || '30', 10) * 60 * 1000,
    });
    // 2026-07-05: circuit breaker a scrape-sávra (5 hiba → 60s open → half-open).
    this._breaker = new CircuitBreaker({
      threshold: parseInt(process.env.BRAVE_BREAKER_THRESHOLD || '5', 10),
      cooldownMs: parseInt(process.env.BRAVE_BREAKER_COOLDOWN_MS || '60000', 10),
    });
    // Telemetria a /health-hez.
    this._browserLaunchTs = null;    // utolsó sikeres launch időpontja
    this._lastScrapeOkTs = null;     // utolsó SIKERES scrape időpontja
    this._scrapeOkCount = 0;
    this._scrapeFailCount = 0;
    this._launchFailures = 0;        // EGYMÁS UTÁNI launch-hibák (3 → exit(1))
    this._orphansKilled = 0;
    // 2026-07-05: watchdog — 60 mp-enként árva-chromium reap + idle kor-recycle.
    this._watchdog = null;
    if (process.env.BRAVE_WATCHDOG_DISABLED !== 'true') {
      this._startWatchdog();
    }
    this.turndownService = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-'
    });
    
    // Felesleges elemek eltávolítása
    this.turndownService.remove(['script', 'style', 'nav', 'footer', 'iframe']);
  }

  async initialize() {
    const bravePath = process.env.BRAVE_PATH || this.detectBravePath();

    let launched;
    try {
      launched = await this._launchBrowser(bravePath);
    } catch (e) {
      // 2026-07-05: 3 EGYMÁS UTÁNI launch-halál → a konténer menthetetlen
      // (törött profil / kifogyott erőforrás) → process.exit(1), a Railway
      // ON_FAILURE restart-policyja tiszta lappal indít újra.
      this._launchFailures++;
      console.error(`❌ Browser-launch hiba (${this._launchFailures}/3): ${e.message}`);
      if (this._launchFailures >= 3) {
        console.error('💀 3 egymás utáni browser-launch-halál — process.exit(1), a Railway tiszta lappal újraindít');
        process.exit(1);
      }
      throw e;
    }
    this._launchFailures = 0;
    this._browserLaunchTs = Date.now();
    this.browser = launched;

    // 2026-06-29: ha a Chromium meghal, a this.browser stale handle marad -> a
    // disconnected-handler nullázza, így a következő ensureBrowser() újraépíti
    // (zombi-szerver ellen). A `=== launched` guard: egy ÁRVA/régi böngésző
    // disconnect-je NE nullázza a frissen indítottat (verseny-védelem).
    launched.on('disconnected', () => {
      if (this.browser === launched) {
        this.browser = null;
        // A böngésző halálával a context+lap handle-ök is stale-ek -> nullázd,
        // hogy a getInteractivePage() friss böngészőn újraépítse őket.
        this._interactiveCtx = null;
        this._interactivePage = null;
      }
    });
  }

  _launchBrowser(bravePath) {
    return puppeteer.launch({
      executablePath: bravePath,
      headless: process.env.HEADLESS === 'true' ? 'new' : false,
      // Erősített launch — Cloudflare TLS-fingerprint + viselkedés-detektor
      // ellenére is átmenős. A StealthPlugin a Runtime-szintű leakeket fedi,
      // ezek a flag-ek a Chrome-szintű automatizáció-jeleket tüntetik el.
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-features=site-per-process,IsolateOrigins,AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-dev-shm-usage',
        '--disable-infobars',
        '--disable-extensions-except=',
        '--lang=en-US,en',
        '--window-size=1920,1080',
        '--start-maximized',
        '--enable-features=NetworkService,NetworkServiceInProcess',
      ]
    });
  }

  // 2026-06-29: STATEFUL navigáció a PERZISZTENS lapon (getCurrentPage).
  // A scrape eldobható lapot nyit+zár (lőj-és-felejts), ezért a vizuális/egér
  // toolok eddig egy üres about:blank lapot kaptak. Ez a tool a perzisztens
  // lapot viszi az URL-re és NYITVA hagyja → navigate → visual_inspect →
  // mouse_control mind ugyanazon a látható oldalon dolgozik.
  async navigate(url, options = {}) {
    url = this._normalizeUrl(url);
    // Az interaktív sáv KÖTÖTT lapja (nem "utolsó lap") -> nincs lap-drift.
    const page = await this.getInteractivePage();
    await page.goto(url, {
      waitUntil: options.waitUntil || 'domcontentloaded',
      timeout: options.timeout || 30000
    });
    const wait = options.waitTime ?? 2500;
    if (wait) await new Promise(r => setTimeout(r, wait));
    const screenshot = await page.screenshot({ encoding: 'base64' });
    let title = '';
    try { title = await page.title(); } catch (e) {}
    return {
      success: true,
      url: page.url(),
      title,
      screenshot: `data:image/png;base64,${screenshot}`
    };
  }

  // 2026-06-29: SET-OF-MARKS pillanatkép a perzisztens lapról. Kigyűjti a
  // kattintható elemeket (link/gomb), dedup href szerint, MÉRET szerint
  // rangsorol (nagy videó-thumbnailek elöl), számozott jelölőket rajzol, és
  // visszaadja a {n, label, x, y} térképet + a jelölt screenshotot. Így egy
  // kis modellnek nem pixelt kell becsülnie, csak SZÁMOT választania.
  async markedSnapshot(options = {}) {
    const max = options.max || 30;
    const page = await this.getInteractivePage();
    let elements = await page.evaluate(() => {
      const vw = window.innerWidth, vh = window.innerHeight;
      const seen = new Set();
      const out = [];
      const cands = Array.from(document.querySelectorAll(
        'a[href], button, [role="button"], [role="link"], input[type="submit"], input[type="button"]'
      ));
      for (const el of cands) {
        const rect = el.getBoundingClientRect();
        if (rect.width < 30 || rect.height < 15) continue;
        // teljesen viewporton kívül → kihagy
        if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) continue;
        // egész oldalt lefedő overlay → kihagy
        if (rect.width > vw * 0.97 && rect.height > vh * 0.85) continue;
        const cx = rect.x + rect.width / 2, cy = rect.y + rect.height / 2;
        if (cx < 0 || cx > vw || cy < 0 || cy > vh) continue;
        let label = (el.getAttribute('aria-label') || el.textContent || el.value || '')
          .replace(/\s+/g, ' ').trim();
        const href = el.getAttribute('href') || '';
        const key = href || label;
        if (!key) continue;
        if (label.length < 2 && !href) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ label: label.slice(0, 80), href,
          x: Math.round(cx), y: Math.round(cy),
          area: Math.round(rect.width * rect.height) });
      }
      return out;
    });
    // Azonos href-ű elemek összevonása (thumbnail + cím-link ugyanarra a videóra):
    // a kattintási pont a LEGNAGYOBB elem közepe, a címke a LEGHOSSZABB szöveg (= cím).
    const normHref = (h) => {
      const m = (h || '').match(/[?&]v=([\w-]+)/);
      return m ? 'v:' + m[1] : (h || '');
    };
    const groups = new Map();
    const singles = [];
    for (const e of elements) {
      if (e.href) {
        const k = normHref(e.href);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(e);
      } else {
        singles.push(e);
      }
    }
    const merged = [];
    for (const arr of groups.values()) {
      arr.sort((a, b) => b.area - a.area);
      const big = arr[0];
      const label = arr.map(x => x.label).filter(Boolean).sort((a, b) => b.length - a.length)[0] || big.label;
      merged.push({ label, href: big.href, x: big.x, y: big.y, area: big.area });
    }
    elements = merged.concat(singles);
    // méret szerint csökkenő (nagy thumbnailek elöl), majd limit
    elements.sort((a, b) => b.area - a.area);
    elements = elements.slice(0, max);
    // jelölők kirajzolása
    await page.evaluate((els) => {
      els.forEach((e, i) => {
        const m = document.createElement('div');
        m.className = 'som-marker';
        m.style.cssText = `position:fixed;left:${e.x - 16}px;top:${e.y - 13}px;` +
          `min-width:26px;height:24px;padding:0 4px;background:#ff0033;color:#fff;` +
          `border:2px solid #fff;border-radius:6px;display:flex;align-items:center;` +
          `justify-content:center;font:bold 15px sans-serif;z-index:2147483647;` +
          `pointer-events:none;box-shadow:0 0 5px #000;`;
        m.textContent = (i + 1);
        document.body.appendChild(m);
      });
    }, elements);
    const screenshot = await page.screenshot({ encoding: 'base64' });
    await page.evaluate(() => document.querySelectorAll('.som-marker').forEach(e => e.remove()));
    return {
      screenshot: `data:image/png;base64,${screenshot}`,
      elements: elements.map((e, i) => ({ n: i + 1, label: e.label, href: e.href, x: e.x, y: e.y })),
      count: elements.length
    };
  }

  detectBravePath() {
    // Platform-specifikus Brave útvonalak
    const paths = {
      win32: [
        'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
        'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe'
      ],
      darwin: [
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
      ],
      linux: [
        '/usr/bin/brave-browser',
        '/usr/bin/brave',
        '/snap/bin/brave'
      ]
    };

    const platformPaths = paths[process.platform] || paths.linux;
    
    for (const p of platformPaths) {
      try {
        const fs = require('fs');
        if (fs.existsSync(p)) {
          return p;
        }
      } catch (e) {}
    }
    
    throw new Error('Brave böngésző nem található. Állítsd be a BRAVE_PATH környezeti változót!');
  }

  async scrape(url, options = {}) {
    // ─── AUTO-FALLBACK ESCALATION CHAIN ─────────────────────────────────
    // options.auto_fallback === true esetén: a server intelligensen lépcsőzik
    // anti-bot védelem alapján. Az agent CSAK egyetlen flag-et ad meg, és a
    // server végigviszi a chain-t:
    //   1) default scrape (~5s)         — ha "JS required" / üres-stub →
    //   2) stealth scrape (~5-19s)      — ha blocked →
    //   3) Webclaw (~0.2-1s)            — wreq Chrome 142 TLS-impersonáció,
    //                                     DataDome/Turnstile-killer (NEM JS) →
    //   4) FlareSolverr (~30-90s)       — JS+CAPTCHA-combo fallback →
    //   5) FlareSolverr+render (~60s)   — FlareSolverr cookies+UA-val Puppeteer-render →
    //   6) Wayback Machine cache (~10s) → 7) Google AMP mirror (~10s)
    // A visszaadott payload tartalmazza az `escalation_path` mezőt — telemetria
    // a kliens (Bridge agent) számára.
    if (options.auto_fallback === true) {
      return await this._scrapeAutoEscalation(url, options);
    }

    // ─── FLARESOLVERR PATH — opt-in, 3. anti-bot szint ──────────────────
    // options.flaresolverr === true esetén: bypassoljuk a teljes Puppeteer
    // pipeline-t és a `FLARESOLVERR_URL` env-on futó FlareSolverr Docker-
    // szolgáltatáson keresztül scrape-elünk. Az ott futó undetected-
    // chromedriver a Cloudflare Turnstile-szintű falakat is megnyitja.
    // Csak akkor érdemes ha (a) FLARESOLVERR_URL set és (b) a stealth mode
    // is `blocked`-ot adott vagy nincs is bekapcsolva.
    if (options.flaresolverr === true) {
      if (!process.env.FLARESOLVERR_URL) {
        return {
          url,
          title: '',
          markdown: '',
          text: '',
          cf_status: 'flaresolverr_not_configured',
          error: 'FLARESOLVERR_URL environment variable is not set on the brave-mcp-server. Configure it in Railway env to enable the FlareSolverr fallback path.',
        };
      }
      return await this._scrapeViaFlareSolverr(url, options);
    }

    // ─── WEBCLAW PATH — opt-in, 7. anti-bot szint ───────────────────────
    // options.webclaw === true esetén: bypass Puppeteer és FlareSolverr,
    // a WEBCLAW_URL env-on futó Webclaw REST API-t hívjuk. A Webclaw wreq +
    // BoringSSL Chrome 142+ TLS-impersonációval szúr át DataDome JA4+
    // védelmen — Reuters/Bloomberg tier-3 cikkek is bejönnek <1s alatt
    // mobile proxy nélkül. Lokálisan ./webclaw/target/release/webclaw-server.
    if (options.webclaw === true) {
      if (!process.env.WEBCLAW_URL) {
        return {
          url,
          title: '',
          markdown: '',
          text: '',
          cf_status: 'webclaw_not_configured',
          error: 'WEBCLAW_URL environment variable is not set on the brave-mcp-server. Configure it (e.g. http://127.0.0.1:3000 lokálisan vagy Railway publikus URL) to enable the Webclaw L7 path.',
        };
      }
      return await this._scrapeViaWebclaw(url, options);
    }

    // ─── CIRCUIT BREAKER — 2026-07-05 ───────────────────────────────────
    // Ha a browser-motor sorozatban halott, NE várassuk a hívót timeout-ig:
    // azonnali, strukturált hiba retry_after-rel. A webclaw/flaresolverr
    // opt-in path-ok (fent) NEM browseresek, azokat a breaker nem érinti;
    // az auto_fallback chain L1/L2-je itt gyorsan hibázik és eszkalál tovább.
    if (!this._breaker.canPass()) {
      return {
        url,
        title: '',
        markdown: '',
        text: '',
        error: 'brave_down',
        retry_after: this._breaker.retryAfterSec(),
        cf_status: 'circuit_open',
        content_usable: false,
        block_reason: 'brave_down',
      };
    }

    // ─── SCRAPE-SÁV FÉK ─────────────────────────────────────────────────
    // Permit a concurrency-caphoz + esetleges böngésző-recycle biztonságos
    // ablakban. A newPage() a _scrapeOnce try-ján BELÜL nyílik -> ha dob, a
    // finally akkor is zárja a lapot, a külső finally pedig a permitet
    // (nincs szivárgás).
    await this._scrapeGate.acquire();
    try {
      // ─── RETRY — 2026-07-05: 2 újrapróbálkozás exponenciális backoffal ──
      // (1s, 4s). CSAK browser-halál-osztályú hibákra (Protocol error /
      // Target closed / disconnected) — ezek gyorsan buknak, és a következő
      // kísérlet ensureBrowser()-e friss böngészőt indít. Tartalmi/hálózati
      // hibát (DNS, 404, nav-timeout) NEM retry-zunk, az csak lassítana.
      const backoffs = [1000, 4000];
      let lastErr = null;
      for (let attempt = 0; attempt <= backoffs.length; attempt++) {
        try {
          const result = await this._scrapeOnce(url, options);
          this._breaker.recordSuccess();
          this._lastScrapeOkTs = Date.now();
          this._scrapeOkCount++;
          return result;
        } catch (e) {
          lastErr = e;
          if (attempt < backoffs.length && this._isTransientBrowserError(e)) {
            console.warn(`[retry] scrape browser-hiba (${attempt + 1}. kísérlet): ${e.message} — ${backoffs[attempt]}ms backoff`);
            await BraveController._sleep(backoffs[attempt]);
            continue;
          }
          break;
        }
      }
      this._scrapeFailCount++;
      // Breakerbe csak a browser-halál / hung-browser osztály számít.
      if (this._isBreakerCountableError(lastErr)) {
        this._breaker.recordFailure();
      }
      throw lastErr;
    } finally {
      this._scrapeGate.release();
    }
  }

  // Browser-halál-osztályú hiba: gyorsan bukik, retry-ra érdemes (a következő
  // ensureBrowser() friss Chromiumot indít).
  _isTransientBrowserError(err) {
    const m = String(err?.message || err || '');
    return /Protocol error|Target closed|Session closed|Connection closed|browser has disconnected|Browser is not connected|Navigating frame was detached|Browser closed/i.test(m);
  }

  // Breaker-countable: browser-halál VAGY navigation-hang (a zombi-böngésző
  // klasszikus tünete). Sima site-oldali hibák (DNS, ERR_CONNECTION_REFUSED)
  // NEM nyitják a breakert.
  _isBreakerCountableError(err) {
    if (this._isTransientBrowserError(err)) return true;
    const m = String(err?.message || err || '');
    return /Navigation timeout|TimeoutError|Timed out/i.test(m) || err?.name === 'TimeoutError';
  }

  // A tényleges Puppeteer-scrape — feltételezi, hogy a gate-permit már a miénk.
  async _scrapeOnce(url, options = {}) {
    // ─── STEALTH MODE — opt-in, opciós paraméter ────────────────────────
    // options.stealth === true esetén:
    //   • UA + viewport randomizáció (Chrome 120-122 variants)
    //   • Per-domain cookie-jar load/save (Cloudflare cf_clearance őrzés)
    //   • Cloudflare-challenge auto-resolve (8s wait + retry)
    //   • Bővített HTTP-headers
    // Default (stealth=false): a gyors, jelenlegi viselkedés — minimális
    // overhead. A statdata-jellegű JS-rendered forrásokra (Eurostat,
    // MNB, ECB, DBnomics) ez tökéletes, mert ott nincs anti-bot-fal.
    const stealthMode = options.stealth === true;

    let page;
    try {
      page = await this.newPage();
      // ─── MEMÓRIA-DIÉTA — 2026-07-05: kép/font/media/tracker blokkolás ──
      // CSAK a scrape-sávon, CSAK ha nem kell screenshot és nem stealth mód
      // (a CF-challenge-feloldásnak teljes erőforrás-készlet kellhet).
      // Az interaktív/vizuális sáv (getInteractivePage) ÉRINTETLEN.
      if (!stealthMode && !options.screenshot) {
        await this._applyScrapeDiet(page);
      }
      if (stealthMode) {
        // Random UA + viewport — Cloudflare TLS-fingerprint statisztikát megtöri.
        const ua = BraveController.UA_POOL[
          Math.floor(Math.random() * BraveController.UA_POOL.length)
        ];
        await page.setUserAgent(ua);
        await page.setViewport({
          width: 1366 + Math.floor(Math.random() * 200),
          height: 768 + Math.floor(Math.random() * 200),
        });
        // Extra fejlécek — egyes Cloudflare-fogadópontok ezeket figyelik.
        await page.setExtraHTTPHeaders({
          'Accept-Language': 'en-US,en;q=0.9,hu;q=0.8',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Upgrade-Insecure-Requests': '1',
        });
        // Per-domain cookie-jar load — Cloudflare cf_clearance és társai.
        // Egy korábban megnyert challenge ~30 perc – 2 óra élethosszú, így a
        // következő scrape-ek azonnal átmennek.
        await this._loadDomainCookies(page, url);
      } else {
        // Default fast-path UA — a meglévő viselkedés (statdata path)
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
      }

      // Navigálás
      await page.goto(url, {
        waitUntil: options.waitUntil || 'networkidle2',
        timeout: options.timeout || 30000
      });

      // Várakozás további tartalomra
      if (options.waitForSelector) {
        await page.waitForSelector(options.waitForSelector, { timeout: 10000 });
      }

      if (options.waitTime) {
        await BraveController._sleep(options.waitTime);
      }

      // ─── Cloudflare-challenge auto-resolve — CSAK STEALTH MODE-BAN ─────
      // Default módon a happy-path-ot semmi nem lassítja. Egyetlen retry,
      // max 6s nav-timeout → worst-case +14s per scrape (csak ha CF challenge
      // tényleg ott van). Konzervatív indikátor-lista a `_isCloudflareChallenge`
      // helperben — false-positive minimalizálva.
      let cfStatus = stealthMode ? 'none' : 'skipped';
      let html = await page.content();
      if (stealthMode && this._isCloudflareChallenge(html)) {
        cfStatus = 'attempt_1';
        console.log('[CF] Challenge detected, waiting 8s for auto-resolve...');
        // Kis emberi mozgás — Cloudflare behaviour-score-ját lendíti
        try {
          await page.mouse.move(
            300 + Math.random() * 400,
            200 + Math.random() * 400,
            { steps: 10 }
          );
        } catch (_) {}
        await BraveController._sleep(8000);
        try {
          await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 6000 });
        } catch (_) {
          // Nincs új navigáció — a content() újraolvasása viszont kötelező
        }
        html = await page.content();
        if (!this._isCloudflareChallenge(html)) {
          cfStatus = 'cleared_attempt_1';
          console.log('[CF] Challenge cleared on attempt 1');
        } else {
          cfStatus = 'blocked';
          console.log('[CF] Still blocked after 1 attempt');
        }
      }

      // Cookie-jar save — csak stealth módban, ha bármi clearance cookie
      // keletkezett. Default módban nem mentünk semmit.
      if (stealthMode) {
        await this._saveDomainCookies(page, url);
      }

      // Screenshot készítése ha kell
      let screenshot = null;
      if (options.screenshot) {
        screenshot = await page.screenshot({
          fullPage: true,
          encoding: 'base64'
        });
      }

      // Tartalom kinyerése (stealth retry már frissítette a html-t)
      const $ = cheerio.load(html);
      
      // Metadata gyűjtése
      const metadata = {
        title: $('title').text() || $('meta[property="og:title"]').attr('content'),
        description: $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content'),
        url: page.url(),
        language: $('html').attr('lang') || 'en',
        author: $('meta[name="author"]').attr('content'),
        publishedTime: $('meta[property="article:published_time"]').attr('content'),
        modifiedTime: $('meta[property="article:modified_time"]').attr('content')
      };

      // Tiszta szöveg és markdown
      const bodyHtml = $('body').html() || html;
      const markdown = this.turndownService.turndown(bodyHtml);
      const text = $('body').text().replace(/\s+/g, ' ').trim();

      // Linkek gyűjtése
      const links = [];
      $('a[href]').each((_, elem) => {
        const href = $(elem).attr('href');
        const text = $(elem).text().trim();
        if (href && !href.startsWith('#')) {
          links.push({
            href: new URL(href, url).href,
            text: text || 'No text'
          });
        }
      });

      const result = {
        url: page.url(),
        title: metadata.title,
        metadata,
        markdown,
        text,
        html: options.includeHtml ? html : undefined,
        links: options.includeLinks ? links : undefined,
        screenshot: screenshot ? `data:image/png;base64,${screenshot}` : undefined,
        // cf_status: 'none' | 'cleared_attempt_N' | 'blocked' — kliens-side telemetria
        cf_status: cfStatus,
      };
      // Content-flag dekorálás — content_usable + block_reason + markdown_warning
      return this._decorateContentFlags(result);

    } finally {
      // Lap-zárás MINDEN kimeneten (hiba esetén is). A scrape-lapok a default
      // BrowserContextben élnek — azt nem lehet/kell zárni, a page.close() a
      // teljes takarítás; a context-szintű nullázást a recycle végzi.
      if (page) { try { await page.close(); } catch (e) { /* recycle közben már zárt */ } }
    }
  }

  async crawl(startUrl, options = {}) {
    const { 
      maxPages = 10, 
      sameDomain = true,
      includePattern,
      excludePattern 
    } = options;

    const visited = new Set();
    const toVisit = [startUrl];
    const results = [];
    const startDomain = new URL(startUrl).hostname;

    while (toVisit.length > 0 && results.length < maxPages) {
      const url = toVisit.shift();
      
      if (visited.has(url)) continue;
      visited.add(url);

      // URL szűrés
      if (includePattern && !new RegExp(includePattern).test(url)) continue;
      if (excludePattern && new RegExp(excludePattern).test(url)) continue;
      
      try {
        console.error(`Crawling: ${url}`);
        const result = await this.scrape(url, { includeLinks: true });
        results.push(result);

        // Új linkek hozzáadása
        if (result.links) {
          for (const link of result.links) {
            const linkUrl = new URL(link.href);
            
            if (sameDomain && linkUrl.hostname !== startDomain) continue;
            if (!visited.has(link.href) && !toVisit.includes(link.href)) {
              toVisit.push(link.href);
            }
          }
        }
      } catch (error) {
        console.error(`Hiba ${url} crawl során: ${error.message}`);
      }
    }

    return {
      startUrl,
      crawledPages: results.length,
      results
    };
  }

  async search(query, options = {}) {
    // 2026-05-10 fix — search.brave.com Puppeteer-detektálja és Navigation timeout.
    // Mind a Brave-search-class-ok ('.snippet', '.snippet-title', stb.) elavultak.
    // Stabil fallback-chain: (1) Brave HTML — ha működik, (2) DuckDuckGo HTML — anti-bot-szelíd.
    const limit = options.limit || 10;
    const tries = [
      {
        name: 'brave',
        url: `https://search.brave.com/search?q=${encodeURIComponent(query)}`,
        timeout: 8000,
        // Új Brave HTML class-ok (data-testid alapú, 2026-os struktúra). Ha
        // a fő selector nem található, üres listával lépünk a következő engine-re.
        extractor: () => {
          const items = [];
          // Több selector-séma próbálása
          const containers = document.querySelectorAll(
            '[data-testid="web-result"], .snippet, [data-type="web"]'
          );
          containers.forEach(el => {
            const a = el.querySelector('a[href^="http"]');
            const titleEl = el.querySelector('h2, .title, .snippet-title');
            const descEl = el.querySelector('.snippet-description, .description, p');
            if (a && (titleEl || a.innerText)) {
              items.push({
                title: (titleEl ? titleEl.innerText : a.innerText).trim(),
                url: a.href,
                description: descEl ? descEl.innerText.trim() : '',
              });
            }
          });
          return items;
        },
      },
      {
        name: 'duckduckgo',
        url: `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
        timeout: 8000,
        // DDG HTML stabil — class="result__a" + class="result__snippet"
        extractor: () => {
          const items = [];
          document.querySelectorAll('.result').forEach(el => {
            const a = el.querySelector('a.result__a');
            const snippet = el.querySelector('.result__snippet');
            if (a) {
              let url = a.href;
              // DDG redirect-URL rendezés: /l/?uddg=https%3A%2F%2F...
              try {
                const u = new URL(url, 'https://duckduckgo.com');
                const real = u.searchParams.get('uddg');
                if (real) url = decodeURIComponent(real);
              } catch (_) {}
              items.push({
                title: a.innerText.trim(),
                url,
                description: snippet ? snippet.innerText.trim() : '',
              });
            }
          });
          return items;
        },
      },
    ];

    for (const engine of tries) {
      const page = await this.newPage();
      try {
        // Memória-diéta a search-lapokra is (nincs screenshot-igény).
        await this._applyScrapeDiet(page);
        await page.setUserAgent(
          'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
        );
        await page.goto(engine.url, { waitUntil: 'domcontentloaded', timeout: engine.timeout });
        // Adjunk a JS-nek esélyt
        await new Promise(r => setTimeout(r, 1500));
        const items = await page.evaluate(engine.extractor);
        if (items && items.length > 0) {
          return {
            query,
            engine: engine.name,
            results: items.slice(0, limit),
          };
        }
        // 0 találat → következő engine
      } catch (e) {
        // Engine timeout / hiba → következő engine
        console.log(`⚠️  search engine ${engine.name} failed: ${e.message}`);
      } finally {
        await page.close();
      }
    }

    // Egyik engine sem adott találatot
    return { query, engine: 'none', results: [], note: 'Egyetlen search-engine sem adott találatot — érdemes brave_scrape-pel direkt URL-t lehúzni.' };
  }

  async close() {
    // Idempotens + halott-handle-biztos: előbb nullázunk (a disconnected-handler
    // és párhuzamos ensureBrowser ne lásson félkész állapotot), a close() hibáját
    // záráskor nyeljük (egy már levált böngésző close()-a dobhat).
    if (this._watchdog) { clearInterval(this._watchdog); this._watchdog = null; }
    const b = this.browser;
    this.browser = null;
    this._initPromise = null;
    if (b) {
      try { await b.close(); } catch (e) { /* már halott/levált — záráskor irreleváns */ }
    }
  }

  async login(params) {
    const page = await this.newPage();
    
    try {
      // Human-like behavior
      await page.setViewport({
        width: 1366 + Math.floor(Math.random() * 100),
        height: 768 + Math.floor(Math.random() * 100)
      });
      
      // Random mouse movements
      await page.mouse.move(
        Math.random() * 1000,
        Math.random() * 700
      );
      
      // Site-specific login flows
      const loginConfigs = {
        gmail: {
          url: 'https://accounts.google.com',
          usernameSelector: 'input[type="email"]',
          passwordSelector: 'input[type="password"]',
          nextButtonSelector: '#identifierNext',
          submitSelector: '#passwordNext',
          waitForLogin: 'a[aria-label*="Google Account"]',
          steps: 'sequential' // username first, then password
        },
        facebook: {
          url: 'https://www.facebook.com',
          usernameSelector: 'input[name="email"]',
          passwordSelector: 'input[name="pass"]',
          submitSelector: 'button[name="login"]',
          waitForLogin: 'div[role="navigation"]',
          steps: 'simultaneous'
        },
        twitter: {
          url: 'https://twitter.com/login',
          usernameSelector: 'input[autocomplete="username"]',
          passwordSelector: 'input[type="password"]',
          nextButtonSelector: 'div[role="button"]:has-text("Next")',
          submitSelector: 'div[role="button"]:has-text("Log in")',
          waitForLogin: 'a[aria-label="Profile"]',
          steps: 'sequential'
        },
        linkedin: {
          url: 'https://www.linkedin.com/login',
          usernameSelector: 'input[id="username"]',
          passwordSelector: 'input[id="password"]',
          submitSelector: 'button[type="submit"]',
          waitForLogin: 'nav[role="navigation"]',
          steps: 'simultaneous'
        },
        instagram: {
          url: 'https://www.instagram.com/accounts/login/',
          usernameSelector: 'input[name="username"]',
          passwordSelector: 'input[type="password"]',
          submitSelector: 'button[type="submit"]',
          waitForLogin: 'svg[aria-label="Home"]',
          steps: 'simultaneous'
        }
      };

      const config = params.site === 'custom' 
        ? await this.detectLoginConfig(params.customUrl)
        : loginConfigs[params.site];

      if (!config) {
        throw new Error('Unsupported site or unable to detect login form');
      }

      // Navigate to login page
      await page.goto(params.site === 'custom' ? params.customUrl : config.url, {
        waitUntil: 'networkidle2'
      });

      // Human-like delay
      await this.humanDelay();

      // Execute login based on flow type
      if (config.steps === 'sequential') {
        // Gmail/Twitter style - username first
        await page.waitForSelector(config.usernameSelector, { visible: true });
        await page.click(config.usernameSelector);
        await this.humanType(page, config.usernameSelector, params.credentials.username);
        
        if (config.nextButtonSelector) {
          await page.click(config.nextButtonSelector);
          await page.waitForNavigation({ waitUntil: 'networkidle2' });
        }
        
        await page.waitForSelector(config.passwordSelector, { visible: true });
        await page.click(config.passwordSelector);
        await this.humanType(page, config.passwordSelector, params.credentials.password);
        await page.click(config.submitSelector);
        
      } else {
        // Facebook/LinkedIn style - both fields together
        await page.waitForSelector(config.usernameSelector, { visible: true });
        await page.click(config.usernameSelector);
        await this.humanType(page, config.usernameSelector, params.credentials.username);
        
        await page.click(config.passwordSelector);
        await this.humanType(page, config.passwordSelector, params.credentials.password);
        
        await this.humanDelay();
        await page.click(config.submitSelector);
      }

      // Wait for login to complete
      try {
        await page.waitForSelector(config.waitForLogin, { 
          visible: true, 
          timeout: 30000 
        });
      } catch (e) {
        // Check for 2FA
        const needs2FA = await this.check2FA(page);
        if (needs2FA && params.credentials.totp) {
          await this.handle2FA(page, params.credentials.totp);
          await page.waitForSelector(config.waitForLogin, { 
            visible: true, 
            timeout: 30000 
          });
        } else if (needs2FA) {
          throw new Error('2FA required but no TOTP code provided');
        } else {
          throw new Error('Login failed - could not verify successful login');
        }
      }

      // Save session if requested
      if (params.saveSession) {
        const cookies = await page.cookies();
        const sessionData = {
          site: params.site,
          cookies,
          userAgent: await page.evaluate(() => navigator.userAgent),
          timestamp: Date.now()
        };
        
        // Store in local file system
        const sessionPath = path.join(process.cwd(), '.sessions', `${params.site}_session.json`);
        await fs.mkdir(path.dirname(sessionPath), { recursive: true });
        await fs.writeFile(sessionPath, JSON.stringify(sessionData, null, 2));
      }

      // Get some proof of login
      const proof = await page.evaluate(() => {
        return {
          url: window.location.href,
          title: document.title,
          userName: document.querySelector('[data-testid="ProfileHeader_Name"]')?.textContent ||
                    document.querySelector('.userName')?.textContent ||
                    document.querySelector('[aria-label*="Account"]')?.textContent ||
                    'Logged in'
        };
      });

      return {
        success: true,
        site: params.site,
        proof,
        message: 'Successfully logged in',
        sessionSaved: params.saveSession
      };

    } catch (error) {
      // Take screenshot for debugging
      const screenshot = await page.screenshot({ encoding: 'base64' });
      
      return {
        success: false,
        error: error.message,
        screenshot: `data:image/png;base64,${screenshot}`,
        hint: 'Check the screenshot to see what went wrong'
      };
    } finally {
      await page.close();
    }
  }

  async detectLoginConfig(url) {
    // Intelligent login form detection for custom sites
    // 2026-07-05: page.close() try/finally-ba (dupla-close / hibaági szivárgás fix)
    const page = await this.newPage();
    try {
      await page.goto(url, { waitUntil: 'networkidle2' });
      
      const config = await page.evaluate(() => {
        // Find username field
        const usernameSelectors = [
          'input[type="email"]',
          'input[name="username"]',
          'input[name="email"]',
          'input[id="username"]',
          'input[placeholder*="email" i]',
          'input[placeholder*="username" i]'
        ];
        
        let usernameSelector = null;
        for (const selector of usernameSelectors) {
          if (document.querySelector(selector)) {
            usernameSelector = selector;
            break;
          }
        }

        // Find password field
        const passwordSelector = 'input[type="password"]';
        
        // Find submit button
        const submitSelectors = [
          'button[type="submit"]',
          'input[type="submit"]',
          'button:contains("Log in")',
          'button:contains("Sign in")',
          'button:contains("Login")'
        ];
        
        let submitSelector = null;
        for (const selector of submitSelectors) {
          try {
            if (document.querySelector(selector)) {
              submitSelector = selector;
              break;
            }
          } catch (e) {}
        }

        return {
          url: window.location.href,
          usernameSelector,
          passwordSelector,
          submitSelector,
          steps: 'simultaneous'
        };
      });
      
      return config;

    } catch (error) {
      return null;
    } finally {
      try { await page.close(); } catch (e) { /* már zárt */ }
    }
  }

  async humanDelay(min = 500, max = 2000) {
    const delay = min + Math.random() * (max - min);
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  async humanType(page, selector, text) {
    await page.focus(selector);
    for (const char of text) {
      await page.keyboard.type(char, { 
        delay: 50 + Math.random() * 100 
      });
      // Occasional pause
      if (Math.random() < 0.1) {
        await this.humanDelay(100, 300);
      }
    }
  }

  async check2FA(page) {
    const selectors = [
      'input[name="totp"]',
      'input[name="code"]',
      'input[placeholder*="code" i]',
      'input[placeholder*="2fa" i]',
      'input[aria-label*="code" i]'
    ];
    
    for (const selector of selectors) {
      if (await page.$(selector)) {
        return true;
      }
    }
    return false;
  }

  async handle2FA(page, code) {
    const selectors = [
      'input[name="totp"]',
      'input[name="code"]',
      'input[placeholder*="code" i]'
    ];
    
    for (const selector of selectors) {
      if (await page.$(selector)) {
        await page.click(selector);
        await this.humanType(page, selector, code);
        
        // Find and click submit
        const submitBtn = await page.$('button[type="submit"], button:contains("Verify")');
        if (submitBtn) {
          await submitBtn.click();
        }
        break;
      }
    }
  }

  async executeSessionAction(params) {
    // Load saved session
    const sessionPath = path.join(process.cwd(), '.sessions', `${params.site}_session.json`);

    // 2026-07-05: lap-leak fix — a page korábban CSAK a sikeres ágon záródott,
    // hiba esetén árván maradt (kúszó RSS). Most try/finally zárja mindig.
    let page = null;
    try {
      const sessionData = JSON.parse(await fs.readFile(sessionPath, 'utf-8'));

      if (Date.now() - sessionData.timestamp > 24 * 60 * 60 * 1000) {
        throw new Error('Session expired, please login again');
      }

      page = await this.newPage();
      
      // Restore session
      await page.setUserAgent(sessionData.userAgent);
      await page.setCookie(...sessionData.cookies);
      
      // Navigate to appropriate page based on action
      const actionConfigs = {
        gmail: {
          read_emails: async () => {
            await page.goto('https://mail.google.com', { waitUntil: 'networkidle2' });
            await page.waitForSelector('tr.zA', { timeout: 30000 });
            
            const emails = await page.evaluate(() => {
              const emailRows = document.querySelectorAll('tr.zA');
              return Array.from(emailRows).slice(0, 10).map(row => ({
                from: row.querySelector('.yW')?.textContent,
                subject: row.querySelector('.y6')?.textContent,
                snippet: row.querySelector('.y2')?.textContent,
                time: row.querySelector('.xW')?.textContent
              }));
            });
            
            return { emails };
          },
          send_email: async () => {
            await page.goto('https://mail.google.com', { waitUntil: 'networkidle2' });
            await page.click('.T-I.T-I-KE'); // Compose button
            
            await this.humanDelay();
            await page.type('input[name="to"]', params.parameters.to);
            await page.type('input[name="subjectbox"]', params.parameters.subject);
            await page.type('div[role="textbox"]', params.parameters.body);
            
            await page.keyboard.down('Control');
            await page.keyboard.press('Enter');
            await page.keyboard.up('Control');
            
            return { success: true, message: 'Email sent' };
          }
        },
        facebook: {
          get_messages: async () => {
            await page.goto('https://www.facebook.com/messages', { waitUntil: 'networkidle2' });
            // Facebook Messenger scraping logic
            return { messages: [] };
          },
          post_content: async () => {
            await page.goto('https://www.facebook.com', { waitUntil: 'networkidle2' });
            await page.click('[role="button"][aria-label*="What\'s on your mind"]');
            await this.humanDelay();
            await page.type('[role="textbox"]', params.parameters.content);
            await page.click('[aria-label="Post"]');
            return { success: true, message: 'Posted to Facebook' };
          }
        }
      };

      // Execute action
      let result;
      if (params.action === 'custom' && params.customScript) {
        result = await page.evaluate(params.customScript);
      } else if (actionConfigs[params.site] && actionConfigs[params.site][params.action]) {
        result = await actionConfigs[params.site][params.action]();
      } else {
        throw new Error(`Action ${params.action} not implemented for ${params.site}`);
      }

      return { success: true, data: result };

    } catch (error) {
      return {
        success: false,
        error: error.message,
        hint: 'You may need to login again'
      };
    } finally {
      if (page) { try { await page.close(); } catch (e) { /* már zárt */ } }
    }
  }

  async listSessions() {
    const sessionsDir = path.join(process.cwd(), '.sessions');
    
    try {
      const files = await fs.readdir(sessionsDir);
      const sessions = [];
      
      for (const file of files) {
        if (file.endsWith('_session.json')) {
          const sessionPath = path.join(sessionsDir, file);
          const sessionData = JSON.parse(await fs.readFile(sessionPath, 'utf-8'));
          
          sessions.push({
            site: sessionData.site,
            age: Date.now() - sessionData.timestamp,
            ageHuman: this.humanizeTime(Date.now() - sessionData.timestamp),
            expired: Date.now() - sessionData.timestamp > 24 * 60 * 60 * 1000,
            cookieCount: sessionData.cookies.length
          });
        }
      }
      
      return {
        sessions,
        total: sessions.length,
        active: sessions.filter(s => !s.expired).length,
        expired: sessions.filter(s => s.expired).length
      };
      
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { sessions: [], total: 0, active: 0, expired: 0 };
      }
      throw error;
    }
  }

  // Visual CAPTCHA handling
  async visualCaptcha(params) {
    const page = await this.getInteractivePage();
    
    if (params.action === 'capture') {
      // Teljes képernyőkép a CAPTCHA területről
      const screenshot = await page.screenshot({ 
        fullPage: false,
        encoding: 'base64' 
      });
      
      // Elemek pozíciójának meghatározása
      const elements = await page.evaluate(() => {
        const captcha = document.querySelector('.g-recaptcha, #captcha, [data-captcha], iframe[src*="recaptcha"], iframe[src*="captcha"]');
        const rect = captcha?.getBoundingClientRect();
        
        // Minden kattintható elem megkeresése
        const clickables = Array.from(document.querySelectorAll('img, button, div[role="button"], canvas, .captcha-image, [class*="captcha"]'))
          .filter(el => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          })
          .map(el => {
            const r = el.getBoundingClientRect();
            return {
              tag: el.tagName,
              classes: el.className,
              text: el.textContent?.trim() || el.alt || el.title || '',
              bounds: { 
                x: Math.round(r.x), 
                y: Math.round(r.y), 
                width: Math.round(r.width), 
                height: Math.round(r.height),
                centerX: Math.round(r.x + r.width/2),
                centerY: Math.round(r.y + r.height/2)
              }
            };
          });
        
        return {
          captchaArea: rect ? { 
            x: Math.round(rect.x), 
            y: Math.round(rect.y), 
            width: Math.round(rect.width), 
            height: Math.round(rect.height) 
          } : null,
          clickableElements: clickables,
          viewport: { 
            width: window.innerWidth, 
            height: window.innerHeight 
          },
          pageTitle: document.title
        };
      });
      
      return {
        screenshot: `data:image/png;base64,${screenshot}`,
        elements,
        hint: "Screenshot készült. Az elemek koordinátái megtalálhatók az 'elements' objektumban. Használd a brave_mouse_control tool-t a kattintáshoz!"
      };
    }
    
    if (params.action === 'click' && params.coordinates) {
      await this.humanMouseMove(page, params.coordinates.x, params.coordinates.y);
      await page.mouse.click(params.coordinates.x, params.coordinates.y);
      await this.humanDelay(500, 1000);
      
      // Screenshot a kattintás után
      const afterClick = await page.screenshot({ encoding: 'base64' });
      
      return { 
        success: true, 
        clicked: params.coordinates,
        screenshotAfter: `data:image/png;base64,${afterClick}`,
        message: `Kattintottam: x=${params.coordinates.x}, y=${params.coordinates.y}`
      };
    }
    
    if (params.action === 'type' && params.text) {
      // Először kattintsunk a beviteli mezőre ha van koordináta
      if (params.coordinates) {
        await page.mouse.click(params.coordinates.x, params.coordinates.y);
        await this.humanDelay(100, 300);
      }
      
      // Emberi gépelés szimuláció
      await this.humanType(page, null, params.text);
      
      return { 
        success: true, 
        typed: params.text,
        message: `Beírtam: "${params.text}"`
      };
    }
  }

  // Mouse control
  async mouseControl(params) {
    const page = await this.getInteractivePage();
    // 2026-07-01: URL-echo — minden művelet-válaszra rákerül a lap AKTUÁLIS url-je,
    // hogy egy esetleges drift (action.url ≠ navigate.url) azonnal detektálható/
    // riasztható legyen. Lustán értékel: a click UTÁNI navigáció is látszik.
    const echo = (o) => ({ ...o, url: page.url() });

    // Track mouse position
    await page.evaluateOnNewDocument(() => {
      window.mouseX = 0;
      window.mouseY = 0;
      document.addEventListener('mousemove', (e) => {
        window.mouseX = e.clientX;
        window.mouseY = e.clientY;
      });
    });
    
    switch (params.action) {
      case 'move':
        await this.humanMouseMove(page, params.x, params.y);
        return echo({ success: true, action: 'move', position: { x: params.x, y: params.y } });
        
      case 'click':
        await this.humanMouseMove(page, params.x, params.y);
        await this.humanDelay(100, 300);
        await page.mouse.click(params.x, params.y);
        return echo({ success: true, action: 'click', position: { x: params.x, y: params.y } });
        
      case 'doubleClick':
        await this.humanMouseMove(page, params.x, params.y);
        await page.mouse.click(params.x, params.y, { clickCount: 2 });
        return echo({ success: true, action: 'doubleClick', position: { x: params.x, y: params.y } });
        
      case 'rightClick':
        await this.humanMouseMove(page, params.x, params.y);
        await page.mouse.click(params.x, params.y, { button: 'right' });
        return echo({ success: true, action: 'rightClick', position: { x: params.x, y: params.y } });
        
      case 'drag':
        await this.humanMouseMove(page, params.x, params.y);
        await page.mouse.down();
        await this.humanMouseMove(page, params.targetX, params.targetY, params.duration || 1000);
        await page.mouse.up();
        return echo({
          success: true,
          action: 'drag',
          from: { x: params.x, y: params.y },
          to: { x: params.targetX, y: params.targetY }
        });
        
      case 'hover':
        await this.humanMouseMove(page, params.x, params.y);
        await this.humanDelay(params.duration || 1000, params.duration || 1500);
        return echo({ success: true, action: 'hover', position: { x: params.x, y: params.y } });
        
      case 'screenshot_with_cursor':
        // Rajzoljunk egy virtuális kurzort
        await page.evaluate((x, y) => {
          const cursor = document.createElement('div');
          cursor.style.position = 'fixed';
          cursor.style.left = x + 'px';
          cursor.style.top = y + 'px';
          cursor.style.width = '20px';
          cursor.style.height = '20px';
          cursor.style.backgroundColor = 'red';
          cursor.style.borderRadius = '50%';
          cursor.style.zIndex = '999999';
          cursor.style.pointerEvents = 'none';
          cursor.id = 'virtual-cursor';
          document.body.appendChild(cursor);
        }, params.x || 0, params.y || 0);
        
        const screenshot = await page.screenshot({ encoding: 'base64' });
        
        // Töröljük a virtuális kurzort
        await page.evaluate(() => {
          document.getElementById('virtual-cursor')?.remove();
        });
        
        return echo({
          screenshot: `data:image/png;base64,${screenshot}`,
          cursorPosition: { x: params.x || 0, y: params.y || 0 },
          hint: "Piros pont jelzi a kurzor pozíciót"
        });

      default:
        return echo({ success: false, error: 'Ismeretlen művelet' });
    }
  }

  // Visual element inspection
  async visualInspect(params) {
    const page = await this.getInteractivePage();
    // 2026-07-01: URL-echo — top-level `url` MINDEN mód válaszában, hogy a drift
    // (inspect.url ≠ navigate.url) azonnal látszódjon, ne csak a pageInfo mélyén.
    const echo = (o) => ({ url: page.url(), ...o });

    if (params.mode === 'full_analysis') {
      // Teljes oldal elemzés
      const analysis = await page.evaluate(() => {
        const elements = [];
        
        // Minden interaktív elem
        const selectors = [
          'button', 'a', 'input', 'select', 'textarea', 
          '[onclick]', '[role="button"]', '[role="link"]',
          '.btn', '.button', '[class*="button"]'
        ];
        
        const processedElements = new Set();
        
        selectors.forEach(selector => {
          document.querySelectorAll(selector).forEach(el => {
            if (processedElements.has(el)) return;
            processedElements.add(el);
            
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            const isVisible = rect.width > 0 && rect.height > 0 && 
                            style.display !== 'none' && 
                            style.visibility !== 'hidden' &&
                            style.opacity !== '0';
            
            if (isVisible) {
              elements.push({
                type: el.tagName.toLowerCase(),
                text: el.textContent?.trim() || el.value || el.placeholder || el.alt || '',
                ariaLabel: el.getAttribute('aria-label'),
                position: { 
                  x: Math.round(rect.x + rect.width/2), 
                  y: Math.round(rect.y + rect.height/2) 
                },
                bounds: {
                  x: Math.round(rect.x),
                  y: Math.round(rect.y),
                  width: Math.round(rect.width),
                  height: Math.round(rect.height)
                },
                style: {
                  backgroundColor: style.backgroundColor,
                  color: style.color,
                  fontSize: style.fontSize
                },
                clickable: true,
                href: el.href || null
              });
            }
          });
        });
        
        // Rendezés pozíció szerint (fentről le, balról jobbra)
        elements.sort((a, b) => {
          if (Math.abs(a.bounds.y - b.bounds.y) < 10) {
            return a.bounds.x - b.bounds.x;
          }
          return a.bounds.y - b.bounds.y;
        });
        
        return {
          elements,
          pageInfo: {
            title: document.title,
            url: window.location.href,
            scrollHeight: document.documentElement.scrollHeight,
            clientHeight: document.documentElement.clientHeight
          }
        };
      });
      
      const screenshot = await page.screenshot({ encoding: 'base64' });
      
      return echo({
        screenshot: `data:image/png;base64,${screenshot}`,
        interactiveElements: analysis.elements,
        pageInfo: analysis.pageInfo,
        totalElements: analysis.elements.length,
        hint: `Találtam ${analysis.elements.length} interaktív elemet. Használd a koordinátákat a brave_mouse_control tool-lal!`
      });
    }
    
    if (params.mode === 'find_element' && params.query) {
      // Elem keresése szöveg alapján
      const found = await page.evaluate((query) => {
        const normalizedQuery = query.toLowerCase().trim();
        const elements = Array.from(document.querySelectorAll('*'));
        const matches = [];
        
        elements.forEach(el => {
          const text = (el.textContent?.trim() || '').toLowerCase();
          const aria = (el.getAttribute('aria-label') || '').toLowerCase();
          const value = (el.value || '').toLowerCase();
          const placeholder = (el.placeholder || '').toLowerCase();
          const title = (el.title || '').toLowerCase();
          
          const isMatch = text.includes(normalizedQuery) || 
                         aria.includes(normalizedQuery) ||
                         value.includes(normalizedQuery) ||
                         placeholder.includes(normalizedQuery) ||
                         title.includes(normalizedQuery);
          
          if (isMatch && el.offsetWidth > 0 && el.offsetHeight > 0) {
            const rect = el.getBoundingClientRect();
            matches.push({
              text: el.textContent?.trim() || value || placeholder,
              type: el.tagName.toLowerCase(),
              center: { 
                x: Math.round(rect.x + rect.width/2), 
                y: Math.round(rect.y + rect.height/2) 
              },
              bounds: {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.round(rect.width),
                height: Math.round(rect.height)
              },
              matchedIn: text.includes(normalizedQuery) ? 'text' : 
                        aria.includes(normalizedQuery) ? 'aria-label' :
                        value.includes(normalizedQuery) ? 'value' :
                        placeholder.includes(normalizedQuery) ? 'placeholder' : 'title'
            });
          }
        });
        
        return matches;
      }, params.query);
      
      // Screenshot with highlighted matches
      if (found.length > 0) {
        // Highlight találatok
        await page.evaluate((matches) => {
          matches.forEach((match, index) => {
            const highlight = document.createElement('div');
            highlight.style.position = 'fixed';
            highlight.style.left = match.bounds.x + 'px';
            highlight.style.top = match.bounds.y + 'px';
            highlight.style.width = match.bounds.width + 'px';
            highlight.style.height = match.bounds.height + 'px';
            highlight.style.border = '3px solid red';
            highlight.style.backgroundColor = 'rgba(255,0,0,0.1)';
            highlight.style.zIndex = '999998';
            highlight.style.pointerEvents = 'none';
            highlight.className = 'search-highlight';
            
            const label = document.createElement('div');
            label.style.position = 'absolute';
            label.style.top = '-25px';
            label.style.left = '0';
            label.style.backgroundColor = 'red';
            label.style.color = 'white';
            label.style.padding = '2px 5px';
            label.style.fontSize = '12px';
            label.style.fontWeight = 'bold';
            label.textContent = `#${index + 1}`;
            
            highlight.appendChild(label);
            document.body.appendChild(highlight);
          });
        }, found);
        
        const screenshot = await page.screenshot({ encoding: 'base64' });
        
        // Tisztítás
        await page.evaluate(() => {
          document.querySelectorAll('.search-highlight').forEach(el => el.remove());
        });
        
        return echo({
          found: found.length,
          elements: found,
          screenshot: `data:image/png;base64,${screenshot}`,
          suggestion: `Találtam ${found.length} elemet "${params.query}" keresésre. ` +
                     `Az első elem (#1) koordinátái: x=${found[0].center.x}, y=${found[0].center.y}`
        });
      }
      
      return echo({
        found: 0,
        elements: [],
        message: `Nem találtam "${params.query}" szöveget tartalmazó elemet az oldalon.`
      });
    }
    
    if (params.mode === 'interactive_map') {
      // Interaktív térkép készítése
      const screenshot = await page.screenshot({ encoding: 'base64' });
      
      // Számozzuk meg az összes kattintható elemet
      const numbered = await page.evaluate(() => {
        const elements = [];
        let counter = 1;
        
        document.querySelectorAll('button, a, input, select, [onclick], [role="button"]').forEach(el => {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            // Szám hozzáadása
            const marker = document.createElement('div');
            marker.style.position = 'fixed';
            marker.style.left = (rect.x + rect.width/2 - 12) + 'px';
            marker.style.top = (rect.y + rect.height/2 - 12) + 'px';
            marker.style.width = '24px';
            marker.style.height = '24px';
            marker.style.backgroundColor = '#ff0000';
            marker.style.color = 'white';
            marker.style.borderRadius = '50%';
            marker.style.display = 'flex';
            marker.style.alignItems = 'center';
            marker.style.justifyContent = 'center';
            marker.style.fontSize = '12px';
            marker.style.fontWeight = 'bold';
            marker.style.zIndex = '999999';
            marker.style.pointerEvents = 'none';
            marker.className = 'element-marker';
            marker.textContent = counter;
            document.body.appendChild(marker);
            
            elements.push({
              number: counter,
              text: el.textContent?.trim() || el.value || '',
              type: el.tagName.toLowerCase(),
              center: {
                x: Math.round(rect.x + rect.width/2),
                y: Math.round(rect.y + rect.height/2)
              }
            });
            
            counter++;
          }
        });
        
        return elements;
      });
      
      const numberedScreenshot = await page.screenshot({ encoding: 'base64' });
      
      // Tisztítás
      await page.evaluate(() => {
        document.querySelectorAll('.element-marker').forEach(el => el.remove());
      });
      
      return echo({
        screenshot: `data:image/png;base64,${numberedScreenshot}`,
        elements: numbered,
        totalElements: numbered.length,
        hint: "Minden kattintható elem meg van számozva. Használd a számot vagy a koordinátákat a kattintáshoz!"
      });
    }
  }

  // Emberi egérmozgás szimuláció Bézier görbével
  async humanMouseMove(page, targetX, targetY, duration = 500) {
    const steps = Math.ceil(duration / 20);
    
    // Jelenlegi pozíció lekérése
    const currentPos = await page.evaluate(() => ({ 
      x: window.mouseX || 0, 
      y: window.mouseY || 0 
    })).catch(() => ({ x: 0, y: 0 }));
    
    // Kontroll pontok a Bézier görbéhez (természetes ív)
    const cp1x = currentPos.x + (targetX - currentPos.x) * 0.25 + (Math.random() - 0.5) * 50;
    const cp1y = currentPos.y + (targetY - currentPos.y) * 0.25 + (Math.random() - 0.5) * 50;
    const cp2x = currentPos.x + (targetX - currentPos.x) * 0.75 + (Math.random() - 0.5) * 50;
    const cp2y = currentPos.y + (targetY - currentPos.y) * 0.75 + (Math.random() - 0.5) * 50;
    
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      
      // Cubic Bézier görbe számítás
      const x = Math.pow(1-t, 3) * currentPos.x +
                3 * Math.pow(1-t, 2) * t * cp1x +
                3 * (1-t) * Math.pow(t, 2) * cp2x +
                Math.pow(t, 3) * targetX;
                
      const y = Math.pow(1-t, 3) * currentPos.y +
                3 * Math.pow(1-t, 2) * t * cp1y +
                3 * (1-t) * Math.pow(t, 2) * cp2y +
                Math.pow(t, 3) * targetY;
      
      // Kis random tremor emberi hatásért
      const tremor = i < steps ? 1 : 0; // Csak mozgás közben
      const finalX = x + (Math.random() - 0.5) * tremor;
      const finalY = y + (Math.random() - 0.5) * tremor;
      
      await page.mouse.move(finalX, finalY);
      
      // Update tracked position
      await page.evaluate((x, y) => {
        window.mouseX = x;
        window.mouseY = y;
      }, finalX, finalY).catch(() => {});
      
      await new Promise(r => setTimeout(r, 20));
    }
  }

  humanizeTime(ms) {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) return `${days} nap`;
    if (hours > 0) return `${hours} óra`;
    if (minutes > 0) return `${minutes} perc`;
    return `${seconds} másodperc`;
  }

  // 2026-06-29: ÖNGYÓGYÍTÁS. Ha nincs böngésző VAGY a kapcsolat megszakadt
  // (OOM-kill / Chromium-crash / snap profil-lock), a this.browser stale, nem-null
  // handle marad -> onnantól MINDEN hívás "Protocol error: Connection closed"-dal dől
  // (zombi szerver). Ez eldobja a stale handle-t és újat épít. Minden lap-nyitó út
  // ezen megy át (newPage / getCurrentPage / navigate).
  async ensureBrowser() {
    if (!this.browser || !this.browser.isConnected()) {
      // Verseny-lock: ha több egyidejű hívás látja nullnak/halottnak, MIND ugyanazt
      // az egy initialize()-t várja meg -> nem indul 2 böngésző (ami az árva-disconnect
      // -> érvényes nullázása churn-t okozná). A finally felszabadítja a következő ciklusra.
      this._initPromise ??= this.initialize().finally(() => { this._initPromise = null; });
      await this._initPromise;
    }
    return this.browser;
  }

  // 2026-07-01: teljes böngésző-újraindítás a kúszó Chromium-RSS nullázására.
  // Nullázza a handle-öket (browser + interaktív context/lap), lezárja a régi
  // böngészőt; a következő ensureBrowser() frisset indít. CSAK biztonságos
  // ablakban hívjuk (ScrapeGate: egyedüli aktív scrape) -> nem szakít meg mást.
  async _recycleBrowser() {
    const b = this.browser;
    if (!b) return;
    this.browser = null;
    this._interactiveCtx = null;
    this._interactivePage = null;
    try { await b.close(); } catch (e) { /* már halott — záráskor irreleváns */ }
  }

  // Minden új lap ezen át nyílik -> garantáltan él a böngésző.
  async newPage() {
    await this.ensureBrowser();
    return this.browser.newPage();
  }

  // ════════════════════════════════════════════════════════════════════
  //  MEMÓRIA-DIÉTA — 2026-07-05 (scrape-sáv request-blokkolás)
  // ════════════════════════════════════════════════════════════════════
  // Kép/font/media + analytics-tracker requestek blokkolása a scrape-lapokon.
  // A markdown/text-kinyeréshez ezek nem kellenek, viszont a Chromium RSS-ét
  // és a networkidle2-várakozást is jelentősen hizlalják. FIGYELEM: az
  // interaktív/vizuális sáv (visual_inspect / screenshot / set-of-marks) NEM
  // kapja meg — ott a képek kellenek.
  async _applyScrapeDiet(page) {
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      try {
        if (BraveController.DIET_BLOCKED_TYPES.has(req.resourceType()) ||
            BraveController.DIET_BLOCKED_HOSTS.some(p => req.url().includes(p))) {
          return req.abort();
        }
        return req.continue();
      } catch (e) {
        // már kezelt request / lap záródik — best effort
        try { req.continue(); } catch (_) {}
      }
    });
  }

  // ════════════════════════════════════════════════════════════════════
  //  WATCHDOG — 2026-07-05 (árva-Chromium reap + idle kor-recycle)
  // ════════════════════════════════════════════════════════════════════
  // 60 mp-enként: (1) az 5 percnél öregebb ÁRVA chromium-processzek SIGKILL —
  // a saját élő böngésző-fát (node leszármazottai + browser.process() fája)
  // SOHA nem lőjük; ráadásul csak automatizációs markerű processzeket
  // (--headless / --remote-debugging / puppeteer-profil) célzunk, így lokál
  // gépen a Kommandant saját desktop-Brave-je garantáltan védett.
  // (2) ha a böngésző kora > maxAge és épp NINCS aktív scrape → graceful
  // recycle (a gate-permit megfogásával, hogy in-flight scrape-et ne törjünk).
  _startWatchdog() {
    const intervalMs = parseInt(process.env.BRAVE_WATCHDOG_INTERVAL_MS || '60000', 10);
    this._watchdog = setInterval(() => {
      this._watchdogTick().catch(e => console.warn(`[watchdog] tick hiba: ${e.message}`));
    }, intervalMs);
    this._watchdog.unref(); // ne tartsa életben a processzt
  }

  async _watchdogTick() {
    // 1) árva chromium reap
    const maxAgeS = parseInt(process.env.BRAVE_ORPHAN_MAX_AGE_S || '300', 10);
    await this._reapOrphanChromium(maxAgeS);
    // 2) idle kor-recycle: terhelés alatt a ScrapeGate.acquire() intézi; ha
    // viszont nincs forgalom, itt fogunk permitet és biztonságos ablakban
    // (egyedüli permit-birtokosként) újraindítjuk az öreg böngészőt.
    if (this._scrapeGate._browserAged() && this._scrapeGate.active === 0) {
      await this._scrapeGate.acquire();
      try {
        if (this._scrapeGate.active === 1 && this._scrapeGate._browserAged()) {
          console.log('[watchdog] böngésző-életkor > küszöb, idle recycle');
          this._scrapeGate.since = 0;
          await this._recycleBrowser();
        }
      } finally {
        this._scrapeGate.release();
      }
    }
  }

  static async _listProcesses() {
    const { stdout } = await execFileP('ps', ['-eo', 'pid=,ppid=,etimes=,rss=,args=']);
    return stdout.split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .map(l => {
        const m = l.match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
        return m ? { pid: +m[1], ppid: +m[2], etimes: +m[3], rssKb: +m[4], args: m[5] } : null;
      })
      .filter(Boolean);
  }

  // Automatizált (puppeteer-indítású) chromium-processz felismerése. A sima
  // desktop-Brave (snap) NEM matchel — nincs headless/remote-debugging markere.
  static _isAutomationChromium(p) {
    if (!/(brave|chrome|chromium)/i.test(p.args)) return false;
    return /--headless|--remote-debugging-(port|pipe)|puppeteer_dev_chrome_profile|--user-data-dir=\/tmp/i.test(p.args);
  }

  _ownBrowserPid() {
    try { return this.browser?.process()?.pid ?? null; } catch (_) { return null; }
  }

  async _reapOrphanChromium(minAgeS) {
    let procs;
    try {
      procs = await BraveController._listProcesses();
    } catch (e) {
      return 0; // nincs ps (pl. minimál konténer) — watchdog e része kimarad
    }
    const byPid = new Map(procs.map(p => [p.pid, p]));
    const children = new Map();
    for (const p of procs) {
      if (!children.has(p.ppid)) children.set(p.ppid, []);
      children.get(p.ppid).push(p.pid);
    }
    // VÉDETT halmaz:
    //  (a) az ÉLŐ böngésző fő-PID-je + teljes leszármazott-fája,
    //  (b) a saját node-processzünk + FELMENŐI (wrapper shellek — a cmdline-juk
    //      tartalmazhat automation-marker stringet, mégsem chromiumok; a
    //      2026-07-05-ös lokál teszt bizonyította, hogy enélkül öngyilkosság
    //      lehet a vége).
    const protectedSet = new Set([process.pid]);
    let cur = byPid.get(process.pid);
    while (cur && cur.ppid > 0 && !protectedSet.has(cur.ppid)) {
      protectedSet.add(cur.ppid);
      cur = byPid.get(cur.ppid);
    }
    const ownPid = this._ownBrowserPid();
    if (ownPid) {
      const stack = [ownPid];
      while (stack.length) {
        const pid = stack.pop();
        if (protectedSet.has(pid)) continue;
        protectedSet.add(pid);
        for (const c of children.get(pid) || []) stack.push(c);
      }
    }
    // ÁRVA-kritérium: a szülő init/systemd (reparentelt), VAGY a szülő MI
    // vagyunk (konténerben a node a PID 1 → az árvák alánk reparentelődnek;
    // az élő böngészőt az (a) védi). Egy MÁSIK élő szerver-instance saját
    // böngészője így SOHA nem célpont — annak a szülője a másik node.
    const isOrphaned = (p) => {
      if (p.ppid === 1 || p.ppid === process.pid) return true;
      const parent = byPid.get(p.ppid);
      if (!parent) return true; // szülő már halott
      return /(^|\/)systemd(\s|$)|systemd --user|(^|\/)init(\s|$)/.test(parent.args);
    };
    let killed = 0;
    for (const p of procs) {
      if (!BraveController._isAutomationChromium(p)) continue;
      if (protectedSet.has(p.pid)) continue;
      if (p.etimes < minAgeS) continue;
      if (!isOrphaned(p)) continue;
      try {
        process.kill(p.pid, 'SIGKILL');
        killed++;
        console.warn(`[watchdog] árva chromium SIGKILL: pid=${p.pid} age=${p.etimes}s rss=${Math.round(p.rssKb / 1024)}MB`);
      } catch (_) { /* közben kimúlt */ }
    }
    if (killed) this._orphansKilled += killed;
    return killed;
  }

  // ════════════════════════════════════════════════════════════════════
  //  HEALTH-TELEMETRIA — 2026-07-05 (a /health endpoint táplálása)
  // ════════════════════════════════════════════════════════════════════
  getHealthStats() {
    return {
      browser_alive: !!(this.browser && this.browser.isConnected()),
      browser_age_s: this._browserLaunchTs
        ? Math.round((Date.now() - this._browserLaunchTs) / 1000) : null,
      last_successful_scrape: this._lastScrapeOkTs
        ? new Date(this._lastScrapeOkTs).toISOString() : null,
      scrape_ok_count: this._scrapeOkCount,
      scrape_fail_count: this._scrapeFailCount,
      scrapes_since_recycle: this._scrapeGate.since,
      active_scrapes: this._scrapeGate.active,
      max_concurrent_scrapes: this._scrapeGate.max,
      breaker: {
        state: this._breaker.state,
        consecutive_failures: this._breaker.consecutiveFailures,
        ...(this._breaker.state === 'open'
          ? { retry_after: this._breaker.retryAfterSec() } : {}),
      },
      launch_failures: this._launchFailures,
      orphans_killed: this._orphansKilled,
    };
  }

  // Chromium-processzek aggregált RSS-e (MB) + darabszám — /health-hez.
  // Csak az AUTOMATIZÁCIÓS (puppeteer-indítású) chromiumot számolja, hogy
  // lokál futáskor a desktop-Brave ne torzítsa a metrikát.
  async getChromiumStats() {
    try {
      const procs = await BraveController._listProcesses();
      const chromium = procs.filter(p => BraveController._isAutomationChromium(p));
      return {
        chromium_process_count: chromium.length,
        chromium_rss_mb: Math.round(chromium.reduce((s, p) => s + p.rssKb, 0) / 1024),
      };
    } catch (_) {
      return { chromium_process_count: null, chromium_rss_mb: null };
    }
  }

  async getCurrentPage() {
    await this.ensureBrowser();
    const pages = await this.browser.pages();
    return pages[pages.length - 1]; // Utolsó aktív oldal (LEGACY — scrape-sáv)
  }

  // 2026-07-01: az INTERAKTÍV sáv lapja. Saját BrowserContextben él, KÖTÖTT
  // referenciaként -> a navigate/inspect/mouse/marked_snapshot mind PONTOSAN ezt
  // a lapot célozza, függetlenül attól, hány lapot nyit közben az Echolot-scrape.
  // Öngyógyító: ha a böngésző/kontextus/lap meghalt, újraépíti (a stale handle-ök
  // nullázását a disconnected-handler végzi). Így a lap-drift STRUKTURÁLISAN
  // lehetetlen: nem "utolsó lapot" tippelünk, hanem a sajátunkat tartjuk kézben.
  async getInteractivePage() {
    await this.ensureBrowser();
    // Kontextus: dedikált, elkülönítve az alap (scrape) kontextustól.
    // createBrowserContext = izolált (incognito) context; a régebbi puppeteer
    // createIncognitoBrowserContext néven ismeri -> mindkettőre felkészülünk.
    if (!this._interactiveCtx) {
      this._interactiveCtx = this.browser.createBrowserContext
        ? await this.browser.createBrowserContext()
        : await this.browser.createIncognitoBrowserContext();
    }
    // Lap: kötött referencia. Ha bezárták/elszállt, nyiss frisset a SAJÁT contextben.
    if (!this._interactivePage || this._interactivePage.isClosed()) {
      this._interactivePage = await this._interactiveCtx.newPage();
    }
    try { await this._interactivePage.bringToFront(); } catch (e) {}
    return this._interactivePage;
  }

  // youtu.be/<id> -> youtube.com/watch?v=<id>: a cross-domain redirect headful
  // instance-on elhasal, a youtube.com-on belüli útvonalak viszont mennek.
  _normalizeUrl(url) {
    const m = (url || '').match(/^https?:\/\/(?:www\.)?youtu\.be\/([\w-]+)/i);
    return m ? `https://www.youtube.com/watch?v=${m[1]}` : url;
  }

  async clearSessions(site) {
    const sessionsDir = path.join(process.cwd(), '.sessions');

    try {
      if (site === 'all') {
        // Töröljük az összes session-t (login + cookie-jar)
        const files = await fs.readdir(sessionsDir);
        for (const file of files) {
          if (file.endsWith('_session.json') || file.startsWith('_cookies_')) {
            await fs.unlink(path.join(sessionsDir, file));
          }
        }
        return { success: true, message: 'Minden session + cookie-jar törölve' };
      } else {
        // Csak egy specifikus site session-jét töröljük
        const sessionPath = path.join(sessionsDir, `${site}_session.json`);
        await fs.unlink(sessionPath);
        return { success: true, message: `${site} session törölve` };
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        return { success: false, message: 'Nem található ilyen session' };
      }
      throw error;
    }
  }

  // ════════════════════════════════════════════════════════════════════
  //  CLOUDFLARE / ANTI-BOT FALLBACK HELPERS — 2026-05-12
  // ════════════════════════════════════════════════════════════════════

  // Per-domain cookie-jar — Cloudflare cf_clearance és társai. 30 perc – 2 óra
  // életű, mégis sokat segít: egy egyszer megnyert challenge után ~10x scrape
  // megy fenntartás nélkül a Stealth-pipeline-on.
  async _loadDomainCookies(page, url) {
    try {
      const domain = new URL(url).hostname;
      const cookiePath = path.join(process.cwd(), '.sessions', `_cookies_${domain}.json`);
      const data = await fs.readFile(cookiePath, 'utf-8').catch(() => null);
      if (!data) return false;
      const payload = JSON.parse(data);
      // 2 órán túli cookie-jart ne erőltessünk — cf_clearance amúgy is lejár
      const age = Date.now() - (payload.timestamp || 0);
      if (age > 2 * 60 * 60 * 1000) return false;
      if (Array.isArray(payload.cookies) && payload.cookies.length) {
        await page.setCookie(...payload.cookies);
        return true;
      }
    } catch (_) {
      // first-visit / corrupt — silent fall-through
    }
    return false;
  }

  async _saveDomainCookies(page, url) {
    try {
      const domain = new URL(url).hostname;
      const cookies = await page.cookies();
      if (!cookies || !cookies.length) return;
      const cookiePath = path.join(process.cwd(), '.sessions', `_cookies_${domain}.json`);
      await fs.mkdir(path.dirname(cookiePath), { recursive: true });
      await fs.writeFile(
        cookiePath,
        JSON.stringify({ domain, timestamp: Date.now(), cookies }, null, 2),
      );
    } catch (e) {
      console.warn(`[cookie-jar] save failed for ${url}: ${e.message}`);
    }
  }

  // HTML-pattern matcher: Cloudflare Just-a-moment / Turnstile / generic
  // anti-bot challenge oldalak felismerése. Konzervatív — csak akkor true,
  // ha biztos challenge-page, nem egy random "javascript" szóelőfordulás.
  _isCloudflareChallenge(html) {
    if (!html || typeof html !== 'string') return false;
    // Konzervatív indikátor-lista: csak olyan stringek, amik kizárólag aktív
    // CF challenge-page-en jelennek meg. "Cloudflare Ray ID" SZÁNDÉKOSAN
    // kimaradt — sok normál CF-protected oldal (statdata-jellegű) is mutatja
    // a footer-ben, de NINCS challenge → false positive lenne, és 14s extra
    // wait minden statdata-scrape-en. Lassítás-kockázatot kerüljük.
    const indicators = [
      'Just a moment',
      'cf-challenge',
      'challenge-platform',
      'cf_chl_opt',
      'Checking your browser before accessing',
      'unusual activity from your computer',
      'Please enable JavaScript and cookies to continue',
      'Verifying you are human',
      'Verify you are human',
    ];
    return indicators.some(s => html.includes(s));
  }

  static _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // ════════════════════════════════════════════════════════════════════
  //  FLARESOLVERR FALLBACK — 3. anti-bot szint (2026-05-12)
  // ════════════════════════════════════════════════════════════════════
  // A FlareSolverr egy önálló Docker-szolgáltatás (Railway-en külön service),
  // ami undetected-chromedriver-rel megy keresztül a Cloudflare Turnstile-on
  // és más magas-tier anti-bot pipeline-okon. A brave-mcp-server POST-ol egy
  // `cmd: request.get`-et és visszakapja a feloldott HTML-t + cookie-kat.
  //
  // Konfiguráció: FLARESOLVERR_URL env-vár (pl. http://flaresolverr.railway.internal:8191/v1)
  // FlareSolverr docker image: ghcr.io/flaresolverr/flaresolverr:latest
  async _scrapeViaFlareSolverr(url, options = {}) {
    const flaresolverrUrl = process.env.FLARESOLVERR_URL;
    const maxTimeout = Math.min(options.timeout || 60000, 120000);

    const payload = {
      cmd: 'request.get',
      url,
      maxTimeout,
    };

    let response;
    try {
      const resp = await fetch(flaresolverrUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        // FlareSolverr challenge-solve mérete: max ~90s, +20s buffer
        signal: AbortSignal.timeout(maxTimeout + 20000),
      });
      if (!resp.ok) {
        return {
          url,
          title: '',
          markdown: '',
          text: '',
          cf_status: 'flaresolverr_http_error',
          error: `FlareSolverr HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`,
        };
      }
      response = await resp.json();
    } catch (e) {
      return {
        url,
        title: '',
        markdown: '',
        text: '',
        cf_status: 'flaresolverr_network_error',
        error: `FlareSolverr unreachable: ${e.name}: ${e.message}`,
      };
    }

    if (response.status !== 'ok' || !response.solution) {
      return {
        url,
        title: '',
        markdown: '',
        text: '',
        cf_status: 'flaresolverr_solve_failed',
        error: `FlareSolverr returned status=${response.status}, message=${response.message || ''}`,
      };
    }

    const sol = response.solution;
    const html = sol.response || '';
    const $ = cheerio.load(html);
    const finalUrl = sol.url || url;

    // Metadata (ugyanaz a pattern mint a normál scrape-ben)
    const metadata = {
      title: $('title').text() || $('meta[property="og:title"]').attr('content'),
      description: $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content'),
      url: finalUrl,
      language: $('html').attr('lang') || 'en',
      author: $('meta[name="author"]').attr('content'),
      publishedTime: $('meta[property="article:published_time"]').attr('content'),
      modifiedTime: $('meta[property="article:modified_time"]').attr('content'),
      flaresolverr_user_agent: sol.userAgent,
    };

    const bodyHtml = $('body').html() || html;
    const markdown = this.turndownService.turndown(bodyHtml);
    const text = $('body').text().replace(/\s+/g, ' ').trim();

    // Persistáljuk a FlareSolverr cookie-kat is — ha sikerült az áttörés,
    // a clearance cookie ~30 perc – 2 óra ÉLŐ, és a következő scrape már
    // a sima stealth path-on is működhet vele.
    if (Array.isArray(sol.cookies) && sol.cookies.length) {
      try {
        const domain = new URL(finalUrl).hostname;
        const cookiePath = path.join(process.cwd(), '.sessions', `_cookies_${domain}.json`);
        await fs.mkdir(path.dirname(cookiePath), { recursive: true });
        await fs.writeFile(
          cookiePath,
          JSON.stringify({ domain, timestamp: Date.now(), cookies: sol.cookies, source: 'flaresolverr' }, null, 2),
        );
      } catch (_) {
        // silent fail
      }
    }

    const result = {
      url: finalUrl,
      title: metadata.title,
      metadata,
      markdown,
      text,
      html: options.includeHtml ? html : undefined,
      cf_status: 'via_flaresolverr',
      // Visszacsatoljuk a session-t — az auto-escalation chain
      // a 4. szinten (render-with-session) ezt használja.
      _flaresolverr_session: {
        cookies: sol.cookies || [],
        userAgent: sol.userAgent,
      },
    };
    return this._decorateContentFlags(result);
  }

  // ════════════════════════════════════════════════════════════════════
  //  WEBCLAW FALLBACK — 3. anti-bot szint (2026-05-12)
  // ════════════════════════════════════════════════════════════════════
  // Webclaw (0xMassi/webclaw) — Rust-alapú, wreq + BoringSSL TLS-impersonáció
  // Chrome 142+/Firefox 144+ profilokkal. JA4+ ujjlenyomatot tökéletesen
  // szimulál → DataDome / Cloudflare network-szintű védelmet ÁTSZÚR.
  //   - Nem futtat JS-t (statikus HTML scrape pure-network módban)
  //   - 0.2-1s/req (vs FlareSolverr 30-90s)
  //   - Reuters tier-3 + biddr Turnstile bizonyítottan átszúrhatóak
  //   - LICENC: AGPL-3.0 → privát/internal hívás OK, NE expose-old publikus API-ként
  //
  // Konfiguráció: WEBCLAW_URL env-vár (pl. http://127.0.0.1:3000 lokál, vagy
  // Railway publikus URL). Stateless REST API: POST /v1/scrape.
  async _scrapeViaWebclaw(url, options = {}) {
    const webclawUrl = process.env.WEBCLAW_URL;
    const timeoutMs = Math.min(options.timeout || 30000, 60000);

    const payload = {
      url,
      formats: ['markdown'],
      only_main_content: options.only_main_content !== false,
    };

    let response;
    try {
      const resp = await fetch(`${webclawUrl.replace(/\/+$/, '')}/v1/scrape`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!resp.ok) {
        return {
          url,
          title: '',
          markdown: '',
          text: '',
          cf_status: 'webclaw_http_error',
          error: `Webclaw HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`,
        };
      }
      response = await resp.json();
    } catch (e) {
      return {
        url,
        title: '',
        markdown: '',
        text: '',
        cf_status: 'webclaw_network_error',
        error: `Webclaw unreachable: ${e.name}: ${e.message}`,
      };
    }

    const markdown = response.markdown || '';
    const meta = response.metadata || {};
    const finalUrl = meta.url || response.url || url;

    // Plain-text származtatás a markdown-ból — link-stripping, image-removal,
    // whitespace-collapse. Az _evaluateContent stub-detektora ezt is megnézi.
    const text = markdown
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')         // images
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')       // links → link-text
      .replace(/[#*_>`~]/g, '')                       // markdown formatting
      .replace(/\s+/g, ' ')
      .trim();

    const result = {
      url: finalUrl,
      title: meta.title || '',
      metadata: {
        title: meta.title,
        description: meta.description,
        url: finalUrl,
        language: meta.language || 'en',
        author: meta.author,
        publishedTime: meta.published_time || meta.publishedTime,
        modifiedTime: meta.modified_time || meta.modifiedTime,
        webclaw_browser_profile: meta.browser_profile || 'chrome-default',
      },
      markdown,
      text,
      cf_status: 'via_webclaw',
      content_source: 'webclaw',
    };
    return this._decorateContentFlags(result);
  }

  // ════════════════════════════════════════════════════════════════════
  //  AUTO-FALLBACK ESCALATION CHAIN — 2026-05-12
  // ════════════════════════════════════════════════════════════════════
  // Az agent egyszeri hívással megkapja a leg-legmagasabb-tartalmú eredményt.
  // A chain a kliens által NEM láthatóan eszkalálódik. A `escalation_path`
  // mező transparens log: mely szintek lettek megpróbálva, melyik nyert.

  _isBlockedOrEmpty(result) {
    // Backwards-compatible boolean wrapper a régi callsite-okhoz.
    return !this._evaluateContent(result).usable;
  }

  // Új objektum-orientált detector: {usable, reason, markdown_len}.
  // A scrape()/escalation chain ezt használja, hogy a payload-ban
  // EGYÉRTELMŰ content_usable + block_reason mezőt adhasson vissza.
  _evaluateContent(result) {
    if (!result) {
      return { usable: false, reason: 'empty_response', markdown_len: 0 };
    }
    const md = result.markdown || result.text || '';
    const len = md.length;
    // Empty-response küszöb 500 chars (volt 200 — túl alacsony, 259-charos
    // FT-féle "Security Verification" stub-ok átengedtek false-positive-ként).
    if (!md || len < 500) {
      return { usable: false, reason: 'empty_response', markdown_len: len };
    }
    if (this._isCloudflareChallenge(md)) {
      return { usable: false, reason: 'cloudflare_challenge', markdown_len: len };
    }
    // CDN-/szerver-szintű "Security Verification" interstitial-ok (FT,
    // Akamai, Imperva) — a Webclaw HTTP 403-as választ kap a CDN edge-ről,
    // és a markdown ilyen kis stub: "Challenge Request ID ... Status Code 403"
    const cdnInterstitialPatterns = [
      'Security Verification',
      'Challenge Request ID',
      'Status Code 403',
      'Status Code 401',
      'Status Code 429',
      'Request blocked',
      'Access blocked',
    ];
    const mdInterstitial = md.slice(0, 800);
    if (cdnInterstitialPatterns.filter(s => mdInterstitial.includes(s)).length >= 2) {
      return { usable: false, reason: 'cdn_interstitial', markdown_len: len };
    }
    const jsPromptPatterns = [
      'Javascript is required for full functionality',
      'Please enable JavaScript',
      'enable-javascript.com',
      'Verify you are human',
      'unusual activity from your browser',
    ];
    // Két detektor:
    //   (a) Rövid markdown bárhol — a klasszikus eset
    //   (b) Hosszabb markdown DE a stub-szöveg az első 300 char-ban van —
    //       a biddr-szerű "JS required + sok nav-link" eset, ahol a stub
    //       a content TETEJÉN ül és a navigation-szöveg felfújja az md_len-t.
    const mdHead = md.slice(0, 300);
    if (
      (jsPromptPatterns.some(s => md.includes(s)) && len < 600) ||
      jsPromptPatterns.some(s => mdHead.includes(s))
    ) {
      return { usable: false, reason: 'js_required_stub', markdown_len: len };
    }
    // Paywall-banner: néha a cikkszöveg helyett bejelentkezési felületet
    // ad vissza a server. Két detektor:
    //   (a) Klasszikus "Subscribe to continue" + rövid md (< 800 chars)
    //   (b) Nav-felfújt paywall (FT, NYT, WSJ): a paywall-szöveg az első
    //       1500 char-ban van, de a teljes md hosszabb a sok nav-link miatt
    const paywallPatterns = [
      'Subscribe to continue reading',
      'Sign in to continue',
      'Please log in to continue',
      'To continue reading, subscribe',
      'Subscribe to unlock this article',
      'Subscribe to read',
      'Try unlimited access',
      'Subscribe for full access',
      'This article is for subscribers only',
      'Become a subscriber to read',
    ];
    const mdEarly = md.slice(0, 1500);
    if (
      (paywallPatterns.some(s => md.includes(s)) && len < 800) ||
      paywallPatterns.some(s => mdEarly.includes(s))
    ) {
      return { usable: false, reason: 'paywall_banner', markdown_len: len };
    }
    // Title-szintű paywall-stub: ha a title maga "Subscribe to ..." / "Sign in"
    // mintával kezdődik, az gyanús — a valódi cikkcím helyett a paywall-oldal
    // címét kaptuk.
    const title = (result.title || '').trim();
    if (/^(Subscribe to|Sign in|Log in to|Login to)/i.test(title) && len < 8000) {
      return { usable: false, reason: 'paywall_banner', markdown_len: len };
    }
    // Internet Archive / Wayback Machine saját splash + no-capture page-ek.
    // Ezek NEM a target-cikk tartalmát adják vissza — csak az archive saját
    // belépő-oldalát vagy "nincs ilyen capture" üzenetét.
    const waybackBlockers = [
      'Please enable JS and disable any ad blocker',
      'Hrm. The Wayback Machine has not archived',
      'Wayback Machine doesn\'t have that page archived',
      'Ask the publishers to restore access to',
      'Internet Archive AudioLive Music Archive',
      'Sorry, we\'re having a tough time loading',
    ];
    if (waybackBlockers.some(s => md.includes(s))) {
      return { usable: false, reason: 'wayback_no_capture', markdown_len: len };
    }
    return { usable: true, reason: null, markdown_len: len };
  }

  // Payload-builder: bármely scrape-result-hez hozzá ad content_usable +
  // block_reason mezőket. Stub-tartalom esetén a markdown-ra warning-flag
  // kerül, a title kiürítve hogy a kliens ne idézze tévedésből.
  _decorateContentFlags(result, override_reason = null) {
    if (!result) return result;
    const eval_ = this._evaluateContent(result);
    const decorated = { ...result };
    decorated.content_usable = eval_.usable;
    decorated.block_reason = override_reason || eval_.reason;
    if (!eval_.usable) {
      decorated.markdown_warning = 'CONTENT_STUB_DO_NOT_QUOTE';
      // Title-cleanup: ne maradjon a domain-név mint "title", mert
      // megtévesztő — az agent cikkcímként idézhetné.
      if (decorated.title && decorated.title.length < 60 &&
          !decorated.title.includes(' ')) {
        decorated.title = '';
      }
    }
    return decorated;
  }

  async _scrapeAutoEscalation(url, options = {}) {
    const escalation_path = [];
    let best = null;
    const baseOptions = { ...options };
    delete baseOptions.auto_fallback;
    delete baseOptions.stealth;
    delete baseOptions.flaresolverr;

    const trackBest = (r) => {
      if ((r?.markdown || '').length > (best?.markdown || '').length) best = r;
    };

    const finalize = (winning, lvl_path) => {
      const { _flaresolverr_session, ...clean } = winning || { url, markdown: '', text: '' };
      const decorated = this._decorateContentFlags(clean);
      return { ...decorated, escalation_path: lvl_path };
    };

    // ── Szint 1: default scrape (~5s) ──────────────────────────────────
    try {
      const r1 = await this.scrape(url, { ...baseOptions });
      const eval1 = this._evaluateContent(r1);
      escalation_path.push({ level: 1, mode: 'default',
        ok: eval1.usable, md_len: eval1.markdown_len,
        cf_status: r1?.cf_status, block_reason: eval1.reason });
      if (eval1.usable) return finalize(r1, escalation_path);
      trackBest(r1);
    } catch (e) {
      escalation_path.push({ level: 1, mode: 'default', error: e.message });
    }

    // ── Szint 2: stealth (~5-19s) ──────────────────────────────────────
    try {
      const r2 = await this.scrape(url, { ...baseOptions, stealth: true });
      const eval2 = this._evaluateContent(r2);
      escalation_path.push({ level: 2, mode: 'stealth',
        ok: eval2.usable, md_len: eval2.markdown_len,
        cf_status: r2?.cf_status, block_reason: eval2.reason });
      if (eval2.usable) return finalize(r2, escalation_path);
      trackBest(r2);
    } catch (e) {
      escalation_path.push({ level: 2, mode: 'stealth', error: e.message });
    }

    // ── Szint 3: Webclaw TLS-impersonáció (~0.2-1s) ────────────────────
    // wreq + BoringSSL Chrome 142+ JA4+ fingerprint. DataDome / Cloudflare
    // network-szintű védelmet átszúr JS-futtatás nélkül. Reuters tier-3 +
    // biddr Turnstile bizonyítottan átszúrhatóak. AGPL-3.0 → csak privát.
    // WEBCLAW_URL env-vár (lokál: http://127.0.0.1:3000, vagy Railway).
    if (process.env.WEBCLAW_URL) {
      try {
        const r3 = await this._scrapeViaWebclaw(url, baseOptions);
        const eval3 = this._evaluateContent(r3);
        escalation_path.push({ level: 3, mode: 'webclaw',
          ok: eval3.usable, md_len: eval3.markdown_len,
          cf_status: r3?.cf_status, block_reason: eval3.reason });
        if (eval3.usable) return finalize(r3, escalation_path);
        trackBest(r3);
      } catch (e) {
        escalation_path.push({ level: 3, mode: 'webclaw', error: e.message });
      }
    } else {
      escalation_path.push({ level: 3, mode: 'webclaw',
        skipped: 'WEBCLAW_URL not configured' });
    }

    // ── Szint 4: FlareSolverr direct (~30-90s) ─────────────────────────
    // Csak akkor jövünk ide, ha Webclaw (L3) nem oldotta meg — ami azt
    // jelenti, hogy az oldal JS-render-igényes vagy aktív CAPTCHA-t prezentál.
    let r4 = null;
    if (process.env.FLARESOLVERR_URL) {
      try {
        r4 = await this._scrapeViaFlareSolverr(url, baseOptions);
        const eval4 = this._evaluateContent(r4);
        escalation_path.push({ level: 4, mode: 'flaresolverr',
          ok: eval4.usable, md_len: eval4.markdown_len,
          cf_status: r4?.cf_status, block_reason: eval4.reason });
        if (eval4.usable) return finalize(r4, escalation_path);
        trackBest(r4);
      } catch (e) {
        escalation_path.push({ level: 4, mode: 'flaresolverr', error: e.message });
      }
    } else {
      escalation_path.push({ level: 4, mode: 'flaresolverr',
        skipped: 'FLARESOLVERR_URL not configured' });
    }

    // ── Szint 5: FlareSolverr session → Puppeteer-render ──────────────
    const session = r4?._flaresolverr_session;
    if (session && Array.isArray(session.cookies) && session.cookies.length) {
      try {
        const r5 = await this._renderWithFlareSolverrSession(url, session, baseOptions);
        const eval5 = this._evaluateContent(r5);
        escalation_path.push({ level: 5, mode: 'flaresolverr_render',
          ok: eval5.usable, md_len: eval5.markdown_len,
          cf_status: r5?.cf_status, block_reason: eval5.reason });
        if (eval5.usable) return finalize(r5, escalation_path);
        trackBest(r5);
      } catch (e) {
        escalation_path.push({ level: 5, mode: 'flaresolverr_render', error: e.message });
      }
    } else {
      escalation_path.push({ level: 5, mode: 'flaresolverr_render',
        skipped: 'no usable FlareSolverr session' });
    }

    // ── Szint 6: Wayback Machine cache (anti-bot-mentes) ──────────────
    // A `archive.org/wayback/available` JSON-API megmondja a legközelebbi
    // valódi cache-URL-t (nem a self-redirect /web/<url>-t, ami a homepage-re
    // mehet). Ezt scrape-eljük aztán a default módban.
    try {
      const r6 = await this._scrapeViaWaybackMachine(url, baseOptions);
      const eval6 = this._evaluateContent(r6);
      escalation_path.push({ level: 6, mode: 'wayback_machine',
        ok: eval6.usable, md_len: eval6.markdown_len, block_reason: eval6.reason });
      if (eval6.usable) {
        return finalize(r6, escalation_path);
      }
      trackBest(r6);
    } catch (e) {
      escalation_path.push({ level: 6, mode: 'wayback_machine', error: e.message });
    }

    // ── Szint 7: Google AMP mirror ─────────────────────────────────────
    // Az AMP-verzió sok mainstream news-cikknél elérhető és nincs paywall.
    // A google.com/amp/s/<host>/<path> trükkel a Google-cache-AMP-renderét
    // hívjuk. Sokszor utolsó cseppet ad a Reuters / Bloomberg / FT cikkekhez.
    try {
      const u = new URL(url);
      const ampUrl = `https://www.google.com/amp/s/${u.host}${u.pathname}${u.search}`;
      const r7 = await this.scrape(ampUrl, { ...baseOptions, stealth: true });
      const eval7 = this._evaluateContent(r7);
      escalation_path.push({ level: 7, mode: 'google_amp',
        ok: eval7.usable, md_len: eval7.markdown_len, block_reason: eval7.reason });
      if (eval7.usable) {
        const r7fin = { ...r7, url, original_scrape_url: ampUrl, content_source: 'google_amp' };
        return finalize(r7fin, escalation_path);
      }
      trackBest(r7);
    } catch (e) {
      escalation_path.push({ level: 7, mode: 'google_amp', error: e.message });
    }

    // ── Minden szint blocked ───────────────────────────────────────────
    const failed = best || { url, markdown: '', text: '', cf_status: 'all_levels_blocked' };
    const { _flaresolverr_session, ...clean } = failed;
    return {
      ...this._decorateContentFlags(clean, 'all_levels_blocked'),
      cf_status: 'all_levels_blocked',
      escalation_path,
    };
  }

  // Wayback Machine via official JSON-API. Robosztusabb mint a /web/<url>
  // self-redirect, mert a `closest.url` GARANTÁLTAN valódi cache-snapshot URL.
  // HA nincs cache → `available: false`, és visszaadunk egy üres-eredményt
  // a megfelelő block_reason-nel.
  async _scrapeViaWaybackMachine(url, options = {}) {
    let availableUrl = null;
    try {
      const apiUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`;
      const resp = await fetch(apiUrl, {
        method: 'GET',
        signal: AbortSignal.timeout(15000),
      });
      if (resp.ok) {
        const data = await resp.json();
        const closest = data?.archived_snapshots?.closest;
        if (closest?.available && closest.status === '200' && closest.url) {
          availableUrl = closest.url;
        }
      }
    } catch (_) {
      // hálózati hiba — visszaesés
    }
    if (!availableUrl) {
      return {
        url,
        title: '',
        markdown: '',
        text: '',
        cf_status: 'wayback_no_capture',
        content_source: 'wayback_machine',
      };
    }
    // Scrape-eljük a tényleges Wayback-cache-URL-t a default scrape-pel.
    // A Wayback cache-page anti-bot-mentes, gyors.
    const r = await this.scrape(availableUrl, { ...options });
    return {
      ...r,
      url, // eredeti URL, a kliensnek ez a hivatkozás
      original_scrape_url: availableUrl,
      content_source: 'wayback_machine',
    };
  }

  async _renderWithFlareSolverrSession(url, session, options = {}) {
    const page = await this.newPage();
    try {
      // Pontos UA + cookies átadás a FlareSolverr session-ből.
      if (session.userAgent) {
        await page.setUserAgent(session.userAgent);
      }
      await page.setViewport({ width: 1920, height: 1080 });
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      });

      // FlareSolverr cookies átadása. A puppeteer setCookie a domain-t
      // megkívánja — ha hiányzik, az URL hostnévből pótoljuk.
      const hostname = new URL(url).hostname;
      const cookies = session.cookies
        .filter(c => c && c.name && c.value !== undefined)
        .map(c => ({
          name: c.name,
          value: String(c.value),
          domain: c.domain || hostname,
          path: c.path || '/',
          expires: typeof c.expires === 'number' ? c.expires : -1,
          httpOnly: !!c.httpOnly,
          secure: !!c.secure,
          sameSite: c.sameSite || 'Lax',
        }));
      if (cookies.length) {
        await page.setCookie(...cookies);
      }

      await page.goto(url, {
        waitUntil: options.waitUntil || 'networkidle2',
        timeout: options.timeout || 45000,
      });
      const waitMs = Math.min(Math.max(options.waitTime || 5000, 3000), 15000);
      await BraveController._sleep(waitMs);

      let screenshot = null;
      if (options.screenshot) {
        screenshot = await page.screenshot({ fullPage: true, encoding: 'base64' });
      }

      const html = await page.content();
      const $ = cheerio.load(html);
      const metadata = {
        title: $('title').text() || $('meta[property="og:title"]').attr('content'),
        description: $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content'),
        url: page.url(),
        language: $('html').attr('lang') || 'en',
      };
      const bodyHtml = $('body').html() || html;
      const markdown = this.turndownService.turndown(bodyHtml);
      const text = $('body').text().replace(/\s+/g, ' ').trim();

      const result = {
        url: page.url(),
        title: metadata.title,
        metadata,
        markdown,
        text,
        html: options.includeHtml ? html : undefined,
        screenshot: screenshot ? `data:image/png;base64,${screenshot}` : undefined,
        cf_status: 'via_flaresolverr_render',
      };
      return this._decorateContentFlags(result);
    } finally {
      await page.close();
    }
  }
}

// Memória-diéta: blokkolt erőforrás-típusok + analytics/tracker hostok a
// SCRAPE-sávon (a vizuális/interaktív sáv sosem kapja meg). A stylesheet
// SZÁNDÉKOSAN nincs blokkolva — némely oldal JS-e CSS-load-ra vár.
BraveController.DIET_BLOCKED_TYPES = new Set(['image', 'font', 'media']);
BraveController.DIET_BLOCKED_HOSTS = [
  'google-analytics.com',
  'googletagmanager.com',
  'googlesyndication.com',
  'adservice.google.',
  'doubleclick.net',
  'connect.facebook.net',
  'facebook.com/tr',
  'hotjar.com',
  'segment.io',
  'segment.com',
  'mixpanel.com',
  'scorecardresearch.com',
  'chartbeat.com',
  'gemius.pl',
  'amazon-adsystem.com',
  'criteo.com',
  'criteo.net',
  'taboola.com',
  'outbrain.com',
  'newrelic.com',
  'nr-data.net',
];

// User-Agent pool — Chrome 120-122 desktop variants (Win/Mac/Linux). A scrape()
// minden hívásnál véletlenszerűt választ → a TLS-fingerprint statisztika nem
// detektálható "always-same-bot"-ként.
BraveController.UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
];