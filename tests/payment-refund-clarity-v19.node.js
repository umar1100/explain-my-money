/* Payment vs refund clarity (v19): Umar's CIBC statement showed the app must
   clearly separate THREE things — (1) refunds (money back from stores,
   reduces spending), (2) other statement credits (money back the app cannot
   confidently tie to a store refund, reduces spending), (3) bill payments
   (what he paid toward the card bill — money movement, NEVER spending and
   never subtracted). v19 generalizes bill-payment recognition beyond CIBC
   (verified issuer descriptors + the parser-verified CIBC "Your payments"
   table section) and renders the three concepts distinctly everywhere.

   Conservative by design (never-guess): only externally verified
   descriptors and the parser-verified section move rows to kind='payment'.
   Unverified wordings, "PAYMENTS" (plural), and generic-parser 'payments'
   sections stay as credits / Review. All merchants are fictional.
   Run with node. */
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
    id: 'v19-' + (++seq), date: '2026-07-29', statementId: 'st-1',
    merchantRaw: merchantRaw, amountMinor: amountMinor,
    signConvention: 'pdf-card', excluded: 0, status: 'active',
  }, extra || {});
}
function classified(merchantRaw, amountMinor, extra) {
  const r = raw(merchantRaw, amountMinor, extra);
  E.classifyRows([r], []);
  if (r.spendAmountMinor === undefined) r.spendAmountMinor = r.amountMinor;
  if (r.signedAmountMinor === undefined) r.signedAmountMinor = r.amountMinor;
  return r;
}

/* ---------- 1. verified issuer descriptors (BANK_PAYMENT_EXAMPLES) ---------- */
ok(Array.isArray(E.BANK_PAYMENT_EXAMPLES) && E.BANK_PAYMENT_EXAMPLES.length >= 7,
  'BANK_PAYMENT_EXAMPLES documents the verified issuer patterns', E.BANK_PAYMENT_EXAMPLES && E.BANK_PAYMENT_EXAMPLES.length);
E.BANK_PAYMENT_EXAMPLES.forEach(function (ex) {
  const r = classified(ex.descriptor, -100000);
  ok(r.kind === 'payment', 'verified pattern [' + ex.issuer + '] "' + ex.descriptor + '" -> kind=payment', r.kind);
  ok(r.excluded === 1 && r.spendAmountMinor === 0, 'verified pattern "' + ex.descriptor + '" excluded from spend');
});
/* Spot-check the issuers Umar named. */
const issuers = E.BANK_PAYMENT_EXAMPLES.map(function (x) { return x.issuer; });
ok(issuers.indexOf('CIBC') !== -1 && issuers.indexOf('TD') !== -1 && issuers.indexOf('RBC') !== -1,
  'CIBC, TD, RBC all have verified patterns', issuers);

/* ---------- 2. near misses are NEVER guessed as payments ---------- */
const misses = [
  ['TELUS PRE-AUTH PAYMENT', -10500],   // credit, not movement
  ['PRE-AUTH PAYMENT FIDO', -9900],     // credit, not movement
  ['PAYMENTS DUE', -10000],             // plural: not verified
  ['REPAYMENT PLAN', -10000],           // does not start with PAYMENT
  ['RBC STATEMENT ADJUSTMENT', -5000],  // neutral wording
];
misses.forEach(function (m) {
  const r = classified(m[0], m[1]);
  ok(r.kind !== 'payment', 'near miss "' + m[0] + '" is NOT a payment', r.kind);
});
/* Wrong-sign PAYMENT is contradictory, never a payment. */
const wrongSign = classified('PAYMENT CIBC', 353000);
ok(wrongSign.kind !== 'payment', 'PAYMENT with purchase sign is not guessed as a payment', wrongSign.kind);

/* ---------- 3. isParserPaymentSection: verified only ---------- */
ok(E.isParserPaymentSection({ section: 'payments', sectionVerified: true }) === true,
  'verified payments section is trusted');
ok(E.isParserPaymentSection({ section: 'payments' }) === false,
  'generic payments section (no stamp) is NOT trusted');
ok(E.isParserPaymentSection({ section: 'payments', sectionVerified: false }) === false,
  'explicitly unverified section is NOT trusted');
ok(E.isParserPaymentSection({ section: 'purchases', sectionVerified: true }) === false,
  'verified purchase section is not a payment section');
ok(E.isParserPaymentSection({}) === false, 'no section is not a payment section');

/* ---------- 4. CIBC verified section -> payment without guessing ---------- */
/* Descriptor deliberately does NOT match the anchored PAYMENT rule, so only
   the parser-verified section can explain the classification. */
const secRow = raw('CIBC PAYMENT', -353000,
  { section: 'payments', sectionVerified: true, statementId: 'st-cibc' });
E.classifyRows([secRow], []);
ok(secRow.kind === 'payment', 'CIBC verified-section row -> payment', secRow.kind);
ok(secRow.kindConfidence >= 0.95, 'verified-section confidence is 0.95', secRow.kindConfidence);
ok(secRow.excluded === 1 && secRow.spendAmountMinor === 0, 'section payment excluded from spend');

/* Generic-parser section without the stamp: never trusted. */
const genRow = raw('RBC STATEMENT ADJUSTMENT', -5000,
  { section: 'payments', statementId: 'st-generic' });
E.classifyRows([genRow], []);
ok(genRow.kind !== 'payment', 'generic payments section row is NOT a payment', genRow.kind);
ok(genRow.kind === 'purchase' && E.purchaseSignContradicts(genRow) === true,
  'generic section row stays a statement credit (money back), not movement', genRow.kind);

/* ---------- 5. sacred: user corrections and rules outrank everything ---------- */
const userFixed = raw('PAYMENT CIBC', -353000,
  { kind: 'purchase', classificationSource: 'user', category: 'other' });
E.classifyRows([userFixed], []);
ok(userFixed.kind === 'purchase', 'user-corrected payment keeps the user kind');
const userSec = raw('CIBC PAYMENT', -353000,
  { section: 'payments', sectionVerified: true, kind: 'purchase', classificationSource: 'user' });
E.classifyRows([userSec], []);
ok(userSec.kind === 'purchase', 'user kind wins over the verified section too');
const ruleRow = raw('PAYMENT CIBC', -353000);
E.classifyRows([ruleRow], [{ id: 'r1', enabled: true, priority: 100,
  matchMerchant: 'PAYMENT CIBC', kind: 'transfer', label: 'test rule' }]);
ok(ruleRow.kind === 'transfer' && ruleRow.classificationSource === 'rule',
  'household rule outranks the payment rules');

/* ---------- 6. end-to-end: refunds + other credits + payments + purchases --- */
/* Umar's CIBC month, plus one store refund: purchases $3,681.53,
   PAYMENT CIBC $3,530.00, APPLE.COM/CA $1,151.47, TELUS PRE-AUTH $105.00,
   store refund $250.00. Expected: gross 368153, refunds 25000,
   other credits 125647, net 217506, payments 353000 (never in net). */
const cibc = [
  classified('GROCERY MART', 200000, { category: 'groceries' }),
  classified('FUEL STOP', 100000, { category: 'transport' }),
  classified('CORNER CAFE', 68153, { category: 'dining' }),
  classified('PAYMENT CIBC', -353000),
  classified('APPLE.COM/CA', -115147, { category: 'shopping' }),
  classified('TELUS PRE-AUTH PAYMENT', -10500, { category: 'utilities' }),
  classified('CORNER CAFE REFUND', -25000, { category: 'dining' }),
];
const rec = E.reconcile(cibc, null);
ok(rec.grossPurchasesMinor === 368153, 'gross purchases = $3,681.53', rec.grossPurchasesMinor);
ok(rec.refundsTotalMinor === 25000, 'refunds = $250.00 (store refund only)', rec.refundsTotalMinor);
ok(rec.refundCount === 1, 'exactly one refund', rec.refundCount);
ok(rec.statementCreditsMinor === 125647, 'other credits = $1,256.47 (Apple + Telus)', rec.statementCreditsMinor);
ok(rec.statementCreditCount === 2, 'two other-credit rows', rec.statementCreditCount);
ok(rec.netSpendMinor === 217506, 'net spend = 368153 - 25000 - 125647 = $2,175.06', rec.netSpendMinor);
ok(rec.paymentsTotalMinor === 353000, 'payments total = $3,530.00', rec.paymentsTotalMinor);
ok(rec.paymentCount === 1, 'one bill payment', rec.paymentCount);
ok(rec.netSpendMinor !== 368153 - 25000 - 125647 - 353000,
  'the $3,530 payment is NOT subtracted from net spend');

/* ---------- 7. buildBriefing facts carry the payment fields ---------- */
const facts = E.buildBriefing(cibc, '2026-07-01', '2026-07-31', null, 'July 2026', null);
ok(facts.paymentsTotalMinor === 353000, 'briefing facts carry paymentsTotalMinor', facts.paymentsTotalMinor);
ok(facts.paymentCount === 1, 'briefing facts carry paymentCount', facts.paymentCount);

/* ---------- 8. briefing text names all three concepts distinctly ---------- */
const text = E.renderBriefingText(facts);
ok(text.indexOf('Bill payments') !== -1 || text.indexOf('bill payments') !== -1,
  'briefing names bill payments', text.slice(0, 400));
ok(text.indexOf('not subtracted') !== -1,
  'briefing says payments are not subtracted');
ok(text.indexOf('Refunds (money back from stores)') !== -1,
  'briefing labels refunds as money back from stores');
ok(text.indexOf('Other credits') !== -1,
  'briefing labels other credits distinctly from refunds');

/* A payment can never manufacture a "net credit": without the fix, Umar's
   statement showed net credit $1,104.94 (payments hidden in credits). */
const noFix = E.reconcile([
  classified('GROCERY MART', 200000),
  classified('FUEL STOP', 100000),
  classified('CORNER CAFE', 68153),
  classified('PAYMENT CIBC', -353000),
  classified('APPLE.COM/CA', -115147),
  classified('TELUS PRE-AUTH PAYMENT', -10500),
], null);
ok(noFix.netSpendMinor === 242506, 'no refunds: net spend = 368153 - 125647 = $2,425.06', noFix.netSpendMinor);
ok(noFix.netSpendMinor > 0, 'net spend stays positive — no phantom net credit', noFix.netSpendMinor);

/* ---------- summary (engine part) ---------- */
const enginePass = pass;
const engineFails = fail;
if (fail === 0) console.log('PASS: payment-refund-clarity-v19 engine (' + pass + ' checks)');

/* ============================================================================
 * App-level tests: tab routing, hero wording, notes, migration.
 * Minimal DOM + in-memory Store shims (same approach as e2e.node.js).
 * ============================================================================ */
function makeEl(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(), children: [], dataset: {}, style: {},
    _innerHTML: '', value: '', files: null, type: '', id: '', className: '',
    set innerHTML(h) { this._innerHTML = String(h); },
    get innerHTML() { return this._innerHTML; },
    setAttribute() {}, getAttribute() { return null; },
    appendChild(c) { this.children.push(c); return c; },
    insertBefore(c) { this.children.unshift(c); return c; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
    focus() {}, click() {}, remove() {}, closest() { return null; },
  };
  return el;
}
global.document = {
  getElementById() { return null; },
  querySelector() { return null; }, querySelectorAll() { return []; },
  createElement(tag) { return makeEl(tag); },
  addEventListener() {}, body: makeEl('body'),
};
global.CSS = { escape: (s) => String(s) };
global.requestAnimationFrame = (fn) => setTimeout(fn, 0);

const memDB = {};
let autoId = 1;
global.Store = {
  async put(store, obj) {
    memDB[store] = memDB[store] || {};
    obj = Object.assign({}, obj);
    if (obj.id === null || obj.id === undefined) obj.id = (obj.key != null ? String(obj.key) : 'id' + (autoId++));
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
  async logAudit() { return 'audit-stub'; },
  async wipeAll() { for (const k of Object.keys(memDB)) memDB[k] = {}; },
};

require(WEB + '/app.js');
const App = global.App;
const T = App._test;
if (!App || !T) { console.error('FAIL: App/_test missing'); process.exit(1); }

/* ---------- 9. txnTab: movement rows surface under Payments & transfers --- */
ok(T.txnTab({ kind: 'payment', excluded: 1 }) === 'payments',
  'excluded payment row tabs to Payments & transfers, not Excluded');
ok(T.txnTab({ kind: 'transfer', excluded: 1 }) === 'payments',
  'excluded transfer row tabs to Payments & transfers');
ok(T.txnTab({ kind: 'fee', excluded: 1 }) === 'payments',
  'excluded fee row tabs to Payments & transfers');
ok(T.txnTab({ kind: 'purchase', excluded: 1 }) === 'excluded',
  'user-excluded purchase still tabs to Excluded');
ok(T.txnTab({ kind: 'refund', excluded: 0, category: 'dining' }) === 'refunds',
  'refund tabs to Refunds');

/* ---------- 10. otherExcluded: payments named once, not twice ---------- */
ok(T.otherExcluded({ excludedTotalMinor: 353000, paymentsTotalMinor: 353000 }) === 0,
  'excluded note nets out the named bill payments', T.otherExcluded({ excludedTotalMinor: 353000, paymentsTotalMinor: 353000 }));
ok(T.otherExcluded({ excludedTotalMinor: 473000, paymentsTotalMinor: 353000 }) === 120000,
  'other exclusions still surface in the excluded note');
ok(T.otherExcluded({}) === 0, 'empty recon -> no excluded note');

/* ---------- 11. hero: three concepts, payments never subtracted ---------- */
const heroHtml = App.headlineHtml({ recon: rec, month: '2026-07', mTxns: cibc, headline: null });
ok(heroHtml.indexOf('Bill payments:') !== -1, 'hero names Bill payments');
ok(heroHtml.indexOf('$3,530.00') !== -1, 'hero shows the $3,530.00 payment total', heroHtml.slice(0, 600));
ok(heroHtml.toLowerCase().indexOf('not subtracted') !== -1, 'hero says payments are not subtracted');
ok(heroHtml.indexOf('other credits') !== -1, 'hero says "other credits"');
ok(heroHtml.toLowerCase().indexOf('statement credits') === -1,
  'hero no longer says "statement credits"', heroHtml.slice(0, 900));
ok(heroHtml.indexOf('refunds (money back from stores)') !== -1,
  'hero labels refunds as money back from stores');
ok(heroHtml.indexOf('$2,175.06') !== -1, 'hero headline is net spend $2,175.06');

/* ---------- 12. refunds note: refund vs other credit vs payment ---------- */
const noteHtml = App.refundsNoteHtml(rec, null);
ok(noteHtml.indexOf('Refunds (money back from stores)') !== -1, 'note labels store refunds');
ok(noteHtml.indexOf('Other credits (money back that is not a store refund)') !== -1,
  'note labels other credits distinctly');
ok(noteHtml.indexOf('Bill payments (what you paid toward the card bill)') !== -1,
  'note labels bill payments distinctly');
ok(noteHtml.indexOf('never subtracted') !== -1, 'note says payments are never subtracted');

/* ---------- 13. migration: verified section, idempotent, sacred ---------- */
async function main() {
  await Store.put('statements', { id: 'st-cibc', templateId: 'cibc_v1' });
  await Store.put('statements', { id: 'st-generic', templateId: 'generic_statement_v1' });
  await Store.put('txns', { id: 't1', statementId: 'st-cibc', merchantRaw: 'PAYMENT CIBC',
    amountMinor: -353000, signConvention: 'pdf-card', kind: 'payment',
    classificationSource: 'builtin', excluded: 1, spendAmountMinor: 0 });
  /* Pre-v19 CIBC payments-table row: builtin, misclassified, section present
     but no verified stamp yet. */
  await Store.put('txns', { id: 't2', statementId: 'st-cibc', merchantRaw: 'CIBC PAYMENT',
    amountMinor: -50000, signConvention: 'pdf-card', kind: 'purchase',
    classificationSource: 'builtin', section: 'payments' });
  /* Generic-parser payments section: must NOT be trusted. */
  await Store.put('txns', { id: 't3', statementId: 'st-generic', merchantRaw: 'RBC STATEMENT ADJUSTMENT',
    amountMinor: -5000, signConvention: 'pdf-card', kind: 'purchase',
    classificationSource: 'builtin', section: 'payments' });
  /* User correction: sacred. */
  await Store.put('txns', { id: 't4', statementId: 'st-cibc', merchantRaw: 'PAYMENT CIBC',
    amountMinor: -20000, signConvention: 'pdf-card', kind: 'purchase',
    classificationSource: 'user', category: 'other' });

  await App.migratePaymentClarity();
  const t1 = await Store.get('txns', 't1');
  const t2 = await Store.get('txns', 't2');
  const t3 = await Store.get('txns', 't3');
  const t4 = await Store.get('txns', 't4');
  ok(t2.kind === 'payment' && t2.sectionVerified === true,
    'CIBC payments-table row reclassified as payment with the verified stamp', t2 && { kind: t2.kind, sv: t2.sectionVerified });
  ok(t3.kind === 'purchase' && t3.sectionVerified !== true,
    'generic payments-section row is NOT trusted (stays a credit)', t3 && t3.kind);
  ok(t4.kind === 'purchase' && t4.classificationSource === 'user',
    'user-corrected row untouched by the migration');
  ok(t1.kind === 'payment', 'already-correct payment row stays a payment');
  ok((await App.prefGet('payclarity_v19')) === '1', 'migration stamps its pref');

  /* Idempotent: second run changes nothing. */
  await Store.put('txns', { id: 't2', statementId: 'st-cibc', merchantRaw: 'CIBC PAYMENT',
    amountMinor: -50000, signConvention: 'pdf-card', kind: 'purchase',
    classificationSource: 'builtin', section: 'payments' });
  await App.prefSet('payclarity_v19', null);
  await App.migratePaymentClarity();
  const t2b = await Store.get('txns', 't2');
  ok(t2b.kind === 'payment', 'migration re-applies cleanly after reset');
  await App.migratePaymentClarity();
  const t2c = await Store.get('txns', 't2');
  ok(t2c.kind === 'payment' && (await App.prefGet('payclarity_v19')) === '1',
    'second run is a no-op (idempotent)');

  if (fail === 0) console.log('PASS: payment-refund-clarity-v19 app (' + (pass - enginePass) + ' checks)');
  finish();
}
function finish() {
  if (fail === 0) console.log('PASS: payment-refund-clarity-v19 (' + pass + ' checks total)');
  else { console.error('FAILURES: ' + fail + ' of ' + (pass + fail)); process.exit(1); }
}
main().catch((e) => { console.error('FAIL: migration test threw', e && e.message); process.exit(1); });
