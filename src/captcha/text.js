// ════════════════════════════════════════════════════════════════════
//  C2 — szöveges / matekos CAPTCHA (2026-10-07)
// ════════════════════════════════════════════════════════════════════
// A felismerő (detect.js) a képet és a válasz-mezőt data-c2-cap jellel látja el.
//  * kép nélküli számtani kérdés („Mennyi 3 + 4?") → HELYBEN számolunk, LLM nélkül;
//  * képes feladvány → a kép ELEM-KÉPERNYŐKÉPE (a kép-URL-t SOHA nem töltjük le
//    újra: a legtöbb megvalósítás minden letöltésnél új kódot sorsol, és a
//    munkamenetben az utolsót várja) → C1 `kind:"text"` (instruction: "math", ha
//    a környezet számtani feladatra utal) → a válasz begépelése, beküldés;
//  * kimenet: ha beküldés után nincs többé (ugyanilyen) CAPTCHA a lapon → kész;
//    ha új kép jött (rossz válasz) → új kör, legfeljebb ctx.maxRounds.

import { detectCaptcha, solveMathExpr } from './detect.js';
import { act, remaining, sleep, rnd } from './util.js';

async function submitNear(page, inp, ctx) {
  const btnH = await inp.evaluateHandle((el) => {
    const f = el.form || el.closest('form');
    if (!f) return null;
    return f.querySelector('button:not([type=button]):not([type=reset]), input[type=submit], input[type=image]');
  }).catch(() => null);
  const btn = btnH ? btnH.asElement() : null;
  if (btn) {
    await ctx.human.clickHandle(page, btn);
    act(ctx, { type: 'click', target: 'form_submit' });
  } else {
    await page.keyboard.press('Enter');
    act(ctx, { type: 'press', key: 'Enter' });
  }
}

export async function solveTextCaptcha(page, det, ctx) {
  ctx.vendor = 'text';
  let cur = det;
  let rounds = 0;
  let lastErr = null;
  while (rounds < ctx.maxRounds && remaining(ctx) > 1500) {
    rounds++;
    const inp = await page.$('[data-c2-cap="input"]');
    if (!inp) return { ok: false, error: 'input_missing', rounds };
    let answer = null;
    if (cur.kind === 'math_text') {
      answer = solveMathExpr(cur.text?.expr);
      act(ctx, { type: 'local_math' });
      if (answer === null) return { ok: false, error: 'math_unparsed', rounds };
    } else {
      const img = await page.$('[data-c2-cap="img"]');
      if (!img) return { ok: false, error: 'image_missing', rounds };
      if (cur.text && cur.text.imageLoaded === false) return { ok: false, error: 'image_not_loaded', rounds };
      let b64;
      try { b64 = await img.screenshot({ encoding: 'base64', type: 'png' }); } catch (e) {
        return { ok: false, error: `image_capture_failed:${String(e?.message || e).slice(0, 60)}`, rounds };
      }
      // C1: a számtani kép külön fajta (kind:"math" — a modell átír, a motor számol)
      const resp = await ctx.solve({
        kind: cur.text?.mathHint ? 'math' : 'text', image_b64: b64,
        meta: { vendor: 'text', math: !!cur.text?.mathHint },
      });
      if (!resp.ok) {
        lastErr = resp.error || 'solver_failed';
        if (resp.fatal) return { ok: false, error: lastErr, rounds };
        continue;
      }
      answer = String(resp.answer ?? '').trim();
      if (!answer) { lastErr = 'empty_answer'; continue; }
    }
    // a mező törlése és a válasz begépelése
    await ctx.human.clickHandle(page, inp);
    await inp.evaluate((el) => { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }).catch(() => {});
    await sleep(rnd(80, 200));
    await ctx.human.type(page, answer);
    act(ctx, { type: 'type', target: 'captcha_input', chars: answer.length });
    await sleep(rnd(200, 500));

    let navigated = false;
    const navP = page.waitForNavigation({ timeout: Math.max(500, Math.min(8000, remaining(ctx) - 500)) })
      .then(() => { navigated = true; }).catch(() => {});
    await submitNear(page, inp, ctx);
    // beküldés: navigáció VAGY helyben (XHR) csere — legfeljebb a keretig várunk
    await Promise.race([navP, sleep(Math.min(4000, Math.max(300, remaining(ctx) - 800)))]);
    if (navigated) {
      try { await page.waitForNetworkIdle({ idleTime: 400, timeout: Math.max(300, Math.min(4000, remaining(ctx) - 500)) }); } catch (_) {}
    }
    const again = await detectCaptcha(page, { waitMs: 0 });
    if (!again.found || again.vendor !== 'text') {
      act(ctx, { type: 'outcome', outcome: 'solved' });
      return { ok: true, rounds, answer };
    }
    act(ctx, { type: 'outcome', outcome: 'retry' });
    lastErr = 'wrong_answer';
    cur = again;
  }
  return { ok: false, error: rounds >= ctx.maxRounds ? `max_rounds:${lastErr || 'unknown'}` : 'budget_exhausted', rounds };
}
