// ════════════════════════════════════════════════════════════════════
//  Tool-szintű hívás-határidő — 2026-09-23
// ════════════════════════════════════════════════════════════════════
// MIÉRT: a /mcp tools/call eddig MINDEN toolt a TOOL_CALL_TIMEOUT_MS (25 s)
// alá zárt. A brave_scrape flaresolverr / auto_fallback útja viszont
// dokumentáltan 30–150 s (FlareSolverr solve, 7-szintű lánc) → ezek az utak
// csendben 504-et adtak, a hívó sosem kapta meg az eredményt (néma bukás).
// Mostantól: alapértelmezés marad 25 s, de a hosszú utak saját plafont kapnak.
// Minden érték env-ből felülírható; a függvény TISZTA (tesztelhető).

import { solverEnabled as captchaSolverEnabled } from './captcha/read-path.js';

const envInt = (env, k, d) => {
  const v = parseInt(env?.[k] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : d;
};

// ════════════════════════════════════════════════════════════════════
//  Olvasási CAPTCHA/challenge-plafon — 2026-10-08 (rel-wall, W2+C2)
// ════════════════════════════════════════════════════════════════════
// MIÉRT: a valódi reCAPTCHA-n a 25 s-os hívás-keretbe kb. EGY megoldási kör
// fér. Koordinátori döntés: a TOOL_CALL_TIMEOUT_MS alapértéke marad, de az
// EGYSZERI (munkamenet nélküli) `purpose:"read"` brave_page-hívás — az engine
// fetch Chrome-foka — magasabb plafont kap: READ_CHALLENGE_TIMEOUT_MS (alap
// 60 000). A 25 s fölötti részt a brave_page CSAK akkor használja, ha a lapon
// ténylegesen CAPTCHA-t kezel (src/brave-page.js run()), és ezt a válaszban
// kimondja (`read_challenge_timeout`). Munkamenetes hívás (session_id /
// keep_session) SOHA nem kapja (ott a megoldó sem fut).
// Sosem rövidebb az alapnál.
export function readChallengeCeilingMs(env = process.env) {
  const base = envInt(env, 'TOOL_CALL_TIMEOUT_MS', 25000);
  return Math.max(base, envInt(env, 'READ_CHALLENGE_TIMEOUT_MS', 60000));
}

// Egyszeri olvasó brave_page-hívás? (Ugyanaz a szabály, mint a brave-page.js
// run()-jában: session_id NINCS, és keep_session nincs — vagy close-zal jön.)
export function isOneShotRead(args) {
  const a = (args && typeof args === 'object') ? args : {};
  if (a.purpose !== 'read') return false;
  if (typeof a.session_id === 'string' && a.session_id) return false;
  if (a.keep_session && !a.close) return false;
  return true;
}

// A hívás határideje ms-ban az adott toolra és argumentumokra.
export function toolTimeoutMs(toolName, args, env = process.env) {
  const base = envInt(env, 'TOOL_CALL_TIMEOUT_MS', 25000);
  const a = (args && typeof args === 'object') ? args : {};
  if (toolName === 'brave_page' && isOneShotRead(a) && captchaSolverEnabled(env)) {
    // A külső (HTTP /mcp) vágás itt a magasabb plafon — a hívás belső
    // határideje ettől még a régi, amíg CAPTCHA-t nem kezel.
    return readChallengeCeilingMs(env);
  }
  if (toolName === 'brave_scrape' && (a.flaresolverr === true || a.auto_fallback === true)) {
    // A lánc worst-case ~150 s + tartalék. Sosem rövidebb az alapnál.
    return Math.max(base, envInt(env, 'TOOL_TIMEOUT_SCRAPE_SLOW_MS', 160000));
  }
  if (toolName === 'brave_crawl') {
    // 2026-10-06: a crawl saját plafont kaphat (alapból = az alap 25 s). A
    // crawl a plafonon BELÜL részeredménnyel tér vissza (crawlBudgetMs).
    return envInt(env, 'TOOL_TIMEOUT_CRAWL_MS', base);
  }
  return base;
}

// ════════════════════════════════════════════════════════════════════
//  brave_crawl időkerete — 2026-10-06
// ════════════════════════════════════════════════════════════════════
// MIÉRT: a crawl szekvenciálisan, oldalanként ~1,5–5 s-ot tölt (mért), és
// eddig NEM volt időkerete → ~12–15 oldal fölött a 25 s-os hívás-határidő
// mindig lelőtte, a hívó 504-et kapott NULLA eredménnyel, a crawl pedig a
// háttérben árván futott tovább. Mostantól a crawl a hívás-határidő MÍNUSZ
// tartalék alatt befejezi magát, és amit addig begyűjtött, visszaadja
// (truncated=true). A tartalék fedezi az utolsó lap kemény levágását és a
// JSON-válasz összeállítását.
export function crawlBudgetMs(args, env = process.env) {
  const ceiling = toolTimeoutMs('brave_crawl', args, env);
  const margin = envInt(env, 'TOOL_CRAWL_MARGIN_MS', 4000);
  // Legalább 3 s munkaidő akkor is, ha a plafon kicsi (teszt / rossz env).
  return Math.max(3000, ceiling - margin);
}
