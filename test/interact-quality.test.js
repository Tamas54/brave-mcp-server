// brave_page — interakció-minőség (R2-E, 2026-10-07): akció-hiba diagnózis
// (P1-2), trusted-input fegyelem (P2-1), gépelés-visszaolvasás (P2-2).
//
// Helyi fixture-lapok a 127.0.0.1-en (a brave-page.test.js teszt-kivételével:
// BRAVE_EGRESS_ALLOW_TEST_LOOPBACK=1 + NODE_ENV=test). A lapok maguk rögzítik az
// események `isTrusted`-jét — így a teszt a LAP szemével látja, valódi (CDP-
// egér/billentyű) vagy szintetikus (JS) volt-e a bemenet.
// Böngésző nélkül (nincs BRAVE_PATH / chrome) a fájl kimarad.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findBrowser, startFixture } from './helpers.js';
import { keptVerdict, nextMove, NEXT_MOVE } from '../src/action-diagnose.js';

const browserPath = findBrowser();
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iq-profiles-'));
Object.assign(process.env, {
  NODE_ENV: 'test',
  BRAVE_EGRESS_ALLOW_TEST_LOOPBACK: '1',
  HEADLESS: 'true',
  BRAVE_WATCHDOG_DISABLED: 'true',
  BRAVE_PAGE_PROFILE_DIR: profileDir,
});
for (const k of Object.keys(process.env)) if (k.startsWith('RAILWAY_')) delete process.env[k];
if (browserPath) process.env.BRAVE_PATH = browserPath;

// Közös napló a lapon: window.__log = [{ev, id, trusted}]
const LOG = `<script>window.__log=[];const L=(ev,e)=>__log.push({ev,id:(e.target&&e.target.id)||'',trusted:e.isTrusted});
document.addEventListener('click',e=>L('click',e),true);</script>`;

const ROUTES = {
  // Cookie-banner TAKARJA a „Vásárlás" gombot (fix, a nézetablak alján).
  '/banner': `<!doctype html><title>Banner</title>${LOG}
    <style>body{margin:0;height:1200px} #buy{position:absolute;top:650px;left:40px;width:160px;height:40px}
    #cookie-banner{position:fixed;left:0;right:0;bottom:0;height:300px;background:#222;color:#fff;z-index:99}</style>
    <button id="buy" onclick="document.title='bought'">Buy now</button>
    <button id="off" disabled>Disabled</button>
    <a id="hidden" href="#h" style="display:none" onclick="document.title='hidden-clicked'">hidden</a>
    <div id="cookie-banner" class="consent-banner">We use cookies to improve your experience.
      <button id="accept" onclick="document.getElementById('cookie-banner').remove()">Accept all</button></div>`,
  // React-szerű VEZÉRELT mező: a belső állapot csak a natív (billentyűzetes)
  // bevitelre változik; a JS-ből írt .value-t a „value tracker" elnyeli (React).
  '/controlled': `<!doctype html><title>Controlled</title>
    <input id="ctl"><div id="state"></div>
    <script>
      const inp = document.getElementById('ctl');
      const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      let state = 'elozo ertek', tracked = state;
      Object.defineProperty(inp, 'value', { configurable: true,
        get() { return desc.get.call(this); },
        set(v) { tracked = String(v); desc.set.call(this, v); } });
      inp.value = state;
      inp.addEventListener('input', () => { const v = desc.get.call(inp); if (v !== tracked) { tracked = v; state = v; }
        document.getElementById('state').textContent = state; });
      document.getElementById('state').textContent = state;
      window.__state = () => state;
    </script>`,
  // Gépelés-visszaolvasás: maxlength, chip-mező, OTP-dobozok, újraformázó, jelszó.
  '/fields': `<!doctype html><title>Fields</title>
    <input id="short" maxlength="5">
    <input id="chips" placeholder="emails"><div id="chiplist"></div>
    <input id="otp1" maxlength="1"><input id="otp2" maxlength="1"><input id="otp3" maxlength="1">
    <input id="phone">
    <input id="plain">
    <input id="pw" type="password">
    <input id="ro" readonly value="fixed">
    <script>
      const chips = document.getElementById('chips');
      chips.addEventListener('input', () => { if (chips.value.includes(',')) {
        const d = document.createElement('span'); d.textContent = chips.value.replace(',', ''); document.getElementById('chiplist').appendChild(d);
        chips.value = ''; } });
      for (const [a, b] of [['otp1', 'otp2'], ['otp2', 'otp3']]) {
        document.getElementById(a).addEventListener('input', (e) => { if (e.target.value.length >= 1) document.getElementById(b).focus(); });
      }
      const ph = document.getElementById('phone');
      ph.addEventListener('input', () => { const d = ph.value.replace(/\\D/g, '');
        ph.value = d.length > 3 ? '(' + d.slice(0, 3) + ') ' + d.slice(3) : d; });
    </script>`,
  // Sima görgetés (scroll-behavior: smooth) + a látómezőn kívüli gomb: görgetés, megállás, valódi kattintás.
  '/smooth': `<!doctype html><title>Smooth</title>${LOG}<style>html{scroll-behavior:smooth} body{margin:0;height:4000px}
    #far{position:absolute;top:3000px;left:50px;width:120px;height:30px}</style>
    <button id="far" onclick="document.title='far-clicked'">Far away</button>`,
  // P3-4: a lap MutationObserverrel számolja a DOM-változást.
  '/mutations': `<!doctype html><title>Mut</title><style>a,button{display:inline-block;margin:20px;padding:10px 30px}</style>
    <a href="/a">First link</a><button>Second button</button><a href="/b">Third link</a>
    <script>window.__mut=0;new MutationObserver(l=>{window.__mut+=l.length}).observe(document,{subtree:true,childList:true,attributes:true});</script>`,
  '/select': `<!doctype html><title>Select</title>
    <select id="sort"><option value="d">Default</option><option value="p">Price</option><option value="x" disabled>Gone</option><option value="r">Rating</option></select>
    <select id="multi" multiple><option>A</option><option>B</option></select>
    <div id="notsel">x</div>
    <script>window.__ch=[];document.getElementById('sort').addEventListener('change',e=>__ch.push({v:e.target.value,trusted:e.isTrusted}));</script>`,
};

let fx, c;

test.before(async () => {
  if (!browserPath) return;
  fx = await startFixture(ROUTES);
  const { BraveController } = await import('../src/brave-controller.js');
  c = new BraveController();
  await c.initialize();
});

test.after(async () => {
  if (c) await c.close();
  if (fx) await fx.close();
  fs.rmSync(profileDir, { recursive: true, force: true });
});

const skip = !browserPath && 'nincs böngésző (BRAVE_PATH)';
const run = (args) => c.pageTool(args);
const js = (script) => ({ type: 'executeJavascript', script });

// ── tiszta függvények (böngésző nélkül is) ─────────────────────────────
test('keptVerdict: full / truncated / emptied / focus_moved / reformatted / unreadable', () => {
  const st = (value, focused = true, maxlength = null) => ({ value, focused, secret: false, maxlength });
  assert.equal(keptVerdict('hello', st(''), st('hello')).kept, 'full');
  const f2 = keptVerdict('hello', st(''), st('hello', false));
  assert.equal(f2.kept, 'full'); assert.equal(f2.focus_moved, true);
  const t = keptVerdict('abcdefgh', st(''), st('abcde', true, 5));
  assert.equal(t.kept, 'truncated'); assert.equal(t.kept_len, 5); assert.equal(t.maxlength, 5);
  assert.equal(keptVerdict('a@b.io,', st(''), st('')).kept, 'emptied');
  assert.equal(keptVerdict('123', st(''), st('1', false)).kept, 'focus_moved');
  assert.equal(keptVerdict('1234567', st(''), st('(123) 4567')).kept, 'reformatted');
  assert.equal(keptVerdict('x', st(''), { value: null }).kept, 'unreadable');
  // a write HOZZÁFŰZ: a korábbi tartalom után az ÚJ rész számít
  assert.equal(keptVerdict('def', st('abc'), st('abcdef')).kept, 'full');
  // értéket SOSEM ad vissza
  assert.ok(!JSON.stringify(keptVerdict('TITOK-123', st(''), st('TITOK-1'))).includes('TITOK'));
});

test('nextMove: minden diagnózis-ágnak van mondata', () => {
  assert.equal(nextMove({ bad_selector: true }), NEXT_MOVE.bad_selector);
  assert.equal(nextMove({ matches: 0 }), NEXT_MOVE.matches);
  assert.equal(nextMove({ matches: 1, covered_by: { tag: 'div' } }), NEXT_MOVE.covered_by);
  assert.equal(nextMove({ matches: 1, disabled: true }), NEXT_MOVE.disabled);
  assert.equal(nextMove({ matches: 1, width: 0, height: 0 }), NEXT_MOVE.display_none);
  assert.equal(nextMove({ matches: 3, width: 10, height: 10 }), NEXT_MOVE.ambiguous);
  assert.equal(nextMove(null), NEXT_MOVE.momentary);
});

// ── P1-2: akció-hiba diagnózis ────────────────────────────────────────
test('P1-2: cookie-banner takarja a gombot → why.covered_by + next, a takaróra SEM kattint', { skip }, async () => {
  const r = await run({
    url: `${fx.base}/banner`, keep_session: true,
    actions: [{ type: 'click', selector: '#buy' }],
  });
  assert.equal(r.ok, false);
  const a = r.action_results[0];
  assert.equal(a.ok, false);
  assert.match(a.error, /^not_clickable: covered by div#cookie-banner/);
  assert.equal(a.why.covered_by.tag, 'div');
  assert.equal(a.why.covered_by.id, 'cookie-banner');
  assert.match(a.why.covered_by.class, /consent-banner/);
  assert.match(a.why.covered_by.text, /We use cookies/);
  assert.equal(a.why.covered_by.position, 'fixed');
  assert.ok(a.why.width > 0 && a.why.height > 0);
  assert.match(a.next, /cookie banner|dialog/);
  // a lap szemével: SEMMI kattintás nem történt (sem a gombon, sem a banneren)
  const log = await run({ session_id: r.session_id, actions: [js('JSON.stringify(window.__log)')] });
  assert.deepEqual(JSON.parse(log.action_results[0].js_result), []);
  // a banner bezárása (valódi kattintás), utána a gomb már megy — trusted
  const r2 = await run({
    session_id: r.session_id, formats: ['text'],
    actions: [{ type: 'click', selector: '#accept' }, { type: 'click', selector: '#buy' },
      js('JSON.stringify({t: document.title, log: window.__log})')],
  });
  assert.equal(r2.ok, true, JSON.stringify(r2.action_results));
  const out = JSON.parse(r2.action_results[2].js_result);
  assert.equal(out.t, 'bought');
  assert.deepEqual(out.log.map(x => [x.id, x.trusted]), [['accept', true], ['buy', true]]);
  assert.ok(!r2.warnings.includes('untrusted_click_fallback'));
  await run({ session_id: r.session_id, close: true });
});

test('P1-2: nincs találat / rossz szelektor / letiltott / szöveg nélkül — mindnek van why + next', { skip }, async () => {
  const miss = await run({ url: `${fx.base}/banner`, timeout_ms: 5000, actions: [{ type: 'click', selector: '#nincs-ilyen' }] });
  assert.equal(miss.action_results[0].ok, false);
  assert.deepEqual(miss.action_results[0].why, { matches: 0 });
  assert.equal(miss.action_results[0].next, NEXT_MOVE.matches);

  const t0 = Date.now();
  const bad = await run({ url: `${fx.base}/banner`, actions: [{ type: 'click', selector: 'div[[' }] });
  assert.equal(bad.action_results[0].why.bad_selector, true);
  assert.equal(bad.action_results[0].next, NEXT_MOVE.bad_selector);
  assert.ok(Date.now() - t0 < 8000, 'a rossz szelektor nem várja ki a timeoutot');

  const dis = await run({ url: `${fx.base}/banner`, actions: [{ type: 'click', selector: '#off' }] });
  assert.equal(dis.action_results[0].error, 'not_clickable: disabled');
  assert.equal(dis.action_results[0].why.disabled, true);
  assert.equal(dis.action_results[0].next, NEXT_MOVE.disabled);

  const txt = await run({ url: `${fx.base}/banner`, actions: [{ type: 'click', text: 'Nincs ilyen felirat' }] });
  assert.equal(txt.action_results[0].error, 'no element matches text');
  assert.equal(txt.action_results[0].next, NEXT_MOVE.text_matches);

  const ro = await run({ url: `${fx.base}/fields`, actions: [{ type: 'write', selector: '#ro', text: 'x' }] });
  assert.equal(ro.action_results[0].error, 'not_editable: readonly');
  assert.equal(ro.action_results[0].why.readonly, true);
});

// ── P2-1: trusted-input fegyelem ──────────────────────────────────────
test('P2-1: rejtett elemre a JS-fallback KIMONDVA (untrusted_click_fallback), x/y-nál a cél leírása', { skip }, async () => {
  const r = await run({
    url: `${fx.base}/banner`,
    actions: [{ type: 'click', selector: '#hidden' }, js('JSON.stringify({t: document.title, log: window.__log})')],
  });
  assert.equal(r.ok, true, JSON.stringify(r.action_results));
  assert.equal(r.action_results[0].untrusted, true);
  assert.equal(r.action_results[0].why.display_none, true);
  assert.ok(r.warnings.includes('untrusted_click_fallback'));
  const out = JSON.parse(r.action_results[1].js_result);
  assert.equal(out.t, 'hidden-clicked');
  assert.deepEqual(out.log.map(x => x.trusted), [false]);

  const xy = await run({ url: `${fx.base}/banner`, actions: [{ type: 'click', x: 100, y: 700 }] });
  assert.equal(xy.action_results[0].target.id, 'cookie-banner');
});

test('P2-1: látómezőn kívüli elem sima görgetésű lapon — görgetés, megállás, VALÓDI kattintás', { skip }, async () => {
  const r = await run({ url: `${fx.base}/smooth`, actions: [{ type: 'click', selector: '#far' }, js('JSON.stringify({t: document.title, log: window.__log})')] });
  assert.equal(r.ok, true, JSON.stringify(r.action_results));
  assert.ok(!r.action_results[0].untrusted);
  const out = JSON.parse(r.action_results[1].js_result);
  assert.equal(out.t, 'far-clicked');
  assert.deepEqual(out.log.map(x => [x.id, x.trusted]), [['far', true]]);
});

test('P2-1: React-szerű vezérelt mező — billentyűzetes clear után a DOM és a belső állapot is üres', { skip }, async () => {
  const r = await run({
    url: `${fx.base}/controlled`,
    actions: [
      { type: 'clear', selector: '#ctl' },
      js('JSON.stringify({dom: document.getElementById("ctl").value, state: window.__state()})'),
      { type: 'write', selector: '#ctl', text: 'uj ertek' },
      js('JSON.stringify({dom: document.getElementById("ctl").value, state: window.__state()})'),
    ],
  });
  assert.equal(r.ok, true, JSON.stringify(r.action_results));
  assert.equal(r.action_results[0].cleared, true);
  assert.deepEqual(JSON.parse(r.action_results[1].js_result), { dom: '', state: '' });
  assert.equal(r.action_results[2].kept, 'full');
  assert.deepEqual(JSON.parse(r.action_results[3].js_result), { dom: 'uj ertek', state: 'uj ertek' });
  // Kontroll: a RÉGI motor-oldali JS-ürítés (el.value='' + szintetikus input) ugyanitt
  // szétválasztja a DOM-ot és az állapotot — ezért kellett a billentyűzetes út.
  const old = await run({
    url: `${fx.base}/controlled`,
    actions: [js(`(() => { const el = document.getElementById('ctl'); el.value = ''; el.dispatchEvent(new Event('input', {bubbles: true}));
      return JSON.stringify({dom: el.value, state: window.__state()}); })()`)],
  });
  assert.deepEqual(JSON.parse(old.action_results[0].js_result), { dom: '', state: 'elozo ertek' });
});

test('P2-1: select billentyűzettel (trusted change-esemény), opció-hiány listával, nem-select', { skip }, async () => {
  const r = await run({
    url: `${fx.base}/select`,
    actions: [{ type: 'select', selector: '#sort', value: 'Rating' }, js('JSON.stringify({v: document.getElementById("sort").value, ch: window.__ch})')],
  });
  assert.equal(r.ok, true, JSON.stringify(r.action_results));
  assert.equal(r.action_results[0].selected, 'Rating');
  assert.equal(r.action_results[0].matched_by, 'label');
  assert.ok(!r.action_results[0].untrusted);
  const out = JSON.parse(r.action_results[1].js_result);
  assert.equal(out.v, 'r');
  assert.ok(out.ch.length >= 1 && out.ch.every(x => x.trusted === true), JSON.stringify(out.ch));
  assert.ok(!r.warnings.includes('untrusted_select_fallback'));

  const back = await run({ url: `${fx.base}/select`, actions: [{ type: 'select', selector: '#sort', value: 'p' }] });
  assert.equal(back.action_results[0].matched_by, 'value');

  const nf = await run({ url: `${fx.base}/select`, actions: [{ type: 'select', selector: '#sort', value: 'Nincs' }] });
  assert.equal(nf.action_results[0].error, 'option_not_found');
  assert.deepEqual(nf.action_results[0].options, ['Default', 'Price', 'Gone', 'Rating']);
  const ns = await run({ url: `${fx.base}/select`, actions: [{ type: 'select', selector: '#notsel', value: 'x' }] });
  assert.equal(ns.action_results[0].error, 'not_a_select');
  // többes select: a billentyű nem jó út → JS, KIMONDVA
  const mu = await run({ url: `${fx.base}/select`, actions: [{ type: 'select', selector: '#multi', value: 'B' }] });
  assert.equal(mu.action_results[0].untrusted, true);
  assert.ok(mu.warnings.includes('untrusted_select_fallback'));
});

// ── P2-2: gépelés-visszaolvasás ───────────────────────────────────────
test('P2-2: kept = truncated / emptied (chip) / focus_moved (OTP) / reformatted / full; jelszónál érték nélkül', { skip }, async () => {
  const r = await run({
    url: `${fx.base}/fields`,
    actions: [
      { type: 'write', selector: '#short', text: 'abcdefgh' },
      { type: 'write', selector: '#chips', text: 'a@b.io,' },
      { type: 'write', selector: '#otp1', text: '123' },
      { type: 'write', selector: '#phone', text: '1234567' },
      { type: 'write', selector: '#plain', text: 'hello' },
      { type: 'write', selector: '#pw', text: 'JELSZO-TITOK-77' },
    ],
  });
  assert.equal(r.ok, true, JSON.stringify(r.action_results));
  const k = r.action_results.map(x => x.kept);
  assert.deepEqual(k, ['truncated', 'emptied', 'focus_moved', 'reformatted', 'full', 'full']);
  assert.equal(r.action_results[0].kept_len, 5);
  assert.equal(r.action_results[0].maxlength, 5);
  assert.match(r.action_results[1].kept_note, /chip|item/);
  assert.equal(r.action_results[2].kept_len, 1);
  assert.equal(r.action_results[5].kept_len, 15);
  assert.ok(!JSON.stringify(r).includes('JELSZO-TITOK-77'), 'a jelszó nem jöhet vissza');
});

// ── P3-4: set-of-marks jelölők a KÉPRE, nem a lap DOM-jába ─────────────
test('P3-4: brave_marked_snapshot — alapból 0 DOM-mutáció (jelölő a képen), dom_markers=true a régi út', { skip }, async () => {
  await c.navigate(`${fx.base}/mutations`, { waitTime: 200 });
  const r = await c.markedSnapshot({});
  assert.equal(r.markers, 'image', JSON.stringify(r.warnings));
  assert.ok(r.count >= 3);
  assert.deepEqual(Object.keys(r.elements[0]).sort(), ['href', 'label', 'n', 'x', 'y']);
  assert.match(r.screenshot, /^data:image\/png;base64,/);
  const page = await c.getInteractivePage();
  assert.equal(await page.evaluate(() => window.__mut), 0, 'a céllap DOM-ja nem változhat');
  // a jelölt kép NEM azonos a tiszta képpel (a számok rákerültek)
  const clean = await page.screenshot({ encoding: 'base64' });
  assert.notEqual(r.screenshot.slice(22), clean);
  const old = await c.markedSnapshot({ dom_markers: true });
  assert.equal(old.markers, 'dom');
  assert.ok(await page.evaluate(() => window.__mut) > 0);
});
