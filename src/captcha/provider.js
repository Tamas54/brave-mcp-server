// CAPTCHA-megoldó — szolgáltató-független belépési pont (W2, 2026-10-07).
//
// EGYETLEN felület a megoldókhoz:
//   solveCaptcha({ kind, page, frame, meta, purpose }) →
//     { ok, answer?, actions?, provider, ms, cost_usd?, tried[], error? }
//   kind: 'text' | 'math' | 'image_grid' | 'audio' | 'turnstile'
//   meta: kind-függő — turnstile: {sitekey, url, action?, cdata?, userAgent,
//         challenge_page (CF interstitial-oldalon true)}; image_grid: {vendor,
//         box, url}; text/math: {imageBase64?, text?}
//   answer:  szöveg / szám / token (a kind szerint)
//   actions: a hívó által végrehajtandó lépések, ha a szolgáltató nem maga
//            kattint: [{type:'click', x, y} | {type:'click', selector, frame?}
//            | {type:'type', text, selector?} | {type:'wait', ms}] — x/y a FŐ
//            keret nézetablakában, CSS-pixelben (a challenge.js emberi
//            bemenettel hajtja végre).
//
// ⛔ HATÁR (koordinátori döntés, 2026-10-07): a megoldó CSAK olvasási úton fut
// (scrape / crawl / map letöltés) — `purpose === 'read'`. A brave_page-
// munkamenetek, interact/goal űrlapok SOSEM hívhatják: más purpose mellett a
// függvény egyetlen szolgáltatót sem indít (`error: 'purpose_not_allowed'`).
//
// Szolgáltatók: registerProvider(name, impl), impl = {
//   kinds?: string[],                         // mit tud (hiányában: mindent)
//   configured?(env) → {ok, reason?},         // kulcs / beállítás megvan-e
//   solve(req) → {ok, answer?, actions?, cost_usd?, error?}
// }. A sorrend a CAPTCHA_SOLVER_PROVIDER env (vesszővel; pl. „echolot,capsolver"),
// az első sikeres nyer. Ha egy név még nincs regisztrálva, LUSTÁN betöltjük a
// `./<név>-provider.js` modult (pl. a saját „echolot" szolgáltató a
// src/captcha/echolot-provider.js-ben — azt egy MÁSIK sáv írja; a modul vagy
// maga hívja a registerProvider-t, vagy default exportként adja az impl-t).
//
// Beépített fizetős szolgáltatók: capsolver, 2captcha (createTask /
// getTaskResult protokoll; turnstile → token, text → kép-szöveg). Kulcs:
// CAPTCHA_SOLVER_KEY_<NÉV> (pl. CAPTCHA_SOLVER_KEY_CAPSOLVER), ennek hiányában
// CAPTCHA_SOLVER_KEY. Kulcs nélkül inaktívak, és a /health kimondja. A kulcsot
// SOHA nem naplózzuk, nem adjuk vissza, és a hibaszövegekből is kitakarjuk.
// ⚠ A fizetős adapterek élő szolgáltatón NINCSENEK kipróbálva (kulcs nincs) —
// csak helyi álszolgáltatón (test/captcha-provider.test.js).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const KINDS = Object.freeze(['text', 'math', 'image_grid', 'audio', 'turnstile']);
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const PROVIDERS = new Map();
const LOAD_ERRORS = new Map();

export function registerProvider(name, impl) {
  name = String(name || '').trim().toLowerCase();
  if (!NAME_RE.test(name)) throw new Error(`captcha provider: érvénytelen név: ${name}`);
  if (!impl || typeof impl.solve !== 'function') throw new Error(`captcha provider ${name}: solve() kell`);
  PROVIDERS.set(name, impl);
  LOAD_ERRORS.delete(name);
  return () => { if (PROVIDERS.get(name) === impl) PROVIDERS.delete(name); };
}

export function unregisterProvider(name) {
  PROVIDERS.delete(String(name || '').trim().toLowerCase());
}

export function providerOrder(env = process.env) {
  const out = [];
  for (const raw of String(env.CAPTCHA_SOLVER_PROVIDER || '').split(',')) {
    const n = raw.trim().toLowerCase();
    if (n && n !== 'none' && NAME_RE.test(n) && !out.includes(n)) out.push(n);
  }
  return out;
}

export function providerKey(name, env = process.env) {
  const k = env[`CAPTCHA_SOLVER_KEY_${String(name).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] || env.CAPTCHA_SOLVER_KEY || '';
  return String(k).trim();
}

// Lusta betöltés: ./<név>-provider.js, ha létezik (a név szigorúan szűrt).
async function ensureLoaded(name) {
  if (PROVIDERS.has(name) || LOAD_ERRORS.has(name)) return PROVIDERS.get(name) || null;
  const file = path.join(HERE, `${name}-provider.js`);
  if (!fs.existsSync(file)) { LOAD_ERRORS.set(name, 'not_found'); return null; }
  try {
    const mod = await import(file);
    if (!PROVIDERS.has(name)) {
      const impl = mod.default || mod.provider;
      if (impl && typeof impl.solve === 'function') registerProvider(name, impl);
    }
    if (!PROVIDERS.has(name)) LOAD_ERRORS.set(name, 'not_registered');
  } catch (e) {
    LOAD_ERRORS.set(name, `load_error: ${String(e?.message || e).slice(0, 120)}`);
  }
  return PROVIDERS.get(name) || null;
}

// Induláskor (best-effort): a /health már a valós regisztrációt mutassa.
export async function preloadProviders(env = process.env) {
  for (const n of providerOrder(env)) await ensureLoaded(n);
}

function configuredOf(name, impl, env) {
  try {
    const c = typeof impl.configured === 'function' ? impl.configured(env) : { ok: true };
    return c && typeof c === 'object' ? { ok: !!c.ok, reason: c.reason || null } : { ok: !!c, reason: null };
  } catch (e) {
    return { ok: false, reason: 'configured_threw' };
  }
}

// A kulcs (és bármely beállított CAPTCHA_SOLVER_KEY*) kitakarása egy szövegből.
export function redactKeys(s, env = process.env) {
  let out = String(s ?? '');
  for (const [k, v] of Object.entries(env)) {
    if (/^CAPTCHA_SOLVER_KEY/.test(k) && v && String(v).length >= 4) out = out.split(String(v)).join('***');
  }
  return out;
}

const withTimeout = (p, ms) => (ms > 0
  ? Promise.race([p, new Promise((_, rej) => { const t = setTimeout(() => rej(new Error('solver_timeout')), ms); t.unref?.(); })])
  : p);

export async function solveCaptcha({ kind, page = null, frame = null, meta = {}, purpose, env = process.env, timeoutMs = 0 } = {}) {
  const t0 = Date.now();
  const ms = () => Date.now() - t0;
  if (purpose !== 'read') return { ok: false, provider: null, ms: 0, tried: [], error: 'purpose_not_allowed' };
  if (!KINDS.includes(kind)) return { ok: false, provider: null, ms: 0, tried: [], error: 'unknown_kind' };
  const order = providerOrder(env);
  if (!order.length) return { ok: false, provider: null, ms: 0, tried: [], error: 'no_provider_configured' };
  const tried = [];
  for (const name of order) {
    const impl = await ensureLoaded(name);
    if (!impl) { tried.push({ provider: name, skipped: LOAD_ERRORS.get(name) || 'not_registered' }); continue; }
    if (Array.isArray(impl.kinds) && !impl.kinds.includes(kind)) { tried.push({ provider: name, skipped: 'kind_unsupported' }); continue; }
    const cfg = configuredOf(name, impl, env);
    if (!cfg.ok) { tried.push({ provider: name, skipped: cfg.reason || 'not_configured' }); continue; }
    const p0 = Date.now();
    try {
      const r = await withTimeout(Promise.resolve(impl.solve({
        kind, page, frame, meta: meta || {}, purpose, env, key: providerKey(name, env),
      })), timeoutMs);
      const one = { provider: name, ok: !!r?.ok, ms: Date.now() - p0 };
      if (r?.cost_usd != null) one.cost_usd = r.cost_usd;
      if (!r?.ok && r?.error) one.error = redactKeys(String(r.error).slice(0, 200), env);
      tried.push(one);
      if (r?.ok) {
        const out = { ok: true, provider: name, ms: ms(), tried };
        if (r.answer !== undefined) out.answer = r.answer;
        if (Array.isArray(r.actions)) out.actions = r.actions;
        if (r.cost_usd != null) out.cost_usd = r.cost_usd;
        return out;
      }
    } catch (e) {
      tried.push({ provider: name, ok: false, ms: Date.now() - p0, error: redactKeys(String(e?.message || e).slice(0, 200), env) });
    }
  }
  return { ok: false, provider: null, ms: ms(), tried, error: 'no_provider_solved' };
}

// /health: hálózat nélkül; a kulcsot sosem adja ki (csak hogy BE van-e állítva).
export function captchaSolverHealth(env = process.env) {
  const order = providerOrder(env);
  const providers = order.map((name) => {
    const impl = PROVIDERS.get(name);
    if (!impl) return { name, registered: false, active: false, reason: LOAD_ERRORS.get(name) || 'not_loaded' };
    const cfg = configuredOf(name, impl, env);
    return {
      name, registered: true, active: cfg.ok,
      ...(Array.isArray(impl.kinds) ? { kinds: [...impl.kinds] } : {}),
      ...(cfg.ok ? {} : { reason: cfg.reason || 'not_configured' }),
    };
  });
  return {
    active: providers.some(p => p.active),
    order,
    providers,
    purpose_gate: 'read',
    ...(order.length ? {} : { reason: 'CAPTCHA_SOLVER_PROVIDER not set' }),
  };
}

// ─── Beépített fizetős adapterek (createTask / getTaskResult) ─────────────
// Mindkét szolgáltató ugyanazt a JSON-protokollt beszéli: POST /createTask
// {clientKey, task} → {errorId, taskId}; POST /getTaskResult {clientKey, taskId}
// → {status: 'processing'|'ready', solution}. A kulcs a TÖRZSBEN megy, URL-ben soha.
const PAID = {
  capsolver: {
    base: 'https://api.capsolver.com',
    task: {
      turnstile: (m) => ({ type: 'AntiTurnstileTaskProxyLess', websiteURL: m.url, websiteKey: m.sitekey,
        ...(m.action || m.cdata ? { metadata: { ...(m.action ? { action: m.action } : {}), ...(m.cdata ? { cdata: m.cdata } : {}) } } : {}) }),
      text: (m) => ({ type: 'ImageToTextTask', body: m.imageBase64 }),
    },
    answer: { turnstile: (s) => s?.token, text: (s) => s?.text },
  },
  '2captcha': {
    base: 'https://api.2captcha.com',
    task: {
      turnstile: (m) => ({ type: 'TurnstileTaskProxyless', websiteURL: m.url, websiteKey: m.sitekey,
        ...(m.action ? { action: m.action } : {}), ...(m.cdata ? { data: m.cdata } : {}), ...(m.userAgent ? { userAgent: m.userAgent } : {}) }),
      text: (m) => ({ type: 'ImageToTextTask', body: m.imageBase64 }),
    },
    answer: { turnstile: (s) => s?.token, text: (s) => s?.text },
  },
};

function paidProvider(name, spec) {
  return {
    kinds: Object.keys(spec.task),
    configured(env) {
      return providerKey(name, env) ? { ok: true } : { ok: false, reason: 'no_key' };
    },
    async solve({ kind, meta, key, env }) {
      const mk = spec.task[kind];
      if (!mk) return { ok: false, error: 'kind_unsupported' };
      if (kind === 'turnstile' && (!meta.sitekey || !meta.url)) return { ok: false, error: 'missing_sitekey_or_url' };
      // CF challenge-oldal: a sima Turnstile-token itt nem visz át (cData /
      // chlPageData kellene) → nem költünk rá.
      if (kind === 'turnstile' && meta.challenge_page) return { ok: false, error: 'challenge_page_unsupported' };
      if (kind === 'text' && !meta.imageBase64) return { ok: false, error: 'missing_image' };
      // Teszt-felülírás (helyi álszolgáltató): CAPTCHA_SOLVER_BASE_URL.
      const base = String(env.CAPTCHA_SOLVER_BASE_URL || spec.base).replace(/\/+$/, '');
      const pollMs = Math.max(50, parseInt(env.CAPTCHA_SOLVER_POLL_MS || '3000', 10) || 3000);
      const maxMs = Math.max(1000, parseInt(env.CAPTCHA_SOLVER_MAX_MS || '90000', 10) || 90000);
      const post = async (p, body) => {
        const r = await fetch(`${base}${p}`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ clientKey: key, ...body }), signal: AbortSignal.timeout(20000),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j.errorId) throw new Error(`${name}: ${j.errorCode || 'http_' + r.status} ${String(j.errorDescription || '').slice(0, 100)}`);
        return j;
      };
      const created = await post('/createTask', { task: mk(meta) });
      // Néhány szolgáltató azonnal válaszol (ImageToText).
      if (created.status === 'ready' && created.solution) {
        const a = spec.answer[kind](created.solution);
        return a ? { ok: true, answer: a, cost_usd: created.cost ? Number(created.cost) : undefined } : { ok: false, error: 'empty_solution' };
      }
      const taskId = created.taskId;
      if (!taskId) return { ok: false, error: 'no_task_id' };
      const t0 = Date.now();
      while (Date.now() - t0 < maxMs) {
        await new Promise(r => setTimeout(r, pollMs));
        const res = await post('/getTaskResult', { taskId });
        if (res.status === 'ready') {
          const a = spec.answer[kind](res.solution);
          return a ? { ok: true, answer: a, cost_usd: res.cost ? Number(res.cost) : undefined } : { ok: false, error: 'empty_solution' };
        }
        if (res.status && res.status !== 'processing' && res.status !== 'idle') return { ok: false, error: `status_${res.status}` };
      }
      return { ok: false, error: 'timeout' };
    },
  };
}

for (const [name, spec] of Object.entries(PAID)) registerProvider(name, paidProvider(name, spec));
