// brave_page — böngészős tesztek egy 127.0.0.1-es fixture-szerverrel.
//
// A helyi lapokat az egress-szűrő SZÁNDÉKOSAN tiltja, ezért ez a fájl a
// teszt-kivétellel fut: BRAVE_EGRESS_ALLOW_TEST_LOOPBACK=1 + NODE_ENV=test (és
// nincs RAILWAY_* env) — CSAK a 127.0.0.0/8 és ::1 nyílik meg, a belső háló
// (10/8, 169.254/16, …) továbbra is tiltott, amit itt is ellenőrzünk.
// Böngésző nélkül (nincs BRAVE_PATH / chrome) a fájl kimarad.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findBrowser, startFixture } from './helpers.js';

const browserPath = findBrowser();
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-profiles-'));
Object.assign(process.env, {
  NODE_ENV: 'test',
  BRAVE_EGRESS_ALLOW_TEST_LOOPBACK: '1',
  HEADLESS: 'true',
  BRAVE_WATCHDOG_DISABLED: 'true',
  BRAVE_PAGE_PROFILE_DIR: profileDir,
});
for (const k of Object.keys(process.env)) if (k.startsWith('RAILWAY_')) delete process.env[k];
if (browserPath) process.env.BRAVE_PATH = browserPath;

const DL_NAME = `bp-dl-${process.pid}-${Date.now()}.bin`;
const noise = Array.from({ length: 4000 }, (_, i) => `<span style="color:#${((i * 2654435761) >>> 8 & 0xffffff).toString(16).padStart(6, '0')}">${(i * 7919 % 1000).toString(36)}</span>`).join('');

const ROUTES = {
  '/form': `<!doctype html><title>Form</title>
    <input id="q" autofocus><button id="go" onclick="document.getElementById('out').textContent='Hello '+document.getElementById('q').value">Go</button>
    <div id="out"></div><a href="/page2">Next page</a>
    <div id="clicks">0</div><button class="c" onclick="clicks.textContent=+clicks.textContent+1">c</button><button class="c" onclick="clicks.textContent=+clicks.textContent+1">c</button>`,
  '/page2': '<!doctype html><title>Second</title><h1>Second page</h1>',
  '/responsive': '<!doctype html><meta name="viewport" content="width=device-width"><title>Resp</title><p>r</p>',
  '/submit': `<!doctype html><title>Submit</title><form action="/page2" method="get"><input id="s" name="s" autofocus></form>`,
  '/long': `<!doctype html><title>Long</title><div style="height:30000px;background:linear-gradient(red,blue)">top</div><p id="bottom">bottom</p>`,
  '/noise': `<!doctype html><title>Noise</title><div style="font-size:9px;word-break:break-all">${noise}</div>`,
  '/setstate': `<!doctype html><title>Set</title><script>document.cookie='pc=cookie-ok; path=/; max-age=3600';localStorage.setItem('lk','ls-ok');</script>set`,
  '/readstate': `<!doctype html><title>Read</title><div id="r"></div><script>document.getElementById('r').textContent=(document.cookie||'none')+'|'+(localStorage.getItem('lk')||'none');</script>`,
  '/echo-headers': (req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(req.headers)); },
  '/redirect-internal': (req, res) => { res.writeHead(302, { location: 'http://10.0.0.1/admin' }); res.end(); },
  '/sub-internal': '<!doctype html><title>Sub</title><img src="http://10.0.0.2/pixel.png"><p>body</p>',
  '/ads': `<!doctype html><title>Ads</title><script>window.__ad='pending'</script>
    <script src="https://securepubads.g.doubleclick.net/tag/js/gpt.js" onerror="window.__ad='blocked'" onload="window.__ad='loaded'"></script>`,
  '/popup': `<!doctype html><title>Popup</title><a id="p" href="/page2" target="_blank">open popup</a>`,
  '/alert': `<!doctype html><title>Alert</title><script>alert('hi');document.title='after-alert'</script>`,
  '/tofile': `<!doctype html><title>ToFile</title><script>setTimeout(()=>{location.href='file:///etc/hostname'},20)</script>`,
  '/download': (req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${DL_NAME}"` });
    res.end(Buffer.alloc(1024, 7));
  },
  '/dl-link': `<!doctype html><title>DL</title><a id="d" href="/download" download>dl</a>`,
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

test('one-shot: write + click + wait + scrape, formats html/text/links', { skip }, async () => {
  const r = await run({
    url: `${fx.base}/form`,
    formats: ['html', 'text', 'links'],
    actions: [
      { type: 'write', selector: '#q', text: 'world' },
      { type: 'click', selector: '#go' },
      { type: 'wait', selector: '#out' },
      { type: 'scrape' },
    ],
  });
  assert.equal(r.ok, true, JSON.stringify(r.warnings) + r.error);
  assert.equal(r.session_id, null);
  assert.equal(r.status, 200);
  assert.equal(r.title, 'Form');
  assert.match(r.text, /Hello world/);
  assert.match(r.html, /Hello world/);
  assert.ok(r.links.includes(`${fx.base}/page2`));
  assert.equal(r.action_results.length, 4);
  assert.ok(r.action_results.every(a => a.ok));
  assert.match(r.action_results[3].html, /Hello world/);
  assert.equal(typeof r.elapsed_ms, 'number');
  for (const k of ['ok', 'session_id', 'url', 'final_url', 'status', 'title', 'html', 'text', 'links', 'screenshot', 'action_results', 'blocked', 'warnings', 'elapsed_ms']) {
    assert.ok(k in r, `szerződés-kulcs hiányzik: ${k}`);
  }
});

test('click: text szerint, x/y koordinátával, all:true', { skip }, async () => {
  const r1 = await run({ url: `${fx.base}/form`, actions: [{ type: 'click', text: 'Next page' }] });
  assert.equal(r1.ok, true, r1.error);
  assert.equal(r1.final_url, `${fx.base}/page2`);
  assert.equal(r1.title, 'Second');

  const r2 = await run({
    url: `${fx.base}/form`, keep_session: true, formats: ['text'],
    actions: [
      { type: 'write', selector: '#q', text: 'xy' },
      { type: 'executeJavascript', script: 'const b = document.getElementById("go").getBoundingClientRect(); return {x: b.x + b.width/2, y: b.y + b.height/2}' },
    ],
  });
  const { x, y } = r2.action_results[1].js_result;
  const r3 = await run({ session_id: r2.session_id, formats: ['text'], actions: [{ type: 'click', x, y }, { type: 'click', selector: 'button.c', all: true }] });
  assert.equal(r3.ok, true, r3.error);
  assert.match(r3.text, /Hello xy/);
  assert.equal(r3.action_results[1].clicked, 2);
  assert.match(r3.text, /\n2\n|^2$|\b2\b/);
  await run({ session_id: r2.session_id, close: true });
});

test('press Enter űrlapot küld (navigáció megvárva); scroll', { skip }, async () => {
  const r = await run({ url: `${fx.base}/submit`, actions: [{ type: 'write', selector: '#s', text: 'abc' }, { type: 'press', key: 'Enter' }] });
  assert.equal(r.ok, true, r.error);
  assert.match(r.final_url, /\/page2\?s=abc$/);
  const s = await run({ url: `${fx.base}/long`, actions: [{ type: 'scroll', direction: 'down', amount: 1500 }, { type: 'executeJavascript', script: 'window.scrollY' }] });
  assert.equal(s.action_results[1].js_result, 1500);
  const bad = await run({ url: `${fx.base}/long`, actions: [{ type: 'press', key: 'NotARealKey' }, { type: 'scrape' }] });
  assert.equal(bad.ok, false);
  assert.equal(bad.action_results[0].ok, false);
  assert.match(bad.action_results[1].error, /skipped/);
});

test('screenshot: JPEG data-URI, fullPage magasság-plafon, minőség-lépcső a méretplafonhoz', { skip }, async () => {
  const r = await run({ url: `${fx.base}/long`, formats: ['screenshot'], screenshot: { fullPage: true } });
  assert.equal(r.ok, true, r.error);
  assert.match(r.screenshot, /^data:image\/jpeg;base64,/);
  assert.ok(r.screenshot.length <= 1500000 + 30);
  assert.ok(r.warnings.some(w => w.startsWith('screenshot_height_capped')), JSON.stringify(r.warnings));

  const mgr = c._pages();
  const saved = mgr.limits.screenshotMaxB64;
  mgr.limits.screenshotMaxB64 = 60000;
  try {
    const r2 = await run({ url: `${fx.base}/noise`, actions: [{ type: 'screenshot', quality: 95, viewport: { width: 1600, height: 1200 } }] });
    const shot = r2.action_results[0];
    assert.equal(shot.ok, true, shot.error);
    assert.ok(shot.screenshot.length <= 60000 + 30, `méret ${shot.screenshot.length}`);
    assert.ok(r2.warnings.some(w => /screenshot_(quality_reduced|downscaled)/.test(w)), JSON.stringify(r2.warnings));
  } finally {
    mgr.limits.screenshotMaxB64 = saved;
  }
});

test('generatePDF (és a Firecrawl-féle "pdf" alias)', { skip }, async () => {
  const r = await run({ url: `${fx.base}/page2`, actions: [{ type: 'generatePDF', format: 'A4' }, { type: 'pdf', landscape: true }] });
  assert.equal(r.ok, true, r.error);
  for (const a of r.action_results) {
    assert.match(a.pdf, /^data:application\/pdf;base64,/);
    assert.equal(Buffer.from(a.pdf.split(',')[1], 'base64').subarray(0, 4).toString(), '%PDF');
  }
});

test('executeJavascript: kifejezés, return-forma — és SOSEM Node-oldalon', { skip }, async () => {
  const r = await run({
    url: `${fx.base}/page2`,
    actions: [
      { type: 'executeJavascript', script: '1 + 2' },
      { type: 'executeJavascript', script: 'return { t: document.title, n: [1, 2] }' },
    ],
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.action_results[0].js_result, 3);
  assert.equal(r.action_results[0].js_type, 'number');
  assert.deepEqual(r.action_results[1].js_result, { t: 'Second', n: [1, 2] });
  // Node-oldali objektumok nem érhetők el: a lapban a process/require nem létezik.
  const r2 = await run({ url: `${fx.base}/page2`, actions: [{ type: 'executeJavascript', script: 'return typeof process + "/" + typeof require' }] });
  assert.equal(r2.action_results[0].js_result, 'undefined/undefined');
  const r3 = await run({ url: `${fx.base}/page2`, actions: [{ type: 'executeJavascript', script: 'process.exit(1)' }] });
  assert.equal(r3.action_results[0].ok, false);
  assert.match(r3.action_results[0].error, /process is not defined/);
});

test('mobile, headers, locale, timezone', { skip }, async () => {
  const r = await run({
    url: `${fx.base}/responsive`, mobile: true, locale: 'hu-HU', timezone: 'Europe/Budapest',
    actions: [{ type: 'executeJavascript', script: 'return [navigator.userAgent, innerWidth, navigator.language, Intl.DateTimeFormat().resolvedOptions().timeZone, matchMedia("(pointer:coarse)").matches, devicePixelRatio]' }],
  });
  assert.equal(r.ok, true, r.error);
  // (Viewport-meta nélküli lapon a mobil layout-szélesség 980 px — ezért /responsive.)
  const [ua, w, lang, tz, coarse, dpr] = r.action_results[0].js_result;
  assert.match(ua, /Mobile/);
  assert.equal(w, 412);
  assert.equal(coarse, true);
  assert.equal(dpr, 2.625);
  assert.equal(lang, 'hu-HU');
  assert.equal(tz, 'Europe/Budapest');

  const h = await run({ url: `${fx.base}/echo-headers`, formats: ['text'], locale: 'hu-HU', headers: { 'X-Test': 'yes', Host: 'evil.test', 'Proxy-Authorization': 'x' } });
  const echoed = JSON.parse(h.text);
  assert.equal(echoed['x-test'], 'yes');
  assert.match(echoed['accept-language'], /^hu-HU/);
  assert.notEqual(echoed.host, 'evil.test');
  assert.ok(h.warnings.some(w => /header_dropped: Host/.test(w)));
  assert.ok(h.warnings.some(w => /header_dropped: Proxy-Authorization/.test(w)));
});

test('munkamenet: állapot megmarad, close lezár, 128 bites id, nem tart slotot', { skip }, async () => {
  const a = await run({ url: `${fx.base}/page2`, keep_session: true, actions: [{ type: 'executeJavascript', script: 'window.__x = 42' }] });
  assert.equal(a.ok, true, a.error);
  assert.match(a.session_id, /^[0-9a-f]{32}$/);
  assert.equal(c._scrapeGate.active, 0, 'hívások között nincs concurrency-slot');
  const b = await run({ session_id: a.session_id, actions: [{ type: 'executeJavascript', script: 'window.__x' }] });
  assert.equal(b.action_results[0].js_result, 42);
  assert.equal(b.session_id, a.session_id);
  const cl = await run({ session_id: a.session_id, close: true });
  assert.equal(cl.session_id, null);
  const gone = await run({ session_id: a.session_id });
  assert.equal(gone.ok, false);
  assert.match(gone.error, /session_lost:closed_by_caller/);
  const nf = await run({ session_id: 'f'.repeat(32) });
  assert.equal(nf.error, 'session_not_found');
});

test('munkamenet-izoláció: másik munkamenet nem látja a sütit', { skip }, async () => {
  const a = await run({ url: `${fx.base}/setstate`, keep_session: true });
  const b = await run({ url: `${fx.base}/readstate`, formats: ['text'] });
  assert.equal(b.text.trim(), 'none|none');
  await run({ session_id: a.session_id, close: true });
});

test('max munkamenet (BRAVE_PAGE_MAX_SESSIONS=4) és tétlen TTL', { skip }, async () => {
  const ids = [];
  for (let i = 0; i < 4; i++) {
    const r = await run({ url: `${fx.base}/page2`, keep_session: true });
    assert.equal(r.ok, true, r.error);
    ids.push(r.session_id);
  }
  const over = await run({ url: `${fx.base}/page2`, keep_session: true });
  assert.equal(over.ok, false);
  assert.match(over.error, /too_many_sessions/);
  const oneShot = await run({ url: `${fx.base}/page2` });
  assert.equal(oneShot.ok, true, 'a one-shot hívás a limitnél is megy');

  const mgr = c._pages();
  const saved = mgr.limits.idleTtlMs;
  mgr.limits.idleTtlMs = 200;
  try {
    await new Promise(r => setTimeout(r, 400));
    await mgr._sweep();
  } finally {
    mgr.limits.idleTtlMs = saved;
  }
  assert.equal(mgr.size(), 0);
  const r = await run({ session_id: ids[0] });
  assert.match(r.error, /session_lost:idle_ttl_expired/);
});

test('profil: sütik + localStorage visszatöltése; save_changes:false nem ír; LRU', { skip }, async () => {
  const p1 = await run({ url: `${fx.base}/setstate`, profile: { name: 'owner1:p' } });
  assert.equal(p1.ok, true, p1.error);
  const p2 = await run({ url: `${fx.base}/readstate`, formats: ['text'], profile: { name: 'owner1:p' } });
  assert.equal(p2.text.trim(), 'pc=cookie-ok|ls-ok');
  // Másik névtér ugyanazzal a "p" névvel: üres.
  const other = await run({ url: `${fx.base}/readstate`, formats: ['text'], profile: { name: 'owner2:p' } });
  assert.equal(other.text.trim(), 'none|none');

  // save_changes:false → a módosítás nem íródik vissza.
  await run({ url: `${fx.base}/readstate`, profile: { name: 'owner1:ro', save_changes: false }, actions: [{ type: 'executeJavascript', script: 'localStorage.setItem("lk","ro")' }] });
  const ro = await run({ url: `${fx.base}/readstate`, formats: ['text'], profile: { name: 'owner1:ro', save_changes: false } });
  assert.equal(ro.text.trim(), 'none|none');

  // Egyszerre csak EGY mentő munkamenet: a második csak olvas (warninggal).
  const holder = await run({ url: `${fx.base}/page2`, keep_session: true, profile: { name: 'owner1:lock' } });
  const second = await run({ url: `${fx.base}/page2`, profile: { name: 'owner1:lock' } });
  assert.ok(second.warnings.some(w => w.startsWith('profile_locked')));
  await run({ session_id: holder.session_id, close: true });

  const mgr = c._pages();
  const saved = mgr.profiles.max;
  mgr.profiles.max = 2;
  try {
    for (const n of ['lru:a', 'lru:b', 'lru:c']) {
      await run({ url: `${fx.base}/setstate`, profile: { name: n } });
      await new Promise(r => setTimeout(r, 20));
    }
    const files = fs.readdirSync(profileDir).filter(f => f.endsWith('.json'));
    assert.equal(files.length, 2, `LRU: ${files.length} fájl`);
    const again = await run({ url: `${fx.base}/readstate`, formats: ['text'], profile: { name: 'lru:c' } });
    assert.equal(again.text.trim(), 'pc=cookie-ok|ls-ok');
  } finally {
    mgr.profiles.max = saved;
  }
});

test('egress teszt-módban is: belső háló tiltva (fő URL, redirect, al-erőforrás, navigate, lapon belüli fetch)', { skip }, async () => {
  const r1 = await run({ url: 'http://10.0.0.1/' });
  assert.equal(r1.ok, false);
  assert.match(r1.blocked.reason, /blocked_ip:10\.0\.0\.1/);

  const r2 = await run({ url: `${fx.base}/redirect-internal`, formats: ['html'] });
  assert.equal(r2.ok, false);
  assert.match(r2.blocked?.reason || '', /blocked_ip:10\.0\.0\.1/, JSON.stringify(r2));
  assert.equal(r2.html, null);

  const r3 = await run({ url: `${fx.base}/sub-internal` });
  assert.equal(r3.ok, true, r3.error);
  assert.ok(r3.warnings.some(w => /egress_blocked_subresources: 10\.0\.0\.2/.test(w)), JSON.stringify(r3.warnings));

  const r4 = await run({ url: `${fx.base}/page2`, actions: [{ type: 'navigate', url: 'http://169.254.169.254/latest/meta-data/' }] });
  assert.equal(r4.ok, false);
  assert.match(r4.blocked.reason, /169\.254\.169\.254/);

  const r5 = await run({ url: `${fx.base}/page2`, actions: [{ type: 'executeJavascript', script: 'return fetch("http://192.168.1.1/").then(r => r.status + ":" + r.headers.get("x-brave-egress-blocked"), e => "ERR")' }] });
  assert.match(String(r5.action_results[0].js_result), /^403:blocked_ip:192\.168\.1\.1$/);
});

test('séma-őr: file:/data:/chrome:/javascript: tiltva — URL-ként, navigate-ként és lapon belül', { skip }, async () => {
  for (const u of ['file:///etc/hostname', 'data:text/html,hi', 'chrome://version', 'javascript:alert(1)', 'view-source:http://example.com']) {
    const r = await run({ url: u });
    assert.equal(r.ok, false, u);
    assert.match(r.blocked.reason, /scheme_not_allowed/, u);
  }
  const n = await run({ url: `${fx.base}/page2`, actions: [{ type: 'navigate', url: 'file:///etc/hostname' }] });
  assert.equal(n.ok, false);
  assert.match(n.blocked.reason, /scheme_not_allowed:file/);
  const host = fs.readFileSync('/etc/hostname', 'utf8').trim();
  const inPage = await run({ url: `${fx.base}/tofile`, formats: ['html', 'text'], actions: [{ type: 'wait', milliseconds: 500 }] });
  const leaked = `${inPage.html || ''}${inPage.text || ''}`;
  if (host.length >= 3) assert.ok(!leaked.includes(host), 'a lapon belüli file:// navigáció nem szivárogtat');
  assert.ok(!/^file:/.test(inPage.final_url || ''), inPage.final_url);
});

test('block_ads, felugró ablak, alert, letöltés tiltva', { skip }, async () => {
  const ads = await run({ url: `${fx.base}/ads`, actions: [{ type: 'executeJavascript', script: 'window.__ad' }] });
  assert.equal(ads.action_results[0].js_result, 'blocked');
  assert.ok(ads.warnings.some(w => /block_ads: 1 request/.test(w)), JSON.stringify(ads.warnings));

  const pop = await run({ url: `${fx.base}/popup`, actions: [{ type: 'click', selector: '#p' }, { type: 'wait', milliseconds: 500 }] });
  assert.ok(pop.warnings.some(w => w.startsWith('popup_closed')), JSON.stringify(pop.warnings));
  assert.equal(pop.final_url, `${fx.base}/popup`);

  const al = await run({ url: `${fx.base}/alert` });
  assert.equal(al.title, 'after-alert');
  assert.ok(al.warnings.some(w => w.startsWith('dialog_dismissed')));

  await run({ url: `${fx.base}/dl-link`, actions: [{ type: 'click', selector: '#d' }, { type: 'wait', milliseconds: 800 }] });
  await run({ url: `${fx.base}/download` });
  const candidates = [path.join(os.homedir(), 'Downloads', DL_NAME), path.join(process.cwd(), DL_NAME), path.join(os.tmpdir(), DL_NAME)];
  for (const f of candidates) assert.equal(fs.existsSync(f), false, `letöltés történt: ${f}`);
});

test('határidő: timeout_ms betartva, részleges eredmény warninggal', { skip }, async () => {
  const t0 = Date.now();
  const r = await run({ url: `${fx.base}/page2`, timeout_ms: 2500, actions: [{ type: 'wait', milliseconds: 8000 }, { type: 'scrape' }] });
  const dt = Date.now() - t0;
  assert.ok(dt < 4000, `túl lassú: ${dt}ms`);
  assert.ok(r.warnings.some(w => w.startsWith('wait_truncated')), JSON.stringify(r.warnings));
});

test('concurrency: a ScrapeGate-limitet tiszteli (foglalt sáv → busy, nem örök várakozás)', { skip }, async () => {
  const savedMax = c._scrapeGate.max;
  c._scrapeGate.max = 1;
  try {
    const long = run({ url: `${fx.base}/page2`, actions: [{ type: 'wait', milliseconds: 3500 }] });
    await new Promise(r => setTimeout(r, 300));
    const t0 = Date.now();
    const blocked = await run({ url: `${fx.base}/page2`, timeout_ms: 2000 });
    assert.equal(blocked.ok, false);
    assert.match(blocked.error, /^busy/);
    assert.ok(Date.now() - t0 < 3000);
    const first = await long;
    assert.equal(first.ok, true, first.error);
    assert.equal(c._scrapeGate.active, 0);
  } finally {
    c._scrapeGate.max = savedMax;
  }
});

test('meglévő scrape-sáv: belső cél egress_blocked, file:// tiltva, helyi fixture (teszt-mód) megy', { skip }, async () => {
  const b = await c.scrape('http://10.0.0.1/');
  assert.equal(b.error, 'egress_blocked');
  assert.equal(b.content_usable, false);
  assert.equal(b.block_reason, 'egress_blocked');
  const f = await c.scrape('file:///etc/hostname');
  assert.equal(f.error, 'egress_blocked');
  assert.match(f.blocked.reason, /scheme_not_allowed:file/);
  const redir = await c.scrape(`${fx.base}/redirect-internal`);
  assert.equal(redir.error, 'egress_blocked');
  const ok = await c.scrape(`${fx.base}/page2`, { waitUntil: 'domcontentloaded' });
  // (A rövid, szóköz nélküli címet a meglévő _decorateContentFlags üríti — régi viselkedés.)
  assert.equal(ok.metadata.title, 'Second');
  assert.match(ok.text, /Second page/);
  await assert.rejects(c.navigate('file:///etc/hostname', { waitTime: 0 }), /egress_blocked/);
});
