// C2 — CAPTCHA-fixture-ök a node --test csomaghoz (2026-10-07).
//
// Két helyi szerver:
//  * „fő" (127.0.0.1): a falas lapok (reCAPTCHA / hCaptcha / szöveges / matekos /
//    belépő-űrlap / tiltott URL) és a fal mögötti tartalom (POST-ellenőrzéssel);
//  * „szolgáltató" (127.0.0.2, KÜLÖN származás): a reCAPTCHA horgony- és
//    feladvány-keret (…/recaptcha/api2/anchor|bframe — ugyanaz az útvonal, mint
//    élesben), a hCaptcha keretek (…/hcaptcha.html#frame=…), és a SZERVER-oldali
//    feladvány-állapot (a kliens nem csalhat: a helyes választ a szerver tudja).
// A hamis engine (startFakeEngine) a C1/C3-szerződést játssza: a beküldött
// KÉPERNYŐKÉPEKET dekódolja (minimál PNG-dekóder) — így a teszt azt is igazolja,
// hogy a csempe-kivágás helyes és a sorrend jó (nem csak a vezénylést).
import http from 'node:http';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const rid = () => crypto.randomBytes(6).toString('hex');

// ── minimál PNG-dekóder (8 bit, RGB/RGBA, nem interlace — a Chrome képe ilyen) ──
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not png');
  let off = 8; let w = 0; let h = 0; let ct = 0; let bd = 0; const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off); const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bd = data[8]; ct = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bd !== 8 || (ct !== 2 && ct !== 6)) throw new Error(`unsupported png ${bd}/${ct}`);
  const bpp = ct === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(w * h * 3);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0; const b = prev[x]; const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
      line[x] = v & 255;
    }
    for (let x = 0; x < w; x++) { out[(y * w + x) * 3] = line[x * bpp]; out[(y * w + x) * 3 + 1] = line[x * bpp + 1]; out[(y * w + x) * 3 + 2] = line[x * bpp + 2]; }
    prev = line;
  }
  return { w, h, px: (x, y) => { const i = (Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) * 3; return [out[i], out[i + 1], out[i + 2]]; }, raw: out };
}

const isRed = ([r, g, b]) => r > 170 && g < 90 && b < 90;

function avgCenter(img) {
  let r = 0; let g = 0; let b = 0; let n = 0;
  for (let y = Math.floor(img.h * 0.35); y < img.h * 0.65; y += 2) {
    for (let x = Math.floor(img.w * 0.35); x < img.w * 0.65; x += 2) { const p = img.px(x, y); r += p[0]; g += p[1]; b += p[2]; n++; }
  }
  return [r / n, g / n, b / n];
}

// piros foltok súlypontja (normalizált) — a hCaptcha-vászon „pont" feladványához
function redBlobs(img) {
  const seen = new Uint8Array(img.w * img.h); const blobs = [];
  for (let y = 0; y < img.h; y += 2) {
    for (let x = 0; x < img.w; x += 2) {
      const k = y * img.w + x;
      if (seen[k] || !isRed(img.px(x, y))) continue;
      const st = [[x, y]]; seen[k] = 1; let sx = 0; let sy = 0; let n = 0;
      while (st.length) {
        const [cx, cy] = st.pop(); sx += cx; sy += cy; n++;
        for (const [dx, dy] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) {
          const nx = cx + dx; const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= img.w || ny >= img.h) continue;
          const nk = ny * img.w + nx;
          if (!seen[nk] && isRed(img.px(nx, ny))) { seen[nk] = 1; st.push([nx, ny]); }
        }
      }
      if (n > 20) blobs.push({ x: sx / n / img.w, y: sy / n / img.h });
    }
  }
  return blobs;
}

// a szöveges CAPTCHA „képe": 4 függőleges sáv, a számjegy d → rgb(d*25, 100, 255-d*25)
function readBars(img) {
  let s = '';
  for (let k = 0; k < 4; k++) {
    const [r] = img.px(Math.floor(img.w * (k + 0.5) / 4), Math.floor(img.h / 2));
    s += String(Math.max(0, Math.min(9, Math.round(r / 25))));
  }
  return s;
}

// a szöveges fixture-kép „olvasása" (a hamis szolgáltatókhoz)
export const fakeTextAnswer = (b64) => readBars(decodePng(Buffer.from(b64, 'base64')));

// ── hamis engine: POST /internal/v1/captcha/solve ─────────────────────────────
export async function startFakeEngine({ token }) {
  const calls = [];
  const behavior = { unsupported: new Set(), wrongFirst: new Set(), delayMs: 0 };
  const server = http.createServer((req, res) => {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method !== 'POST' || req.url !== '/internal/v1/captcha/solve') return send(404, { error: 'not_found' });
    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'unauthorized' });
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      let j;
      try { j = JSON.parse(body); } catch (_) { return send(400, { ok: false, error: 'bad_json' }); }
      calls.push({ kind: j.kind, purpose: j.purpose, tiles: j.tiles_b64?.length || 0, image: !!j.image_b64, audio: !!(j.audio || j.audio_b64),
        instruction: j.instruction, grid: j.grid, meta: j.meta, mime: j.mime, op: j.op, url: j.url });
      if (behavior.delayMs) await new Promise(r => setTimeout(r, behavior.delayMs));
      if (j.purpose !== 'read') return send(403, { ok: false, error: 'purpose_not_read' });
      if (behavior.unsupported.has(j.kind)) return send(501, { ok: false, error: 'unsupported_kind' });
      const base = { ok: true, confidence: 0.9, model: 'fake-vlm', ms: 3, cost_usd: 0.001 };
      try {
        if (j.kind === 'grid') {
          // a C1-szerződés: PONTOSAN EGY — image_b64 (+grid) VAGY tiles_b64
          if (!!j.image_b64 === !!j.tiles_b64) return send(400, { ok: false, error: 'bad_request', detail: 'kind=grid needs exactly one of image_b64 or tiles_b64' });
          let cells;
          if (j.image_b64) {
            const img = decodePng(Buffer.from(j.image_b64, 'base64'));
            const { rows, cols } = j.grid;
            cells = [];
            for (let r = 0; r < rows; r++) {
              for (let c2 = 0; c2 < cols; c2++) {
                const cx = Math.floor((c2 + 0.5) * img.w / cols); const cy = Math.floor((r + 0.5) * img.h / rows);
                let rr = 0; let gg = 0; let bb = 0; let n = 0;
                for (let dy = -6; dy <= 6; dy += 2) for (let dx = -6; dx <= 6; dx += 2) { const p = img.px(cx + dx, cy + dy); rr += p[0]; gg += p[1]; bb += p[2]; n++; }
                cells.push([rr / n, gg / n, bb / n]);
              }
            }
          } else {
            cells = j.tiles_b64.map(b => avgCenter(decodePng(Buffer.from(b, 'base64'))));
          }
          const tiles = cells.map((col, i) => (isRed(col) ? i : -1)).filter(i => i >= 0);
          if (behavior.wrongFirst.has('grid')) { behavior.wrongFirst.delete('grid'); return send(200, { ...base, tiles: [] }); }
          return send(200, { ...base, tiles });
        }
        if (j.kind === 'point') return send(200, { ...base, points: redBlobs(decodePng(Buffer.from(j.image_b64, 'base64'))) });
        if (j.kind === 'text' || j.kind === 'math') {
          const code = readBars(decodePng(Buffer.from(j.image_b64, 'base64')));
          if (behavior.wrongFirst.has('text')) { behavior.wrongFirst.delete('text'); return send(200, { ...base, answer: '0000' }); }
          return send(200, { ...base, answer: code });
        }
        if (j.kind === 'audio') {
          // a C3 alakja: `audio` mező, a válaszban `success` (nem `ok`)
          const m = Buffer.from(j.audio, 'base64').toString('latin1').match(/ANSWER:([a-z0-9 ]+)/);
          const { ok: _o, ...rest } = base;
          return send(200, { success: true, ...rest, backend: 'fake-asr', answer: m ? m[1].trim() : '' });
        }
        return send(400, { ok: false, error: 'bad_request', detail: "kind must be one of ['text', 'math', 'grid']" });
      } catch (e) {
        return send(500, { ok: false, error: `fake_engine:${e.message}` });
      }
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`, calls, behavior,
    close: () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

// ── közös szerver-indító (host választható) ──────────────────────────────────
async function serve(host, handler) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let data = {};
      const ct = String(req.headers['content-type'] || '');
      try {
        if (ct.includes('json')) data = JSON.parse(body || '{}');
        else if (ct.includes('urlencoded')) data = Object.fromEntries(new URLSearchParams(body));
      } catch (_) {}
      Promise.resolve(handler(req, res, u, data)).catch((e) => { res.writeHead(500); res.end(String(e)); });
    });
  });
  await new Promise(r => server.listen(0, host, r));
  return { server, base: `http://${host}:${server.address().port}`, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

const html = (res, s, code = 200) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' }); res.end(s); };
const json = (res, o) => { res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify(o)); };

const COLORS = { red: '#e01010', blue: '#1e3cdc', green: '#10a040' };
const svgTile = (c) => `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="${COLORS[c] || c}"/></svg>`)}`;

function randTiles(n, minRed = 2) {
  for (;;) {
    const t = Array.from({ length: n }, () => (Math.random() < 0.35 ? 'red' : (Math.random() < 0.5 ? 'blue' : 'green')));
    const reds = t.filter(c => c === 'red').length;
    if (reds >= minRed && reds <= n - 2) return t;
  }
}

// ── a szolgáltató-keretek kliens-kódja ────────────────────────────────────────
const ANCHOR_HTML = `<!doctype html><html><body style="margin:0;font-family:Arial,sans-serif">
<div style="width:300px;height:74px;border:1px solid #d3d3d3;background:#f9f9f9;display:flex;align-items:center;padding-left:12px;box-sizing:border-box">
<span id="recaptcha-anchor" role="checkbox" aria-checked="false" tabindex="0" class="recaptcha-checkbox" style="display:inline-block;width:24px;height:24px;border:2px solid #c1c1c1;border-radius:2px;background:#fff;cursor:pointer"></span>
<label style="margin-left:12px">I'm not a robot</label></div>
<script>
const P = new URLSearchParams(location.search); const sid = P.get('sid');
const a = document.getElementById('recaptcha-anchor');
a.addEventListener('click', async (e) => {
  if (!e.isTrusted) return;
  if (P.get('mode') === 'pass') {
    const r = await (await fetch('/rc/pass?sid=' + sid)).json();
    a.setAttribute('aria-checked', 'true');
    parent.postMessage({ rc: 'solved', token: r.token }, '*');
    return;
  }
  parent.postMessage({ rc: 'open' }, '*');
});
window.addEventListener('message', (e) => { if (e.data && e.data.rc === 'checked') { a.setAttribute('aria-checked', 'true'); a.style.background = '#0a0'; } });
</script></body></html>`;

const BFRAME_HTML = `<!doctype html><html lang="en"><body style="margin:0;font-family:Arial,sans-serif;background:#fff">
<div id="root"></div>
<script>
const P = new URLSearchParams(location.search); const sid = P.get('sid');
const root = document.getElementById('root');
const COLORS = { red: '#e01010', blue: '#1e3cdc', green: '#10a040' };
let nonce = 0;
const svg = (c) => 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" data-n="' + (++nonce) + '"><rect width="100" height="100" fill="' + (COLORS[c] || c) + '"/></svg>');
let ch = null;
const j = async (u, body) => (await fetch(u, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {})).json();
function controls(vt) {
  return '<div class="rc-footer" style="padding:8px;display:flex;gap:8px;align-items:center">'
    + '<button id="recaptcha-reload-button" title="Get a new challenge" style="width:40px;height:40px">R</button>'
    + '<button id="recaptcha-audio-button" title="Get an audio challenge" style="width:40px;height:40px">A</button>'
    + '<button id="recaptcha-image-button" title="Get a visual challenge" style="display:none;width:40px;height:40px">I</button>'
    + '<button id="recaptcha-verify-button" style="margin-left:auto;width:100px;height:40px;background:#1a73e8;color:#fff;border:0">' + vt + '</button></div>';
}
function wire() {
  const v = document.getElementById('recaptcha-verify-button');
  v.addEventListener('click', (e) => { if (e.isTrusted) (ch.mode === 'audio' ? verifyAudio() : verify()); });
  document.getElementById('recaptcha-audio-button').addEventListener('click', (e) => { if (e.isTrusted) toAudio(); });
  document.getElementById('recaptcha-reload-button').addEventListener('click', (e) => { if (e.isTrusted) load(); });
}
function hideErrors() { root.querySelectorAll('.rc-imageselect-incorrect-response,.rc-imageselect-error-select-more').forEach(x => { x.style.display = 'none'; }); }
function renderImage() {
  const size = Math.floor(360 / ch.cols); let rows = '';
  for (let r = 0; r < ch.rows; r++) {
    rows += '<tr>';
    for (let c = 0; c < ch.cols; c++) {
      const i = r * ch.cols + c;
      rows += '<td role="button" id="' + i + '" class="rc-imageselect-tile" style="padding:2px;cursor:pointer"><div class="rc-image-tile-wrapper" style="width:' + size + 'px;height:' + size + 'px"><img class="rc-image-tile-' + ch.rows + ch.cols + '" src="' + svg(ch.tiles[i]) + '" style="width:' + size + 'px;height:' + size + 'px;display:block;transition:opacity .2s"></div></td>';
    }
    rows += '</tr>';
  }
  root.innerHTML = '<div id="rc-imageselect"><div class="rc-imageselect-instructions" style="background:#1a73e8;color:#fff;padding:14px"><div class="rc-imageselect-desc-wrapper"><div class="rc-imageselect-desc-no-canonical">Select all images with <strong>' + ch.target + '</strong>' + (ch.dynamic ? '<span> Click verify once there are none left</span>' : '<span> If there are none, click skip</span>') + '</div></div></div>'
    + '<div class="rc-imageselect-challenge"><div id="rc-imageselect-target" class="rc-imageselect-target"><table class="rc-imageselect-table-' + ch.rows + ch.cols + '" style="border-collapse:collapse"><tbody>' + rows + '</tbody></table></div></div>'
    + '<div class="rc-imageselect-incorrect-response" style="display:none;color:red">Please try again.</div>'
    + '<div class="rc-imageselect-error-select-more" style="display:none;color:red">Please select all matching images.</div>'
    + controls(ch.dynamic ? 'Verify' : 'Skip') + '</div>';
  root.querySelectorAll('td.rc-imageselect-tile').forEach(td => td.addEventListener('click', (e) => onTile(e, td)));
  wire();
}
function onTile(e, td) {
  if (!e.isTrusted) return;
  hideErrors();
  const i = +td.id;
  if (ch.dynamic) {
    if (td.classList.contains('rc-imageselect-dynamic-selected')) return;
    td.classList.add('rc-imageselect-dynamic-selected');
    const img = td.querySelector('img'); img.style.opacity = '0';
    setTimeout(async () => {
      const r = await j('/rc/replace?sid=' + sid + '&i=' + i);
      img.src = svg(r.color); img.className = 'rc-image-tile-11';
      setTimeout(() => { img.style.opacity = '1'; td.classList.remove('rc-imageselect-dynamic-selected'); }, 50);
    }, 600);
  } else {
    td.classList.toggle('rc-imageselect-tileselected');
    td.style.outline = td.classList.contains('rc-imageselect-tileselected') ? '4px solid #1a73e8' : '';
    const any = root.querySelectorAll('.rc-imageselect-tileselected').length;
    document.getElementById('recaptcha-verify-button').textContent = any ? 'Verify' : 'Skip';
  }
}
async function verify() {
  const selected = [...root.querySelectorAll('td.rc-imageselect-tileselected')].map(td => +td.id);
  const r = await j('/rc/verify', { sid, selected });
  if (r.ok) { root.innerHTML = ''; parent.postMessage({ rc: 'solved', token: r.token }, '*'); return; }
  if (r.error === 'select-more') { root.querySelector('.rc-imageselect-error-select-more').style.display = 'block'; return; }
  // a valódi bframe rossz válasz után néha az egész keretet újratölti (mérve)
  if (r.reload) { sessionStorage.setItem('c2autostart', '1'); location.reload(); return; }
  await load();
  root.querySelector('.rc-imageselect-incorrect-response').style.display = 'block';
}
async function toAudio(err) {
  const r = await j('/rc/audio?sid=' + sid);
  if (r.blocked) { ch = { mode: 'blocked' }; root.innerHTML = '<div class="rc-doscaptcha-header">Try again later</div><div class="rc-doscaptcha-body">Your computer or network may be sending automated queries.</div>'; return; }
  ch = { mode: 'audio' };
  root.innerHTML = '<div id="rc-audio" style="padding:12px"><div class="rc-audiochallenge-error-message" style="' + (err ? 'color:red' : 'display:none') + '">' + (err || '') + '</div>'
    + '<audio id="audio-source" src="' + r.url + '" style="display:none"></audio>'
    + '<div class="rc-audiochallenge-response-field"><input type="text" id="audio-response" style="width:300px;height:30px"></div>'
    + '<div class="rc-audiochallenge-tdownload"><a class="rc-audiochallenge-tdownload-link" href="' + r.url + '">Download</a></div>'
    + controls('Verify') + '</div>';
  wire();
}
async function verifyAudio() {
  const answer = document.getElementById('audio-response').value;
  const r = await j('/rc/audio-verify', { sid, answer });
  if (r.ok) { root.innerHTML = ''; parent.postMessage({ rc: 'solved', token: r.token }, '*'); return; }
  toAudio('Multiple correct solutions required - please solve more.');
}
async function load() { ch = await j('/rc/challenge?sid=' + sid); ch.mode = 'image'; renderImage(); }
window.addEventListener('message', (e) => { if (e.data && e.data.rc === 'start' && !ch) load(); });
if (sessionStorage.getItem('c2autostart')) { sessionStorage.removeItem('c2autostart'); load(); }
</script></body></html>`;

const HC_HTML = `<!doctype html><html><body style="margin:0;font-family:Arial,sans-serif">
<div id="root"></div>
<script>
const H = new URLSearchParams(location.hash.slice(1)); const frame = H.get('frame'); const sid = H.get('sid');
const root = document.getElementById('root');
const COLORS = { red: '#e01010', blue: '#1e3cdc', green: '#10a040' };
const svgUrl = (c) => "url('data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="' + (COLORS[c] || c) + '"/></svg>') + "')";
const j = async (u, body) => (await fetch(u, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {})).json();
if (frame === 'checkbox') {
  root.innerHTML = '<div style="width:300px;height:74px;border:1px solid #ddd;display:flex;align-items:center;padding-left:14px;box-sizing:border-box"><div id="checkbox" role="checkbox" aria-checked="false" tabindex="0" style="width:28px;height:28px;border:2px solid #999;border-radius:4px;cursor:pointer"></div><span style="margin-left:12px">I am human</span></div>';
  const cb = document.getElementById('checkbox');
  cb.addEventListener('click', (e) => { if (e.isTrusted) parent.postMessage({ hc: 'open' }, '*'); });
  window.addEventListener('message', (e) => { if (e.data && e.data.hc === 'checked') { cb.setAttribute('aria-checked', 'true'); cb.style.background = '#0a0'; } });
} else {
  let ch = null; let clicks = [];
  const err = (on) => { const d = root.querySelector('.display-error'); if (d) { d.style.opacity = on ? '1' : '0'; d.setAttribute('aria-hidden', on ? 'false' : 'true'); } };
  const footer = (label, text) => '<div class="interface-challenge" style="position:relative;height:60px"><div class="display-error" aria-hidden="true" style="opacity:0;color:#b00">Please try again.</div>'
    + '<div class="refresh button" role="button" aria-label="Refresh Challenge." style="position:absolute;left:10px;bottom:5px;width:35px;height:35px;border:1px solid #888">R</div>'
    + '<div class="button-submit button" role="button" aria-label="' + label + '" style="position:absolute;right:10px;bottom:5px;width:90px;height:35px;background:#555;color:#fff;text-align:center;line-height:35px;cursor:pointer"><div class="text">' + text + '</div></div></div>';
  function render() {
    const label = (ch.mode === 'grid' ? 'Submit Challenge, page ' + ch.page + ' of ' + ch.pages : 'Submit Challenge');
    let body = '';
    if (ch.mode === 'grid') {
      body = '<div class="task-grid" style="display:grid;grid-template-columns:repeat(3,120px);gap:6px;padding:8px">'
        + ch.tiles.map((c, i) => '<div class="task-image" data-i="' + i + '" aria-pressed="false" style="width:120px;height:120px;cursor:pointer"><div class="image-wrapper"><div class="image" style="width:120px;height:120px;background-image:' + svgUrl(c) + ';background-size:cover"></div></div></div>').join('') + '</div>';
    } else {
      body = '<canvas id="cv" width="480" height="320" style="width:480px;height:320px;display:block;margin:8px"></canvas>';
    }
    root.innerHTML = '<div class="challenge-view"><div class="challenge-prompt" style="background:#00838f;color:#fff;padding:12px"><h2 class="prompt-text" style="margin:0;font-size:18px">' + ch.prompt + '</h2></div>' + body + '</div>' + footer(label, 'Skip');
    if (ch.mode === 'grid') {
      root.querySelectorAll('.task-image').forEach(t => t.addEventListener('click', (e) => {
        if (!e.isTrusted) return; err(false);
        const on = t.getAttribute('aria-pressed') !== 'true'; t.setAttribute('aria-pressed', on ? 'true' : 'false'); t.style.outline = on ? '4px solid #00838f' : '';
        root.querySelector('.button-submit .text').textContent = root.querySelectorAll('.task-image[aria-pressed=true]').length ? (ch.page < ch.pages ? 'Next' : 'Verify') : 'Skip';
      }));
    } else {
      const cv = document.getElementById('cv'); const g = cv.getContext('2d');
      g.fillStyle = '#f2efe6'; g.fillRect(0, 0, 480, 320);
      for (const c of ch.circles) { g.beginPath(); g.arc(c.x, c.y, c.r, 0, Math.PI * 2); g.fillStyle = COLORS[c.color]; g.fill(); }
      clicks = [];
      cv.addEventListener('click', (e) => {
        if (!e.isTrusted) return; err(false);
        const b = cv.getBoundingClientRect(); const x = (e.clientX - b.left) * 480 / b.width; const y = (e.clientY - b.top) * 320 / b.height;
        clicks.push({ x, y }); g.fillStyle = '#000'; g.fillRect(x - 2, y - 2, 4, 4);
        root.querySelector('.button-submit .text').textContent = 'Verify';
      });
    }
    root.querySelector('.button-submit').addEventListener('click', (e) => { if (e.isTrusted) submit(); });
    root.querySelector('.refresh').addEventListener('click', (e) => { if (e.isTrusted) load(); });
  }
  async function submit() {
    const selected = [...root.querySelectorAll('.task-image[aria-pressed=true]')].map(t => +t.dataset.i);
    const r = await j('/hc/submit', { sid, selected, clicks });
    if (r.ok && r.token) { parent.postMessage({ hc: 'solved', token: r.token }, '*'); root.innerHTML = ''; return; }
    if (r.ok && r.next) { ch = r.next; render(); return; }
    ch = r.next || ch; render(); err(true);
  }
  async function load() { ch = await j('/hc/challenge?sid=' + sid); render(); }
  window.addEventListener('message', (e) => { if (e.data && e.data.hc === 'start' && !ch) load(); });
}
</script></body></html>`;

// ── szerverek + állapot ───────────────────────────────────────────────────────
export async function startCaptchaFixtures() {
  const st = { rc: new Map(), hc: new Map(), text: new Map(), tokens: new Set(), passHits: [] };

  // „szolgáltató" (külön származás)
  const vendor = await serve('127.0.0.2', (req, res, u, data) => {
    const sid = u.searchParams.get('sid') || data.sid;
    const rc = st.rc.get(sid);
    const hc = st.hc.get(sid);
    if (u.pathname === '/recaptcha/api2/anchor') return html(res, ANCHOR_HTML);
    if (u.pathname === '/recaptcha/api2/bframe') return html(res, BFRAME_HTML);
    if (u.pathname.endsWith('/hcaptcha.html')) return html(res, HC_HTML);
    if (u.pathname === '/rc/pass') { const t = `rc-ok-${rid()}`; st.tokens.add(t); return json(res, { token: t }); }
    if (u.pathname === '/rc/challenge') {
      const dyn = rc.mode === 'dynamic';
      const n = rc.mode === 'static44' ? 16 : 9;
      rc.tiles = randTiles(n);
      rc.queue = {};
      if (dyn) rc.tiles.forEach((c, i) => { rc.queue[i] = c === 'red' && i % 2 === 0 ? ['red', 'blue'] : ['blue']; });
      rc.challenges = (rc.challenges || 0) + 1;
      const side = n === 16 ? 4 : 3;
      return json(res, { rows: side, cols: side, tiles: rc.tiles, target: 'red squares', dynamic: dyn });
    }
    if (u.pathname === '/rc/replace') {
      const i = Number(u.searchParams.get('i'));
      const q = rc.queue[i] || [];
      const c = q.length ? q.shift() : 'blue';
      rc.tiles[i] = c;
      return json(res, { color: c });
    }
    if (u.pathname === '/rc/verify') {
      rc.verifies = (rc.verifies || 0) + 1;
      const reds = rc.tiles.map((c, i) => (c === 'red' ? i : -1)).filter(i => i >= 0);
      let ok;
      if (rc.mode === 'dynamic') ok = reds.length === 0;
      else {
        const sel = new Set(data.selected || []);
        ok = reds.length === sel.size && reds.every(i => sel.has(i));
        if (!ok && sel.size && [...sel].every(i => rc.tiles[i] === 'red')) return json(res, { ok: false, error: 'select-more' });
      }
      if (ok && rc.extraRounds > 0) { rc.extraRounds--; return json(res, { ok: false, error: 'incorrect', reload: rc.mode === 'reload' }); }
      if (!ok) return json(res, { ok: false, error: 'incorrect' });
      const t = `rc-ok-${rid()}`; st.tokens.add(t); rc.solved = true;
      return json(res, { ok: true, token: t });
    }
    if (u.pathname === '/rc/audio') {
      if (rc.mode === 'blockaudio') return json(res, { blocked: true });
      const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
      rc.audioAnswer = Array.from({ length: 4 }, () => words[Math.floor(Math.random() * 10)]).join(' ');
      rc.audioN = (rc.audioN || 0) + 1;
      return json(res, { url: `/rc/audio.mp3?sid=${sid}&n=${rc.audioN}` });
    }
    if (u.pathname === '/rc/audio.mp3') {
      const buf = Buffer.concat([Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00', 'latin1'), crypto.randomBytes(400), Buffer.from(`ANSWER:${rc.audioAnswer}\n`, 'latin1')]);
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      return res.end(buf);
    }
    if (u.pathname === '/rc/audio-verify') {
      rc.audioVerifies = (rc.audioVerifies || 0) + 1;
      if (String(data.answer || '').trim().toLowerCase() === rc.audioAnswer) {
        const t = `rc-ok-${rid()}`; st.tokens.add(t); rc.solved = true;
        return json(res, { ok: true, token: t });
      }
      return json(res, { ok: false });
    }
    if (u.pathname === '/hc/challenge') {
      hc.page = 1;
      return json(res, hcChallenge(hc));
    }
    if (u.pathname === '/hc/submit') {
      hc.submits = (hc.submits || 0) + 1;
      let ok;
      if (hc.mode === 'grid') {
        const reds = hc.tiles.map((c, i) => (c === 'red' ? i : -1)).filter(i => i >= 0);
        const sel = new Set(data.selected || []);
        ok = reds.length === sel.size && reds.every(i => sel.has(i));
      } else {
        const clicks = data.clicks || [];
        const hit = (c, p) => Math.hypot(c.x - p.x, c.y - p.y) <= c.r + 6;
        ok = hc.circles.filter(c => c.color === 'red').every(c => clicks.some(p => hit(c, p)))
          && !clicks.some(p => hc.circles.some(c => c.color !== 'red' && hit(c, p)));
      }
      if (!ok) { hc.page = 1; return json(res, { ok: false, next: hcChallenge(hc) }); }
      if (hc.mode === 'grid' && hc.page < 2) { hc.page++; return json(res, { ok: true, next: hcChallenge(hc) }); }
      const t = `hc-ok-${rid()}`; st.tokens.add(t); hc.solved = true;
      return json(res, { ok: true, token: t });
    }
    res.writeHead(404); res.end('nf');
  });

  function hcChallenge(hc) {
    if (hc.mode === 'grid') {
      hc.tiles = randTiles(9);
      return { mode: 'grid', prompt: 'Please click each image containing a red square', page: hc.page, pages: 2, tiles: hc.tiles };
    }
    const circles = [];
    const nRed = 2 + Math.floor(Math.random() * 2);
    while (circles.length < nRed + 2) {
      const c = { x: 50 + Math.random() * 380, y: 50 + Math.random() * 220, r: 26, color: circles.length < nRed ? 'red' : 'blue' };
      if (circles.every(o => Math.hypot(o.x - c.x, o.y - c.y) > 70)) circles.push(c);
    }
    hc.circles = circles;
    return { mode: 'canvas', prompt: 'Click on every red circle', circles };
  }

  const B2 = vendor.base;
  const secret = (k) => `<!doctype html><title>Content</title><article><h1>Behind the wall</h1><p>SECRET-${k}-CONTENT: the protected article body is here.</p></article>`;

  const textWall = (path, extra = '') => {
    const sid = rid();
    st.text.set(sid, { code: null, fetches: 0 });
    return `<!doctype html><title>Verification</title><h1>Security check</h1>
      <form action="${path}" method="POST"><p>To continue, type the characters you see in the picture.</p>
      <img id="captcha-image" alt="captcha" src="/captcha.svg?sid=${sid}" width="160" height="50" style="display:block;margin:8px 0">
      <input type="hidden" name="sid" value="${sid}">${extra}
      <input type="text" name="captcha_code" id="captcha_code" placeholder="Enter code" autocomplete="off">
      <button type="submit">Continue</button></form>`;
  };

  const main = await serve('127.0.0.1', (req, res, u, data) => {
    const p = u.pathname;
    if (p === '/rc-wall') {
      const sid = rid();
      const mode = u.searchParams.get('mode') || 'static';
      st.rc.set(sid, { mode, extraRounds: mode === 'reload' ? 1 : Number(u.searchParams.get('extra') || 0) });
      const amode = u.searchParams.get('mode') === 'pass' ? 'pass' : 'x';
      return html(res, `<!doctype html><title>Just a moment</title><h1>Please verify you are human</h1>
        <form id="f" action="/rc-pass" method="POST">
          <div class="g-recaptcha"><iframe id="anchor" title="reCAPTCHA" src="${B2}/recaptcha/api2/anchor?ar=1&k=test&sid=${sid}&mode=${amode}" width="304" height="78" style="border:0"></iframe></div>
          <textarea id="g-recaptcha-response" name="g-recaptcha-response" style="display:none"></textarea>
          <button type="submit" id="go">Continue</button>
        </form>
        <div id="bwrap" style="visibility:hidden;position:absolute;left:40px;top:120px;z-index:2000;box-shadow:0 0 4px #888">
          <iframe id="bframe" title="recaptcha challenge expires in two minutes" src="${B2}/recaptcha/api2/bframe?k=test&sid=${sid}" width="400" height="560" style="border:0;background:#fff"></iframe></div>
        <script>
          window.addEventListener('message', (e) => {
            const d = e.data || {};
            if (d.rc === 'open') { document.getElementById('bwrap').style.visibility = 'visible'; document.getElementById('bframe').contentWindow.postMessage({ rc: 'start' }, '*'); }
            if (d.rc === 'solved') { document.getElementById('bwrap').style.visibility = 'hidden'; document.getElementById('g-recaptcha-response').value = d.token; document.getElementById('anchor').contentWindow.postMessage({ rc: 'checked' }, '*'); }
          });
        </script>`);
    }
    if (p === '/hc-wall') {
      const sid = rid();
      st.hc.set(sid, { mode: u.searchParams.get('mode') || 'grid' });
      const fr = (f) => `${B2}/hcaptcha/captcha/v1/abc123/static/hcaptcha.html#frame=${f}&id=w1&sid=${sid}`;
      return html(res, `<!doctype html><title>Verify</title><h1>One more step</h1>
        <form action="/hc-pass" method="POST"><input class="textinput" name="email" type="text" tabindex="-1" aria-hidden="true">
          <div class="h-captcha"><iframe title="Widget containing checkbox for hCaptcha security challenge" src="${fr('checkbox')}" width="302" height="78" style="border:0"></iframe></div>
          <textarea name="h-captcha-response" style="display:none"></textarea><input type="submit" value="Submit"></form>
        <div id="hwrap" style="visibility:hidden;position:absolute;left:30px;top:110px;z-index:2000;background:#fff;box-shadow:0 0 4px #888">
          <iframe id="hch" title="Main content of the hCaptcha challenge" src="${fr('challenge')}" width="520" height="560" style="border:0"></iframe></div>
        <script>
          const cbf = document.querySelector('.h-captcha iframe');
          window.addEventListener('message', (e) => {
            const d = e.data || {};
            if (d.hc === 'open') { document.getElementById('hwrap').style.visibility = 'visible'; document.getElementById('hch').contentWindow.postMessage({ hc: 'start' }, '*'); }
            if (d.hc === 'solved') { document.getElementById('hwrap').style.visibility = 'hidden'; document.querySelector('textarea[name=h-captcha-response]').value = d.token; cbf.contentWindow.postMessage({ hc: 'checked' }, '*'); }
          });
        </script>`);
    }
    if (p === '/rc-pass' || p === '/hc-pass') {
      const t = data['g-recaptcha-response'] || data['h-captcha-response'];
      st.passHits.push({ path: p, ok: st.tokens.has(t) });
      if (st.tokens.has(t)) return html(res, secret(p === '/rc-pass' ? 'RC' : 'HC'));
      return html(res, '<!doctype html><title>Denied</title><p>verification failed</p>', 403);
    }
    if (p === '/text-wall' || p === '/signup/verify') return html(res, textWall(p === '/text-wall' ? '/text-pass' : '/signup/verify-pass', u.searchParams.get('fail') ? '<input type="hidden" name="fail" value="1">' : ''));
    if (p === '/captcha.svg') {
      const s = st.text.get(u.searchParams.get('sid'));
      const code = Array.from({ length: 4 }, () => Math.floor(Math.random() * 10)).join('');
      if (s) { s.code = code; s.fetches++; }
      const bars = [...code].map((d, k) => `<rect x="${k * 40}" y="0" width="40" height="50" fill="rgb(${d * 25},100,${255 - d * 25})"/>`).join('');
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' });
      return res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="160" height="50">${bars}</svg>`);
    }
    if (p === '/text-pass' || p === '/signup/verify-pass') {
      const s = st.text.get(data.sid);
      const failFirst = data.fail && s && !s.failedOnce;
      if (s && s.code && String(data.captcha_code || '') === s.code && !failFirst) {
        st.text.delete(data.sid);
        return html(res, secret('TEXT'));
      }
      if (s && failFirst) s.failedOnce = true;
      // rossz válasz → új feladvány (új sid), a „fail" jelzés nélkül
      return html(res, textWall('/text-pass'));
    }
    if (p === '/math-wall') {
      const a = 2 + Math.floor(Math.random() * 7); const b = 1 + Math.floor(Math.random() * 7);
      const id = rid(); st.text.set(id, { code: String(a + b) });
      return html(res, `<!doctype html><title>Check</title><form action="/math-pass" method="POST">
        <label for="ans">Anti-spam question: What is ${a} + ${b}?</label>
        <input type="text" id="ans" name="answer"><input type="hidden" name="q" value="${id}"><button type="submit">Send</button></form>`);
    }
    if (p === '/math-pass') {
      const s = st.text.get(data.q);
      if (s && String(data.answer).trim() === s.code) return html(res, secret('MATH'));
      return html(res, '<!doctype html><title>Wrong</title><p>wrong answer</p>', 403);
    }
    if (p === '/members/area') {
      const sid = rid(); st.text.set(sid, { code: null, fetches: 0 });
      return html(res, `<!doctype html><title>Log in</title><form action="/session" method="POST">
        <input type="text" name="username" placeholder="User"><input type="password" name="password" placeholder="Password">
        <img alt="captcha" src="/captcha.svg?sid=${sid}" width="160" height="50"><input type="hidden" name="sid" value="${sid}">
        <input type="text" name="captcha_code" placeholder="Enter the code"><button type="submit">Log in</button></form>`);
    }
    if (p === '/article-with-widget') {
      const sid = rid(); st.rc.set(sid, { mode: 'static' });
      const para = '<p>' + 'This is a long article paragraph with plenty of readable words in it. '.repeat(12) + '</p>';
      return html(res, `<!doctype html><title>Article</title><article><h1>Long read</h1>${para.repeat(8)}</article>
        <div class="g-recaptcha"><iframe title="reCAPTCHA" src="${B2}/recaptcha/api2/anchor?ar=1&k=test&sid=${sid}" width="304" height="78" style="border:0"></iframe></div>`);
    }
    if (p === '/v3-page') {
      return html(res, `<!doctype html><title>Contact</title><p>Short page with an invisible v3 badge.</p>
        <script src="${B2}/recaptcha/api.js?render=x"></script>
        <div style="position:fixed;bottom:0;right:0;width:70px;height:60px;overflow:hidden"><iframe title="reCAPTCHA" src="${B2}/recaptcha/api2/anchor?ar=1&k=test&size=invisible" width="256" height="60" style="border:0"></iframe></div>`);
    }
    if (p === '/plain') return html(res, '<!doctype html><title>Plain</title><p>No captcha here, just text.</p><a href="/rc-wall">wall</a>');
    if (p === '/crawl-start') return html(res, '<!doctype html><title>Start</title><p>index</p><a href="/text-wall">a protected page</a>');
    res.writeHead(404); res.end('nf');
  });

  return {
    main: main.base, vendor: B2, st,
    close: async () => { await main.close(); await vendor.close(); },
  };
}
