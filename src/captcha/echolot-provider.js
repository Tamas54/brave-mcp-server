// ════════════════════════════════════════════════════════════════════
//  C2 — „echolot": a SAJÁT CAPTCHA-megoldó szolgáltató (2026-10-07)
// ════════════════════════════════════════════════════════════════════
// A W2 szolgáltató-független felülete (src/captcha/provider.js):
//   solveCaptcha({kind, page, frame, meta, purpose})
//     → {ok, answer?, actions?, provider, ms, cost_usd?}
// Ez a modul ennek az „echolot" megvalósítása: a böngésző-oldali vezénylés
// (grid.js / audio.js / text.js) + a felismerés/olvasás eredményének elküldése
// az engine SAJÁT megoldó-végpontjára (C1: szöveg/kép, C3: hang):
//   POST {CAPTCHA_ENGINE_URL}/internal/v1/captcha/solve   (Authorization: Bearer)
//   törzs: {kind, image_b64 | tiles_b64[] | audio_b64, instruction?, purpose:"read", …}
//   válasz: {ok, answer | tiles[] | points[], confidence, model, ms, cost_usd}
// A modul NEM importálja a provider.js-t (körkörös import ellen); a
// regisztrációt a read-path.js végzi, ha a W2 felülete jelen van.
//
// HATÁR: purpose !== "read" → azonnali elutasítás (purpose_not_allowed), a lapon
// SEMMI nem történik. Az engine-nek is mindig purpose:"read" megy.
//
// Env:
//   CAPTCHA_ENGINE_URL           az engine alap-URL-je (pl. http://engine.internal:8000)
//   CAPTCHA_ENGINE_TOKEN         belső token (Bearer)
//   CAPTCHA_ENGINE_TIMEOUT_MS    egy megoldó-hívás plafonja (alap 15000)
//   CAPTCHA_MAX_ROUNDS           körök száma feladványonként (alap 5)
//   CAPTCHA_RECAPTCHA_ORDER      „image,audio" (alap) | „audio,image" | „image" | „audio"
//   CAPTCHA_COST_CAP_USD_DAY     napi (UTC) folyamat-szintű költség-plafon (alap 2.0)

import { detectCaptcha, solveMathExpr } from './detect.js';
import { solveRecaptcha, solveHcaptcha } from './grid.js';
import { solveTextCaptcha } from './text.js';
import { defaultHuman } from './pointer.js';

const envNum = (env, k, d) => {
  const v = Number(env?.[k]);
  return env?.[k] !== undefined && env?.[k] !== '' && Number.isFinite(v) ? v : d;
};

// ── költség-napló (folyamat-memória; nincs tartós tár — a plafon védőháló) ──
const ledger = { day: '', costUsd: 0, calls: 0 };

function ledgerDay() { return new Date().toISOString().slice(0, 10); }

function ledgerRoll() {
  const d = ledgerDay();
  if (ledger.day !== d) { ledger.day = d; ledger.costUsd = 0; ledger.calls = 0; }
}

export function costStatus(env = process.env) {
  ledgerRoll();
  return { day: ledger.day, cost_usd: Number(ledger.costUsd.toFixed(6)), calls: ledger.calls, cap_usd: envNum(env, 'CAPTCHA_COST_CAP_USD_DAY', 2) };
}

export function _resetLedger() { ledger.day = ''; ledger.costUsd = 0; ledger.calls = 0; }

// A C1/C3-válasz egységesítése.
function normalizeResp(j) {
  if (!j || typeof j !== 'object') return { ok: false, error: 'bad_payload' };
  const out = {
    // a C3 (hang) a REST-válaszban `success`-t ad `ok` helyett — mindkettőt értjük
    ok: j.ok === true || (j.ok === undefined && j.success === true),
    answer: j.answer,
    tiles: j.tiles,
    points: j.points,
    confidence: typeof j.confidence === 'number' ? j.confidence : null,
    model: typeof j.model === 'string' ? j.model.slice(0, 80) : null,
    ms: typeof j.ms === 'number' ? j.ms : null,
    cost_usd: typeof j.cost_usd === 'number' && Number.isFinite(j.cost_usd) && j.cost_usd >= 0 ? j.cost_usd : 0,
  };
  if (!out.ok) out.error = typeof j.error === 'string' ? j.error.slice(0, 80) : 'solver_declined';
  return out;
}

// Egy hívás a megoldó-végpontra. Sosem dob: hibánál {ok:false, error, fatal?}.
export async function engineSolve(body, { deadlineTs = Date.now() + 15000, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const base = String(env.CAPTCHA_ENGINE_URL || '').trim().replace(/\/+$/, '');
  if (!base) return { ok: false, error: 'engine_unconfigured', fatal: true };
  ledgerRoll();
  const cap = envNum(env, 'CAPTCHA_COST_CAP_USD_DAY', 2);
  if (ledger.costUsd >= cap) return { ok: false, error: 'cost_cap_reached', fatal: true };
  const timeout = Math.min(envNum(env, 'CAPTCHA_ENGINE_TIMEOUT_MS', 15000), deadlineTs - Date.now() - 300);
  if (timeout < 800) return { ok: false, error: 'budget_exhausted', fatal: true };
  const payload = { ...body, purpose: 'read' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const t0 = Date.now();
  try {
    const headers = { 'content-type': 'application/json' };
    if (env.CAPTCHA_ENGINE_TOKEN) headers.authorization = `Bearer ${env.CAPTCHA_ENGINE_TOKEN}`;
    const res = await fetchImpl(`${base}/internal/v1/captcha/solve`, {
      method: 'POST', headers, body: JSON.stringify(payload), signal: ctrl.signal, redirect: 'manual',
    });
    const text = await res.text();
    if (text.length > 1_000_000) return { ok: false, error: 'engine_response_too_large' };
    let j = null;
    try { j = JSON.parse(text); } catch (_) { j = null; }
    ledger.calls++;
    if (res.status === 401 || res.status === 403) return { ok: false, error: `engine_auth_${res.status}`, fatal: true };
    if (res.status === 404 || res.status === 501 ||
        (res.status === 400 && /kind must be/i.test(String(j?.detail || '')))) {
      // a végpont (még) nincs — vagy ez a fajta nem támogatott (C1: 400 „kind must be one of …")
      const e = j && typeof j.error === 'string' ? j.error : `engine_http_${res.status}`;
      return { ok: false, error: /unsupported/.test(e) ? e : `unsupported_kind:${e}`, switchMode: true };
    }
    if (res.status === 503 && j?.error === 'feature_disabled') return { ok: false, error: 'engine_feature_disabled', fatal: true, switchMode: true };
    const out = normalizeResp(j);
    ledger.costUsd += out.cost_usd || 0;
    if (!res.ok && out.ok) { out.ok = false; out.error = `engine_http_${res.status}`; }
    if (!out.ok && !out.error) out.error = `engine_http_${res.status}`;
    if (!out.ok && /unsupported/.test(out.error)) out.switchMode = true;
    out.ms = out.ms ?? (Date.now() - t0);
    return out;
  } catch (e) {
    if (e?.name === 'AbortError') return { ok: false, error: 'engine_timeout' };
    return { ok: false, error: `engine_unreachable:${String(e?.cause?.code || e?.message || e).slice(0, 40)}` };
  } finally {
    clearTimeout(timer);
  }
}

function orderFromEnv(env) {
  const raw = String(env.CAPTCHA_RECAPTCHA_ORDER || 'image,audio').toLowerCase();
  const o = raw.split(/[\s,]+/).filter(x => x === 'image' || x === 'audio');
  return o.length ? [...new Set(o)] : ['image', 'audio'];
}

// Csak-válasz mód (a W2 felületének text/math/audio kérései, lap NÉLKÜL): a
// kép/hang → válasz, a bevitel a hívóé.
async function answerOnly(kind, meta, env, deadlineTs) {
  if (kind === 'math' && typeof meta.text === 'string') {
    const a = solveMathExpr(meta.text);
    return a === null ? { ok: false, error: 'math_unparsed' } : { ok: true, answer: a, cost_usd: 0 };
  }
  if ((kind === 'text' || kind === 'math') && meta.imageBase64) {
    return engineSolve({ kind, image_b64: meta.imageBase64 }, { deadlineTs, env });
  }
  if (kind === 'audio' && (meta.audioBase64 || meta.audio_b64)) {
    const a = meta.audioBase64 || meta.audio_b64;
    return engineSolve({ kind: 'audio', audio: a, audio_b64: a, mime: meta.mime || 'audio/mpeg', mode: 'auto' }, { deadlineTs, env });
  }
  return null;
}

// A szolgáltató (a W2 felületének impl-je: {kinds, configured, solve}). A
// böngészőben MAGA kattint/gépel — ezért `actions`-t SOHA nem ad vissza (azt a
// W2 challenge.js végrehajtaná); az akció-napló neve `trace`. `meta`:
//   detection      — a detect.js leírója (ha nincs, itt ismerjük fel)
//   deadlineTs     — abszolút határidő (ms)
//   human          — {move, click, type, clickHandle} (a W2 kezéből: pointer.fromHumanInput)
//   solver         — a kép/hang → válasz háttér felülírása ((body) => válasz); teszt / más szolgáltató
//   fallbackSolver — második sor a SZÖVEGES kép-feladványhoz (pl. a W2 fizetős lánca)
//   env            — tesztvarrat (a W2 a kérés `env` mezőjében adja)
export const echolotProvider = {
  name: 'echolot',
  // a W2 fajta-nevei (image_grid/text/math/audio) + a saját felismerő nevei
  kinds: ['image_grid', 'text', 'math', 'audio', 'recaptcha_v2', 'recaptcha_invisible', 'hcaptcha', 'math_text'],
  configured(env = process.env) {
    return String(env.CAPTCHA_ENGINE_URL || '').trim() ? { ok: true } : { ok: false, reason: 'CAPTCHA_ENGINE_URL not set' };
  },
  async solve({ kind, page, frame, meta = {}, purpose, env: reqEnv } = {}) {
    const t0 = Date.now();
    if (purpose !== 'read') {
      return { ok: false, error: 'purpose_not_allowed', provider: 'echolot', ms: 0, cost_usd: 0 };
    }
    meta = meta || {};
    const env = meta.env || reqEnv || process.env;
    if (!page || meta.imageBase64 || typeof meta.text === 'string' || meta.audioBase64) {
      const a = await answerOnly(kind, meta, env, meta.deadlineTs || (t0 + envNum(env, 'CAPTCHA_SOLVE_BUDGET_MS', 20000)));
      if (a) return { ok: !!a.ok, answer: a.ok ? a.answer : undefined, error: a.ok ? undefined : a.error, provider: 'echolot', ms: Date.now() - t0, cost_usd: a.cost_usd || 0 };
      if (!page) return { ok: false, error: 'page_required', provider: 'echolot', ms: 0, cost_usd: 0 };
    }
    const deadlineTs = meta.deadlineTs || (t0 + envNum(env, 'CAPTCHA_SOLVE_BUDGET_MS', 20000));
    const ctx = {
      t0, deadlineTs, actions: [], calls: 0, cost: 0,
      maxRounds: Math.max(1, Math.min(10, envNum(env, 'CAPTCHA_MAX_ROUNDS', 5))),
      order: orderFromEnv(env),
      human: meta.human || defaultHuman,
      vendor: null,
    };
    ctx.solve = async (body0) => {
      const tc = Date.now();
      // a C1-határ mezői: a művelet (scrape|crawl) és a lap URL-je (belépő/fizetési → 403)
      let pageUrl = null;
      try { pageUrl = page.url(); } catch (_) {}
      const body = { ...body0, op: meta.op === 'crawl' ? 'crawl' : 'scrape', ...(pageUrl ? { url: pageUrl } : {}) };
      let r = meta.solver
        ? normalizeResp(await meta.solver({ ...body, purpose: 'read' }))
        : await engineSolve(body, { deadlineTs: ctx.deadlineTs, env });
      // második sor (csak szöveges kép): a saját végpont nem adott választ
      if (!r.ok && (body.kind === 'text' || body.kind === 'math') && typeof meta.fallbackSolver === 'function' && ctx.deadlineTs - Date.now() > 2000) {
        const f = normalizeResp(await meta.fallbackSolver({ ...body, purpose: 'read' }));
        ctx.actions.length < 200 && ctx.actions.push({ t: Date.now() - t0, type: 'solve_fallback', kind: body.kind, ok: !!f.ok, primary_error: r.error });
        if (f.ok) r = f;
      }
      ctx.calls++;
      ctx.cost += r.cost_usd || 0;
      ctx.actions.length < 200 && ctx.actions.push({
        t: Date.now() - t0, type: 'solve', kind: body.kind, ok: !!r.ok, ms: Date.now() - tc,
        ...(r.ok ? {} : { error: r.error }), ...(r.model ? { model: r.model } : {}),
      });
      return r;
    };
    let det = meta.detection;
    if (!det) {
      det = await detectCaptcha(page);
      if (!det.found) return { ok: false, error: 'no_captcha', provider: 'echolot', ms: Date.now() - t0, cost_usd: 0 };
    }
    // fő-keret navigációk számlálása: a sikeres megoldás után a lap gyakran
    // magától továbblép (data-callback → submit) — a keretek ilyenkor eltűnnek
    ctx.mainNavs = 0;
    ctx.navsAtStart = 0;
    const onNav = (f) => { try { if (f === page.mainFrame()) ctx.mainNavs++; } catch (_) {} };
    try { page.on('framenavigated', onNav); } catch (_) {}
    let r;
    try {
      if (det.vendor === 'recaptcha') r = await solveRecaptcha(page, det, ctx);
      else if (det.vendor === 'hcaptcha') r = await solveHcaptcha(page, det, ctx);
      else if (det.vendor === 'text') r = await solveTextCaptcha(page, det, ctx);
      else r = { ok: false, error: `unsupported_kind:${kind || det.kind}` };
    } catch (e) {
      const m = String(e?.message || e).split('\n')[0];
      r = { ok: false, error: /detached|Target closed|Session closed|Execution context was destroyed/i.test(m) ? 'page_changed' : `internal:${m.slice(0, 80)}` };
    } finally {
      try { page.off('framenavigated', onNav); } catch (_) {}
    }
    return {
      ok: !!r.ok,
      answer: r.token || r.answer || undefined,
      error: r.ok ? undefined : r.error,
      rounds: r.rounds ?? 0,
      how: r.how,
      trace: ctx.actions,
      provider: 'echolot',
      solver_calls: ctx.calls,
      ms: Date.now() - t0,
      cost_usd: Number(ctx.cost.toFixed(6)),
    };
  },
};

// A W2 provider.js lusta betöltője a default exportot (vagy `provider`-t) regisztrálja.
export const provider = echolotProvider;
export default echolotProvider;
