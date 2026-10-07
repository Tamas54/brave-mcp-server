// ════════════════════════════════════════════════════════════════════
//  C2 — képes rács-vezénylés: reCAPTCHA v2 és hCaptcha (2026-10-07)
// ════════════════════════════════════════════════════════════════════
// A FOLYAMAT (reCAPTCHA):
//   1. jelölőnégyzet (horgony-keret) emberi kattintással → vagy rögtön átenged
//      (aria-checked=true), vagy megnyílik a feladvány-keret (bframe);
//   2. a feladat szövege (`.rc-imageselect-desc*`, a cél a <strong>-ban) és a
//      rács (3×3 / 4×4 a tábla osztályából) kiolvasása; csempénként egy
//      elem-képernyőkép (a képet SOHA nem töltjük le újra — a kép-URL a
//      munkamenethez kötött), plusz az egész rács képe;
//   3. a C1-végpont (`kind:"grid"`) hívása → a kiválasztott csempe-indexek
//      (0-tól, sorfolytonosan) → emberi egérmozgással kattintás;
//   4. DINAMIKUS rács („Click verify once there are none left"): a kattintott
//      csempék helyére új kép úszik be — megvárjuk, csak az újakat küldjük
//      vissza (`meta.subset`), amíg a modell már nem választ;
//   5. „Verify"/„Skip"/„Next" → kimenet: átengedve / új kör (hibaüzenet vagy új
//      feladvány) / tiltás; legfeljebb ctx.maxRounds kör, a ctx.deadlineTs-ig.
//   A hang-út (audio.js) ugyanebben a körben fut, a ctx.order sorrendjében
//   (alap: kép, majd hang) — a kép-út kudarca/nem-támogatottsága után átvált.
// hCaptcha: jelölőnégyzet → feladvány-keret; a régi DOM-rács (`.task-image`)
// ugyanígy `kind:"grid"`, a mai VÁSZON-alapú feladvány (`canvas`) `kind:"point"`
// (a modell normalizált x,y pontokat ad, a vásznon kattintunk). Nem támogatott
// feladvány-típusnál (pl. húzás) frissítés legfeljebb 2-szer.

import { anchorChecked, frameVisible, RC_BFRAME_RE, RC_ANCHOR_RE, HC_FRAME_RE } from './detect.js';
import { audioRound, rcStateInPage, rcSig } from './audio.js';

import { sleep, rnd, remaining, act, waitFor } from './util.js';
import { decodePng, crop } from './png.js';

// Keret-csere / navigáció közbeni puppeteer-hiba (nem a mi logikánk hibája).
export function isFrameGone(e) {
  return /detached|Execution context was destroyed|Cannot find context|Target closed|frame got detached|Session closed|context.*destroyed/i
    .test(String(e?.message || e));
}

// A C1-válasz csempe-listája → rendezett, egyedi 0-alapú indexek. Elfogad:
// [0,4,7] | "0,4,7" | [true,false,…] (n hosszú) | {tiles:[…]} | {answer:[…]}.
export function normalizeTiles(resp, n) {
  let t = resp?.tiles ?? resp?.answer;
  if (typeof t === 'string') t = t.split(/[\s,;]+/).filter(Boolean).map(Number);
  if (!Array.isArray(t)) return [];
  if (t.length === n && t.length > 0 && t.every(v => typeof v === 'boolean')) {
    return t.map((v, i) => (v ? i : -1)).filter(i => i >= 0);
  }
  return [...new Set(t.map(Number).filter(i => Number.isInteger(i) && i >= 0 && i < n))].sort((a, b) => a - b);
}

// A C1 `kind:"point"`-válasza → normalizált (0..1) pontok, legfeljebb 12.
export function normalizePoints(resp) {
  const p = resp?.points ?? resp?.answer;
  if (!Array.isArray(p)) return [];
  return p.map(q => (Array.isArray(q) ? { x: Number(q[0]), y: Number(q[1]) } : { x: Number(q?.x), y: Number(q?.y) }))
    .filter(q => Number.isFinite(q.x) && Number.isFinite(q.y) && q.x >= 0 && q.x <= 1 && q.y >= 0 && q.y <= 1)
    .slice(0, 12);
}

export async function shot(handle) {
  return handle.screenshot({ encoding: 'base64', type: 'png' });
}

// A rács EGY képe + a csempék Node-oldali kivágása (png.js); bármi hibánál a
// csempénkénti képernyőkép a tartalék. → { gridB64, tilesB64[] }
export async function shootTiles(container, tiles) {
  let gridB64 = null;
  try {
    const buf = await container.screenshot({ type: 'png' });
    gridB64 = Buffer.from(buf).toString('base64');
    const gb = await container.boundingBox();
    if (!gb || gb.width < 2) throw new Error('grid_box');
    const img = decodePng(Buffer.from(buf));
    const k = img.w / gb.width;
    const out = [];
    let ux0 = Infinity; let uy0 = Infinity; let ux1 = -Infinity; let uy1 = -Infinity;
    for (const t of tiles) {
      const tb = await t.boundingBox();
      if (!tb) throw new Error('tile_box');
      out.push(crop(img, (tb.x - gb.x) * k, (tb.y - gb.y) * k, tb.width * k, tb.height * k).toString('base64'));
      ux0 = Math.min(ux0, tb.x); uy0 = Math.min(uy0, tb.y); ux1 = Math.max(ux1, tb.x + tb.width); uy1 = Math.max(uy1, tb.y + tb.height);
    }
    // a rács-kép PONTOSAN a csempék uniója (a tároló lehet szélesebb / párnázott —
    // a „grid: rows×cols" egyenletes felosztása csak így esik a csempékre)
    if (tiles.length && Number.isFinite(ux0)) {
      gridB64 = crop(img, (ux0 - gb.x) * k, (uy0 - gb.y) * k, (ux1 - ux0) * k, (uy1 - uy0) * k).toString('base64');
    }
    return { gridB64, tilesB64: out };
  } catch (_) {
    const out = [];
    for (const t of tiles) out.push(await shot(t));
    return { gridB64, tilesB64: out };
  }
}

// Kicsi (pl. 800×600-as) nézetben a feladvány-ablak kilóghat → a kattintás
// elveszne. Asztali nézetet legalább 1280×900-ra bővítünk; mobilt nem bántunk.
export async function ensureViewport(page) {
  let vp = null;
  try { vp = page.viewport(); } catch (_) {}
  if (vp?.isMobile) return;
  if (!vp || vp.width < 1000 || vp.height < 860) {
    try {
      await page.setViewport({ width: Math.max(vp?.width || 0, 1280), height: Math.max(vp?.height || 0, 900), deviceScaleFactor: vp?.deviceScaleFactor || 1 });
    } catch (_) { /* best effort */ }
  }
}

function refind(page, re, want) {
  try {
    for (const f of page.frames()) {
      const u = f.url();
      if (want) { const m = u.match(re); if (m && m[1] === want) return f; } else if (re.test(u)) return f;
    }
  } catch (_) {}
  return null;
}

async function tokenPresent(page, vendor) {
  const sel = vendor === 'hcaptcha'
    ? 'textarea[name="h-captcha-response"], textarea[name="g-recaptcha-response"][id^="g-recaptcha-response-"]'
    : 'textarea[name="g-recaptcha-response"], textarea.g-recaptcha-response';
  try {
    return await page.mainFrame().evaluate((s) => [...document.querySelectorAll(s)].some(t => (t.value || '').length > 10), sel);
  } catch (_) { return false; }
}

export async function readToken(page, vendor) {
  const sel = vendor === 'hcaptcha' ? 'textarea[name="h-captcha-response"]' : 'textarea[name="g-recaptcha-response"]';
  try {
    return await page.mainFrame().evaluate((s) => [...document.querySelectorAll(s)].map(t => t.value || '').find(v => v.length > 10) || null, sel);
  } catch (_) { return null; }
}

// ═══════════════════════════════ reCAPTCHA ═══════════════════════════════

async function rcState(bframe) {
  return bframe.evaluate(rcStateInPage);
}


// Egy kép-kör. Visszaad: { ok } | { error, fatal?, switchMode? }
async function imageRound(page, bframe, ctx) {
  let st = await waitFor(async () => {
    const s = await rcState(bframe);
    if (s.mode === 'blocked' || s.mode === 'audio') return s;
    return s.mode === 'image' && s.tiles.length && s.tiles.every(t => t.loaded && t.opaque) ? s : null;
  }, ctx, 6000);
  if (!st) return { error: 'tiles_not_loaded' };
  if (st.mode === 'blocked') return { error: 'recaptcha_blocked', fatal: true };
  if (st.mode === 'audio') {
    // a hang-útról vissza a képre (pl. a kép-út a sorrendben a hang után jön)
    const b = await bframe.$('#recaptcha-image-button');
    if (!b) return { error: 'image_button_missing', switchMode: true };
    await ctx.human.clickHandle(page, b);
    act(ctx, { type: 'click', target: 'recaptcha_image_button' });
    return { error: 'mode_switched', retry: true };
  }
  const n = st.tiles.length;
  const rows = st.rows || Math.round(Math.sqrt(n));
  const cols = st.cols || Math.ceil(n / rows);
  const tiles = await bframe.$$('td.rc-imageselect-tile');
  if (tiles.length !== n) return { error: 'tile_count_mismatch' };
  const gridH = await bframe.$('#rc-imageselect-target');
  const { gridB64, tilesB64 } = gridH ? await shootTiles(gridH, tiles) : { gridB64: null, tilesB64: await Promise.all(tiles.map(shot)) };
  act(ctx, { type: 'capture', tiles: tilesB64.length, grid: `${rows}x${cols}`, dynamic: st.dynamic });
  // C1-szerződés: PONTOSAN EGY a kettőből — az egész rács képe + grid (a modell a
  // számozott jelölőkön választ; a 4×4-en a csempéken átnyúló tárgyat is látja); a
  // csempék csak tartalékként (ha a rács-kép nem készült el)
  const resp = await ctx.solve({
    kind: 'grid', instruction: st.instruction,
    ...(gridB64 ? { image_b64: gridB64, grid: { rows, cols } } : { tiles_b64: tilesB64 }),
    meta: { vendor: 'recaptcha', target: st.target, dynamic: st.dynamic, carousel: st.carousel },
  });
  if (!resp.ok) return { error: resp.error || 'solver_failed', fatal: resp.fatal, switchMode: resp.switchMode };
  const want = new Set(normalizeTiles(resp, n));
  // „válassz többet" után a korábbi jelölések megmaradnak → csak a KÜLÖNBSÉGET kattintjuk
  const toggles = [];
  for (let i = 0; i < n; i++) if (want.has(i) !== !!st.tiles[i].selected) toggles.push(i);
  const oldSrc = st.tiles.map(t => t.src);
  for (const i of toggles) {
    if (remaining(ctx) < 1500) break;
    await ctx.human.clickHandle(page, tiles[i]);
    act(ctx, { type: 'click', target: 'recaptcha_tile', index: i });
    await sleep(rnd(80, 260));
  }
  if (st.dynamic) {
    await dynamicLoop(page, bframe, ctx, toggles.filter(i => want.has(i)), oldSrc, st);
  }
  if (remaining(ctx) < 1200) return { error: 'budget_exhausted', fatal: true };
  const vb = await bframe.$('#recaptcha-verify-button');
  if (!vb) return { error: 'verify_button_missing' };
  await sleep(rnd(200, 500));
  const sigBefore = rcSig(await rcState(bframe).catch(() => null));
  await ctx.human.clickHandle(page, vb);
  act(ctx, { type: 'click', target: 'recaptcha_verify', selected: want.size });
  return { ok: true, sigBefore };
}

// Dinamikus rács: a kattintott csempék cseréjének kivárása, az új képek
// újraküldése, amíg a modell már nem jelöl (legfeljebb 6 menet).
async function dynamicLoop(page, bframe, ctx, clicked, oldSrc, st0) {
  let pending = clicked.slice();
  for (let iter = 0; pending.length && iter < 6 && remaining(ctx) > 4300; iter++) {
    const since = Date.now();
    // a „Verify"-ra MINDIG maradjon idő: a csere-várás nem eheti meg a keretet
    // (mérve a Google demóján: a dinamikus rács egy csere-köre 2–4 s)
    const waitMs = Math.min(9000, remaining(ctx) - 3500);
    if (waitMs < 800) break;
    const ready = await waitFor(async () => {
      const s = await rcState(bframe);
      if (s.mode !== 'image') return { gone: true };
      // kész a csere: új kép (új src) betöltve, átlátszatlan, a „dinamikus kijelölés"
      // lekerült; ha az src véletlenül azonos maradna, 2,5 s után a többi jel is elég
      const ok = pending.every(i => s.tiles[i] && s.tiles[i].loaded && !s.tiles[i].dynSel && s.tiles[i].opaque
        && (s.tiles[i].src !== oldSrc[i] || Date.now() - since > 2500));
      return ok ? s : null;
    }, ctx, waitMs, 250);
    if (!ready || ready.gone) break;
    if (remaining(ctx) < 3500) break;
    const handles = await bframe.$$('td.rc-imageselect-tile');
    const gridH = await bframe.$('#rc-imageselect-target');
    const sub = pending.map(i => handles[i]);
    const shots = gridH ? (await shootTiles(gridH, sub)).tilesB64 : await Promise.all(sub.map(shot));
    const resp = await ctx.solve({
      kind: 'grid', instruction: ready.instruction, tiles_b64: shots,
      meta: { vendor: 'recaptcha', target: st0.target, dynamic: true, subset: pending.slice() },
    });
    if (!resp.ok) break;
    const pick = normalizeTiles(resp, pending.length).map(j => pending[j]);
    act(ctx, { type: 'dynamic_recheck', tiles: pending.length, picked: pick.length });
    for (const i of pick) {
      oldSrc[i] = ready.tiles[i].src;
      if (remaining(ctx) < 1500) break;
      await ctx.human.clickHandle(page, handles[i]);
      act(ctx, { type: 'click', target: 'recaptcha_tile', index: i, dynamic: true });
      await sleep(rnd(120, 350));
    }
    pending = pick;
  }
}

// Ellenőrzés utáni kimenet: 'solved' | 'retry' | 'blocked'
async function rcOutcome(page, ctx, before) {
  const r = await waitFor(async () => {
    const anchor = refind(page, RC_ANCHOR_RE);
    if (anchor && await anchorChecked(anchor, 'recaptcha')) return 'solved';
    const bframe = refind(page, RC_BFRAME_RE);
    if (!anchor && !bframe && ctx.mainNavs > ctx.navsAtStart) return 'solved';   // a lap továbblépett (callback-beküldés)
    if (!bframe || !(await frameVisible(bframe))) {
      return (await tokenPresent(page, 'recaptcha')) ? 'solved' : null;
    }
    const s = await rcState(bframe);
    if (s.mode === 'blocked') return 'blocked';
    if (rcSig(s) !== before) {
      if (s.mode === 'image' && s.errors.length) return 'retry';
      if (s.mode === 'audio' && s.errorText) return 'retry';
      // új feladvány / új hanganyag — megvárjuk, hogy betöltsön
      if (s.mode === 'image' && s.tiles.length && s.tiles.every(t => t.loaded)) return 'retry';
      if (s.mode === 'audio' && s.audioUrl) return 'retry';
    }
    return null;
  }, ctx, 7000, 250);
  return r || 'retry';
}

export async function solveRecaptcha(page, det, ctx) {
  ctx.vendor = 'recaptcha';
  await ensureViewport(page);
  let anchor = det.frames.anchor;
  if (!det.challengeVisible) {
    if (!anchor || det.kind === 'recaptcha_invisible') return { ok: false, error: 'recaptcha_invisible_no_challenge' };
    const h = await anchor.$('#recaptcha-anchor');
    if (!h) return { ok: false, error: 'anchor_missing' };
    await ctx.human.clickHandle(page, h);
    act(ctx, { type: 'click', target: 'recaptcha_checkbox' });
  }
  const first = await waitFor(async () => {
    if (anchor && await anchorChecked(anchor, 'recaptcha')) return 'checked';
    const bf = refind(page, RC_BFRAME_RE);
    if (bf && await frameVisible(bf)) {
      const s = await rcState(bf);
      if (s.mode === 'blocked') return 'blocked';
      if ((s.mode === 'image' && s.tiles.length) || s.mode === 'audio') return 'challenge';
    }
    return null;
  }, ctx, 9000, 250);
  act(ctx, { type: 'challenge', state: first || 'timeout' });
  if (first === 'checked') return { ok: true, rounds: 0, how: 'checkbox' };
  if (first === 'blocked') return { ok: false, error: 'recaptcha_blocked' };
  if (!first) return { ok: false, error: 'challenge_not_shown' };

  const order = ctx.order.length ? ctx.order : ['image', 'audio'];
  let modeIdx = 0;
  let rounds = 0;
  let modeFails = 0;
  let lastErr = null;
  let switches = 0;
  while (rounds < ctx.maxRounds && remaining(ctx) > 2500) {
    const bframe = refind(page, RC_BFRAME_RE);
    if (!bframe) {
      if (ctx.mainNavs > ctx.navsAtStart) return { ok: true, rounds, how: 'navigated' };
      return { ok: false, error: 'challenge_frame_lost', rounds };
    }
    const mode = order[modeIdx];
    let r;
    try {
      r = mode === 'audio' ? await audioRound(page, bframe, ctx) : await imageRound(page, bframe, ctx);
    } catch (e) {
      // a feladvány-keret rossz válasz után újrarajzol / újratölt (mérve a Google
      // demóján: „Execution context was destroyed") — új kör a friss kerettel
      if (!isFrameGone(e)) throw e;
      act(ctx, { type: 'frame_reloaded', mode });
      await sleep(700);
      rounds++;
      continue;
    }
    if (r.retry && ++switches <= 2) { await sleep(800); continue; }
    rounds++;
    if (!r.ok) {
      lastErr = r.error;
      act(ctx, { type: 'round_failed', mode, error: r.error });
      // mód-specifikus hiba (nem támogatott fajta, hang tiltva, gomb hiányzik) → váltás
      if ((r.switchMode || r.error === 'audio_blocked' || /unsupported/.test(r.error || '')) && modeIdx + 1 < order.length) {
        modeIdx++; modeFails = 0; continue;
      }
      if (r.fatal) return { ok: false, error: r.error, rounds };
      if (++modeFails >= 2 && modeIdx + 1 < order.length) { modeIdx++; modeFails = 0; }
      continue;
    }
    const out = await rcOutcome(page, ctx, r.sigBefore);
    act(ctx, { type: 'outcome', mode, outcome: out });
    if (out === 'solved') return { ok: true, rounds, token: await readToken(page, 'recaptcha') };
    if (out === 'blocked') return { ok: false, error: 'recaptcha_blocked', rounds };
    lastErr = 'wrong_answer';
    // a kép-út a 3. hibás kör után átadja a hangnak (ha van)
    if (++modeFails >= 3 && modeIdx + 1 < order.length) { modeIdx++; modeFails = 0; }
  }
  return { ok: false, error: rounds >= ctx.maxRounds ? `max_rounds:${lastErr || 'unknown'}` : 'budget_exhausted', rounds };
}

// ═══════════════════════════════ hCaptcha ════════════════════════════════

function hcStateInPage() {
  const vis = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const prompt = (document.querySelector('.prompt-text')?.innerText || '').replace(/\s+/g, ' ').trim();
  const tiles = [...document.querySelectorAll('.task-image, .task-grid .task')].filter(vis);
  const canvases = [...document.querySelectorAll('canvas')].filter(vis)
    .sort((a, b) => (b.getBoundingClientRect().width * b.getBoundingClientRect().height) - (a.getBoundingClientRect().width * a.getBoundingClientRect().height));
  const submit = document.querySelector('.button-submit');
  const err = document.querySelector('.display-error');
  const errVis = !!err && Number(getComputedStyle(err).opacity) > 0.5 && err.getAttribute('aria-hidden') !== 'true';
  const tileLoaded = tiles.map(t => {
    const img = t.querySelector('.image');
    const bg = img ? getComputedStyle(img).backgroundImage : '';
    const im = t.querySelector('img');
    return (bg && bg !== 'none') || (im && im.complete && im.naturalWidth > 0) || (!img && !im);
  });
  // a sorok/oszlopok a csempék elhelyezkedéséből
  const ys = [...new Set(tiles.map(t => Math.round(t.getBoundingClientRect().top / 8)))];
  const rows = ys.length || 0;
  return {
    prompt,
    nTiles: tiles.length,
    rows,
    cols: rows ? Math.ceil(tiles.length / rows) : 0,
    tilesLoaded: tileLoaded.every(Boolean),
    selected: tiles.map(t => t.getAttribute('aria-pressed') === 'true' || /\bselected\b/.test(t.className)),
    hasCanvas: canvases.length > 0,
    submitText: (submit?.innerText || '').trim(),
    submitLabel: submit?.getAttribute('aria-label') || '',
    errVis,
  };
}

function hcSig(s) {
  return s ? `${s.prompt}|${s.nTiles}|${s.submitLabel}|${s.hasCanvas}|${s.errVis}` : '';
}

async function hcRound(page, ch, ctx, refreshes) {
  // a vászon aszinkron rajzol: rövid ülepedés, majd a csempék betöltése
  const st = await waitFor(async () => {
    const s = await ch.evaluate(hcStateInPage);
    return s.prompt && ((s.nTiles && s.tilesLoaded) || s.hasCanvas) ? s : null;
  }, ctx, 6000, 250);
  if (!st) return { error: 'challenge_not_loaded' };
  // húzós feladvány (pl. „Drag the animal to …") — kattintással nem oldható: frissítés,
  // a megoldó hívása nélkül (mérve a hCaptcha demóján)
  if (/\bdrag\b|húzd|ziehe|\bmove\b.+\b(?:into|onto|to)\b|\bslide\b/i.test(st.prompt)) return { error: 'unsupported_drag', refresh: refreshes < 3 };
  await sleep(st.hasCanvas && !st.nTiles ? 700 : 200);
  let resp;
  if (st.nTiles) {
    const tiles = await ch.$$('.task-image, .task-grid .task');
    const vis = [];
    for (const t of tiles) { const bb = await t.boundingBox(); if (bb && bb.width > 4) vis.push(t); }
    const gh = await ch.$('.task-grid') || await ch.$('.challenge-view');
    const { gridB64, tilesB64 } = gh ? await shootTiles(gh, vis) : { gridB64: null, tilesB64: await Promise.all(vis.map(shot)) };
    act(ctx, { type: 'capture', tiles: tilesB64.length, grid: `${st.rows}x${st.cols}` });
    const gridOk = gridB64 && st.rows * st.cols === tilesB64.length;
    resp = await ctx.solve({
      kind: 'grid', instruction: st.prompt,
      ...(gridOk ? { image_b64: gridB64, grid: { rows: st.rows, cols: st.cols } } : { tiles_b64: tilesB64 }),
      meta: { vendor: 'hcaptcha' },
    });
    if (!resp.ok) return { error: resp.error || 'solver_failed', fatal: resp.fatal, refresh: /unsupported/.test(resp.error || '') && refreshes < 2 };
    const want = new Set(normalizeTiles(resp, vis.length));
    for (let i = 0; i < vis.length; i++) {
      if (want.has(i) === !!st.selected[i]) continue;
      if (remaining(ctx) < 1500) break;
      await ctx.human.clickHandle(page, vis[i]);
      act(ctx, { type: 'click', target: 'hcaptcha_tile', index: i });
      await sleep(rnd(120, 380));
    }
  } else {
    const canvases = await ch.$$('canvas');
    let cv = null; let area = 0;
    for (const c of canvases) {
      const bb = await c.boundingBox();
      if (bb && bb.width * bb.height > area) { area = bb.width * bb.height; cv = c; }
    }
    if (!cv) return { error: 'canvas_missing' };
    const b64 = await shot(cv);
    resp = await ctx.solve({ kind: 'point', instruction: st.prompt, image_b64: b64, meta: { vendor: 'hcaptcha' } });
    if (!resp.ok) return { error: resp.error || 'solver_failed', fatal: resp.fatal, refresh: /unsupported/.test(resp.error || '') && refreshes < 2 };
    const pts = normalizePoints(resp);
    await cv.evaluate((el) => el.scrollIntoView({ block: 'center' })).catch(() => {});
    const bb = await cv.boundingBox();
    if (!bb) return { error: 'canvas_missing' };
    for (const p of pts) {
      if (remaining(ctx) < 1500) break;
      await ctx.human.click(page, bb.x + p.x * bb.width, bb.y + p.y * bb.height);
      act(ctx, { type: 'click', target: 'hcaptcha_point' });
      await sleep(rnd(150, 400));
    }
    if (!pts.length) return { error: 'no_points', refresh: refreshes < 2 };
  }
  const sb = await ch.$('.button-submit');
  if (!sb) return { error: 'submit_missing' };
  await sleep(rnd(200, 500));
  const sigBefore = hcSig(await ch.evaluate(hcStateInPage).catch(() => null));
  await ctx.human.clickHandle(page, sb);
  act(ctx, { type: 'click', target: 'hcaptcha_submit' });
  return { ok: true, sigBefore };
}

async function hcOutcome(page, ctx, before) {
  const r = await waitFor(async () => {
    const cb = refind(page, HC_FRAME_RE, 'checkbox');
    if (cb && await anchorChecked(cb, 'hcaptcha')) return 'solved';
    const ch = refind(page, HC_FRAME_RE, 'challenge');
    if (!cb && !ch && ctx.mainNavs > ctx.navsAtStart) return 'solved';
    if (!ch || !(await frameVisible(ch))) return (await tokenPresent(page, 'hcaptcha')) ? 'solved' : null;
    const s = await ch.evaluate(hcStateInPage);
    if (hcSig(s) === before) return null;
    if (s.errVis) return 'retry';
    if (s.prompt && ((s.nTiles && s.tilesLoaded) || s.hasCanvas)) return 'next';
    return null;
  }, ctx, 7000, 250);
  return r || 'retry';
}

export async function solveHcaptcha(page, det, ctx) {
  ctx.vendor = 'hcaptcha';
  await ensureViewport(page);
  const cb = det.frames.anchor;
  if (!det.challengeVisible) {
    if (!cb) return { ok: false, error: 'hcaptcha_invisible_no_challenge' };
    const h = await cb.$('#checkbox');
    if (!h) return { ok: false, error: 'anchor_missing' };
    await ctx.human.clickHandle(page, h);
    act(ctx, { type: 'click', target: 'hcaptcha_checkbox' });
  }
  const first = await waitFor(async () => {
    if (cb && await anchorChecked(cb, 'hcaptcha')) return 'checked';
    const ch = refind(page, HC_FRAME_RE, 'challenge');
    if (ch && await frameVisible(ch)) {
      const s = await ch.evaluate(hcStateInPage);
      if (s.prompt && (s.nTiles || s.hasCanvas)) return 'challenge';
    }
    return null;
  }, ctx, 10000, 250);
  act(ctx, { type: 'challenge', state: first || 'timeout' });
  if (first === 'checked') return { ok: true, rounds: 0, how: 'checkbox' };
  if (!first) return { ok: false, error: 'challenge_not_shown' };

  let rounds = 0;
  let refreshes = 0;
  let lastErr = null;
  while (rounds < ctx.maxRounds && remaining(ctx) > 2500) {
    const ch = refind(page, HC_FRAME_RE, 'challenge');
    if (!ch) {
      if (ctx.mainNavs > ctx.navsAtStart) return { ok: true, rounds, how: 'navigated' };
      return { ok: false, error: 'challenge_frame_lost', rounds };
    }
    rounds++;
    let r;
    try {
      r = await hcRound(page, ch, ctx, refreshes);
    } catch (e) {
      if (!isFrameGone(e)) throw e;
      act(ctx, { type: 'frame_reloaded' });
      await sleep(700);
      continue;
    }
    if (!r.ok) {
      lastErr = r.error;
      act(ctx, { type: 'round_failed', error: r.error });
      if (r.refresh) {
        const rb = await ch.$('.refresh.button, .refresh-button, [aria-label*="Refresh" i]');
        if (rb) {
          refreshes++;
          await ctx.human.clickHandle(page, rb);
          act(ctx, { type: 'click', target: 'hcaptcha_refresh' });
          await sleep(1200);
          continue;
        }
      }
      if (r.fatal) return { ok: false, error: r.error, rounds };
      continue;
    }
    const out = await hcOutcome(page, ctx, r.sigBefore);
    act(ctx, { type: 'outcome', outcome: out });
    if (out === 'solved') return { ok: true, rounds, token: await readToken(page, 'hcaptcha') };
    if (out === 'retry') lastErr = 'wrong_answer';
  }
  return { ok: false, error: rounds >= ctx.maxRounds ? `max_rounds:${lastErr || 'unknown'}` : 'budget_exhausted', rounds };
}

export const _inPage = { hcStateInPage };
