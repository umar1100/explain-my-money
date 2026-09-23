/* Canonical spend tests (v16/v17): one computation for every sign convention.
   Rows reach the ledger in two conventions:
     PDF imports (PC/CIBC): purchases positive, refunds negative ('pdf-card')
     CSV imports / manual Add rows: purchases negative, refunds positive ('csv')
   v17: every row carries its signConvention stamp (import-time provenance);
   a purchase-kind row whose stored sign contradicts its convention is a
   statement credit and reduces spend instead of adding to it.
   Every spend computation must go through Engine.canonicalSpendMinor so all
   views agree. Covers: canonicalSpendMinor shapes, reconcile identical
   across conventions, payments/transfers/fees never spend, excludedTotal
   magnitudes, return attribution with CSV-convention refunds, split-aware
   totals, coverageOfTxns == reconcile gross, briefing text magnitudes.
   All merchants are fictional. Run with node. */
'use strict';
const path = require('path');
const WEB = path.join(__dirname, '..', 'apps/web/js');
global.window = global;
require(WEB + '/engine.js');
const E = global.Engine;
if (!E) { console.error('FAIL: Engine missing'); process.exit(1); }

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; }
  else { fail++; console.error('FAIL:', name, extra === undefined ? '' : JSON.stringify(extra)); }
}

function row(id, o) {
  // v17: rows carry their signConvention stamp; the default is 'pdf-card'
  // (the validated-template path), mirroring the engine default.
  const r = Object.assign({
    id: id, merchantRaw: 'FRESHCART MARKET', amountMinor: 100,
    kind: 'purchase', category: 'groceries', date: '2026-06-10', statementId: 'st-1',
    excluded: 0, status: 'active', signConvention: 'pdf-card'
  }, o);
  if (r.signedAmountMinor === undefined) r.signedAmountMinor = r.amountMinor;
  return r;
}

/* ---------- canonicalSpendMinor shapes ---------- */
ok(E.canonicalSpendMinor(row('a', { amountMinor: 10000, kind: 'purchase' })) === 10000, 'PDF purchase +10000 -> +10000');
ok(E.canonicalSpendMinor(row('b', { amountMinor: -10000, kind: 'purchase', signConvention: 'csv' })) === 10000, 'CSV purchase -10000 -> +10000');
ok(E.canonicalSpendMinor(row('c', { amountMinor: -10000, spendAmountMinor: 10000, kind: 'purchase', signConvention: 'csv' })) === 10000,
  'manual purchase (amountMinor -10000, spendAmountMinor +10000) -> +10000');
ok(E.canonicalSpendMinor(row('d', { amountMinor: -1500, kind: 'refund' })) === -1500, 'PDF refund -1500 -> -1500');
ok(E.canonicalSpendMinor(row('e', { amountMinor: 1500, kind: 'refund', signConvention: 'csv' })) === -1500, 'CSV refund +1500 -> -1500');
ok(E.canonicalSpendMinor(row('f', { amountMinor: 1500, spendAmountMinor: 1500, kind: 'refund' })) === -1500,
  'manual refund -> -1500');
ok(E.canonicalSpendMinor(row('g', { amountMinor: -12000, kind: 'payment' })) === 0, 'payment never spend');
ok(E.canonicalSpendMinor(row('h', { amountMinor: -12000, kind: 'transfer' })) === 0, 'transfer never spend');
ok(E.canonicalSpendMinor(row('i', { amountMinor: -1200, kind: 'fee' })) === 0, 'fee never spend');
ok(E.canonicalSpendMinor(row('j', { amountMinor: -5000, kind: 'cash_advance' })) === 0, 'cash_advance never spend');
ok(E.canonicalSpendMinor(row('k', { amountMinor: 999, kind: 'uncertain' })) === 0, 'uncertain never spend');
ok(E.canonicalSpendMinor(row('l', { amountMinor: 10000, kind: 'purchase', excluded: 1 })) === 0, 'excluded purchase -> 0');
ok(E.canonicalSpendMinor(row('m', { amountMinor: 10000, kind: 'purchase', status: 'duplicate' })) === 0, 'duplicate -> 0');
ok(E.canonicalSpendMinor(row('n', { amountMinor: 10000, kind: 'purchase', excluded: true })) === 0, 'boolean excluded -> 0');
ok(E.canonicalSpendMinor(row('o', { amountMinor: null, kind: 'purchase' })) === 0, 'null amount -> 0');
ok(E.canonicalSpendMinor(null) === 0, 'null row -> 0');

/* ---------- reconcile: identical across conventions ---------- */
// Same logical ledger, stored PDF-style...
const pdfLedger = [
  row('p1', { amountMinor: 10000, spendAmountMinor: 10000 }),
  row('p2', { amountMinor: 5000, spendAmountMinor: 5000 }),
  row('r1', { amountMinor: -1500, spendAmountMinor: -1500, kind: 'refund', merchantRaw: 'COSTCO REFUND' }),
  row('pay', { amountMinor: -12000, spendAmountMinor: 0, kind: 'payment', excluded: 1, merchantRaw: 'PAYMENT RECEIVED' }),
  row('xf', { amountMinor: -3000, spendAmountMinor: 0, kind: 'transfer', excluded: 1, merchantRaw: 'E-TRANSFER' }),
  row('fee', { amountMinor: -1200, spendAmountMinor: 0, kind: 'fee', excluded: 1, merchantRaw: 'ANNUAL FEE' }),
];
// ...and CSV/manual-style (purchases negative, refunds positive).
const csvLedger = [
  row('p1', { amountMinor: -10000, spendAmountMinor: -10000, signConvention: 'csv' }),
  row('p2', { amountMinor: -5000, spendAmountMinor: -5000, signConvention: 'csv' }),
  row('r1', { amountMinor: 1500, spendAmountMinor: 1500, kind: 'refund', merchantRaw: 'COSTCO REFUND', signConvention: 'csv' }),
  row('pay', { amountMinor: 12000, spendAmountMinor: 0, kind: 'payment', excluded: 1, merchantRaw: 'PAYMENT RECEIVED', signConvention: 'csv' }),
  row('xf', { amountMinor: 3000, spendAmountMinor: 0, kind: 'transfer', excluded: 1, merchantRaw: 'E-TRANSFER', signConvention: 'csv' }),
  row('fee', { amountMinor: 1200, spendAmountMinor: 0, kind: 'fee', excluded: 1, merchantRaw: 'ANNUAL FEE', signConvention: 'csv' }),
];
// ...and a hostile mix of both.
const mixedLedger = [pdfLedger[0], csvLedger[1], csvLedger[2], pdfLedger[3], csvLedger[4], pdfLedger[5]];

for (const [name, ledger] of [['pdf', pdfLedger], ['csv', csvLedger], ['mixed', mixedLedger]]) {
  const r = E.reconcile(ledger, null);
  ok(r.grossPurchasesMinor === 15000, name + ': gross = 15000', r.grossPurchasesMinor);
  ok(r.refundsTotalMinor === 1500, name + ': refunds = 1500', r.refundsTotalMinor);
  ok(r.refundsTotalMinor >= 0, name + ': refunds never negative', r.refundsTotalMinor);
  ok(r.netSpendMinor === 13500, name + ': net = 15000 - 1500', r.netSpendMinor);
  ok(r.refundCount === 1, name + ': one refund counted', r.refundCount);
}
// The old signed-sum math diverged on the mixed ledger (this is the v16 bug):
const rawSignedGross = mixedLedger
  .filter((t) => t.kind === 'purchase' && !t.excluded && t.status !== 'duplicate')
  .reduce((s, t) => s + t.amountMinor, 0);
ok(rawSignedGross !== 15000, 'raw signed sums diverge on mixed conventions (the v16 bug)', rawSignedGross);

/* ---------- excludedTotalMinor: magnitudes left out ---------- */
const xr = E.reconcile([
  row('x1', { amountMinor: 3000, kind: 'purchase', excluded: 1 }),
  row('x2', { amountMinor: -4000, kind: 'purchase', excluded: 1 }),
  row('x3', { amountMinor: 800, kind: 'refund', excluded: 1 }),
  row('x4', { amountMinor: -9000, kind: 'payment', excluded: 1 }),
], null);
ok(xr.excludedTotalMinor === 3000 + 4000 + 800 + 9000, 'excludedTotal = printed magnitudes left out', xr.excludedTotalMinor);
ok(xr.grossPurchasesMinor === 0 && xr.netSpendMinor === 0, 'all-excluded ledger spends nothing');

/* ---------- return attribution with CSV-convention refunds ---------- */
const may = [
  row('mp', { id: 'mp', amountMinor: -99900, kind: 'purchase', category: 'shopping', date: '2026-05-20', merchantRaw: 'BIGBOX STORE', signConvention: 'csv' }),
];
const jun = [
  row('jp', { id: 'jp', amountMinor: -50000, kind: 'purchase', category: 'groceries', date: '2026-06-05', signConvention: 'csv' }),
  // Refund received in June for the May purchase, stored CSV-style (positive).
  row('jr', { id: 'jr', amountMinor: 99900, kind: 'refund', category: 'shopping', date: '2026-06-18', merchantRaw: 'BIGBOX STORE', signConvention: 'csv' }),
];
const links = [{ refundTxnId: 'jr', purchaseTxnId: 'mp', status: 'confirmed' }];
const moves = E.refundMoves(may.concat(jun), links);
ok(moves.length === 1 && moves[0].amountMinor === -99900, 'refund move carries canonical negative amount', moves[0] && moves[0].amountMinor);
const adjJun = E.returnAdjustment(may.concat(jun), links, '2026-06');
ok(adjJun && adjJun.deltaMinor === 99900, 'June net RISES by the moved-out refund (CSV convention)', adjJun && adjJun.deltaMinor);
const adjMay = E.returnAdjustment(may.concat(jun), links, '2026-05');
ok(adjMay && adjMay.deltaMinor === -99900, 'May net FALLS by the attributed return', adjMay && adjMay.deltaMinor);
const monthly = E.monthlyNetSpend(may.concat(jun), links);
const mJun = monthly.find((m) => m.month === '2026-06'), mMay = monthly.find((m) => m.month === '2026-05');
ok(mJun && mJun.netMinor === 50000, 'June attributed net = 50000 (refund moved out)', mJun && mJun.netMinor);
ok(mMay && mMay.netMinor === 0, 'May attributed net = 99900 - 99900 = 0', mMay && mMay.netMinor);

/* ---------- split-aware totals use magnitudes ---------- */
// NOTE: the app stores splits as positive magnitudes summing to |spend|
// (the split editor enforces this); canonical math absorbs them via Math.abs.
const splitTxn = row('s1', { amountMinor: -100000, kind: 'purchase', category: '', date: '2026-06-12', signConvention: 'csv',
  splits: [{ category: 'groceries', amountMinor: 60000 }, { category: 'household', amountMinor: 40000 }] });
const st = E.splitAwareCategoryTotals([splitTxn], '2026-06');
ok(st.groceries === 60000 && st.household === 40000, 'split shares count as magnitudes', st);
const tbc = E.totalsByCategory([splitTxn]);
ok(tbc.totals.groceries === 60000 && tbc.totals.household === 40000, 'totalsByCategory splits canonical', tbc.totals);
const members = E.categoryMembers([splitTxn], 'groceries');
ok(members.length === 1 && members[0].shareMinor === 60000, 'categoryMembers share canonical positive', members[0] && members[0].shareMinor);

/* ---------- coverageOfTxns denominator == reconcile gross ---------- */
const covLedger = pdfLedger.concat(csvLedger.map((t) => Object.assign({}, t, { id: t.id + '-b' })));
const cov = E.coverageOfTxns(covLedger, []);
const recAll = E.reconcile(covLedger, null);
ok(cov.grossMinor === recAll.grossPurchasesMinor, 'coverage denominator == reconcile gross', { c: cov.grossMinor, r: recAll.grossPurchasesMinor });
ok(cov.grossMinor === 30000, 'coverage gross = 2 x 15000', cov.grossMinor);

/* ---------- briefing text: magnitudes only ---------- */
const brief = E.buildBriefing(mixedLedger, '2026-06-01', '2026-06-30', null, 'June 2026', null);
const text = E.renderBriefingText(brief);
ok(text.indexOf('-$') === -1, 'briefing text never prints -$', text.split('\n')[0]);
ok(text.indexOf('You spent $135.00 in June 2026') !== -1, 'briefing headline magnitude', text.split('\n')[0]);
ok(text.indexOf('after $15.00 in refunds') !== -1, 'briefing refunds magnitude', text.split('\n')[0]);
ok(text.indexOf('Gross purchases before money back: $150.00') !== -1, 'briefing gross magnitude');
ok(E.fmtMoneyAbs(-123456) === '$1,234.56', 'fmtMoneyAbs', E.fmtMoneyAbs(-123456));

/* ---------- splitAwareNetCategoryTotals: movers compare bar figures ---------- */
const netTxns = [
  row('n1', { amountMinor: -100000, kind: 'purchase', category: 'groceries', date: '2026-06-05', signConvention: 'csv' }),
  row('n2', { amountMinor: 30000, kind: 'refund', category: 'groceries', date: '2026-06-20', signConvention: 'csv' }),
  row('n3', { amountMinor: -50000, kind: 'purchase', category: 'dining', date: '2026-06-08', signConvention: 'csv' }),
];
const netT = E.splitAwareNetCategoryTotals(netTxns, '2026-06');
ok(netT.groceries === 70000, 'net category total nets refunds (100000 - 30000)', netT.groceries);
ok(netT.dining === 50000, 'purchase-only category', netT.dining);
const barT = E.totalsByCategory(netTxns).totals;
ok(netT.groceries === barT.groceries && netT.dining === barT.dining, 'movers math == bar math (one computation)');

console.log('\nCANONICAL-SPEND-V16: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
