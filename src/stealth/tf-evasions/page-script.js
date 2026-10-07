// A lapon futó TF-evasion szkript összerakása (2026-10-07).
//
// A vendor/ alatti fájlok a tf-playwright-stealth fork SZÓ SZERINTI másolatai
// (MIT, lásd /THIRD_PARTY_NOTICES.md). A fork ezeket egyetlen, kivételkezelés
// nélküli, összefűzött init-scriptként futtatja — ott bármelyik evasion dobása
// az összes utána következőt megöli, és a top-level const-ok globális kötések
// lesznek (STEALTH_DIFF 3.0 / P3). Itt ezért:
//   * minden egy IIFE-ben fut (a nyers CDP Page.addScriptToEvaluateOnNewDocument
//     NEM csomagol — globális `utils`/`opts` detektálható volna);
//   * minden evasion külön try/catch-ben, feature-detektálással;
//   * az `opts` a fork Python-oldali Properties-e helyett a lapon, a MÁR
//     felülírt navigator.userAgent-ből számolódik (webglForUA) — így a WebGL
//     bármely sávban (scrape, interaktív, brave_page mobil-UA) ugyanahhoz az
//     OS-hez illik, amit a UA állít.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webglForUA } from './persona.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'vendor');

// A vendorolt fájl törzse (a saját attribúciós fejlécünk nélkül — az első
// üres sorig tartó kommentblokk).
export function vendorBody(name) {
  const raw = readFileSync(path.join(DIR, name), 'utf8');
  const i = raw.indexOf('\n\n');
  return i >= 0 ? raw.slice(i + 2) : raw;
}

let _cached = null;

export function buildPageScript() {
  if (_cached) return _cached;
  const utilsJs = vendorBody('utils.js');
  const webglJs = vendorBody('webgl.vendor.js');
  _cached = `(() => {
  try {
${utilsJs}
    // ── webgl.vendor (fork) — persona-konzisztens értékekkel ──
    try {
      if (typeof WebGLRenderingContext !== 'undefined') {
        const opts = { webgl: (${webglForUA.toString()})(navigator.userAgent) };
        // WebGL2 nélküli környezetben a fork kódja a 2. addProxy-nál dob — az
        // első (WebGL1) proxy addigra él, a dobást a try/catch elnyeli.
${webglJs}
      }
    } catch (e) { /* egy evasion hibája ne törje a lapot */ }
  } catch (e) { /* utils-hiba: semmi ne fusson, a lap érintetlen */ }
})();`;
  return _cached;
}
