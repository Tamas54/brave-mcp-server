// ════════════════════════════════════════════════════════════════════
//  C2 — reCAPTCHA hang-út (2026-10-07)
// ════════════════════════════════════════════════════════════════════
// 1. a feladvány-keretben az audio-kapcsoló (#recaptcha-audio-button);
// 2. a hangfájl (.rc-audiochallenge-tdownload-link href / #audio-source src)
//    letöltése A BÖNGÉSZŐ KONTEXTUSÁBAN (a feladvány-keret saját fetch-ével: a
//    sütik és a származás a keret sajátjai — Node-oldali letöltés más ujjlenyomat
//    és más IP-kép lenne); méret-plafon CAPTCHA_AUDIO_MAX_BYTES (alap 2 MB);
// 3. a C3 hívása (`kind:"audio"`, audio_b64 + mime) → átirat;
// 4. a válasz begépelése (#audio-response) emberi ritmusban, „Verify".
// „Your computer or network may be sending automated queries" (.rc-doscaptcha-*)
// = hang tiltva → `audio_blocked` (a vezénylés a kép-útra vált, ha van).

import { act, remaining, waitFor, sleep } from './util.js';

// A reCAPTCHA feladvány-keret állapota (kép / hang / tiltás). A grid.js is ezt
// használja — egy helyen, hogy a két mód ugyanazt a képet lássa.
export function rcStateInPage() {
  const q = (s) => document.querySelector(s);
  const shown = (el) => {
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const dos = q('.rc-doscaptcha-header, .rc-doscaptcha-body');
  if (dos && shown(dos)) return { mode: 'blocked', text: (dos.innerText || '').slice(0, 200) };
  const aud = q('#rc-audio');
  if (aud && shown(aud)) {
    const link = q('.rc-audiochallenge-tdownload-link');
    const src = q('#audio-source');
    const errEl = q('.rc-audiochallenge-error-message');
    return {
      mode: 'audio',
      audioUrl: (link && link.href) || (src && src.src) || null,
      errorText: errEl && shown(errEl) ? (errEl.innerText || '').trim().slice(0, 200) : '',
      lang: document.documentElement.lang || '',
    };
  }
  const img = q('#rc-imageselect');
  if (img) {
    const desc = q('.rc-imageselect-desc-no-canonical, .rc-imageselect-desc, .rc-imageselect-desc-wrapper');
    const instruction = (desc ? desc.innerText : '').replace(/\s+/g, ' ').trim();
    const strong = desc ? desc.querySelector('strong') : null;
    const table = q('#rc-imageselect-target table') || q('table[class*="rc-imageselect-table"]');
    const m = (table ? table.className : '').match(/rc-imageselect-table-(\d)(\d)/);
    let rows = m ? Number(m[1]) : (table ? table.rows.length : 0);
    let cols = m ? Number(m[2]) : (table && table.rows[0] ? table.rows[0].cells.length : 0);
    const tiles = [...document.querySelectorAll('td.rc-imageselect-tile')].map(td => {
      const im = td.querySelector('img');
      const wrap = td.querySelector('.rc-image-tile-wrapper') || im;
      const op = (el) => (el ? Number(getComputedStyle(el).opacity) : 1);
      return {
        selected: td.classList.contains('rc-imageselect-tileselected'),
        dynSel: td.classList.contains('rc-imageselect-dynamic-selected'),
        src: im ? (im.getAttribute('src') || '') : '',
        loaded: !!im && im.complete && im.naturalWidth > 0,
        opaque: op(im) >= 0.99 && op(wrap) >= 0.99,
      };
    });
    if (!rows && tiles.length) { rows = Math.round(Math.sqrt(tiles.length)); cols = Math.ceil(tiles.length / rows); }
    const errors = ['.rc-imageselect-incorrect-response', '.rc-imageselect-error-select-more',
      '.rc-imageselect-error-dynamic-more', '.rc-imageselect-error-select-something']
      .filter(s => shown(q(s))).map(s => s.slice(15));
    const vb = q('#recaptcha-verify-button');
    return {
      mode: 'image',
      instruction,
      target: strong ? strong.innerText.trim() : '',
      rows, cols, tiles, errors,
      dynamic: /none left/i.test(instruction),
      carousel: /if there are none|click skip/i.test(instruction),
      verifyText: vb ? vb.innerText.trim() : '',
    };
  }
  return { mode: 'none' };
}

// Az állapot ujjlenyomata (a kimenet-figyeléshez: változott-e a feladvány).
export function rcSig(s) {
  if (!s) return '';
  if (s.mode === 'image') return `img|${s.instruction}|${(s.tiles || []).map(t => t.src).join(',')}|${(s.errors || []).join(',')}`;
  if (s.mode === 'audio') return `aud|${s.audioUrl || ''}|${s.errorText || ''}`;
  return s.mode;
}

const MAX_AUDIO = () => {
  const v = parseInt(process.env.CAPTCHA_AUDIO_MAX_BYTES || '', 10);
  return Number.isFinite(v) && v > 0 ? v : 2 * 1024 * 1024;
};

// A hangfájl letöltése a keret kontextusában → { b64, type } | { err }
async function downloadInFrame(frame, url, maxBytes) {
  return frame.evaluate(async (u, max) => {
    try {
      const r = await fetch(u, { credentials: 'include' });
      if (!r.ok) return { err: `http_${r.status}` };
      const buf = await r.arrayBuffer();
      if (buf.byteLength > max) return { err: 'too_large' };
      if (buf.byteLength < 64) return { err: 'too_small' };
      const bytes = new Uint8Array(buf);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return { b64: btoa(bin), type: (r.headers.get('content-type') || '').split(';')[0].trim(), bytes: bytes.length };
    } catch (e) {
      return { err: `fetch_failed:${String(e && e.message || e).slice(0, 60)}` };
    }
  }, url, maxBytes);
}

// Egy hang-kör. Visszaad: { ok } | { error, fatal?, switchMode? }
export async function audioRound(page, bframe, ctx) {
  let st = await bframe.evaluate(rcStateInPage);
  if (st.mode === 'blocked') return { error: 'audio_blocked' };
  if (st.mode !== 'audio') {
    const b = await bframe.$('#recaptcha-audio-button');
    const vis = b ? await b.evaluate(el => {
      const cs = getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden' && el.getBoundingClientRect().width > 0;
    }).catch(() => false) : false;
    if (!vis) return { error: 'audio_button_missing', switchMode: true };
    await ctx.human.clickHandle(page, b);
    act(ctx, { type: 'click', target: 'recaptcha_audio_button' });
  }
  st = await waitFor(async () => {
    const s = await bframe.evaluate(rcStateInPage);
    if (s.mode === 'blocked') return s;
    return s.mode === 'audio' && s.audioUrl ? s : null;
  }, ctx, 7000, 250);
  if (!st) return { error: 'audio_not_shown' };
  if (st.mode === 'blocked') return { error: 'audio_blocked' };
  if (remaining(ctx) < 3000) return { error: 'budget_exhausted', fatal: true };

  const dl = await downloadInFrame(bframe, st.audioUrl, MAX_AUDIO());
  if (!dl || dl.err) return { error: `audio_download_failed:${dl?.err || 'unknown'}` };
  act(ctx, { type: 'audio_download', bytes: dl.bytes, mime: dl.type || null });
  // a C3 a hangot `audio` néven várja (a koordinátori vázlat `audio_b64`-et írt) —
  // mindkettőt küldjük, amíg a merge egyet nem választ
  const resp = await ctx.solve({
    kind: 'audio', audio: dl.b64, audio_b64: dl.b64, mime: dl.type || 'audio/mpeg', mode: 'auto',
    meta: { vendor: 'recaptcha', lang: st.lang || null },
  });
  if (!resp.ok) return { error: resp.error || 'solver_failed', fatal: resp.fatal, switchMode: resp.switchMode };
  const answer = String(resp.answer ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!answer) return { error: 'empty_answer' };

  const inp = await bframe.$('#audio-response');
  if (!inp) return { error: 'audio_input_missing' };
  await ctx.human.clickHandle(page, inp);
  // esetleges korábbi (hibás) válasz törlése
  await inp.evaluate((el) => { el.value = ''; }).catch(() => {});
  await sleep(120);
  await ctx.human.type(page, answer);
  act(ctx, { type: 'type', target: 'audio_response', chars: answer.length });
  const vb = await bframe.$('#recaptcha-verify-button');
  if (!vb) return { error: 'verify_button_missing' };
  await sleep(250 + Math.random() * 400);
  const sigBefore = rcSig(await bframe.evaluate(rcStateInPage).catch(() => null));
  await ctx.human.clickHandle(page, vb);
  act(ctx, { type: 'click', target: 'recaptcha_verify' });
  return { ok: true, sigBefore };
}
