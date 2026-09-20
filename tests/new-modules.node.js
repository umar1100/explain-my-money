/* New-module tests: OCR receipt parser (pure) + LLM privacy adapter.
   Synthetic data only. No network. Run with node. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB = path.join(__dirname, '..', 'apps/web');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok   ' + name);
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}

/* ---------- load ocr.js + llm.js into a DOM-less sandbox ---------- */
const sandbox = { console: console };
sandbox.window = sandbox;
sandbox.global = sandbox;
sandbox.self = sandbox;
// Minimal localStorage stub so settings round-trip is testable.
const _ls = {};
sandbox.localStorage = {
  getItem: (k) => (k in _ls ? _ls[k] : null),
  setItem: (k, v) => { _ls[k] = String(v); },
  removeItem: (k) => { delete _ls[k]; }
};
vm.createContext(sandbox);
for (const f of ['js/ocr.js', 'js/llm.js']) {
  vm.runInContext(fs.readFileSync(path.join(WEB, f), 'utf8'), sandbox, { filename: f });
}
const OCR = sandbox.OCR;
const LLM = sandbox.LLM;
if (!OCR || !LLM) { console.error('FAIL: OCR/LLM did not load'); process.exit(1); }

/* ---------- OCR.parseReceiptText ---------- */
console.log('== OCR receipt parsing (synthetic)');
const receiptText = [
  'COSTCO WHOLESALE #138',
  '5980 Ave. Example',
  '2026-08-14  18:22',
  '',
  'KS PROTEIN BAR      24.99',
  'MILK 2L              6.49',
  'BANANAS              3.29',
  '',
  'SUBTOTAL            34.77',
  'GST                  1.74',
  'TOTAL              $36.51',
  'MASTERCARD        $36.51',
  'THANK YOU'
].join('\n');

const r = OCR.parseReceiptText(receiptText);
check('merchant parsed (store number stripped by design)',
  r.merchant_text === 'COSTCO WHOLESALE', JSON.stringify(r.merchant_text));
check('total parsed = 3651', r.total_minor === 3651, 'got ' + r.total_minor);
check('date parsed = 2026-08-14', r.receipt_date === '2026-08-14', 'got ' + r.receipt_date);
check('line items found >= 3', (r.line_items || []).length >= 3, 'got ' + (r.line_items || []).length);
check('tax parsed = 174', r.tax_minor === 174, 'got ' + r.tax_minor);

const empty = OCR.parseReceiptText('gibberish no amounts here\njust words');
check('no total on gibberish', empty.total_minor === null);
check('merchant falls back to first line',
  empty.merchant_text === 'gibberish no amounts here', JSON.stringify(empty.merchant_text));

/* ---------- LLM settings ---------- */
console.log('== LLM settings');
check('disabled by default', LLM.isActive() === false);
check('no key by default', LLM.hasKey() === false);
LLM.saveSettings({ enabled: true, privacyMode: 'aggregates', baseUrl: 'https://example.test/v1', model: 'test-model' });
const s = LLM.getSettings();
check('settings round-trip', s.enabled === true && s.privacyMode === 'aggregates' &&
  s.baseUrl === 'https://example.test/v1' && s.model === 'test-model', JSON.stringify(s));
check('still inactive without key', LLM.isActive() === false);
LLM.setKey('sk-test');
check('active with enabled+key+mode', LLM.isActive() === true);
check('hasKey true', LLM.hasKey() === true);
LLM.clearKey();
check('clearKey forgets', LLM.hasKey() === false && LLM.isActive() === false);
LLM.saveSettings({ enabled: false, privacyMode: 'off' }); // restore safe defaults

/* ---------- LLM packet builder ---------- */
console.log('== LLM privacy packets');
const facts = {
  scope: { period: 'Aug 2026', accounts: ['PC Mastercard'], currency: 'CAD' },
  metrics: [{ metric: 'net_spend', amount_minor: 123456 }],
  drivers: [{ group: 'groceries', delta_minor: 5000, confidence: 1 }],
  unresolved: [{ count: 2 }]
};

const agg = LLM.buildPacket(facts, 'aggregates');
check('aggregates shape = scope/facts/drivers/unresolved/privacy_mode',
  !!(agg.scope && Array.isArray(agg.facts) && Array.isArray(agg.drivers) && agg.privacy_mode === 'aggregates'),
  JSON.stringify(Object.keys(agg)));
check('aggregates metrics pass through', agg.facts.length === 1 && agg.facts[0].amount_minor === 123456);
check('aggregates has no transaction detail',
  JSON.stringify(agg).indexOf('merchant') === -1 && !agg.transactions && !agg.approved_detail);
check('aggregates never includes receipt images/account numbers',
  !agg.receipt_images && JSON.stringify(agg).indexOf('4242') === -1);

const approved = [{ merchant: 'COSTCO', amount_minor: 3651 }];
const det = LLM.buildPacket(facts, 'detailed', approved);
check('detailed includes exactly the approved detail',
  Array.isArray(det.approved_detail) && det.approved_detail.length === 1 &&
  det.approved_detail[0].merchant === 'COSTCO');

const detEmpty = LLM.buildPacket(facts, 'detailed', null);
check('detailed without approval sends nothing extra',
  Array.isArray(detEmpty.approved_detail) && detEmpty.approved_detail.length === 0);

const prev = LLM.previewPayload(facts, 'answer');
check('preview has provider+model+request', !!(prev.provider && prev.model && prev.request));
let parsed = null;
try { parsed = JSON.parse(prev.request.messages[1].content); } catch (e) {}
check('preview user message is JSON with evidence_packet',
  !!(parsed && parsed.evidence_packet && parsed.kind === 'answer'));
check('preview packet matches buildPacket output',
  JSON.stringify(parsed.evidence_packet) === JSON.stringify(LLM.buildPacket(facts, prev.privacyMode)));

/* phrase* must fall back to deterministic when disabled — no network attempt */
(async () => {
  const res = await LLM.phraseAnswer(facts, 'deterministic text', () => { throw new Error('must not be called'); });
  check('phraseAnswer refuses when disabled (deterministic fallback, no preview call)',
    res.source === 'deterministic' && res.text === 'deterministic text');
  const res2 = await LLM.phraseBriefing(facts, 'briefing text', () => { throw new Error('must not be called'); });
  check('phraseBriefing refuses when disabled',
    res2.source === 'deterministic' && res2.text === 'briefing text');

  if (failures) { console.log('\n' + failures + ' CHECK(S) FAILED'); process.exit(1); }
  console.log('\nALL NEW-MODULE CHECKS PASSED');
})();
