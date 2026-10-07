// ════════════════════════════════════════════════════════════════════
//  C2 — minimál PNG-kodek a csempe-kivágáshoz (2026-10-07)
// ════════════════════════════════════════════════════════════════════
// MIÉRT: a rács csempéit csempénként külön képernyőképpel venni ~110 ms/csempe
// (4×4-en ~1,8 s a 25 s-os keretből, mérve); EGY rács-kép + Node-oldali kivágás
// ~150 ms, és a csempék ugyanabból a pillanatból származnak. Csak azt tudja, amit
// a Chrome képernyőképe ad: 8 bites RGB/RGBA, nem interlace-olt PNG. Más alaknál
// a hívó visszaesik a csempénkénti képernyőképre.

import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// → { w, h, rgb: Buffer (w*h*3) }; nem támogatott alaknál dob.
export function decodePng(buf) {
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('png:signature');
  let off = 8; let w = 0; let h = 0; let ct = -1; let bd = 0; let il = 0;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bd = data[8]; ct = data[9]; il = data[12]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bd !== 8 || il !== 0 || (ct !== 2 && ct !== 6)) throw new Error(`png:unsupported:${bd}/${ct}/${il}`);
  if (w * h > 16_000_000) throw new Error('png:too_large');
  const bpp = ct === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  if (raw.length < h * (stride + 1)) throw new Error('png:truncated');
  const rgb = Buffer.alloc(w * h * 3);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const base = y * (stride + 1);
    const f = raw[base];
    const line = Buffer.from(raw.subarray(base + 1, base + 1 + stride));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      line[x] = v & 255;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      rgb[o] = line[x * bpp]; rgb[o + 1] = line[x * bpp + 1]; rgb[o + 2] = line[x * bpp + 2];
    }
    prev = line;
  }
  return { w, h, rgb };
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// RGB-téglalap → PNG (szűrő nélkül, zlib).
export function encodePng(w, h, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Kivágás a dekódolt képből (képpont-koordinátákban, a képre szorítva).
export function crop(img, x, y, w, h) {
  const x0 = Math.max(0, Math.min(img.w - 1, Math.round(x)));
  const y0 = Math.max(0, Math.min(img.h - 1, Math.round(y)));
  const cw = Math.max(1, Math.min(img.w - x0, Math.round(w)));
  const ch = Math.max(1, Math.min(img.h - y0, Math.round(h)));
  const out = Buffer.alloc(cw * ch * 3);
  for (let r = 0; r < ch; r++) img.rgb.copy(out, r * cw * 3, ((y0 + r) * img.w + x0) * 3, ((y0 + r) * img.w + x0 + cw) * 3);
  return encodePng(cw, ch, out);
}
