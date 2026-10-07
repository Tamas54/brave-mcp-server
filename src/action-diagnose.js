// ════════════════════════════════════════════════════════════════════
//  Akció-diagnózis + gépelés-visszaolvasás — 2026-10-07 (R2-E, böngésző-
//  interakció minősége; P1-2, P2-1, P2-2)
// ════════════════════════════════════════════════════════════════════
// MIÉRT: a brave_page click/write/select hibája eddig egy nyers puppeteer-
// timeout vagy „no element matches text" volt — a hívó (ember vagy LLM) nem
// tudta, MI állta útját: nincs ilyen elem, kettő is van, rejtett, letiltott,
// vagy (a leggyakoribb) egy cookie-banner / dialógus TAKARJA. Ugyanígy a
// gépelés: „sikerült" — de a mező maxlength-tel levágta, a chip-mező kiürítette,
// vagy a fókusz továbbugrott (OTP-dobozok). Ez a modul mondja ki ezeket:
//   * diagnose(el)      — lapon belüli függvény: méret, display/visibility,
//                         disabled/readonly, pointer-events, képernyőn kívül,
//                         és `covered_by` {tag,id,class,text,position} — MI van felül;
//   * nextMove(why)     — EGY mondat, amire a hívó cselekedni tud;
//   * fieldState(el)    — a mező értéke / fókusza / titok-e (egy pillanatban);
//   * keptVerdict(...)  — full | truncated | reformatted | emptied | focus_moved |
//                         unreadable — a gépelés UTÁN a mező valódi állapota.
//
// ATTRIBÚCIÓ (MIT-port, a MAI állapotból — a 2026-09-02 előtti AGPL-előzményből
// SEMMI): feder-cr/invisible_playwright_mcp @ b54f0a4 (0.70.12, 2026-10-06),
// src/invisible_playwright_mcp/mcp/actions.py — DIAGNOSE_JS, NEXT_MOVE,
// next_move(), FIELD_STATE_JS, what_the_field_kept(); clean.py — SECRET_AUTOCOMPLETE.
// MIT License, Copyright (c) 2024-2026 AIHawk contributors. A licenc teljes
// szövege és a részletek: ~/recon/tinyfish/THIRD_PARTY_NOTICES_bravemcp.md
// (a repóba NOTICES-fájl nem kerül — Kommandant, 2026-10-07).
// Eltérések a forrástól: puppeteer-ElementHandle (nem Playwright-locator);
// `readonly` és több pontos takarás-próba (nem csak a középpont); a `kept`
// gépi kód + rövid mondat (nem egyetlen próza); ÉRTÉKET SOSEM adunk vissza,
// csak hosszt (a gépelt szöveg lehet vault-titok — a hívó oldalán kitakarva sem
// kell, hogy visszajöjjön).

// ── Lapon belüli: miért nem landolhat az akció az elemen ─────────────
// Az ELEMET kapja (nem a szelektort): a puppeteer oldotta fel, így árnyék-DOM
// és a puppeteer saját szintaxisa ugyanazt jelenti a diagnózisnak, mint az
// akciónak. Visszaad egy kattintási pontot is (`point`) — az első olyan pontot
// (középpont, majd 4 belső pont), ahol a találat az elem maga vagy a leszárma-
// zottja; ha egyik sem, `covered_by` a középpont takarója.
export function diagnoseInPage(el) {
  const r = el.getBoundingClientRect();
  const out = { width: Math.round(r.width), height: Math.round(r.height) };
  const s = getComputedStyle(el);
  if (s.display === 'none') out.display_none = true;
  if (s.visibility === 'hidden') out.visibility_hidden = true;
  if (el.disabled === true) out.disabled = true;
  if (el.readOnly === true) out.readonly = true;
  if (s.pointerEvents === 'none') out.pointer_events_none = true;
  const W = window.innerWidth, H = window.innerHeight;
  if (r.bottom < 0 || r.top > H || r.right < 0 || r.left > W) out.off_screen = true;
  // Az elem SAJÁT gyökerétől kérdezzük: a dokumentum az árnyék-gyökéren belüli
  // elemre a HOST-ot adná, és a host nem `contains()`-olja az árnyék-tartalmat.
  const root = el.getRootNode ? el.getRootNode() : document;
  const within = (a, b) => {
    for (let n = a; n; n = n.parentNode || n.host) if (n === b) return true;
    return false;
  };
  const hitAt = (x, y) => {
    if (!(x >= 0 && y >= 0 && x < W && y < H)) return null;
    return (root.elementFromPoint ? root : document).elementFromPoint(x, y);
  };
  if (out.width > 0 && out.height > 0 && !out.display_none && !out.visibility_hidden) {
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const pts = [[cx, cy],
      [r.left + r.width * 0.25, r.top + r.height * 0.25], [r.left + r.width * 0.75, r.top + r.height * 0.25],
      [r.left + r.width * 0.25, r.top + r.height * 0.75], [r.left + r.width * 0.75, r.top + r.height * 0.75]];
    let firstHit = null;
    for (const [x, y] of pts) {
      const hit = hitAt(x, y);
      if (firstHit === null) firstHit = hit;
      // A találat az elem maga / leszármazottja (a gomb ikonja), vagy az őse
      // (pointer-events:none-os belső <span> — a valódi egér is az ősön landol).
      if (hit && (within(hit, el) || within(el, hit))) {
        out.point = { x: Math.round(x), y: Math.round(y) };
        break;
      }
    }
    if (!out.point && firstHit) {
      const t = (firstHit.innerText || firstHit.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
      const cls = firstHit.className && firstHit.className.toString ? firstHit.className.toString().slice(0, 60) : '';
      out.covered_by = {
        tag: firstHit.tagName.toLowerCase(),
        id: firstHit.id || undefined,
        class: cls || undefined,
        text: t || undefined,
        position: getComputedStyle(firstHit).position,
      };
    }
  }
  return out;
}

// ── Mit tegyél (egy mondat) ──────────────────────────────────────────
// A mondatok itt élnek, nem az akciókban: a válasz attól függ, mit mond a LAP,
// nem attól, melyik akció kérdezte.
export const NEXT_MOVE = {
  bad_selector: 'that is not valid CSS, so nothing was searched for. Use a selector (or ref) '
    + 'from a fresh snapshot verbatim.',
  matches: 'nothing on the page matches that selector. If you wrote it yourself, take a fresh '
    + 'snapshot and use a selector or ref from it verbatim; if it came from a snapshot, the page '
    + 'has changed since: snapshot again.',
  ambiguous: 'the selector matches more than one element and the first one could not take the '
    + 'action. Use a more specific selector or the ref from a fresh snapshot.',
  covered_by: 'something else is on top of it (see covered_by). Deal with that element first — '
    + 'accept or close the cookie banner, close the dialog — which is a different action from '
    + 'trying this one again.',
  display_none: 'it is in the page but not displayed. Whatever reveals it (a menu, a tab, a '
    + '"more" button) has not happened yet.',
  visibility_hidden: 'it is laid out but invisible, so it cannot be used.',
  disabled: 'it is disabled. Something has to enable it first (fill the required fields, accept '
    + 'the terms).',
  readonly: 'it is read-only: the page fills it some other way (a picker, a button next to it).',
  pointer_events_none: 'it does not take pointer events at all, which is usually deliberate: '
    + 'the page is refusing it for now.',
  off_screen: 'it is outside the window and could not be scrolled into view.',
  text_matches: 'no visible element shows that text. Check the wording against a fresh snapshot; '
    + 'the element may appear only after scrolling or opening a menu.',
  option_not_found: 'the dropdown has no option with that value or label (see options); pick one '
    + 'of the listed labels.',
  not_a_select: 'that element is not a native <select>. For a custom dropdown, click it open and '
    + 'then click the option.',
  not_a_text_field: 'that element is not a text field, so there is nothing to clear.',
  clear_failed: 'the field keeps its text after select-all + Backspace: the page rewrites it from '
    + 'its own state. Read the page before typing into it.',
  momentary: 'the page reports nothing wrong with it, so whatever stopped the action was '
    + 'momentary. Look at the page before trying again.',
};

export function nextMove(why) {
  if (!why || typeof why !== 'object') return NEXT_MOVE.momentary;
  if (why.bad_selector) return NEXT_MOVE.bad_selector;
  if (why.matches === 0) return NEXT_MOVE.matches;
  for (const k of ['covered_by', 'display_none', 'visibility_hidden', 'disabled', 'readonly',
    'pointer_events_none', 'off_screen']) {
    if (why[k]) return NEXT_MOVE[k];
  }
  if (why.width === 0 || why.height === 0) return NEXT_MOVE.display_none;
  if (why.matches > 1) return NEXT_MOVE.ambiguous;
  return NEXT_MOVE.momentary;
}

// A puppeteer üzenete érvénytelen szelektornál (nem a lap hibája).
const UNPARSABLE = /not a valid selector|unexpected token|unknown engine|selector.*(?:parse|syntax)|syntaxerror|malformed|invalid selector/i;
export function isBadSelectorError(e) {
  return UNPARSABLE.test(String(e?.message || e || ''));
}

// Szelektor → diagnózis (a puppeteer oldja fel, mint az akciót). Sosem dob:
// ha a lap nem kérdezhető, null.
export async function diagnoseSelector(page, selector) {
  let found;
  try {
    found = await page.$$(String(selector));
  } catch (e) {
    return isBadSelectorError(e) ? { bad_selector: true } : null;
  }
  try {
    if (!found.length) return { matches: 0 };
    const why = { matches: found.length };
    try { Object.assign(why, await found[0].evaluate(diagnoseInPage) || {}); } catch (_) { /* közben eltűnt */ }
    delete why.point;
    return why;
  } finally {
    for (const h of found || []) h.dispose().catch(() => {});
  }
}

// ── Mező-állapot (gépelés előtt és után) ─────────────────────────────
// Egy olvasás → az érték, a fókusz és a titok-jelleg ugyanazt a pillanatot
// írja le. `value` null, ha nem szövegmező és nem szerkeszthető tartalom.
export function fieldStateInPage(el) {
  const SECRET_AC = ['current-password', 'new-password', 'one-time-code', 'cc-csc', 'cc-number'];
  const secret = (() => {
    if (!el || el.tagName !== 'INPUT') return false;
    if (String(el.type || '').toLowerCase() === 'password') return true;
    const tokens = String(el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);
    return tokens.some(t => SECRET_AC.indexOf(t) >= 0);
  })();
  const root = el && el.getRootNode ? el.getRootNode() : document;
  const isText = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
  const value = !el ? null : isText ? String(el.value ?? '') : (el.isContentEditable ? String(el.innerText ?? '') : null);
  const ml = isText && typeof el.maxLength === 'number' && el.maxLength >= 0 ? el.maxLength : null;
  return { value, focused: !!el && root.activeElement === el, secret, maxlength: ml };
}

// ── Mit tartott meg a mező (P2-2) ────────────────────────────────────
// A gépelés NEM idempotens: egy chip-mező az első gépelésből elemet csinált, a
// második másodikat. Ezért minden alakot NÉVEN nevezünk, és a hívó dönt.
//   before/after: fieldStateInPage-eredmény; text: a gépelt szöveg.
// Vissza: { kept, kept_len, typed_len, focus_moved?, maxlength?, note } — ÉRTÉK NÉLKÜL.
export function keptVerdict(text, before, after) {
  const typed = String(text ?? '');
  const out = { typed_len: typed.length };
  const value = after ? after.value : null;
  if (value === null || value === undefined) {
    return { ...out, kept: 'unreadable', note: 'typed; the target is not a field whose text can be read back' };
  }
  const prev = before && typeof before.value === 'string' ? before.value : '';
  // A gépelés előtti tartalom (a write hozzáfűz): az ÚJ rész a vizsgált érték.
  let fresh = value;
  if (prev && value.startsWith(prev)) fresh = value.slice(prev.length);
  else if (prev && value.endsWith(prev)) fresh = value.slice(0, value.length - prev.length);
  out.kept_len = fresh.length;
  const focused = !!after.focused;
  if (fresh === typed || (prev && value.includes(typed))) {
    out.kept = 'full';
    if (!focused) {
      out.focus_moved = true;
      out.note = 'typed in full; then the page moved the focus on';
    } else {
      out.note = 'typed in full';
    }
    return out;
  }
  if (!focused && typed.startsWith(fresh)) {
    out.kept = 'focus_moved';
    out.note = fresh
      ? `the page moved the focus to another field after ${fresh.length} of ${typed.length} characters `
        + '(as a code split across boxes does); the rest went where the focus went — read the page to check'
      : 'the page moved the focus away before any of it stayed in this field; the keys went where the '
        + 'focus went — read the page to see where';
    return out;
  }
  if (fresh && typed.startsWith(fresh)) {
    out.kept = 'truncated';
    if (after.maxlength !== null && after.maxlength !== undefined) out.maxlength = after.maxlength;
    out.note = `the field kept only the first ${fresh.length} of ${typed.length} characters and refused `
      + 'the rest (as a maxlength does); shorten the text if the field cannot take more';
    return out;
  }
  const caution = 'Read the page before typing again: a field that turns text into items would take it twice.';
  if (!fresh) {
    out.kept = 'emptied';
    out.note = 'the field is empty after typing: the page took the text out of it — a tag or chip field '
      + 'does that when a comma or Enter turns it into an item. ' + caution;
    return out;
  }
  if (typed.endsWith(fresh)) {
    out.kept = 'emptied';
    out.note = `the field holds only the last ${fresh.length} of ${typed.length} characters: the page `
      + 'emptied it while it was being typed (a page that rewrites the field from its own state). ' + caution;
    return out;
  }
  out.kept = 'reformatted';
  out.note = 'typed; the page shows the value in its own format (e.g. spaces, dashes, a currency) — '
    + 'this is usually fine';
  return out;
}

// Az elem rövid leírása (x,y-kattintás célpontja; napló/LLM-barát, érték nélkül).
export function describeInPage(el) {
  if (!el) return null;
  const t = (el.innerText || el.getAttribute?.('aria-label') || el.getAttribute?.('placeholder') || '')
    .trim().replace(/\s+/g, ' ').slice(0, 60);
  const cls = el.className && el.className.toString ? el.className.toString().slice(0, 60) : '';
  return { tag: el.tagName.toLowerCase(), id: el.id || undefined, class: cls || undefined, text: t || undefined };
}
