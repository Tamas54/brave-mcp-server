// TF-evasions — a tf-playwright-stealth fork ÚJ evasion-javításainak átvétele
// a brave-mcp stealth-rétegébe (2026-10-07, TINYFISH PARITY 2.9).
//
// Kapcsoló: STEALTH_TF_EVASIONS=1 (alapból KI). A processz indulásakor olvassuk
// (a puppeteer-extra pluginlánc a modul betöltésekor áll össze) — A/B-hoz és
// fokozatos élesítéshez újraindítás kell, futás közbeni átkapcsolás nincs.
//
// MI KERÜLT ÁT (és mi NEM) — részletesen: /THIRD_PARTY_NOTICES.md és
// ~/recon/tinyfish/STEALTH_AB.md. Röviden:
//   * A fork JS-javításainak döntő része (utils, iframe.contentWindow,
//     navigator.plugins/mimeTypes, permissions, chrome.loadTimes/csi,
//     outerdimensions, media.codecs) a puppeteer-extra-plugin-stealth
//     2.11.2-ből van visszaportolva — azt a brave-mcp eddig is futtatta.
//     Újra felrakni dupla Proxyt jelentene, ezért NEM.
//   * A 3 visszalépés (navigator.webdriver `delete`, feltétel nélküli
//     `window.chrome = {runtime:{}}`, `hasPlugins = false`) NEM.
//   * ÁT: a fork persona-koncepciója (UA ↔ platform ↔ UA-CH ↔ nyelv ↔ WebGL
//     egy forrásból) — CDP-n, a fork hibái nélkül (persona.js), és a fork
//     utils.js + webgl.vendor.js-e szó szerint (vendor/), persona-értékekkel.
//   * A persona miatt a puppeteer-extra 4 evasionjét KIKAPCSOLJUK (ugyanazt a
//     felületet írnák felül, ellentmondóan): user-agent-override (elavult
//     GREASE, „Google Chrome" márka Brave alatt is), navigator.languages és
//     navigator.hardwareConcurrency (csak a FŐ szálon hazudnak → a worker
//     natív értéke ellentmond — mérve), webgl.vendor (macOS-sztring minden OS-en).
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { buildPersona, brandFor, parseLanguages, hostOS } from './persona.js';
import { buildPageScript } from './page-script.js';

const require = createRequire(import.meta.url);
const { PuppeteerExtraPlugin } = require('puppeteer-extra-plugin');

export const TF_SUPERSEDED_PE_EVASIONS = Object.freeze([
  'user-agent-override',
  'navigator.languages',
  'navigator.hardwareConcurrency',
  'webgl.vendor',
]);

export function tfEvasionsEnabled(env = process.env) {
  return /^(1|true|on|yes)$/i.test(String(env.STEALTH_TF_EVASIONS || '').trim());
}

export function tfConfig(env = process.env) {
  const languages = parseLanguages(env.STEALTH_TF_LANGUAGES || 'en-US,en');
  return {
    enabled: tfEvasionsEnabled(env),
    // Az alapértékek a MÉRT legjobb kombináció (~/recon/tinyfish/STEALTH_AB.md,
    // 2026-10-07): 'host' + 'native'. A fork szó szerinti viselkedése ('ua' +
    // 'mask') env-vel választható.
    //   'host' — a persona OS-e a gazdagépé: a worker navigator.platform-ja
    //            (CDP-vel nem írható felül) így nem mond ellent (mérve);
    //   'ua'   — a kért UA OS-e (Windows-default, stealth-pool).
    osMode: String(env.STEALTH_TF_PERSONA_OS || '').trim() === 'ua' ? 'ua' : 'host',
    languages: languages.length ? languages : ['en-US', 'en'],
    //   'native' — nincs WebGL-hamisítás: a worker/OffscreenCanvas úgyis natívat
    //              ad, a fő szál ↔ worker ellentmondás maga is jel (mérve:
    //              deviceandbrowserinfo BOT→ember, creepjs stealth 80→60%);
    //   'mask'   — a fork webgl.vendor evasionje persona-értékekkel (fő szál).
    webgl: String(env.STEALTH_TF_WEBGL || '').trim() === 'mask' ? 'mask' : 'native',
  };
}

// /health-hez: hálózati hívás nélkül mondja ki a kapcsoló állapotát.
export function tfHealth(env = process.env) {
  const c = tfConfig(env);
  return c.enabled
    ? { enabled: true, persona_os: c.osMode, webgl: c.webgl, languages: c.languages, superseded_pe_evasions: [...TF_SUPERSEDED_PE_EVASIONS] }
    : { enabled: false };
}

// A puppeteer-extra stealth-plugin példányából kiveszi a TF által
// felváltott evasionöket. A use() ELŐTT kell hívni.
export function pruneSupersededEvasions(stealthPlugin) {
  for (const e of TF_SUPERSEDED_PE_EVASIONS) stealthPlugin.enabledEvasions.delete(e);
  return stealthPlugin;
}

// böngésző → { version, brand } (egyszer kérdezzük le böngészőnként).
const _browserInfo = new WeakMap();
async function browserInfo(browser) {
  let info = _browserInfo.get(browser);
  if (info) return info;
  let version = '';
  try { version = await browser.version(); } catch (_) { /* régi/halott böngésző */ }
  let exe = process.env.BRAVE_PATH || '';
  try { exe = browser.process()?.spawnfile || exe; } catch (_) { /* connect()-elt böngésző */ }
  info = { version, brand: brandFor(exe) };
  _browserInfo.set(browser, info);
  return info;
}

// A scrape-sáv által kért (explicit) persona lapra. Ha a plugin onPageCreated-je
// később ér be, ezt küldi újra — így a kért OS nem vész el (verseny-védelem).
const _explicit = new WeakMap();

async function sendPersona(page, p) {
  const o = { userAgent: p.userAgent, acceptLanguage: p.acceptLanguage, platform: p.platform, userAgentMetadata: p.userAgentMetadata };
  const client = typeof page._client === 'function' ? page._client() : null;
  if (client) await client.send('Network.setUserAgentOverride', o);
  else await page.setUserAgent(o.userAgent, o.userAgentMetadata);
}

export async function personaFor(page, uaHint, env = process.env) {
  const cfg = tfConfig(env);
  const info = await browserInfo(page.browser());
  return buildPersona({ uaHint, browserVersion: info.version, brand: info.brand, languages: cfg.languages, osMode: cfg.osMode });
}

// A scrape-sáv belépési pontja (a page.setUserAgent HELYETT, ha a kapcsoló be):
// a setUserAgent metadata nélkül a UA-CH-t KIÜRÍTI (brands: [], platform: '')
// és a navigator.platform a gazdagépé marad — mérve, ez volt a legtöbb jel.
export async function applyTfPersona(page, { uaHint, env = process.env } = {}) {
  const persona = await personaFor(page, uaHint, env);
  _explicit.set(page, persona);
  await sendPersona(page, persona);
  return persona;
}

// A bináris főverziója INDÍTÁS ELŐTT (`<exe> --version`: „Brave Browser
// 154.1.96.61" / „Google Chrome 154.0.8037.57" — a Brave-nél is az első szám a
// Chromium-főverzió). Útvonalanként egyszer; hibánál null (a flag kimarad).
const _exeMajor = new Map();
export function exeMajorVersion(exe) {
  if (!exe) return null;
  if (_exeMajor.has(exe)) return _exeMajor.get(exe);
  let major = null;
  try {
    const out = execFileSync(exe, ['--version'], { timeout: 8000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = String(out).match(/(\d+)\.\d+(\.\d+)*/);
    if (m) major = m[1];
  } catch (_) { /* nincs/lassú bináris → a --user-agent kimarad */ }
  _exeMajor.set(exe, major);
  return major;
}

// Az indítási argumentumok TF-igazítása (tiszta függvény, tesztelhető).
//   * --lang / --accept-lang: a nyelv a böngésző EGÉSZÉBEN (fő szál, worker,
//     fejléc) ugyanaz. A régi '--lang=en-US,en' nem érvényes locale → a
//     gazdagép LANG-ja szivárgott (mérve: hu-HU a workerben és a fejlécben).
//   * --user-agent: a böngésző ALAP-UA-ja a persona UA-ja — a lap-szintű CDP-
//     felülírás a service workerre nem hat, ott „HeadlessChrome/154" maradt
//     (creepjs hasHeadlessWorkerUA — mérve).
//   * env LANG/LANGUAGE/LC_ALL: az Intl-locale is a persona nyelve.
export function tfLaunchOptions(options, { env = process.env, major } = {}) {
  const { languages, osMode } = tfConfig(env);
  const first = languages[0];
  const posix = `${first.replace('-', '_')}.UTF-8`;
  const out = { ...options };
  out.args = (options.args || []).filter(a => !/^--(lang|accept-lang|user-agent)=/.test(String(a)));
  out.args.push(`--lang=${first}`, `--accept-lang=${languages.join(',')}`);
  if (major) {
    const ua = buildPersona({
      uaHint: osMode === 'host' ? hostOS() : 'Windows',
      browserVersion: `${major}.0.0.0`, languages, osMode,
    }).userAgent;
    out.args.push(`--user-agent=${ua}`);
  }
  out.env = { ...(options.env || env), LANG: posix, LANGUAGE: `${first.replace('-', '_')}:${first.split('-')[0]}`, LC_ALL: posix };
  return out;
}

class TfEvasionsPlugin extends PuppeteerExtraPlugin {
  constructor(opts = {}) { super(opts); }

  get name() { return 'brave-mcp/tf-evasions'; }

  async beforeLaunch(options) {
    return tfLaunchOptions(options, { major: exeMajorVersion(options.executablePath) });
  }

  async onPageCreated(page) {
    try {
      if (tfConfig().webgl === 'mask') await page.evaluateOnNewDocument(buildPageScript());
    } catch (_) { /* a lap közben zárult */ }
    try {
      const def = await personaFor(page, 'Windows');
      // A számolás alatt a scrape-sáv már kérhetett saját personát.
      await sendPersona(page, _explicit.get(page) || def);
    } catch (_) { /* a lap közben zárult */ }
  }
}

export function tfEvasionsPlugin(opts) {
  return new TfEvasionsPlugin(opts);
}
