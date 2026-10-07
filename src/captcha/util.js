// C2 — közös segédek a CAPTCHA-vezényléshez (idő-keret, várakozás, akció-napló).

export const sleep = (ms) => new Promise(r => setTimeout(r, Math.max(0, ms)));
export const rnd = (a, b) => a + Math.random() * (b - a);

export function remaining(ctx) { return ctx.deadlineTs - Date.now(); }

// Akció-napló a válaszhoz (beírt szöveg SOHA, csak a hossza).
export function act(ctx, a) {
  if (ctx.actions.length < 200) ctx.actions.push({ t: Date.now() - ctx.t0, ...a });
}

// fn() igaz-szerű értékéig pollozunk, legfeljebb timeoutMs-ig ÉS a ctx határidejéig.
export async function waitFor(fn, ctx, timeoutMs, intervalMs = 200) {
  const end = Math.min(Date.now() + timeoutMs, ctx.deadlineTs);
  for (;;) {
    let v = null;
    try { v = await fn(); } catch (_) { v = null; }
    if (v) return v;
    if (Date.now() >= end) return null;
    await sleep(intervalMs);
  }
}
