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
  return base;
}
