/* Statement-credit regression tests (v17): Umar's real June case was PDF-ONLY
   (no CSV import). PC statements print purchases positive and credits
   negative; several negative credit rows whose descriptions matched no
   refund keyword defaulted to kind='purchase'. v16 then counted those
   credits as positive spend (gross $15,749.43 on his screen). v17 detects
   the sign/convention contradiction and counts them as statement credits
   instead: they REDUCE net spend.

   Fictional PC-style June ledger (all merchants fictional):
     genuine purchases:                     +$3,769.99
     misclassified credits (kind purchase): -$11,979.44  (2 rows)
     payments (excluded):                   -$8,000.00
   Expected v17: gross $3,769.99, statement credits $11,979.44 (2 rows),
   refunds $0, net -$8,209.45 (a net-credit month). Run with node. */
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
function T(o) {
  const r = Object.assign({
    id: 'sc' + (++seq), date: '2026-06-15', statementId: 'st-pc',
    excluded: 0, status: 'active', signConvention: 'pdf-card',
    classificationSource: 'builtin',
  }, o);
  if (r.signedAmountMinor === undefined) r.signedAmountMinor = r.amountMinor;
  if (r.spendAmountMinor === undefined) r.spendAmountMinor = r.amountMinor;
  return r;
}
/* Genuine PC purchase: positive card-centric amount, kind purchase. */
function buy(merchant, amountMinor, category, date) {
  return T({ merchantRaw: merchant, amountMinor: amountMinor, kind: 'purchase',
    category: category, date: date || '2026-06-15' });
}
/* Misclassified credit: negative card-centric amount, kind purchase
   (no refund keyword matched at import). */
function credit(merchant, amountMinor, category, date) {
  return T({ merchantRaw: merchant, amountMinor: -Math.abs(amountMinor),
    kind: 'purchase', category: category, date: date || '2026-06-15' });
}

const txns = [
  buy('NORTHSTAR GROCERS', 125000, 'groceries', '2026-06-02'),
  buy('FUEL STOP', 89999, 'transport', '2026-06-07'),
  buy('PHARMACY PLUS', 42000, 'health', '2026-06-11'),
  buy('CORNER CAFE', 120000, 'dining', '2026-06-19'),
  // Two large credits the keyword rules didn't catch (no "refund"/"return").
  credit('BIGBOX ONLINE', 1162806, 'shopping', '2026-06-14'),
  credit('BILL ADJUSTMENT', 35138, 'other', '2026-06-22'),
  // Payments are money movement, never spend.
  T({ merchantRaw: 'PAYMENT RECEIVED - THANK YOU', amountMinor: -500000, kind: 'payment', excluded: 1, category: 'uncategorized', date: '2026-06-20' }),
  T({ merchantRaw: 'PAYMENT RECEIVED - THANK YOU', amountMinor: -300000, kind: 'payment', excluded: 1, category: 'uncategorized', date: '2026-06-28' }),
];

/* ---------- purchaseSignContradicts ---------- */
ok(E.purchaseSignContradicts(txns[0]) === false, 'genuine PDF purchase does not contradict');
ok(E.purchaseSignContradicts(txns[4]) === true, 'negative PDF "purchase" contradicts (statement credit)');
ok(E.purchaseSignContradicts(txns[5]) === true, 'second credit contradicts');
ok(E.purchaseSignContradicts(txns[6]) === false, 'payment never contradicts (not a purchase)');
// A human correction is trusted even when the sign looks wrong.
const userFixed = T({ merchantRaw: 'BIGBOX ONLINE', amountMinor: -1162806, kind: 'purchase',
  category: 'shopping', classificationSource: 'user' });
ok(E.purchaseSignContradicts(userFixed) === false, 'user-corrected kind is trusted, never a contradiction');
// Manual entries use the CSV convention: a negative purchase is genuine spend.
const manual = T({ merchantRaw: 'CORNER CAFE', amountMinor: -120000, spendAmountMinor: 120000,
  kind: 'purchase', category: 'dining', signConvention: 'csv', classificationSource: 'manual' });
ok(E.purchaseSignContradicts(manual) === false, 'manual (csv-convention) negative purchase is genuine');
ok(E.canonicalSpendMinor(manual) === 120000, 'manual purchase canonical +120000');
// CSV imports: negative purchase / positive refund are genuine, not credits.
const csvBuy = T({ merchantRaw: 'FRESHCART', amountMinor: -50000, kind: 'purchase',
  category: 'groceries', signConvention: 'csv', classificationSource: 'builtin' });
ok(E.purchaseSignContradicts(csvBuy) === false, 'CSV negative purchase is genuine');
ok(E.canonicalSpendMinor(csvBuy) === 50000, 'CSV purchase canonical +50000');
// Zero-amount rows never contradict.
ok(E.purchaseSignContradicts(T({ amountMinor: 0, kind: 'purchase' })) === false, 'zero amount never contradicts');

/* ---------- canonicalSpendMinor ---------- */
ok(E.canonicalSpendMinor(txns[0]) === 125000, 'genuine purchase canonical positive');
ok(E.canonicalSpendMinor(txns[4]) === -1162806, 'misclassified credit canonical NEGATIVE');
ok(E.canonicalSpendMinor(txns[5]) === -35138, 'second credit canonical negative');
ok(E.canonicalSpendMinor(txns[6]) === 0, 'payment canonical 0');

/* ---------- reconcile: the v17 buckets ---------- */
const r = E.reconcile(txns, null);
ok(r.grossPurchasesMinor === 376999, 'gross = genuine purchases only ($3,769.99)', r.grossPurchasesMinor);
ok(r.statementCreditsMinor === 1197944, 'statement credits = $11,979.44', r.statementCreditsMinor);
ok(r.statementCreditCount === 2, 'two statement-credit rows counted', r.statementCreditCount);
ok(r.statementCreditsMinor >= 0, 'statement credits never negative');
ok(r.refundsTotalMinor === 0, 'no refunds', r.refundsTotalMinor);
ok(r.refundCount === 0, 'refund count 0', r.refundCount);
ok(r.netSpendMinor === -820945, 'net = 376999 - 1197944 = -$8,209.45 (net-credit month)', r.netSpendMinor);
// The hero build-up resolves exactly: purchases - refunds - credits = net.
ok(r.grossPurchasesMinor - r.refundsTotalMinor - r.statementCreditsMinor === r.netSpendMinor,
  'build-up resolves: gross - refunds - statement credits = net');

/* ---------- category totals: credits reduce, never inflate ---------- */
const cats = E.totalsByCategory(txns).totals;
ok(cats.shopping === -1162806, 'shopping bar = -$11,628.06 (net credit), NOT +$11,628.06', cats.shopping);
ok(cats.other === -35138, 'other bar = -$351.38', cats.other);
ok(cats.groceries === 125000, 'groceries bar = +$1,250.00', cats.groceries);
const members = E.categoryMembers(txns, 'shopping');
ok(members.length === 1 && members[0].shareMinor === -1162806, 'shopping drill-down share negative', members[0] && members[0].shareMinor);
const netCats = E.splitAwareNetCategoryTotals(txns, '2026-06');
ok(netCats.shopping === -1162806, 'movers math matches bar math for credit categories', netCats.shopping);
const grossCats = E.splitAwareCategoryTotals(txns, '2026-06');
ok(grossCats.shopping === undefined, 'budget gross spend excludes the credit row (no phantom budget burn)', grossCats.shopping);
ok(grossCats.groceries === 125000, 'budget gross keeps genuine purchases', grossCats.groceries);

/* ---------- receipt coverage denominator == hero purchases figure ---------- */
const cov = E.coverageOfTxns(txns, []);
ok(cov.grossMinor === r.grossPurchasesMinor, 'coverage denominator == reconcile gross', { c: cov.grossMinor, r: r.grossPurchasesMinor });
ok(cov.grossMinor === 376999, 'coverage denominator = $3,769.99 (credits excluded)', cov.grossMinor);

/* ---------- briefing: honest about the net-credit month ---------- */
const brief = E.buildBriefing(txns, '2026-06-01', '2026-06-30', null, 'June 2026', null);
ok(brief.statementCreditsMinor === 1197944, 'briefing facts carry statementCreditsMinor');
ok(brief.statementCreditCount === 2, 'briefing facts carry statementCreditCount');
const text = E.renderBriefingText(brief);
ok(text.indexOf('-$') === -1, 'briefing never prints -$');
ok(text.indexOf('net-credit month') !== -1, 'briefing names the net-credit month', text.split('\n')[0]);
ok(text.indexOf('$8,209.45') !== -1, 'briefing shows the $8,209.45 net credit magnitude');
ok(text.indexOf('$11,979.44') !== -1, 'briefing shows the $11,979.44 statement credits');
ok(text.indexOf('2 transaction(s)') !== -1, 'briefing counts the 2 credit rows');

console.log('--- end-to-end: parser-style raw -> normalize -> stamp -> classify -> reconcile ---');

/* ---------- committed PDF-only regression: the REAL import flow ----------
   Raw rows as Parsers.PC emits them (card-centric signedAmountMinor, ISO
   date fallback via dateInferred). The credit carries no refund keyword, so
   classifyRows defaults it to kind='purchase'; the v17 contradiction check
   must catch it. No CSV anywhere in this flow. */
const rawRows = [
  { rawDateText: 'Jun 14', rawDescription: 'BIGBOX ONLINE', rawAmountText: '-$11,628.06', signedAmountMinor: -1162806, dateInferred: '2026-06-14' },
  { rawDateText: 'Jun 02', rawDescription: 'NORTHSTAR GROCERS', rawAmountText: '$1,250.00', signedAmountMinor: 125000, dateInferred: '2026-06-02' },
  { rawDateText: 'Jun 20', rawDescription: 'PAYMENT RECEIVED - THANK YOU', rawAmountText: '-$5,000.00', signedAmountMinor: -500000, dateInferred: '2026-06-20' }
];
const norm = E.normalizeRows(rawRows);
/* App.stageNormalize provenance stamp for a PDF import. */
norm.forEach(function (r) { if (!r.signConvention) r.signConvention = 'pdf-card'; });
ok(norm[0].amountMinor === -1162806, 'e2e: normalize keeps the credit sign', norm[0].amountMinor);
ok(norm[0].date === '2026-06-14', 'e2e: normalize resolves the date', norm[0].date);
const cls = E.classifyRows(norm, []);
ok(cls[0].kind === 'purchase', 'e2e: keyword-less credit defaults to purchase', cls[0].kind);
ok(cls[1].kind === 'purchase', 'e2e: genuine charge is a purchase', cls[1].kind);
ok(cls[2].kind === 'payment', 'e2e: THANK YOU row is a payment', cls[2].kind);
ok(E.purchaseSignContradicts(cls[0]) === true, 'e2e: the defaulted credit contradicts its PDF convention');
ok(E.purchaseSignContradicts(cls[1]) === false, 'e2e: the genuine charge does not contradict');
const er = E.reconcile(cls, null);
ok(er.grossPurchasesMinor === 125000, 'e2e: gross is the genuine purchase only', er.grossPurchasesMinor);
ok(er.statementCreditsMinor === 1162806, 'e2e: the credit is a statement credit, not spend', er.statementCreditsMinor);
ok(er.statementCreditCount === 1, 'e2e: one credit row counted', er.statementCreditCount);
ok(er.refundsTotalMinor === 0, 'e2e: no refunds', er.refundsTotalMinor);
ok(er.netSpendMinor === 125000 - 1162806, 'e2e: net = gross - credits', er.netSpendMinor);
const ebrief = E.buildBriefing(cls, '2026-06-01', '2026-06-30', null, 'All accounts', null);
ok(ebrief.netSpendMinor === er.netSpendMinor, 'e2e: briefing net matches reconcile', ebrief.netSpendMinor);
ok(ebrief.statementCreditsMinor === 1162806, 'e2e: briefing carries the credit bucket', ebrief.statementCreditsMinor);

console.log('\nSTATEMENT-CREDITS-V17: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
