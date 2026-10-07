// CAPTCHA-megoldó belépési pont (W2, 2026-10-07): szolgáltató-független
// felület, regisztráció, sorrend, a `purpose === 'read'` HATÁR, kulcs nélküli
// inaktivitás, és hogy a kulcs SEHOL nem jelenik meg (health, eredmény,
// hibaszöveg, napló). A fizetős adapter a helyi álszolgáltatón (createTask /
// getTaskResult) — élő szolgáltatót nem hívunk.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixture } from './helpers.js';
import {
  solveCaptcha, registerProvider, unregisterProvider, captchaSolverHealth, providerOrder, providerKey, KINDS, redactKeys,
} from '../src/captcha/provider.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'TEST-KEY-9f8e7d6c5b4a';

test('felület: kind-ok, sorrend env-ből, kulcs-feloldás', () => {
  assert.deepEqual([...KINDS], ['text', 'math', 'image_grid', 'audio', 'turnstile']);
  assert.deepEqual(providerOrder({ CAPTCHA_SOLVER_PROVIDER: ' Echolot , capsolver,capsolver,none,../x' }), ['echolot', 'capsolver']);
  assert.deepEqual(providerOrder({}), []);
  assert.equal(providerKey('capsolver', { CAPTCHA_SOLVER_KEY: 'a', CAPTCHA_SOLVER_KEY_CAPSOLVER: 'b' }), 'b');
  assert.equal(providerKey('2captcha', { CAPTCHA_SOLVER_KEY: 'a' }), 'a');
  assert.equal(redactKeys(`x ${KEY} y`, { CAPTCHA_SOLVER_KEY: KEY }), 'x *** y');
});

test('⛔ HATÁR: csak purpose="read" mellett fut szolgáltató — minden más purpose-nál egyik sem hívódik', async () => {
  let calls = 0;
  const off = registerProvider('fakeread', { kinds: ['text'], solve: async () => { calls++; return { ok: true, answer: '42' }; } });
  try {
    const env = { CAPTCHA_SOLVER_PROVIDER: 'fakeread' };
    for (const purpose of [undefined, '', 'interact', 'page', 'goal', 'form', 'READ', 'read ']) {
      const r = await solveCaptcha({ kind: 'text', meta: {}, purpose, env });
      assert.equal(r.ok, false);
      assert.equal(r.error, 'purpose_not_allowed', String(purpose));
    }
    assert.equal(calls, 0);
    const ok = await solveCaptcha({ kind: 'text', meta: {}, purpose: 'read', env });
    assert.deepEqual([ok.ok, ok.answer, ok.provider, calls], [true, '42', 'fakeread', 1]);
  } finally { off(); }
});

// 2026-10-08 (rel-wall, koordinátori döntés): a C2 szabálya él — a saját megoldó
// az EGYSZERI `purpose:"read"` brave_page-hívásban futhat (az engine fetch
// Chrome-foka), munkamenetben SOHA. A W2 challenge-kezelője és szolgáltató-lánca
// a brave_page-ből továbbra sem érhető el.
test('⛔ HATÁR (szerkezeti): a brave_page a W2 challenge-kezelőt nem éri el; a C2 megoldót CSAK az egyszeri read-ágban, munkamenet-őr mögött', () => {
  const page = fs.readFileSync(path.join(ROOT, 'src', 'brave-page.js'), 'utf8');
  assert.ok(!/challenge\.js/.test(page) && !/solveCaptcha/.test(page) && !/captcha\/provider/.test(page));
  const imports = (page.match(/from '\.\/captcha\/[^']+'/g) || []).sort();
  assert.deepEqual(imports, ["from './captcha/pointer.js'", "from './captcha/read-path.js'"]);
  // pontosan EGY megoldó-hívás, a `purpose === 'read'` ágban, a `sid || keep` őr UTÁN
  assert.equal((page.match(/solveOnReadPath\(/g) || []).length, 1);
  const at = page.indexOf('solveOnReadPath(page');
  const branch = page.indexOf("if (args.purpose === 'read') {");
  assert.ok(branch > 0 && branch < at);
  assert.match(page.slice(branch, at), /if \(sid \|\| keep\) \{\s*warn\('captcha_solver_skipped: session path/);
  assert.match(page.slice(at, at + 80), /purpose: 'read'/);
  // a scrape-út a challenge-kezelőt és a megoldót MINDIG purpose:'read'-del hívja
  const ctl = fs.readFileSync(path.join(ROOT, 'src', 'brave-controller.js'), 'utf8');
  const calls = ctl.match(/handleChallenge\(page[\s\S]{0,600}?\}\);/g) || [];
  assert.ok(calls.length >= 1);
  for (const c of calls) assert.match(c, /purpose: 'read'/);
  const solves = ctl.match(/solveOnReadPath\(page[^)]*\)/g) || [];
  assert.ok(solves.length >= 1);
  for (const c of solves) assert.match(c, /purpose: 'read'/);
  assert.ok(!/solveCaptcha/.test(ctl));
});

test('sorrend + tartalék: az első hibázó után a második nyer; ismeretlen név kimarad; kind-szűrés', async () => {
  const seen = [];
  const offA = registerProvider('fakea', { kinds: ['image_grid'], solve: async () => { seen.push('a'); return { ok: false, error: 'nope' }; } });
  const offB = registerProvider('fakeb', { solve: async (req) => { seen.push('b'); return { ok: true, actions: [{ type: 'click', x: 1, y: 2 }], cost_usd: 0 }; } });
  const offC = registerProvider('fakec', { kinds: ['turnstile'], solve: async () => { seen.push('c'); return { ok: true, answer: 't' }; } });
  try {
    const env = { CAPTCHA_SOLVER_PROVIDER: 'nincsilyen,fakec,fakea,fakeb' };
    const r = await solveCaptcha({ kind: 'image_grid', purpose: 'read', env });
    assert.equal(r.ok, true);
    assert.equal(r.provider, 'fakeb');
    assert.deepEqual(r.actions, [{ type: 'click', x: 1, y: 2 }]);
    assert.deepEqual(seen, ['a', 'b']);
    assert.deepEqual(r.tried.map(x => [x.provider, x.skipped || (x.ok ? 'ok' : x.error)]),
      [['nincsilyen', 'not_found'], ['fakec', 'kind_unsupported'], ['fakea', 'nope'], ['fakeb', 'ok']]);
    // a kivétel sem dönti be a láncot
    const offD = registerProvider('faked', { solve: async () => { throw new Error(`boom ${KEY}`); } });
    const r2 = await solveCaptcha({ kind: 'math', purpose: 'read', env: { CAPTCHA_SOLVER_PROVIDER: 'faked,fakeb', CAPTCHA_SOLVER_KEY: KEY } });
    assert.equal(r2.provider, 'fakeb');
    assert.ok(!JSON.stringify(r2).includes(KEY));
    assert.match(r2.tried[0].error, /boom \*\*\*/);
    offD();
    assert.equal((await solveCaptcha({ kind: 'nincs', purpose: 'read', env })).error, 'unknown_kind');
    assert.equal((await solveCaptcha({ kind: 'text', purpose: 'read', env: {} })).error, 'no_provider_configured');
  } finally { offA(); offB(); offC(); unregisterProvider('faked'); }
});

test('health: kulcs nélkül inaktív és kimondja; kulccsal aktív — a kulcs sosem látszik', () => {
  const none = captchaSolverHealth({});
  assert.equal(none.active, false);
  assert.equal(none.purpose_gate, 'read');
  assert.match(none.reason, /CAPTCHA_SOLVER_PROVIDER/);
  const noKey = captchaSolverHealth({ CAPTCHA_SOLVER_PROVIDER: 'capsolver,2captcha' });
  assert.equal(noKey.active, false);
  assert.deepEqual(noKey.providers.map(p => [p.name, p.registered, p.active, p.reason]),
    [['capsolver', true, false, 'no_key'], ['2captcha', true, false, 'no_key']]);
  const withKey = captchaSolverHealth({ CAPTCHA_SOLVER_PROVIDER: 'capsolver', CAPTCHA_SOLVER_KEY: KEY });
  assert.equal(withKey.active, true);
  assert.ok(!JSON.stringify(withKey).includes(KEY));
  const ext = captchaSolverHealth({ CAPTCHA_SOLVER_PROVIDER: 'echolot' });
  assert.equal(ext.providers[0].name, 'echolot');
  assert.equal(ext.active, false);
});

test('fizetős adapter (álszolgáltatón): createTask → getTaskResult → token; a kulcs csak a törzsben megy', async () => {
  const bodies = [];
  let polls = 0;
  const fx = await startFixture({
    '/createTask': (req, res) => {
      let b = ''; req.on('data', d => { b += d; }); req.on('end', () => {
        bodies.push({ url: req.url, body: JSON.parse(b) });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ errorId: 0, taskId: 'T1' }));
      });
    },
    '/getTaskResult': (req, res) => {
      let b = ''; req.on('data', d => { b += d; }); req.on('end', () => {
        bodies.push({ url: req.url, body: JSON.parse(b) });
        polls++;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(polls < 2 ? { errorId: 0, status: 'processing' } : { errorId: 0, status: 'ready', solution: { token: 'TOKEN-OK' }, cost: '0.0012' }));
      });
    },
  });
  const logs = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...a) => { logs.push(a.join(' ')); };
  try {
    const env = { CAPTCHA_SOLVER_PROVIDER: 'capsolver', CAPTCHA_SOLVER_KEY: KEY, CAPTCHA_SOLVER_BASE_URL: fx.base, CAPTCHA_SOLVER_POLL_MS: '50' };
    const r = await solveCaptcha({ kind: 'turnstile', purpose: 'read', env, meta: { sitekey: '0x4AAAAAAAFixture', url: 'https://example.com/' } });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.answer, 'TOKEN-OK');
    assert.equal(r.cost_usd, 0.0012);
    assert.equal(bodies[0].body.task.type, 'AntiTurnstileTaskProxyLess');
    assert.equal(bodies[0].body.task.websiteKey, '0x4AAAAAAAFixture');
    assert.equal(bodies[0].body.clientKey, KEY);
    assert.ok(bodies.every(b => !b.url.includes(KEY)));
    assert.ok(!JSON.stringify(r).includes(KEY));
    // sitekey nélkül a fizetős adapter nem hív ki
    const n = bodies.length;
    const miss = await solveCaptcha({ kind: 'turnstile', purpose: 'read', env, meta: { url: 'https://example.com/' } });
    assert.equal(miss.ok, false);
    assert.equal(bodies.length, n);
    // kulcs nélkül egyáltalán nem fut
    const nokey = await solveCaptcha({ kind: 'turnstile', purpose: 'read', env: { ...env, CAPTCHA_SOLVER_KEY: '' }, meta: { sitekey: '0x4', url: 'https://e.com/' } });
    assert.equal(nokey.ok, false);
    assert.equal(nokey.tried[0].skipped, 'no_key');
    assert.equal(bodies.length, n);
  } finally {
    Object.assign(console, orig);
    await fx.close();
  }
  assert.ok(!logs.join('\n').includes(KEY));
});
