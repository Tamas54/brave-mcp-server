// Emberi bemenet — egérpálya, kattintás-ritmus, gépelési ritmus (W2, 2026-10-07).
//
// Portolva (JS-re átírva, NEM szó szerint): feder-cr/invisible_playwright
// @ 9fc1d25b37593baacde1d27e998e155658c85ebf (0.27.0, 2026-10-06) — MIT License,
// Copyright (c) 2026 stealthfox contributors. CSAK a mai (MIT) állapotból.
//   * src/invisible_playwright/_motion.py   — style_for_seed, _plan (kontroll-
//     poligon kar-geometriával, Fitts-idő, mintavétel 8 ms-os padlóval, Beta-
//     sebességprofil, túllövés + korrekció, kétdimenziós remegés, pixel-ismétlés)
//   * src/invisible_playwright/_behaviour.py — TypingPersona + plan_typing
//     (log-normál dwell/gap, kéz-váltás/azonos kéz/azonos billentyű digram,
//     elgondolkodás), plan_click (gombnyomás-dwell), landing_point, initial_pointer
//   * src/invisible_playwright/_pacing.py   — a kézbesítési fegyelem (abszolút
//     határidők egy t0-tól, késésnél ELDOBÁS a „hatótávon" belül, sosem két
//     esemény egy pillanatban) egyszerűsítve
// A teljes licencszöveg és a forrásfájlok sha256-ja: a HELYI notices-fájlban
// (~/recon/tinyfish/THIRD_PARTY_NOTICES_bravemcp.md) — a repóba notices nem kerül.
//
// Eltérések a forrástól: a Python random.Random helyett mulberry32 + Box–Muller
// (a mag-reprodukálhatóság megmarad, a Python-kimenettel bitre NEM egyezik); a
// „session" itt egy böngésző-indítás (recycle → új mag), nem egy Playwright-
// kontextus; a gépelés-tervet a hívás határidejéhez skálázzuk (a brave_page
// 25 s-os keretén belül).
//
// Kapcsoló: HUMANIZE=1 (alapból KI) — a brave_page kattintás/gépelés és a
// brave_mouse_control ezen megy át. A challenge-checkbox kattintása (challenge.js)
// MINDIG ezt használja (ott a viselkedés maga a mért jel). HUMANIZE_SEED=<szám>
// rögzíti a magot (mérés/reprodukció); különben indításonként véletlen.
//
// A modul tiszta része (tervezők) böngésző nélkül tesztelhető; a meghajtó
// (HumanInput) a puppeteer page.mouse / page.keyboard API-ját hívja. A lapba
// SEMMIT nem injektál (a régi humanMouseMove window.mouseX-et írt a lapra — az
// maga is jel volt): a kurzor helyét a Node-oldal tartja nyilván.

import crypto from 'node:crypto';

export function humanizeEnabled(env = process.env) {
  return /^(1|true|on|yes)$/i.test(String(env.HUMANIZE || '').trim());
}

export function humanizeSeed(env = process.env) {
  const s = String(env.HUMANIZE_SEED || '').trim();
  if (/^\d{1,10}$/.test(s)) return Number(s) >>> 0;
  return crypto.randomBytes(4).readUInt32LE(0);
}

// ─── PRNG ───────────────────────────────────────────────────────────────
// FNV-1a (32 bit): független al-folyamok egy magból, címkénként (a forrás
// _mix / _sub_seed mintája).
export function mix(seed, tag) {
  let h = (0x811c9dc5 ^ (seed >>> 0)) >>> 0;
  for (const c of Buffer.from(String(tag), 'utf8')) {
    h ^= c;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h || 0xdeadbeef;
}

export function rngOf(seed) {
  let a = (seed >>> 0) || 0x9e3779b9;
  const random = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    random,
    uniform: (lo, hi) => lo + (hi - lo) * random(),
    randint: (lo, hi) => lo + Math.floor(random() * (hi - lo + 1)),
    // Box–Muller; nulla-átlagú (a forrás „Noise is zero-mean" elve).
    gauss: (mu, sigma) => {
      let u = 0;
      while (u === 0) u = random();
      const v = random();
      return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
  };
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const logNormal = (r, median, sigma) => median * Math.exp(r.gauss(0, sigma));

// ─── Kemény korlátok (nem mag-függők: minden mag ezen belül marad) ────────
export const MIN_STEPS = 2;
export const MAX_STEPS = 160;
export const MIN_DURATION_MS = 40;
export const MAX_DURATION_MS = 2000;
// Két egéresemény ennél közelebb nem lehet (125 Hz-es egér = 8 ms).
export const SAMPLE_FLOOR_MS = 8;
const EPS = 1e-9;

// ─── Munkamenet-stílus (a _motion.style_for_seed portja) ─────────────────
export function motionStyleForSeed(seed) {
  const r = rngOf(mix(seed, 'motion:style'));
  const knotBase = [r.uniform(0.12, 0.38), r.uniform(0.38, 0.62), r.uniform(0.62, 0.88)];
  const bowBase = [r.uniform(0.55, 1.45), r.uniform(-0.70, 1.45), r.uniform(-0.70, 1.45)];
  const aLo = r.uniform(1.70, 2.60);
  let aHi = Math.min(aLo + r.uniform(0.60, 1.40), 3.60);
  if (aHi <= aLo) aHi = aLo + 0.20;
  const rLo = r.uniform(0.78, 1.20);
  const rHi = Math.min(rLo + r.uniform(0.25, 0.65), 1.85);
  const overLo = r.uniform(0.48, 0.62);
  const overHi = Math.min(overLo + r.uniform(0.12, 0.26), 0.88);
  return Object.freeze({
    knots: r.randint(1, 3),
    knotBase,
    knotWobble: r.uniform(0.02, 0.07),
    bowBase,
    bowFrac: r.uniform(0.008, 0.042),
    bowAbsPx: r.uniform(1.0, 4.2),
    bowKneePx: r.uniform(30.0, 90.0),
    pivotAngle: r.uniform(0, 2 * Math.PI),
    pivotStrength: r.uniform(0.62, 0.96),
    bowBias: r.uniform(-0.35, 0.35),
    bowCapPx: r.uniform(40.0, 110.0),
    shortMovePx: r.uniform(40.0, 90.0),
    targetWPx: r.uniform(28.0, 56.0),
    fittsAMs: r.uniform(90.0, 190.0),
    fittsBMs: r.uniform(90.0, 160.0),
    durJitter: r.uniform(0.10, 0.28),
    stepMs: r.uniform(8.0, 18.0),
    stepJitter: r.uniform(0.10, 0.35),
    easeALo: aLo, easeAHi: aHi, easeRLo: rLo, easeRHi: rHi,
    tremorAcrossPx: r.uniform(0.16, 0.58),
    tremorAniso: r.uniform(0.35, 0.95),
    tremorFullPx: r.uniform(70.0, 190.0),
    tremorBurstP: r.uniform(0.05, 0.20),
    tremorBurstMult: r.uniform(1.5, 2.8),
    tremorShape: r.uniform(0.60, 1.60),
    overshootP: r.uniform(0.14, 0.48),
    overshootFrac: r.uniform(0.010, 0.040),
    overshootCapPx: r.uniform(18.0, 45.0),
    overshootMinPx: r.uniform(10.0, 34.0),
    overStartLo: overLo, overStartHi: overHi,
    overShape: r.uniform(0.80, 1.60),
    dupKeepP: r.uniform(0.10, 0.40),
    dupRunMax: r.randint(1, 3),
  });
}

// ─── Geometria ────────────────────────────────────────────────────────────
function bezierPoint(ctrl, t) {
  let pts = ctrl;
  while (pts.length > 1) {
    const nx = [];
    for (let i = 0; i < pts.length - 1; i++) {
      nx.push([pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t]);
    }
    pts = nx;
  }
  return pts[0];
}

function arcTable(ctrl, n) {
  const ts = [];
  const cum = [0];
  let prev = null;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    ts.push(t);
    const p = bezierPoint(ctrl, t);
    if (prev) cum.push(cum[cum.length - 1] + Math.hypot(p[0] - prev[0], p[1] - prev[1]));
    prev = p;
  }
  return { ts, cum };
}

function tAtArclen(ts, cum, s) {
  const total = cum[cum.length - 1];
  if (total <= EPS) return 0;
  s = clamp(s, 0, total);
  let lo = 0, hi = cum.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < s) lo = m + 1; else hi = m; }
  const j = lo;
  if (j <= 0) return ts[0];
  if (j >= cum.length) return ts[ts.length - 1];
  const span = cum[j] - cum[j - 1];
  const f = span <= EPS ? 0 : (s - cum[j - 1]) / span;
  return ts[j - 1] + (ts[j] - ts[j - 1]) * f;
}

// Beta-alakú sebességsűrűség kumulált profilja: 0 sebesség mindkét végén.
function profileTable(a, b, n = 65) {
  const ts = [];
  for (let i = 0; i < n; i++) ts.push(i / (n - 1));
  const dens = ts.map(t => (t ** (a - 1)) * ((1 - t) ** (b - 1)));
  const cum = [0];
  for (let i = 1; i < n; i++) cum.push(cum[i - 1] + 0.5 * (dens[i] + dens[i - 1]) * (ts[i] - ts[i - 1]));
  const total = cum[n - 1];
  if (total <= EPS) return ts;
  const out = cum.map(c => c / total);
  out[n - 1] = 1;
  return out;
}

function profileAt(table, u) {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  const x = u * (table.length - 1);
  const i = Math.floor(x);
  if (i >= table.length - 1) return table[table.length - 1];
  return table[i] + (table[i + 1] - table[i]) * (x - i);
}

function axisBetween(fx, fy, tx, ty) {
  const dx = tx - fx, dy = ty - fy;
  const dist = Math.hypot(dx, dy);
  const ux = dx / dist, uy = dy / dist;
  return { fx, fy, tx, ty, dist, ux, uy, nx: -uy, ny: ux };
}

// ─── A pálya szakaszai (a _plan sorrendje — a sorrend a szerződés része) ──
function controlPolygon(r, ax, st) {
  const swing = -(Math.cos(st.pivotAngle) * ax.nx + Math.sin(st.pivotAngle) * ax.ny);
  const ampScale = st.bowFrac * ax.dist + st.bowAbsPx * ax.dist / (ax.dist + st.bowKneePx);
  const nKnots = ax.dist < st.shortMovePx ? 1 : st.knots;
  const axial = [];
  for (let j = 0; j < nKnots; j++) axial.push(clamp(st.knotBase[j] + r.gauss(0, st.knotWobble), 0.04, 0.96));
  axial.sort((a, b) => a - b);
  const ctrl = [[ax.fx, ax.fy]];
  axial.forEach((u, j) => {
    const mag = st.bowBase[j];
    let amp = ampScale * (st.pivotStrength * swing * mag + (1 - st.pivotStrength) * r.gauss(st.bowBias, 1) * mag);
    amp = clamp(amp, -st.bowCapPx, st.bowCapPx);
    ctrl.push([ax.fx + ax.ux * ax.dist * u + ax.nx * amp, ax.fy + ax.uy * ax.dist * u + ax.ny * amp]);
  });
  ctrl.push([ax.tx, ax.ty]);
  return ctrl;
}

function movementDuration(r, ax, st, targetW) {
  const w = targetW && targetW > 0 ? targetW : st.targetWPx;
  const bits = Math.log2(ax.dist / w + 1);
  const d = (st.fittsAMs + st.fittsBMs * bits) * Math.exp(r.gauss(0, st.durJitter));
  return clamp(d, MIN_DURATION_MS, MAX_DURATION_MS);
}

function sampleTimes(r, duration, st) {
  let n = Math.round(duration / st.stepMs);
  n = Math.max(MIN_STEPS, Math.min(MAX_STEPS, n));
  const incs = [];
  for (let i = 0; i < n; i++) incs.push(Math.exp(r.gauss(0, st.stepJitter)));
  const tot = incs.reduce((a, b) => a + b, 0);
  const times = [0];
  let acc = 0;
  for (const c of incs) { acc += c; times.push(duration * acc / tot); }
  times[times.length - 1] = duration;
  if (times.length <= 2) return times;
  // A padló alatti mintát ELDOBJUK (nem préseljük) — a menetrend és a végpont marad.
  const kept = [times[0]];
  for (const tm of times.slice(1, -1)) if (tm - kept[kept.length - 1] >= SAMPLE_FLOOR_MS) kept.push(tm);
  if (kept.length > 1 && duration - kept[kept.length - 1] < SAMPLE_FLOOR_MS) kept.pop();
  kept.push(duration);
  return kept;
}

function drawOvershoot(r, ax, st) {
  if (ax.dist < st.overshootMinPx || r.random() >= st.overshootP) return { amp: 0, perp: 0, u0: 1, shape: 1 };
  const amp = clamp(st.overshootFrac * ax.dist * Math.exp(r.gauss(0, 0.35)), 0, st.overshootCapPx);
  return { amp, perp: amp * r.gauss(0, 0.40), u0: r.uniform(st.overStartLo, st.overStartHi), shape: st.overShape };
}

const overWeight = (o, u) => (o.amp <= 0 || u <= o.u0 ? 0 : Math.sin(Math.PI * (u - o.u0) / (1 - o.u0)) ** o.shape);

function sampleCurve(ctrl, times, duration, ax, prof, over) {
  const nArc = Math.max(24, Math.min(240, Math.floor(ax.dist / 3) + 8));
  const { ts, cum } = arcTable(ctrl, nArc);
  const length = cum[cum.length - 1];
  const raw = [];
  const last = times.length - 1;
  times.forEach((tm, i) => {
    if (i === 0) { raw.push([ax.fx, ax.fy, 0]); return; }
    if (i === last) { raw.push([ax.tx, ax.ty, tm]); return; }
    const u = tm / duration;
    let [px, py] = bezierPoint(ctrl, tAtArclen(ts, cum, profileAt(prof, u) * length));
    const w = overWeight(over, u);
    if (w) {
      px += ax.ux * over.amp * w + ax.nx * over.perp * w;
      py += ax.uy * over.amp * w + ax.ny * over.perp * w;
    }
    raw.push([px, py, tm]);
  });
  return raw;
}

function applyTremor(r, raw, ax, st, duration) {
  const gain = Math.min(1, Math.sqrt(ax.dist / st.tremorFullPx));
  const across = st.tremorAcrossPx * gain;
  const along = across * st.tremorAniso;
  for (let i = 1; i < raw.length - 1; i++) {
    const [px, py, tm] = raw[i];
    const w = Math.sin(Math.PI * (tm / duration)) ** st.tremorShape;
    let a = r.gauss(0, along), c = r.gauss(0, across);
    if (r.random() < st.tremorBurstP) {
      a += r.gauss(0, along * st.tremorBurstMult);
      c += r.gauss(0, across * st.tremorBurstMult);
    }
    a *= w; c *= w;
    raw[i] = [px + ax.ux * a + ax.nx * c, py + ax.uy * a + ax.ny * c, tm];
  }
}

function collapseDuplicatePixels(r, raw, st) {
  const out = [];
  const keys = [];
  let prevT = 0, run = 0;
  raw.forEach(([px, py, tm], i) => {
    const key = `${Math.round(px)},${Math.round(py)}`;
    const last = i === raw.length - 1;
    if (keys.length && key === keys[keys.length - 1]) {
      run++;
      if (!(run <= st.dupRunMax && r.random() < st.dupKeepP)) {
        if (!last) return;
        out.pop(); keys.pop();
        prevT = out.length ? out[out.length - 1].t : 0;
        run = 0;
      }
    } else run = 0;
    out.push({ x: px, y: py, dt: tm - prevT, t: tm });
    keys.push(key);
    prevT = tm;
  });
  return out;
}

// Egy mozdulat (from → to) eseményei: [{x, y, dt, t}] (t = eltelt ms a kezdettől).
// Azonos mag + index → azonos pálya; a végpont PONTOSAN a cél.
export function planPath(from, to, { seed = 0, index = 0, targetW = null, style = null, jitter = true } = {}) {
  const [fx, fy] = from, [tx, ty] = to;
  if (Math.hypot(tx - fx, ty - fy) < EPS || (Math.round(fx) === Math.round(tx) && Math.round(fy) === Math.round(ty))) {
    return [{ x: tx, y: ty, dt: 0, t: 0 }];
  }
  const st = style || motionStyleForSeed(seed);
  const r = rngOf(mix(seed, `motion:move:${index}`));
  const ax = axisBetween(fx, fy, tx, ty);
  const ctrl = controlPolygon(r, ax, st);
  const duration = movementDuration(r, ax, st, targetW);
  const times = sampleTimes(r, duration, st);
  const easeA = r.uniform(st.easeALo, st.easeAHi);
  const prof = profileTable(easeA, easeA * r.uniform(st.easeRLo, st.easeRHi));
  const over = drawOvershoot(r, ax, st);
  const raw = sampleCurve(ctrl, times, duration, ax, prof, over);
  if (jitter) applyTremor(r, raw, ax, st, duration);
  return collapseDuplicatePixels(r, raw, st);
}

// ─── Kéz a gombon / billentyűzeten (_behaviour portja) ───────────────────
export function pointerPersona(seed) {
  // A forrás PointerPersona-jából csak a kattintás-ritmus kell (a mozdulat
  // alakja a motionStyle-é — egy mozdulat-modell, nem kettő).
  const r = rngOf(mix(seed, 'pointer-persona'));
  return Object.freeze({
    seed,
    clickDwellMedianMs: r.uniform(58, 124),
    clickDwellSigma: r.uniform(0.20, 0.40),
    dblclickGapMedianMs: r.uniform(95, 215),
  });
}

// [(dwell, gap)] gombnyomásonként; az utolsó gap 0.
export function planClick(persona, clicks = 1, nonce = 0) {
  const r = rngOf(mix(persona.seed, `click:${nonce}`));
  const out = [];
  const n = Math.max(1, clicks);
  for (let i = 0; i < n; i++) {
    const dwell = logNormal(r, persona.clickDwellMedianMs, persona.clickDwellSigma);
    const gap = i === n - 1 ? 0 : logNormal(r, persona.dblclickGapMedianMs, 0.30);
    out.push([dwell, gap]);
  }
  return out;
}

const LEFT_HAND = new Set('`12345qwertasdfgzxcvb~!@#$%QWERTASDFGZXCVB');
const RIGHT_HAND = new Set('67890-=yuiop[]\\hjkl;\'nm,./^&*()_+YUIOP{}|HJKL:"NM<>?');
const handOf = (ch) => (LEFT_HAND.has(ch) ? 'L' : RIGHT_HAND.has(ch) ? 'R' : '?');

export function typingPersona(seed) {
  const r = rngOf(mix(seed, 'typing-persona'));
  return Object.freeze({
    seed,
    dwellMedianMs: r.uniform(62, 118),
    dwellSigma: r.uniform(0.22, 0.42),
    gapMedianMs: r.uniform(95, 235),
    gapSigma: r.uniform(0.34, 0.62),
    alternateHandFactor: r.uniform(0.74, 0.92),
    sameHandFactor: r.uniform(1.04, 1.24),
    sameKeyFactor: r.uniform(1.25, 1.75),
    hesitationRate: r.uniform(0.02, 0.07),
    hesitationMedianMs: r.uniform(420, 1250),
    hesitationSigma: r.uniform(0.40, 0.70),
  });
}

// [(dwell, gap)] karakterenként: a billentyű lent-ideje és a KÖVETKEZŐ
// lenyomásig hátralévő idő (az utolsónál 0).
export function planTyping(text, persona, nonce = 0) {
  const r = rngOf(mix(persona.seed, `typing:${nonce}`));
  const chars = Array.from(String(text));
  const out = [];
  chars.forEach((ch, i) => {
    const dwell = logNormal(r, persona.dwellMedianMs, persona.dwellSigma);
    if (i === chars.length - 1) { out.push([dwell, 0]); return; }
    const nxt = chars[i + 1];
    let gap = logNormal(r, persona.gapMedianMs, persona.gapSigma);
    if (ch === nxt) gap *= persona.sameKeyFactor;
    else {
      const a = handOf(ch), b = handOf(nxt);
      if (a !== '?' && b !== '?') gap *= (a !== b ? persona.alternateHandFactor : persona.sameHandFactor);
    }
    if (r.random() < persona.hesitationRate) gap += logNormal(r, persona.hesitationMedianMs, persona.hesitationSigma);
    out.push([dwell, gap]);
  });
  return out;
}

// Hová érkezik a mutató egy dobozon belül: Gauss a közép körül, a középső
// 2×keep sávba vágva — sosem pontosan a geometriai közép.
export function landingPoint(box, r, { spread = 0.20, keep = 0.40 } = {}) {
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  return [
    clamp(r.gauss(cx, box.width * spread), cx - keep * box.width, cx + keep * box.width),
    clamp(r.gauss(cy, box.height * spread), cy - keep * box.height, cy + keep * box.height),
  ];
}

// A kurzor kiinduló helye egy friss lapon — sosem (0, 0).
export function initialPointer(seed, viewport) {
  const w = viewport?.width || 1280, h = viewport?.height || 800;
  const r = rngOf(mix(seed, 'pointer-origin'));
  if (r.random() < 0.58) return [r.uniform(0.18 * w, 0.82 * w), r.uniform(0.12 * h, 0.78 * h)];
  return [r.uniform(0.08 * w, 0.72 * w), r.uniform(0.005 * h, 0.09 * h)];
}

// ─── Meghajtó ─────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(res => setTimeout(res, Math.max(0, ms)));
const now = () => performance.now();

// Egy munkamenet (= böngésző-indítás) „keze": egy mag → egy mozdulat-stílus,
// egy kattintás- és gépelési ritmus. A kurzor helye laponként (WeakMap) — a
// lapba semmi nem kerül.
export class HumanInput {
  constructor(seed) {
    this.seed = seed >>> 0;
    this.style = motionStyleForSeed(this.seed);
    this.pointer = pointerPersona(this.seed);
    this.typing = typingPersona(this.seed);
    this._pos = new WeakMap();
    this._pages = 0;
    this._moves = 0;
    this._nonces = new Map();
  }

  _nonce(kind) {
    const n = (this._nonces.get(kind) || 0) + 1;
    this._nonces.set(kind, n);
    return n;
  }

  position(page) {
    let p = this._pos.get(page);
    if (!p) {
      p = initialPointer(mix(this.seed, `page:${++this._pages}`), page.viewport?.() || null);
      this._pos.set(page, p);
    }
    return p;
  }

  // A mozdulat eseményei abszolút határidőkkel (egy t0-tól): ha a gép késik,
  // a túlhaladott közbülső pontot ELDOBJUK (ha a következő a „hatótávon" belül
  // van), sosem küldünk két eseményt egy pillanatban (≥ 8 ms). A végpont mindig megy.
  async move(page, x, y, { targetW = null } = {}) {
    const from = this.position(page);
    const path = planPath(from, [x, y], { seed: this.seed, index: this._moves++, targetW, style: this.style });
    const vp = page.viewport?.() || null;
    const clampVp = (px, py) => (vp?.width && vp?.height
      ? [clamp(px, 0, vp.width - 1), clamp(py, 0, vp.height - 1)] : [px, py]);
    let reach = 0;
    for (let i = 1; i < path.length; i++) reach = Math.max(reach, Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y));
    reach *= 2;
    const t0 = now();
    let lastEmit = -Infinity;
    let ref = from;
    let sent = 0;
    for (let i = 0; i < path.length; i++) {
      const ev = path[i];
      const last = i === path.length - 1;
      const nxt = path[i + 1];
      const droppable = !last && nxt && Math.hypot(nxt.x - ref[0], nxt.y - ref[1]) <= reach + 1e-9;
      const wait = t0 + ev.t - now();
      if (wait > 0) await sleep(wait);
      else if (droppable && now() >= t0 + nxt.t) continue;
      const behind = SAMPLE_FLOOR_MS - (now() - lastEmit);
      if (behind > 0) {
        if (droppable) continue;
        await sleep(behind);
      }
      const [px, py] = last ? [ev.x, ev.y] : clampVp(ev.x, ev.y);
      await page.mouse.move(px, py);
      lastEmit = now();
      ref = [ev.x, ev.y];
      sent++;
    }
    this._pos.set(page, [x, y]);
    return { events: sent, ms: Math.round(now() - t0) };
  }

  // Mozdulat a célra + gombnyomás valódi lent-idővel (dupla kattintásnál a
  // két nyomás közti szünettel). Érintős (mobil) nézetben nincs egérpálya.
  async click(page, x, y, { targetW = null, clickCount = 1, button = 'left' } = {}) {
    const touch = !!page.viewport?.()?.hasTouch;
    let mv = { events: 0, ms: 0 };
    if (!touch) mv = await this.move(page, x, y, { targetW });
    else await page.mouse.move(x, y);
    const plan = planClick(this.pointer, clickCount, this._nonce('click'));
    const t0 = now();
    for (let i = 0; i < plan.length; i++) {
      const [dwell, gap] = plan[i];
      await page.mouse.down({ button, clickCount: i + 1 });
      await sleep(dwell);
      await page.mouse.up({ button, clickCount: i + 1 });
      if (gap) await sleep(gap);
    }
    this._pos.set(page, [x, y]);
    return { move_events: mv.events, move_ms: mv.ms, press_ms: Math.round(now() - t0) };
  }

  // Elem-dobozra kattintás: a landolási pont a doboz közepe körül (nem a pixel-közép).
  async clickBox(page, box, opts = {}) {
    const r = rngOf(mix(this.seed, `land:${this._nonce('land')}`));
    const [x, y] = landingPoint(box, r);
    return this.click(page, x, y, { ...opts, targetW: opts.targetW ?? (Math.min(box.width, box.height) || null) });
  }

  // Céltalan kis mozdulat (olvasás közbeni „fészkelődés") a nézetablakon belül.
  async idle(page, { maxPx = 160 } = {}) {
    const [x0, y0] = this.position(page);
    const r = rngOf(mix(this.seed, `idle:${this._nonce('idle')}`));
    const vp = page.viewport?.() || { width: 1280, height: 800 };
    const ang = r.uniform(0, 2 * Math.PI);
    const d = r.uniform(maxPx * 0.2, maxPx);
    const x = clamp(x0 + Math.cos(ang) * d, 5, (vp.width || 1280) - 5);
    const y = clamp(y0 + Math.sin(ang) * d, 5, (vp.height || 800) - 5);
    return this.move(page, x, y);
  }

  // Gépelés valódi lent-idővel és digram-ritmussal. budgetMs: ha a terv
  // hosszabb, arányosan gyorsítjuk (padlóval); ha így sem fér bele (×0,25 alatti
  // skála), {humanized:false} — a hívó a régi gyors utat választja.
  async type(page, text, { budgetMs = 0 } = {}) {
    const chars = Array.from(String(text));
    if (!chars.length) return { humanized: true, ms: 0 };
    let plan = planTyping(text, this.typing, this._nonce('typing'));
    const total = plan.reduce((a, [d, g]) => a + d + g, 0);
    let scale = 1;
    if (budgetMs > 0 && total > budgetMs) {
      scale = budgetMs / total;
      if (scale < 0.25) return { humanized: false, reason: 'budget', planned_ms: Math.round(total) };
      plan = plan.map(([d, g]) => [Math.max(12, d * scale), Math.max(20, g * scale)]);
    }
    const t0 = now();
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      const [dwell, gap] = plan[i];
      let down = false;
      try { await page.keyboard.down(ch); down = true; } catch (_) { await page.keyboard.sendCharacter(ch); }
      await sleep(dwell);
      if (down) await page.keyboard.up(ch);
      if (gap) await sleep(gap);
    }
    return { humanized: true, ms: Math.round(now() - t0), scale: Math.round(scale * 100) / 100 };
  }
}
