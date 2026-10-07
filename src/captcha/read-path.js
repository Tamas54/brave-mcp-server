// ════════════════════════════════════════════════════════════════════
//  C2 — a CAPTCHA-megoldó belépési pontja az OLVASÁSI utakon (2026-10-07)
// ════════════════════════════════════════════════════════════════════
// HÍVÓK (és CSAK ezek):
//   * BraveController._scrapeOnce — brave_scrape (és az auto_fallback lánc
//     böngészős fokai) + brave_crawl oldalai; a purpose itt KÓDBAN rögzített
//     'read', a hívó paramétere nem változtathat rajta;
//   * PageSessionManager.run — CSAK az egyszeri (munkamenet nélküli) brave_page-
//     hívás, ha a hívó `purpose:"read"`-et ad (az engine fetch Chrome-foka). A
//     munkamenetes brave_page (session_id / keep_session) — az interact/goal
//     útja — SOHA nem jut ide.
// Védővonalak (mélységben):
//   1. purpose !== 'read' → semmi (még felismerés sem);
//   2. CAPTCHA_SOLVER_ENABLED (alap KI);
//   3. űrlap-/URL-őr (detect.js): belépés/regisztráció/beküldés-űrlapon nem;
//   4. idő-keret (a hívó határideje), óránkénti darabszám- és napi költség-plafon;
//   5. a szolgáltató maga is elutasít minden nem-'read' kérést.
// Sikeres reCAPTCHA/hCaptcha után, ha a widget egy FAL-űrlapban ül (nincs más
// felhasználói mező) és a lap magától nem lépett tovább, a beküldő gombot is
// megnyomjuk — ez a fal „átlépése" (a tartalom a következő lapon van).
//
// Env:
//   CAPTCHA_SOLVER_ENABLED        1/true = be (alap: KI)
//   CAPTCHA_SOLVER_PROVIDER       a kép → válasz háttere (lásd backendsFor): üres/„echolot" = a saját
//                                 végpont; „echolot,capsolver" = szövegnél fizetős második sor (W2)
//   CAPTCHA_SOLVE_BUDGET_MS       egy megoldás plafonja (alap 20000; a hívó határideje alatt) —
//                                 a brave_page egyszeri read-hívásában a READ_CHALLENGE_TIMEOUT_MS-
//                                 ből számolt keret írja felül (budgetMs, lásd tool-timeout.js)
//   CAPTCHA_MIN_BUDGET_MS         ennél kevesebb hátralévő időnél nem kezdünk bele (alap 5000)
//   CAPTCHA_DETECT_WAIT_MS        a widget-keret betöltésére várás (alap 2500)
//   CAPTCHA_MAX_SOLVES_PER_HOUR   óránkénti megoldás-kísérlet plafon (alap 30)
//   CAPTCHA_WALL_MAX_TEXT         ennél több olvasható jel a lapon → nem fal (alap 4000)
//   CAPTCHA_TRACE                 1 = a válasz `captcha.trace`-ében az akció-napló (mérés)

import { detectCaptcha } from './detect.js';
import { echolotProvider, engineSolve } from './echolot-provider.js';
import { defaultHuman } from './pointer.js';

// A scrape-sáv memória-diétája (kép/font/media blokk) a CAPTCHA-képeket is
// elvágná: a megoldó a W2-vel KÖZÖS `page.__dietOff` jellel kapcsolja ki az adott
// lapon (brave-controller _applyScrapeDiet tiszteli — a W2 challenge-kivárása is
// ezt használja).

const sleep = (ms) => new Promise(r => setTimeout(r, Math.max(0, ms)));

// KEMÉNY határidő: egy keret-navigáció közben lógó evaluate / képernyőkép se vigye
// a hívást a 25 s-os külső vágásig (mérve: a hCaptcha-demón 2/5 hívás 504-et kapott
// e nélkül). Lejártakor a hívó megy tovább; a háttérben maradó lépések a lap
// zárásával halnak el.
function withDeadline(p, ms, onLate) {
  let t;
  return Promise.race([
    p,
    new Promise((resolve) => { t = setTimeout(() => resolve(onLate()), Math.max(1, ms)); }),
  ]).finally(() => clearTimeout(t));
}
const envNum = (env, k, d) => {
  const v = Number(env?.[k]);
  return env?.[k] !== undefined && env?.[k] !== '' && Number.isFinite(v) ? v : d;
};

export function solverEnabled(env = process.env) {
  return /^(1|true|on|yes)$/i.test(String(env.CAPTCHA_SOLVER_ENABLED || '').trim());
}

// ── óránkénti kísérlet-plafon (folyamat-memória) ──
const attempts = [];
function rateAllow(env) {
  const max = envNum(env, 'CAPTCHA_MAX_SOLVES_PER_HOUR', 30);
  const now = Date.now();
  while (attempts.length && now - attempts[0] > 3600_000) attempts.shift();
  if (attempts.length >= max) return false;
  attempts.push(now);
  return true;
}
export function _resetRate() { attempts.length = 0; }

// ── a W2 szolgáltató-független felülete (src/captcha/provider.js), ha jelen van ──
let providerMod;   // undefined = még nem próbáltuk; null = nincs
export async function w2ProviderModule() {
  if (providerMod === undefined) {
    try {
      providerMod = await import('./provider.js');
    } catch (_) {
      providerMod = null;
    }
    if (providerMod && typeof providerMod.registerProvider === 'function') {
      try { providerMod.registerProvider('echolot', echolotProvider); } catch (_) { /* már regisztrálva */ }
    }
  }
  return providerMod;
}
export function _setProviderModule(m) { providerMod = m; }

// Tesztvarrat: gyors (nem emberi) bevitel a hosszú fixture-tesztekhez.
let humanOverride = null;
export function _setHumanOverride(h) { humanOverride = h || null; }

function providerNames(env) {
  return String(env.CAPTCHA_SOLVER_PROVIDER || '').split(',').map(x => x.trim().toLowerCase()).filter(x => x && x !== 'none');
}

// A böngészőben MINDIG a saját vezénylés dolgozik (felismerés, kattintás,
// gépelés). A CAPTCHA_SOLVER_PROVIDER csak a kép → válasz HÁTTERET választja:
//   üres / „echolot" elöl  → a saját engine-végpont (C1/C3); ha a listában más is
//                             van (pl. „echolot,capsolver"), az a SZÖVEGES kép
//                             második sora a W2 láncán át (fizetős, kulccsal);
//   más név elöl           → a SZÖVEGES kép a W2 láncán megy; rács/hang/pont csak
//                             a saját végponton létezik (a fizetős adapterek nem tudják).
async function backendsFor(env) {
  const names = providerNames(env);
  const rest = names.filter(n => n !== 'echolot');
  if (!rest.length) return { primary: null, fallback: null, names };
  const m = await w2ProviderModule();
  if (!m || typeof m.solveCaptcha !== 'function') return { primary: null, fallback: null, names, missing: true };
  const chain = async (body) => {
    if (body.kind !== 'text' && body.kind !== 'math') return { ok: false, error: 'kind_unsupported_by_chain' };
    const r = await m.solveCaptcha({
      kind: body.kind, page: null,
      meta: { imageBase64: body.image_b64 }, purpose: 'read',
      env: { ...env, CAPTCHA_SOLVER_PROVIDER: rest.join(',') },
    });
    return { ok: !!r?.ok, answer: r?.answer, error: r?.error, cost_usd: r?.cost_usd || 0, model: r?.provider || null };
  };
  if (names[0] === 'echolot') return { primary: null, fallback: chain, names };
  // más szolgáltató elöl: a szöveg a láncon, a többi fajta a saját végponton
  const primary = async (body) => (body.kind === 'text' || body.kind === 'math' ? chain(body) : engineSolve(body, { deadlineTs: Date.now() + 15000, env }));
  return { primary, fallback: null, names };
}

// Fal-űrlap beküldése a sikeres widget-megoldás után (lásd a fejlécet).
async function submitWall(page, det, deadlineTs, human, navCount) {
  if (!det.form?.inForm || !det.form.hasSubmit || det.form.userFields > 0) return 'no_form';
  // a lap gyakran magától továbblép (data-callback) — rövid türelem
  const navBefore = navCount();
  const waitEnd = Math.min(Date.now() + 1000, deadlineTs - 500);
  while (Date.now() < waitEnd) {
    if (navCount() > navBefore) break;
    await sleep(150);
  }
  if (navCount() > navBefore) {
    try { await page.waitForNetworkIdle({ idleTime: 400, timeout: Math.max(300, Math.min(5000, deadlineTs - Date.now() - 300)) }); } catch (_) {}
    return 'auto_navigated';
  }
  const frame = det.frames.anchor || det.frames.challenge;
  let el = null;
  try { el = frame ? await frame.frameElement() : null; } catch (_) { el = null; }
  if (!el) return 'frame_gone';
  const h = await el.evaluateHandle((x) => {
    const f = x.closest('form');
    return f ? f.querySelector('button:not([type=button]):not([type=reset]), input[type=submit], input[type=image]') : null;
  }).catch(() => null);
  const btn = h ? h.asElement() : null;
  if (!btn) return 'no_submit';
  const navP = page.waitForNavigation({ timeout: Math.max(500, Math.min(8000, deadlineTs - Date.now() - 300)) }).catch(() => null);
  await human.clickHandle(page, btn);
  await navP;
  try { await page.waitForNetworkIdle({ idleTime: 400, timeout: Math.max(300, Math.min(4000, deadlineTs - Date.now() - 300)) }); } catch (_) {}
  return 'submitted';
}

// A lap CAPTCHA-falának megoldása olvasási úton. null = nincs CAPTCHA / ki van
// kapcsolva (a hívó útja változatlan); különben a telemetria-objektum:
//   {status: 'solved'|'failed'|'skipped', vendor, kind, reason?, provider?, rounds?,
//    solver_calls?, ms, cost_usd?, error?, submit?}
// budgetMs (2026-10-08, rel-wall): a CAPTCHA_SOLVE_BUDGET_MS felülírása — a
// brave_page egyszeri read-hívása a READ_CHALLENGE_TIMEOUT_MS-plafonnal adja (a
// kiterjesztett keretben több kör is férjen); a határidő (deadlineTs) így is köt.
export async function solveOnReadPath(page, { purpose, deadlineTs, env = process.env, human, solver, detectWaitMs, budgetMs, op = 'scrape' } = {}) {
  if (purpose !== 'read') return { status: 'skipped', reason: 'purpose_not_read' };
  if (!solverEnabled(env)) return null;
  const t0 = Date.now();
  const budget = Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : envNum(env, 'CAPTCHA_SOLVE_BUDGET_MS', 20000);
  const end = Math.min(deadlineTs || (t0 + 20000), t0 + budget);
  const dWait = Math.max(0, Math.min(detectWaitMs ?? envNum(env, 'CAPTCHA_DETECT_WAIT_MS', 2500), end - Date.now() - 1000));
  let det;
  try {
    det = await withDeadline(detectCaptcha(page, { waitMs: dWait }), Math.max(500, end - Date.now()), () => ({ found: false, late: true }));
  } catch (_) { return null; }
  if (!det.found) return null;
  const base = { vendor: det.vendor, kind: det.kind };
  const done = (o) => ({ ...base, ...o, ms: Date.now() - t0 });
  if (det.guard) return done({ status: 'skipped', reason: det.guard });
  if (det.checked && det.vendor !== 'text') {
    // valaki (pl. a W2 challenge-kivárása, vagy a lap maga) már átengedte a
    // widgetet — a fal-űrlap beküldése viszont még hátravan
    const hum0 = humanOverride || human || defaultHuman;
    const submit = await submitWall(page, det, end, hum0, () => 0).catch(() => 'submit_failed');
    return done(submit === 'submitted' || submit === 'auto_navigated'
      ? { status: 'solved', how: 'already_checked', submit, provider: null, rounds: 0, solver_calls: 0, cost_usd: 0 }
      : { status: 'skipped', reason: 'already_passed', submit });
  }
  if (!det.solvable) return done({ status: 'skipped', reason: 'not_solvable' });
  const minBudget = det.kind === 'math_text' ? 1500 : envNum(env, 'CAPTCHA_MIN_BUDGET_MS', 5000);
  if (end - Date.now() < minBudget) return done({ status: 'skipped', reason: 'budget' });
  if (!rateAllow(env)) return done({ status: 'skipped', reason: 'rate_limited' });

  // a diéta ki: a feladvány képei/hangja kellenek
  page.__dietOff = true;
  if (det.vendor === 'text' && det.text?.image && det.text.imageLoaded === false) {
    // a kép a diéta miatt nem jött le → egyszeri újratöltés (új feladvány; a régit
    // úgysem láttuk), utána újra-felismerés
    try {
      await page.reload({ waitUntil: 'load', timeout: Math.max(1000, Math.min(10000, end - Date.now() - 3000)) });
      det = await detectCaptcha(page, { waitMs: 500 });
    } catch (_) { det = { found: false }; }
    if (!det.found) return done({ status: 'failed', error: 'reload_lost_captcha' });
    if (det.guard) return done({ status: 'skipped', reason: det.guard });
  }

  const hum = humanOverride || human || defaultHuman;
  let navs = 0;
  const onNav = (f) => { try { if (f === page.mainFrame()) navs++; } catch (_) {} };
  try { page.on('framenavigated', onNav); } catch (_) {}
  try {
    const bk = await backendsFor(env);
    const req = {
      kind: det.kind, page,
      frame: det.frames?.challenge || det.frames?.anchor || page.mainFrame(),
      meta: { detection: det, deadlineTs: end, human: hum, solver: solver || bk.primary || undefined, fallbackSolver: bk.fallback || undefined, env, op },
      purpose: 'read',
    };
    let res;
    try {
      res = await withDeadline(echolotProvider.solve(req), end - Date.now() + 400,
        () => ({ ok: false, error: 'deadline', provider: 'echolot' }));
    } catch (e) {
      res = { ok: false, error: `internal:${String(e?.message || e).split('\n')[0].slice(0, 80)}`, provider: 'echolot' };
    }
    const out = {
      status: res?.ok ? 'solved' : 'failed',
      provider: res?.provider || null,
      rounds: res?.rounds ?? null,
      solver_calls: res?.solver_calls ?? null,
      cost_usd: res?.cost_usd ?? 0,
    };
    if (!res?.ok) out.error = res?.error || 'unknown';
    if (res?.how) out.how = res.how;
    // részletes akció-napló csak kérésre (mérés/hibakeresés): CAPTCHA_TRACE=1
    if (/^(1|true)$/i.test(String(env.CAPTCHA_TRACE || '')) && Array.isArray(res?.trace)) out.trace = res.trace.slice(0, 80);
    if (res?.ok && det.vendor !== 'text' && res.how !== 'navigated') {
      out.submit = await submitWall(page, det, end, hum, () => navs).catch(() => 'submit_failed');
    }
    const ok = res?.ok;
    console.error(`[captcha] ${ok ? 'MEGOLDVA' : 'SIKERTELEN'} vendor=${det.vendor} kind=${det.kind} provider=${out.provider} rounds=${out.rounds} calls=${out.solver_calls} ms=${Date.now() - t0}${ok ? '' : ` error=${out.error}`}`);
    return done(out);
  } finally {
    try { page.off('framenavigated', onNav); } catch (_) {}
  }
}
