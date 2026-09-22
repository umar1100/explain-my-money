/* Spend-math integrity tests (v15): real engine.js.
   - excluded purchases/refunds never count toward gross / refunds / net
   - duplicate rows never count toward spend
   - excludedTotalMinor still records what was excluded
   - the statement balance check (signedRowsSumMinor) still sees every real
     row, including excluded ones
   - payments / transfers never count as spend
   - totalsByCategory + buildBriefing agree with reconcile
   - refundMoves / returnAdjustment ignore links with an excluded leg
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
  const r = Object.assign({
    id: id, merchantRaw: 'FRESHCART MARKET', desc: 'FRESHCART MARKET', amountMinor: 100,
    kind: 'purchase', category: 'groceries', date: '2026-09-10', statementId: 'st-1',
    split: null, excluded: 0, status: 'active'
  }, o);
  // Real rows carry the signed print amount for the balance check.
  if (r.signedAmountMinor === undefined) r.signedAmountMinor = r.amountMinor;
  return r;
}

const base = [
  row('p1', { amountMinor: 10000 }),
  row('p2', { amountMinor: 5000 }),
  row('px', { amountMinor: 3000, excluded: 1 }),
  row('pd', { amountMinor: 4000, status: 'duplicate', excluded: 1 }),
  row('r1', { amountMinor: -1500, kind: 'refund' }),
  row('rx', { amountMinor: -800, kind: 'refund', excluded: 1 }),
  row('pay', { amountMinor: -12000, kind: 'payment', merchantRaw: 'PAYMENT RECEIVED', desc: 'PAYMENT RECEIVED' }),
  row('xf', { amountMinor: 2000, kind: 'transfer', merchantRaw: 'E-TRANSFER', desc: 'E-TRANSFER' })
];

const r = E.reconcile(base, null);
ok(r.grossPurchasesMinor === 15000, 'excluded + duplicate purchases NOT in gross', r.grossPurchasesMinor);
ok(r.refundsTotalMinor === 1500, 'excluded refunds NOT in the refund total', r.refundsTotalMinor);
ok(r.netSpendMinor === 13500, 'net = 15000 - 1500 (excluded/duplicate/payment/transfer out)', r.netSpendMinor);
ok(r.excludedTotalMinor === 6200, 'excludedTotal records the signed excluded amounts (3000+4000-800)', r.excludedTotalMinor);
ok(r.refundCount === 1, 'refundCount ignores the excluded refund', r.refundCount);
ok(r.signedRowsSumMinor === 9700,
   'balance-check sum still sees every real row (incl. excluded)', r.signedRowsSumMinor);
ok(r.balanceCheck === 'no_baseline', 'no reported balances -> balance check stays neutral', r.balanceCheck);

const cat = E.totalsByCategory(base);
ok(cat.totals.groceries === 13500, 'category total excludes excluded/dup rows', cat.totals.groceries);

const brief = E.buildBriefing(base, '2026-09', null);
ok(brief && brief.netSpendMinor === 13500, 'briefing net agrees with reconcile', brief && brief.netSpendMinor);

/* All-excluded month: net is 0, nothing leaks in. */
const allX = [row('a', { amountMinor: 9000, excluded: 1 }), row('b', { amountMinor: -500, kind: 'refund', excluded: 1 })];
const rx = E.reconcile(allX, null);
ok(rx.netSpendMinor === 0 && rx.grossPurchasesMinor === 0 && rx.refundsTotalMinor === 0,
   'a fully excluded month nets to zero', rx);

/* refundMoves must ignore links with an excluded/duplicate leg. Moves only
   exist across months, so use the dated rows (refund in Oct, purchase in Sep). */
const links = [
  { refundTxnId: 'r1', purchaseTxnId: 'p1', status: 'confirmed' },
  { refundTxnId: 'rx', purchaseTxnId: 'p1', status: 'confirmed' },
  { refundTxnId: 'r1', purchaseTxnId: 'px', status: 'confirmed' }
];
const dated = base.map(t => Object.assign({}, t));
dated.find(t => t.id === 'p1').date = '2026-09-05';
dated.find(t => t.id === 'r1').date = '2026-10-02';
dated.find(t => t.id === 'rx').date = '2026-10-03';
dated.find(t => t.id === 'px').date = '2026-09-06';
const mv = E.refundMoves(dated, links);
ok(mv.length === 1 && mv[0].refund.id === 'r1',
   'only the clean link moves (excluded legs are unattributable)', mv.length);
const adj = E.returnAdjustment(dated, links, '2026-09');
ok(adj && adj.deltaMinor === -1500 && adj.movedMinor === -1500,
   'attribution moves only the clean refund into Sep', adj);

console.log(`spend-math-v15: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
