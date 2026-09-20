/* Auto-categorization + Month-aggregate tests: real engine.js + app.js with an
   in-memory Store shim and a minimal DOM stub. No network. Run with node.
   Covers Problem A (on-device auto-categorization: keyword ordering,
   confidence threshold, household-rule precedence, user immunity) and
   Problem B (Month tab as a calendar-month aggregate: monthsWithData,
   txnsInMonth date-prefix selection, statement coverage notes,
   previous-month delta math, per-account breakdown sums). */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'apps/web/js');

/* ---------- minimal DOM stub (same shape as tests/e2e.node.js) ---------- */
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

/* ---------- in-memory Store shim ---------- */
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
  async delete(store, id) { const t = memDB[store] || {}; delete t[String(id)]; },
  async clear(store) { memDB[store] = {}; },
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

function txn(id, statementId, date, amountMinor, merchantRaw, kind) {
  return {
    id, statementId, date, amountMinor, merchantRaw, kind,
    classificationSource: 'import', category: '', categorySource: null,
    excluded: 0, status: 'new', confidence: 'ok',
  };
}

async function main() {
  /* ================= Problem A: on-device auto-categorization ================= */

  // --- keyword conflict ordering: specific phrases beat generic merchants ---
  const conflicts = [
    ['COSTCO GAS BAR #4421', 'transport'],
    ['COSTCO WHOLESALE #118', 'groceries'],
    ['UBER EATS HELP', 'dining'],
    ['UBER TRIP 4XJ2', 'transport'],
    ['CANADIAN TIRE GAS BAR', 'transport'],
    ['CANADIAN TIRE #88', 'household'],
  ];
  const sugOf = (desc) => E.suggestCategory(txn('t', 's1', '2026-08-10', 5000, desc, 'purchase'));
  conflicts.forEach(([desc, expected]) => {
    const s = sugOf(desc);
    ok(s && s.categoryId === expected, 'conflict ordering: "' + desc + '" -> ' + expected, s);
  });

  // --- more spot checks ---
  ok(sugOf('LOBLAWS #1024').categoryId === 'groceries', 'LOBLAWS -> groceries');
  ok(sugOf('STARBUCKS STORE 551').categoryId === 'dining', 'STARBUCKS -> dining');
  ok(sugOf('PRESTO CARD LOAD').categoryId === 'transport', 'PRESTO -> transport');

  // --- real statement merchants seen in the wild (statement truncates /
  // punctuates names: 'SUPERSTO' for SUPERSTORE, 'WAL-MART', 'SQ *' prefix) ---
  const wild = [
    ['REAL CANADIAN SUPERSTO WHITBY ON', 'groceries'],   // truncated print
    ['REAL CANADIAN SUPERSTORE #1234', 'groceries'],
    ['ENERCARE HOME SERVICES MARKHAM ON', 'household'],
    ['KFC #1377 AJAX ON', 'dining'],
    ['WAL-MART #3001 AJAX ON', 'shopping'],              // hyphen variant
    ['WALMART SUPERCENTER', 'shopping'],
    ['AJAX IQBAL FOODS AJAX ON', 'groceries'],
    ['SQ *ICE CREAMONOLOGY TORONTO ON', 'dining'],       // Square prefix
    ['SAVE-ON-FOODS #9921', 'groceries'],                // hyphen variant
    ['POPEYES LOUISIANA KITCHEN', 'dining'],
  ];
  wild.forEach(([desc, expected]) => {
    const s = sugOf(desc);
    ok(s && s.categoryId === expected && s.confidence >= 0.6,
      'wild merchant "' + desc + '" -> ' + expected, s);
  });
  ok(sugOf('SQ *NIKITA FENG TORONTO ON') === null,
    'unknown small business stays blank (never guessed)');

  // --- fee kind, payment/transfer, unknown merchant, non-spend kinds ---
  ok(sugOf('ANNUAL FEE').categoryId === 'fees', 'fee kind -> fees');
  ok(E.suggestCategory(txn('t', 's1', '2026-08-10', 5000, 'COSTCO', 'payment')) === null, 'payment -> null');
  ok(E.suggestCategory(txn('t', 's1', '2026-08-10', 5000, 'COSTCO', 'transfer')) === null, 'transfer -> null');
  ok(E.suggestCategory(txn('t', 's1', '2026-08-10', 5000, 'ZZZQ MYSTERY SHOP 9', 'purchase')) === null, 'unknown merchant -> null (blank, never guessed)');
  ok(E.suggestCategory(txn('t', 's1', '2026-08-10', 5000, 'COSTCO', 'uncertain')) === null, 'uncertain kind -> null');

  // --- confidence threshold: built-in suggestions apply only at >= 0.6 ---
  const realSuggest = E.suggestCategory;
  E.suggestCategory = () => ({ categoryId: 'dining', confidence: 0.55, reason: 'stub' });
  let rows = [txn('r1', 's1', '2026-08-10', 4200, 'SOME CAFE', 'purchase')];
  E.autoCategorize(rows, []);
  ok(rows[0].category === '' && rows[0].categorySource == null, '0.55 confidence suggestion NOT applied (threshold 0.6)', rows[0]);
  E.suggestCategory = () => ({ categoryId: 'dining', confidence: 0.65, reason: 'stub' });
  rows = [txn('r2', 's1', '2026-08-10', 4200, 'SOME CAFE', 'purchase')];
  E.autoCategorize(rows, []);
  ok(rows[0].category === 'dining' && rows[0].categorySource === 'auto' && rows[0].categoryConfidence === 0.65,
    '0.65 confidence suggestion applied as auto', rows[0]);
  E.suggestCategory = realSuggest;

  // --- household category rule beats the built-in suggestion ---
  rows = [txn('r3', 's1', '2026-08-10', 9000, 'COSTCO WHOLESALE #118', 'purchase')];
  E.autoCategorize(rows, [{ id: 'r-costco', enabled: true, priority: 100, matchMerchant: 'COSTCO', kind: null, category: 'dining', label: 'rule' }]);
  ok(rows[0].category === 'dining' && rows[0].categorySource === 'rule' && rows[0].categoryConfidence === 1.0,
    'household rule category wins over built-in', rows[0]);
  // legacy appMatch.setCategory rules are honored too
  rows = [txn('r4', 's1', '2026-08-10', 9000, 'COSTCO WHOLESALE #118', 'purchase')];
  E.autoCategorize(rows, [{ id: 'r-old', enabled: true, matchMerchant: 'COSTCO', kind: null, appMatch: { setCategory: 'dining' } }]);
  ok(rows[0].category === 'dining' && rows[0].categorySource === 'rule', 'legacy appMatch.setCategory rule honored', rows[0]);
  // disabled rules never fire
  rows = [txn('r5', 's1', '2026-08-10', 9000, 'COSTCO WHOLESALE #118', 'purchase')];
  E.autoCategorize(rows, [{ id: 'r-off', enabled: false, matchMerchant: 'COSTCO', kind: null, category: 'dining' }]);
  ok(rows[0].category === 'groceries' && rows[0].categorySource === 'auto', 'disabled rule ignored (falls back to built-in)', rows[0]);

  // --- user corrections are never overwritten (backfill-safe) ---
  const userKind = txn('u1', 's1', '2026-08-10', 9000, 'COSTCO WHOLESALE #118', 'purchase');
  userKind.classificationSource = 'user'; // user corrected the KIND
  const userCat = txn('u2', 's1', '2026-08-10', 9000, 'COSTCO WHOLESALE #118', 'purchase');
  userCat.category = 'dining'; userCat.categorySource = 'user'; // user set the CATEGORY
  const plain = txn('u3', 's1', '2026-08-10', 9000, 'COSTCO WHOLESALE #118', 'purchase');
  E.autoCategorize([userKind, userCat, plain], [{ id: 'r-c', enabled: true, matchMerchant: 'COSTCO', kind: null, category: 'transport', label: 'rule' }]);
  ok(userKind.category === '', 'classificationSource=user row untouched');
  ok(userCat.category === 'dining' && userCat.categorySource === 'user', 'categorySource=user row untouched (backfill-safe)');
  ok(plain.category === 'transport' && plain.categorySource === 'rule', 'non-user row still categorized by rule');
  // user immunity holds with no rules at all
  const userCat2 = txn('u4', 's1', '2026-08-10', 3100, 'STARBUCKS', 'purchase');
  userCat2.category = 'dining'; userCat2.categorySource = 'user';
  E.autoCategorize([userCat2], []);
  ok(userCat2.category === 'dining', 'user category survives empty backfill', userCat2);

  // --- needsCategory: uncategorized spend rows belong in the review queue ---
  ok(T.needsCategory(txn('n1', 's1', '2026-08-10', 5000, 'X', 'purchase')) === true, 'blank purchase needs category');
  ok(T.needsCategory(txn('n2', 's1', '2026-08-10', -1500, 'X', 'refund')) === true, 'blank refund needs category');
  const hasCat = txn('n3', 's1', '2026-08-10', 5000, 'X', 'purchase'); hasCat.category = 'groceries';
  ok(T.needsCategory(hasCat) === false, 'categorized purchase does not need category');
  const legacyCat = txn('n3b', 's1', '2026-08-10', 5000, 'X', 'purchase'); legacyCat.categoryId = 'groceries';
  ok(T.needsCategory(legacyCat) === false, 'legacy categoryId honored');
  ok(T.needsCategory(txn('n4', 's1', '2026-08-10', 5000, 'X', 'payment')) === false, 'payment never needs category');
  ok(T.needsCategory(txn('n5', 's1', '2026-08-10', 5000, 'X', 'uncertain')) === false, 'uncertain kind not a category task');
  const excl = txn('n6', 's1', '2026-08-10', 5000, 'X', 'purchase'); excl.excluded = 1;
  ok(T.needsCategory(excl) === false, 'excluded row not flagged');
  const dup = txn('n7', 's1', '2026-08-10', 5000, 'X', 'purchase'); dup.status = 'duplicate';
  ok(T.needsCategory(dup) === false, 'duplicate row not flagged');

  /* ================= Problem B: Month as calendar-month aggregate ================= */

  // Two statements; statement B's period is entirely in September but has
  // an August-dated row (periods span month boundaries — date prefix wins).
  const stA = { id: 'stA', periodStart: '2026-08-01', periodEnd: '2026-08-31', scopeLabel: 'Visa ••1234' };
  const stB = { id: 'stB', periodStart: '2026-09-01', periodEnd: '2026-09-30', scopeLabel: 'MC ••5678' };
  const allTxns = [
    txn('a1', 'stA', '2026-08-05', 5000, 'LOBLAWS', 'purchase'),
    txn('a2', 'stA', '2026-08-28', 3000, 'STARBUCKS', 'purchase'),
    txn('a3', 'stA', '2026-09-02', 1000, 'LOBLAWS', 'purchase'),      // September, not in Aug
    txn('b1', 'stB', '2026-08-15', -1500, 'LOBLAWS', 'refund'),
    txn('b2', 'stB', '2026-08-31', 2500, 'COSTCO GAS', 'purchase'),  // boundary day
    txn('b3', 'stB', '2026-07-30', 2000, 'STARBUCKS', 'purchase'),   // July, not in Aug
  ];
  allTxns.forEach((t) => { t.category = 'groceries'; }); // categorize so deltas are per-category

  // --- monthsWithData / latestTxnMonth / txnsInMonth ---
  ok(JSON.stringify(T.monthsWithData(allTxns)) === JSON.stringify(['2026-07', '2026-08', '2026-09']), 'monthsWithData sorted unique', T.monthsWithData(allTxns));
  ok(T.latestTxnMonth(allTxns) === '2026-09', 'latestTxnMonth');
  ok(T.latestTxnMonth([]) === null, 'latestTxnMonth null on empty');
  const aug = T.txnsInMonth(allTxns, '2026-08');
  ok(aug.length === 4, 'date-prefix selection: 4 August rows', aug.map((t) => t.id));
  ok(aug.every((t) => t.date.indexOf('2026-08') === 0), 'all selected rows dated in August');
  ok(aug.some((t) => t.id === 'b2'), 'boundary 2026-08-31 included');
  ok(!aug.some((t) => t.id === 'a3' || t.id === 'b3'), 'out-of-month rows excluded even from contributing statements');

  // --- statementCoverage ---
  ok(T.statementCoverage(stA, '2026-08') === 'full', 'stA covers August fully');
  ok(T.statementCoverage(stB, '2026-08') === 'outside', 'stB period outside August (but has Aug-dated rows)');
  const partSt = { id: 'stP', periodStart: '2026-07-20', periodEnd: '2026-08-18' };
  ok(T.statementCoverage(partSt, '2026-08') === 'partial', 'partial coverage detected');
  ok(T.statementCoverage({ id: 'stU' }, '2026-08') === 'unknown', 'missing period -> unknown (never guessed)');
  ok(T.statementCoverage({ id: 'stM', periodStart: 'garbage', periodEnd: '2026-08-31' }, '2026-08') === 'unknown', 'malformed period -> unknown');

  // --- aggregate reconcile == sum of per-account reconciles (additive) ---
  const rec = (rows) => E.reconcile(rows, null);
  const agg = rec(aug);
  const netA = rec(aug.filter((t) => t.statementId === 'stA')).netSpendMinor;
  const netB = rec(aug.filter((t) => t.statementId === 'stB')).netSpendMinor;
  ok(netA + netB === agg.netSpendMinor, 'per-account nets sum to the month aggregate', { netA, netB, agg: agg.netSpendMinor });
  ok(Number.isInteger(agg.netSpendMinor) && Number.isInteger(agg.grossPurchasesMinor), 'money stays in integer minor units');

  // --- previous-month delta math via buildBriefing (across statements) ---
  const jul = T.txnsInMonth(allTxns, '2026-07');
  const facts = E.buildBriefing(aug, '2026-08-01', '2026-08-31', jul.length ? jul : null, 'August 2026', null);
  ok(facts && Array.isArray(facts.deltas), 'buildBriefing returns deltas for the month aggregate');
  const gDelta = facts.deltas.find((d) => d.category === 'groceries');
  // August groceries: 5000 + 3000 + 2500 (purchases) - 1500 (refund, signed
  // into the category total) = 9000; July: 2000 -> delta 7000.
  ok(gDelta && gDelta.deltaMinor === 7000, 'previous-month delta math across statements', gDelta);
  const noPrev = E.buildBriefing(jul, '2026-07-01', '2026-07-31', null, 'July 2026', null);
  ok(noPrev && noPrev.deltas.length === 0, 'no previous month -> no deltas, no crash');

  // --- reviewTxns: deduplicated review rows (Problem B "Needs your review") ---
  const rq1 = txn('q1', 's1', '2026-08-10', 5000, 'MISC', 'purchase'); rq1.confidence = 'needs_review'; // uncategorized + needs_review: ONE row, not two
  const rq2 = txn('q2', 's1', '2026-08-11', 5000, 'LOBLAWS', 'purchase'); rq2.confidence = 'needs_review'; rq2.category = 'groceries'; // categorized + needs_review
  const rq3 = txn('q3', 's1', '2026-08-12', 5000, 'X', 'uncertain'); // uncertain kind
  const rq4 = txn('q4', 's1', '2026-08-13', 5000, 'X', 'payment'); rq4.confidence = 'likely'; // confident payment: not a review row
  ok(T.reviewTxns([rq1, rq2, rq3, rq4]).length === 3, 'reviewTxns dedupes the uncategorized+needs_review row', T.reviewTxns([rq1, rq2, rq3, rq4]).map((t) => t.id));
  ok(T.reviewTxns([rq4]).length === 0, 'confident payment is not a review row');
  ok(T.reviewTxns([]).length === 0, 'reviewTxns handles empty list');

  // --- review list: "Needs a category" section renders for uncertain-tabbed
  // uncategorized rows, with no double-listing ---
  App._stmtTxns = [rq1, rq2, rq3, rq4];
  App.state.dataRev = (App.state.dataRev || 0) + 1; App.state.statementId = 's1';
  const reviewHtml = App.txnListHtml([rq1, rq2, rq3, rq4], 'review', {}, 100);
  ok(reviewHtml.indexOf('Needs a category') !== -1, '"Needs a category" section visible even when the row is kind-uncertain');
  const miscHits = (reviewHtml.match(/MISC/g) || []).length;
  ok(miscHits === 1, 'uncategorized row listed exactly once (not duplicated across sections)', miscHits);
  const loblawsHits = (reviewHtml.match(/LOBLAWS/g) || []).length;
  ok(loblawsHits === 1, 'categorized uncertain row still listed once', loblawsHits);
  const emptyHtml = App.txnListHtml([rq4], 'review', {}, 100);
  ok(emptyHtml.indexOf('Nothing needs review') !== -1, 'empty review queue renders the all-clear');

  // --- receiptCoverageFor: month-scoped evidence quality ---
  const covTxns = [
    txn('c1', 'stA', '2026-08-05', 10000, 'LOBLAWS', 'purchase'),
    txn('c2', 'stA', '2026-08-06', 5000, 'STARBUCKS', 'purchase'),
    txn('c3', 'stA', '2026-09-02', 9000, 'LOBLAWS', 'purchase'),
  ];
  const cov = App.coverageOfTxns(covTxns.filter((t) => t.date.indexOf('2026-08') === 0), []);
  ok(cov.grossMinor === 15000 && cov.ratio === 0, 'month-scoped coverage math (no matches yet)', cov);
  const covM = App.coverageOfTxns(covTxns.filter((t) => t.date.indexOf('2026-08') === 0), [{ txnId: 'c1', status: 'confirmed' }]);
  ok(covM.matchedMinor === 10000 && Math.abs(covM.ratio - 10000 / 15000) < 1e-9, 'confirmed match raises month coverage', covM);
  const covOut = App.coverageOfTxns(covTxns.filter((t) => t.date.indexOf('2026-08') === 0), [{ txnId: 'c3', status: 'confirmed' }]);
  ok(covOut.matchedMinor === 0, 'match on an out-of-month txn does not leak into the month', covOut);

  // --- renderBriefingText works on the month aggregate facts ---
  const text = E.renderBriefingText(facts);
  ok(typeof text === 'string' && text.length > 0 && text.indexOf('August 2026') !== -1, 'briefing text renders for the month aggregate');

  console.log('\nAUTO-CAT/MONTH: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('HARNESS ERROR', e); process.exit(1); });
