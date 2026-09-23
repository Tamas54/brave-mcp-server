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
