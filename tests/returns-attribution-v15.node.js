/* Cross-month return attribution consistency (v15): real engine.js + app.js.
   - App.attributedRefunds: purchases minus attributed refunds always equals
     the (attributed) net spend headline
   - Engine returnAdjustment moves only linked refunds between months, and
     the App-side attributed math resolves for both the source and the
     destination month
   - App.refundsNoteHtml: the "already subtracted" claim only appears when no
     cross-month attribution happened; otherwise the note breaks out received
     vs attributed amounts
   All merchants are fictional. Run with node. */
'use strict';
const path = require('path');
const WEB = path.join(__dirname, '..', 'apps/web/js');
global.window = undefined;
global.localStorage = { _m: {}, getItem(k) { return this._m[k] == null ? null : this._m[k]; },
  setItem(k, v) { this._m[k] = String(v); }, removeItem(k) { delete this._m[k]; } };
require(WEB + '/engine.js');
require(WEB + '/app.js');
const E = globalThis.Engine, A = globalThis.App;
if (!E || !A || typeof A.attributedRefunds !== 'function') {
  console.error('FAIL: Engine/App.attributedRefunds missing'); process.exit(1);
}

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; }
  else { fail++; console.error('FAIL:', name, extra === undefined ? '' : JSON.stringify(extra)); }
}

function row(id, o) {
  return Object.assign({
    id: id, merchantRaw: 'FRESHCART MARKET', desc: 'FRESHCART MARKET', amountMinor: 100,
    kind: 'purchase', category: 'groceries', date: '2026-09-10', statementId: 'st-1',
    split: null, excluded: 0, status: 'active'
  }, o);
}

/* ---------- 1. attributedRefunds pure math ---------- */
let at = A.attributedRefunds({ refundsTotalMinor: 2000, returnOutMinor: 500, returnAdjMinor: -300 });
ok(at.outMinor === 500 && at.inMinor === 300, 'out/in components', at);
ok(at.attrRefundsMinor === 1800, 'attributed refunds = 2000 - 500 + 300', at.attrRefundsMinor);

at = A.attributedRefunds({ refundsTotalMinor: 2000 });
ok(at.attrRefundsMinor === 2000 && at.outMinor === 0 && at.inMinor === 0,
   'no attribution -> refunds as received', at);

/* Hero invariant: gross - attributedRefunds === netSpendMinor. */
const recon = { grossPurchasesMinor: 10000, refundsTotalMinor: 2000, netSpendMinor: 8000,
                returnOutMinor: 1000, returnAdjMinor: -1000 };
at = A.attributedRefunds(recon);
ok(recon.grossPurchasesMinor - at.attrRefundsMinor === recon.netSpendMinor,
   'hero build-up resolves: 10000 - 2000 = 8000', at);

/* ---------- 2. Engine-level: one linked refund across two months ---------- */
const txns = [
  row('p', { amountMinor: 10000, date: '2026-09-05' }),
  row('r', { amountMinor: -2000, kind: 'refund', date: '2026-10-02' })
];
const links = [{ refundTxnId: 'r', purchaseTxnId: 'p', status: 'confirmed' }];

const adjSep = E.returnAdjustment(txns, links, '2026-09');
ok(adjSep && adjSep.deltaMinor === -2000 && adjSep.movedMinor === -2000,
   'Sep attribution pulls the Oct refund into Sep', adjSep);

const adjOct = E.returnAdjustment(txns, links, '2026-10');
ok(adjOct && adjOct.deltaMinor === 2000 && adjOct.movedMinor === 0,
   'Oct adjustment pushes the refund back out of Oct', adjOct);

/* Month-context-style composites must resolve on both sides. */
function composite(month, unadjustedRecon) {
  const rc = Object.assign({}, unadjustedRecon);
  const adj = E.returnAdjustment(txns, links, month);
  if (adj) {
    rc.netSpendMinor += adj.deltaMinor;
    rc.returnAdjMinor = adj.movedMinor;
    rc.returnOutMinor = adj.deltaMinor - adj.movedMinor;
  }
  const a = A.attributedRefunds(rc);
  return rc.grossPurchasesMinor - a.attrRefundsMinor === rc.netSpendMinor;
}
ok(composite('2026-09', { grossPurchasesMinor: 10000, refundsTotalMinor: 0, netSpendMinor: 10000 }),
   'Sep: 10000 purchases - 2000 attributed refunds = 8000 net');
ok(composite('2026-10', { grossPurchasesMinor: 0, refundsTotalMinor: 2000, netSpendMinor: -2000 }),
   'Oct: 0 purchases - 0 attributed refunds = 0 net (refund counted in Sep)');

/* monthlyNetSpend (the trend source) agrees with the hero adjustment. */
const trend = E.monthlyNetSpend(txns, links);
const tSep = trend.find(e => e.month === '2026-09'), tOct = trend.find(e => e.month === '2026-10');
ok(tSep && tSep.netMinor === 8000 && tOct && tOct.netMinor === 0,
   'trend months move the refund physically, matching the hero', trend);

/* ---------- 3. refundsNoteHtml honesty ---------- */
const rsPlain = { totalMinor: 2000, count: 2 };
let note = A.refundsNoteHtml({ refundsTotalMinor: 2000, refundCount: 2 }, rsPlain);
ok(note.indexOf('already subtracted from net spend') !== -1,
   'no attribution -> the plain claim is fine', note);
ok(note.indexOf('as received') === -1, 'no attribution -> no as-received breakout', note);

note = A.refundsNoteHtml({ refundsTotalMinor: 2000, refundCount: 2, returnOutMinor: 1000, returnAdjMinor: 0 }, rsPlain);
ok(note.indexOf('already subtracted from net spend') === -1,
   'with attribution -> the false claim is gone', note);
ok(note.indexOf('as received') !== -1 && note.indexOf('Netted against') !== -1,
   'with attribution -> received vs netted breakout shown', note);

console.log(`returns-attribution-v15: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
