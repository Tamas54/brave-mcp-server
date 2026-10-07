// ════════════════════════════════════════════════════════════════════
//  C2 — CAPTCHA-felismerés a böngésző-oldalon (2026-10-07)
// ════════════════════════════════════════════════════════════════════
// MIT ISMER FEL:
//  * reCAPTCHA v2 — a horgony-keret (…/recaptcha/(api2|enterprise)/anchor) és a
//    feladvány-keret (…/bframe); a „size=invisible" horgony láthatatlan változat.
//  * hCaptcha — a hcaptcha.html#frame=checkbox / #frame=challenge keretek.
//  * Szöveges / matekos CAPTCHA egy űrlapon: kép (img/canvas/svg „captcha"-jelű
//    attribútummal) + beviteli mező; ill. kép nélküli, szövegben feltett
//    számtani kérdés („Mennyi 3 + 4?", „What is 7 - 2?") — ez helyben megoldható.
// A keretek felismerése URL-ÚTVONAL alapú (a hoszttól független), így a helyi
// fixture-lapok ugyanazt az utat járják, mint az éles Google/hCaptcha-keretek.
//
// HATÁR-ŐRÖK (a megoldó CSAK olvasási úton, és ott is csak FAL-jellegű CAPTCHA-n):
//  * űrlap-őr: ha a CAPTCHA egy olyan űrlapban ül, amelyben a CAPTCHA-n kívül
//    kitöltendő (látható, engedélyezett) felhasználói mező is van — belépés,
//    regisztráció, beküldés —, az NEM fal, hanem űrlap → `guard: 'form_captcha'`.
//  * tartalom-őr: ha a lapon már > CAPTCHA_WALL_MAX_TEXT (alap 4000) jelnyi
//    olvasható szöveg van, a CAPTCHA nem fal (pl. hozzászólás-widget egy cikk
//    alatt) → `guard: 'content_present'` — pénzt és kockázatot nem költünk rá.
//  * láthatatlan (v3 / invisible v2) horgony nyitott feladvány nélkül: nem fal,
//    { found:false } — és a puszta api.js-re sem várunk (nincs késleltetés).
//  * URL-őr: a lap vagy az űrlap célja belépés/regisztráció/fizetés-jellegű
//    útvonal → `guard: 'forbidden_url'` (az engine stealth-szolgáltatásának
//    _FORBIDDEN listájával egy szellemben, de útvonal-SZEGMENS szinten, hogy egy
//    „/ticket-prices-rise" cikk ne essen ki).

export const RC_ANCHOR_RE = /\/recaptcha\/(?:api2|enterprise)\/anchor(?:[?#]|$)/;
export const RC_BFRAME_RE = /\/recaptcha\/(?:api2|enterprise)\/bframe(?:[?#]|$)/;
export const HC_FRAME_RE = /\/hcaptcha[^/?#]*\.html(?:\?[^#]*)?#(?:[^#]*&)?frame=(checkbox|challenge)(?:&|$)/;

const FORBIDDEN_SEGMENT_RE = /^(?:log-?in|sign-?in|sign-?up|register|registration|checkout|payment|purchase|oauth\d?|authorize|log-?out|password|forgot-?password|reset-?password|account-?create|create-?account)(?:[._-].*)?$/i;

// Belépés/regisztráció/fizetés-jellegű URL? (útvonal-szegmens szinten)
export function isForbiddenUrl(u) {
  let x;
  try { x = new URL(String(u)); } catch (_) { return false; }
  const segs = x.pathname.split('/').filter(Boolean).map(s => { try { return decodeURIComponent(s); } catch (_) { return s; } });
  return segs.some(s => FORBIDDEN_SEGMENT_RE.test(s));
}

const sleep = (ms) => new Promise(r => setTimeout(r, Math.max(0, ms)));

// ── lap-oldali segédek (önálló függvényként mennek át az evaluate-be) ──────────

// Egy elem (a CAPTCHA-widget kerete / a válasz-mező) űrlap-környezete: hány
// OLYAN felhasználói mező van mellette, amit egy embernek ki kellene töltenie.
// Nem számít: rejtett, letiltott, csak-olvasható, aria-hidden, tabindex=-1
// (mézesbödön), a CAPTCHA saját válasz-mezője/textarea-ja.
function formInfoInPage(el, excludeSel) {
  const form = el.closest('form');
  const visible = (x) => {
    const r = x.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(x);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) !== 0;
  };
  const scope = form || null;
  let userFields = 0;
  const names = [];
  if (scope) {
    const TEXTY = new Set(['', 'text', 'email', 'password', 'tel', 'number', 'search', 'url', 'date', 'datetime-local', 'month', 'week', 'time']);
    for (const f of scope.querySelectorAll('input, textarea, select')) {
      if (excludeSel && f.matches(excludeSel)) continue;
      const tag = f.tagName.toLowerCase();
      const type = (f.getAttribute('type') || '').toLowerCase();
      if (tag === 'input' && !TEXTY.has(type)) continue;
      if (f.disabled || f.readOnly) continue;
      if (f.getAttribute('aria-hidden') === 'true' || f.tabIndex === -1) continue;
      if (/(?:g-recaptcha|h-captcha)-response/i.test(f.name || f.id || '')) continue;
      if (!visible(f)) continue;
      userFields++;
      if (names.length < 5) names.push(`${tag}:${type || 'text'}:${(f.name || f.id || '').slice(0, 30)}`);
    }
  }
  let action = null;
  try { action = form ? new URL(form.getAttribute('action') || location.href, location.href).href : null; } catch (_) {}
  const submit = scope ? scope.querySelector('button:not([type=button]):not([type=reset]), input[type=submit], input[type=image]') : null;
  return { inForm: !!form, userFields, fieldNames: names, action, hasSubmit: !!submit };
}

// Szöveges/matekos CAPTCHA keresése a fő keretben. A talált elemeket
// data-c2-cap attribútummal jelöli (img|input), hogy a vezénylés megtalálja.
function textCaptchaInPage() {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) !== 0;
  };
  const attrs = (el) => el ? [el.id, typeof el.className === 'string' ? el.className : (el.className?.baseVal || ''),
    el.getAttribute('name'), el.getAttribute('alt'), el.getAttribute('title'), el.getAttribute('src'),
    el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('data-captcha') !== null ? 'captcha' : '']
    .filter(Boolean).join(' ') : '';
  const CAP = /captcha|captch|securimage|kaptcha|botdetect|verif(?:y|ication)[-_ ]?(?:code|image)|security[-_ ]?(?:code|image)|antispam|ellenőrző[-_ ]?kód/i;
  const ANS = /captcha|captch|security[-_ ]?code|verif(?:y|ication)[-_ ]?code|answer|response|solution|kód|eredmény|result|characters|code/i;
  const MATH = /(-?\d{1,4})\s*([+\-−–×xX*÷/])\s*(-?\d{1,4})\s*(?:=|\?|$)/;

  for (const old of document.querySelectorAll('[data-c2-cap]')) old.removeAttribute('data-c2-cap');

  const labelOf = (inp) => {
    let t = '';
    if (inp.id) {
      try { const l = document.querySelector(`label[for="${CSS.escape(inp.id)}"]`); if (l) t += ' ' + l.innerText; } catch (_) {}
    }
    const wrap = inp.closest('label');
    if (wrap) t += ' ' + wrap.innerText;
    const lb = inp.getAttribute('aria-labelledby');
    if (lb) for (const id of lb.split(/\s+/)) { const e = document.getElementById(id); if (e) t += ' ' + e.innerText; }
    return t.replace(/\s+/g, ' ').trim();
  };
  // a mező előtti közeli szöveg (a szülő szövege, max 300 jel) — a matekos
  // kérdés gyakran egy <p>/<span>-ben áll a mező előtt
  const nearText = (inp) => {
    let p = inp.parentElement;
    for (let i = 0; i < 3 && p; i++, p = p.parentElement) {
      const t = (p.innerText || '').replace(/\s+/g, ' ').trim();
      if (t && t.length <= 300) return t;
    }
    return '';
  };

  const inputs = [...document.querySelectorAll('input:not([type]), input[type=text], input[type=number], input[type=tel], input[type=search]')]
    .filter(i => vis(i) && !i.disabled && !i.readOnly && i.getAttribute('aria-hidden') !== 'true');
  const images = [...document.querySelectorAll('img, canvas, svg')]
    .filter(el => vis(el) && (CAP.test(attrs(el)) || CAP.test(attrs(el.parentElement))));

  // 1) kép + mező párosítás (azonos űrlap, ill. legközelebbi közös ős)
  for (const img of images) {
    const form = img.closest('form');
    const cands = inputs.filter(i => (form ? i.form === form : true));
    let best = null;
    let bestScore = -1;
    for (const i of cands) {
      const sig = attrs(i) + ' ' + labelOf(i);
      let s = 0;
      if (CAP.test(sig)) s += 3;
      if (ANS.test(sig)) s += 2;
      // DOM-közelség: a közös ős mélysége
      let a = img.parentElement; let d = 0;
      while (a && !a.contains(i) && d < 8) { a = a.parentElement; d++; }
      s += Math.max(0, 4 - d) * 0.5;
      if (s > bestScore) { bestScore = s; best = i; }
    }
    if (best && bestScore >= 1.5) {
      img.setAttribute('data-c2-cap', 'img');
      best.setAttribute('data-c2-cap', 'input');
      const hint = [attrs(img), labelOf(best), nearText(best)].join(' ');
      const math = /math|sum|calculat|arithmetic|összeg|számold|mennyi|\+|plus/i.test(hint);
      const loaded = img.tagName.toLowerCase() !== 'img' || (img.complete && img.naturalWidth > 0);
      return { kind: 'text', image: true, imageLoaded: loaded, mathHint: math, tag: img.tagName.toLowerCase() };
    }
  }
  // 2) kép nélküli, szövegben feltett számtani kérdés
  for (const i of inputs) {
    const sig = attrs(i) + ' ' + labelOf(i);
    const txt = labelOf(i) + ' ' + nearText(i);
    const m = txt.match(MATH);
    if (m && (CAP.test(sig) || ANS.test(sig) || /what is|mennyi|solve|calculate|spam|robot|human|ember/i.test(txt))) {
      i.setAttribute('data-c2-cap', 'input');
      return { kind: 'math_text', image: false, expr: `${m[1]} ${m[2]} ${m[3]}` };
    }
  }
  // 3) widget-jelek, amelyek kerete még nem töltődött be
  // csak LÁTHATÓ widget-tartó számít (a puszta api.js — pl. a láthatatlan v3 egy
  // kapcsolati űrlapon — nem fal, arra nem várunk)
  const pending = [...document.querySelectorAll('.g-recaptcha, .h-captcha, [data-hcaptcha-widget-id]')]
    .some(el => { const r = el.getBoundingClientRect(); return r.width > 30 && r.height > 30 && getComputedStyle(el).visibility !== 'hidden'; });
  return { kind: null, pending };
}

function bodyTextLenInPage() {
  return document.body ? (document.body.innerText || '').replace(/\s+/g, ' ').trim().length : 0;
}

function frameVisibleInPage(el) {
  const r = el.getBoundingClientRect();
  if (r.width < 30 || r.height < 30) return false;
  if (typeof el.checkVisibility === 'function') {
    return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  }
  for (let x = el; x && x !== document.documentElement; x = x.parentElement) {
    const cs = getComputedStyle(x);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false;
  }
  return true;
}

// ── Node-oldal ─────────────────────────────────────────────────────────────

async function frameEl(frame) {
  try { return await frame.frameElement(); } catch (_) { return null; }
}

export async function frameVisible(frame) {
  const el = await frameEl(frame);
  if (!el) return false;
  try { return await el.evaluate(frameVisibleInPage); } catch (_) { return false; } finally { el.dispose().catch(() => {}); }
}

async function formInfoForFrame(frame) {
  const el = await frameEl(frame);
  if (!el) return null;
  try { return await el.evaluate(formInfoInPage, null); } catch (_) { return null; } finally { el.dispose().catch(() => {}); }
}

export async function anchorChecked(frame, vendor) {
  if (!frame) return false;
  const sel = vendor === 'hcaptcha' ? '#checkbox' : '#recaptcha-anchor';
  try {
    return await frame.evaluate((s) => {
      const el = document.querySelector(s);
      return !!el && el.getAttribute('aria-checked') === 'true';
    }, sel);
  } catch (_) { return false; }
}

function findFrames(page) {
  const out = { rcAnchor: null, rcBframe: null, hcCheckbox: null, hcChallenge: null };
  let frames = [];
  try { frames = page.frames(); } catch (_) { return out; }
  for (const f of frames) {
    let u = '';
    try { u = f.url(); } catch (_) { continue; }
    if (!out.rcAnchor && RC_ANCHOR_RE.test(u)) out.rcAnchor = f;
    else if (!out.rcBframe && RC_BFRAME_RE.test(u)) out.rcBframe = f;
    else {
      const m = u.match(HC_FRAME_RE);
      if (m && m[1] === 'checkbox' && !out.hcCheckbox) out.hcCheckbox = f;
      if (m && m[1] === 'challenge' && !out.hcChallenge) out.hcChallenge = f;
    }
  }
  return out;
}

// A fal vékony köztes lap; ha a lapon ennél több olvasható szöveg van, a
// tartalom már előttünk van — a CAPTCHA (pl. egy hozzászólás-widget) nem fal,
// a megoldás csak pénz és kockázat.
const wallMaxText = () => {
  const v = parseInt(process.env.CAPTCHA_WALL_MAX_TEXT || '', 10);
  return Number.isFinite(v) && v > 0 ? v : 4000;
};

async function guardOf(page, pageUrl, form) {
  if (isForbiddenUrl(pageUrl) || (form?.action && isForbiddenUrl(form.action))) return 'forbidden_url';
  if (form && form.userFields > 0) return 'form_captcha';
  let len = 0;
  try { len = await page.mainFrame().evaluate(bodyTextLenInPage); } catch (_) { len = 0; }
  if (len > wallMaxText()) return 'content_present';
  return null;
}

// A lap CAPTCHA-leírója, vagy { found:false }. `waitMs`: ha widget-jel van, de a
// keret még nem töltődött be, legfeljebb ennyit várunk rá.
export async function detectCaptcha(page, { waitMs = 3000 } = {}) {
  const t0 = Date.now();
  let pageUrl = '';
  try { pageUrl = page.url(); } catch (_) {}
  for (;;) {
    const fr = findFrames(page);
    if (fr.rcAnchor || fr.rcBframe) {
      const anchorUrl = fr.rcAnchor ? fr.rcAnchor.url() : '';
      const invisible = /[?&]size=invisible(?:&|$)/.test(anchorUrl);
      const challengeVisible = fr.rcBframe ? await frameVisible(fr.rcBframe) : false;
      const anchorVisible = fr.rcAnchor && !invisible ? await frameVisible(fr.rcAnchor) : false;
      // láthatatlan (v3 / invisible v2) horgony nyitott feladvány nélkül: nem fal
      if (invisible && !challengeVisible && !fr.hcCheckbox) return { found: false };
      if (anchorVisible || challengeVisible || Date.now() - t0 >= waitMs) {
        const form = await formInfoForFrame(fr.rcAnchor || fr.rcBframe);
        const checked = await anchorChecked(fr.rcAnchor, 'recaptcha');
        return {
          found: true, vendor: 'recaptcha',
          kind: invisible ? 'recaptcha_invisible' : 'recaptcha_v2',
          frames: { anchor: fr.rcAnchor, challenge: fr.rcBframe },
          anchorVisible, challengeVisible, checked, form,
          guard: await guardOf(page, pageUrl, form),
          solvable: !checked && (anchorVisible || challengeVisible),
        };
      }
    } else if (fr.hcCheckbox || fr.hcChallenge) {
      const challengeVisible = fr.hcChallenge ? await frameVisible(fr.hcChallenge) : false;
      const anchorVisible = fr.hcCheckbox ? await frameVisible(fr.hcCheckbox) : false;
      if (anchorVisible || challengeVisible || Date.now() - t0 >= waitMs) {
        const form = await formInfoForFrame(fr.hcCheckbox || fr.hcChallenge);
        const checked = await anchorChecked(fr.hcCheckbox, 'hcaptcha');
        return {
          found: true, vendor: 'hcaptcha', kind: 'hcaptcha',
          frames: { anchor: fr.hcCheckbox, challenge: fr.hcChallenge },
          anchorVisible, challengeVisible, checked, form,
          guard: await guardOf(page, pageUrl, form),
          solvable: !checked && (anchorVisible || challengeVisible),
        };
      }
    } else {
      let t = null;
      try { t = await page.mainFrame().evaluate(textCaptchaInPage); } catch (_) { t = null; }
      if (t && t.kind) {
        let form = null;
        try {
          const inp = await page.$('[data-c2-cap="input"]');
          if (inp) {
            form = await inp.evaluate(formInfoInPage, '[data-c2-cap="input"]');
            await inp.dispose();
          }
        } catch (_) {}
        return {
          found: true, vendor: 'text', kind: t.kind,
          frames: {}, text: t, form,
          guard: await guardOf(page, pageUrl, form),
          solvable: true,
        };
      }
      if (!t || !t.pending || Date.now() - t0 >= waitMs) return { found: false };
    }
    if (Date.now() - t0 >= waitMs) return { found: false };
    await sleep(250);
  }
}

// Helyi, LLM nélküli számtan a kép nélküli matekos CAPTCHA-hoz.
export function solveMathExpr(expr) {
  const m = String(expr || '').match(/(-?\d{1,6})\s*([+\-−–×xX*÷/])\s*(-?\d{1,6})/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[3]);
  switch (m[2]) {
    case '+': return String(a + b);
    case '-': case '−': case '–': return String(a - b);
    case '×': case 'x': case 'X': case '*': return String(a * b);
    case '÷': case '/': return b !== 0 && a % b === 0 ? String(a / b) : null;
    default: return null;
  }
}

export const _inPage = { formInfoInPage, textCaptchaInPage, frameVisibleInPage };
