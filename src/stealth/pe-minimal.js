// „pe-minimál" mód — 2026-10-07 (R2-E, P1-3). Kapcsoló: STEALTH_PE_MINIMAL=1
// (alapból KI; indításkor olvasott, mint a STEALTH_TF_EVASIONS).
//
// MIÉRT: a CreepJS „stealth 60 %"-unk maradéka (hasIframeProxy,
// hasBadChromeRuntime, hasToStringProxy, „extension: puppeteer-extra") a
// puppeteer-extra-plugin-stealth SAJÁT shimjeiből jön — new headless alatt ezek
// nagy része fölösleges, mert a natív érték már jó, a shim (Proxy +
// Function.prototype.toString-csere) viszont maga a jel. Mérve 2026-10-07
// (Brave 154, --headless=new, rebrowser, shim NÉLKÜL): webdriver=false,
// vendor="Google Inc.", 7 plugin, chrome.app/csi/loadTimes natívan VAN,
// chrome.runtime natívan NINCS (helyes egy sima lapon), Notification
// "default" ↔ permissions "prompt" (egyezik), mp4/aac "probably", outerWidth/
// Height kitöltve, srcdoc-iframe contentWindow ép, toString natív.
//
// KI (ezek natívan jók, a shim csak jelet ad): lásd PE_MINIMAL_DISABLED.
// BENT marad: user-agent-override (a natív UA „HeadlessChrome"-ot mond — TF
// alatt úgyis a persona váltja), sourceurl (CDP-szintű, nincs lapba írt Proxy),
// defaultArgs, navigator.webdriver (no-op, ha a natív már false).
export const PE_MINIMAL_DISABLED = Object.freeze([
  'chrome.app',
  'chrome.csi',
  'chrome.loadTimes',
  'chrome.runtime',
  'iframe.contentWindow',
  'media.codecs',
  'navigator.hardwareConcurrency',
  'navigator.languages',
  'navigator.permissions',
  'navigator.plugins',
  'webgl.vendor',
  'window.outerdimensions',
]);

export function peMinimalEnabled(env = process.env) {
  return /^(1|true|on|yes)$/i.test(String(env.STEALTH_PE_MINIMAL || '').trim());
}

// A puppeteer-extra stealth-plugin példányából kiveszi a natívan jó értékű
// shimeket (a use() ELŐTT kell hívni — a pruneSupersededEvasions mintájára).
export function prunePeMinimal(stealthPlugin) {
  for (const e of PE_MINIMAL_DISABLED) stealthPlugin.enabledEvasions.delete(e);
  return stealthPlugin;
}

// /health: hálózat nélkül mondja ki az állapotot.
export function peMinimalHealth(env = process.env) {
  return peMinimalEnabled(env)
    ? { minimal: true, disabled_evasions: [...PE_MINIMAL_DISABLED] }
    : { minimal: false };
}
