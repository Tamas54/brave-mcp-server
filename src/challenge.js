// JS-challenge / interstitial felismerés, kivárás és (flag mögött) checkbox-
// kattintás — W2 „falon át", 2026-10-07.
//
// Részben portolva: D4Vinci/Scrapling @ 43dee00 (v0.4.15) — BSD-3-Clause,
// Copyright (c) 2024, Karim shoair. Átvett elemek (JS-re átírva):
//   * scrapling/engines/_browsers/_base.py `_detect_cloudflare` — a `cType:
//     '<non-interactive|managed|interactive>'` jelölő és a Turnstile-szkript
//     (challenges.cloudflare.com/turnstile/v) mint challenge-típus;
//   * scrapling/engines/_browsers/_stealth.py `_cloudflare_solver` — a Turnstile-
//     iframe (challenge-platform URL) keret-elemének doboza + a checkbox helye a
//     doboz bal felső sarkától (+26..28, +25..27 px), a tartalék szelektorok
//     (`#cf_turnstile div, #cf-turnstile div, .turnstile>div>div`,
//     `.main-content p+div>div>div`), legfeljebb 3 próbálkozás.
// A Scrapling neve promócióra nem használható (BSD-3, 3. pont). A teljes
// licencszöveg a repó THIRD_PARTY_NOTICES.md fájljában.
//
// Saját: a többi gyártó (DataDome, PerimeterX/HUMAN, Imperva, Akamai) jelölői,
// a fal (block) ↔ kivárható challenge ↔ interaktív challenge szétválasztás, a
// határidő-tudatos kivárás navigáció-figyeléssel, az emberi kattintás
// (stealth/humanize.js), a megoldó-horog (captcha/provider.js) és a clearance-
// sütik szűrése.
//
// ⛔ HATÁR: kattintás és megoldó CSAK `purpose === 'read'` mellett (scrape /
// crawl). A brave_page ezt a modult nem hívja (a C2 saját megoldója az egyszeri
// `purpose:"read"` brave_page-hívásban a captcha/read-path.js-en át fut —
// munkamenetben soha).
// 2026-10-08 (rel-wall): reCAPTCHA v2 / hCaptcha + engedélyezett C2 → a W2 nem
// kattint, azonnal átad (captchaHandoff, SOLVER_HANDOFF_TYPES).

import { solveCaptcha, captchaSolverHealth } from './captcha/provider.js';

const envInt = (env, k, d, lo, hi) => {
  const v = parseInt(env?.[k] ?? '', 10);
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
};

export function challengeConfig(env = process.env) {
  return {
    // 0 = KI: a scrape a régi viselkedésre áll vissza (csak a stealth-szint
    // régi 8 s-os CF-várakozása marad).
    waitMs: envInt(env, 'CHALLENGE_WAIT_MS', 15000, 0, 60000),
    // Olyan interaktív challenge, amit nem tudunk megoldani (DataDome-csúszka,
    // PX „Press & Hold", checkbox CHALLENGE_SOLVE nélkül): csak ennyit várunk,
    // hátha a JS magától továbbenged.
    interactiveWaitMs: envInt(env, 'CHALLENGE_INTERACTIVE_WAIT_MS', 5000, 0, 60000),
    pollMs: envInt(env, 'CHALLENGE_POLL_MS', 500, 100, 5000),
    // Ha a scrape-kapura mások várnak, ennyi után elengedjük a slotot.
    busyWaitMs: envInt(env, 'CHALLENGE_BUSY_WAIT_MS', 5000, 0, 60000),
    solve: /^(1|true|on|yes)$/i.test(String(env.CHALLENGE_SOLVE || '').trim()),
    clearanceTtlMs: envInt(env, 'CHALLENGE_CLEARANCE_TTL_MS', 25 * 60 * 1000, 0, 24 * 3600 * 1000),
  };
}

export function challengeHealth(env = process.env) {
  const c = challengeConfig(env);
  return {
    wait: c.waitMs > 0,
    wait_ms: c.waitMs,
    interactive_wait_ms: c.interactiveWaitMs,
    busy_wait_ms: c.busyWaitMs,
    solve: c.solve,
    clearance_reuse: c.waitMs > 0 && c.clearanceTtlMs > 0,
  };
}

// ─── Felismerés (nyers HTML-ből, olcsó) ─────────────────────────────────
// Visszaad: null | { type, vendor, interactive, block, ctype? }
//   block       — végleges fal (nincs mit kivárni: azonnal passed:false)
//   interactive — emberi lépés kell (checkbox, csúszka, nyomva tartás)
// KONZERVATÍV: a normál, Cloudflare mögötti lapok is betöltik a
// /cdn-cgi/challenge-platform/scripts/jsd/main.js-t és mutatják a „Ray ID"-t —
// ezek önmagukban NEM challenge-jelek.
const CF_TITLE_RE = /<title[^>]*>\s*(Just a moment\.\.\.|Checking your browser|Please wait\.\.\.|Egy pillanat|Einen Moment|Un instant|Un momento|Один момент|Even geduld|Chwileczkę|Bir dakika|Um momento)/i;
const CF_MARKER_RE = /_cf_chl_opt|\/cdn-cgi\/challenge-platform\/h\/[a-z]\/orchestrate\/(chl_page|managed|jsch|captcha)|id=["']challenge-(running|form|stage|body-text|error-text)["']|class=["'][^"']*\bcf-browser-verification\b/i;
const CF_TEXT_RE = /Checking your browser before accessing|Verifying you are human\. This may take a few seconds|needs to review the security of your connection before proceeding|Performing security verification/i;

function visibleTextLen(html) {
  return String(html)
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim().length;
}

export function detectChallengeHtml(html) {
  if (!html || typeof html !== 'string') return null;
  const head = html.length > 400000 ? html.slice(0, 400000) : html;

  // Cloudflare — végleges tiltás (1020 / „Sorry, you have been blocked").
  if (/cf-error-details|cf-error-code/i.test(head) && /you have been blocked|Access denied|Error 10\d\d/i.test(head)) {
    return { type: 'cloudflare_block', vendor: 'cloudflare', interactive: false, block: true };
  }
  // Cloudflare — interstitial („Just a moment…", managed / non-interactive / interactive).
  const ctype = (head.match(/cType:\s*['"](non-interactive|managed|interactive)['"]/) || [])[1] || null;
  const cfTitle = CF_TITLE_RE.test(head);
  if (ctype || CF_MARKER_RE.test(head) || (cfTitle && /cf-chl|cf_chl|challenge-platform\/h\//i.test(head)) ||
      (CF_TEXT_RE.test(head) && visibleTextLen(head) < 3000)) {
    const interactive = ctype === 'managed' || ctype === 'interactive' ||
      /challenges\.cloudflare\.com\/turnstile|\/turnstile\/(if|v0)\/|cf-turnstile|Verify you are human/i.test(head);
    return { type: 'cloudflare_interstitial', vendor: 'cloudflare', interactive, block: false, ...(ctype ? { ctype } : {}) };
  }
  // DataDome — 'rt': 'i' interstitial (JS-eszközellenőrzés, magától továbbenged),
  // 'c' captcha (csúszka); 't': 'bv' = tiltott látogató (végleges).
  if (/captcha-delivery\.com/i.test(head) && (/var\s+dd\s*=\s*\{/.test(head) || /<iframe[^>]+captcha-delivery\.com/i.test(head))) {
    const rt = (head.match(/['"]rt['"]\s*:\s*['"](\w)['"]/) || [])[1] || '';
    const t = (head.match(/['"]t['"]\s*:\s*['"](\w+)['"]/) || [])[1] || '';
    if (t === 'bv') return { type: 'datadome_block', vendor: 'datadome', interactive: false, block: true };
    if (rt === 'i') return { type: 'datadome_interstitial', vendor: 'datadome', interactive: false, block: false };
    return { type: 'datadome_captcha', vendor: 'datadome', interactive: true, block: false };
  }
  // PerimeterX / HUMAN — „Press & Hold".
  if (/id=["']px-captcha["']/i.test(head) || /captcha\.px-cd[n]\.net|px-cloud\.net\/[^"']*captcha/i.test(head) ||
      (/_pxAppId/.test(head) && /Access to this page has been denied|Press (&amp;|&) Hold/i.test(head))) {
    return { type: 'perimeterx', vendor: 'perimeterx', interactive: true, block: false };
  }
  // Imperva / Incapsula.
  if (/Incapsula incident ID|Request unsuccessful\. Incapsula/i.test(head)) {
    return { type: 'imperva_block', vendor: 'imperva', interactive: false, block: true };
  }
  if (/_Incapsula_Resource/i.test(head) || (/Pardon Our Interruption/i.test(head) && visibleTextLen(head) < 3000)) {
    return { type: 'imperva_interstitial', vendor: 'imperva', interactive: false, block: false };
  }
  // Akamai — sec-cpt challenge (magától továbbenged) / Access Denied (végleges).
  if (/\/_sec\/cp_challenge\//.test(head)) {
    return { type: 'akamai_challenge', vendor: 'akamai', interactive: false, block: false };
  }
  if (/errors\.edgesuite\.net|<title>\s*Access Denied\s*<\/title>[\s\S]{0,2000}Reference\s*#/i.test(head) && visibleTextLen(head) < 1500) {
    return { type: 'akamai_block', vendor: 'akamai', interactive: false, block: true };
  }
  // „Kapu"-lapok: rövid lap egy checkbox-widgettel (Turnstile / reCAPTCHA v2 /
  // hCaptcha). Egy hosszú cikk alján ülő űrlap-widget NEM kapu.
  const shortPage = visibleTextLen(head) < 1500;
  // A widget-ELEM kell (a puszta api.js-szkript nem kapu: pl. egy átengedett
  // CF-lap is betöltheti — mérve: scrapingcourse „You bypassed…" oldala).
  if (shortPage && (/class=["'][^"']*\bcf-turnstile\b/i.test(head) ||
      (/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js/i.test(head) && /data-sitekey=/i.test(head)))) {
    return { type: 'turnstile_gate', vendor: 'cloudflare', interactive: true, block: false };
  }
  if (shortPage && /class=["'][^"']*\bg-recaptcha\b[^>]*data-sitekey|data-sitekey[^>]*class=["'][^"']*\bg-recaptcha\b/i.test(head)) {
    return { type: 'recaptcha_gate', vendor: 'google', interactive: true, block: false };
  }
  if (shortPage && /class=["'][^"']*\bh-captcha\b[^>]*data-sitekey|data-sitekey[^>]*class=["'][^"']*\bh-captcha\b/i.test(head)) {
    return { type: 'hcaptcha_gate', vendor: 'hcaptcha', interactive: true, block: false };
  }
  return null;
}

// Amik magától (JS) is továbbengedhetnek → a teljes várakozási keret jár nekik.
const AUTO_PASS_TYPES = new Set(['cloudflare_interstitial', 'datadome_interstitial', 'imperva_interstitial', 'akamai_challenge']);
// Mely challenge-eken van értelme a checkbox-kattintásnak.
const CHECKBOX_TYPES = new Set(['cloudflare_interstitial', 'turnstile_gate', 'recaptcha_gate', 'hcaptcha_gate']);

// ─── Átadás a C2 saját megoldójának — 2026-10-08 (rel-wall) ─────────────
// Koordinátori döntés: reCAPTCHA v2 és hCaptcha típusnál, ha a C2 megoldó
// engedélyezett (CAPTCHA_SOLVER_ENABLED) ÉS az út olvasási, a W2 NEM kattint a
// jelölőnégyzetre és NEM várja ki a 15 s-os keretet (az a C2 idejét enné meg),
// hanem azonnal átadja a vezérlést a src/captcha/read-path.js
// solveOnReadPath-jának (a hívó futtatja, lásd brave-controller _scrapeOnce).
// A Cloudflare/Turnstile és a többi interstitial a W2-é marad. Kikapcsolt C2
// mellett a W2 régi viselkedése él (CHALLENGE_SOLVE=1 → checkbox-kattintás).
export const SOLVER_HANDOFF_TYPES = new Set(['recaptcha_gate', 'hcaptcha_gate']);

export function captchaHandoff(det, { solverEnabled = false, purpose } = {}) {
  return !!(det && solverEnabled && purpose === 'read' && SOLVER_HANDOFF_TYPES.has(det.type));
}

// ─── Checkbox keresése (keretek + tartalék szelektorok) ─────────────────
const TURNSTILE_FRAME_RE = /\/cdn-cgi\/challenge-platform\/[^?#]*turnstile|^https?:\/\/challenges\.cloudflare\.com\/cdn-cgi\/challenge-platform\//i;
const RECAPTCHA_ANCHOR_RE = /\/recaptcha\/(api2|enterprise)\/anchor/i;
const RECAPTCHA_GRID_RE = /\/recaptcha\/(api2|enterprise)\/bframe/i;
const HCAPTCHA_CHECKBOX_RE = /hcaptcha\.com\/captcha\/v1\/[^#]*#frame=checkbox|#frame=checkbox[^#]*hcaptcha/i;
const HCAPTCHA_GRID_RE = /hcaptcha\.com\/captcha\/v1\/[^#]*#frame=challenge/i;
const SITEKEY_RE = /\/(0x[0-9A-Za-z_-]{16,})(?:\/|$)/;

async function visibleBox(handle) {
  try {
    const b = await handle.boundingBox();
    return b && b.width > 4 && b.height > 4 ? b : null;
  } catch (_) { return null; }
}

// A Turnstile-keret checkboxa — CSAK ha valóban kint van. A widget előbb
// „Verifying…" állapotban fut (nem-interaktív próba), a checkbox csak akkor
// jelenik meg, ha az elbukott; a pörgő jelre kattintani hiába (mérve, 10-07).
// A keret jellemzően OOPIF (challenges.cloudflare.com, saját CDP-célpont), a
// checkbox ZÁRT shadow-gyökérben ül → DOM.getDocument({pierce:true}) a keret
// saját munkamenetén. Azonos folyamatú keretnél (helyi fixtúra) frame.$().
// Vissza: { ready: true, box } | { ready: false } | { ready: null } (nem mérhető).
async function turnstileCheckboxState(page, frame, frameBox) {
  try {
    const el = await frame.$('input[type="checkbox"]');
    const b = el ? await visibleBox(el) : null;
    if (b) return { ready: true, box: { x: b.x + 2, y: b.y + 2, width: Math.min(20, b.width - 4), height: Math.max(4, b.height - 4) } };
  } catch (_) { /* OOPIF / zárt gyökér — lent CDP-vel */ }
  let target = null;
  try { target = page.browser().targets().find(t => t.url() === frame.url()) || null; } catch (_) { /* */ }
  if (!target) return { ready: null };
  let s = null;
  try {
    s = await target.createCDPSession();
    const { root } = await s.send('DOM.getDocument', { depth: -1, pierce: true });
    let id = null;
    const walk = (n) => {
      if (id) return;
      if (n.nodeName === 'INPUT') {
        const a = n.attributes || [];
        const i = a.indexOf('type');
        if (i >= 0 && a[i + 1] === 'checkbox') { id = n.backendNodeId; return; }
      }
      for (const k of [...(n.children || []), ...(n.shadowRoots || []), ...(n.contentDocument ? [n.contentDocument] : [])]) walk(k);
    };
    walk(root);
    if (!id) return { ready: false };
    const { model } = await s.send('DOM.getBoxModel', { backendNodeId: id });
    const q = model.content;   // a keret saját nézetablakában → + a keret-elem doboza
    const x = frameBox.x + q[0], y = frameBox.y + q[1], w = q[2] - q[0], h = q[5] - q[1];
    if (!(w > 2 && h > 2)) return { ready: false };
    // A checkbox-négyzet a vezérlő BAL szélén (a széles input a feliratot is fedi).
    return { ready: true, box: { x: x + 2, y: y + 2, width: Math.min(20, w - 4), height: Math.max(4, h - 4) } };
  } catch (_) {
    return { ready: null };
  } finally {
    if (s) s.detach().catch(() => {});
  }
}

export async function findCheckbox(page) {
  let frames = [];
  try { frames = page.frames(); } catch (_) { /* lap zárult */ }
  for (const f of frames) {
    let u = '';
    try { u = f.url(); } catch (_) { continue; }
    if (TURNSTILE_FRAME_RE.test(u)) {
      try {
        const el = await f.frameElement();
        const box = el ? await visibleBox(el) : null;
        if (box) {
          const st = await turnstileCheckboxState(page, f, box);
          return { target: 'turnstile', frame: f, frameBox: box, sitekey: (u.match(SITEKEY_RE) || [])[1] || null, ready: st.ready,
            // Ha nem mérhető: a checkbox a widget bal felső sarkától (Scrapling: +26..28, +25..27).
            box: st.box || { x: box.x + 25, y: box.y + 24, width: 4, height: 4 } };
        }
      } catch (_) { /* a keret közben cserélődött */ }
    }
    if (RECAPTCHA_ANCHOR_RE.test(u)) {
      try {
        const el = await f.$('#recaptcha-anchor');
        const box = el ? await visibleBox(el) : null;
        if (box) return { target: 'recaptcha', frame: f, box, ready: true, sitekey: (u.match(/[?&]k=([^&]+)/) || [])[1] || null };
      } catch (_) { /* */ }
    }
    if (HCAPTCHA_CHECKBOX_RE.test(u)) {
      try {
        const el = await f.$('#checkbox');
        const box = el ? await visibleBox(el) : null;
        if (box) return { target: 'hcaptcha', frame: f, box, ready: true, sitekey: (u.match(/sitekey=([^&]+)/) || [])[1] || null };
      } catch (_) { /* */ }
    }
  }
  // Tartalék: a widget-tároló (a Turnstile zárt shadow-gyökérben is ülhet).
  for (const sel of ['#cf_turnstile div', '#cf-turnstile div', '.cf-turnstile div', '.turnstile>div>div', '.main-content p+div>div>div']) {
    try {
      const els = await page.$$(sel);
      const el = els[els.length - 1];
      const box = el ? await visibleBox(el) : null;
      if (box) return { target: 'turnstile', frame: null, frameBox: box, ready: null, box: { x: box.x + 25, y: box.y + 24, width: 4, height: 4 }, sitekey: null };
    } catch (_) { /* */ }
  }
  return null;
}

// Látható rács-challenge (reCAPTCHA bframe / hCaptcha challenge) — a saját
// megoldó (image_grid) bemenete.
async function findGridFrame(page) {
  let frames = [];
  try { frames = page.frames(); } catch (_) { return null; }
  for (const f of frames) {
    let u = '';
    try { u = f.url(); } catch (_) { continue; }
    const vendor = RECAPTCHA_GRID_RE.test(u) ? 'recaptcha' : HCAPTCHA_GRID_RE.test(u) ? 'hcaptcha' : null;
    if (!vendor) continue;
    try {
      const el = await f.frameElement();
      const box = el ? await visibleBox(el) : null;
      if (box && box.height > 100) return { vendor, frame: f, box };
    } catch (_) { /* */ }
  }
  return null;
}

async function pageSitekey(page) {
  try {
    return await page.evaluate(() => {
      const el = document.querySelector('[data-sitekey]');
      return el ? { sitekey: el.getAttribute('data-sitekey'), action: el.getAttribute('data-action'), cdata: el.getAttribute('data-cdata') } : null;
    });
  } catch (_) { return null; }
}

// Megoldó-token beírása a válaszmezőkbe + a widget data-callback-je.
export async function injectToken(page, token) {
  return page.evaluate((tok) => {
    let n = 0;
    for (const name of ['cf-turnstile-response', 'g-recaptcha-response', 'h-captcha-response']) {
      for (const el of document.querySelectorAll(`[name="${name}"]`)) { el.value = tok; n++; }
    }
    const w = document.querySelector('[data-callback]');
    const cb = w && w.getAttribute('data-callback');
    if (cb && typeof window[cb] === 'function') { try { window[cb](tok); return 'callback'; } catch (e) { return 'callback_error'; } }
    return n ? 'field' : 'none';
  }, String(token)).catch(() => 'error');
}

// Szolgáltató által visszaadott lépések végrehajtása (emberi bemenettel).
export async function performActions(page, actions, human) {
  let done = 0;
  for (const a of (actions || []).slice(0, 50)) {
    if (!a || typeof a !== 'object') continue;
    if (a.type === 'wait') { await sleep(Math.min(5000, Math.max(0, Number(a.ms) || 0))); done++; continue; }
    if (a.type === 'click') {
      if (Number.isFinite(a.x) && Number.isFinite(a.y)) { await human.click(page, a.x, a.y); done++; continue; }
      if (typeof a.selector === 'string') {
        const ctx = a.frame || page;
        const el = await ctx.$(a.selector).catch(() => null);
        const box = el ? await visibleBox(el) : null;
        if (box) { await human.clickBox(page, box); done++; }
      }
      continue;
    }
    if (a.type === 'type' && typeof a.text === 'string') {
      if (typeof a.selector === 'string') {
        const ctx = a.frame || page;
        const el = await ctx.$(a.selector).catch(() => null);
        const box = el ? await visibleBox(el) : null;
        if (box) await human.clickBox(page, box);
      }
      const r = await human.type(page, a.text.slice(0, 200), { budgetMs: 8000 });
      if (!r.humanized) await page.keyboard.type(a.text.slice(0, 200));
      done++;
    }
  }
  return done;
}

const sleep = (ms) => new Promise(r => setTimeout(r, Math.max(0, ms)));

async function readHtml(page) {
  try { return await page.content(); } catch (_) { return null; }   // navigáció közben: kontextus nincs
}

// ─── Kivárás + (flag mögött) megoldás ───────────────────────────────────
// first: a detectChallengeHtml eredménye a betöltött lapon.
// opts: { waitMs, interactiveWaitMs, pollMs, deadlineTs, solve, purpose, human,
//         humanizeIdle, busy?() → bool, busyWaitMs, env,
//         captchaHandoff?: bool — a C2 megoldó engedélyezett (lásd captchaHandoff()) }
// Vissza: { info: {type, vendor, interactive, waited_ms, passed, navigations,
//           blocked?, final_type?, cut?: 'deadline'|'busy', widget_solved?, solve?,
//           solver?, handoff?: 'captcha_solver'}, html }
// handoff: a W2 nem nyúlt a widgethez — az átjutásról a hívó dönt a C2 után.
export async function handleChallenge(page, first, opts = {}) {
  const t0 = Date.now();
  const env = opts.env || process.env;
  const readPath = opts.purpose === 'read';
  const solveOn = !!opts.solve && readPath && !!opts.human;
  const solverHealth = readPath ? captchaSolverHealth(env) : { active: false };
  const handoff = (d) => captchaHandoff(d, { solverEnabled: !!opts.captchaHandoff, purpose: opts.purpose });
  const info = { type: first.type, vendor: first.vendor, interactive: !!first.interactive, waited_ms: 0, passed: false, navigations: 0 };
  if (first.ctype) info.ctype = first.ctype;
  if (first.block) {
    info.blocked = true;
    return { info, html: null };
  }
  // reCAPTCHA v2 / hCaptcha + aktív C2: azonnali átadás (0 ms, kattintás nélkül).
  if (handoff(first)) {
    info.handoff = 'captcha_solver';
    return { info, html: null };
  }
  // Teljes keret: ami magától is továbbengedhet (a CF „managed" is gyakran
  // kattintás nélkül megy át), vagy amin tudunk lépni (checkbox / megoldó).
  const canAct = (solveOn && CHECKBOX_TYPES.has(first.type)) || solverHealth.active;
  const full = !first.interactive || AUTO_PASS_TYPES.has(first.type) || canAct;
  const budget = full ? opts.waitMs : Math.min(opts.waitMs, opts.interactiveWaitMs ?? opts.waitMs);
  const budgetEnd = t0 + Math.max(0, budget);
  let end = budgetEnd;
  if (opts.deadlineTs) end = Math.min(end, opts.deadlineTs);
  const busyWaitMs = opts.busyWaitMs ?? 5000;
  const pollMs = opts.pollMs || 500;

  let navs = 0;
  let mainFrame = null;
  try { mainFrame = page.mainFrame(); } catch (_) { /* */ }
  const onNav = (fr) => { if (fr === mainFrame) navs++; };
  try { page.on('framenavigated', onNav); } catch (_) { /* */ }

  const solve = { attempted: false, clicks: 0, target: null };
  let lastClickTs = 0;
  let lastIdleTs = t0;
  let solverTried = false;
  let checkboxMissing = false;
  let html = null;
  let cur = first;
  try {
    for (;;) {
      const rem = end - Date.now();
      if (rem <= 0) { if (end < budgetEnd) info.cut = 'deadline'; break; }
      // Terhelés alatt (a scrape-kapura mások várnak) legfeljebb busyWaitMs-ig
      // tartjuk a slotot — egy challenge-fal ne éheztesse ki a többi scrape-et.
      if (opts.busy && Date.now() - t0 >= busyWaitMs && opts.busy()) { info.cut = 'busy'; break; }
      await sleep(Math.min(pollMs, rem));
      html = await readHtml(page);
      if (html === null) continue;                     // navigáció folyik
      cur = detectChallengeHtml(html);
      if (!cur) { info.passed = true; break; }
      if (cur.block) { info.blocked = true; info.final_type = cur.type; break; }
      if (cur.type !== first.type) info.final_type = cur.type;
      // A kivárás közben reCAPTCHA/hCaptcha-kapuvá vált (pl. interstitial után):
      // innen a C2-é — a W2 itt sem kattint, és nem égeti tovább a keretet.
      if (handoff(cur)) { info.handoff = 'captcha_solver'; break; }
      const elapsed = Date.now() - t0;

      // Emberi „fészkelődés" a várakozás alatt (HUMANIZE=1).
      if (opts.humanizeIdle && opts.human && Date.now() - lastIdleTs > 1800 && end - Date.now() > 800) {
        lastIdleTs = Date.now();
        await opts.human.idle(page).catch(() => {});
      }

      // Checkbox (Turnstile / reCAPTCHA / hCaptcha): a non-interactive ág kapjon
      // ~1,5 s-ot magától, utána legfeljebb 3 kattintás, ≥ 4 s-os közzel.
      if (solveOn && CHECKBOX_TYPES.has(cur.type) && solve.clicks < 3 && elapsed > 1500 &&
          Date.now() - lastClickTs > 4000 && end - Date.now() > 1500) {
        const cb = await findCheckbox(page);
        // Csak a KINT LÉVŐ checkboxra kattintunk; ha az állapot nem mérhető
        // (ready: null), a Scrapling-féle eltolással, de csak 6 s után.
        if (cb && (cb.ready === true || (cb.ready === null && elapsed > 6000))) {
          solve.attempted = true;
          solve.target = cb.target;
          try {
            const r = await opts.human.clickBox(page, cb.box, { targetW: 24 });
            solve.clicks++;
            solve.move_events = (solve.move_events || 0) + (r.move_events || 0);
          } catch (e) { solve.error = String(e?.message || e).slice(0, 120); }
          lastClickTs = Date.now();
          continue;
        }
        if (!cb) checkboxMissing = true;
        else solve.waiting_for_checkbox = true;
      }

      // Kapu-widget (beágyazott Turnstile / reCAPTCHA / hCaptcha) megoldva: a
      // válaszmezőben token van — a lap a saját JS-ével mehet tovább; ha nem
      // megy, a hívó ezt látja (widget_solved, de passed:false).
      if (/_gate$/.test(cur.type) && !info.widget_solved) {
        const tok = await page.evaluate(() => Array.from(document.querySelectorAll(
          '[name="cf-turnstile-response"],[name="g-recaptcha-response"],[name="h-captcha-response"]'))
          .some(e => (e.value || '').length > 10)).catch(() => false);
        if (tok) { info.widget_solved = true; info.widget_solved_at = Date.now() - t0; }
      }
      // Megoldott kapu-widget, de a lap nem lép tovább magától: 2,5 s türelem,
      // utána a challenge ÁTJUTOTTNAK számít (a lap tartalma az, ami — a
      // tartalom-értékelő mondja meg, használható-e).
      if (info.widget_solved && Date.now() - t0 - info.widget_solved_at > 2500) { info.passed = true; break; }

      // Megoldó-horog (olvasási úton, ha van aktív szolgáltató): a checkbox után
      // megjelenő RÁCS (image_grid), vagy Turnstile-token (sitekey kell).
      if (readPath && solverHealth.active && !solverTried && end - Date.now() > 3000 &&
          (solve.clicks >= 1 || !solveOn || checkboxMissing) && Date.now() - lastClickTs > 2500) {
        const grid = await findGridFrame(page);
        let req = null;
        if (grid) {
          req = { kind: 'image_grid', frame: grid.frame, meta: { vendor: grid.vendor, box: grid.box, url: page.url() } };
        } else if (cur.type === 'turnstile_gate' || cur.type === 'cloudflare_interstitial') {
          // Turnstile-token. A CF challenge-OLDALON (interstitial) a puszta token
          // nem elég (a platform saját folyamata fut) — ezt `challenge_page`
          // jelzi a szolgáltatónak; a beépített fizetős adapterek ilyenkor nem hívnak ki.
          const cb = await findCheckbox(page);
          const sk = cb?.sitekey ? { sitekey: cb.sitekey } : await pageSitekey(page);
          if (sk?.sitekey && (!cb || cb.target === 'turnstile')) {
            req = { kind: 'turnstile', frame: cb?.frame || null,
              meta: { ...sk, url: page.url(), challenge_page: cur.type === 'cloudflare_interstitial' } };
          }
        }
        if (req) {
          solverTried = true;
          let ua = '';
          try { ua = await page.browser().userAgent(); } catch (_) { /* */ }
          const res = await solveCaptcha({ ...req, page, meta: { ...req.meta, userAgent: ua }, purpose: opts.purpose, env,
            timeoutMs: Math.max(1000, end - Date.now() - 1000) });
          info.solver = { kind: req.kind, ok: res.ok, provider: res.provider, ms: res.ms,
            ...(res.cost_usd != null ? { cost_usd: res.cost_usd } : {}), ...(res.ok ? {} : { error: res.error }), tried: res.tried };
          if (res.ok && res.answer !== undefined && req.kind === 'turnstile') info.solver.inject = await injectToken(page, res.answer);
          if (res.ok && Array.isArray(res.actions)) info.solver.actions = await performActions(page, res.actions, opts.human);
        }
      }
    }
  } finally {
    try { page.off('framenavigated', onNav); } catch (_) { /* */ }
  }
  if (info.passed) {
    // Ülepedés: az átengedett lap betöltése (korlátos).
    const rem = Math.min(3000, (opts.deadlineTs || Infinity) - Date.now() - 200);
    if (rem > 200) await page.waitForNetworkIdle({ idleTime: 500, timeout: rem }).catch(() => {});
    html = await readHtml(page) ?? html;
  }
  info.waited_ms = Date.now() - t0;
  info.navigations = navs;
  delete info.widget_solved_at;
  if (solve.attempted || solveOn && first.interactive) info.solve = solve;
  return { info, html };
}

// ─── Clearance-sütik (a persona-konzisztencia része) ────────────────────
// Csak a védelmi rendszerek „átengedő" sütijei — nem a látogató identitása.
export const CLEARANCE_COOKIE_RE = /^(cf_clearance|__cf_bm|cf_chl_\w*|datadome|_px\w*|pxcts|incap_ses_\w+|visid_incap_\w+|reese84|_abck|bm_sz|ak_bmsc)$/;

export function clearanceCookies(cookies, nowSec = Date.now() / 1000) {
  return (cookies || []).filter(c => c && CLEARANCE_COOKIE_RE.test(String(c.name)) &&
    (!(c.expires > 0) || c.expires > nowSec + 30));
}
