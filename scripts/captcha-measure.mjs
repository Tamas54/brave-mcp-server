#!/usr/bin/env node
// C2 — CAPTCHA-vezénylés mérése nyilvános DEMO-lapokon (2026-10-07).
//
// Helyi brave-mcp (saját, szabad porton indított folyamat, a végén CSAK azt
// állítjuk le) + megoldó-végpont:
//   * CAPTCHA_ENGINE_URL megadva → a valódi (helyi) engine (C1/C3) — siker-arány;
//   * különben beépített HAMIS megoldó (véletlen csempék / pontok / szöveg) — ekkor
//     a mérés a VEZÉNYLÉST méri (felismerés, kattintás, kivágás, körök, idő), a
//     siker-arány értelemszerűen ~0.
// Futtatás:  node scripts/captcha-measure.mjs [--n 5] [--out <json>] [--only <scenario,…>] [--cwd-base <rövid dir>]
// A demo-lapok kifejezetten tesztelésre valók (Google reCAPTCHA v2 demo, hCaptcha demo).
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const N = Number(arg('n', 5));
const OUT = arg('out', path.join(process.env.HOME, 'recon/round3/captcha/c2_meres_raw.json'));
const TOKEN = crypto.randomBytes(24).toString('hex');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer(); s.unref();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

// ── hamis megoldó (nem ismeri a választ) ──
async function startFakeEngine() {
  const calls = [];
  const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const send = (code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { ok: false, error: 'unauthorized' });
      let j = {};
      try { j = JSON.parse(body); } catch (_) { return send(400, { ok: false, error: 'bad_json' }); }
      const rec = { t: Date.now(), kind: j.kind, purpose: j.purpose, op: j.op, host: (() => { try { return new URL(j.url).host; } catch (_) { return null; } })(),
        grid: j.grid || null, tiles: j.tiles_b64?.length || 0, image_kb: j.image_b64 ? Math.round(j.image_b64.length * 0.75 / 1024) : 0,
        audio_kb: (j.audio || j.audio_b64) ? Math.round((j.audio || j.audio_b64).length * 0.75 / 1024) : 0, mime: j.mime || null,
        instruction: typeof j.instruction === 'string' ? j.instruction.slice(0, 120) : null };
      calls.push(rec);
      const base = { ok: true, confidence: 0.05, model: 'fake-random', ms: 1, cost_usd: 0 };
      if (j.purpose !== 'read') return send(403, { ok: false, error: 'purpose_not_allowed' });
      if (j.kind === 'grid') {
        const n = j.tiles_b64 ? j.tiles_b64.length : (j.grid.rows * j.grid.cols);
        const tiles = Array.from({ length: n }, (_, i) => i).filter(() => Math.random() < 0.3);
        return send(200, { ...base, tiles });
      }
      if (j.kind === 'point') return send(200, { ...base, points: Array.from({ length: 2 + Math.floor(Math.random() * 2) }, () => ({ x: 0.15 + Math.random() * 0.7, y: 0.35 + Math.random() * 0.55 })) });
      if (j.kind === 'audio') return send(200, { success: true, ...base, answer: Array.from({ length: 4 }, () => words[Math.floor(Math.random() * 10)]).join(' ') });
      if (j.kind === 'text' || j.kind === 'math') return send(200, { ...base, answer: crypto.randomBytes(3).toString('hex') });
      return send(400, { ok: false, error: 'bad_request', detail: "kind must be one of ['text', 'math', 'grid']" });
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, calls, close: () => new Promise(r => { srv.closeAllConnections?.(); srv.close(() => r()); }) };
}

async function startBrave(env) {
  const port = await freePort();
  // ideiglenes cwd: ott nincs key.pem/cert.pem → sima HTTP (mint a http-e2e teszt)
  const cwd = fs.mkdtempSync(path.join(arg('cwd-base', '/tmp'), 'c2-meres-'));
  // a Chrome a TMPDIR-be teszi a profil-socketet — hosszú útvonalnál nem indul
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'dual-server.js'), '--http-only'], {
    cwd, env: { ...process.env, ...env, TMPDIR: '/tmp', PORT: String(port), BRAVE_PAGE_PROFILE_DIR: path.join(cwd, 'profiles') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  const keep = (b) => { for (const l of String(b).split('\n')) if (/\[captcha\]|❌|Error/.test(l)) log.push(l.slice(0, 300)); };
  child.stdout.on('data', keep); child.stderr.on('data', keep);
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${base}/health`); if (r.ok) break; } catch (_) {}
    await sleep(500);
  }
  return { base, child, log, pid: child.pid, cwd };
}

async function stopBrave(b) {
  if (!b?.child || b.child.exitCode !== null) return;
  b.child.kill('SIGTERM');
  for (let i = 0; i < 20 && b.child.exitCode === null; i++) await sleep(250);
  if (b.child.exitCode === null) b.child.kill('SIGKILL');
  try { fs.rmSync(b.cwd, { recursive: true, force: true }); } catch (_) {}
}

let rpcId = 0;
async function callTool(base, name, args) {
  const t0 = Date.now();
  let status = 0; let body = null;
  try {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
      signal: AbortSignal.timeout(60000),
    });
    status = r.status;
    body = await r.json().catch(() => null);
  } catch (e) { return { ms: Date.now() - t0, status: 0, rpcError: { message: `fetch:${String(e.cause?.code || e.message || e)}` } }; }
  let result = null;
  try { result = JSON.parse(body?.result?.content?.[0]?.text || 'null'); } catch (_) { result = null; }
  return { ms: Date.now() - t0, status, rpcError: body?.error || null, result };
}

const DEMOS = {
  recaptcha: 'https://www.google.com/recaptcha/api2/demo',
  hcaptcha: 'https://accounts.hcaptcha.com/demo',
};

function summarize(r, eng0, eng) {
  const res = r.result || {};
  const cap = res.captcha || null;
  const trace = cap?.trace || [];
  const text = String(res.markdown || res.text || res.html || '');
  return {
    ms: r.ms, http: r.status, rpc_error: r.rpcError?.message || null,
    captcha: cap ? { status: cap.status, vendor: cap.vendor, kind: cap.kind, reason: cap.reason || null, error: cap.error || null,
      rounds: cap.rounds ?? null, solver_calls: cap.solver_calls ?? null, solve_ms: cap.ms, submit: cap.submit || null, how: cap.how || null } : null,
    warnings: (res.warnings || []).filter(w => /captcha/.test(w)),
    passed_marker: /Verification Success|Hooray|Challenge Success/i.test(text),
    trace_summary: {
      challenge: trace.find(x => x.type === 'challenge')?.state || null,
      captures: trace.filter(x => x.type === 'capture').map(x => `${x.grid}${x.dynamic ? 'dyn' : ''}:${x.tiles}`),
      tile_clicks: trace.filter(x => /tile|point/.test(x.target || '')).length,
      verifies: trace.filter(x => /verify|submit/.test(x.target || '')).length,
      outcomes: trace.filter(x => x.type === 'outcome').map(x => x.outcome),
      dynamic_rechecks: trace.filter(x => x.type === 'dynamic_recheck').length,
      audio: trace.filter(x => x.type === 'audio_download').map(x => `${Math.round(x.bytes / 1024)}KB ${x.mime}`),
      failures: trace.filter(x => x.type === 'round_failed').map(x => x.error),
      first_solve_ms: trace.find(x => x.type === 'solve')?.t ?? null,
    },
    engine_calls: eng.calls.slice(eng0).map(c => ({ kind: c.kind, op: c.op, host: c.host, grid: c.grid, tiles: c.tiles, image_kb: c.image_kb, audio_kb: c.audio_kb, instruction: c.instruction })),
  };
}

async function main() {
  const real = !!process.env.CAPTCHA_ENGINE_URL;
  const eng = real ? { url: process.env.CAPTCHA_ENGINE_URL, calls: [], close: async () => {} } : await startFakeEngine();
  const out = { started: new Date().toISOString(), engine: real ? 'real' : 'fake-random', n: N, runs: [] };
  const baseEnv = {
    HEADLESS: 'true', BRAVE_WATCHDOG_DISABLED: 'true',
    CAPTCHA_SOLVER_ENABLED: '1', CAPTCHA_ENGINE_URL: eng.url, CAPTCHA_ENGINE_TOKEN: real ? (process.env.CAPTCHA_ENGINE_TOKEN || '') : TOKEN,
    CAPTCHA_TRACE: '1', CAPTCHA_MAX_SOLVES_PER_HOUR: '200',
    ...(process.env.BRAVE_PATH ? { BRAVE_PATH: process.env.BRAVE_PATH } : {}),
  };
  const scenarios = [
    { name: 'recaptcha_scrape_image_first', env: { CAPTCHA_RECAPTCHA_ORDER: 'image,audio' }, tool: 'brave_scrape', args: { url: DEMOS.recaptcha }, n: N },
    { name: 'recaptcha_scrape_audio_first', env: { CAPTCHA_RECAPTCHA_ORDER: 'audio,image' }, tool: 'brave_scrape', args: { url: DEMOS.recaptcha }, n: Math.max(2, Math.ceil(N / 2)) },
    { name: 'hcaptcha_scrape', env: {}, tool: 'brave_scrape', args: { url: DEMOS.hcaptcha }, n: N },
    { name: 'recaptcha_brave_page_read', env: {}, tool: 'brave_page', args: { url: DEMOS.recaptcha, purpose: 'read', formats: ['text'] }, n: Math.max(2, Math.ceil(N / 2)) },
    { name: 'BOUNDARY_brave_page_session', env: {}, tool: 'brave_page', args: { url: DEMOS.recaptcha, purpose: 'read', keep_session: true, formats: ['text'] }, n: 1, closeSession: true },
  ];
  const only = arg('only', '');
  for (const sc of scenarios) {
    if (only && !only.split(',').includes(sc.name)) continue;
    const b = await startBrave({ ...baseEnv, ...sc.env });
    console.error(`[meres] ${sc.name}: brave-mcp pid=${b.pid} ${b.base}`);
    try {
      for (let i = 0; i < sc.n; i++) {
        const e0 = eng.calls.length;
        const r = await callTool(b.base, sc.tool, sc.args);
        const s = summarize(r, e0, eng);
        out.runs.push({ scenario: sc.name, i, ...s });
        console.error(`[meres]   #${i} ${s.ms}ms captcha=${JSON.stringify(s.captcha)} calls=${s.engine_calls.length}`);
        if (sc.closeSession && r.result?.session_id) await callTool(b.base, 'brave_page', { session_id: r.result.session_id, close: true });
        await sleep(1500);
      }
    } finally {
      out.runs.filter(x => x.scenario === sc.name).forEach(x => { x.server_log_tail = undefined; });
      out[`log_${sc.name}`] = b.log.slice(-20);
      await stopBrave(b);
    }
  }
  out.finished = new Date().toISOString();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  await eng.close();
  console.error(`[meres] kész → ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
