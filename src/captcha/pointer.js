// ════════════════════════════════════════════════════════════════════
//  C2 — emberi egér- és billentyű-bevitel a CAPTCHA-vezényléshez (2026-10-07)
// ════════════════════════════════════════════════════════════════════
// MIÉRT KÜLÖN: a W2 sáv építi a közös humanizálást (src/captcha/*). Amíg az nincs
// a main-en, ez a tartalék: a vezénylés (grid/audio/text) MINDIG a `ctx.human`
// objektumon át mozgat/kattint/gépel, így a merge-nél a W2 megvalósítása egy
// helyen (read-path.js → humanFor()) cserélhető, a folyamatok érintetlenek.
//
// Elvek:
//  * Az egér-pozíciót a Node-oldalon tartjuk (WeakMap lap → {x,y}) — a lapba
//    SEMMIT nem írunk (a régi humanMouseMove window.mouseX-e lapból látható volt).
//  * Bézier-ív kis remegéssel, a lépésszám a távolsággal nő, időkerettel.
//  * Kattintás = mozgás + rövid megállás + down/up 40–120 ms-mal.
//  * Gépelés karakterenként 45–140 ms-mal (a keyboard.type delay-e egyenletes
//    lenne).

const pos = new WeakMap();

const rnd = (a, b) => a + Math.random() * (b - a);
const sleep = (ms) => new Promise(r => setTimeout(r, Math.max(0, ms)));

function startPos(page) {
  const p = pos.get(page);
  if (p) return p;
  let vp = null;
  try { vp = page.viewport(); } catch (_) { /* nincs viewport-infó */ }
  const w = vp?.width || 1280;
  const h = vp?.height || 800;
  return { x: rnd(w * 0.3, w * 0.7), y: rnd(h * 0.3, h * 0.7) };
}

// Egérmozgás a (x, y) pontra Bézier-íven. Visszaadja a tényleges végpontot.
export async function humanMove(page, x, y, { maxMs } = {}) {
  const from = startPos(page);
  const dx = x - from.x;
  const dy = y - from.y;
  const dist = Math.hypot(dx, dy);
  // Fitts-szerű időtartam: rövid út gyors (csempéről csempére ~0,3 s), hosszú lassabb
  const total = maxMs ?? Math.max(180, Math.min(650, 150 + 90 * Math.log2(1 + dist / 30)));
  const steps = Math.max(6, Math.min(28, Math.round(dist / 20)));
  const spread = Math.min(70, dist * 0.22);
  const c1 = { x: from.x + dx * 0.3 + rnd(-spread, spread), y: from.y + dy * 0.3 + rnd(-spread, spread) };
  const c2 = { x: from.x + dx * 0.7 + rnd(-spread, spread), y: from.y + dy * 0.7 + rnd(-spread, spread) };
  // egy mouse.move maga is ~10–20 ms (CDP-kör) — ezt levonjuk az alvásból
  const perStep = Math.max(0, total / steps - 14);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    // ease-in-out: az ív eleje-vége lassabb
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const u = 1 - e;
    let px = u * u * u * from.x + 3 * u * u * e * c1.x + 3 * u * e * e * c2.x + e * e * e * x;
    let py = u * u * u * from.y + 3 * u * u * e * c1.y + 3 * u * e * e * c2.y + e * e * e * y;
    if (i < steps) { px += rnd(-0.8, 0.8); py += rnd(-0.8, 0.8); }
    await page.mouse.move(px, py);
    await sleep(perStep * rnd(0.6, 1.4));
  }
  pos.set(page, { x, y });
  return { x, y };
}

export async function humanClick(page, x, y) {
  await humanMove(page, x, y);
  await sleep(rnd(50, 140));
  await page.mouse.down();
  await sleep(rnd(40, 110));
  await page.mouse.up();
  return { x, y };
}

export async function humanType(page, text) {
  for (const ch of String(text)) {
    await page.keyboard.type(ch);
    await sleep(rnd(45, 140));
  }
}

// Egy elem véletlen pontja a középső ~60%-ban (fő-keret koordinátákban). A
// puppeteer boundingBox()-a a keretek eltolását már beszámítja.
export async function pointIn(handle, { inner = 0.6 } = {}) {
  try {
    await handle.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' }));
  } catch (_) { /* nem görgethető — a box így is jó lehet */ }
  const bb = await handle.boundingBox();
  if (!bb || bb.width < 1 || bb.height < 1) return null;
  const m = (1 - inner) / 2;
  return {
    x: bb.x + bb.width * rnd(m, 1 - m),
    y: bb.y + bb.height * rnd(m, 1 - m),
    box: bb,
  };
}

// Az alapértelmezett „human" a vezényléshez (a W2-é felülírhatja).
export const defaultHuman = {
  move: humanMove,
  click: humanClick,
  type: humanType,
  async clickHandle(page, handle) {
    const p = await pointIn(handle);
    if (!p) return false;
    await humanClick(page, p.x, p.y);
    return true;
  },
};

// A W2 HumanInput-jának (src/stealth/humanize.js: move/click/clickBox/type)
// illesztése a vezénylés felületére. Ha a vezérlőn van `_humanInput()` (a W2
// merge után), a scrape-út ezt adja át — egy böngésző = egy „kéz" (közös mag).
export function fromHumanInput(h) {
  if (!h || typeof h.click !== 'function' || typeof h.clickBox !== 'function') return null;
  return {
    move: (page, x, y) => h.move(page, x, y),
    click: (page, x, y) => h.click(page, x, y),
    async type(page, text) {
      let r = null;
      try { r = await h.type(page, text, { budgetMs: 8000 }); } catch (_) { r = null; }
      if (!r?.humanized) await page.keyboard.type(String(text));
    },
    async clickHandle(page, handle) {
      try { await handle.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' })); } catch (_) {}
      const box = await handle.boundingBox();
      if (!box || box.width < 1 || box.height < 1) return false;
      await h.clickBox(page, box);
      return true;
    },
  };
}
