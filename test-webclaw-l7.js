// End-to-end test of the L7 Webclaw integration in brave-controller.js
//
// Prereq: webclaw-server running locally on http://127.0.0.1:3000
//   cd webclaw-poc && source env.sh && ./webclaw/target/release/webclaw-server
//
// Usage: WEBCLAW_URL=http://127.0.0.1:3000 node test-webclaw-l7.js

import { BraveController } from './src/brave-controller.js';
import dotenv from 'dotenv';

dotenv.config();

const REUTERS_HUB = 'https://www.reuters.com/world/';
const REUTERS_ARTICLE = 'https://www.reuters.com/business/us-consumer-prices-increase-further-april-2026-05-12/';
const EUROSTAT_BASELINE = 'https://ec.europa.eu/eurostat/web/products-euro-indicators';
// devlog szerint biddr.com mind L1-L6 szinten blokkolt (Turnstile + IP-bound clearance)
const BIDDR_TURNSTILE = 'https://www.biddr.com/auctions/leu/browse?a=1839&l=1972015';

function logBlock(title) {
  console.log('\n' + '='.repeat(70));
  console.log(' ' + title);
  console.log('='.repeat(70));
}

function summarize(result, label) {
  const md = result.markdown || '';
  const status = result.content_usable ? 'PASS' : (result.block_reason ? `WEAK(${result.block_reason})` : 'WEAK');
  console.log(`[${label}] ${status}  md_len=${md.length}  cf_status=${result.cf_status || '-'}  title="${(result.title || '').slice(0, 80)}"`);
  if (result.escalation_path) {
    console.log('  escalation_path:');
    for (const step of result.escalation_path) {
      console.log(`    L${step.level} ${step.mode}: ${JSON.stringify({ ok: step.ok, md_len: step.md_len, block_reason: step.block_reason, error: step.error, skipped: step.skipped })}`);
    }
  }
  if (result.markdown) {
    console.log('  --- markdown first 300 chars ---');
    console.log('  ' + md.slice(0, 300).replace(/\n/g, '\n  '));
  }
}

async function main() {
  if (!process.env.WEBCLAW_URL) {
    console.error('ERROR: WEBCLAW_URL env var not set. Set to http://127.0.0.1:3000 for local PoC.');
    process.exit(1);
  }
  console.log(`WEBCLAW_URL = ${process.env.WEBCLAW_URL}`);
  console.log(`FLARESOLVERR_URL = ${process.env.FLARESOLVERR_URL || '(unset, L4/L5 will skip)'}`);

  const controller = new BraveController();
  await controller.initialize();

  try {
    // ── TEST 1 — direct webclaw:true flag ─────────────────────────────
    logBlock('TEST 1: brave_scrape with webclaw:true on Reuters tier-3 hub');
    const t1Start = Date.now();
    const r1 = await controller.scrape(REUTERS_HUB, { webclaw: true });
    console.log(`  time: ${Date.now() - t1Start}ms`);
    summarize(r1, 'webclaw-direct');

    // ── TEST 2 — auto_fallback on Reuters article (should escalate to L3) ─
    logBlock('TEST 2: brave_scrape auto_fallback on Reuters article (expect L3 Webclaw to win)');
    const t2Start = Date.now();
    const r2 = await controller.scrape(REUTERS_ARTICLE, { auto_fallback: true });
    console.log(`  time: ${Date.now() - t2Start}ms`);
    summarize(r2, 'auto_fallback-reuters');

    // ── TEST 3 — auto_fallback on Eurostat (L1 should win without escalation) ─
    logBlock('TEST 3: brave_scrape auto_fallback on Eurostat (baseline, expect L1 to win)');
    const t3Start = Date.now();
    const r3 = await controller.scrape(EUROSTAT_BASELINE, { auto_fallback: true });
    console.log(`  time: ${Date.now() - t3Start}ms`);
    summarize(r3, 'auto_fallback-eurostat');

    // ── TEST 3b — auto_fallback on biddr Turnstile (devlog: L1-L6 BLOKK; L3 Webclaw should win) ─
    logBlock('TEST 3b: auto_fallback on biddr Turnstile (devlog: 6-level BLOCK; expect L3 Webclaw to win)');
    const t3bStart = Date.now();
    const r3b = await controller.scrape(BIDDR_TURNSTILE, { auto_fallback: true });
    console.log(`  time: ${Date.now() - t3bStart}ms`);
    summarize(r3b, 'auto_fallback-biddr-turnstile');

    // ── TEST 4 — webclaw:true without WEBCLAW_URL config — error case ─
    logBlock('TEST 4: webclaw:true with WEBCLAW_URL temporarily unset (expect error response)');
    const savedUrl = process.env.WEBCLAW_URL;
    delete process.env.WEBCLAW_URL;
    const r4 = await controller.scrape(REUTERS_HUB, { webclaw: true });
    process.env.WEBCLAW_URL = savedUrl;
    summarize(r4, 'webclaw-no-config');

  } catch (e) {
    console.error('TEST FAILED:', e.stack);
  } finally {
    await controller.close();
  }
}

main();
