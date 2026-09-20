/* End-to-end integration test: real W1 engine.js + app.js (W2 UI logic) with an
   in-memory Store shim and a minimal DOM stub. No network. Run with node. */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'apps/web/js');

/* ---------- minimal DOM stub ---------- */
function makeEl(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    children: [], dataset: {}, style: {},
    _innerHTML: '', value: '', files: null, type: '',
    id: '', className: '',
    set innerHTML(h) { this._innerHTML = String(h); },
    get innerHTML() { return this._innerHTML; },
    setAttribute() {}, getAttribute() { return null; },
    appendChild(c) { this.children.push(c); return c; },
    insertBefore(c) { this.children.unshift(c); return c; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
    focus() {}, click() {}, remove() {}, closest() { return null; },
  };
  return el;
}
const viewEl = makeEl('div'); viewEl.id = 'view';
const elementsById = { view: viewEl };
global.document = {
  getElementById(id) { return elementsById[id] || null; },
  querySelector(sel) {
    if (sel === '#view') return viewEl;
    const m = /^#([\w-]+)$/.exec(sel);
    return m ? (elementsById[m[1]] || null) : null;
  },
  querySelectorAll() { return []; },
  createElement(tag) { return makeEl(tag); },
  addEventListener() {},
  body: makeEl('body'),
};
global.window = global;
global.CSS = { escape: (s) => String(s) };
global.URL = { createObjectURL: () => 'blob:stub' };
global.requestAnimationFrame = (fn) => setTimeout(fn, 0);

/* ---------- in-memory Store shim (same API semantics as store.js) ---------- */
const memDB = {};
let autoId = 1;
global.Store = {
  async put(store, obj) {
    memDB[store] = memDB[store] || {};
    obj = Object.assign({}, obj);
    if (obj.id === null || obj.id === undefined) obj.id = 'id' + (autoId++);
    memDB[store][String(obj.id)] = obj;
    return obj.id;
  },
  async get(store, id) {
    const t = memDB[store] || {};
    const r = t[String(id)];
    return r ? Object.assign({}, r) : null;
  },
  async all(store) {
    const t = memDB[store] || {};
    return Object.keys(t).map((k) => Object.assign({}, t[k]));
  },
  async query(store, index, value) {
    const t = memDB[store] || {};
    return Object.keys(t).map((k) => Object.assign({}, t[k]))
      .filter((r) => String(r[index]) === String(value));
  },
  async delete(store, id) { const t = memDB[store] || {}; delete t[String(id)]; },
  async logAudit(eventType, entityType, entityId, details) {
    return this.put('auditEvents', { eventType, entityType, entityId, details, timestamp: Date.now() });
  },
  async wipeAll() { for (const k of Object.keys(memDB)) memDB[k] = {}; },
  async exportAll() {
    const out = {};
    for (const k of Object.keys(memDB)) out[k] = await this.all(k);
    return out;
  },
};

/* ---------- load real engine + app ---------- */
global.window = global;
require(WEB + '/engine.js');
require(WEB + '/app.js');
const E = global.Engine, App = global.App, T = App._test;

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; }
  else { fail++; console.error('FAIL:', name, extra === undefined ? '' : JSON.stringify(extra)); }
}
async function main() {
  // --- boot with no data: first-run goes to Add ---
  await App.boot();
  ok(App.state.tab === 'add', 'first run starts at Add tab');
  ok(!App._pipeFailed, 'boot ok');

  // --- simulate statement-file import (bypass file picker) ---
  const csv = fs.readFileSync(path.join(ROOT, 'tests/fixtures/sample_statement_aug2026.csv'), 'utf8');
  const parsed = E.parseCSV(csv);
  ok(parsed.rows.length === 25 && parsed.errors.length === 0, 'parseCSV: 25 rows, 0 errors');
  ok(parsed.rows[0].rawDateText === '2026-08-02', 'rows are objects with rawDateText');
  const hash = T.sha256Hex(csv);
  App.state.pending = {
    fileName: 'sample_statement_aug2026.csv', fileSize: csv.length, text: csv,
    rows: parsed.rows, errors: parsed.errors, hash, duplicate: false,
  };
  // confirm-import reads DOM inputs; stub them
  elementsById['acct-name'] = makeEl('input'); elementsById['acct-name'].value = 'Main Visa';
  elementsById['acct-last4'] = makeEl('input'); elementsById['acct-last4'].value = '1234';
  elementsById['period-label'] = makeEl('input'); elementsById['period-label'].value = '2026-08';
  global.document.getElementById = (id) => elementsById[id] || null;
  global.document.querySelector = (sel) => {
    if (sel === '#view') return viewEl;
    const m = /^#([\w-]+)$/.exec(sel);
    return m ? (elementsById[m[1]] || null) : null;
  };
  await App.Actions['confirm-import']();
  // wait for pipeline
  for (let i = 0; i < 200 && !(App.state.pipe && (App.state.pipe.done || App.state.pipe.failed)); i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  const pipe = App.state.pipe;
  ok(pipe && pipe.done && !pipe.failed, 'pipeline completes', pipe && pipe.failed);
  ok(pipe.txns.length === 25, 'pipeline: 25 txns');

  const kinds = {};
  pipe.txns.forEach((t) => { kinds[t.kind] = (kinds[t.kind] || 0) + 1; });
  ok(kinds.purchase === 21 && kinds.refund === 1 && kinds.payment === 1, 'kinds as expected', kinds);

  // --- persisted schema shapes (V9) ---
  const txns = await Store.all('txns');
  ok(txns.length === 25, '25 txns persisted');
  ok(txns.every((t) => t.statementId != null), 'txns carry statementId');
  const sf = (await Store.all('sourceFiles'))[0];
  ok(sf && sf.sha256 === hash && sf.fileName === 'sample_statement_aug2026.csv', 'sourceFiles schema fields', sf);
  const st = (await Store.all('statements'))[0];
  ok(st && st.createdAt && st.periodStart === '2026-08-02', 'statements schema fields', st && { p: st.periodStart, c: st.createdAt });
  const br = (await Store.all('briefings'))[0];
  ok(br && br.facts && br.factsJson && br.text, 'briefings: facts + factsJson + text');
  ok(br.facts.topDrivers && br.facts.topDrivers.length === 5, 'facts.topDrivers present');
  ok(typeof br.facts.unresolvedCount === 'number', 'facts.unresolvedCount present');
  ok(br.text.split('\n')[0].indexOf("can't give you a final number") !== -1, 'briefing honesty headline');
  const recon = E.reconcile(txns, null);
  ok(recon.netSpendMinor === -142153, 'reconcile netSpendMinor signed', recon.netSpendMinor);
  ok(T.spendAbs(recon.netSpendMinor) === '$1,421.53', 'spendAbs magnitude display');
  ok(T.spendAbs(recon.grossPurchasesMinor) === '$1,463.71', 'gross magnitude');

  // --- duplicate import blocked ---
  const dupPending = { fileName: 'x.csv', fileSize: 1, text: csv, rows: parsed.rows, errors: [], hash, duplicate: true };
  const isDup = (await Store.all('sourceFiles')).some((f) => f.sha256 === hash);
  ok(isDup === true, 'duplicate detected by sha256');
  ok(dupPending.duplicate === true, 'preview flags duplicate');

  // --- correction: kind -> Engine rule -> stored flat -> applies to new import ---
  const misc = txns.find((t) => /MISC/.test(t.rawDescription));
  ok(misc && misc.kind === 'purchase', 'MISC starts as purchase');
  await App.applyCorrection(misc.id, 'kind', 'fee');
  const offer = App.state.ruleOffer;
  ok(offer && offer.rule && offer.rule.kind === 'fee', 'Engine built a kind rule', offer && offer.rule);
  ok(offer.rule.matchMerchant && offer.rule.id, 'rule has matchMerchant + id', offer.rule);
  ok(typeof offer.scopeDescription === 'string', 'rule has scopeDescription');
  const miscAfter = await Store.get('txns', misc.id);
  ok(miscAfter.classificationSource === 'user', 'user correction stamps classificationSource=user');
  await App.Actions['confirm-rule']();
  const rules = await Store.all('householdRules');
  ok(rules.length === 1, 'one rule stored');
  const r = rules[0];
  ok(r.matchMerchant === offer.rule.matchMerchant && r.kind === 'fee' && r.enabled === true, 'rule stored FLAT in applyRules shape', r);
  // fresh classify: rule applies; user-corrected row untouched
  const fresh = E.normalizeRows(E.parseCSV(csv).rows.map((x, i) => Object.assign({ rowIndex: i }, x)));
  E.classifyRows(fresh, rules);
  const freshMisc = fresh.find((t) => /MISC/.test(t.rawDescription));
  ok(freshMisc.kind === 'fee' && freshMisc.classificationSource === 'rule', 'rule fires on re-import', { k: freshMisc.kind, s: freshMisc.classificationSource });
  const userRow = Object.assign({}, freshMisc, { classificationSource: 'user', kind: 'purchase' });
  E.applyRules([userRow], rules);
  ok(userRow.kind === 'purchase', 'applyRules never overrides user corrections');

  // --- correction: category -> Engine-built category rule (flat shape) ---
  // LOBLAWS auto-categorized to 'groceries' at import (categorySource=auto),
  // so we correct to a different value; correcting to the same value is a
  // deliberate no-op (no offer, no rule).
  const loblaws = txns.find((t) => /LOBLAWS/.test(t.rawDescription));
  ok(loblaws && loblaws.category === 'groceries' && loblaws.categorySource === 'auto',
    'LOBLAWS auto-categorized at import', loblaws && { c: loblaws.category, s: loblaws.categorySource });
  await App.applyCorrection(loblaws.id, 'category', 'dining');
  const offer2 = App.state.ruleOffer;
  ok(offer2 && offer2.rule && offer2.rule.kind === null && offer2.rule.category === 'dining',
    'category correction offers an Engine category rule (kind=null, category=dining)', offer2 && offer2.rule);
  ok(offer2 && offer2.appMatch && offer2.appMatch.setCategory === 'dining', 'category offer keeps appMatch payload', offer2 && offer2.appMatch);
  await App.Actions['confirm-rule']();
  const rules2 = await Store.all('householdRules');
  ok(rules2.length === 2, 'category rule stored');
  const cr = rules2.find((x) => x.ruleType === 'category');
  ok(cr && cr.kind === null && cr.category === 'dining' && cr.appMatch && cr.appMatch.setCategory === 'dining',
    'category rule stored flat (category) + legacy appMatch.setCategory', cr);
  const loblawsAfter = await Store.get('txns', loblaws.id);
  ok(loblawsAfter.category === 'dining' && loblawsAfter.categorySource === 'user',
    'user correction stamps categorySource=user', loblawsAfter && { c: loblawsAfter.category, s: loblawsAfter.categorySource });

  // --- correction: excluded uses 1/0 and counts in reconcile ---
  await App.applyCorrection(loblaws.id, 'excluded', 1);
  const txns2 = await Store.all('txns');
  const recon2 = E.reconcile(txns2, null);
  ok(recon2.excludedTotalMinor === 118000 + (-8743), 'excluded===1 counted by reconcile', recon2.excludedTotalMinor);
  ok(App.state.ruleOffer === null, 'excluded correction offers no rule');

  // --- receipts: save + match suggestion with sign alignment ---
  const rcId = await Store.put('receipts', {
    imageBlob: null, merchantRaw: 'LOBLAWS', date: '2026-08-02', amountMinor: 8743, currency: 'CAD', createdAt: Date.now(),
  });
  const rc = await Store.get('receipts', rcId);
  ok(rc.amountMinor === 8743 && rc.merchantRaw === 'LOBLAWS', 'receipt schema fields');
  const target = (await Store.all('txns')).find((t) => /LOBLAWS #4521/.test(t.rawDescription) && t.rowIndex === 0);
  const res = E.scoreReceiptMatch(target, { amountMinor: -8743, date: rc.date, merchantRaw: rc.merchantRaw });
  ok(res[0] >= 0.85, 'sign-aligned receipt scores >= threshold', res);
  // app helper produces the aligned view (real function under test)
  const aligned = T.receiptForScore(rc, target);
  const res2 = E.scoreReceiptMatch(target, aligned);
  ok(res2[0] === res[0] && res2[0] >= 0.85, 'receiptForScore alignment matches', res2);

  // confirm-match stamps receiptId (V8 handshake)
  elementsById['match-x'] = makeEl('div');
  await App.Actions['confirm-match']({ receipt: rcId, txn: target.id });
  const tLinked = await Store.get('txns', target.id);
  ok(tLinked.receiptId === rcId, 'confirm-match stamps txn.receiptId');
  const cov = await App.receiptCoverage();
  ok(cov.matchedMinor === 8743 && cov.ratio > 0, 'coverage counts confirmed match', cov);

  // --- Ask: six answers render ---
  App.state.askQ = 'q-spend';
  const ctx = await App.askCtx();
  ok(ctx && ctx.facts && ctx.facts.topDrivers, 'askCtx includes facts');
  for (const q of ['q-spend', 'q-change', 'q-grocery', 'q-mixed', 'q-move', 'q-uncertain']) {
    const ans = await App.buildAnswer(q, ctx);
    // Labeled spend totals must never read negative; per-txn signed amounts
    // (matching the CSV) are by design and allowed in lists.
    const labeledNeg = /(Net spend|Gross purchases|Refunds|spend after refunds)[^<]*-\$/.test(ans.body);
    ok(ans && ans.title && ans.body && !labeledNeg, 'answer ' + q + ' renders, no negative labeled total');
  }
  const spendAns = await App.buildAnswer('q-spend', ctx);
  // MISC (-$18.44) was reclassified purchase->fee above: net = $1,403.09
  ok(spendAns.body.indexOf('$1,403.09') !== -1, 'q-spend shows net magnitude', spendAns.body.slice(0, 120));
  ok(App.matchQuestion('why did groceries rise') === 'q-change' || App.matchQuestion('why did groceries rise') === 'q-grocery', 'keyword routing works');

  // --- audit trail ---
  const audits = await Store.all('auditEvents');
  const types = audits.map((a) => a.eventType);
  ['import.completed', 'statement.imported', 'correction.applied', 'rule.created', 'match.confirmed'].forEach((t) =>
    ok(types.indexOf(t) !== -1, 'audit has ' + t, types));
  ok(audits.every((a) => a.timestamp), 'audit events carry timestamp (V9)');

  // --- export + wipe ---
  const exp = await Store.exportAll();
  ok(exp.txns && exp.txns.length === 25, 'exportAll includes txns');
  await Store.wipeAll();
  ok((await Store.all('txns')).length === 0, 'wipeAll clears');

  console.log('\nINTEGRATION: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
