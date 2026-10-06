// ════════════════════════════════════════════════════════════════════
//  Tool-szintű hívás-határidő — 2026-09-23
// ════════════════════════════════════════════════════════════════════
// MIÉRT: a /mcp tools/call eddig MINDEN toolt a TOOL_CALL_TIMEOUT_MS (25 s)
// alá zárt. A brave_scrape flaresolverr / auto_fallback útja viszont
// dokumentáltan 30–150 s (FlareSolverr solve, 7-szintű lánc) → ezek az utak
// csendben 504-et adtak, a hívó sosem kapta meg az eredményt (néma bukás).
// Mostantól: alapértelmezés marad 25 s, de a hosszú utak saját plafont kapnak.
// Minden érték env-ből felülírható; a függvény TISZTA (tesztelhető).

const envInt = (env, k, d) => {
  const v = parseInt(env?.[k] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : d;
};

// A hívás határideje ms-ban az adott toolra és argumentumokra.
export function toolTimeoutMs(toolName, args, env = process.env) {
  const base = envInt(env, 'TOOL_CALL_TIMEOUT_MS', 25000);
  const a = (args && typeof args === 'object') ? args : {};
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
