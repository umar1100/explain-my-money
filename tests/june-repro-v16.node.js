/* June-2026 reproduction (v16): Umar's June screen showed three incompatible
   "spend" numbers for the same month —
     hero / briefing "You spent":        $8,209.45  (raw signed sum)
     visible category bars summed:      $14,951.02  (gross - refunds)
     receipt denominator:               $15,749.43  (purchase magnitudes)
   plus movers "up $X" with no May baseline.
   Fixture: tests/fixtures/june2026-v16.js (fictional 37-transaction June
   ledger, President's Choice style card, mixed PDF-positive and CSV-negative
   conventions). This suite proves the fixture reproduces the bug class and
   that v16 resolves it to one canonical computation. Run with node. */
'use strict';
const path = require('path');
const WEB = path.join(__dirname, '..', 'apps/web/js');
global.window = global;
require(WEB + '/engine.js');
const E = global.Engine;
if (!E) { console.error('FAIL: Engine missing'); process.exit(1); }
const J = require('./fixtures/june2026-v16.js');
const EXP = J.EXPECTED;

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; }
  else { fail++; console.error('FAIL:', name, extra === undefined ? '' : JSON.stringify(extra)); }
}

const txns = J.juneTxns();
ok(txns.length === EXP.count, 'fixture: 37 transactions', txns.length);

const recon = E.reconcile(txns, null);
ok(recon.grossPurchasesMinor === EXP.grossMinor, 'canonical gross = $15,749.43', recon.grossPurchasesMinor);
ok(recon.refundsTotalMinor === EXP.refundsMinor, 'canonical refunds = $798.41', recon.refundsTotalMinor);
ok(recon.netSpendMinor === EXP.netMinor, 'canonical net = $14,951.02', recon.netSpendMinor);
ok(recon.refundsTotalMinor >= 0, 'refunds never negative');
ok(recon.unresolvedCount === 0, 'no uncertain rows (briefing honesty rule needs zero to print a final number)', recon.unresolvedCount);

/* The OLD signed-sum math on this exact ledger produces the ~$8,209.45 hero. */
const rawSigned = txns
  .filter((t) => (t.kind === 'purchase' || t.kind === 'refund') && !t.excluded && t.status !== 'duplicate')
  .reduce((s, t) => s + (t.amountMinor || 0), 0);
ok(rawSigned === EXP.oldSignedHeroMinor, 'old signed-sum math gives $8,209.44 (one cent off the reported $8,209.45)', rawSigned);
ok(rawSigned !== recon.grossPurchasesMinor, 'signed sum != canonical gross: bug class reproduced');
ok(rawSigned !== recon.netSpendMinor, 'signed sum != canonical net: bug class reproduced');

/* Category bars: net-of-refunds, sum to canonical net. */
const cats = E.totalsByCategory(txns).totals;
for (const k of Object.keys(EXP.bars)) {
  ok(cats[k] === EXP.bars[k], k + ' bar', cats[k]);
}
const barSum = Object.keys(cats).reduce((s, k) => s + cats[k], 0);
ok(barSum === recon.netSpendMinor, 'category bars sum EXACTLY to canonical net', { barSum: barSum, net: recon.netSpendMinor });

/* Drill-down consistency: members of a category sum to its bar. */
const members = E.categoryMembers(txns, 'shopping');
const memberSum = members.reduce((s, m) => s + m.shareMinor, 0);
ok(memberSum === cats.shopping, 'shopping drill-down sums to shopping bar', memberSum);
ok(members.filter((m) => m.kind === 'purchase').every((m) => m.shareMinor > 0), 'purchase drill-down shares are magnitudes (never negative)');
ok(members.filter((m) => m.kind === 'refund').every((m) => m.shareMinor < 0), 'refund drill-down shares reduce the bar (canonical negative)');

/* Receipt denominator == canonical gross over the same rows. */
const cov = E.coverageOfTxns(txns, []);
ok(cov.grossMinor === recon.grossPurchasesMinor, 'receipt denominator == canonical gross ($15,749.43)', cov.grossMinor);
ok(cov.grossMinor === EXP.grossMinor, 'receipt denominator exact', cov.grossMinor);

/* Same logical ledger stored entirely PDF-style gives identical totals.
   v17: converting the storage convention means converting the provenance
   stamp too — a real PDF import carries both together. */
const allPdf = txns.map((t) => {
  const c = Object.assign({}, t);
  c.signConvention = 'pdf-card';
  if (c.kind === 'purchase') c.amountMinor = Math.abs(c.amountMinor);
  if (c.kind === 'refund') c.amountMinor = -Math.abs(c.amountMinor);
  return c;
});
const reconPdf = E.reconcile(allPdf, null);
ok(reconPdf.grossPurchasesMinor === recon.grossPurchasesMinor &&
   reconPdf.refundsTotalMinor === recon.refundsTotalMinor &&
   reconPdf.netSpendMinor === recon.netSpendMinor, 'all-PDF storage gives identical canonical totals');

/* Briefing: one set of numbers, magnitudes only. */
const facts = E.buildBriefing(txns, '2026-06-01', '2026-06-30', null, 'June 2026', null);
const btext = E.renderBriefingText(facts);
ok(btext.indexOf('-$') === -1, 'briefing never prints -$');
ok(btext.indexOf('You spent $14,951.02 in June 2026') !== -1, 'briefing headline = canonical net', btext.split('\n')[0]);
ok(btext.indexOf('after $798.41 in refunds') !== -1, 'briefing refunds magnitude');
ok(btext.indexOf('Gross purchases before refunds: $15,749.43') !== -1, 'briefing gross magnitude');
ok(btext.indexOf('Card payments and transfers are money movement, not spending') !== -1, 'briefing states movement policy');

/* Hero build-up resolves: gross - refunds = net (no unexplained gap). */
ok(recon.grossPurchasesMinor - recon.refundsTotalMinor === recon.netSpendMinor, 'hero build-up resolves exactly');

console.log('\nJUNE-REPRO-V16: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
