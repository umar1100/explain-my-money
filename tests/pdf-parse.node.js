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
  // Unknown layout: parsed by the generic layout-inference engine
  // (format generic_statement / template generic_statement_v1).
  ['Triangle Mastercard (generic layout)', 'eStatement_August2026_EN.pdf', { format: 'generic_statement', templateId: 'generic_statement_v1', rows: 1 }],
];

/* ---------- load engine.js + parsers.js into a DOM-less sandbox ---------- */
const sandbox = { console: console };
sandbox.window = sandbox;
sandbox.global = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);
for (const f of ['js/engine.js', 'js/generic-table.js', 'js/parsers.js']) {
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

  // Statement dates spelled out with full month names (seen in the wild:
  // "Statement date: July 16, 2026") must parse, not throw "unknown month".
  const I = Parsers._internals || {};
  if (typeof I.pcParseLongDate === 'function') {
    const pcDate = (s) => { try { return I.pcParseLongDate(s); } catch (e) { return 'THROW:' + e.message; } };
    check('pc: full month name parses', pcDate('July 16, 2026') === '2026-07-16', pcDate('July 16, 2026'));
    check('pc: abbreviation still parses', pcDate('Jul 16, 2026') === '2026-07-16', pcDate('Jul 16, 2026'));
    check('pc: dotted abbreviation still parses', pcDate('Jul. 16, 2026') === '2026-07-16', pcDate('Jul. 16, 2026'));
    const allMonths = ['January 3, 2025', 'February 14, 2025', 'March 1, 2025', 'April 30, 2025',
      'May 5, 2025', 'June 6, 2025', 'July 16, 2026', 'August 8, 2025', 'September 9, 2025',
      'October 10, 2025', 'November 11, 2025', 'December 25, 2025'];
    check('pc: all 12 full month names parse',
      allMonths.every((s) => !/^THROW/.test(pcDate(s))),
      JSON.stringify(allMonths.filter((s) => /^THROW/.test(pcDate(s)))));
  } else {
    check('pcParseLongDate exposed in _internals', false, 'not exposed');
  }
  if (typeof I.cibcParseLongDate === 'function') {
    const cibcDate = (s) => { try { return I.cibcParseLongDate(s); } catch (e) { return 'THROW:' + e.message; } };
    check('cibc: full month name parses', cibcDate('July 16, 2026') === '2026-07-16', cibcDate('July 16, 2026'));
  }

  // PC: foreign-currency detail printed as ONE line (amount + code + rate),
  // e.g. "5.25 USA 1.445714285" — seen in the wild with no standalone
  // currency-code line before it. It belongs to the row above and must not
  // pause the import as "could not be parsed".
  if (Parsers.PC && typeof Parsers.PC.parseTextLines === 'function') {
    // Rolling 3-line header: the third line completes the detection
    // window and is consumed as the header.
    const pcTableHead = [
      { page: 1, text: 'Account activity' },
      { page: 1, text: 'Transaction history' },
      { page: 1, text: 'dd/mm dd/mm Description Amount' },
    ];
    const fxOneLine = [
      ...pcTableHead,
      { page: 1, text: '16/07 16/07 FOREIGN PURCHASE $7.60' },
      { page: 1, text: '5.25 USA 1.445714285' },
      { page: 1, text: '15/07 15/07 GROCERY STORE $120.00' },
    ];
    const r1 = Parsers.PC.parseTextLines(fxOneLine);
    check('pc: one-line FX detail does not pause import',
      r1.unparsed.length === 0 && r1.rows.length === 2,
      JSON.stringify(r1.unparsed.map((u) => u.text)));
    check('pc: one-line FX detail attaches to the row above',
      r1.rows[0] && r1.rows[0].rawDescription.indexOf('5.25 USA 1.445714285') !== -1 &&
        r1.rows[0].signedAmountMinor === 760,
      r1.rows[0] ? r1.rows[0].rawDescription : 'no row');
    check('pc: following row is untouched by FX line',
      r1.rows[1] && r1.rows[1].rawDescription === 'GROCERY STORE',
      r1.rows[1] ? r1.rows[1].rawDescription : 'no row');
    // Same line after a standalone currency-code line: the rate is consumed,
    // no dangling armed state leaks into the next row.
    const r2 = Parsers.PC.parseTextLines([
      ...pcTableHead,
      { page: 1, text: '16/07 16/07 FOREIGN PURCHASE $7.60' },
      { page: 1, text: 'USD' },
      { page: 1, text: '5.25 USD 1.445714285' },
      { page: 1, text: '15/07 15/07 GROCERY STORE $120.00' },
    ]);
    check('pc: one-line FX detail after code line attaches cleanly',
      r2.unparsed.length === 0 && r2.rows.length === 2 &&
        r2.rows[0].rawDescription.indexOf('5.25 USD 1.445714285') !== -1 &&
        r2.rows[1].rawDescription === 'GROCERY STORE',
      JSON.stringify(r2.unparsed.map((u) => u.text)));
    // Negative: with no row above (or a row on another page) we still refuse
    // to guess — the line must be flagged, not silently attached.
    const r3 = Parsers.PC.parseTextLines([
      ...pcTableHead,
      { page: 1, text: '5.25 USA 1.445714285' },
    ]);
    check('pc: one-line FX detail with no row above is still flagged',
      r3.unparsed.length === 1 && r3.rows.length === 0,
      'unparsed=' + r3.unparsed.length + ' rows=' + r3.rows.length);
    const r4 = Parsers.PC.parseTextLines([
      ...pcTableHead,
      { page: 1, text: '16/07 16/07 FOREIGN PURCHASE $7.60' },
      { page: 2, text: '5.25 USA 1.445714285' },
    ]);
    check('pc: one-line FX detail on another page is still flagged',
      r4.unparsed.length === 1,
      'unparsed=' + r4.unparsed.length);
  }

  /* ---------- generic template: synthetic PDFs (hand-built, zero deps) ---------- */
  console.log('== generic template (synthetic PDFs)');

  function escPdfText(s) {
    return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  }
  // pages: array of pages; each page = [{x, y, text}] with y in points from
  // the bottom of a US-Letter page. Produces a minimal but valid PDF that
  // the vendored pdf.js can extract text positions from.
  function makePdf(pages) {
    const chunks = ['%PDF-1.4'];
    const offsets = {};
    const bodyLen = () => Buffer.byteLength(chunks.join('\n') + '\n', 'latin1');
    const addObj = (num, body) => { offsets[num] = bodyLen(); chunks.push(num + ' 0 obj', body, 'endobj'); };
    const n = pages.length;
    const pageNums = [], contentNums = [];
    let next = 4;
    for (let i = 0; i < n; i++) { pageNums.push(next++); contentNums.push(next++); }
    addObj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    addObj(2, '<< /Type /Pages /Kids [' + pageNums.map((p) => p + ' 0 R').join(' ') + '] /Count ' + n + ' >>');
    addObj(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
    for (let i = 0; i < n; i++) {
      let stream = '';
      for (const it of pages[i]) {
        stream += 'BT /F1 11 Tf 1 0 0 1 ' + it.x + ' ' + it.y + ' Tm (' + escPdfText(it.text) + ') Tj ET\n';
      }
      const len = Buffer.byteLength(stream, 'latin1');
      addObj(pageNums[i], '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ' +
        '/Resources << /Font << /F1 3 0 R >> >> /Contents ' + contentNums[i] + ' 0 R >>');
      addObj(contentNums[i], '<< /Length ' + len + ' >>\nstream\n' + stream + 'endstream');
    }
    const xrefOff = bodyLen();
    const maxObj = next - 1;
    chunks.push('xref', '0 ' + (maxObj + 1), '0000000000 65535 f ');
    for (let i = 1; i <= maxObj; i++) chunks.push(String(offsets[i]).padStart(10, '0') + ' 00000 n ');
    chunks.push('trailer', '<< /Size ' + (maxObj + 1) + ' /Root 1 0 R >>', 'startxref', String(xrefOff), '%%EOF');
    return Buffer.from(chunks.join('\n'), 'latin1');
  }
  async function parseSynthetic(pages, onProgress) {
    const buf = makePdf(pages);
    return Parsers.parsePdf(toArrayBuffer(buf), pdfjsLib, onProgress);
  }

  // Fictional two-column bank statement: Charges | Payments columns.
  const twoCol = [[
    { x: 72, y: 740, text: 'Northstar Bank' },
    { x: 72, y: 724, text: 'Monthly statement' },
    { x: 72, y: 708, text: 'Statement period: Mar 01, 2026 - Mar 31, 2026' },
    { x: 72, y: 690, text: 'Previous balance 1,000.00' },
    { x: 72, y: 660, text: 'Date' }, { x: 150, y: 660, text: 'Description' },
    { x: 400, y: 660, text: 'Charges' }, { x: 520, y: 660, text: 'Payments' },
    { x: 72, y: 640, text: 'Mar 05' }, { x: 150, y: 640, text: 'GROCERY STORE' }, { x: 400, y: 640, text: '45.67' },
    { x: 72, y: 622, text: 'Mar 07' }, { x: 150, y: 622, text: 'PAYMENT THANK YOU' }, { x: 520, y: 622, text: '200.00' },
    { x: 72, y: 604, text: 'Mar 12' }, { x: 150, y: 604, text: 'COFFEE SHOP' }, { x: 400, y: 604, text: '4.50' },
    { x: 72, y: 586, text: 'Mar 20' }, { x: 150, y: 586, text: 'REFUND ISSUED' }, { x: 400, y: 586, text: '(12.00)' },
    { x: 72, y: 560, text: 'New balance 838.17' },
    { x: 72, y: 100, text: 'Page 1 of 1' },
  ]];
  const progCalls = [];
  const g2 = await parseSynthetic(twoCol, (p, np) => progCalls.push([p, np]));
  check('generic: format', g2.format === 'generic_statement', 'got ' + g2.format);
  check('generic: templateId', g2.templateId === 'generic_statement_v1', 'got ' + g2.templateId);
  check('generic: 4 rows', g2.rows.length === 4, 'got ' + g2.rows.length);
  check('generic: two-column signs', JSON.stringify(g2.rows.map((r) => r.signedAmountMinor)) === '[4567,-20000,450,-1200]',
    JSON.stringify(g2.rows.map((r) => r.signedAmountMinor)));
  check('generic: description kept', g2.rows[0].rawDescription === 'GROCERY STORE', JSON.stringify(g2.rows[0].rawDescription));
  check('generic: year inferred from period', g2.rows[0].dateInferred === '2026-03-05', 'got ' + g2.rows[0].dateInferred);
  check('generic: period meta', g2.meta.period_start === '2026-03-01' && g2.meta.period_end === '2026-03-31',
    JSON.stringify({ s: g2.meta.period_start, e: g2.meta.period_end }));
  check('generic: opening balance meta', g2.meta.reported_start_balance_minor === 100000,
    'got ' + g2.meta.reported_start_balance_minor);
  check('generic: closing balance meta', g2.meta.reported_end_balance_minor === 83817,
    'got ' + g2.meta.reported_end_balance_minor);
  check('generic: explicit-marker row is high confidence', g2.rows[3].confidence === 'high', 'got ' + g2.rows[3].confidence);
  // The layout-inference engine names explicit charge/payment columns
  // with high confidence (0.85+); the old line heuristic only reached
  // medium here. Confidence follows the engine's validated model.
  check('generic: header-derived rows are high', g2.rows[0].confidence === 'high', 'got ' + g2.rows[0].confidence);
  check('generic: warnings recorded', Array.isArray(g2.warnings) && g2.warnings.length >= 3,
    'got ' + (g2.warnings || []).length);
  check('generic: onProgress called per page', progCalls.length === 1 && progCalls[0][0] === 1 && progCalls[0][1] === 1,
    JSON.stringify(progCalls));
  // Full engine path: normalize -> classify -> reconcile against baseline.
  const g2rows = Engine.normalizeRows(g2.rows.map((r) => Object.assign({}, r)));
  check('generic: all rows have date+amount',
    g2rows.every((r) => r.date && r.amountMinor !== null && r.amountMinor !== undefined));
  Engine.classifyRows(g2rows, []);
  const g2rec = Engine.reconcile(g2rows, {
    startMinor: g2.meta.reported_start_balance_minor, endMinor: g2.meta.reported_end_balance_minor });
  check('generic: reconcile balanceCheck = ok', g2rec.balanceCheck === 'ok',
    'got ' + g2rec.balanceCheck + ' gap=' + g2rec.gapMinor);

  // Single-column layout: bare amounts positive; - / CR negative.
  const singleCol = [[
    { x: 72, y: 740, text: 'Acme Bank' },
    { x: 72, y: 724, text: 'Account statement' },
    { x: 72, y: 708, text: 'Statement date: April 15, 2026' },
    { x: 72, y: 660, text: 'Date' }, { x: 150, y: 660, text: 'Description' }, { x: 450, y: 660, text: 'Amount' },
    { x: 72, y: 640, text: '2026-04-02' }, { x: 150, y: 640, text: 'COFFEE SHOP' }, { x: 450, y: 640, text: '4.50' },
    { x: 72, y: 622, text: '2026-04-03' }, { x: 150, y: 622, text: 'PAYMENT RECEIVED' }, { x: 450, y: 622, text: '-200.00' },
    { x: 72, y: 604, text: '2026-04-05' }, { x: 150, y: 604, text: 'STORE REFUND' }, { x: 450, y: 604, text: '25.00CR' },
    { x: 72, y: 100, text: 'Page 1 of 1' },
  ]];
  const g1 = await parseSynthetic(singleCol);
  check('single-col: 3 rows', g1.rows.length === 3, 'got ' + g1.rows.length);
  check('single-col: signs', JSON.stringify(g1.rows.map((r) => r.signedAmountMinor)) === '[450,-20000,-2500]',
    JSON.stringify(g1.rows.map((r) => r.signedAmountMinor)));
  check('single-col: explicit rows high confidence',
    g1.rows[1].confidence === 'high' && g1.rows[2].confidence === 'high',
    JSON.stringify(g1.rows.map((r) => r.confidence)));
  // Single amount column under a confirmed header: high confidence.
  check('single-col: bare row high confidence', g1.rows[0].confidence === 'high',
    'got ' + g1.rows[0].confidence);
  check('single-col: ISO dates kept', g1.rows[0].dateInferred === '2026-04-02', 'got ' + g1.rows[0].dateInferred);

  // Two columns with NO header words: sign is ambiguous -> low confidence
  // -> engine must route into the review queue.
  const noHeader = [[
    { x: 72, y: 740, text: 'Some Bank' },
    { x: 72, y: 708, text: 'Statement period: Mar 01, 2026 - Mar 31, 2026' },
    { x: 72, y: 640, text: 'Mar 05' }, { x: 150, y: 640, text: 'GROCERY STORE' }, { x: 400, y: 640, text: '45.67' },
    { x: 72, y: 622, text: 'Mar 07' }, { x: 150, y: 622, text: 'PAYMENT THANK YOU' }, { x: 520, y: 622, text: '200.00' },
    { x: 72, y: 100, text: 'Page 1 of 1' },
  ]];
  const gA = await parseSynthetic(noHeader);
  check('ambiguous: rows low confidence', gA.rows.every((r) => r.confidence === 'low'),
    JSON.stringify(gA.rows.map((r) => r.confidence)));
  const gArows = Engine.normalizeRows(gA.rows.map((r) => Object.assign({}, r)));
  Engine.classifyRows(gArows, []);
  check('ambiguous: payment row routed to review queue', gArows[1].confidence === 'needs_review',
    'got ' + gArows[1].confidence);
  check('ambiguous: review reason cites heuristic', /heuristic/i.test(gArows[1].kindReason || ''),
    JSON.stringify(gArows[1].kindReason));

  // Running-balance column: excluded via a real "Balance" header (not a
  // "Previous balance" summary line).
  var bal = await parseSynthetic([[
    { x: 72, y: 700, text: 'Fictional Bank' },
    { x: 72, y: 682, text: 'Statement period: Mar 01, 2026 - Mar 31, 2026' },
    { x: 72, y: 664, text: 'Date' },
    { x: 150, y: 664, text: 'Description' },
    { x: 400, y: 664, text: 'Amount' },
    { x: 520, y: 664, text: 'Balance' },
    { x: 72, y: 646, text: 'Mar 05' },
    { x: 150, y: 646, text: 'GROCERY STORE' },
    { x: 400, y: 646, text: '45.67' },
    { x: 520, y: 646, text: '1,045.67' },
    { x: 72, y: 628, text: 'Mar 07' },
    { x: 150, y: 628, text: 'PAYMENT THANK YOU' },
    { x: 400, y: 628, text: '-200.00' },
    { x: 520, y: 628, text: '845.67' }
  ]]);
  check('balance-col: 2 rows', bal.rows.length === 2, 'got ' + bal.rows.length);
  check('balance-col: transaction amounts (not running balance)',
    JSON.stringify(bal.rows.map((r) => r.signedAmountMinor)) === '[4567,-20000]',
    JSON.stringify(bal.rows.map((r) => r.signedAmountMinor)));
  // The engine header-anchors the Amount column, so running-balance
  // figures can never leak into rows: the raw amount text must be the
  // Amount column's values, not the Balance column's.
  check('balance-col: raw amounts are the Amount column values',
    JSON.stringify(bal.rows.map((r) => r.rawAmountText)) === '["45.67","-200.00"]',
    JSON.stringify(bal.rows.map((r) => r.rawAmountText)));

  // Non-statement PDF: friendly error, not a technical dump.
  const menu = [[
    { x: 72, y: 740, text: "Luigi's Trattoria" },
    { x: 72, y: 720, text: 'Dinner menu' },
    { x: 72, y: 690, text: 'Margherita Pizza 14.99' },
    { x: 72, y: 672, text: 'Spaghetti Carbonara 16.50' },
    { x: 72, y: 654, text: 'Tiramisu 7.00' },
    { x: 72, y: 620, text: 'Open daily 11:00am to 10:00pm' },
  ]];
  let menuErr = null;
  try { await parseSynthetic(menu); } catch (e) { menuErr = e && e.message; }
  check('non-statement: friendly error',
    menuErr === "This PDF doesn't look like a bank or credit-card statement we can read: found 1 pages but no lines with both a date and an amount.",
    JSON.stringify(menuErr));

  console.log(failures === 0 ? '\nALL PDF PARSE CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED');
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e && e.stack || e); process.exit(1); });
