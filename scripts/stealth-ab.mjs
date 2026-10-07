#!/usr/bin/env node
// Stealth A/B-mérés (2026-10-07, TINYFISH PARITY 2.9).
//
// A brave-mcp-t HELYBEN indítja (a repó szerint: node src/dual-server.js
// --http-only) konfigurációnként külön processzben, és a brave_scrape MCP-
// toolt hívja (a 7 szintű lánc 1. „default" és 2. „stealth" szintje) ugyanazon
// a tesztoldal-készleten:
//   * saját jeldetektor (test/fixtures/stealth-probe.js, 127.0.0.1),
//   * nyilvános fingerprint-/botdetektor-oldalak (sannysoft, creepjs,
//     browserleaks, pixelscan, deviceandbrowserinfo, areyouheadless),
//   * valós, közepesen védett oldalak — CSAK azt rögzítjük, kapunk-e
//     blokk-/challenge-lapot. ⛔ CAPTCHA-megoldás / Turnstile-kijátszás NINCS
//     (Kommandant, 09-23): a mérés a detektálási JELEK számát nézi.
//
// Konfigurációk (env a szerverprocesszeknek):
//   off      — STEALTH_TF_EVASIONS kikapcsolva (a mai éles viselkedés)
//   on_ua    — TF, persona-OS = a kért UA OS-e + WebGL-maszk (a fork szó szerint)
//   on_host  — TF, persona-OS = gazdagép + WebGL-maszk
//   on_host_native — TF, persona-OS = gazdagép, nincs WebGL-maszk
//   on       — csak STEALTH_TF_EVASIONS=1 (a TF alapértékei = on_host_native)
//
// Használat:
//   node scripts/stealth-ab.mjs --browser /usr/bin/brave-browser \
//     [--configs off,on_ua,on_host,on_host_native] [--sites probe,sannysoft,...] \
//     [--real-rounds 2] [--out ab.json] [--md ab.md]
// A gazdagép locale-ját prod-szerűre (en_US) állítjuk minden konfigurációnál —
// a Docker-image-ben nincs LANG, így ott a Chrome alapja en-US.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixture } from '../test/helpers.js';
import { probeRoutes, parseProbe } from '../test/fixtures/stealth-probe.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const CONFIGS = {
  off: {},
  on_ua: { STEALTH_TF_EVASIONS: '1', STEALTH_TF_PERSONA_OS: 'ua', STEALTH_TF_WEBGL: 'mask' },
  on_host: { STEALTH_TF_EVASIONS: '1', STEALTH_TF_PERSONA_OS: 'host', STEALTH_TF_WEBGL: 'mask' },
  on_host_native: { STEALTH_TF_EVASIONS: '1', STEALTH_TF_PERSONA_OS: 'host', STEALTH_TF_WEBGL: 'native' },
  // A TF alapértékei (= on_host_native, 2026-10-07 óta) — élesítés előtti ellenőrzéshez.
  on: { STEALTH_TF_EVASIONS: '1' },
};

// ─── Elemzők: szöveg → { signals, verdict, details[] } ───────────────────
const uaOS = (ua) => /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Linux|X11/.test(ua) ? 'Linux' : '?';
const BLOCK_RE = /Just a moment|Robot or human|Access Denied|Additional Verification Required|captcha-delivery|Pardon Our Interruption|verify you are (a )?human|unusual traffic|Request blocked|You have been blocked|Attention Required/i;

const PARSERS = {
  probe(text) {
    const p = parseProbe(text);
    if (!p) return { signals: null, verdict: 'nincs eredmény', details: [] };
    return { signals: p.signals, verdict: `${p.signals}/${p.checks}`, details: p.bots };
  },
  sannysoft(text) {
    const intoliFail = (text.match(/\(failed\)|\bWebDriver Advanced failed/g) || []).length;
    const fps = [...text.matchAll(/([A-Z][A-Z_]{3,})(ok|WARN|FAIL)\{/g)];
    if (!fps.length) return { signals: null, verdict: 'nincs eredmény', details: [] };
    const bad = fps.filter(m => m[2] !== 'ok').map(m => `${m[1]}:${m[2]}`);
    return { signals: intoliFail + bad.length, verdict: `intoli-fail ${intoliFail}, fpscanner ${bad.length}/${fps.length}`, details: bad };
  },
  creepjs(text) {
    const lh = text.match(/(\d+)% like headless/);
    const h = text.match(/(\d+)% headless/);
    const s = text.match(/(\d+)% stealth/);
    if (!lh || !h || !s) return { signals: null, verdict: 'nincs eredmény', details: [] };
    const i = text.indexOf('like headless');
    const j = text.indexOf('platform hints', i);
    const seg = text.slice(i, j > i ? j : i + 1500);
    // A szövegben az érték / szekciócím és a következő kulcs összeragad („falsehasX: true", „StealthhasY: true") → előtag le.
    const flags = [...seg.matchAll(/(?:true|false|Like Headless|Headless|Stealth)?([a-z][a-zA-Z]+): true/g)].map(m => m[1]);
    const ext = (text.match(/extension: ([\w-]+)/) || [])[1];
    return {
      signals: flags.length,
      verdict: `like-headless ${lh[1]}% · headless ${h[1]}% · stealth ${s[1]}%${ext ? ' · ext: ' + ext : ''}`,
      details: flags,
    };
  },
  browserleaks(text) {
    const ua = (text.match(/userAgent(Mozilla\/5\.0[^\n]*?Safari\/[\d.]+)/) || [])[1];
    if (!ua) return { signals: null, verdict: 'nincs eredmény', details: [] };
    const plat = (text.match(/ platform([A-Za-z0-9 _]+?) oscpu/) || [])[1] || '';
    const wd = (text.match(/webdriver(true|false)/) || [])[1];
    const brands = (text.match(/brands(\[[^\]]*\]|[^ ]+)/) || [])[1] || '';
    const chPlat = (text.match(/mobile(?:true|false) platform(\S+)/) || [])[1] || '';
    const os_ = uaOS(ua);
    const platOk = { Windows: /^Win32$/, macOS: /^MacIntel$/, Linux: /^Linux/ }[os_];
    const bad = [];
    if (wd === 'true') bad.push('webdriver=true');
    if (platOk && !platOk.test(plat)) bad.push(`platform ${plat} vs UA ${os_}`);
    if (!brands || brands === '[]') bad.push('UA-CH brands üres');
    if (chPlat === 'empty' || (chPlat && chPlat !== os_)) bad.push(`UA-CH platform ${chPlat} vs UA ${os_}`);
    return { signals: bad.length, verdict: `UA ${os_} · platform ${plat} · CH ${chPlat || '?'}`, details: bad };
  },
  pixelscan_fp(text) {
    const m = text.match(/Fingerprint is (consistent|inconsistent)/);
    const auto = /No automated behavior detected/.test(text) ? 'nincs automatizáció' : /utomat\w* (behavior|framework) detected/.test(text) ? 'AUTOMATIZÁCIÓ' : '?';
    if (!m) return { signals: null, verdict: 'nincs eredmény', details: [] };
    const bad = [];
    if (m[1] === 'inconsistent') bad.push('fingerprint inconsistent');
    if (auto === 'AUTOMATIZÁCIÓ') bad.push('automation detected');
    return { signals: bad.length, verdict: `${m[1]} · ${auto}`, details: bad };
  },
  pixelscan_bot(text) {
    const i = text.indexOf('Navigator ');
    if (i < 0 || !/Clear/.test(text)) return { signals: null, verdict: 'nincs eredmény', details: [] };
    const j = text.indexOf('User agentMozilla', i);
    const seg = text.slice(i, j > i ? j : i + 6000);
    const clear = (seg.match(/\bClear\b/g) || []).length;
    const bad = [...seg.matchAll(/(\w+) (Detected|Suspicious|Failed|Warning)\b/g)].map(m => `${m[1]}:${m[2]}`);
    return { signals: bad.length, verdict: `${bad.length} jelzett / ${clear} tiszta`, details: bad };
  },
  dbi(text) {
    const m = text.match(/"isBot":\s*(true|false)/);
    if (!m) return { signals: null, verdict: 'nincs eredmény', details: [] };
    const d = text.match(/"details":\s*\{([^}]*)\}/);
    const flags = d ? [...d[1].matchAll(/"(\w+)":\s*true/g)].map(x => x[1]) : [];
    return { signals: flags.length, verdict: m[1] === 'true' ? 'BOT' : 'ember', details: flags };
  },
  areyouheadless(text) {
    if (/You are not Chrome headless/i.test(text)) return { signals: 0, verdict: 'nem headless', details: [] };
    if (/You are Chrome headless/i.test(text)) return { signals: 1, verdict: 'HEADLESS', details: ['headless'] };
    return { signals: null, verdict: /502|Bad Gateway/.test(text) ? 'elérhetetlen (502)' : 'nincs eredmény', details: [] };
  },
  real(text, r) {
    const t = String(text || '');
    const title = String(r?.title || '');
    const blocked = t.trim().length < 200 || BLOCK_RE.test(title) || BLOCK_RE.test(t.slice(0, 3000));
    const why = t.trim().length < 200 ? 'üres/csonk válasz' : ((title.match(BLOCK_RE) || t.slice(0, 3000).match(BLOCK_RE) || [])[0] || '');
    return { signals: blocked ? 1 : 0, verdict: blocked ? `BLOKK (${why})` : `átjut (${t.length} kar.)`, details: blocked ? [why] : [] };
  },
};

const PUBLIC = [
  { id: 'probe', kind: 'probe', wait: 800 },
  { id: 'sannysoft', url: 'https://bot.sannysoft.com/', kind: 'sannysoft', wait: 3000 },
  { id: 'creepjs', url: 'https://abrahamjuliot.github.io/creepjs/', kind: 'creepjs', wait: 12000 },
  { id: 'browserleaks', url: 'https://browserleaks.com/javascript', kind: 'browserleaks', wait: 3000 },
  { id: 'pixelscan_fp', url: 'https://pixelscan.net/fingerprint-check', kind: 'pixelscan_fp', wait: 15000 },
  { id: 'pixelscan_bot', url: 'https://pixelscan.net/bot-check', kind: 'pixelscan_bot', wait: 15000 },
  { id: 'dbi', url: 'https://deviceandbrowserinfo.com/are_you_a_bot', kind: 'dbi', wait: 8000 },
  { id: 'areyouheadless', url: 'https://arh.antoinevastel.com/bots/areyouheadless', kind: 'areyouheadless', wait: 3000 },
];
const REAL = [
  { id: 'reuters', url: 'https://www.reuters.com/world/' },
  { id: 'zillow', url: 'https://www.zillow.com/homes/for_sale/' },
  { id: 'indeed', url: 'https://www.indeed.com/jobs?q=nurse' },
  { id: 'walmart', url: 'https://www.walmart.com/search?q=tv' },
  { id: 'leboncoin', url: 'https://www.leboncoin.fr/' },
  { id: 'etsy', url: 'https://www.etsy.com/search?q=mug' },
  { id: 'idealista', url: 'https://www.idealista.com/' },
  { id: 'g2', url: 'https://www.g2.com/categories/crm' },
].map(s => ({ ...s, kind: 'real', wait: 3000 }));

// ─── Szerver-indítás (mint a test/http-e2e.test.js) ─────────────────────
async function freePort() {
  const s = net.createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise(r => s.close(r));
  return p;
}

async function startServer(name, extraEnv, browserPath) {
  const port = await freePort();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `bmcp-ab-${name}-`));
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('RAILWAY_') || k.startsWith('BRAVE_') || k.startsWith('STEALTH_TF_')) delete env[k];
  }
  Object.assign(env, {
    PORT: String(port), HEADLESS: 'true', BRAVE_PATH: browserPath,
    BRAVE_WATCHDOG_DISABLED: 'true', NODE_ENV: 'test', BRAVE_EGRESS_ALLOW_TEST_LOOPBACK: '1',
    BRAVE_PAGE_PROFILE_DIR: path.join(cwd, 'profiles'),
    // A lassú detektor-oldalak (creepjs/pixelscan ~15-30 s) miatt a 25 s-os
    // tool-határidő itt tágabb — a mért viselkedést nem érinti.
    TOOL_CALL_TIMEOUT_MS: '90000',
    LANG: 'en_US.UTF-8', LANGUAGE: 'en_US:en', LC_ALL: 'en_US.UTF-8',
    ...extraEnv,
  });
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'dual-server.js'), '--http-only'], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  while (Date.now() - t0 < 40000) {
    try { if ((await fetch(`${base}/tools`)).ok) break; } catch (_) { /* indul */ }
    await new Promise(r => setTimeout(r, 250));
  }
  let seq = 0;
  const call = async (args) => {
    const r = await fetch(`${base}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method: 'tools/call', params: { name: 'brave_scrape', arguments: args } }),
    });
    const j = await r.json();
    if (j.error) return { error: j.error.message || JSON.stringify(j.error) };
    const text = j.result?.content?.[0]?.text || '';
    try { return JSON.parse(text); } catch (_) { return { raw: text }; }
  };
  const health = async () => { try { return await (await fetch(`${base}/health`)).json(); } catch (e) { return { error: e.message }; } };
  const stop = async () => {
    child.kill('SIGTERM');
    await new Promise(r => { child.once('exit', r); setTimeout(r, 8000); });
    fs.rmSync(cwd, { recursive: true, force: true });
  };
  return { name, call, health, stop, log: () => log };
}

// ─── Fő menet ────────────────────────────────────────────────────────────
async function main() {
  const browserPath = arg('browser', process.env.BRAVE_PATH || '/usr/bin/brave-browser');
  const cfgNames = arg('configs', 'off,on_ua,on_host,on_host_native').split(',').filter(c => CONFIGS[c]);
  const only = arg('sites', '') ? new Set(arg('sites', '').split(',')) : null;
  const realRounds = parseInt(arg('real-rounds', '2'), 10);
  const outPath = arg('out', path.join(os.tmpdir(), 'stealth-ab.json'));
  const mdPath = arg('md', '');

  const fx = await startFixture(probeRoutes());
  const servers = {};
  for (const c of cfgNames) servers[c] = await startServer(c, CONFIGS[c], browserPath);
  const meta = { started: new Date().toISOString(), browser: browserPath, configs: {} };
  for (const c of cfgNames) meta.configs[c] = { env: CONFIGS[c], stealth_tf: (await servers[c].health())?.stealth_tf ?? null };

  const jobs = [];
  for (const s of PUBLIC) jobs.push({ ...s, round: 1 });
  for (let r = 1; r <= realRounds; r++) for (const s of REAL) jobs.push({ ...s, round: r });
  const results = [];
  const save = () => fs.writeFileSync(outPath, JSON.stringify({ meta, results }, null, 1));

  const siteIdx = {};
  const seen = {};
  for (const job of jobs) {
    if (only && !only.has(job.id) && !(only.has('real') && job.kind === 'real')) continue;
    // Konfig-sorrend forgatása oldalanként ÉS körönként (IP-hírnév / sorrendi
    // torzítás ellen): egy oldal k-adik előfordulásánál a (oldal-index + k)-adik
    // konfig megy elöl — így N körben minden konfig egyszer első. (A globális
    // számláló hibás volt: ha az oldalszám a konfigszám többszöröse, egy oldalon
    // minden körben ugyanaz a konfig ment elöl — 2026-10-07, mérve.)
    if (!(job.id in siteIdx)) siteIdx[job.id] = Object.keys(siteIdx).length;
    seen[job.id] = (seen[job.id] || 0) + 1;
    const off = siteIdx[job.id] + seen[job.id] - 1;
    const order = cfgNames.map((_, i) => cfgNames[(i + off) % cfgNames.length]);
    for (const c of order) {
      for (const level of ['default', 'stealth']) {
        const url = job.kind === 'probe' ? `${fx.base}/probe` : job.url;
        const t0 = Date.now();
        let r;
        try { r = await servers[c].call({ url, stealth: level === 'stealth', waitTime: job.wait, timeout: 45000 }); } catch (e) { r = { error: e.message }; }
        const ms = Date.now() - t0;
        const text = r?.text || r?.raw || '';
        const parsed = r?.error ? { signals: null, verdict: 'HIBA: ' + String(r.error).slice(0, 80), details: [] } : PARSERS[job.kind](text, r);
        const ua = (text.match(/Mozilla\/5\.0 \(([^)]+)\)/) || [])[1] || '';
        results.push({ site: job.id, kind: job.kind, round: job.round, config: c, level, ms, ...parsed, ua_os: ua ? uaOS(ua) : '' });
        console.log(`[ab] ${job.id}#${job.round} ${c}/${level} ${ms}ms → ${parsed.signals ?? '–'} | ${parsed.verdict}${parsed.details.length ? ' | ' + parsed.details.slice(0, 6).join(',') : ''}`);
        save();
      }
    }
  }
  meta.finished = new Date().toISOString();
  save();
  for (const c of cfgNames) await servers[c].stop();
  await fx.close();
  if (mdPath) fs.writeFileSync(mdPath, renderMd({ meta, results }));
  console.log(`[ab] kész: ${outPath}${mdPath ? ' + ' + mdPath : ''}`);
}

// Összesítő táblázat (oldal × konfig × szint), a valós oldalaknál a körök összege.
export function renderMd({ meta, results }) {
  const cfgs = Object.keys(meta.configs);
  const sites = [...new Set(results.map(r => r.site))];
  const cell = (rs) => {
    if (!rs.length) return '–';
    const nums = rs.map(r => r.signals).filter(v => v !== null && v !== undefined);
    if (!nums.length) return rs[0].verdict;
    if (rs[0].kind === 'real') return `${nums.reduce((a, b) => a + b, 0)}/${nums.length} blokk`;
    return `${nums.join('+')} · ${rs[0].verdict}`;
  };
  const head = ['Oldal', ...cfgs.flatMap(c => [`${c} default`, `${c} stealth`])];
  const lines = [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`];
  for (const s of sites) {
    const row = [s];
    for (const c of cfgs) for (const l of ['default', 'stealth']) row.push(cell(results.filter(r => r.site === s && r.config === c && r.level === l)).replace(/\|/g, '/'));
    lines.push(`| ${row.join(' | ')} |`);
  }
  return lines.join('\n') + '\n';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
