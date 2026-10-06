// brave_crawl időkeret + részeredmény (2026-10-06).
//
// Gyökérok (mérve): a crawl időkeret nélkül, szekvenciálisan járt be, a
// 25 s-os tool-határidő a TELJES eredményt eldobta (504, nulla oldal), a crawl
// pedig a háttérben árván futott tovább. Ezek a tesztek azt rögzítik, hogy
//   * a crawl a kereten belül RÉSZEREDMÉNNYEL tér vissza (truncated=true),
//   * egy lógó oldal csak a saját oldal-határidejéig tart, a crawl megy tovább,
//   * a lapok mindig záródnak, a kapu-permit visszakerül, a breaker nem nyílik,
//   * HTTP-n át a lassú site sem ad többé 504-et.
// 1. rész: böngésző nélkül (a scrape() csonkolva). 2–3. rész: valódi böngésző
// + 127.0.0.1-es fixture (teszt-kivétellel), böngésző nélkül kimarad.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser, startFixture } from './helpers.js';
import { toolTimeoutMs, crawlBudgetMs } from '../src/tool-timeout.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browserPath = findBrowser();
Object.assign(process.env, {
  NODE_ENV: 'test',
  BRAVE_EGRESS_ALLOW_TEST_LOOPBACK: '1',
  HEADLESS: 'true',
  BRAVE_WATCHDOG_DISABLED: 'true',
});
for (const k of Object.keys(process.env)) if (k.startsWith('RAILWAY_')) delete process.env[k];
if (browserPath) process.env.BRAVE_PATH = browserPath;

const { BraveController } = await import('../src/brave-controller.js');
const { tools } = await import('../src/tools.js');
const crawlTool = tools.find(t => t.name === 'brave_crawl');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── 1. Tiszta részek ────────────────────────────────────────────────

test('tool-timeout: brave_crawl plafon + időkeret', () => {
  assert.equal(toolTimeoutMs('brave_crawl', {}, {}), 25000);
  assert.equal(toolTimeoutMs('brave_crawl', {}, { TOOL_CALL_TIMEOUT_MS: '30000' }), 30000);
  assert.equal(toolTimeoutMs('brave_crawl', {}, { TOOL_TIMEOUT_CRAWL_MS: '60000' }), 60000);
  // A keret a plafon alatt marad (tartalék a válasz összeállítására).
  assert.equal(crawlBudgetMs({}, {}), 21000);
  assert.equal(crawlBudgetMs({}, { TOOL_TIMEOUT_CRAWL_MS: '60000' }), 56000);
  assert.equal(crawlBudgetMs({}, { TOOL_CRAWL_MARGIN_MS: '2000' }), 23000);
  assert.equal(crawlBudgetMs({}, { TOOL_CALL_TIMEOUT_MS: '4000' }), 3000);   // alsó korlát
  for (const env of [{}, { TOOL_TIMEOUT_CRAWL_MS: '8000' }, { TOOL_CALL_TIMEOUT_MS: '60000' }]) {
    assert.ok(crawlBudgetMs({}, env) < toolTimeoutMs('brave_crawl', {}, env));
  }
});

test('URL-normalizálás, host-kulcs, markdown-linkek', () => {
  const n = BraveController._crawlNormalizeUrl;
  assert.equal(n('https://x.io/a#frag'), 'https://x.io/a');
  assert.equal(n('/b?q=1#z', 'https://x.io/a'), 'https://x.io/b?q=1');
  assert.equal(n('mailto:a@b.c'), null);
  assert.equal(n('javascript:void(0)'), null);
  assert.equal(n('http://[bad'), null);
  assert.equal(BraveController._crawlHostKey('WWW.TinyFish.ai'), 'tinyfish.ai');
  const links = BraveController._markdownLinks('[A](/a) [B](https://y.io/b "t") [C](mailto:x@y)', 'https://x.io/doc.md');
  assert.deepEqual(links.map(l => l.href), ['https://x.io/a', 'https://y.io/b']);
  assert.ok(BraveController.CRAWL_SKIP_EXT.test('/files/report.PDF'));
  assert.ok(!BraveController.CRAWL_SKIP_EXT.test('/skill.md'));
});

test('_textBodyOf: csak nem-HTML szöveges típusra ad nyers törzset', async () => {
  const resp = (ct, body = 'BODY') => ({ headers: () => ({ 'content-type': ct }), text: async () => body });
  assert.deepEqual(await BraveController._textBodyOf(resp('text/markdown; charset=utf-8')), { contentType: 'text/markdown', body: 'BODY' });
  assert.deepEqual(await BraveController._textBodyOf(resp('application/json')), { contentType: 'application/json', body: 'BODY' });
  assert.deepEqual(await BraveController._textBodyOf(resp('application/rss+xml')), { contentType: 'application/rss+xml', body: 'BODY' });
  assert.equal(await BraveController._textBodyOf(resp('text/html; charset=utf-8')), null);
  assert.equal(await BraveController._textBodyOf(resp('image/png')), null);
  assert.equal(await BraveController._textBodyOf(resp('')), null);
  assert.equal(await BraveController._textBodyOf(null), null);
  assert.equal(await BraveController._textBodyOf({ headers: () => ({ 'content-type': 'text/plain' }), text: async () => { throw new Error('x'); } }), null);
});

test('tools.js: a brave_crawl a hívás-határidőből számolt keretet adja át', async () => {
  let got;
  const fake = { crawl: async (u, o) => { got = { u, o }; return { ok: true }; } };
  await crawlTool.execute(fake, { startUrl: 'https://x.io/', maxPages: 3 });
  assert.equal(got.u, 'https://x.io/');
  assert.equal(got.o.maxPages, 3);
  assert.equal(got.o.budgetMs, crawlBudgetMs({ startUrl: 'https://x.io/', maxPages: 3 }));
});

// Böngésző nélküli controller, csonkolt scrape()-pel: egy kis „site" gráf.
function stubController(site, { delayMs = 0, hang = new Set(), honorDeadline = true } = {}) {
  const c = new BraveController();
  c.calls = [];
  c.scrape = async (url, opts) => {
    c.calls.push({ url, opts });
    const u = new URL(url);
    if (hang.has(u.pathname)) {
      if (!honorDeadline) return new Promise(() => {});   // lapnyitás előtt akad el
      await sleep(Math.max(0, opts.deadlineTs - Date.now()));
      throw BraveController._pageDeadlineError('page');
    }
    if (delayMs) await sleep(delayMs);
    const page = site[u.pathname];
    if (!page) throw new Error('net::ERR_HTTP_RESPONSE_CODE_FAILURE');
    const final = page.redirect ? new URL(page.redirect) : u;
    return {
      url: final.href,
      title: u.pathname,
      markdown: `# ${u.pathname}`,
      links: (page.links || []).map(h => ({ href: new URL(h, final).href, text: h })),
    };
  };
  return c;
}

test('stub: az időkeret RÉSZEREDMÉNNYEL tér vissza (truncated), nem dob', async () => {
  const site = {};
  for (let i = 0; i < 50; i++) site[`/p${i}`] = { links: [`/p${i + 1}`, `/p${i + 2}`] };
  site['/'] = { links: ['/p0'] };
  const c = stubController(site, { delayMs: 300 });
  const t0 = Date.now();
  const r = await c.crawl('https://s.test/', { maxPages: 50, budgetMs: 2000 });
  const t = Date.now() - t0;
  assert.equal(r.truncated, true);
  assert.equal(r.stop_reason, 'time_budget');
  assert.ok(r.crawledPages >= 3 && r.crawledPages <= 7, `pages=${r.crawledPages}`);
  assert.equal(r.results.length, r.crawledPages);
  assert.ok(r.pending_urls > 0);
  assert.ok(t <= 2000 + 400, `t=${t}`);
  // Alapból a linklista nem kerül a válaszba, csak a darabszám.
  assert.equal(r.results[0].links, undefined);
  assert.equal(typeof r.results[0].links_found, 'number');
});

test('stub: lógó oldal → page_timeout, a crawl megy tovább (mindkét védvonal)', async () => {
  const site = { '/': { links: ['/hang', '/a', '/b'] }, '/a': {}, '/b': {} };
  for (const honorDeadline of [true, false]) {
    const c = stubController(site, { hang: new Set(['/hang']), honorDeadline });
    const t0 = Date.now();
    const r = await c.crawl('https://s.test/', { maxPages: 10, budgetMs: 10000, pageTimeoutMs: 1000 });
    const t = Date.now() - t0;
    assert.deepEqual(r.results.map(x => new URL(x.url).pathname), ['/', '/a', '/b'], `honor=${honorDeadline}`);
    assert.deepEqual(r.errors, [{ url: 'https://s.test/hang', error: 'page_timeout' }]);
    assert.equal(r.truncated, false);
    assert.equal(r.stop_reason, 'queue_exhausted');
    // Az oldal-határidő (1 s) + legfeljebb a kemény védőháló (1,5 s).
    assert.ok(t < (honorDeadline ? 1600 : 3100), `honor=${honorDeadline} t=${t}`);
    // Minden scrape-hívás oldal-határidőt kapott, a kereten belül.
    for (const call of c.calls) assert.ok(call.opts.deadlineTs > 0 && call.opts.deadlineTs <= t0 + 10000 + 50);
  }
});

test('stub: #fragment-dedup, átirányítás utáni host „saját", idegen domain kimarad', async () => {
  const site = {
    '/': { redirect: 'https://www.s2.test/', links: [] },
  };
  const c = stubController(site);
  // A start 301-gyel másik hostra visz; a linkek a végső hostra mutatnak.
  c.scrape = async (url, opts) => {
    c.calls.push({ url, opts });
    const u = new URL(url);
    if (u.hostname === 's.test') {
      return { url: 'https://www.s2.test/', links: [
        { href: 'https://www.s2.test/a#x' }, { href: 'https://www.s2.test/a' },
        { href: 'https://s2.test/b' }, { href: 'https://other.test/c' },
        { href: 'https://www.s2.test/file.pdf' }, { href: 'mailto:x@y.z' },
      ] };
    }
    return { url, links: [{ href: url + '#self' }, { href: 'https://www.s2.test/' }] };
  };
  const r = await c.crawl('https://s.test/', { maxPages: 10, budgetMs: 5000 });
  assert.deepEqual(c.calls.map(x => x.url), ['https://s.test/', 'https://www.s2.test/a', 'https://s2.test/b']);
  assert.equal(r.crawledPages, 3);
  assert.equal(r.stop_reason, 'queue_exhausted');
});

test('stub: brave_down → azonnali megállás; hibás regex → strukturált hiba', async () => {
  const c = stubController({});
  c.scrape = async () => ({ error: 'brave_down', retry_after: 42 });
  const r = await c.crawl('https://s.test/', { maxPages: 5, budgetMs: 5000 });
  assert.equal(r.stop_reason, 'brave_down');
  assert.equal(r.errors[0].retry_after, 42);
  const bad = await c.crawl('https://s.test/', { includePattern: '(' });
  assert.equal(bad.error, 'invalid_pattern');
  const badStart = await c.crawl('ftp://s.test/');
  assert.equal(badStart.error, 'invalid_start_url');
});

// ─── 2. Valódi böngésző + fixture ────────────────────────────────────

const skip = !browserPath && 'nincs böngésző (BRAVE_PATH)';
const hangingSockets = new Set();
const ROUTES = {
  '/': '<!doctype html><title>Home</title><a href="/hang">hang</a> <a href="/a#top">a</a> <a href="/a">a2</a> <a href="/doc.md">doc</a> <a href="/chain/0">chain</a>',
  '/a': '<!doctype html><title>A</title><p>page a</p>',
  // Végtelenül töltődő oldal: a fejléc + fél HTML megy, a válasz sosem zárul.
  '/hang': (req, res) => {
    hangingSockets.add(res);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.write('<!doctype html><title>Hang</title><p>loading');
  },
  '/doc.md': (req, res) => {
    res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8', 'x-content-type-options': 'nosniff' });
    res.end('# Doc\n\nSee [B](/b) for more.\n');
  },
  '/b': '<!doctype html><title>B</title><p>page b</p>',
};
// Lassú lánc: /chain/N 600 ms késleltetéssel, link a következőre.
function chainRoute(req, res, u) {
  const m = /^\/chain\/(\d+)$/.exec(u.pathname);
  if (!m) { res.writeHead(404); return res.end(); }
  const i = Number(m[1]);
  setTimeout(() => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html><title>C${i}</title><p>chain ${i}</p><a href="/chain/${i + 1}">next</a>`);
  }, 600);
}

let fx, c;
test.before(async () => {
  if (!browserPath) return;
  fx = await startFixture(new Proxy(ROUTES, {
    get: (t, p) => (typeof p === 'string' && p.startsWith('/chain/')) ? chainRoute : t[p],
  }));
  c = new BraveController();
  await c.initialize();
});
test.after(async () => {
  for (const res of hangingSockets) { try { res.destroy(); } catch (_) {} }
  if (c) await c.close();
  if (fx) await fx.close();
});

test('böngésző: lógó oldal page_timeout, .md szöveg-fallback, fragment-dedup, lapok zárva', { skip, timeout: 60000 }, async () => {
  const before = (await c.browser.pages()).length;
  const t0 = Date.now();
  const r = await c.crawl(`${fx.base}/`, { maxPages: 6, budgetMs: 15000, pageTimeoutMs: 2000, includePattern: '^(?!.*/chain/)' });
  const t = Date.now() - t0;
  const paths = r.results.map(x => new URL(x.url).pathname);
  assert.deepEqual(paths, ['/', '/a', '/doc.md', '/b'], JSON.stringify(r.errors));
  assert.deepEqual(r.errors.map(e => [new URL(e.url).pathname, e.error]), [['/hang', 'page_timeout']]);
  const md = r.results.find(x => x.url.endsWith('/doc.md'));
  assert.match(md.markdown, /See \[B\]\(\/b\)/);
  assert.equal(md.content_type, 'text/markdown');
  assert.ok(t < 15000, `t=${t}`);
  await sleep(300);
  assert.equal((await c.browser.pages()).length, before, 'minden crawl-lap zárva');
  assert.equal(c._scrapeGate.active, 0, 'a kapu-permitek visszakerültek');
  assert.equal(c._breaker.state, 'closed', 'a saját oldal-timeout nem nyitja a breakert');
});

test('böngésző: lassú lánc → a keret végén részeredmény, nincs árva munka', { skip, timeout: 60000 }, async () => {
  const before = (await c.browser.pages()).length;
  const okBefore = c._scrapeOkCount;
  const t0 = Date.now();
  const r = await c.crawl(`${fx.base}/chain/0`, { maxPages: 50, budgetMs: 4000, pageTimeoutMs: 3000 });
  const t = Date.now() - t0;
  assert.equal(r.truncated, true);
  assert.equal(r.stop_reason, 'time_budget');
  assert.ok(r.crawledPages >= 2, `pages=${r.crawledPages}`);
  assert.ok(t <= 4000 + 500, `t=${t}`);
  const okAtReturn = c._scrapeOkCount;
  await sleep(2500);
  assert.equal(c._scrapeOkCount, okAtReturn, 'visszatérés után nem fut tovább scrape');
  assert.equal(okAtReturn - okBefore, r.crawledPages);
  assert.equal((await c.browser.pages()).length, before);
  assert.equal(c._scrapeGate.active, 0);
});

// ─── 3. HTTP e2e: a lassú site sem ad többé 504-et ───────────────────

async function freePort() {
  const s = net.createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise(r => s.close(r));
  return p;
}

test('HTTP e2e: tools/call brave_crawl lassú site-on → 200 + truncated a határidőn belül (nem 504)', { skip, timeout: 90000 }, async () => {
  const port = await freePort();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'bmcp-crawl-'));
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('RAILWAY_') || k.startsWith('BRAVE_') || k.startsWith('TOOL_')) delete env[k];
  Object.assign(env, {
    PORT: String(port), HEADLESS: 'true', BRAVE_PATH: browserPath, BRAVE_WATCHDOG_DISABLED: 'true',
    NODE_ENV: 'test', BRAVE_EGRESS_ALLOW_TEST_LOOPBACK: '1',
    BRAVE_PAGE_PROFILE_DIR: path.join(cwd, 'profiles'),
    TOOL_CALL_TIMEOUT_MS: '8000',
  });
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'dual-server.js'), '--http-only'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  try {
    const t0 = Date.now();
    while (Date.now() - t0 < 30000) {
      try { if ((await fetch(`${base}/tools`)).ok) break; } catch (_) { /* még indul */ }
      await sleep(200);
    }
    const call = async () => {
      const ts = Date.now();
      const resp = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'brave_crawl', arguments: { startUrl: `${fx.base}/chain/0`, maxPages: 40 } } }),
      });
      return { status: resp.status, j: await resp.json(), ms: Date.now() - ts };
    };
    // Első hívás böngészőt is indít — a keret ezt is belefoglalja.
    for (let i = 0; i < 2; i++) {
      const { status, j, ms } = await call();
      assert.equal(status, 200, `${i}. hívás: ${JSON.stringify(j).slice(0, 300)}\n${log.slice(-1500)}`);
      const r = JSON.parse(j.result.content[0].text);
      assert.equal(r.truncated, true);
      assert.equal(r.stop_reason, 'time_budget');
      assert.ok(r.crawledPages >= 1, `pages=${r.crawledPages}`);
      assert.ok(ms < 8000, `ms=${ms}`);
    }
  } finally {
    child.kill('SIGTERM');
    await new Promise(r => { child.once('exit', r); setTimeout(r, 8000); });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
