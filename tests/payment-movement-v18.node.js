/* Payment-movement regression tests (v18): Umar's CIBC statement showed the
   hero subtracting his $3,530.00 card bill payment ("PAYMENT CIBC") as a
   "statement credit": purchases $3,681.53 − credits $4,786.47 = net credit
   $1,104.94. Paying the card bill is money movement (a transfer), never
   spend and never a spend reduction. v18 recognizes bank bill-payment
   descriptors — the description STARTS with the word PAYMENT — as
   kind='payment' at classify time, and a boot migration re-runs the current
   classifier over already-imported builtin rows so no re-import is needed.

   Conservative by design (never-guess): "TELUS PRE-AUTH PAYMENT" does NOT
   start with PAYMENT, so it stays a statement credit (money back); only
   clear bank-payment descriptors move. Run with node. */
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

let seq = 0;
/* Raw import-style row: no kind yet, like a fresh PDF import row. */
function raw(merchantRaw, amountMinor, extra) {
  return Object.assign({
    id: 'pm' + (++seq), date: '2026-07-29', statementId: 'st-cibc',
    merchantRaw: merchantRaw, amountMinor: amountMinor,
    signConvention: 'pdf-card', excluded: 0, status: 'active',
  }, extra || {});
}

/* ---------- isBankPaymentDescriptor: unit checks ---------- */
ok(E.isBankPaymentDescriptor(raw('PAYMENT CIBC', -353000)) === true, 'PAYMENT CIBC negative -> payment descriptor');
ok(E.isBankPaymentDescriptor(raw('PAYMENT', -10000)) === true, 'bare PAYMENT negative -> payment descriptor');
ok(E.isBankPaymentDescriptor(raw('PAYMENT - THANK YOU', -500000)) === true, 'PAYMENT - THANK YOU negative -> payment descriptor');
ok(E.isBankPaymentDescriptor(raw('PAYMENT THANK YOU', -500000)) === true, 'PAYMENT THANK YOU negative -> payment descriptor');
ok(E.isBankPaymentDescriptor(raw('payment cibc', -353000)) === true, 'lowercase payment cibc -> payment descriptor');
ok(E.isBankPaymentDescriptor(raw('  PAYMENT   CIBC  ', -353000)) === true, 'extra whitespace tolerated');
ok(E.isBankPaymentDescriptor(raw('TELUS PRE-AUTH PAYMENT', -10500)) === false, 'TELUS PRE-AUTH PAYMENT stays a statement credit, NOT movement');
ok(E.isBankPaymentDescriptor(raw('PAYMENTS DUE', -10000)) === false, 'PAYMENTS (no word boundary) is not guessed');
ok(E.isBankPaymentDescriptor(raw('REPAYMENT PLAN', -10000)) === false, 'REPAYMENT does not start with PAYMENT');
ok(E.isBankPaymentDescriptor(raw('APPLE.COM/CA', -115147)) === false, 'APPLE.COM/CA negative is a credit, not a payment');
ok(E.isBankPaymentDescriptor(raw('WAL-MART #3001', 5314)) === false, 'ordinary purchase is not a payment');
ok(E.isBankPaymentDescriptor(raw('PAYMENT CIBC', 353000)) === false, 'positive-signed PAYMENT on pdf-card is contradictory: never guessed');
ok(E.isBankPaymentDescriptor(raw('PAYMENT CIBC', 0)) === false, 'zero-amount PAYMENT is not a payment');
ok(E.isBankPaymentDescriptor(raw('PAYMENT CIBC', null)) === false, 'missing amount is not a payment');
ok(E.isBankPaymentDescriptor(raw(null, -353000)) === false, 'missing descriptor is not a payment');
/* CSV convention: purchases print negative, so a bill payment prints
   positive — the credit-sign check follows the row's own convention. */
ok(E.isBankPaymentDescriptor(raw('PAYMENT CIBC', 353000, { signConvention: 'csv' })) === true,
  'csv-convention positive PAYMENT is a credit in its own convention -> payment descriptor');
ok(E.isBankPaymentDescriptor(raw('PAYMENT CIBC', -353000, { signConvention: 'csv' })) === false,
  'csv-convention negative PAYMENT is purchase-signed: never guessed');

/* ---------- classifyRows: fresh-import behaviour ---------- */
const fresh = [
  raw('PAYMENT CIBC', -353000),
  raw('PAYMENT', -10000),
  raw('TELUS PRE-AUTH PAYMENT', -10500),
  raw('APPLE.COM/CA', -115147),
  raw('WAL-MART #3001', 5314),
];
E.classifyRows(fresh, []);
ok(fresh[0].kind === 'payment', 'PAYMENT CIBC classified as payment');
ok(fresh[0].excluded === 1 && fresh[0].spendAmountMinor === 0, 'payment excluded from spend fields');
ok(fresh[0].classificationSource === 'builtin', 'payment stamped builtin');
ok(fresh[0].kindConfidence >= 0.95, 'payment descriptor confidence is high (0.95)');
ok(fresh[1].kind === 'payment', 'bare PAYMENT classified as payment');
ok(fresh[2].kind === 'purchase', 'TELUS PRE-AUTH PAYMENT stays kind=purchase (credit fallback)');
ok(E.purchaseSignContradicts(fresh[2]) === true, 'TELUS row is a statement credit (reduces spend), not movement');
ok(fresh[3].kind === 'purchase', 'APPLE.COM/CA negative stays kind=purchase');
ok(E.purchaseSignContradicts(fresh[3]) === true, 'APPLE.COM/CA is a statement credit');
ok(fresh[4].kind === 'purchase', 'ordinary purchase untouched');
ok(E.purchaseSignContradicts(fresh[4]) === false, 'ordinary purchase does not contradict');

/* A human correction is sacred: the descriptor check never overrides it. */
const userFixed = raw('PAYMENT CIBC', -353000,
  { kind: 'purchase', classificationSource: 'user', category: 'other' });
E.classifyRows([userFixed], []);
ok(userFixed.kind === 'purchase', 'user-corrected PAYMENT CIBC keeps the user kind');

/* Household rules outrank builtin: a kind rule on the descriptor wins. */
const ruleRow = raw('PAYMENT CIBC', -353000);
E.classifyRows([ruleRow], [{ id: 'r1', enabled: true, priority: 100,
  matchMerchant: 'PAYMENT CIBC', kind: 'transfer', label: 'test rule' }]);
ok(ruleRow.kind === 'transfer' && ruleRow.classificationSource === 'rule',
  'household rule on PAYMENT CIBC outranks the builtin descriptor check');

/* Review queue: a recognized payment never needs review. */
ok(E.rowNeedsReview(fresh[0]) === false, 'recognized payment is not review-queued');
ok(E.rowNeedsReview(fresh[2]) === true, 'un-categorized TELUS credit still needs review (never-guess)');

/* ---------- reconcile: Umar's CIBC statement numbers ---------- */
/* purchases $3,681.53; credits: APPLE.COM/CA -$1,151.47 + TELUS -$105.00;
   bill payment -$3,530.00. Expected: gross 368153, credits 125647 (2 rows),
   net spend 242506. The payment must not appear in any spend bucket. */
function classified(merchantRaw, amountMinor) {
  const r = raw(merchantRaw, amountMinor);
  E.classifyRows([r], []);
  if (r.spendAmountMinor === undefined) r.spendAmountMinor = r.amountMinor;
  if (r.signedAmountMinor === undefined) r.signedAmountMinor = r.amountMinor;
  return r;
}
const cibc = [
  classified('GROCERY MART', 200000),
  classified('FUEL STOP', 100000),
  classified('CORNER CAFE', 68153),
  classified('PAYMENT CIBC', -353000),
  classified('APPLE.COM/CA', -115147),
  classified('TELUS PRE-AUTH PAYMENT', -10500),
];
const rec = E.reconcile(cibc, null);
ok(rec.grossPurchasesMinor === 368153, 'gross purchases = $3,681.53', rec.grossPurchasesMinor);
ok(rec.refundsTotalMinor === 0, 'no refunds', rec.refundsTotalMinor);
ok(rec.statementCreditsMinor === 125647, 'statement credits = $1,256.47 (Apple + Telus only)', rec.statementCreditsMinor);
ok(rec.statementCreditCount === 2, 'two statement-credit rows', rec.statementCreditCount);
ok(rec.netSpendMinor === 242506, 'net spend = $2,425.06 (NOT a net credit)', rec.netSpendMinor);
ok(rec.grossPurchasesMinor - rec.refundsTotalMinor - rec.statementCreditsMinor === rec.netSpendMinor,
  'hero build-up resolves: purchases - refunds - credits = net');
/* The payment row is movement: canonical 0, and kind buckets reconcile. */
const kinds = {};
cibc.forEach(function (t) { kinds[t.kind] = (kinds[t.kind] || 0) + 1; });
ok(kinds.payment === 1, 'one payment row counted under payments', kinds);
ok(kinds.purchase === 5, 'five purchase-kind rows (3 genuine + 2 credits)', kinds);
ok(E.canonicalSpendMinor(cibc[3]) === 0, 'payment canonical spend is 0');

/* A bill payment can never manufacture a "net credit": even a payment
   larger than the month's purchases leaves net spend untouched. */
const bigPay = cibc.concat([classified('PAYMENT', -1000000)]);
const rec2 = E.reconcile(bigPay, null);
ok(rec2.netSpendMinor === 242506, 'a $10,000 bill payment does not move net spend', rec2.netSpendMinor);
ok(rec2.netSpendMinor >= 0, 'no net-credit label can come from payments');

/* Statement credits genuinely reduce spend (money back), payments do not. */
ok(E.canonicalSpendMinor(cibc[4]) === -115147, 'APPLE.COM/CA credit canonical negative');
ok(E.canonicalSpendMinor(cibc[5]) === -10500, 'TELUS credit canonical negative');

console.log('payment-movement-v18: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
