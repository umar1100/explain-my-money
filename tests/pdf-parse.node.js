/* PDF parser validation: real engine.js + parsers.js via pdf.js in node.
   Synthetic detection checks always run. Real specimen-PDF checks are
   opt-in and local-only (EMM_PRIVATE_PDF_DIR); when that env var is
   unset or the files are missing they are skipped and the suite still
   exits 0, so CI never depends on private data. No real content is
   copied into fixtures or output. Run with node. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB = path.join(__dirname, '..', 'apps/web');
const pdfjsLib = require(path.join(WEB, 'vendor/pdf.min.js'));

/* Private-statement PDFs are opt-in and local-only. They are never
   committed to the repo. Set EMM_PRIVATE_PDF_DIR to a directory holding
   statement.pdf and Account_Statement.pdf to run those checks; otherwise
   they are skipped and the synthetic checks still run (CI-safe). */
const PRIVATE_DIR = process.env.EMM_PRIVATE_PDF_DIR || '';
const PRIVATE_PDFS = [
  ['PC Financial Mastercard', 'statement.pdf', { format: 'pc_financial', templateId: 'pc_world_elite_mc_v1', rows: 117 }],
  ['CIBC Costco World Mastercard', 'Account_Statement.pdf', { format: 'cibc_costco', templateId: 'cibc_costco_world_mc_v1', rows: 54 }],
];

/* ---------- load engine.js + parsers.js into a DOM-less sandbox ---------- */
const sandbox = { console: console };
sandbox.window = sandbox;
sandbox.global = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);
for (const f of ['js/engine.js', 'js/parsers.js']) {
  vm.runInContext(fs.readFileSync(path.join(WEB, f), 'utf8'), sandbox, { filename: f });
}
const Engine = sandbox.Engine;
const Parsers = sandbox.Parsers;
if (!Engine || !Parsers) { console.error('FAIL: Engine/Parsers did not load'); process.exit(1); }

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok   ' + name);
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}

function toArrayBuffer(buf) {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function testFile(label, pdfPath, expected) {
  console.log('== ' + label);
  const buf = fs.readFileSync(pdfPath);
  const res = await Parsers.parsePdf(toArrayBuffer(buf), pdfjsLib);
  check('format detected = ' + expected.format, res.format === expected.format, 'got ' + res.format);
  check('templateId = ' + expected.templateId, res.templateId === expected.templateId, 'got ' + res.templateId);
  check('row count = ' + expected.rows, res.rows.length === expected.rows, 'got ' + res.rows.length);
  check('reported start balance present', typeof res.meta.reported_start_balance_minor === 'number');
  check('reported end balance present', typeof res.meta.reported_end_balance_minor === 'number');
  check('period start/end present', !!res.meta.period_start && !!res.meta.period_end,
    JSON.stringify({ s: res.meta.period_start, e: res.meta.period_end }));

  // Full engine path: normalize (parser-authoritative signing + inferred
  // dates) -> classify -> reconcile against the reported baseline.
  const rows = Engine.normalizeRows(res.rows.map((r) => Object.assign({}, r)));
  const dateErrs = rows.filter((r) => r.date === null).length;
  check('all rows have a parsed date', dateErrs === 0, dateErrs + ' missing');
  const amtErrs = rows.filter((r) => r.amountMinor === null || r.amountMinor === undefined).length;
  check('all rows have an amount', amtErrs === 0, amtErrs + ' missing');
  Engine.classifyRows(rows, []);
  const reported = {
    startMinor: res.meta.reported_start_balance_minor,
    endMinor: res.meta.reported_end_balance_minor
  };
  const rec = Engine.reconcile(rows, reported);
  check('reconcile balanceCheck = ok', rec.balanceCheck === 'ok',
    'got ' + rec.balanceCheck + ' gap=' + rec.gapMinor);
  check('gap is zero', rec.gapMinor === 0, 'gap=' + rec.gapMinor);
  // Briefing honesty path also sees the baseline.
  const facts = Engine.buildBriefing(rows, res.meta.period_start, res.meta.period_end, null, label, reported);
  check('briefing balanceCheck = ok', facts.balanceCheck === 'ok', 'got ' + facts.balanceCheck);
  return { res, rows, rec };
}

(async () => {
  // Private PDFs: run only when explicitly pointed at; never required.
  let privateRan = 0;
  for (const [label, file, expected] of PRIVATE_PDFS) {
    const pdfPath = PRIVATE_DIR ? path.join(PRIVATE_DIR, file) : null;
    if (pdfPath && fs.existsSync(pdfPath)) {
      await testFile(label, pdfPath, expected);
      privateRan++;
    } else {
      console.log('== ' + label);
      console.log('  skipped: private PDFs not available (set EMM_PRIVATE_PDF_DIR to the directory holding ' + file + ')');
    }
  }
  console.log('  private-PDF checks run: ' + privateRan + ' (opt-in, local-only)');

  // Detection negatives: garbage must not claim a template.
  check('detectFormat rejects unknown text', Parsers.detectFormat('Monthly bank statement\nRandom Corp') === null);
  check('detectFormat detects PC markers',
    Parsers.detectFormat("President's Choice Financial\nWorld Elite Mastercard\nStatement date:") === 'pc_financial');
  check('detectFormat detects CIBC markers',
    Parsers.detectFormat('CIBC Costco World Mastercard\nStatement Date') === 'cibc_costco');

  console.log(failures === 0 ? '\nALL PDF PARSE CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e && e.stack || e); process.exit(1); });
