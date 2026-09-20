/* ============================================================================
 * parsers.js — "Explain My Money" Gate 1 prototype: on-device PDF parsers
 * ----------------------------------------------------------------------------
 * Ports of backend/parsers/pc_financial.py and backend/parsers/cibc_costco.py
 * (validated at 100% row recall against the real specimen PDFs).
 *
 * PURE FUNCTIONS + one async pdf.js driver. No DOM, no network, no storage.
 * Coordinates: pdf.js getTextContent items carry transform[4]=x,
 * transform[5]=y in PDF points, y-up — the same convention as the Python
 * visitor_text positions, so the validated column-split (392pt) and
 * y-tolerance (2.5pt) constants transfer unchanged.
 *
 * Row contract (mirrors the Python raw-row contract, camelCase for the JS
 * engine): rawDateText / rawDescription / rawAmountText / rawCurrency
 * (exactly as printed — never rewritten), pageNumber, rowIndex, plus:
 *   signedAmountMinor  int — parser-authoritative card-account signing
 *                      (charges positive, payments/credits negative). The
 *                      engine's normalizeRows uses this INSTEAD of re-parsing
 *                      rawAmountText, because section-aware signing (e.g.
 *                      CIBC's "Your payments" table prints positives) cannot
 *                      be recovered from the printed text alone.
 *   dateInferred     ISO date with year inferred from the statement period
 *                    (the engine falls back to this when rawDateText has no
 *                    year, e.g. "16/08" or "Mar 20").
 *   confidence       'high' | 'medium' | 'low' — heuristic-parse certainty
 *                    (generic template only). The engine routes 'low' rows
 *                    into the review queue (see classifyRows).
 *   confidenceNote   human-readable reason for the confidence level.
 *
 * Formats: the two validated templates (pc_financial, cibc_costco) are
 * tried first and refuse to guess. Anything else falls back to
 * Parsers.parseGeneric, a heuristic reader for any bank/credit-card
 * statement: date+amount line detection, amount-column clustering,
 * header-driven sign inference, balance keyword metadata, year inference.
 *
 * Money is ALWAYS integer minor units. No parseFloat anywhere near money.
 * Nothing is silently dropped: unparsed table-region lines raise.
 *
 * ES2019-compatible: no modules, no optional chaining, no nullish
 * coalescing, no BigInt. Loaded via plain <script> after engine.js;
 * exposes global `Parsers`. Also loadable in node for tests
 * (Parsers.parsePdf takes the pdfjsLib object as a parameter).
 * ========================================================================== */
(function () {
  'use strict';

  var Parsers = {};

  /* ------------------------------------------------------------------ */
  /* Small shared helpers                                                 */
  /* ------------------------------------------------------------------ */

  function trim(s) { return String(s == null ? '' : s).replace(/^\s+|\s+$/g, ''); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function isoDate(y, m, d) { return y + '-' + pad2(m) + '-' + pad2(d); }

  /**
   * Printed amount -> signed integer minor units. Integer math only.
   * Handles "$1,234.56", "-$123.45", "$123.45-", "227.88", "-  $433.27",
   * "+  $1,273.26", "18.93 CR". Throws on anything unparseable.
   */
  function amountToMinor(text) {
    var t = trim(text).replace(/\u2013|\u2014/g, '-'); // en/em dash -> hyphen
    if (t === '') throw new Error('empty amount text');
    var negative = false;
    if (/CR$/i.test(t)) { negative = true; t = trim(t.slice(0, -2)); }
    if (t.charAt(0) === '-') { negative = true; t = trim(t.slice(1)); }
    else if (t.charAt(0) === '+') { t = trim(t.slice(1)); }
    else if (t.charAt(t.length - 1) === '-') { negative = true; t = trim(t.slice(0, -1)); }
    t = t.replace(/[$\s,]/g, '');
    var m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(t);
    if (!m) throw new Error('unparseable amount: ' + text);
    var dollars = m[1].replace(/^0+(?=\d)/, '') || '0';
    var cents = m[2] || '';
    while (cents.length < 2) cents += '0';
    var minor = 0, i;
    for (i = 0; i < dollars.length; i++) minor = minor * 10 + (dollars.charCodeAt(i) - 48);
    minor = minor * 100 + (cents.charCodeAt(0) - 48) * 10 + (cents.charCodeAt(1) - 48);
    return negative ? -minor : minor;
  }

  /** Normalise straight/curly/misdecoded apostrophes for marker matching. */
  function normApos(s) {
    return String(s).replace(/[‘’\u0091\u0092`]/g, "'");
  }

  /**
   * Yield to the event loop so progress paints on phones. No-op when
   * setTimeout is unavailable (e.g. the node test sandbox).
   */
  function yieldToUI() {
    if (typeof setTimeout === 'function') {
      return new Promise(function (r) { setTimeout(r, 0); });
    }
    return Promise.resolve();
  }

  function looksLikeISODate(s) {
    if (typeof s !== 'string') return false;
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trim(s));
    if (!m) return false;
    var y = +m[1], mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* pdf.js text-item extraction -> position-aware lines                  */
  /* ------------------------------------------------------------------ */

  function sanitize(text) {
    // Drop control characters (keep newlines for intra-item splitting).
    return String(text).replace(/[^\n\x20-\uFFFF]/g, function (c) {
      return c === '\n' ? c : '';
    });
  }

  /**
   * Parsers.collectItems(pdf, maxPages, onProgress) -> Promise<[{page,x,y,cx,text}]>.
   * One fragment per pdf.js text item (embedded newlines split). Exact
   * (page,x,y,text) duplicates dropped (some statements emit ops twice).
   * onProgress(page, numPages) is optional and fires once per page so the
   * UI can show "Reading page X of Y…" instead of a dead spinner.
   */
  Parsers.collectItems = async function (pdf, maxPages, onProgress) {
    var frags = [];
    var n = Math.min(pdf.numPages, maxPages || pdf.numPages);
    for (var p = 1; p <= n; p++) {
      var page = await pdf.getPage(p);
      var tc = await page.getTextContent();
      var items = (tc && tc.items) || [];
      var seen = {};
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (it.str === null || it.str === undefined) continue;
        var x = it.transform[4], y = it.transform[5];
        var w = (typeof it.width === 'number' && isFinite(it.width)) ? it.width : 0;
        var parts = sanitize(it.str).split('\n');
        for (var k = 0; k < parts.length; k++) {
          var part = parts[k];
          if (!part || !part.replace(/\s/g, '')) continue;
          var key = p + '|' + x.toFixed(2) + '|' + y.toFixed(2) + '|' + part;
          if (seen[key]) continue;
          seen[key] = 1;
          frags.push({ page: p, x: x, y: y, cx: x + w / 2, text: part });
        }
      }
      if (page.cleanup) page.cleanup();
      // Yield to the event loop per page so the "Reading page X of Y…"
      // progress actually paints on phones instead of freezing the UI.
      await yieldToUI();
      if (typeof onProgress === 'function') {
        try { onProgress(p, n); } catch (e) { /* progress must never break parsing */ }
      }
    }
    return frags;
  };

  // Y-grouping tolerance (points) when rebuilding lines — validated value.
  var LINE_Y_TOLERANCE = 2.5;

  function groupIntoLines(frags) {
    // Sort top-to-bottom (-y), then left-to-right (x). Bucket anchor is
    // the first fragment's y so buckets cannot chain across rows.
    var sorted = frags.slice().sort(function (a, b) {
      return (b.y - a.y) || (a.x - b.x);
    });
    var buckets = []; // [anchorY, [frags]]
    for (var i = 0; i < sorted.length; i++) {
      var f = sorted[i];
      if (buckets.length && Math.abs(f.y - buckets[buckets.length - 1][0]) <= LINE_Y_TOLERANCE) {
        buckets[buckets.length - 1][1].push(f);
      } else {
        buckets.push([f.y, [f]]);
      }
    }
    var lines = [];
    for (var b = 0; b < buckets.length; b++) {
      var parts = buckets[b][1].slice().sort(function (a, c) { return a.x - c.x; });
      lines.push(parts.map(function (p) { return p.text; }).join(' '));
    }
    return lines;
  }

  /**
   * Rebuild [{page, text}] lines from fragments. When columnSplitX is
   * given, each page's fragments are split into left (cx < split) and
   * right columns first; the page contributes left-column lines followed
   * by right-column lines, so a transaction table never interleaves with
   * an account-summary column. Empty lines are dropped.
   */
  function extractLines(frags, columnSplitX) {
    var byPage = {};
    frags.forEach(function (f) {
      (byPage[f.page] = byPage[f.page] || []).push(f);
    });
    var pages = Object.keys(byPage).map(Number).sort(function (a, b) { return a - b; });
    var out = [];
    pages.forEach(function (p) {
      var fr = byPage[p];
      var cols = (columnSplitX === null || columnSplitX === undefined) ? [fr] : [
        fr.filter(function (f) { return f.cx < columnSplitX; }),
        fr.filter(function (f) { return f.cx >= columnSplitX; })
      ];
      cols.forEach(function (col) {
        groupIntoLines(col).forEach(function (ln) {
          if (ln.replace(/\s/g, '')) out.push({ page: p, text: trim(ln) });
        });
      });
    });
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Format detection                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * Parsers.detectFormat(firstPageText) -> 'pc_financial' | 'cibc_costco' | null.
   * Conservative: requires the institution + network + statement markers.
   */
  Parsers.detectFormat = function (firstPageText) {
    var t = normApos(String(firstPageText || '')).toLowerCase();
    var pc = t.indexOf('president') !== -1 && t.indexOf('choice') !== -1 &&
      t.indexOf('financial') !== -1 && t.indexOf('mastercard') !== -1 &&
      (t.indexOf('statement date') !== -1 || t.indexOf('account activity') !== -1);
    if (pc) return 'pc_financial';
    var cibc = t.indexOf('cibc') !== -1 && t.indexOf('costco') !== -1 &&
      t.indexOf('mastercard') !== -1;
    if (cibc) return 'cibc_costco';
    return null;
  };

  // Expose internals needed by the node test (not part of the app contract).
  Parsers._internals = {
    amountToMinor: amountToMinor,
    extractLines: extractLines,
    groupIntoLines: groupIntoLines,
    looksLikeISODate: looksLikeISODate,
    normApos: normApos
  };

  /* ================================================================== */
  /* PC Financial Mastercard (template pc_world_elite_mc_v1)              */
  /* ================================================================== */
  /* Port of backend/parsers/pc_financial.py. Page 1 is two columns: the
   * transaction table (left) and the account summary (right). A text
   * extractor that only sorts by y interleaves the two columns, so
   * extraction is column-aware (COLUMN_SPLIT_X = 392pt, validated). */

  var PC = {
    templateId: 'pc_world_elite_mc_v1',
    institution: "President's Choice Financial",
    columnSplitX: 392.0
  };

  var PC_MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

  function pcParseLongDate(text) {
    var m = /^\s*([A-Za-z]+)\.?\s+(\d{1,2}),\s*(\d{4})\s*$/.exec(text);
    if (!m) throw new Error('unrecognised statement date: ' + text);
    var mo = PC_MONTHS[m[1].toLowerCase()];
    if (!mo) throw new Error('unknown month in statement date: ' + text);
    return isoDate(+m[3], mo, +m[2]);
  }

  var PC_RE_STATEMENT_DATE = /Statement\s+date\s*:?\s*([A-Za-z]+\.?\s+\d{1,2},\s*\d{4})/i;
  var PC_RE_STATEMENT_PERIOD = /Statement\s+period\s*:?\s*([A-Za-z]+\.?\s+\d{1,2},\s*\d{4})\s*[-\u2013]\s*([A-Za-z]+\.?\s+\d{1,2},\s*\d{4})/i;
  var PC_RE_DUE_DATE = /Payment\s+due\s+date\s*:?\s*([A-Za-z]+\.?\s+\d{1,2},\s*\d{4})/i;
  var PC_RE_PAGE_MARKER = /^\s*Page\s+\d+\s+of\s+\d+\b/i;
  var PC_RE_FOOTER_FRAGMENT = /^(\u00ae|Choice Financial|Elite Mastercard)$/i;
  // A transaction row: dd/mm, dd/mm, description, amount. The amount is the
  // FIRST dollar amount after the dates.
  var PC_RE_TXN_ROW = /^\s*(\d{1,2}\/\d{1,2})\s+(\d{1,2}\/\d{1,2})\s+(.+?)\s+(\$[\d,]+\.\d{2}-|-?\$[\d,]+\.\d{2})/;
  var PC_RE_FX_CODE = /^\s*[A-Z]{3}\s*$/;
  var PC_RE_FX_DETAIL = /^\s*[\d,]+\.\d+\s+[A-Z]{3}\b/;
  var PC_RE_FX_RATE_ONLY = /^\s*\d[\d,]*\.\d+\s*$/;
  var PC_RE_AMOUNT = /\$[\d,]+\.\d{2}-|-?\$[\d,]+\.\d{2}/;
  var PC_RE_AMOUNT_LOOSE = /\$[\d,]+\.\d{1,2}/g;

  var PC_END_SENTINELS = [
    'account number:', 'amount paid', 'interest rates', 'questions?',
    'important information'
  ];

  var PC_SKIP_RES = [
    /previous\s+balance/i, /\bas\s+of\b/i, /\+\s*purchases\b/i,
    /\+\s*cash\s+advances\b/i, /\+\s*convenience\s+cheques\b/i,
    /\+\s*promotional\s+balances\b/i, /\+\s*interest\b/i, /\+\s*fees\b/i,
    /\+\s*other\s+charges\b/i, /-\s*payments\b/i,
    /payments\s*_\s*thank\s*you/i, /-\s*other\s+credits\b/i,
    /\bother\s+credits\b/i, /statement\s+balance/i, /past\s+due\s+amount/i,
    /overlimit\s+amount/i, /minimum\s+payment/i, /payment\s+due\s+date/i,
    /\bcredit\b.*\bcash\b/i, /\blimit\b/i, /\bavailable\b/i, /\bsummary\b/i,
    /total\s+payment\s+activity/i, /total\s+purchases/i, /time\s+to\s+pay/i,
    /at\s+your\s+current\s+rates/i, /minimum\s+payment\s+by\s+its\s+due\s+date/i,
    /take\s+approximately/i, /year\(s\)/i, /check\s+your\s+points\s+balance/i,
    /pcoptimum/i, /statement\s+details/i, /account\s+summary/i,
    /X{4}\s+X{4}/, /president.{0,5}s?\s+choice\s+financial/i
  ];

  // Account-summary labels -> [key, negate]. The sign lives in the label
  // ("- Payments _ Thank you" prints a positive amount); negated labels
  // are stored negative so previous + purchases + ... + payments +
  // other_credits == statement holds as a plain sum.
  var PC_METADATA_LABELS = [
    [/previous\s+balance/i, 'previous_balance_minor', false],
    [/\+\s*purchases\b/i, 'purchases_minor', false],
    [/\+\s*cash\s+advances\b/i, 'cash_advances_minor', false],
    [/\+\s*convenience\s+cheques\b/i, 'convenience_cheques_minor', false],
    [/\+\s*promotional\s+balances\b/i, 'promotional_balances_minor', false],
    [/\+\s*interest\b/i, 'interest_minor', false],
    [/\+\s*fees\b/i, 'fees_minor', false],
    [/\+\s*other\s+charges\b/i, 'other_charges_minor', false],
    [/-\s*payments\b|payments\s*_\s*thank\s*you/i, 'payments_minor', true],
    [/-\s*other\s+credits\b/i, 'other_credits_minor', true],
    [/statement\s+balance/i, 'statement_balance_minor', false],
    [/minimum\s+payment/i, 'minimum_payment_minor', false]
  ];

  function pcInferYear(month, ps, pe) {
    // ps/pe: {y, m, d}. Within one calendar year the period's year wins;
    // across New Year, months up to the end month belong to the end year.
    if (ps.y === pe.y) return ps.y;
    return month <= pe.m ? pe.y : ps.y;
  }

  function pcFindPeriod(lines) {
    // lines: [{page, text}]. Returns {start:{y,m,d}, end:{y,m,d}} (either
    // may be null). Handles the extractor splitting the range: when the
    // "Statement period:" line ends with a bare "-", the end date is on a
    // following line of the same page.
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].text, page = lines[i].page;
      var m = PC_RE_STATEMENT_PERIOD.exec(t);
      if (m) {
        var a = /^([A-Za-z]+)\.?\s+(\d{1,2}),\s*(\d{4})$/.exec(trim(m[1]));
        var b = /^([A-Za-z]+)\.?\s+(\d{1,2}),\s*(\d{4})$/.exec(trim(m[2]));
        return {
          start: { y: +a[3], m: PC_MONTHS[a[1].toLowerCase()], d: +a[2] },
          end: { y: +b[3], m: PC_MONTHS[b[1].toLowerCase()], d: +b[2] }
        };
      }
      var so = /Statement\s+period\s*:?\s*([A-Za-z]+\.?\s+\d{1,2},\s*\d{4})\s*-\s*$/i.exec(t);
      if (so) {
        var startIso = pcParseLongDate(so[1]);
        for (var j = i + 1; j < lines.length; j++) {
          if (lines[j].page !== page) break;
          var lone = /^\s*([A-Za-z]+\.?\s+\d{1,2},\s*\d{4})\s*$/.exec(lines[j].text);
          if (lone) {
            var e = /^([A-Za-z]+)\.?\s+(\d{1,2}),\s*(\d{4})$/.exec(trim(lone[1]));
            return {
              startIso: startIso,
              start: null, end: { y: +e[3], m: PC_MONTHS[e[1].toLowerCase()], d: +e[2] }
            };
          }
        }
        return { startIso: startIso, start: null, end: null };
      }
    }
    return { start: null, end: null };
  }

  function pcPeriodStartEnd(period) {
    // Normalise the pcFindPeriod result to {startIso, endIso} strings.
    if (!period) return { startIso: null, endIso: null };
    var s = null, e = null;
    if (period.startIso) s = period.startIso;
    else if (period.start) s = isoDate(period.start.y, period.start.m, period.start.d);
    if (period.end) e = isoDate(period.end.y, period.end.m, period.end.d);
    return { startIso: s, endIso: e };
  }

  PC.extractLines = function (frags) {
    return extractLines(frags, PC.columnSplitX);
  };

  PC.parseMetadata = function (lines) {
    var texts = lines.map(function (l) { return l.text; });
    var meta = {};
    var per = pcPeriodStartEnd(pcFindPeriod(lines));
    if (per.startIso) meta.period_start = per.startIso;
    if (per.endIso) meta.period_end = per.endIso;
    for (var i = 0; i < texts.length; i++) {
      var m = PC_RE_STATEMENT_DATE.exec(texts[i]);
      if (m) { meta.statement_date = pcParseLongDate(m[1]); break; }
    }
    for (var d = 0; d < texts.length; d++) {
      var dm = PC_RE_DUE_DATE.exec(texts[d]);
      if (dm) { meta.payment_due_date = pcParseLongDate(dm[1]); break; }
    }
    for (var idx = 0; idx < texts.length; idx++) {
      var t = texts[idx];
      for (var li = 0; li < PC_METADATA_LABELS.length; li++) {
        var labelRe = PC_METADATA_LABELS[li][0], key = PC_METADATA_LABELS[li][1],
            negate = PC_METADATA_LABELS[li][2];
        if (meta[key] !== undefined) continue;
        var lm = labelRe.exec(t);
        if (!lm) continue;
        var amt = PC_RE_AMOUNT.exec(t.slice(lm.index + lm[0].length));
        if (!amt) {
          for (var n = idx + 1; n < Math.min(idx + 3, texts.length); n++) {
            amt = PC_RE_AMOUNT.exec(texts[n]);
            if (amt) break;
          }
        }
        if (amt) {
          var value = amountToMinor(amt[0]);
          meta[key] = negate ? -value : value;
        }
      }
    }
    // Credit / cash limits and available amounts: a "Limit" line and an
    // "Available" line, each carrying two dollar amounts. The amounts may
    // sit on following lines, so scan a small window.
    for (var q = 0; q < texts.length; q++) {
      var tq = texts[q];
      if (meta.credit_limit_minor === undefined && /\blimit\b/i.test(tq)) {
        var win = texts.slice(q, q + 4).join(' ');
        var amounts = win.match(PC_RE_AMOUNT_LOOSE);
        if (amounts && amounts.length >= 2) {
          meta.credit_limit_minor = amountToMinor(amounts[0]);
          meta.cash_limit_minor = amountToMinor(amounts[1]);
        }
      }
      if (meta.available_credit_minor === undefined && /\bavailable\b/i.test(tq)) {
        var win2 = texts.slice(q, q + 4).join(' ');
        var amounts2 = win2.match(PC_RE_AMOUNT_LOOSE);
        if (amounts2 && amounts2.length >= 2) {
          meta.available_credit_minor = amountToMinor(amounts2[0]);
          meta.available_cash_minor = amountToMinor(amounts2[1]);
        }
      }
    }
    if (meta.previous_balance_minor !== undefined) {
      meta.reported_start_balance_minor = meta.previous_balance_minor;
    }
    if (meta.statement_balance_minor !== undefined) {
      meta.reported_end_balance_minor = meta.statement_balance_minor;
    }
    return meta;
  };

  PC.parseTextLines = function (lines) {
    var per = pcPeriodStartEnd(pcFindPeriod(lines));
    var ps = null, pe = null;
    if (per.startIso && per.endIso) {
      var sp = per.startIso.split('-'), ep = per.endIso.split('-');
      ps = { y: +sp[0], m: +sp[1], d: +sp[2] };
      pe = { y: +ep[0], m: +ep[1], d: +ep[2] };
    }
    var rows = [], unparsed = [];
    var inTable = false, fxArmed = false, fxRateArmed = false;
    var window3 = [];

    function badDate(page, rawText) {
      unparsed.push({ pageNumber: page, text: rawText, reason: 'invalid calendar date' });
    }

    for (var li = 0; li < lines.length; li++) {
      var page = lines[li].page, rawText = lines[li].text;
      var t = trim(rawText);
      if (!t) { fxArmed = false; fxRateArmed = false; continue; }
      if (PC_RE_PAGE_MARKER.test(t)) {
        inTable = false; fxArmed = false; fxRateArmed = false; window3 = [];
        continue;
      }
      if (inTable && PC_RE_FOOTER_FRAGMENT.test(t)) {
        inTable = false; fxArmed = false; fxRateArmed = false;
        continue;
      }
      // Rolling header detection: the header may span three printed lines.
      window3.push(t);
      if (window3.length > 3) window3.shift();
      var joined = window3.join(' ');
      if (/dd\/mm/i.test(joined) && /account\s*activity/i.test(joined)) {
        inTable = true; fxArmed = false; fxRateArmed = false; window3 = [];
        continue;
      }
      if (!inTable) continue;

      var low = t.toLowerCase();
      var ended = false;
      for (var s = 0; s < PC_END_SENTINELS.length; s++) {
        if (low.indexOf(PC_END_SENTINELS[s]) !== -1) { ended = true; break; }
      }
      if (ended) {
        inTable = false; fxArmed = false; fxRateArmed = false; window3 = [];
        continue;
      }

      var m = PC_RE_TXN_ROW.exec(t);
      if (m) {
        var dp = m[1].split('/');
        var dd = +dp[0], mm = +dp[1];
        var inferredIso = null;
        if (ps && pe) {
          var yr = pcInferYear(mm, ps, pe);
          // Validate the calendar date (mirror Python's ValueError path).
          var dim = [31, (yr % 4 === 0 && (yr % 100 !== 0 || yr % 400 === 0)) ? 29 : 28,
                     31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mm - 1];
          if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= dim) {
            inferredIso = isoDate(yr, mm, dd);
          } else {
            badDate(page, rawText);
            fxArmed = false; fxRateArmed = false;
            continue;
          }
        }
        rows.push({
          rawDateText: m[1],
          rawDescription: trim(m[3]),
          rawAmountText: m[4],
          rawCurrency: 'CAD',
          pageNumber: page,
          rowIndex: rows.length,
          dateInferred: inferredIso,
          // Card-centric signed amount (this statement prints
          // payments/refunds negative already).
          signedAmountMinor: amountToMinor(m[4])
        });
        fxArmed = false; fxRateArmed = false;
        continue;
      }

      // Foreign-currency detail: belongs to the row above.
      if (PC_RE_FX_CODE.test(t) && rows.length && rows[rows.length - 1].pageNumber === page) {
        rows[rows.length - 1].rawDescription += ' ' + t;
        fxArmed = true; fxRateArmed = false;
        continue;
      }
      if (fxArmed && PC_RE_FX_DETAIL.test(t)) {
        rows[rows.length - 1].rawDescription += ' ' + trim(t);
        fxArmed = false; fxRateArmed = true;
        continue;
      }
      if (fxRateArmed && PC_RE_FX_RATE_ONLY.test(t) &&
          rows.length && rows[rows.length - 1].pageNumber === page) {
        rows[rows.length - 1].rawDescription += ' ' + trim(t);
        fxRateArmed = false;
        continue;
      }
      fxArmed = false; fxRateArmed = false;

      var skipped = false;
      for (var k = 0; k < PC_SKIP_RES.length; k++) {
        if (PC_SKIP_RES[k].test(t)) { skipped = true; break; }
      }
      if (skipped) continue;

      unparsed.push({ pageNumber: page, text: rawText, reason: 'no row pattern matched' });
    }
    return { rows: rows, unparsed: unparsed };
  };

  Parsers.PC = PC;

  /* ================================================================== */
  /* CIBC Costco World Mastercard (template cibc_costco_world_mc_v1)      */
  /* ================================================================== */
  /* Port of backend/parsers/cibc_costco.py. Two tables, each with its
   * own heading: "Your payments" (no spend-category column) and "Your new
   * charges and credits" (with "Spend Categories"). Sign convention:
   * the payments table prints POSITIVE numbers for money INTO the card
   * account, so the parser negates them into signedAmountMinor. */

  var CIBC = {
    templateId: 'cibc_costco_world_mc_v1',
    institution: 'CIBC',
    columnSplitX: null // single-column pages; plain y-grouped lines
  };

  var CIBC_MONTHS_FULL = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
  var CIBC_MONTHS_ABBR = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  var CIBC_MONTH_NAMES = 'January|February|March|April|May|June|July|August|September|October|November|December';
  var CIBC_MONTH_ABBR_ALT = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec';

  var CIBC_RE_PERIOD = new RegExp(
    '(' + CIBC_MONTH_NAMES + ')\\s+(\\d{1,2})\\s*to\\s*(' + CIBC_MONTH_NAMES + ')\\s+(\\d{1,2}),\\s*(\\d{4})', 'i');
  var CIBC_RE_PERIOD_TWO_YEAR = new RegExp(
    '(' + CIBC_MONTH_NAMES + ')\\s+(\\d{1,2}),\\s*(\\d{4})\\s+to\\s*(' + CIBC_MONTH_NAMES + ')\\s+(\\d{1,2}),\\s*(\\d{4})', 'i');
  var CIBC_RE_STATEMENT_DATE_LABEL = /^\s*Statement Date\s*(.*?)\s*$/i;
  var CIBC_RE_LONG_DATE = /([A-Za-z]+)\.?\s+(\d{1,2}),\s*(\d{4})/;
  var CIBC_RE_PAYMENTS_HEADING = /^\s*Your payments\s*$/i;
  var CIBC_RE_CHARGES_HEADING = /^\s*Your new charges and credits(?:\s*\(continued\))?\s*$/i;
  var CIBC_RE_COLUMN_HEADER = /^\s*date\s+(?:date\s+)?Description\s+(?:Spend Categories\s+)?Amount\(\$\)\s*$/i;
  var CIBC_RE_HEADER_FRAG = /^(Trans|date|Post)$/i;
  var CIBC_RE_TRANS_POST = /^\s*Trans\s+Post\s*$/i;
  var CIBC_RE_TOTAL_PAYMENTS = /^\s*Total payments\b/i;
  var CIBC_RE_TOTAL_FOR = /^\s*Total\s+for\b/i;
  var CIBC_RE_INFO_PARA_START = /^\s*(If you find an error|How we charge interest|\*\*Foreign currency Transactions|1Amount Due is the amount)\b/i;
  var CIBC_RE_CARD_LINE = /^\s*Card number\b/i;
  var CIBC_RE_PREPARED_FOR = /^\s*Prepared for:/i;
  var CIBC_RE_INFO_BLOCK = /^\s*Information about your\b/i;
  var CIBC_RE_TRANSACTIONS_FROM = /^\s*Transactions\s+from\b/i;
  var CIBC_RE_BARE_FRAG = /^(-|\d{3,})$/;
  // Machine-readable routing line ("*0202280000*"): pdf.js's position-aware
  // extraction surfaces these margin elements mid-table (pypdf's stream
  // order placed them after the section end, so the Python port never
  // sees them inside a table). They can never be rows — a row always
  // starts with two "Mon DD" dates.
  var CIBC_RE_MICR_LINE = /^\*[\d\s]+\*$/;
  var CIBC_RE_BONUS_NOTE = /^\s*Identifies transactions\b/i;
  var CIBC_RE_BONUS_NOTE_2 = /^\s*same\s+rate\.?\s*$/i;
  var CIBC_RE_PAGE_FOOTER = /^\s*Page\s*\d+\s*of\s*\d+\s*$/i;
  var CIBC_RE_FX = /^\s*([\d,]+\.\d{2})\s+([A-Z]{3})\s+@\s+([\d.]+)\*{0,2}\s*$/;
  var CIBC_RE_ROW_START = new RegExp(
    '^\\s*(?:' + CIBC_MONTH_ABBR_ALT + ')\\s+\\d{1,2}\\s+(?:' + CIBC_MONTH_ABBR_ALT + ')\\s+\\d{1,2}\\s+', 'i');
  var CIBC_RE_CONTINUATION = new RegExp(
    '^\\s*(?!(?:' + CIBC_MONTH_ABBR_ALT + ')\\s+\\d{1,2}\\b)' +
    '.*?(-?\\$?[\\d,]+\\.\\d{2}(?:-|\\s*CR)?)\\s*$', 'i');
  var CIBC_RE_ROW = new RegExp(
    '^\\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\\s+(\\d{1,2})\\s+' +
    '(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\\s+(\\d{1,2})\\s+' +
    '(.*?)\\s+(-?\\$?[\\d,]+\\.\\d{2}(?:-|\\s*CR)?)\\s*$', 'i');
  var CIBC_RE_DUE_DATE = /Please pay this amount by\s+([A-Za-z]+\.?\s+\d{1,2},\s*\d{4})/i;
  var CIBC_RE_META_AMOUNT = /[-+–]?\s*\$?\s*[\d,]+\.\d{2}/;

  var CIBC_SLIP_MARKERS = ['tear off', 'please turn over', 'payment options', 'total payment enclosed', 'do not staple'];

  var CIBC_SPEND_CATEGORIES = [
    'Professional and Financial Services', 'Personal and Household Expenses',
    'Foreign Currency Transactions', 'Home and Office Improvement',
    'Retail and Grocery', 'Health and Education', 'Transportation', 'Restaurants'
  ];

  // [key, label, policy] — policy +1 keeps the printed magnitude positive,
  // -1 negates it (money back into the account). Labels anchored at line
  // start because the at-a-glance box labels are left-aligned.
  var CIBC_METADATA_LABELS = [
    ['previous_balance_minor', 'Previous balance', +1],
    ['payments_minor', 'Payments', -1],
    ['other_credits_minor', 'Other credits', -1],
    ['total_credits_minor', 'Total credits', -1],
    ['purchases_minor', 'Purchases', +1],
    ['cash_advances_minor', 'Cash advances', +1],
    ['interest_minor', 'Interest', +1],
    ['fees_minor', 'Fees', +1],
    ['total_charges_minor', 'Total charges', +1],
    ['total_balance_minor', 'Total balance', +1],
    ['credit_limit_minor', 'Limit', +1],
    ['available_credit_minor', 'Available', +1],
    ['minimum_payment_minor', 'Minimum Payment', +1]
  ];

  function cibcParseLongDate(text) {
    var m = CIBC_RE_LONG_DATE.exec(text);
    if (!m) throw new Error('unrecognised statement date: ' + text);
    var mo = CIBC_MONTHS_FULL[m[1].toLowerCase()];
    if (!mo) throw new Error('unknown month in statement date: ' + text);
    return isoDate(+m[3], mo, +m[2]);
  }

  function cibcParsePeriod(text) {
    var m = CIBC_RE_PERIOD_TWO_YEAR.exec(text);
    if (m) {
      return {
        start: isoDate(+m[3], CIBC_MONTHS_FULL[m[1].toLowerCase()], +m[2]),
        end: isoDate(+m[6], CIBC_MONTHS_FULL[m[4].toLowerCase()], +m[5])
      };
    }
    m = CIBC_RE_PERIOD.exec(text);
    if (!m) return null;
    var sm = CIBC_MONTHS_FULL[m[1].toLowerCase()], em = CIBC_MONTHS_FULL[m[3].toLowerCase()];
    var ey = +m[5], sy = (sm > em) ? ey - 1 : ey;
    return { start: isoDate(sy, sm, +m[2]), end: isoDate(ey, em, +m[4]) };
  }

  function cibcInferYear(month, psIso, peIso) {
    var peM = +peIso.slice(5, 7), peY = +peIso.slice(0, 4), psY = +psIso.slice(0, 4);
    return month <= peM ? peY : psY;
  }

  function cibcNormalizeLine(text) {
    // The bonus-rewards marker glyph renders as a soft hyphen (U+00AD)
    // or as Ý (U+00DD) depending on the extractor; treat as whitespace.
    return text.replace(/[\u00ad\u00dd]/g, ' ').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
  }

  function cibcIsSlipStart(text) {
    var low = text.toLowerCase();
    for (var i = 0; i < CIBC_SLIP_MARKERS.length; i++) {
      if (low.indexOf(CIBC_SLIP_MARKERS[i]) !== -1) return true;
    }
    return false;
  }

  CIBC.extractLines = function (frags) {
    return extractLines(frags, CIBC.columnSplitX);
  };

  CIBC.parseMetadata = function (lines) {
    var meta = {
      statement_date: null, period_start: null, period_end: null,
      previous_balance_minor: null, payments_minor: null, other_credits_minor: null,
      total_credits_minor: null, purchases_minor: null, cash_advances_minor: null,
      interest_minor: null, fees_minor: null, total_charges_minor: null,
      total_balance_minor: null, credit_limit_minor: null, available_credit_minor: null,
      minimum_payment_minor: null, due_date: null
    };
    for (var i = 0; i < lines.length; i++) {
      var per = cibcParsePeriod(lines[i].text);
      if (per) { meta.period_start = per.start; meta.period_end = per.end; break; }
    }
    var slipPage = null, idx = 0;
    while (idx < lines.length) {
      var page = lines[idx].page, text = lines[idx].text;
      idx++;
      var t = trim(text);
      if (!t) continue;
      if (cibcIsSlipStart(t)) { slipPage = page; continue; }
      if (slipPage === page) continue;
      if (CIBC_RE_PAGE_FOOTER.test(t)) continue;
      // The at-a-glance box lives above the transaction sections; stop
      // there so table totals can never collide with labels.
      if (CIBC_RE_PAYMENTS_HEADING.test(t) || CIBC_RE_CHARGES_HEADING.test(t) ||
          CIBC_RE_TRANSACTIONS_FROM.test(t)) break;

      if (meta.statement_date === null) {
        var sm = CIBC_RE_STATEMENT_DATE_LABEL.exec(t);
        if (sm) {
          var value = trim(sm[1]);
          if (!value) {
            for (var n2 = idx; n2 < Math.min(idx + 2, lines.length); n2++) {
              if (trim(lines[n2].text)) { value = trim(lines[n2].text); break; }
            }
          }
          try { meta.statement_date = cibcParseLongDate(value); } catch (e) { /* leave null */ }
        }
      }
      if (meta.due_date === null) {
        var dm = CIBC_RE_DUE_DATE.exec(t);
        if (dm) {
          try { meta.due_date = cibcParseLongDate(dm[1]); } catch (e) { /* leave null */ }
        }
      }
      // The at-a-glance box prints the label and amount on separate lines
      // ("Minimum Payment2" ... "$10.00"); look ahead for a bare amount.
      if (meta.minimum_payment_minor === null && /^\s*Minimum Payment\d*\s*$/i.test(t)) {
        for (var n3 = idx; n3 < Math.min(idx + 3, lines.length); n3++) {
          var am = /^\s*\$?[\d,]+\.\d{2}\s*$/.exec(lines[n3].text);
          if (am) { meta.minimum_payment_minor = amountToMinor(am[0]); break; }
        }
      }
      for (var li = 0; li < CIBC_METADATA_LABELS.length; li++) {
        var key = CIBC_METADATA_LABELS[li][0], label = CIBC_METADATA_LABELS[li][1],
            policy = CIBC_METADATA_LABELS[li][2];
        if (meta[key] !== null) continue;
        // Escape label for regex (labels contain no special chars, but be safe).
        var lm = new RegExp('^\\s*' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i').exec(t);
        if (!lm) continue;
        var amt = CIBC_RE_META_AMOUNT.exec(t.slice(lm.index + lm[0].length));
        if (amt) {
          var minor = amountToMinor(amt[0]);
          meta[key] = policy > 0 ? Math.abs(minor) : -Math.abs(minor);
        }
      }
    }
    if (meta.previous_balance_minor !== null) {
      meta.reported_start_balance_minor = meta.previous_balance_minor;
    }
    if (meta.total_balance_minor !== null) {
      meta.reported_end_balance_minor = meta.total_balance_minor;
    }
    return meta;
  };

  function cibcSplitCategory(rest) {
    var low = rest.toLowerCase();
    for (var i = 0; i < CIBC_SPEND_CATEGORIES.length; i++) {
      var cat = CIBC_SPEND_CATEGORIES[i];
      if (low.slice(-cat.length) === cat.toLowerCase() &&
          (rest.length === cat.length || rest.charAt(rest.length - cat.length - 1) === ' ')) {
        var desc = rest.slice(0, -cat.length).replace(/\s+$/g, '');
        return [desc || rest, cat];
      }
    }
    return [rest, null];
  }

  function cibcJoinWrappedRows(normed) {
    // normed: [{page, original, text}]. Joins description-wrapped rows
    // into single logical lines; a foreign-currency detail line between
    // the wrapped description and the category/amount line is kept as
    // its own logical line right after the joined row.
    var logical = [], i = 0;
    function rowRe() { return CIBC_RE_ROW; }
    while (i < normed.length) {
      var cur = normed[i], page = cur.page, t = cur.text;
      if (CIBC_RE_ROW_START.test(t) && !rowRe().test(t)) {
        var parts = [{ original: cur.original, text: t }];
        var j = i + 1, fxLine = null;
        if (j < normed.length && normed[j].page === page && CIBC_RE_FX.test(normed[j].text)) {
          fxLine = normed[j]; j++;
        }
        while (j < normed.length) {
          var n = normed[j];
          if (n.page !== page) break;
          if (CIBC_RE_CONTINUATION.test(n.text)) {
            parts.push({ original: n.original, text: n.text });
            j++;
            var combined = parts.map(function (p) { return p.text; }).join(' ');
            if (rowRe().test(combined)) break;
          } else break;
        }
        logical.push({
          page: page,
          original: parts.map(function (p) { return p.original; }).join(' | '),
          text: parts.map(function (p) { return p.text; }).join(' ')
        });
        if (fxLine) logical.push(fxLine);
        i = j;
      } else {
        logical.push(cur);
        i++;
      }
    }
    return logical;
  }

  CIBC.parseTextLines = function (lines) {
    var normed = lines.map(function (l) {
      return { page: l.page, original: l.text, text: cibcNormalizeLine(l.text) };
    });
    normed = cibcJoinWrappedRows(normed);

    var periodStart = null, periodEnd = null;
    for (var p = 0; p < normed.length; p++) {
      var per = cibcParsePeriod(normed[p].text);
      if (per) { periodStart = per.start; periodEnd = per.end; break; }
    }

    var rows = [], unparsed = [], section = null, slipPage = null;
    var i = 0;
    while (i < normed.length) {
      var page = normed[i].page, original = normed[i].original, t = normed[i].text;
      i++;
      if (!t) continue;
      if (cibcIsSlipStart(t)) { slipPage = page; continue; }
      if (slipPage === page) continue; // entire payment-slip block excluded
      if (CIBC_RE_PAGE_FOOTER.test(t)) { section = null; continue; }
      if (CIBC_RE_PAYMENTS_HEADING.test(t)) { section = 'payments'; continue; }
      if (CIBC_RE_CHARGES_HEADING.test(t)) { section = 'charges'; continue; }
      if (section === null) continue;
      if (CIBC_RE_TRANS_POST.test(t) || CIBC_RE_HEADER_FRAG.test(t) ||
          CIBC_RE_COLUMN_HEADER.test(t) || CIBC_RE_CARD_LINE.test(t) ||
          CIBC_RE_BONUS_NOTE.test(t) || CIBC_RE_BONUS_NOTE_2.test(t) ||
          CIBC_RE_PREPARED_FOR.test(t) || CIBC_RE_TRANSACTIONS_FROM.test(t) ||
          CIBC_RE_INFO_BLOCK.test(t) || CIBC_RE_BARE_FRAG.test(t) ||
          CIBC_RE_MICR_LINE.test(t)) continue;
      if (CIBC_RE_TOTAL_PAYMENTS.test(t) || CIBC_RE_TOTAL_FOR.test(t) ||
          CIBC_RE_INFO_PARA_START.test(t)) { section = null; continue; }

      var m = CIBC_RE_ROW.exec(t);
      if (!m) {
        unparsed.push({ pageNumber: page, text: original, reason: 'no row pattern matched' });
        continue;
      }
      var transMonth = CIBC_MONTHS_ABBR[m[1].toLowerCase()];
      var transDay = +m[2];
      var rest = trim(m[5]), amountText = trim(m[6]);
      var description, spendCategoryRaw;
      if (section === 'charges') {
        var sc = cibcSplitCategory(rest);
        description = sc[0]; spendCategoryRaw = sc[1];
      } else {
        description = rest; spendCategoryRaw = null;
      }
      var printedMinor = amountToMinor(amountText);
      // Printed positive in the payments table, but it is money INTO the
      // card account: negate so the card equation balances.
      var signedAmountMinor = section === 'payments' ? -Math.abs(printedMinor) : printedMinor;

      var inferred = null;
      if (periodStart && periodEnd) {
        var yr = cibcInferYear(transMonth, periodStart, periodEnd);
        var dim = [31, (yr % 4 === 0 && (yr % 100 !== 0 || yr % 400 === 0)) ? 29 : 28,
                   31, 30, 31, 30, 31, 31, 30, 31, 30, 31][transMonth - 1];
        if (transMonth >= 1 && transMonth <= 12 && transDay >= 1 && transDay <= dim) {
          inferred = isoDate(yr, transMonth, transDay);
        }
      }

      var row = {
        rawDateText: m[1] + ' ' + m[2],
        rawDescription: description,
        rawAmountText: amountText,
        rawCurrency: 'CAD',
        pageNumber: page,
        rowIndex: rows.length,
        section: section,
        signedAmountMinor: signedAmountMinor,
        transDateInferred: inferred,
        dateInferred: inferred, // harness-wide alias; the engine falls back to it
        spendCategoryRaw: spendCategoryRaw
      };
      // Foreign-currency detail line belongs to the row above.
      if (section === 'charges' && i < normed.length) {
        var fm = CIBC_RE_FX.exec(normed[i].text);
        if (fm && normed[i].page === page) {
          row.fxOriginalAmount = fm[1].replace(/,/g, '');
          row.fxCurrency = fm[2];
          row.fxRate = fm[3];
          i++;
        }
      }
      rows.push(row);
    }
    return { rows: rows, unparsed: unparsed };
  };

  Parsers.CIBC = CIBC;

  /* ================================================================== */
  /* Generic statement (template generic_statement_v1)                    */
  /* ================================================================== */
  /* Fallback when detectFormat returns null: ANY bank/credit-card
   * statement PDF gets a careful heuristic read instead of a refusal.
   * Every uncertain decision is recorded (per-row confidence +
   * confidenceNote, doc-level warnings); the engine routes
   * confidence:'low' rows into the user's review queue.
   *
   * Sign trade-offs (documented, spot-checkable):
   *  - Numeric dates are read day-first (03/04/2026 -> 3 Apr), the
   *    documented order of the supported date forms. Ambiguous cases are
   *    flagged low-confidence for review.
   *  - Amount columns: 1 column -> bare amounts positive; '-' / ( ) /
   *    CR / DR markers negative. 2 columns -> left positive (charges),
   *    right negative (payments), overridden by per-column header words
   *    when the headers name them. With no header guidance the positional
   *    sign is flagged low-confidence rather than trusted.
   * Money stays integer minor units throughout (amountToMinor). */

  var GENERIC = {
    templateId: 'generic_statement_v1',
    institution: 'Generic statement'
  };

  var GENERIC_MONTHS = PC_MONTHS; // jan..dec (+sept) -> 1..12

  // Date token patterns, tried in order; the first match on a line is the
  // row date. 'skip' spans (dot dates) are never row dates but are
  // excluded from amount matching so "15.08" is not read as $15.08.
  var GENERIC_DATE_RES = [
    { kind: 'iso',  re: /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g },
    { kind: 'dmy4', re: /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g },
    { kind: 'dmy4', re: /\b(\d{1,2})-(\d{1,2})-(\d{4})\b/g },
    { kind: 'dmy2', re: /\b(\d{1,2})\/(\d{1,2})\/(\d{2})\b/g },
    { kind: 'dmy2', re: /\b(\d{1,2})-(\d{1,2})-(\d{2})\b/g },
    { kind: 'mon_d', re: /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/gi },
    { kind: 'd_mon', re: /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?(?:,?\s+(\d{4}))?\b/gi },
    { kind: 'skip', re: /\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/g }
  ];

  // Printed amount token: "$1,234.56", "1,234.56", "(123.45)",
  // "-123.45", "123.45-", "123.45CR", "123.45DR", "$ 45.67".
  var GENERIC_AMT_RE = /\(?\s*-?\s*\$?\s*\d[\d,]*\.\d{2}\s*(?:-\s*)?\)?(?:\s*(?:CR|DR))?/gi;

  var GENERIC_RE_PAGE_FOOTER = /^\s*page\s+\d+\s+of\s+\d+\b/i;
  var GENERIC_RE_START_BAL = /\b(previous\s+balance|opening\s+balance|balance\s+forward|balance\s+brought\s+forward)\b/i;
  var GENERIC_RE_END_BAL = /\b(new\s+balance|closing\s+balance|statement\s+balance|ending\s+balance|total\s+balance|amount\s+due|balance\s+due)\b/i;
  var GENERIC_RE_PERIOD_A = /([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?\s*[-\u2013\u2014]\s*([A-Za-z]{3,9})\.?\s+(\d{1,2}),\s+(\d{4})/;
  var GENERIC_RE_PERIOD_B = /(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})\s*(?:to|[-–—])\s*(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/i;
  var GENERIC_RE_STMT_DATE = /statement\s+date[^\n:]*[:\s]+([A-Za-z]+\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4})/i;
  var GENERIC_RE_YEAR = /\b(19|20)\d{2}\b/g;
  var GENERIC_COL_TOL = 15; // points: amount-column clustering tolerance

  var GENERIC_POS_WORDS = ['charge', 'charges', 'debit', 'debits', 'withdrawal', 'purchase', 'purchases', 'advance'];
  var GENERIC_NEG_WORDS = ['payment', 'payments', 'credit', 'credits', 'deposit', 'refund', 'repayment'];

  function genericMonthNum(name) {
    return GENERIC_MONTHS[String(name).toLowerCase()] || null;
  }

  /**
   * Amount token text -> {minor, explicit} or null. explicit = the printed
   * text carried its own sign marker (-, +, parens, CR, DR). Integer math
   * only; delegates the numeric part to amountToMinor.
   */
  function genericAmountToMinor(text) {
    var t = trim(text);
    if (!t) return null;
    var negative = false;
    var pm = /^\(\s*(.*\S)\s*\)$/.exec(t);
    if (pm) { negative = true; t = trim(pm[1]); }
    var dm = /^(.*?)\s*(CR|DR)$/i.exec(t);
    if (dm && /^\s*-?\s*\$?\s*[\d,]*\d\.\d{2}\s*-?\s*$/i.test(dm[1])) {
      negative = true; t = trim(dm[1]); // CR/DR suffix: credit/debit marker
    }
    var explicit = negative || /^[+-]/.test(t) || /-$/.test(t);
    var minor;
    try { minor = amountToMinor(t); } catch (e) { return null; }
    if (negative) minor = -Math.abs(minor);
    return { minor: minor, explicit: explicit };
  }

  /**
   * All date-like spans on a line: [{index, end, y, m, d, hasYear,
   * ambiguous, skip}]. Invalid month/day values are discarded.
   */
  function genericFindDates(text) {
    var out = [];
    for (var k = 0; k < GENERIC_DATE_RES.length; k++) {
      var def = GENERIC_DATE_RES[k];
      def.re.lastIndex = 0;
      var m;
      while ((m = def.re.exec(text)) !== null) {
        if (m[0].length === 0) { def.re.lastIndex++; continue; }
        var y = null, mo = null, d = null, hasYear = false, ambiguous = false;
        if (def.kind === 'skip') {
          out.push({ index: m.index, end: m.index + m[0].length, skip: true });
          continue;
        } else if (def.kind === 'iso') {
          y = +m[1]; mo = +m[2]; d = +m[3]; hasYear = true;
        } else if (def.kind === 'dmy4' || def.kind === 'dmy2') {
          var a = +m[1], b = +m[2];
          y = +m[3]; hasYear = true;
          if (def.kind === 'dmy2') y += (y >= 70 ? 1900 : 2000);
          if (a > 12 && b <= 12) { d = a; mo = b; }
          else if (b > 12 && a <= 12) { mo = a; d = b; }
          else if (a <= 12 && b <= 12) { d = a; mo = b; ambiguous = true; } // day-first default
          else continue; // both > 12: not a date
        } else if (def.kind === 'mon_d') {
          mo = genericMonthNum(m[1]); d = +m[2];
          if (m[3]) { y = +m[3]; hasYear = true; }
        } else if (def.kind === 'd_mon') {
          d = +m[1]; mo = genericMonthNum(m[2]);
          if (m[3]) { y = +m[3]; hasYear = true; }
        }
        if (mo === null || mo < 1 || mo > 12 || d < 1 || d > 31) continue;
        if (hasYear && (y < 1900 || y > 2100)) continue;
        out.push({
          index: m.index, end: m.index + m[0].length, text: m[0],
          y: y, m: mo, d: d, hasYear: hasYear, ambiguous: ambiguous, skip: false
        });
      }
    }
    out.sort(function (a, b) { return a.index - b.index; });
    return out;
  }

  /** Amount-token spans not overlapping any date span: [{index, end, text}]. */
  function genericFindAmounts(text, dateSpans) {
    var out = [];
    GENERIC_AMT_RE.lastIndex = 0;
    var m;
    while ((m = GENERIC_AMT_RE.exec(text)) !== null) {
      if (m[0].length === 0) { GENERIC_AMT_RE.lastIndex++; continue; }
      var s = m.index, e = s + m[0].length, overlap = false;
      for (var i = 0; i < dateSpans.length; i++) {
        if (e > dateSpans[i].index && s < dateSpans[i].end) { overlap = true; break; }
      }
      if (overlap) continue;
      if (genericAmountToMinor(m[0]) === null) continue;
      out.push({ index: s, end: e, text: trim(m[0]) });
    }
    return out;
  }

  /**
   * Rebuild [{page, text, frags}] lines from fragments (frag-preserving
   * variant of groupIntoLines, same y-tolerance).
   */
  function genericBuildLines(frags) {
    var byPage = {};
    frags.forEach(function (f) { (byPage[f.page] = byPage[f.page] || []).push(f); });
    var pages = Object.keys(byPage).map(Number).sort(function (a, b) { return a - b; });
    var out = [];
    pages.forEach(function (p) {
      var sorted = byPage[p].slice().sort(function (a, b) { return (b.y - a.y) || (a.x - b.x); });
      var buckets = [];
      for (var i = 0; i < sorted.length; i++) {
        var f = sorted[i];
        if (buckets.length && Math.abs(f.y - buckets[buckets.length - 1][0]) <= LINE_Y_TOLERANCE) {
          buckets[buckets.length - 1][1].push(f);
        } else {
          buckets.push([f.y, [f]]);
        }
      }
      buckets.forEach(function (bk) {
        var parts = bk[1].slice().sort(function (a, c) { return a.x - c.x; });
        var text = trim(parts.map(function (x) { return x.text; }).join(' '));
        if (text.replace(/\s/g, '')) out.push({ page: p, text: text, frags: parts });
      });
    });
    return out;
  }

  /**
   * X-center of the fragments covering [startIdx, endIdx) of a rebuilt
   * line's text (the rebuild joins fragments with single spaces).
   */
  function genericSpanCenterX(line, startIdx, endIdx) {
    var off = 0, sum = 0, n = 0;
    for (var i = 0; i < line.frags.length; i++) {
      var f = line.frags[i];
      var s = off, e = off + f.text.length;
      if (e > startIdx && s < endIdx && typeof f.cx === 'number' && isFinite(f.cx)) {
        sum += f.cx; n++;
      }
      off = e + 1;
    }
    return n ? sum / n : null;
  }

  function genericDim(y, m) {
    var dims = [31, ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0) ? 29 : 28,
                31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return dims[m - 1] || 31;
  }

  /**
   * Infer the statement year: period range -> statement date ->
   * most-common 4-digit year -> current year. Returns {year, periodStart,
   * periodEnd, note}.
   */
  function genericInferYear(docText) {
    var m = GENERIC_RE_PERIOD_A.exec(docText);
    if (m) {
      var sm = genericMonthNum(m[1]), em = genericMonthNum(m[4]);
      if (sm && em) {
        var ey = +m[6], sy = m[3] ? +m[3] : (sm > em ? ey - 1 : ey);
        return {
          year: ey,
          periodStart: isoDate(sy, sm, Math.min(+m[2], genericDim(sy, sm))),
          periodEnd: isoDate(ey, em, Math.min(+m[5], genericDim(ey, em))),
          note: 'statement period'
        };
      }
    }
    var b = GENERIC_RE_PERIOD_B.exec(docText);
    if (b) {
      var bsm = +b[2], bem = +b[5];
      var by1 = +b[3], by2 = +b[6];
      return {
        year: by2,
        periodStart: isoDate(by1, Math.min(bsm, 12), Math.min(+b[1], genericDim(by1, Math.min(bsm, 12)))),
        periodEnd: isoDate(by2, Math.min(bem, 12), Math.min(+b[4], genericDim(by2, Math.min(bem, 12)))),
        note: 'statement period'
      };
    }
    var sd = GENERIC_RE_STMT_DATE.exec(docText);
    if (sd) {
      var ym = /(\d{4})/.exec(sd[1]);
      if (ym) return { year: +ym[1], periodStart: null, periodEnd: null, note: 'statement date' };
    }
    var counts = {}, best = null, bestN = 0, ym2;
    GENERIC_RE_YEAR.lastIndex = 0;
    while ((ym2 = GENERIC_RE_YEAR.exec(docText)) !== null) {
      var yy = ym2[0];
      counts[yy] = (counts[yy] || 0) + 1;
      if (counts[yy] > bestN) { bestN = counts[yy]; best = yy; }
    }
    if (best) return { year: +best, periodStart: null, periodEnd: null, note: 'most common year in document' };
    var nowY = new Date().getFullYear();
    return { year: nowY, periodStart: null, periodEnd: null, note: 'current year (no year found in document)' };
  }

  function genericWordPolarity(word) {
    var w = String(word).toLowerCase();
    for (var i = 0; i < GENERIC_POS_WORDS.length; i++) {
      if (w === GENERIC_POS_WORDS[i]) return 1;
    }
    for (var j = 0; j < GENERIC_NEG_WORDS.length; j++) {
      if (w === GENERIC_NEG_WORDS[j]) return -1;
    }
    return 0;
  }

  /**
   * Parsers.parseGeneric(frags) -> {format, templateId, institution, rows,
   * meta, warnings} or {rows: [], noStatement: true, reason, pageCount}.
   * Pure function over collectItems fragments.
   */
  Parsers.parseGeneric = async function (frags) {
    var warnings = [];
    var lines = genericBuildLines(frags || []);
    var pageCount = 0;
    lines.forEach(function (l) { if (l.page > pageCount) pageCount = l.page; });

    var docText = lines.map(function (l) { return l.text; }).join('\n');
    var yi = genericInferYear(docText);
    warnings.push('year inferred as ' + yi.year + ' (' + yi.note + ')');
    warnings.push('numeric dates read as day/month (e.g. 03/04/2026 means 3 Apr 2026)');

    var meta = {
      period_start: yi.periodStart, period_end: yi.periodEnd,
      reported_start_balance_minor: null, reported_end_balance_minor: null
    };

    // Pass 1: balance/summary lines + candidate rows.
    var candidates = [], skippedUndated = 0;
    for (var li = 0; li < lines.length; li++) {
      // Yield every ~200 lines so long documents don't freeze the UI.
      if (li % 200 === 0) await yieldToUI();
      var line = lines[li], text = line.text;
      if (GENERIC_RE_PAGE_FOOTER.test(text)) continue;
      var dateSpans = genericFindDates(text);
      var realDates = dateSpans.filter(function (ds) { return !ds.skip; });
      var amounts = genericFindAmounts(text, dateSpans);

      if (GENERIC_RE_START_BAL.test(text) || GENERIC_RE_END_BAL.test(text)) {
        if (amounts.length) {
          var pick = GENERIC_RE_START_BAL.test(text) ? amounts[0] : amounts[amounts.length - 1];
          var bv = genericAmountToMinor(pick.text);
          if (bv) {
            if (GENERIC_RE_START_BAL.test(text) && meta.reported_start_balance_minor === null) {
              meta.reported_start_balance_minor = Math.abs(bv.minor);
            } else if (GENERIC_RE_END_BAL.test(text) && meta.reported_end_balance_minor === null) {
              meta.reported_end_balance_minor = Math.abs(bv.minor);
            }
            continue;
          }
        }
        continue;
      }
      if (!realDates.length || !amounts.length) continue;

      var dateTok = realDates[0];
      // Amount-token x-centers for every token on the line (used for
      // column clustering and balance-column exclusion below).
      var tokXs = [];
      for (var ti = 0; ti < amounts.length; ti++) {
        tokXs.push(genericSpanCenterX(line, amounts[ti].index, amounts[ti].end));
      }
      if (tokXs[0] === null) { skippedUndated++; continue; }
      var ymd = dateTok.hasYear ? isoDate(dateTok.y, dateTok.m, dateTok.d)
                                : isoDate(yi.year, dateTok.m, dateTok.d);
      candidates.push({
        line: line, page: line.page, lineIdx: li,
        dateTok: dateTok, amtToks: amounts, tokXs: tokXs,
        dateInferred: ymd
      });
    }

    if (!candidates.length) {
      return {
        rows: [], noStatement: true, pageCount: pageCount,
        reason: 'no lines with both a date and an amount'
      };
    }
    // Header window: up to 5 lines above the first candidate block (same
    // page). Used for column-header sign attribution and balance-column
    // detection. A "balance" mention only signals a balance COLUMN when it
    // sits on a header-looking line — standalone summary lines like
    // "Previous balance 1,000.00" are not column headers.
    var firstCand = candidates[0];
    var headerWindowText = '', headerHasBalanceColumn = false;
    for (var hwi = Math.max(0, firstCand.lineIdx - 5); hwi < firstCand.lineIdx; hwi++) {
      if (lines[hwi] && lines[hwi].page === firstCand.page) {
        var hwt = lines[hwi].text;
        headerWindowText += ' ' + hwt;
        if (/\bbalance\b/i.test(hwt) &&
            !GENERIC_RE_START_BAL.test(hwt) && !GENERIC_RE_END_BAL.test(hwt)) {
          headerHasBalanceColumn = true;
        }
      }
    }

    // Pass 2: amount-column clustering (~15pt tolerance) over ALL amount
    // tokens on candidate lines. When the headers name a Balance column and
    // there are 2+ clusters, the rightmost cluster is the running balance:
    // drop it and re-pick each row's amount as the first token outside that
    // column (rows with only a balance figure are not transactions).
    function clusterXs(xs) {
      var cols = [];
      var sorted = xs.slice().sort(function (a, b) { return a - b; });
      for (var xi = 0; xi < sorted.length; xi++) {
        var x = sorted[xi];
        if (cols.length && Math.abs(x - cols[cols.length - 1].x) <= GENERIC_COL_TOL) {
          var cc = cols[cols.length - 1];
          cc.x = (cc.x * cc.count + x) / (cc.count + 1);
          cc.count++;
        } else {
          cols.push({ x: x, count: 1 });
        }
      }
      return cols;
    }
    function candidateTokXs(c) {
      var out = [];
      for (var qi = 0; qi < c.tokXs.length; qi++) {
        if (c.tokXs[qi] !== null) out.push(c.tokXs[qi]);
      }
      return out;
    }
    candidates.forEach(function (c) { c.pickIdx = 0; });
    var allXs = [];
    candidates.forEach(function (c) { allXs = allXs.concat(candidateTokXs(c)); });
    var columns = clusterXs(allXs);
    if (columns.length >= 2 && headerHasBalanceColumn) {
      var balX = columns[columns.length - 1].x;
      var kept = [];
      candidates.forEach(function (c) {
        var pick = -1;
        for (var qi = 0; qi < c.tokXs.length; qi++) {
          if (c.tokXs[qi] !== null && Math.abs(c.tokXs[qi] - balX) > GENERIC_COL_TOL) { pick = qi; break; }
        }
        if (pick === -1) { skippedUndated++; return; } // balance-only line
        c.pickIdx = pick;
        kept.push(c);
      });
      candidates = kept;
      if (!candidates.length) {
        return {
          rows: [], noStatement: true, pageCount: pageCount,
          reason: 'no lines with both a date and a transaction amount'
        };
      }
      var keptXs = [];
      candidates.forEach(function (c) { keptXs.push(c.tokXs[c.pickIdx]); });
      columns = clusterXs(keptXs);
      warnings.push('rightmost amount column looks like a running balance — excluded from transaction amounts');
    }
    // Final per-candidate amount + description. The description is the
    // line with the date span and every amount-token span removed, so it
    // works whether the amount prints before or after the date.
    candidates.forEach(function (c) {
      var pi = c.pickIdx || 0;
      c.amtTok = c.amtToks[pi];
      c.amountX = c.tokXs[pi];
      var cutSpans = [{ index: c.dateTok.index, end: c.dateTok.end }];
      for (var ai = 0; ai < c.amtToks.length; ai++) {
        cutSpans.push({ index: c.amtToks[ai].index, end: c.amtToks[ai].end });
      }
      cutSpans.sort(function (p, q) { return p.index - q.index; });
      var dparts = [], dcur = 0;
      for (var di = 0; di < cutSpans.length; di++) {
        if (cutSpans[di].index > dcur) dparts.push(c.line.text.slice(dcur, cutSpans[di].index));
        dcur = Math.max(dcur, cutSpans[di].end);
      }
      dparts.push(c.line.text.slice(dcur));
      c.description = trim(dparts.join(' ').replace(/\s+/g, ' '));
    });
    var columnsUnclear = columns.length > 2;
    if (columnsUnclear) {
      warnings.push('more than two amount columns detected — column layout is unclear, all rows flagged for review');
      columns = columns.sort(function (a, b) { return b.count - a.count; }).slice(0, 2)
        .sort(function (a, b) { return a.x - b.x; });
    }
    candidates.forEach(function (c) {
      var best = 0, bd = Math.abs(c.amountX - columns[0].x);
      for (var ci = 1; ci < columns.length; ci++) {
        var dd = Math.abs(c.amountX - columns[ci].x);
        if (dd < bd) { bd = dd; best = ci; }
      }
      c.colIdx = best;
    });

    // Pass 3: header words above the first candidate block, attributed to
    // the nearest amount column by x position.
    var first = candidates[0];
    var colVotes = columns.map(function () { return { pos: 0, neg: 0 }; });
    var headerWordsSeen = false;
    for (var hi = Math.max(0, first.lineIdx - 5); hi < first.lineIdx; hi++) {
      var hl = lines[hi];
      if (!hl || hl.page !== first.page) continue;
      var words = hl.text.split(/\s+/);
      var woff = 0;
      for (var wi = 0; wi < words.length; wi++) {
        var w = words[wi];
        var wStart = hl.text.indexOf(w, woff);
        woff = wStart + w.length;
        var pol = genericWordPolarity(w.replace(/[^a-z]/gi, ''));
        if (!pol) continue;
        headerWordsSeen = true;
        var wx = genericSpanCenterX(hl, wStart, wStart + w.length);
        if (wx === null) continue;
        var bc = 0, bdist = Math.abs(wx - columns[0].x);
        for (var cj = 1; cj < columns.length; cj++) {
          var ddx = Math.abs(wx - columns[cj].x);
          if (ddx < bdist) { bdist = ddx; bc = cj; }
        }
        if (pol > 0) colVotes[bc].pos++; else colVotes[bc].neg++;
      }
    }
    var colSigns = [], headerClear = false;
    for (var si = 0; si < columns.length; si++) {
      var v = colVotes[si];
      if (v.neg > v.pos) { colSigns.push(-1); headerClear = true; }
      else if (v.pos > v.neg) { colSigns.push(1); headerClear = true; }
      else colSigns.push(si === 0 ? 1 : -1); // positional default
    }
    if (columns.length >= 2) {
      if (headerClear && headerWordsSeen) {
        warnings.push('sign convention inferred from column headers — please spot-check');
      } else {
        warnings.push('amount columns have no clear headers — positional sign assumed (left positive, right negative), rows flagged for review');
      }
    } else {
      warnings.push('single amount column: bare amounts read as charges (positive); - / ( ) / CR / DR read as credits (negative) — please spot-check');
    }

    // Pass 4: rows with sign + confidence.
    var rows = [], lowCount = 0;
    for (var ri = 0; ri < candidates.length; ri++) {
      var c = candidates[ri];
      var av = genericAmountToMinor(c.amtTok.text);
      if (!av) { skippedUndated++; continue; }
      var colSign = colSigns[c.colIdx] || 1;
      var signed, signBasis;
      if (av.explicit) { signed = av.minor; signBasis = 'explicit'; }
      else if (columns.length === 1) { signed = Math.abs(av.minor); signBasis = 'default'; }
      else { signed = colSign * Math.abs(av.minor); signBasis = headerClear ? 'header' : 'assumed'; }

      var conf = 'high', notes = [];
      if (!c.description) { conf = 'low'; notes.push('empty description'); }
      if (c.dateTok.ambiguous) {
        conf = 'low';
        notes.push('ambiguous date (day/month order uncertain) — read as ' + c.dateInferred);
      }
      if (signBasis === 'assumed') {
        conf = 'low';
        notes.push('ambiguous sign — no header or marker; assumed ' + (signed < 0 ? 'negative' : 'positive'));
      } else if (signBasis === 'header' || signBasis === 'default') {
        if (conf !== 'low') conf = 'medium';
        notes.push(signBasis === 'header' ? 'sign from column headers — spot-check'
                                          : 'single amount column — positive assumed, spot-check');
      }
      if (columnsUnclear) {
        conf = 'low';
        notes.push('amount column unclear');
      }
      var confidenceNote = notes.length ? notes.join('; ') : 'heuristic read, all markers clear';
      if (conf === 'low') lowCount++;

      rows.push({
        rawDateText: c.dateTok.text,
        rawDescription: c.description,
        rawAmountText: c.amtTok.text,
        rawCurrency: 'CAD',
        signedAmountMinor: signed,
        dateInferred: c.dateInferred,
        pageNumber: c.page,
        rowIndex: rows.length,
        confidence: conf,
        confidenceNote: confidenceNote
      });
    }
    if (skippedUndated) {
      warnings.push(skippedUndated + ' line(s) with a date and amount could not be placed and were skipped');
    }
    if (lowCount) {
      warnings.push(lowCount + ' of ' + rows.length + ' rows are low-confidence and need review');
    }

    return {
      format: 'generic_statement',
      templateId: GENERIC.templateId,
      institution: GENERIC.institution,
      rows: rows,
      meta: meta,
      warnings: warnings
    };
  };

  // Expose for tests (not part of the app contract).
  Parsers._internals.parseGeneric = Parsers.parseGeneric;
  Parsers._internals.genericAmountToMinor = genericAmountToMinor;
  Parsers._internals.genericFindDates = genericFindDates;

  /* ================================================================== */
  /* Top-level PDF driver                                                 */
  /* ================================================================== */

  /**
   * Parsers.parsePdf(arrayBuffer, pdfjsLib, onProgress) ->
   *   Promise<{format, templateId, institution, rows, meta, warnings?}>.
   * Rows follow the raw-row contract (see file header). The two validated
   * templates are tried first; anything else falls back to the generic
   * heuristic parser. onProgress(page, numPages) is optional and is
   * called once per extracted page. Raises an Error naming the problem
   * when the PDF has no readable statement content.
   */
  Parsers.parsePdf = async function (arrayBuffer, pdfjsLib, onProgress) {
    if (!pdfjsLib || typeof pdfjsLib.getDocument !== 'function') {
      throw new Error('PDF engine not loaded.');
    }
    var data = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
    var pdf = await pdfjsLib.getDocument({
      data: data, useWorkerFetch: false, isEvalSupported: false
    }).promise;
    try {
      var frags = await Parsers.collectItems(pdf, null, onProgress);
      // Detect on page-1 lines rebuilt in reading order (pdf.js emits one
      // word per item on some statements, so raw fragments never contain
      // multi-word markers like "statement date").
      var page1 = frags.filter(function (f) { return f.page === 1; });
      var detectLines = extractLines(page1, null);
      var firstPageText = detectLines.map(function (l) { return l.text; }).join('\n');
      var format = Parsers.detectFormat(firstPageText);
      if (!format) {
        var generic = await Parsers.parseGeneric(frags);
        if (generic.noStatement) {
          var n = generic.pageCount || 0;
          throw new Error('This PDF doesn\'t look like a bank or credit-card ' +
            'statement we can read: found ' + n + ' pages but no lines with ' +
            'both a date and an amount.');
        }
        return generic;
      }
      var P = format === 'pc_financial' ? PC : CIBC;
      var lines = P.extractLines(frags);
      var parsed = P.parseTextLines(lines);
      if (parsed.unparsed.length) {
        var details = parsed.unparsed.slice(0, 5).map(function (u) {
          return 'page ' + u.pageNumber + ': ' + JSON.stringify(String(u.text).slice(0, 80));
        }).join('; ');
        throw new Error(parsed.unparsed.length + ' transaction-table line(s) could not ' +
          'be parsed (refusing to guess): ' + details);
      }
      var meta = P.parseMetadata(lines);
      return {
        format: format,
        templateId: P.templateId,
        institution: P.institution,
        rows: parsed.rows,
        meta: meta
      };
    } finally {
      if (pdf && pdf.destroy) { try { await pdf.destroy(); } catch (e) { /* ignore */ } }
    }
  };
  // Expose global (ES2019-safe global lookup; mirrors engine.js).
  var _g = (typeof window !== 'undefined') ? window
         : (typeof global !== 'undefined') ? global
         : this;
  _g.Parsers = Parsers;
  if (typeof module !== 'undefined' && module.exports) module.exports = Parsers;
})();
