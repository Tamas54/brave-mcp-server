// TF-persona — egy KOHERENS böngésző-profil: UA ↔ navigator.platform ↔
// UA-CH (userAgentData + sec-ch-ua fejlécek) ↔ Accept-Language ↔
// navigator.languages ↔ WebGL-renderer. (2026-10-07, TINYFISH PARITY 2.9)
//
// KONCEPCIÓ-ÁTVÉTEL, NEM KÓD: a tf-playwright-stealth fork új „persona"
// rétege (properties/_navigator_properties.py, _header_properties.py,
// _webgl_properties.py + js/navigator.userAgent.js) ötletét követi, de
// a fork ismert hibái NÉLKÜL (lásd ~/recon/tinyfish/STEALTH_DIFF.md 3.13,
// 3.15, 3.17 és 6. fejezet P2/4):
//   * "Win32" (nem "Win64"), "Linux x86_64" (nem "Linux x86_x64");
//   * a userAgentData NEM sima JS-objektum, hanem CDP-n (Network.
//     setUserAgentOverride + userAgentMetadata) a böngésző SAJÁT
//     NavigatorUAData-ja → valódi getHighEntropyValues(), sec-ch-ua fejlécek,
//     és a workerek UA-ja is ugyanaz;
//   * a verzió a TÉNYLEGESEN futó böngészőé (browser.version()), nem véletlen
//     (a TLS/H2-ujjlenyomat és a JS-feature-készlet különben elárulja);
//   * determinisztikus (nincs véletlen DNT / WebGL-pár / form-factor);
//   * az Accept-Language q-érték NÉLKÜL megy a CDP-be (a Chrome maga teszi rá
//     — mérve: q-értékkel „de;q=0.9;q=0.9" lesz a fejléc, és a Chrome
//     navigator.languages-be is a nyers sztring kerül).
// A GREASE-márka a Chromium mai algoritmusa (components/embedder_support/
// user_agent_utils.cc) — a puppeteer-extra user-agent-override-ja a 2022
// előtti változatot számolja (154-re „;Not A Brand" a valódi „Not A(Brand"
// helyett, mérve Brave 1.96 / Chrome 154 alatt).

export const OS_PROFILES = {
  Windows: {
    uaToken: 'Windows NT 10.0; Win64; x64',
    platform: 'Win32',
    chPlatform: 'Windows',
    platformVersion: '10.0.0',
    architecture: 'x86',
    bitness: '64',
  },
  macOS: {
    uaToken: 'Macintosh; Intel Mac OS X 10_15_7',
    platform: 'MacIntel',
    chPlatform: 'macOS',
    platformVersion: '14.6.1',
    // Apple Silicon: a UA „Intel Mac" marad (befagyasztott), az arch „arm" —
    // összhangban az M1-es WebGL-rendererrel.
    architecture: 'arm',
    bitness: '64',
  },
  Linux: {
    uaToken: 'X11; Linux x86_64',
    platform: 'Linux x86_64',
    chPlatform: 'Linux',
    // Chrome 154 és Brave 1.96 natívan üres platformVersion-t ad Linuxon (mérve).
    platformVersion: '',
    architecture: 'x86',
    bitness: '64',
  },
};

// OS-hez illő, MODERN (ANGLE-formátumú) WebGL vendor/renderer. Determinisztikus
// — a fork 5 véletlen párja OS-től függetlenül választott (Windows-UA mellé
// „Apple M1"-et is), a puppeteer-extra alapértéke („Intel Iris OpenGL Engine")
// pedig ANGLE előtti macOS-sztring minden OS-en.
// FIGYELEM: a lapon futó page-script.js EZT A TÁBLÁT a függvény forrásával
// együtt viszi be (webglForUA.toString()) — ezért önálló, külső hivatkozás nélküli.
export function webglForUA(ua) {
  const s = String(ua || '');
  if (/Android/.test(s)) {
    return { vendor: 'Google Inc. (Qualcomm)', renderer: 'ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2)' };
  }
  if (/Windows/.test(s)) {
    return { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E9B) Direct3D11 vs_5_0 ps_5_0, D3D11)' };
  }
  if (/Mac OS X|Macintosh/.test(s)) {
    return { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)' };
  }
  if (/Linux|X11|CrOS/.test(s)) {
    return { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL 4.6)' };
  }
  return { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E9B) Direct3D11 vs_5_0 ps_5_0, D3D11)' };
}

// UA-sztringből az OS-profil kulcsa (ismeretlen → Windows, mint a pe maskLinux-a).
export function osFromUA(ua) {
  const s = String(ua || '');
  if (/Windows/.test(s)) return 'Windows';
  if (/Mac OS X|Macintosh/.test(s)) return 'macOS';
  if (/Linux|X11/.test(s) && !/Android/.test(s)) return 'Linux';
  return 'Windows';
}

export function hostOS(platform = process.platform) {
  if (platform === 'win32') return 'Windows';
  if (platform === 'darwin') return 'macOS';
  return 'Linux';
}

// A futó böngésző márkája a bináris útvonalából. MIÉRT: a Brave natívan
// „Brave" márkát küld (sec-ch-ua) és van navigator.brave-je — ha mellé
// „Google Chrome"-ot állítunk, az hazugság, amit a creepjs-szerű detektorok
// azonnal látnak. STEALTH_TF_BRAND env felülírhatja ('Brave' | 'Google
// Chrome' | 'Chromium').
export function brandFor(executablePath, env = process.env) {
  const forced = String(env.STEALTH_TF_BRAND || '').trim();
  if (forced) return forced === 'Chromium' ? null : forced;
  const p = String(executablePath || '').toLowerCase();
  if (p.includes('brave')) return 'Brave';
  if (p.includes('chromium')) return null;
  return 'Google Chrome';
}

// A Chromium mai GREASE-algoritmusa (seed = főverzió).
const GREASEY_CHARS = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'];
const GREASED_VERSIONS = ['8', '99', '24'];

export function greasedBrand(major) {
  const seed = Number(major) || 0;
  return {
    brand: `Not${GREASEY_CHARS[seed % GREASEY_CHARS.length]}A${GREASEY_CHARS[(seed + 1) % GREASEY_CHARS.length]}Brand`,
    version: GREASED_VERSIONS[seed % GREASED_VERSIONS.length],
  };
}

// brands (főverzió) vagy fullVersionList (teljes verzió) a valódi sorrendben.
export function brandList(major, brand, version) {
  const seed = Number(major) || 0;
  const g = greasedBrand(seed);
  const grease = { brand: g.brand, version: version === String(seed) ? g.version : `${g.version}.0.0.0` };
  if (!brand) {
    const order = [[0, 1], [1, 0]][seed % 2];
    const out = [];
    out[order[0]] = grease;
    out[order[1]] = { brand: 'Chromium', version };
    return out;
  }
  const order = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]][seed % 6];
  const out = [];
  out[order[0]] = grease;
  out[order[1]] = { brand: 'Chromium', version };
  out[order[2]] = { brand, version };
  return out;
}

// 'en-US,en;q=0.9, hu;q=0.8' → ['en-US','en','hu'] (q-értékek és duplikátumok nélkül).
export function parseLanguages(s) {
  const out = [];
  for (const part of String(s || '').split(',')) {
    const l = part.split(';')[0].trim();
    if (l && !out.includes(l)) out.push(l);
  }
  return out;
}

// A persona összerakása.
//   uaHint         — a hívó által kért UA (ebből CSAK az OS számít, ha os='ua')
//   browserVersion — browser.version() kimenete, pl. "Chrome/154.0.8037.98"
//   brand          — brandFor() eredménye
//   languages      — tömb vagy vesszős lista (q-értékek nélkül kerül tovább)
//   osMode         — 'ua' (a kért UA OS-e, alap) | 'host' (a gazdagép OS-e)
export function buildPersona({ uaHint, browserVersion, brand = 'Google Chrome', languages = ['en-US', 'en'], osMode = 'ua', platform } = {}) {
  const m = String(browserVersion || '').match(/(\d+)\.(\d+)\.(\d+)\.(\d+)/);
  const major = m ? m[1] : '130';
  const realFull = m ? `${m[1]}.${m[2]}.${m[3]}.${m[4]}` : `${major}.0.0.0`;
  // A Brave natívan redukált teljes verziót ad a UA-CH-ban is (mérve: 154.0.0.0).
  const fullVersion = brand === 'Brave' ? `${major}.0.0.0` : realFull;
  const osKey = osMode === 'host' ? hostOS(platform) : osFromUA(uaHint);
  const os = OS_PROFILES[osKey];
  const userAgent = `Mozilla/5.0 (${os.uaToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  const langs = Array.isArray(languages) ? languages.filter(Boolean) : parseLanguages(languages);
  const langList = langs.length ? langs : ['en-US', 'en'];
  return {
    os: osKey,
    userAgent,
    platform: os.platform,
    acceptLanguage: langList.join(','),
    languages: langList,
    userAgentMetadata: {
      brands: brandList(major, brand, major),
      fullVersionList: brandList(major, brand, fullVersion),
      fullVersion,
      platform: os.chPlatform,
      platformVersion: os.platformVersion,
      architecture: os.architecture,
      model: '',
      mobile: false,
      bitness: os.bitness,
      wow64: false,
    },
    webgl: webglForUA(userAgent),
  };
}
