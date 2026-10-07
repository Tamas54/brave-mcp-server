// MCP-higiénia kapuk (R2-E, P3-2, 2026-10-07).
//
// MIÉRT: a tool-leírás a kliens modelljének KONTEXTUSÁT eszi minden hívásnál;
// ami csendben hízik, az minden ügynök-körben fizet. Ezért mérhető kapu:
//   * minden toolon `title` + annotations (readOnly/destructive/idempotent/openWorld);
//   * egy leírás ≤ 1024 karakter (sok kliens itt vág);
//   * a TELJES tools/list (ahogy a szerver adja) token-súlya ≤ a 2026-10-07-i
//     mért érték + 10 %. Ha új tool / paraméter kell: a kaput TUDATOSAN emeld
//     (a commitban indokolva), ne a leírást hizlald észrevétlenül.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tools, toolListEntry } from '../src/tools.js';

// BPE-közelítés: betű-szavak, számok, egyéb jelek külön tokenek (az engine
// snapshot.estimate_tokens-ének egyszerűsített rokona — a kapu ARÁNYRA figyel).
const estimateTokens = (s) => (String(s).match(/[\p{L}]+|\d+|[^\s\p{L}\d]/gu) || []).length;

// Mérve 2026-10-07 (13 tool, title + annotations + select/clear/dom_markers): 4857.
const MEASURED_TOKENS = 4857;
const BUDGET = Math.ceil(MEASURED_TOKENS * 1.1);

test('minden tool: title + annotations (bool hint-ek), ellentmondás nélkül', () => {
  for (const t of tools) {
    assert.equal(typeof t.title, 'string', `${t.name}: title hiányzik`);
    assert.ok(t.title.length > 0 && t.title.length <= 64, `${t.name}: title hossza`);
    const a = t.annotations;
    assert.ok(a && typeof a === 'object', `${t.name}: annotations hiányzik`);
    for (const k of ['readOnlyHint', 'destructiveHint', 'openWorldHint', 'idempotentHint']) {
      assert.equal(typeof a[k], 'boolean', `${t.name}: ${k}`);
    }
    assert.ok(!(a.readOnlyHint && a.destructiveHint), `${t.name}: egyszerre csak-olvasó és romboló`);
  }
  // a tools/list alakja: title + annotations is kimegy
  const e = toolListEntry(tools.find(t => t.name === 'brave_page'));
  assert.deepEqual(Object.keys(e), ['name', 'title', 'description', 'inputSchema', 'annotations']);
  assert.equal(e.annotations.destructiveHint, true);
  assert.equal(toolListEntry(tools.find(t => t.name === 'brave_scrape')).annotations.readOnlyHint, true);
});

test('leírás ≤ 1024 karakter (tool és paraméter)', () => {
  const walk = (name, schema, path) => {
    if (!schema || typeof schema !== 'object') return;
    if (typeof schema.description === 'string') {
      assert.ok(schema.description.length <= 1024, `${name}${path}: ${schema.description.length} karakter`);
    }
    for (const [k, v] of Object.entries(schema.properties || {})) walk(name, v, `${path}.${k}`);
    if (schema.items) walk(name, schema.items, `${path}[]`);
  };
  for (const t of tools) {
    assert.ok(t.description.length <= 1024, `${t.name}: ${t.description.length} karakter`);
    walk(t.name, t.inputSchema, '');
  }
});

test(`a teljes tools/list token-súlya ≤ ${BUDGET} (mért ${MEASURED_TOKENS} + 10 %)`, () => {
  const n = estimateTokens(JSON.stringify(tools.map(toolListEntry)));
  assert.ok(n <= BUDGET, `tools/list: ${n} token > ${BUDGET}`);
});
