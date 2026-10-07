// Emberi bemenet (W2, 2026-10-07): a tervezők tulajdonságai böngésző nélkül
// (a forrás — invisible_playwright tests/test_motion.py — szellemében:
// aritmetikával ellenőrizhető állítások), és a brave_page / brave_mouse_control
// HUMANIZE=1 útja egy valódi lapon, a LAP szemével (isTrusted, eseményszám,
// gombnyomás- és billentyű-idők).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findBrowser, startFixture } from './helpers.js';
import { challengeRoutes } from './fixtures/challenge-pages.js';
import {
  planPath, motionStyleForSeed, planTyping, typingPersona, planClick, pointerPersona, landingPoint, rngOf,
  initialPointer, humanizeEnabled, SAMPLE_FLOOR_MS, MAX_DURATION_MS, MIN_DURATION_MS,
} from '../src/stealth/humanize.js';

const browserPath = findBrowser();
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hz-profiles-'));
Object.assign(process.env, {
  NODE_ENV: 'test', BRAVE_EGRESS_ALLOW_TEST_LOOPBACK: '1', HEADLESS: 'true',
  BRAVE_WATCHDOG_DISABLED: 'true', BRAVE_PAGE_PROFILE_DIR: profileDir,
});
for (const k of Object.keys(process.env)) if (k.startsWith('RAILWAY_') || k === 'HUMANIZE' || k === 'HUMANIZE_SEED') delete process.env[k];
if (browserPath) process.env.BRAVE_PATH = browserPath;
const skip = !browserPath && 'nincs böngésző (BRAVE_PATH)';

// ─── 1. Tervezők ─────────────────────────────────────────────────────────
test('egérpálya: pontos végpont, 8 ms-os padló, Fitts-keret, determinizmus, mag-függő alak', () => {
  for (const seed of [1, 7, 42, 4242, 99991]) {
    for (let i = 0; i < 40; i++) {
      const from = [10 + i * 7, 600 - i * 9], to = [900 - i * 11, 40 + i * 13];
      const p = planPath(from, to, { seed, index: i });
      assert.ok(p.length >= 2);
      assert.deepEqual([p[0].x, p[0].y], from);
      assert.deepEqual([p[p.length - 1].x, p[p.length - 1].y], to);
      const dur = p[p.length - 1].t;
      assert.ok(dur >= MIN_DURATION_MS - 1e-6 && dur <= MAX_DURATION_MS + 1e-6, `dur ${dur}`);
      for (let j = 1; j < p.length; j++) {
        assert.ok(p[j].t - p[j - 1].t >= SAMPLE_FLOOR_MS - 1e-6, `gap ${p[j].t - p[j - 1].t}`);
        assert.ok(p[j].t > p[j - 1].t);
      }
      // nincs hosszú azonos-pixel sorozat a végén (a régi ease-out jele)
      let run = 0, maxRun = 0;
      for (let j = 1; j < p.length; j++) {
        if (Math.round(p[j].x) === Math.round(p[j - 1].x) && Math.round(p[j].y) === Math.round(p[j - 1].y)) maxRun = Math.max(maxRun, ++run); else run = 0;
      }
      assert.ok(maxRun <= 3, `pixel-ismétlés ${maxRun}`);
    }
  }
  // determinizmus + két mag két különböző alak ugyanazon két pont között
  const a1 = planPath([100, 100], [700, 400], { seed: 5, index: 3 });
  const a2 = planPath([100, 100], [700, 400], { seed: 5, index: 3 });
  const b = planPath([100, 100], [700, 400], { seed: 6, index: 3 });
  assert.deepEqual(a1, a2);
  assert.notDeepEqual(a1.map(p => [Math.round(p.x), Math.round(p.y)]), b.map(p => [Math.round(p.x), Math.round(p.y)]));
  // hosszabb út tovább tart (Fitts), átlagosan
  const avg = (d) => { let s = 0; for (let i = 0; i < 60; i++) { const p = planPath([0, 0], [d, 0], { seed: 11, index: i }); s += p[p.length - 1].t; } return s / 60; };
  assert.ok(avg(800) > avg(60) * 1.3, `${avg(800)} vs ${avg(60)}`);
  // al-pixeles mozdulat: egyetlen esemény
  assert.equal(planPath([10.2, 10.2], [10.4, 10.1], { seed: 1 }).length, 1);
  // a stílus mag-függő, korlátok között
  const st = motionStyleForSeed(123);
  assert.ok(st.stepMs >= 8 && st.stepMs <= 18 && st.knots >= 1 && st.knots <= 3);
});

test('egérpálya: a remegés nulla átlagú és kétdimenziós (nem egy irányú)', () => {
  // jitter nélkül ugyanaz a pálya (a remegés az UTOLSÓ húzó szakasz) → pontonkénti különbség
  const along = [], across = [];
  for (let i = 0; i < 200; i++) {
    const a = planPath([50, 50], [850, 450], { seed: 3, index: i, jitter: true });
    const b = planPath([50, 50], [850, 450], { seed: 3, index: i, jitter: false });
    if (a.length !== b.length) continue;   // a pixel-ismétlés-összevonás eltérhet
    const ux = 800 / Math.hypot(800, 400), uy = 400 / Math.hypot(800, 400);
    for (let j = 1; j < a.length - 1; j++) {
      const dx = a[j].x - b[j].x, dy = a[j].y - b[j].y;
      along.push(dx * ux + dy * uy);
      across.push(-dx * uy + dy * ux);
    }
  }
  assert.ok(along.length > 500);
  const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
  const sd = (v) => Math.sqrt(mean(v.map(x => (x - mean(v)) ** 2)));
  assert.ok(Math.abs(mean(across)) < 0.1 * sd(across) + 0.01, `across mean ${mean(across)}`);
  assert.ok(Math.abs(mean(along)) < 0.1 * sd(along) + 0.01, `along mean ${mean(along)}`);
  assert.ok(sd(along) > 0.05 && sd(across) > 0.05, `sd ${sd(along)} / ${sd(across)}`);
});

test('gépelés: log-normál dwell/gap, digram-hatás, determinizmus; kattintás-dwell; landolás', () => {
  const tp = typingPersona(77);
  const plan = planTyping('hello world, this is a typing rhythm test', tp, 1);
  assert.equal(plan.length, 'hello world, this is a typing rhythm test'.length);
  assert.equal(plan[plan.length - 1][1], 0);
  for (const [d, g] of plan) { assert.ok(d > 15 && d < 600, `dwell ${d}`); assert.ok(g >= 0 && g < 8000, `gap ${g}`); }
  assert.deepEqual(planTyping('abc', tp, 5), planTyping('abc', tp, 5));
  assert.notDeepEqual(planTyping('abc', tp, 5), planTyping('abc', tp, 6));
  // azonos billentyű lassabb, mint kézváltás (átlagosan, sok mintán)
  const avgGap = (txt) => { let s = 0, n = 0; for (let k = 0; k < 300; k++) { const p = planTyping(txt, tp, k); s += p[0][1]; n++; } return s / n; };
  assert.ok(avgGap('ss') > avgGap('sj'), `${avgGap('ss')} vs ${avgGap('sj')}`);
  const cp = planClick(pointerPersona(9), 2, 1);
  assert.equal(cp.length, 2);
  assert.ok(cp[0][0] > 20 && cp[0][1] > 30 && cp[1][1] === 0);
  const r = rngOf(1);
  for (let i = 0; i < 500; i++) {
    const [x, y] = landingPoint({ x: 100, y: 200, width: 50, height: 20 }, r);
    assert.ok(x >= 105 && x <= 145 && y >= 202 && y <= 218);
  }
  const ip = initialPointer(5, { width: 1280, height: 800 });
  assert.ok(ip[0] > 0 && ip[1] > 0 && ip[0] < 1280 && ip[1] < 800);
  assert.equal(humanizeEnabled({ HUMANIZE: '1' }), true);
  assert.equal(humanizeEnabled({}), false);
});

// ─── 2. Valódi lap: brave_page HUMANIZE=1 vs KI ──────────────────────────
let fx, c;
test.before(async () => {
  if (!browserPath) return;
  fx = await startFixture(challengeRoutes());
  const { BraveController } = await import('../src/brave-controller.js');
  c = new BraveController();
  await c.initialize();
});
test.after(async () => {
  if (c) await c.close();
  if (fx) await fx.close();
  fs.rmSync(profileDir, { recursive: true, force: true });
});

const js = (script) => ({ type: 'executeJavascript', script });
async function runHuman(on) {
  if (on) process.env.HUMANIZE = '1'; else delete process.env.HUMANIZE;
  try {
    const r = await c.pageTool({
      url: `${fx.base}/human`, timeout_ms: 20000,
      actions: [
        { type: 'click', selector: '#inp' },
        { type: 'write', text: 'hello world' },
        { type: 'click', selector: '#btn' },
        js('JSON.stringify({t: document.title, v: document.getElementById("inp").value, ev: window.__ev})'),
      ],
    });
    assert.equal(r.ok, true, JSON.stringify(r.action_results));
    return JSON.parse(r.action_results[3].js_result);
  } finally { delete process.env.HUMANIZE; }
}

function stats(ev) {
  const downs = ev.filter(e => e.t === 'mousedown'), ups = ev.filter(e => e.t === 'mouseup');
  const kd = ev.filter(e => e.t === 'keydown'), ku = ev.filter(e => e.t === 'keyup');
  const press = downs.map((d, i) => (ups[i] ? ups[i].ts - d.ts : NaN));
  const dwell = kd.map((d, i) => (ku[i] ? ku[i].ts - d.ts : NaN));
  const gaps = kd.slice(1).map((d, i) => d.ts - kd[i].ts);
  const lastBtnDown = downs[downs.length - 1];
  const movesBeforeBtn = ev.filter(e => e.t === 'mousemove' && lastBtnDown && e.ts < lastBtnDown.ts && e.ts > (downs[0]?.ts ?? 0)).length;
  return { press, dwell, gaps, movesBeforeBtn, allTrusted: ev.every(e => e.tr), moves: ev.filter(e => e.t === 'mousemove').length };
}

test('brave_page HUMANIZE=1: egérpálya a célig, valódi gombnyomás-idő, gépelési ritmus — mind trusted', { skip, timeout: 90000 }, async (t) => {
  const on = await runHuman(true);
  assert.equal(on.t, 'clicked');
  assert.equal(on.v, 'hello world');
  const s = stats(on.ev);
  t.diagnostic(`HUMANIZE=1: moves=${s.moves} moves_to_btn=${s.movesBeforeBtn} press=${s.press.map(Math.round)} dwell_med=${Math.round(s.dwell.sort((a, b) => a - b)[5])} gap_med=${Math.round(s.gaps.sort((a, b) => a - b)[5])}`);
  assert.ok(s.allTrusted);
  assert.ok(s.movesBeforeBtn >= 5, `mozgás a gombig: ${s.movesBeforeBtn}`);
  assert.ok(s.press.every(p => p >= 20), `gombnyomás: ${s.press}`);
  assert.equal(s.dwell.length, 11);
  assert.ok(s.dwell.every(d => d >= 10), `dwell: ${s.dwell}`);
  assert.ok(s.gaps.every(g => g >= 20), `gap: ${s.gaps}`);

  const off = await runHuman(false);
  assert.equal(off.t, 'clicked');
  assert.equal(off.v, 'hello world');
  const o = stats(off.ev);
  t.diagnostic(`KI: moves=${o.moves} press=${o.press.map(Math.round)} gap_max=${Math.round(Math.max(...o.gaps))}`);
  // KI: a régi gépi út (egy-egy esemény, ~0 ms-os nyomás és billentyűköz)
  assert.ok(o.moves <= 3, `KI moves=${o.moves}`);
  assert.ok(o.press.every(p => p < 15), `KI press: ${o.press}`);
});

test('brave_mouse_control HUMANIZE=1: nincs lapba írt window.mouseX, sok trusted mozgás', { skip, timeout: 60000 }, async () => {
  await c.navigate(`${fx.base}/human`, { waitTime: 200 });
  process.env.HUMANIZE = '1';
  try {
    const r = await c.mouseControl({ action: 'click', x: 760, y: 515 });
    assert.equal(r.humanized, true);
  } finally { delete process.env.HUMANIZE; }
  const page = await c.getInteractivePage();
  const out = await page.evaluate(() => ({ t: document.title, leak: 'mouseX' in window, moves: window.__ev.filter(e => e.t === 'mousemove' && e.tr).length }));
  assert.equal(out.t, 'clicked');
  assert.equal(out.leak, false);
  assert.ok(out.moves >= 5, `moves=${out.moves}`);
});
