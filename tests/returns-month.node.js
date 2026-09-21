/* Return-attribution + NOFR regression tests: real engine.js, no network.
   Covers:
   - NOFR (No Frills statement abbreviation) auto-categorizes to groceries.
   - Same-statement refunds net against gross purchases (reconcile).
   - Cross-month refund links attribute the return to the purchase's month
     (monthlyNetSpend + returnAdjustment); same-month/rejected links change
     nothing. Run with node. */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'apps/web/js');

global.window = global;
require(WEB + '/engine.js');
const E = global.Engine;
if (!E) { console.error('FAIL: Engine did not load'); process.exit(1); }

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; }
  else { fail++; console.error('FAIL:', name, extra === undefined ? '' : JSON.stringify(extra)); }
}

function row(id, date, amountMinor, merchantRaw, kind) {
  return { id: id, date: date, amountMinor: amountMinor, merchantRaw: merchantRaw,
           kind: kind, excluded: 0, confidence: 'likely' };
}

/* ---------- 1. NOFR keyword gap ---------- */
const nofr = E.suggestCategory(row('t1', '2026-08-17', 1865, "JEROME & ALISHA'S NOFR AJAX ON", 'purchase'));
ok(nofr && nofr.categoryId === 'groceries', 'NOFR abbreviation suggests groceries', nofr);
ok(nofr && nofr.confidence >= 0.6, 'NOFR suggestion meets auto-categorize threshold', nofr);

const rows1 = [row('t1', '2026-08-17', 1865, "JEROME & ALISHA'S NOFR AJAX ON", 'purchase')];
E.autoCategorize(rows1, []);
ok(rows1[0].category === 'groceries' && rows1[0].categorySource === 'auto',
   'autoCategorize stamps NOFR row as groceries', { category: rows1[0].category, src: rows1[0].categorySource });

/* ---------- 1b. RCSS / Domino's / Bonduc keyword gaps (user-reported) ---------- */
const rcss = E.suggestCategory(row('t2', '2026-08-21', 2600, 'RCSS #1012 AJAX ON', 'purchase'));
ok(rcss && rcss.categoryId === 'groceries', 'RCSS (Real Canadian Superstore) suggests groceries', rcss);
ok(rcss && rcss.confidence >= 0.6, 'RCSS suggestion meets auto-categorize threshold', rcss);

const dom = E.suggestCategory(row('t3', '2026-08-28', 2032, 'DOMINOS PIZZA #10566 AJAX ON', 'purchase'));
ok(dom && dom.categoryId === 'dining', 'DOMINOS PIZZA suggests dining', dom);
const domApos = E.suggestCategory(row('t4', '2026-08-28', 1129, "DOMINO'S PIZZA 10360 AJAX ON", 'purchase'));
ok(domApos && domApos.categoryId === 'dining', "DOMINO'S (apostrophe variant) suggests dining", domApos);

const bon = E.suggestCategory(row('t5', '2026-08-16', 1031, 'BONDUC MISSISSAUGA ON', 'purchase'));
ok(bon && bon.categoryId === 'dining', 'BONDUC (verified coffee shop) suggests dining', bon);

const rows1b = [
  row('t2', '2026-08-21', 2600, 'RCSS #1012 AJAX ON', 'purchase'),
  row('t3', '2026-08-28', 2032, 'DOMINOS PIZZA #10566 AJAX ON', 'purchase'),
  row('t5', '2026-08-16', 1031, 'BONDUC MISSISSAUGA ON', 'purchase'),
];
E.autoCategorize(rows1b, []);
ok(rows1b[0].category === 'groceries' && rows1b[1].category === 'dining' && rows1b[2].category === 'dining',
   'autoCategorize stamps RCSS/Dominos/Bonduc rows', rows1b.map(function (r) { return r.category; }));
// Unverifiable merchants stay blank (never guess): domain registrar, unknown kids site.
const nc = E.suggestCategory(row('t6', '2026-08-14', 1643, 'NAME-CHEAP.COM* 4HEEEJQ PHOENIX AZ USD', 'purchase'));
ok(nc === null, 'NAME-CHEAP.COM (domain registrar) suggests nothing', nc);
const rk = E.suggestCategory(row('t7', '2026-08-25', 3400, 'READKIDZ.COM WESTCLIFFE CO', 'purchase'));
ok(rk === null, 'READKIDZ.COM (no matching category) suggests nothing', rk);

/* ---------- 2. Same-statement refund netting ---------- */
const recon = E.reconcile([
  row('p1', '2026-08-10', 10000, 'LOBLAWS', 'purchase'),
  row('r1', '2026-08-17', -1865, "JEROME & ALISHA'S NOFR AJAX ON", 'refund'),
], null);
ok(recon.grossPurchasesMinor === 10000, 'gross purchases = 10000', recon.grossPurchasesMinor);
ok(recon.refundsTotalMinor === 1865, 'refunds total = 1865 magnitude', recon.refundsTotalMinor);
ok(recon.netSpendMinor === 8135, 'net spend = gross - refunds', recon.netSpendMinor);

/* ---------- 3. Cross-month return attribution ---------- */
const augBuy = row('p1', '2026-08-10', 5000, 'CANADIAN TIRE #88', 'purchase');
const sepRefund = row('r1', '2026-09-05', -5000, 'CANADIAN TIRE #88', 'refund');
const txns = [augBuy, sepRefund];
const link = { refundTxnId: 'r1', purchaseTxnId: 'p1', status: 'suggested' };

// No links: old behaviour — refund stays in its own month.
const plain = E.monthlyNetSpend(txns);
const pAug = plain.find(function (r) { return r.month === '2026-08'; });
const pSep = plain.find(function (r) { return r.month === '2026-09'; });
ok(pAug && pAug.netMinor === 5000, 'no links: Aug net = 5000', pAug);
ok(pSep && pSep.netMinor === -5000, 'no links: Sep net = -5000 (refund)', pSep);

// With cross-month link: return attributed to August.
const adj = E.monthlyNetSpend(txns, [link]);
const aAug = adj.find(function (r) { return r.month === '2026-08'; });
const aSep = adj.find(function (r) { return r.month === '2026-09'; });
ok(aAug && aAug.netMinor === 0, 'linked: Aug net = 0 (return attributed)', aAug);
ok(aAug && aAug.returnAdjMinor === -5000, 'linked: Aug returnAdjMinor = -5000', aAug);
ok(aSep && aSep.netMinor === 0, 'linked: Sep net = 0 (refund moved out)', aSep);
ok(aSep && aSep.returnAdjMinor === 0, 'linked: Sep returnAdjMinor = 0', aSep);
// Input rows untouched (purity).
ok(sepRefund.date === '2026-09-05' && augBuy.date === '2026-08-10', 'monthlyNetSpend does not mutate txns');

// returnAdjustment deltas for the month headline.
const adjAug = E.returnAdjustment(txns, [link], '2026-08');
ok(adjAug && adjAug.deltaMinor === -5000 && adjAug.movedMinor === -5000 && adjAug.linkCount === 1,
   'returnAdjustment Aug: delta -5000', adjAug);
const adjSep = E.returnAdjustment(txns, [link], '2026-09');
ok(adjSep && adjSep.deltaMinor === 5000 && adjSep.movedMinor === 0,
   'returnAdjustment Sep: delta +5000', adjSep);
ok(E.returnAdjustment(txns, [link], '2026-10') === null, 'returnAdjustment: null for unaffected month');
ok(E.returnAdjustment(txns, [], '2026-08') === null, 'returnAdjustment: null with no links');

// Same-month link: no move.
const sameMonthRefund = row('r2', '2026-08-20', -5000, 'CANADIAN TIRE #88', 'refund');
const sameLink = { refundTxnId: 'r2', purchaseTxnId: 'p1', status: 'suggested' };
const sameAdj = E.monthlyNetSpend([augBuy, sameMonthRefund], [sameLink]);
const sAug = sameAdj.find(function (r) { return r.month === '2026-08'; });
ok(sAug && sAug.netMinor === 0 && sAug.returnAdjMinor === 0,
   'same-month link changes nothing', sAug);

// Rejected link: ignored.
const rejAdj = E.monthlyNetSpend(txns, [{ refundTxnId: 'r1', purchaseTxnId: 'p1', status: 'rejected' }]);
const rAug = rejAdj.find(function (r) { return r.month === '2026-08'; });
ok(rAug && rAug.netMinor === 5000, 'rejected link ignored', rAug);

// Link to a missing purchase / non-refund kind: ignored, no crash.
const weird = E.monthlyNetSpend(txns, [
  { refundTxnId: 'r1', purchaseTxnId: 'nope', status: 'suggested' },
  { refundTxnId: 'p1', purchaseTxnId: 'r1', status: 'suggested' },
]);
ok(weird.find(function (r) { return r.month === '2026-08'; }).netMinor === 5000,
   'dangling/wrong-kind links ignored');

// refundMoves helper directly.
const moves = E.refundMoves(txns, [link]);
ok(moves.length === 1 && moves[0].fromMonth === '2026-09' && moves[0].toMonth === '2026-08' &&
   moves[0].amountMinor === -5000, 'refundMoves shape', moves);
ok(moves[0].purchase && String(moves[0].purchase.id) === 'p1' &&
   moves[0].refund && String(moves[0].refund.id) === 'r1',
   'refundMoves carries refund+purchase refs (per-account attribution)', moves[0] && { r: moves[0].refund && moves[0].refund.id, p: moves[0].purchase && moves[0].purchase.id });
ok(E.refundMoves(txns, []).length === 0, 'refundMoves: empty with no links');

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
