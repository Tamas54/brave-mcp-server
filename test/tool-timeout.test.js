// Tool-szintű hívás-határidő (src/tool-timeout.js) — tiszta egységtesztek.
import test from 'node:test';
import assert from 'node:assert/strict';
import { toolTimeoutMs } from '../src/tool-timeout.js';

test('alap: minden tool 25 s, ha nincs env', () => {
  assert.equal(toolTimeoutMs('brave_page', { url: 'https://x' }, {}), 25000);
  assert.equal(toolTimeoutMs('brave_scrape', { url: 'https://x' }, {}), 25000);
  assert.equal(toolTimeoutMs('ismeretlen', undefined, {}), 25000);
});

test('brave_scrape flaresolverr / auto_fallback → 160 s', () => {
  assert.equal(toolTimeoutMs('brave_scrape', { flaresolverr: true }, {}), 160000);
  assert.equal(toolTimeoutMs('brave_scrape', { auto_fallback: true }, {}), 160000);
  // Csak valódi true számít (a "true" string nem).
  assert.equal(toolTimeoutMs('brave_scrape', { auto_fallback: 'true' }, {}), 25000);
  assert.equal(toolTimeoutMs('brave_scrape', { stealth: true, webclaw: true }, {}), 25000);
});

test('env-felülírás', () => {
  const env = { TOOL_CALL_TIMEOUT_MS: '30000', TOOL_TIMEOUT_SCRAPE_SLOW_MS: '90000' };
  assert.equal(toolTimeoutMs('brave_page', {}, env), 30000);
  assert.equal(toolTimeoutMs('brave_scrape', { auto_fallback: true }, env), 90000);
  // A lassú plafon sosem rövidebb az alapnál.
  assert.equal(toolTimeoutMs('brave_scrape', { auto_fallback: true }, { TOOL_CALL_TIMEOUT_MS: '200000' }), 200000);
  // Hibás env → alapérték.
  assert.equal(toolTimeoutMs('brave_page', {}, { TOOL_CALL_TIMEOUT_MS: 'abc' }), 25000);
  assert.equal(toolTimeoutMs('brave_page', {}, { TOOL_CALL_TIMEOUT_MS: '-5' }), 25000);
});

// 2026-10-08 (rel-wall): az egyszeri purpose:"read" brave_page CAPTCHA-plafonja.
test('READ_CHALLENGE_TIMEOUT_MS: csak egyszeri purpose:"read" brave_page + bekapcsolt C2 → 60 s; minden más az alap', async () => {
  const { readChallengeCeilingMs, isOneShotRead } = await import('../src/tool-timeout.js');
  const on = { CAPTCHA_SOLVER_ENABLED: '1' };
  assert.equal(toolTimeoutMs('brave_page', { url: 'https://x', purpose: 'read' }, on), 60000);
  // close-zal érkező keep_session = egyszeri hívás
  assert.equal(toolTimeoutMs('brave_page', { url: 'https://x', purpose: 'read', keep_session: true, close: true }, on), 60000);
  // munkamenet: SOHA (ott a megoldó sem fut)
  assert.equal(toolTimeoutMs('brave_page', { session_id: 'abc', purpose: 'read' }, on), 25000);
  assert.equal(toolTimeoutMs('brave_page', { url: 'https://x', purpose: 'read', keep_session: true }, on), 25000);
  // purpose nélkül / más purpose / kikapcsolt megoldó / más tool: alap
  assert.equal(toolTimeoutMs('brave_page', { url: 'https://x' }, on), 25000);
  assert.equal(toolTimeoutMs('brave_page', { url: 'https://x', purpose: 'interact' }, on), 25000);
  assert.equal(toolTimeoutMs('brave_page', { url: 'https://x', purpose: 'read' }, {}), 25000);
  assert.equal(toolTimeoutMs('brave_scrape', { url: 'https://x', purpose: 'read' }, on), 25000);
  // env-felülírás; sosem rövidebb az alapnál
  assert.equal(toolTimeoutMs('brave_page', { purpose: 'read', url: 'x' }, { ...on, READ_CHALLENGE_TIMEOUT_MS: '90000' }), 90000);
  assert.equal(toolTimeoutMs('brave_page', { purpose: 'read', url: 'x' }, { ...on, READ_CHALLENGE_TIMEOUT_MS: '5000' }), 25000);
  assert.equal(readChallengeCeilingMs({ TOOL_CALL_TIMEOUT_MS: '70000' }), 70000);
  assert.equal(readChallengeCeilingMs({ READ_CHALLENGE_TIMEOUT_MS: 'abc' }), 60000);
  assert.equal(isOneShotRead({ purpose: 'read', session_id: '' }), true);
  assert.equal(isOneShotRead(null), false);
});
