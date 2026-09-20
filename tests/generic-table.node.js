/* Generic layout-inference statement reader: validation for
   apps/web/js/generic-table.js (pure ES2019, DOM-less). Synthetic fixture
   checks always run. Real specimen-PDF checks are opt-in and local-only
   (EMM_PRIVATE_PDF_DIR); when that env var is unset or the files are
   missing they are skipped and the suite still exits 0, so CI never
   depends on private data. No real content is copied into fixtures or
   output. Run with node. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB = path.join(__dirname, '..', 'apps/web');
const pdfjsLib = require(path.join(WEB, 'vendor/pdf.min.js'));

const PRIVATE_DIR = process.env.EMM_PRIVATE_PDF_DIR || '';

/* ---------- load generic-table.js (+ parsers.js for real PDFs) ---------- */
const sandbox = { console: console };
sandbox.window = sandbox;
sandbox.global = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(WEB, 'js/generic-table.js'), 'utf8'), sandbox,
  { filename: 'js/generic-table.js' });
vm.runInContext(fs.readFileSync(path.join(WEB, 'js/parsers.js'), 'utf8'), sandbox,
  { filename: 'js/parsers.js' });
const GenericTable = sandbox.GenericTable;
const Parsers = sandbox.Parsers;
if (!GenericTable) { console.error('FAIL: GenericTable did not load'); process.exit(1); }

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok   ' + name);
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}

/* ---------- synthetic fragment builders (y-up points, like pdf.js) ---------- */
function F(x, y, str) { return { x: x, y: y, str: str }; }
// line(y, x1, s1, x2, s2, ...) — one y-band, fragments left to right.
function line(y) {
  const frags = [];
  for (let i = 1; i < arguments.length; i += 2) frags.push(F(arguments[i], y, arguments[i + 1]));
  return frags;
}
function page() {
  let frags = [];
  for (const ln of arguments) frags = frags.concat(ln);
  return frags;
}
const hasNote = (out, sub) => out.notes.some((n) => n.indexOf(sub) !== -1);

/* ================= Test A: header + sections of row shapes ================= */
console.log('== A: charges/payments columns, wrapped desc, CR, parens, TOTAL merchant');
(function () {
  const p = page(
    line(700, 50, 'For the period: July 28, 2026 to August 27, 2026'),
    line(680, 50, 'Transaction date', 110, 'Posting date', 170, 'Description', 380, 'Charges', 460, 'Payments'),
    line(660, 50, 'Aug 22', 110, 'Aug 24', 170, 'FUEL STOP 123', 380, '29.95'),
    line(644, 50, 'Aug 23', 110, 'Aug 25', 170, 'AMAZON MARKETPLACE', 380, '45.67'),
    line(632, 170, 'SEATTLE WA'),
    line(616, 50, 'Aug 24', 110, 'Aug 26', 170, 'REFUND SHOPIFY', 460, '25.00CR'),
    line(600, 50, 'Aug 25', 110, 'Aug 27', 170, 'RETURNED ITEM', 460, '(12.34)'),
    line(584, 50, 'Aug 20', 110, 'Aug 21', 170, 'TOTAL PETROLEUM', 380, '50.00'),
    line(568, 50, 'Total charges $125.62')
  );
  const out = GenericTable.parse([p]);
  check('row count = 5', out.rows.length === 5, 'got ' + out.rows.length);
  const byDesc = {};
  out.rows.forEach((r) => { byDesc[r.description] = r; });
  const fuel = byDesc['FUEL STOP 123'];
  check('fuel row parsed', !!fuel);
  check('fuel amount +2995', fuel && fuel.amountMinor === 2995, JSON.stringify(fuel));
  check('Aug 22 year inferred 2026-08-22', fuel && fuel.date === '2026-08-22', fuel && fuel.date);
  check('posting date 2026-08-24', fuel && fuel.postingDate === '2026-08-24', fuel && fuel.postingDate);
  const amz = byDesc['AMAZON MARKETPLACE SEATTLE WA'];
  check('wrapped description joined', !!amz, JSON.stringify(Object.keys(byDesc)));
  check('AMAZON amount +4567', amz && amz.amountMinor === 4567, amz && amz.amountMinor);
  const cr = byDesc['REFUND SHOPIFY'];
  check('CR suffix -> -2500', cr && cr.amountMinor === -2500, cr && cr.amountMinor);
  check('CR signSource explicit', cr && cr.signSource === 'explicit', cr && cr.signSource);
  const par = byDesc['RETURNED ITEM'];
  check('parens -> -1234', par && par.amountMinor === -1234, par && par.amountMinor);
  const tot = byDesc['TOTAL PETROLEUM'];
  check('TOTAL PETROLEUM kept as a real merchant row', !!tot && tot.amountMinor === 5000,
    JSON.stringify(tot));
  check('stated purchase total captured', out.anchors.totalsBySection.purchases === 12562,
    JSON.stringify(out.anchors.totalsBySection));
  check('no recon warning when totals match', !hasNote(out, 'rows do not reconcile'),
    JSON.stringify(out.notes));
  check('period anchors', out.anchors.periodStart === '2026-07-28' && out.anchors.periodEnd === '2026-08-27',
    JSON.stringify({ s: out.anchors.periodStart, e: out.anchors.periodEnd }));
  check('no row needs review', out.rows.every((r) => !r.needsReview));
})();

/* ================= Test B: reconciliation mismatch ================= */
console.log('== B: stated total mismatch is flagged, never silently accepted');
(function () {
  const p = page(
    line(700, 50, 'Aug 22', 110, 'Aug 24', 170, 'STORE A', 380, '10.00'),
    line(684, 50, 'Total purchases $9.50')
  );
  const out = GenericTable.parse([p]);
  check('row count = 1', out.rows.length === 1, 'got ' + out.rows.length);
  check('exact recon note present',
    hasNote(out, 'rows do not reconcile with stated total — needs review'),
    JSON.stringify(out.notes));
  check('confidence downgraded below 0.9', out.confidence < 0.9, 'got ' + out.confidence);
})();

/* ================= Test C: headerless table, dd/mm slash dates ================= */
console.log('== C: headerless table, slash-date orientation vote');
(function () {
  const p = page(
    line(660, 46, '08/22', 93, '08/24', 140, 'STORE ABC', 338, '$15.73'),
    line(644, 46, '08/23', 93, '08/25', 140, 'STORE DEF', 338, '$20.00')
  );
  const out = GenericTable.parse([p]);
  check('row count = 2', out.rows.length === 2, 'got ' + out.rows.length);
  const yr = String(new Date().getFullYear());
  check('08/22 read as dd/mm', out.rows[0].date === yr + '-08-22', out.rows[0].date);
  check('08/23 read as dd/mm', out.rows[1].date === yr + '-08-23', out.rows[1].date);
  check('amounts parsed', out.rows[0].amountMinor === 1573 && out.rows[1].amountMinor === 2000,
    JSON.stringify(out.rows.map((r) => r.amountMinor)));
  check('descriptions parsed', out.rows[0].description === 'STORE ABC' && out.rows[1].description === 'STORE DEF',
    JSON.stringify(out.rows.map((r) => r.description)));
  check('headerless note present', hasNote(out, 'no table header recognised'),
    JSON.stringify(out.notes));
})();

/* ================= Test D: payment / purchase sections ================= */
console.log('== D: section-aware signing (Your payments)');
(function () {
  const p = page(
    line(700, 50, 'Your payments'),
    line(684, 50, 'Mar 10', 93, 'Mar 12', 140, 'PAYMENT THANK YOU', 504, '433.27'),
    line(668, 50, 'Your new charges and credits'),
    line(652, 50, 'Mar 15', 93, 'Mar 16', 140, 'STORE XYZ', 504, '100.00')
  );
  const out = GenericTable.parse([p]);
  check('row count = 2', out.rows.length === 2, 'got ' + out.rows.length);
  const pay = out.rows[0], pur = out.rows[1];
  check('payment row negative by section', pay.amountMinor === -43327 && pay.section === 'payments',
    JSON.stringify({ a: pay.amountMinor, s: pay.section }));
  check('payment signSource section', pay.signSource === 'section', pay.signSource);
  check('purchase row positive', pur.amountMinor === 10000 && pur.section === 'purchases',
    JSON.stringify({ a: pur.amountMinor, s: pur.section }));
})();

/* ================= Test E: wrapped amount (pending) ================= */
console.log('== E: amount wrapped onto the next line');
(function () {
  const p = page(
    line(700, 50, 'Transaction date', 110, 'Posting date', 170, 'Description', 380, 'Amount'),
    line(684, 50, 'Aug 22', 110, 'Aug 24', 170, 'WRAPPED AMOUNT STORE'),
    line(672, 380, '$33.33')
  );
  const out = GenericTable.parse([p]);
  check('row count = 1', out.rows.length === 1, 'got ' + out.rows.length);
  const r = out.rows[0];
  check('wrapped amount adopted', r && r.amountMinor === 3333, r && r.amountMinor);
  check('description from date line', r && r.description === 'WRAPPED AMOUNT STORE', r && r.description);
})();

/* ================= Test F: refund keyword ================= */
console.log('== F: refund wording flips sign but flags for review');
(function () {
  const p = page(
    line(700, 50, 'Transaction date', 110, 'Posting date', 170, 'Description', 380, 'Amount'),
    line(684, 50, 'Aug 22', 110, 'Aug 24', 170, 'REFUND ISSUED', 380, '10.00')
  );
  const out = GenericTable.parse([p]);
  check('row count = 1', out.rows.length === 1, 'got ' + out.rows.length);
  const r = out.rows[0];
  check('refund -> -1000', r && r.amountMinor === -1000, r && r.amountMinor);
  check('refund-word signSource', r && r.signSource === 'refund-keyword', r && r.signSource);
  check('flagged for review, never silently trusted',
    r && r.needsReview === true && /refund/i.test(r.reviewReason),
    JSON.stringify(r && { nr: r.needsReview, rr: r.reviewReason }));
})();

/* ================= Test G: Dec/Jan year rollback ================= */
console.log('== G: December transaction in a January-ending period rolls back a year');
(function () {
  const p = page(
    line(700, 50, 'For the period: December 20, 2025 to January 19, 2026'),
    line(680, 50, 'Transaction date', 170, 'Description', 380, 'Amount'),
    line(660, 50, 'Dec 28', 110, 'Dec 29', 170, 'STORE Z', 380, '5.00')
  );
  const out = GenericTable.parse([p]);
  check('row count = 1', out.rows.length === 1, 'got ' + out.rows.length);
  check('Dec 28 -> 2025-12-28', out.rows[0] && out.rows[0].date === '2025-12-28',
    out.rows[0] && out.rows[0].date);
})();

/* ================= Test H: integer minor units ================= */
console.log('== H: amounts are integer minor units ($1,234.56 -> 123456)');
(function () {
  const p = page(
    line(700, 50, 'Aug 22', 170, 'BIG STORE', 380, '$1,234.56')
  );
  const out = GenericTable.parse([p]);
  check('row count = 1', out.rows.length === 1, 'got ' + out.rows.length);
  check('$1,234.56 -> 123456', out.rows[0] && out.rows[0].amountMinor === 123456,
    out.rows[0] && out.rows[0].amountMinor);
  check('integer, no float residue', out.rows[0] && Number.isInteger(out.rows[0].amountMinor));
})();

/* ================= Test I: parseFrags shape ({page,x,y,cx,text}) ================= */
console.log('== I: parseFrags accepts the Parsers.collectPageItems shape');
(function () {
  const frags = [
    { page: 1, x: 50, y: 700, cx: 60, text: 'Transaction date' },
    { page: 1, x: 170, y: 700, cx: 200, text: 'Description' },
    { page: 1, x: 380, y: 700, cx: 400, text: 'Amount' },
    { page: 1, x: 50, y: 684, cx: 60, text: 'Aug 22' },
    { page: 1, x: 170, y: 684, cx: 200, text: 'FRAG STORE' },
    { page: 1, x: 380, y: 684, cx: 400, text: '7.77' },
  ];
  const out = GenericTable.parseFrags(frags);
  check('row count = 1', out.rows.length === 1, 'got ' + out.rows.length);
  check('row parsed', out.rows[0] && out.rows[0].amountMinor === 777 && out.rows[0].description === 'FRAG STORE',
    JSON.stringify(out.rows[0]));
})();

/* ================= Test J: headerless two-column table ================= */
/* Without header guidance the charge/payment split is positional: the
   right column reads as payments/credits (negative) and BOTH rows are
   low-confidence review items — never silently trusted. */
console.log('== J: headerless two-column table is positional and review-flagged');
(function () {
  const p = page(
    line(700, 50, 'Statement period: Mar 01, 2026 - Mar 31, 2026'),
    line(660, 50, 'Mar 05', 150, 'GROCERY STORE', 400, '45.67'),
    line(644, 50, 'Mar 07', 150, 'PAYMENT THANK YOU', 520, '200.00')
  );
  const out = GenericTable.parse([p]);
  check('row count = 2', out.rows.length === 2, 'got ' + out.rows.length);
  check('left column positive', out.rows[0] && out.rows[0].amountMinor === 4567,
    JSON.stringify(out.rows[0]));
  check('right column negative', out.rows[1] && out.rows[1].amountMinor === -20000,
    JSON.stringify(out.rows[1]));
  check('both rows need review', out.rows.every((r) => r.needsReview),
    JSON.stringify(out.rows.map((r) => [r.confidence, r.needsReview])));
  check('descriptions kept', out.rows[0].description === 'GROCERY STORE' &&
    out.rows[1].description === 'PAYMENT THANK YOU',
    JSON.stringify(out.rows.map((r) => r.description)));
})();

/* ================= Test K: summary date-range lines are never rows ================= */
/* "Payments received Jul 28 to Aug 27, 2026 0.00" carries a date and an
   amount but is statement-summary language — it must be excluded, not
   parsed as a transaction, and must not define the date columns. */
console.log('== K: summary date-range lines are excluded');
(function () {
  const p = page(
    line(700, 50, 'For the period: July 28, 2026 to August 27, 2026'),
    line(680, 50, 'Payments received Jul 28 to Aug 27, 2026', 400, '0.00'),
    line(660, 50, 'Transaction date', 150, 'Description', 400, 'Amount ($)'),
    line(644, 50, 'Aug 22', 150, 'FUEL STOP 123', 400, '29.95')
  );
  const out = GenericTable.parse([p]);
  check('only the real row parsed', out.rows.length === 1, 'got ' + out.rows.length);
  check('real row intact', out.rows[0] && out.rows[0].amountMinor === 2995 &&
    out.rows[0].description === 'FUEL STOP 123',
    JSON.stringify(out.rows[0]));
  check('summary line excluded with reason',
    out.excluded.some((e) => e.reason === 'summary date-range line'),
    JSON.stringify(out.excluded.map((e) => e.reason)));
})();

/* ================= Real-PDF checks (opt-in, local-only) ================= */
async function collectFrags(pdfPath) {
  const buf = fs.readFileSync(pdfPath);
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
  const frags = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const pf = await Parsers.collectPageItems(pdf, p);
    pf.forEach((f) => frags.push(f));
  }
  return frags;
}
function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}
// date+amount agreement between generic rows and the validated template rows
async function agreement(label, pdfPath, minRatio) {
  const frags = await collectFrags(pdfPath);
  const g = GenericTable.parseFrags(frags);
  const buf = fs.readFileSync(pdfPath);
  const t = await Parsers.parsePdf(toArrayBuffer(buf), pdfjsLib);
  const tleft = new Map();
  t.rows.forEach((r) => {
    const k = (r.dateInferred || r.date) + '|' + r.signedAmountMinor;
    tleft.set(k, (tleft.get(k) || 0) + 1);
  });
  let match = 0;
  g.rows.forEach((r) => {
    const k = r.date + '|' + r.amountMinor;
    if (tleft.get(k) > 0) { tleft.set(k, tleft.get(k) - 1); match++; }
  });
  const total = Math.max(g.rows.length, t.rows.length);
  const ratio = total ? match / total : 1;
  check(label + ' generic/template date+amount agreement >= ' + Math.round(minRatio * 100) + '%',
    ratio >= minRatio, match + '/' + total);
  return { generic: g, template: t };
}

async function realPdfChecks() {
  console.log('== real PDFs (opt-in)');
  if (!PRIVATE_DIR) { console.log('  skip: EMM_PRIVATE_PDF_DIR not set'); return; }
  // Privacy: these checks assert structural properties only (row counts,
  // agreement ratios, presence/shape of anchors). Exact balances, dates,
  // merchants, and totals from private statements must never be copied
  // into this file.
  const tri = path.join(PRIVATE_DIR, 'eStatement_August2026_EN.pdf');
  if (fs.existsSync(tri)) {
    console.log('-- Triangle');
    const g = GenericTable.parseFrags(await collectFrags(tri));
    check('Triangle rows = 1', g.rows.length === 1, 'got ' + g.rows.length);
    const r = g.rows[0] || {};
    check('Triangle description non-empty', typeof r.description === 'string' && r.description.length > 0,
      JSON.stringify(r.description));
    check('Triangle single positive purchase', typeof r.amountMinor === 'number' && r.amountMinor > 0,
      r.amountMinor);
    check('Triangle date well-formed', /^\d{4}-\d{2}-\d{2}$/.test(r.date || ''), r.date);
    check('Triangle posting date well-formed', /^\d{4}-\d{2}-\d{2}$/.test(r.postingDate || ''), r.postingDate);
    check('Triangle new balance present', Number.isFinite(g.anchors.newBalanceMinor));
    check('Triangle period present and ordered',
      !!g.anchors.periodStart && !!g.anchors.periodEnd && g.anchors.periodStart < g.anchors.periodEnd);
    check('Triangle due date present', !!g.anchors.dueDate);
  } else console.log('  skip: Triangle PDF not found');

  const pc = path.join(PRIVATE_DIR, 'statement.pdf');
  if (fs.existsSync(pc)) {
    console.log('-- PC Financial');
    const { generic: g } = await agreement('PC', pc, 0.98);
    check('PC rows = 117', g.rows.length === 117, 'got ' + g.rows.length);
    let gross = 0;
    g.rows.forEach((r) => { if (r.section === 'purchases' && r.amountMinor > 0) gross += r.amountMinor; });
    check('PC purchase gross positive', gross > 0, gross);
    check('PC new balance present', Number.isFinite(g.anchors.newBalanceMinor));
    check('PC due date present', !!g.anchors.dueDate);
  } else console.log('  skip: PC PDF not found');

  const cibc = path.join(PRIVATE_DIR, 'Account_Statement.pdf');
  if (fs.existsSync(cibc)) {
    console.log('-- CIBC');
    const { generic: g } = await agreement('CIBC', cibc, 0.98);
    check('CIBC rows = 54', g.rows.length === 54, 'got ' + g.rows.length);
    check('CIBC due date present', !!g.anchors.dueDate);
    check('CIBC new balance present', Number.isFinite(g.anchors.newBalanceMinor));
  } else console.log('  skip: CIBC PDF not found');
}

(async () => {
  await realPdfChecks();
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', (e && e.stack) || e); process.exit(1); });
