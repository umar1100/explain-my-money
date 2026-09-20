/* ============================================================================
 * generic-table.js — "Explain My Money": layout-INFERENCE credit-card
 * statement reader.
 * ----------------------------------------------------------------------------
 * Unlike the hard-coded template parsers in parsers.js (PC Financial, CIBC
 * Costco), this module infers the transaction table layout from geometry:
 * it clusters date-like and amount-like tokens into columns, confirms them
 * against header keywords when present, and assembles rows from
 * date+amount lines with description continuation. Any bank/credit-card
 * statement PDF with a recognizable date/description/amount table should
 * produce rows — no per-bank template required.
 *
 * PURE FUNCTIONS. No DOM, no network, no storage. ES2019 (no modules,
 * no optional chaining, no nullish coalescing, no BigInt). Exposes global
 * `GenericTable`; also `module.exports` when available (node tests).
 *
 * Input:  GenericTable.parse(pages)
 *   pages = array of pages; each page = array of text items
 *   {x, y, str, w?, h?} in PDF points, y-up (pdf.js convention).
 *   `str` may also be spelled `text`; `cx` may substitute for w.
 *   Convenience: GenericTable.parseFrags(frags) accepts the flat
 *   [{page,x,y,cx,text}] shape produced by Parsers.collectPageItems.
 *
 * Output: { rows, anchors, excluded, confidence, notes }
 *   rows: [{ date:'YYYY-MM-DD'|null, postingDate, description,
 *            amountMinor (signed int; purchases positive), section:
 *            'purchases'|'payments'|'fees'|'interest'|'other',
 *            confidence:0..1, source:'generic', page, rawDateText,
 *            rawAmountText, needsReview, reviewReason, signSource }]
 *   anchors: { periodStart, periodEnd, prevBalanceMinor, newBalanceMinor,
 *            minPaymentMinor, dueDate, totalsBySection:{section:minor},
 *            currency, patterns:{which regex matched per anchor} }
 *   excluded: [{line, reason}] — every deliberately-skipped row-like line.
 *   confidence: 0..1 document-level confidence.
 *   notes: human-readable caveats.
 *
 * Money is ALWAYS integer minor units. Nothing is silently dropped:
 * skipped row-like lines land in `excluded`; uncertain rows are flagged
 * needsReview instead of being guessed.
 * ========================================================================== */
(function () {
  'use strict';

  var GenericTable = {};
  GenericTable.version = 'generic-table-v1';

  /* ------------------------------------------------------------------ */
  /* Tiny helpers                                                         */
  /* ------------------------------------------------------------------ */

  function trim(s) { return String(s == null ? '' : s).replace(/^\s+|\s+$/g, ''); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  var MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
                 jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

  function daysInMonth(y, m) {
    if (m === 2) return (((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0) ? 29 : 28);
    return (m === 4 || m === 6 || m === 9 || m === 11) ? 30 : 31;
  }
  function validDate(y, m, d) {
    return y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
  }
  function iso(y, m, d) { return y + '-' + pad2(m) + '-' + pad2(d); }

  /**
   * Printed amount -> integer minor units (magnitude; sign handled by the
   * caller via explicit markers / column roles / section rules).
   * Handles "$1,234.56", "-$123.45", "$123.45-", "(12.34)", "12.34CR",
   * "-  $433.27", "+  $1,273.26", "0.00". Throws on anything unparseable.
   * Exactly two decimals are required — years, percentages and long
   * reference numbers are never amounts.
   */
  function amountToMinor(text) {
    var t = trim(text).replace(/[\u2013\u2014]/g, '-'); // en/em dash -> hyphen
    if (t === '') throw new Error('empty amount text');
    var negative = false;
    if (/^\(.*\)$/.test(t)) { negative = true; t = trim(t.slice(1, -1)); }
    if (/CR$/i.test(t)) { negative = true; t = trim(t.slice(0, -2)); }
    if (t.charAt(0) === '-') { negative = true; t = trim(t.slice(1)); }
    else if (t.charAt(0) === '+') { t = trim(t.slice(1)); }
    else if (t.charAt(t.length - 1) === '-') { negative = true; t = trim(t.slice(0, -1)); }
    t = t.replace(/[$\s,]/g, '');
    var m = /^(\d+)\.(\d{2})$/.exec(t);
    if (!m) throw new Error('unparseable amount: ' + text);
    var digits = m[1].replace(/^0+(?=\d)/, '') || '0';
    var minor = 0, i;
    for (i = 0; i < digits.length; i++) minor = minor * 10 + (digits.charCodeAt(i) - 48);
    minor = minor * 100 + (m[2].charCodeAt(0) - 48) * 10 + (m[2].charCodeAt(1) - 48);
    return negative ? -minor : minor;
  }

  /* ------------------------------------------------------------------ */
  /* Item normalisation: accept {x,y,str|text,w,cx}                        */
  /* ------------------------------------------------------------------ */

  function normItems(pageItems) {
    var out = [];
    for (var i = 0; i < (pageItems || []).length; i++) {
      var it = pageItems[i] || {};
      var s = (it.str != null ? it.str : it.text);
      s = String(s == null ? '' : s);
      if (!s.replace(/\s/g, '')) continue;
      var x = +it.x || 0, y = +it.y || 0;
      var w = (typeof it.w === 'number' && isFinite(it.w) && it.w > 0) ? it.w : 0;
      var cx = (typeof it.cx === 'number' && isFinite(it.cx)) ? it.cx : x + w / 2;
      out.push({ x: x, y: y, w: w, cx: cx, str: s });
    }
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Line reconstruction: y-banding (3pt), fragments sorted by x, then   */
  /* word tokens with estimated x positions for column work.              */
  /* ------------------------------------------------------------------ */

  var LINE_Y_TOL = 3;

  function buildLines(items) {
    var sorted = items.slice().sort(function (a, b) {
      return (b.y - a.y) || (a.x - b.x);
    });
    var buckets = []; // [anchorY, [items]] — anchor never chains
    for (var i = 0; i < sorted.length; i++) {
      var f = sorted[i];
      if (buckets.length && Math.abs(f.y - buckets[buckets.length - 1][0]) <= LINE_Y_TOL) {
        buckets[buckets.length - 1][1].push(f);
      } else {
        buckets.push([f.y, [f]]);
      }
    }
    var lines = [];
    for (var b = 0; b < buckets.length; b++) {
      var frags = buckets[b][1].slice().sort(function (a, c) { return a.x - c.x; });
      var text = '';
      var tokens = [];
      for (var k = 0; k < frags.length; k++) {
        var fr = frags[k];
        if (text.length) text += ' ';
        var base = text.length;
        text += fr.str;
        // Word tokens with estimated x: proportional to char offsets.
        var fw = fr.w > 0 ? fr.w : Math.max(fr.str.length * 5.2, 1);
        var parts = fr.str.split(/(\s+)/);
        var off = 0;
        for (var p = 0; p < parts.length; p++) {
          var part = parts[p];
          if (!part) { continue; }
          if (!/^\s+$/.test(part)) {
            tokens.push({ t: part, x: fr.x + fw * off / fr.str.length, start: base + off });
          }
          off += part.length;
        }
      }
      // Merge a standalone "-" / "+" with a following amount-like token
      // ("- $433.27", "+ $10.00").
      var merged = [];
      for (var m = 0; m < tokens.length; m++) {
        var tk = tokens[m];
        if ((tk.t === '-' || tk.t === '+') && m + 1 < tokens.length &&
            /^[($]?\d/.test(tokens[m + 1].t)) {
          merged.push({ t: tk.t + tokens[m + 1].t, x: tk.x, start: tk.start });
          m++;
        } else {
          merged.push(tk);
        }
      }
      lines.push({ y: buckets[b][0], frags: frags, text: text, tokens: merged });
    }
    return lines;
  }

  /* ------------------------------------------------------------------ */
  /* Date token parsing. Returns {month, day, year|null, x, n} (n =      */
  /* tokens consumed) or null.                                           */
  /* ------------------------------------------------------------------ */

  var MONTH_RE = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?$/i;
  var DAY_RE = /^(\d{1,2})(?:st|nd|rd|th)?,?$/;
  var YEAR_RE = /^(\d{4})$/;
  var ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  var SLASH_RE = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/;

  function parseDateAt(tokens, i) {
    var tk = tokens[i];
    if (!tk) return null;
    var t = tk.t, m;
    if ((m = ISO_RE.exec(t))) {
      var yy = +m[1], mm = +m[2], dd = +m[3];
      if (!validDate(yy, mm, dd)) return null;
      return { month: mm, day: dd, year: yy, slash: null, x: tk.x, n: 1 };
    }
    if ((m = SLASH_RE.exec(t))) {
      var a = +m[1], b = +m[2], yv = null;
      if (m[3]) { yv = +m[3]; if (yv < 100) yv += 2000; }
      if (a < 1 || b < 1 || a > 31 || b > 31) return null;
      return { month: 0, day: 0, year: yv, slash: { a: a, b: b }, x: tk.x, n: 1 };
    }
    if (MONTH_RE.test(t)) {
      var mon = MONTHS[t.toLowerCase().replace(/[^a-z]/g, '').slice(0, 3)] ||
                MONTHS[t.toLowerCase().replace(/[^a-z]/g, '')];
      var dtk = tokens[i + 1];
      if (!dtk) return null;
      var dm = DAY_RE.exec(dtk.t);
      if (!dm) return null;
      var day = +dm[1];
      var yr = null, n = 2;
      var ytk = tokens[i + 2];
      if (ytk) {
        var ym = YEAR_RE.exec(ytk.t);
        if (ym) { yr = +ym[1]; n = 3; }
      }
      if (day < 1 || day > 31) return null;
      return { month: mon, day: day, year: yr, slash: null, x: tk.x, n: n };
    }
    return null;
  }

  /**
   * Amount token parsing. Returns {minor, explicitNeg, x, right} or null.
   * explicitNeg: the token itself carried a sign marker (-, parens, CR).
   * Rejects tokens followed by '%' (interest rates) and anything that is
   * not exactly-two-decimals.
   */
  function parseAmountAt(tokens, i, lineText) {
    var tk = tokens[i];
    if (!tk) return null;
    var after = lineText.slice(tk.start + tk.t.length);
    var nxt = /^\s*(.)/.exec(after);
    if (nxt && nxt[1] === '%') return null; // interest rate, not money
    var minor;
    try { minor = amountToMinor(tk.t); }
    catch (e) { return null; }
    var explicitNeg = minor < 0;
    var mag = explicitNeg ? -minor : minor;
    var estW = Math.max(tk.t.length * 5.2, 1);
    return { minor: mag, explicitNeg: explicitNeg, x: tk.x, right: tk.x + estW };
  }

  /* ------------------------------------------------------------------ */
  /* Column discovery (per page)                                           */
  /* ------------------------------------------------------------------ */

  function clusterByX(points, tol) {
    // points: [{x, ...}] -> clusters [{x (mean), items}] sorted by x.
    var s = points.slice().sort(function (a, b) { return a.x - b.x; });
    var clusters = [];
    for (var i = 0; i < s.length; i++) {
      var c = clusters[clusters.length - 1];
      if (c && Math.abs(s[i].x - c.x) <= tol) {
        c.items.push(s[i]);
        var sum = 0;
        for (var k = 0; k < c.items.length; k++) sum += c.items[k].x;
        c.x = sum / c.items.length;
      } else {
        clusters.push({ x: s[i].x, items: [s[i]] });
      }
    }
    return clusters;
  }

  // Header keyword stems, matched against lowercased words.
  function headerStem(word) {
    var w = String(word).toLowerCase();
    if (w === 'dd/mm') return 'ddmm';
    if (w === 'date') return 'date';
    if (/^trans/.test(w)) return 'trans';
    if (/^post/.test(w)) return 'post';
    if (w === 'description' || w === 'details') return 'desc';
    if (/^amount/.test(w)) return 'amount';
    if (/^debit/.test(w)) return 'debit';
    if (/^credit/.test(w)) return 'credit';
    if (/^charg/.test(w)) return 'charge';
    if (/^pay/.test(w)) return 'pay';
    if (/\(\$\)/.test(w)) return 'money';
    return null;
  }

  /**
   * Scan fragments for header keywords, grouped into y-bands first.
   * A header is a set of column labels sharing one horizontal line, so a
   * y-band (±4pt) only counts as a header band when it carries >= 2
   * distinct header stems with at least one date-ish or strong amount-ish
   * stem. This keeps transaction-row words ("PAYMENT RBC") and summary
   * prose ("Payment due date ...") from polluting the column geometry:
   * those sit alone (or without a date/amount partner) on their band.
   * Returns { confirmed, txnDateX, postDateX, amountX, creditX, debitX }.
   * confirmed: a date column AND an amount column were both recognised.
   */
  function detectHeader(frags) {
    var hits = [];
    for (var i = 0; i < frags.length; i++) {
      var fwords = String(frags[i].str).split(/\s+/).filter(function (w) { return !!w; });
      for (var k = 0; k < fwords.length; k++) {
        var stem = headerStem(fwords[k]);
        if (stem) hits.push({ x: frags[i].x, y: frags[i].y, stem: stem, fi: i, fw: fwords.length });
      }
    }
    hits.sort(function (a, b) { return b.y - a.y || a.x - b.x; });
    var bands = [], cur = null, h;
    for (h = 0; h < hits.length; h++) {
      var hit = hits[h];
      if (!cur || Math.abs(hit.y - cur.y) > 4) { cur = { y: hit.y, items: [], frags: {} }; bands.push(cur); }
      cur.items.push(hit);
      // Total words on the band (each fragment counted once).
      if (!cur.frags[hit.fi]) { cur.frags[hit.fi] = 1; cur.words = (cur.words || 0) + hit.fw; }
    }
    var dateXs = [], amountXs = [], creditXs = [], debitXs = [], b, c, j;
    for (b = 0; b < bands.length; b++) {
      var set = {}, items = bands[b].items, stemCount = 0, wordCount = 0;
      for (j = 0; j < items.length; j++) set[items[j].stem] = 1;
      // Header density: a real header line is mostly header words. Prose
      // that happens to contain a couple ("TRANSACTION POSTING understated
      // or remove any credits ...", "Payment due date ...") is rejected.
      var seen = {};
      for (j = 0; j < items.length; j++) {
        if (!seen[items[j].x + '|' + items[j].stem]) {
          seen[items[j].x + '|' + items[j].stem] = 1;
          stemCount++;
        }
      }
      wordCount = bands[b].words;
      var keys = Object.keys(set);
      if (keys.length < 2) continue;
      if (wordCount > 0 && stemCount / wordCount < 0.5) continue;
      var dateish = set.trans || set.post || set.date || set.ddmm;
      // Strong amount stems only: 'pay' is deliberately excluded — it is
      // far too polluted by row words ("PAYMENT RBC") and summary prose
      // ("Payment due date") to anchor the amount column.
      var strongAmt = set.amount || set.debit || set.credit || set.charge;
      if (!dateish && !strongAmt) continue;
      var byX = clusterByX(items, 30);
      for (c = 0; c < byX.length; c++) {
        var cset = {};
        for (j = 0; j < byX[c].items.length; j++) cset[byX[c].items[j].stem] = 1;
        if (cset.ddmm || cset.date || cset.trans || cset.post) dateXs.push(byX[c].x);
        if (cset.amount || cset.debit || cset.credit || cset.charge) {
          amountXs.push(byX[c].x);
          if ((cset.credit || cset.pay) && !cset.debit) creditXs.push(byX[c].x);
          if (cset.debit || (cset.charge && !cset.credit && !cset.pay)) debitXs.push(byX[c].x);
        } else if ((cset.pay || cset.money) && strongAmt) {
          // A "Payments"/"($)" money column is only trusted beside a real
          // amount header (e.g. "Charges | Payments"), never alone.
          if (cset.pay && !cset.debit) creditXs.push(byX[c].x);
        }
      }
    }
    dateXs.sort(function (a, b) { return a - b; });
    amountXs.sort(function (a, b) { return a - b; });
    // Dedupe (stacked header words report the same column twice).
    function dedupe(xs) {
      var out = [];
      for (var i = 0; i < xs.length; i++) {
        if (!out.length || xs[i] - out[out.length - 1] > 12) out.push(xs[i]);
      }
      return out;
    }
    dateXs = dedupe(dateXs);
    amountXs = dedupe(amountXs);
    var confirmed = dateXs.length > 0 && amountXs.length > 0;
    return {
      confirmed: confirmed,
      txnDateX: dateXs.length ? dateXs[0] : null,
      postDateX: dateXs.length > 1 ? dateXs[1] : null,
      amountX: amountXs.length ? amountXs[0] : null,
      creditX: creditXs.length ? creditXs[0] : null,
      debitX: debitXs.length ? debitXs[0] : null
    };
  }

  /* ------------------------------------------------------------------ */
  /* Per-page column discovery                                            */
  /* ------------------------------------------------------------------ */

  var DATE_CLUSTER_TOL = 12;
  var AMOUNT_CLUSTER_TOL = 14;

  /**
   * discoverColumns(dateToks, amtToks, header, frags) ->
   *   { txnDateX, postDateX, descLeft, descRight, amountClusters:[{right,minX}],
   *     creditRight|null, positionalCreditRight|null, headerConfirmed }
   * dateToks: [{x, right}], amtToks: [{x, right}].
   */
  function discoverColumns(dateToks, amtToks, header) {
    var dateClusters = clusterByX(dateToks.map(function (t) { return { x: t.x }; }), DATE_CLUSTER_TOL);
    // Amount clusters keyed by RIGHT edge (amounts are usually right-aligned).
    var amtPts = amtToks.map(function (t) { return { x: t.right, left: t.x }; });
    var amtClusters = clusterByX(amtPts, AMOUNT_CLUSTER_TOL);
    var amountClusters = amtClusters.map(function (c) {
      var minX = Infinity;
      for (var i = 0; i < c.items.length; i++) minX = Math.min(minX, c.items[i].left);
      return { right: c.x, minX: minX, count: c.items.length };
    });

    var txnDateX = null, postDateX = null, descLeft = 0;
    if (header.confirmed && header.txnDateX != null) {
      txnDateX = header.txnDateX;
      postDateX = header.postDateX;
      // descLeft = right edge of the txn/posting date token clusters.
      var edges = [];
      for (var i = 0; i < dateToks.length; i++) {
        if (Math.abs(dateToks[i].x - txnDateX) <= DATE_CLUSTER_TOL ||
            (postDateX != null && Math.abs(dateToks[i].x - postDateX) <= DATE_CLUSTER_TOL)) {
          edges.push(dateToks[i].right);
        }
      }
      if (edges.length) descLeft = Math.max.apply(null, edges);
    } else if (dateClusters.length) {
      txnDateX = dateClusters[0].x;
      postDateX = dateClusters.length > 1 ? dateClusters[1].x : null;
      var edges2 = [];
      for (var j = 0; j < dateToks.length; j++) {
        if (Math.abs(dateToks[j].x - txnDateX) <= DATE_CLUSTER_TOL ||
            (postDateX != null && Math.abs(dateToks[j].x - postDateX) <= DATE_CLUSTER_TOL)) {
          edges2.push(dateToks[j].right);
        }
      }
      if (edges2.length) descLeft = Math.max.apply(null, edges2);
    }

    // descRight: left edge of the transaction table's amount column.
    // When the header is confirmed, anchor on the header's amountX so that
    // unrelated amount clusters (right-side summaries, interest tables,
    // running balances) can never become the description boundary or the
    // row-amount source. Without a header, fall back to the leftmost
    // amount cluster clearly right of the description area.
    var descRight = Infinity, ar, txnAmountCluster = null;
    if (header.confirmed && header.amountX != null) {
      var best = null, bestD = 60;
      for (ar = 0; ar < amountClusters.length; ar++) {
        var dA = Math.abs(amountClusters[ar].right - header.amountX);
        if (dA < bestD) { bestD = dA; best = amountClusters[ar]; }
      }
      if (best && best.right > descLeft + 30) { descRight = best.minX; txnAmountCluster = best; }
    }
    if (!isFinite(descRight)) {
      for (ar = 0; ar < amountClusters.length; ar++) {
        if (amountClusters[ar].right > descLeft + 30) {
          if (amountClusters[ar].minX < descRight) {
            descRight = amountClusters[ar].minX;
            txnAmountCluster = amountClusters[ar];
          }
        }
      }
    }
    if (!isFinite(descRight)) descRight = descLeft + 400;

    // Credit-column role: only when a genuine debit/credit (or charge/pay)
    // header PAIR exists — a lone "Payment due date" line elsewhere on the
    // page must never flip every amount negative.
    var creditRight = null;
    if (header.creditX != null) {
      // Count amount-ish header columns via the header object.
      var nAmtHeaders = (header.amountX != null ? 1 : 0) + (header.creditX != null ? 1 : 0) +
                        (header.debitX != null ? 1 : 0);
      if (header.debitX != null || nAmtHeaders >= 2) {
        var best = null, bestD = 150;
        for (var c2 = 0; c2 < amountClusters.length; c2++) {
          var dd = Math.abs(amountClusters[c2].right - (header.creditX + 35));
          if (dd < bestD) { bestD = dd; best = amountClusters[c2]; }
        }
        if (best) creditRight = best.right;
      }
    }

    // Positional credit convention (last resort): two or more amount
    // columns with NO header naming a credit/payment column and no
    // confirmed header at all. The rightmost cluster is read as
    // payments/credits (negative) — but only at low confidence and
    // flagged for review, never silently trusted. This mirrors the
    // legacy heuristic's documented trade-off ("no header guidance:
    // positional sign is flagged low-confidence rather than trusted").
    var positionalCreditRight = null;
    if (creditRight == null && !header.confirmed && amountClusters.length >= 2) {
      var prc = amountClusters[0], pci;
      for (pci = 1; pci < amountClusters.length; pci++) {
        if (amountClusters[pci].right > prc.right) prc = amountClusters[pci];
      }
      if (!txnAmountCluster ||
          Math.abs(prc.right - txnAmountCluster.right) > AMOUNT_CLUSTER_TOL) {
        positionalCreditRight = prc.right;
      }
    }

    return {
      txnDateX: txnDateX, postDateX: postDateX, descLeft: descLeft,
      descRight: descRight - 4, amountClusters: amountClusters,
      txnAmountRight: txnAmountCluster ? txnAmountCluster.right : null,
      creditRight: creditRight, positionalCreditRight: positionalCreditRight,
      headerConfirmed: header.confirmed
    };
  }

  function amountInClusters(amtTok, cols) {
    for (var i = 0; i < cols.amountClusters.length; i++) {
      if (Math.abs(amtTok.right - cols.amountClusters[i].right) <= AMOUNT_CLUSTER_TOL) return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------ */
  /* Sections, exclusions, totals                                         */
  /* ------------------------------------------------------------------ */

  var SECTION_RE = /^\s*(your\s+)?(purchases|new charges and credits|payments?( and credits?)?|returns?( and other credits?)?|fees?|interest( charges?)?|cash advances?|other charges?)(\s*[-–—]\s*.*)?\s*$/i;

  function sectionOf(text) {
    var m = SECTION_RE.exec(text);
    if (!m) return null;
    var s = m[2].toLowerCase();
    if (/purchas/.test(s) || /charges and credits/.test(s)) return 'purchases';
    if (/payment/.test(s)) return 'payments';
    if (/fee/.test(s)) return 'fees';
    if (/interest/.test(s)) return 'interest';
    if (/cash/.test(s)) return 'other';
    if (/return|credit/.test(s)) return 'payments';
    return 'other';
  }

  // Lines that are never transactions (unless they ALSO carry a real
  // date+amount row — a genuine merchant containing these words).
  var EXCLUDE_RE = /total|subtotal|previous balance|balance from|new balance|statement balance|total balance|balance due|amount due|carried|brought forward|payment due|pay this amount|please pay/i;

  // Summary date-range lines ("Payments received Jul 28 to Aug 27, 2026").
  // Statement-summary language — never a transaction, even when the line
  // also carries an amount.
  var RECEIVED_RANGE_RE = /^(payments?|purchases?|credits?|returns?|fees?|interest|cash advances?)\s+received\b/i;

  // (totalsSectionAnywhere / TOTAL_WORD_RE / TOTAL_MARK_RE defined below)

  // Section-total recognition, matched ANYWHERE in the line (summary tables
  // often share the line with card numbers or other sections, e.g.
  // "XXXX XXXX XX07 8967 + Purchases $6,819.77").
  // Two tiers: tier 1 has an explicit total/subtotal word ("Total charges",
  // "Total payment activity") and always wins; tier 2 is a bare section
  // word behind a +/-/bullet summary marker ("+ Purchases", "- Payments").
  var TOTAL_WORD_RE = /(total|subtotal)\s+(purchases?|payments?|payment activity|credits?|returns?(?: and other credits?)?|fees?|interest|cash advances?|charges?)\b/i;

  function totalsSectionAnywhere(text, currentSection) {
    var m = TOTAL_WORD_RE.exec(text);
    if (m) return sectionOfWord(m[2], 1, m.index);
    // A bare "Subtotal" belongs to the current section.
    m = /subtotal/i.exec(text);
    if (m) return { section: currentSection || 'purchases', negative: false, tier: 1, index: m.index };
    // Tier 2: the +/-/bullet summary marker is REQUIRED. A bare section
    // word at line start is usually a section header ("Purchases ...") or
    // an interest-rate table row ("Purchases $0.00 21.99 % ..."), not a total.
    m = /[+\-–•]\s*(purchases?|payments?|credits?|returns?|fees?|interest|cash advances?|charges?)\b/i.exec(text);
    if (m) return sectionOfWord(m[1], 2, m.index);
    return null;
  }

  function sectionOfWord(s, tier, index) {
    s = s.toLowerCase();
    var section;
    if (/purchas/.test(s) || /charge/.test(s)) section = 'purchases';
    else if (/payment/.test(s) || /credit/.test(s) || /return/.test(s)) section = 'payments';
    else if (/fee/.test(s)) section = 'fees';
    else if (/interest/.test(s)) section = 'interest';
    else section = 'other';
    var negative = /payment|credit|return/.test(s);
    return { section: section, negative: negative, tier: tier, index: index };
  }

  var REFUND_RE = /refund|returned|credit adjustment|credit memo/i;

  /* ------------------------------------------------------------------ */
  /* Anchors: statement-level facts from non-row lines                    */
  /* ------------------------------------------------------------------ */

  function parseMonthDate(s, defaultYear) {
    var m = /([a-z]+)\.?\s+(\d{1,2}),?\s*(\d{4})?/i.exec(trim(s));
    if (!m) return null;
    var key = m[1].toLowerCase().replace(/[^a-z]/g, '');
    var mon = MONTHS[key.slice(0, 3)] || MONTHS[key];
    if (!mon) return null;
    var yr = m[3] ? +m[3] : (defaultYear || null);
    if (yr == null) return null;
    var day = +m[2];
    if (!validDate(yr, mon, day)) return null;
    return iso(yr, mon, day);
  }

  function firstAmount(text) {
    var toks = String(text).split(/\s+/);
    for (var i = 0; i < toks.length; i++) {
      try {
        var v = amountToMinor(toks[i]);
        return v < 0 ? -v : v; // anchors are magnitudes
      } catch (e) { /* not an amount */ }
    }
    return null;
  }

  /**
   * Pre-scan JUST the statement period (needed for year inference before
   * rows are assembled). Period phrasing ("Statement period:", "For the
   * period:") never appears inside a transaction row, so every line is
   * scanned — even one that also carries an amount (e.g. "Statement
   * balance: $6,305.60 Statement period: Aug. 16, 2026 - Sept. 15, 2026").
   */
  function prescanPeriod(lines, doc) {
    var A = doc.anchors;
    for (var i = 0; i < lines.length; i++) {
      var L = lines[i];
      var t = L.line.text, m;
      if (A.periodStart) break;
      if ((m = /for the period:\s*(.+?)\s+to\s+(.+)/i.exec(t))) {
        var e = parseMonthDate(m[2], null);
        var s = parseMonthDate(m[1], e ? +e.slice(0, 4) : null);
        if (s && e) { A.periodStart = s; A.periodEnd = e; A.patterns.period = 'for the period: X to Y'; }
      } else if ((m = /statement period:\s*(.+?)\s*[-–—]\s*(.+)/i.exec(t))) {
        var e2 = parseMonthDate(m[2], null);
        var s2 = parseMonthDate(m[1], e2 ? +e2.slice(0, 4) : null);
        if (s2 && e2) { A.periodStart = s2; A.periodEnd = e2; A.patterns.period = 'statement period: X - Y'; }
      } else if ((m = /statement period\s+(.+?)\s+to\s+(.+)/i.exec(t))) {
        var e3 = parseMonthDate(m[2], null);
        var s3 = parseMonthDate(m[1], e3 ? +e3.slice(0, 4) : null);
        if (s3 && e3) { A.periodStart = s3; A.periodEnd = e3; A.patterns.period = 'X statement period Y to Z'; }
      } else if ((m = /(?:transactions?|account activity)\s+from\s+(.+?)\s+to\s+(.+)/i.exec(t))) {
        var e4 = parseMonthDate(m[2], null);
        var s4 = parseMonthDate(m[1], e4 ? +e4.slice(0, 4) : null);
        if (s4 && e4) { A.periodStart = s4; A.periodEnd = e4; A.patterns.period = 'transactions from Y to Z'; }
      }
    }
    if (!A.periodStart) doc.notes.push('statement period not found — year inference falls back to the current year');
  }

  /** Full anchor extraction over non-row lines (with 2-line lookahead). */
  function extractAnchors(lines, doc) {
    var A = doc.anchors;
    for (var i = 0; i < lines.length; i++) {
      var L = lines[i];
      if (L.isRow) continue;
      var t = L.line.text;
      var ahead = t;
      for (var k = 1; k <= 2 && i + k < lines.length; k++) {
        if (!lines[i + k].isRow) ahead += ' ' + lines[i + k].line.text;
      }
      var m, v;
      if (A.newBalanceMinor == null) {
        // Proximity guard (m[0].length): the amount must sit close to the
        // keyword — "Previous balance New this period ... $2.94" in a
        // rewards table must not become the account's previous balance.
        if ((m = /new balance[^$]*?\$?\s*([\d,]+\.\d{2})/i.exec(t)) && m[0].length <= 50) {
          v = firstAmount(m[0]); if (v != null) { A.newBalanceMinor = v; A.patterns.newBalance = 'new balance'; }
        } else if ((m = /statement balance:\s*\$?\s*([\d,]+\.\d{2})/i.exec(t))) {
          v = firstAmount(m[0]); if (v != null) { A.newBalanceMinor = v; A.patterns.newBalance = 'statement balance:'; }
        } else if ((m = /total balance[^$]*?\$?\s*([\d,]+\.\d{2})/i.exec(t)) && m[0].length <= 50) {
          v = firstAmount(m[0]); if (v != null) { A.newBalanceMinor = v; A.patterns.newBalance = 'total balance'; }
        } else if ((m = /balance due[^$]*?\$?\s*([\d,]+\.\d{2})/i.exec(t)) && m[0].length <= 50) {
          v = firstAmount(m[0]); if (v != null) { A.newBalanceMinor = v; A.patterns.newBalance = 'balance due (fallback)'; }
        } else if ((m = /amount due[^$]*?\$?\s*([\d,]+\.\d{2})/i.exec(t)) && m[0].length <= 50) {
          v = firstAmount(m[0]); if (v != null) { A.newBalanceMinor = v; A.patterns.newBalance = 'amount due (fallback)'; }
        }
      }
      if (A.prevBalanceMinor == null) {
        if ((m = /previous balance[^$]*?\$?\s*([\d,]+\.\d{2})/i.exec(t)) && m[0].length <= 50) {
          v = firstAmount(m[0]); if (v != null) { A.prevBalanceMinor = v; A.patterns.prevBalance = 'previous balance'; }
        } else if ((m = /balance from (?:your )?last statement[^$]*?\$?\s*([\d,]+\.\d{2})/i.exec(t)) && m[0].length <= 50) {
          v = firstAmount(m[0]); if (v != null) { A.prevBalanceMinor = v; A.patterns.prevBalance = 'balance from last statement'; }
        }
      }
      if (A.minPaymentMinor == null && (m = /minimum payment[^$]*?\$?\s*([\d,]+\.\d{2})/i.exec(ahead))) {
        v = firstAmount(m[0]); if (v != null) { A.minPaymentMinor = v; A.patterns.minPayment = 'minimum payment'; }
      }
      if (A.dueDate == null) {
        var dm = /payment due date[^\d]*?([a-z]+\.?\s+\d{1,2},?\s+\d{4})/i.exec(ahead) ||
                 /pay(?:ment)?(?: this amount)?(?: due)? by\s+([a-z]+\.?\s+\d{1,2},?\s+\d{4})/i.exec(ahead);
        if (dm) {
          var dd = parseMonthDate(dm[1], A.periodEnd ? +A.periodEnd.slice(0, 4) : null);
          if (dd) { A.dueDate = dd; A.patterns.dueDate = 'payment due date / pay by'; }
        }
      }
      if (A.creditLimitMinor == null && (m = /credit limit[^$]*?\$?\s*([\d,]+\.\d{2})/i.exec(t))) {
        v = firstAmount(m[0]); if (v != null) { A.creditLimitMinor = v; A.patterns.creditLimit = 'credit limit'; }
      }
      // A bare "For the period:" label with the dates on the next line.
      if (!A.periodStart && /for the period\s*:?\s*$/i.test(t) && lines[i + 1]) {
        var t2 = lines[i + 1].line.text;
        var ds = [];
        var dm2 = /([a-z]+\.?\s+\d{1,2},?\s*\d{4})\s*(?:to|[-–—])\s*([a-z]+\.?\s+\d{1,2},?\s*\d{4})/i.exec(t2);
        if (dm2) {
          var s0 = parseMonthDate(dm2[1], null), e0 = parseMonthDate(dm2[2], null);
          if (s0 && e0) { A.periodStart = s0.iso; A.periodEnd = e0.iso; }
        }
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Date resolution with statement-period year inference                 */
  /* ------------------------------------------------------------------ */

  function dateToDays(y, m, d) { return Math.floor(Date.UTC(y, m - 1, d) / 86400000); }

  /**
   * resolveDate(parsed, doc, forceYear) -> {iso|null, yearInferred}.
   * Yearless dates take the statement-period year; the result is pulled
   * back inside [periodStart-60d, periodEnd+60d] when a period is known.
   * Unparseable -> {iso:null}. Never guesses a month/day.
   */
  function resolveDate(parsed, doc, forceYear) {
    var A = doc.anchors;
    var periodYear = A.periodStart ? +A.periodStart.slice(0, 4) : null;
    var fallbackYear = periodYear != null ? periodYear : new Date().getFullYear();
    var yearInferred = false, month, day, year;
    if (parsed.slash) {
      var a = parsed.slash.a, b = parsed.slash.b;
      var ddmm = doc.slashIsDDMM;
      if (a > 12) ddmm = true;
      else if (b > 12) ddmm = false;
      else if (a <= 12 && b <= 12) doc.slashAmbiguousUsed = true;
      month = ddmm ? b : a;
      day = ddmm ? a : b;
      year = forceYear != null ? forceYear : (parsed.year != null ? parsed.year : fallbackYear);
      if (forceYear == null && parsed.year == null) yearInferred = true;
    } else {
      month = parsed.month; day = parsed.day;
      year = forceYear != null ? forceYear : (parsed.year != null ? parsed.year : fallbackYear);
      if (forceYear == null && parsed.year == null) yearInferred = true;
    }
    if (!validDate(year, month, day)) return { iso: null, yearInferred: yearInferred };
    if (A.periodStart && A.periodEnd && forceYear == null) {
      var ps = dateToDays(+A.periodStart.slice(0, 4), +A.periodStart.slice(5, 7), +A.periodStart.slice(8, 10));
      var pe = dateToDays(+A.periodEnd.slice(0, 4), +A.periodEnd.slice(5, 7), +A.periodEnd.slice(8, 10));
      var dd = dateToDays(year, month, day);
      if (dd > pe + 60) year -= 1;
      else if (dd < ps - 60) year += 1;
      if (!validDate(year, month, day)) return { iso: null, yearInferred: yearInferred };
    }
    return { iso: iso(year, month, day), yearInferred: yearInferred };
  }

  /* ------------------------------------------------------------------ */
  /* Row assembly                                                         */
  /* ------------------------------------------------------------------ */

  function firstDateInTxnCol(L, cols) {
    if (cols.txnDateX == null) return null;
    for (var i = 0; i < L.dates.length; i++) {
      if (Math.abs(L.dates[i].x - cols.txnDateX) <= DATE_CLUSTER_TOL) return L.dates[i];
    }
    return null;
  }

  function firstAmountInCols(L, cols) {
    // Prefer the transaction table's own amount column (header-anchored);
    // only then fall back to any other amount cluster on the line.
    var i;
    if (cols.txnAmountRight != null) {
      for (i = 0; i < L.amounts.length; i++) {
        if (Math.abs(L.amounts[i].right - cols.txnAmountRight) <= AMOUNT_CLUSTER_TOL) return L.amounts[i];
      }
    }
    for (i = 0; i < L.amounts.length; i++) {
      if (amountInClusters(L.amounts[i], cols)) return L.amounts[i];
    }
    return null;
  }

  /** Tokens inside the description band, minus date/amount tokens. */
  function bandText(L, cols, skipIdx) {
    var parts = [];
    for (var i = 0; i < L.line.tokens.length; i++) {
      if (skipIdx && skipIdx[i]) continue;
      var tk = L.line.tokens[i];
      if (tk.x > cols.descLeft && tk.x < cols.descRight) parts.push(tk.t);
    }
    return trim(parts.join(' ').replace(/\s+/g, ' '));
  }

  function skipIdxFor(L, dateTok, amtTok) {
    var skip = {}, i;
    for (i = 0; i < L.dates.length; i++) {
      var d = L.dates[i], k;
      for (k = 0; k < d.parsed.n; k++) skip[d.idx + k] = 1;
    }
    for (i = 0; i < L.amounts.length; i++) skip[L.amounts[i].idx] = 1;
    return skip;
  }

  function isHeaderLine(L) {
    if (L.amounts.length || L.dates.length) return false;
    var words = String(L.line.text).split(/\s+/), hits = 0;
    for (var i = 0; i < words.length; i++) if (headerStem(words[i])) hits++;
    return hits >= 2;
  }

  function buildRow(L, dateTok, amtTok, cols, doc, pageIdx, descExtra) {
    var postTok = null, i;
    if (cols.postDateX != null) {
      for (i = 0; i < L.dates.length; i++) {
        if (L.dates[i] !== dateTok && Math.abs(L.dates[i].x - cols.postDateX) <= DATE_CLUSTER_TOL) {
          postTok = L.dates[i]; break;
        }
      }
    }
    var description = bandText(L, cols, skipIdxFor(L, dateTok, amtTok));
    if (descExtra) description = trim(description + ' ' + descExtra);

    var section = doc.currentSection;
    var mag = amtTok.minor;
    var signed, signSource, conf = cols.headerConfirmed ? 0.85 : 0.7;
    var needsReview = false, reviewReason = '';
    if (amtTok.explicitNeg) {
      signed = -mag; signSource = 'explicit'; conf = Math.max(conf, 0.92);
    } else if (cols.creditRight != null &&
               Math.abs(amtTok.right - cols.creditRight) <= AMOUNT_CLUSTER_TOL) {
      signed = -mag; signSource = 'credit-column'; conf = Math.max(conf, 0.9);
    } else if (cols.positionalCreditRight != null &&
               Math.abs(amtTok.right - cols.positionalCreditRight) <= AMOUNT_CLUSTER_TOL) {
      // Headerless two-column table: the charge/payment split itself is a
      // positional guess — negative, low confidence, always review.
      signed = -mag; signSource = 'positional-credit-column'; conf = Math.min(conf, 0.5);
      needsReview = true;
      reviewReason = 'two amount columns without header guidance — right column read as payments/credits by position; needs review';
    } else if (section === 'payments') {
      signed = -mag; signSource = 'section'; conf = Math.max(conf, 0.85);
    } else if (section === 'purchases' && REFUND_RE.test(description)) {
      // Unsigned amount but refund wording: sign is a guess — flag it.
      signed = -mag; signSource = 'refund-keyword'; conf = 0.55;
      needsReview = true;
      reviewReason = 'unsigned amount with refund/credit wording — sign is a guess';
      doc.refundKeywordCount = (doc.refundKeywordCount || 0) + 1;
    } else {
      signed = mag; signSource = 'default-positive';
      if (cols.positionalCreditRight != null) {
        // The left/right split is itself a positional guess: do not
        // silently trust the positive sign either.
        conf = Math.min(conf, 0.55);
        needsReview = true;
        reviewReason = (reviewReason ? reviewReason + '; ' : '') +
          'two amount columns without header guidance — left column read as charges by position; needs review';
      }
    }

    var dr = resolveDate(dateTok.parsed, doc, null);
    var dateISO = dr.iso;
    var postingISO = null;
    if (postTok) {
      var pr = resolveDate(postTok.parsed, doc, null);
      postingISO = pr.iso;
      // Posting date earlier than txn date by >60 days -> roll year back.
      if (dateISO && postingISO) {
        var d1 = dateToDays(+dateISO.slice(0, 4), +dateISO.slice(5, 7), +dateISO.slice(8, 10));
        var d2 = dateToDays(+postingISO.slice(0, 4), +postingISO.slice(5, 7), +postingISO.slice(8, 10));
        if (d2 < d1 - 60) {
          var pr2 = resolveDate(postTok.parsed, doc,
            (+postingISO.slice(0, 4)) - 1);
          if (pr2.iso) postingISO = pr2.iso;
        }
      }
      if (pr && pr.yearInferred) conf -= 0.03;
    }
    if (dr.yearInferred) { conf -= 0.05; doc.yearInferredCount = (doc.yearInferredCount || 0) + 1; }
    if (!dateISO) {
      conf -= 0.25; needsReview = true;
      reviewReason = (reviewReason ? reviewReason + '; ' : '') + 'unparseable date';
    }
    conf = Math.max(0.05, Math.min(0.99, conf));
    if (conf < 0.6 && !needsReview) { needsReview = true; reviewReason = 'low confidence'; }

    var rawDate = '';
    for (i = 0; i < dateTok.parsed.n; i++) rawDate += (i ? ' ' : '') + L.line.tokens[dateTok.idx + i].t;
    return {
      date: dateISO, postingDate: postingISO, description: description,
      amountMinor: signed, section: section,
      confidence: Math.round(conf * 100) / 100, source: 'generic',
      page: pageIdx + 1, rawDateText: rawDate, rawAmountText: amtTok.text,
      needsReview: needsReview, reviewReason: reviewReason, signSource: signSource,
      _y: L.line.y, _section: section
    };
  }

  /* ------------------------------------------------------------------ */
  /* Per-page line classification + row assembly                         */
  /* ------------------------------------------------------------------ */

  var CONTINUATION_GAP = 26;

  function isStructuralLine(L, cols, doc) {
    var text = L.line.text;
    if (L.dates.length === 0 && L.amounts.length === 0 && text.length <= 60 && sectionOf(text)) return true;
    // Date-range section headers ("Payments received Jul 28 to Aug 27, 2026").
    if (RECEIVED_RANGE_RE.test(text)) return true;
    if (totalsSectionAnywhere(text, doc && doc.currentSection) && L.amounts.length && !firstDateInTxnCol(L, cols)) return true;
    if (EXCLUDE_RE.test(text)) return true;
    if (isHeaderLine(L)) return true;
    return false;
  }

  function discardPending(pending, doc) {
    doc.excluded.push({ line: pending.L.line.text, reason: 'date without amount — not parsed as a row' });
  }

  function parsePageLines(pd, doc) {
    var cols = pd.cols, lines = pd.lines, pageIdx = pd.pageIdx;
    var prevRow = null, pending = null;
    // A date-without-amount line only starts a wrapped-amount row when the
    // page actually looks like a transaction table (confirmed header, or at
    // least two complete date+amount lines). Summary pages ("Please pay
    // this amount by May 11, 2026" above a rewards box) must never sprout
    // phantom rows.
    var allowPending = pd.header.confirmed || pd.rowLikeCount >= 2;

    function structural(L) { return isStructuralLine(L, cols, doc); }

    for (var i = 0; i < lines.length; i++) {
      var L = lines[i], line = L.line, text = line.text;

      // Pending wrapped-amount row: a date line still waiting for its amount.
      if (pending) {
        var gapOk = line.y < pending.y && (pending.y - line.y) <= CONTINUATION_GAP &&
                    doc.currentSection === pending.section;
        var pAmt = firstAmountInCols(L, cols);
        var pDate = firstDateInTxnCol(L, cols);
        if (gapOk && pAmt && !pDate && !structural(L)) {
          var prow = buildRow(pending.L, pending.dateTok, pAmt, cols, doc, pageIdx, pending.descExtra);
          // Description may continue on the amount line too.
          var extra = bandText(L, cols, skipIdxFor(L, null, pAmt));
          if (extra) prow.description = trim(prow.description + ' ' + extra);
          if (/\bUSA\b|\bUSD\b/.test(prow.description)) doc.fxNote = true;
          prow.rowIndex = doc.rowIndex++;
          doc.rows.push(prow);
          L.isRow = true; pending.L.isRow = true;
          prevRow = prow; pending = null;
          continue;
        }
        pending.age++;
        if (!gapOk || pending.age > 2 || structural(L) || (pDate && pAmt)) {
          discardPending(pending, doc);
          pending = null;
          // fall through: classify this line normally
        } else {
          // Description continuation while waiting for the amount.
          var pExtra = bandText(L, cols, skipIdxFor(L, null, null));
          if (pExtra) pending.descExtra = trim((pending.descExtra || '') + ' ' + pExtra);
          continue;
        }
      }

      // 1. Section header.
      var sec = (L.dates.length === 0 && L.amounts.length === 0 && text.length <= 60) ? sectionOf(text) : null;
      if (sec) { doc.currentSection = sec; prevRow = null; continue; }

      // 1b. Summary date-range lines ("Payments received Jul 28 to Aug 27,
      // 2026 0.00") are statement summaries, never transactions — exclude
      // before they can start a row. Anchored at line start with the
      // "received" verb; no merchant description looks like this.
      if (RECEIVED_RANGE_RE.test(text)) {
        doc.excluded.push({ line: text, reason: 'summary date-range line' });
        prevRow = null;
        continue;
      }

      // 2. Row start: date in txn-date column + amount in an amount column.
      var dateTok = firstDateInTxnCol(L, cols);
      var amtTok = firstAmountInCols(L, cols);
      if (dateTok && amtTok) {
        var row = buildRow(L, dateTok, amtTok, cols, doc, pageIdx, null);
        if (/\bUSA\b|\bUSD\b/.test(row.description)) doc.fxNote = true;
        row.rowIndex = doc.rowIndex++;
        doc.rows.push(row);
        L.isRow = true;
        prevRow = row;
        continue;
      }

      // 3. Section totals (also recorded as exclusions). A tier-1 total
      // (explicit total/subtotal word) always wins over tier-2 (+/- marker).
      if (!dateTok) {
        var ts = totalsSectionAnywhere(text, doc.currentSection);
        if (ts && L.amounts.length) {
          // First amount at/after the total keyword — the line may carry
          // other sections' amounts before it ("Total payment activity
          // -$2,416.00 + Convenience cheques $0.00").
          var tm = null, ai;
          for (ai = 0; ai < L.amounts.length; ai++) {
            if (line.tokens[L.amounts[ai].idx].start >= ts.index) { tm = L.amounts[ai].minor; break; }
          }
          if (tm == null) tm = L.amounts[0].minor;
          if (tm < 0) tm = -tm;
          var prevTier = doc.totalsTier[ts.section] || 99;
          if (ts.tier <= prevTier) {
            doc.anchors.totalsBySection[ts.section] = ts.negative ? -tm : tm;
            doc.totalsTier[ts.section] = ts.tier;
          }
          doc.excluded.push({ line: text, reason: 'section total (' + ts.section + ')' });
          prevRow = null;
          continue;
        }
      }

      // 4. Totals / balances / summary lines.
      if (EXCLUDE_RE.test(text)) {
        doc.excluded.push({ line: text, reason: 'summary/total/balance line' });
        prevRow = null;
        continue;
      }

      // 5. Table header lines.
      if (isHeaderLine(L)) continue;

      // 6. Date without amount -> maybe a wrapped amount on the next line.
      if (dateTok && !amtTok && allowPending) {
        pending = { L: L, dateTok: dateTok, y: line.y, section: doc.currentSection, age: 0, descExtra: '' };
        continue;
      }

      // 7. Continuation of the previous row (wrapped description, or an
      //    amount line whose row already has its amount — e.g. foreign
      //    currency detail lines). Handled carefully: never adopts a
      //    second amount, never creates a row.
      if (prevRow && !dateTok && line.y < prevRow._y &&
          (prevRow._y - line.y) <= CONTINUATION_GAP &&
          doc.currentSection === prevRow._section && !structural(L)) {
        var cExtra = bandText(L, cols, skipIdxFor(L, null, null));
        if (cExtra) {
          prevRow.description = trim(prevRow.description + ' ' + cExtra);
          if (/\bUSA\b|\bUSD\b/.test(cExtra)) doc.fxNote = true;
        }
        continue;
      }

      // Anything else (prose, footers, stray amounts) is ignored silently.
    }
    if (pending) { discardPending(pending, doc); pending = null; }
  }

  /* ------------------------------------------------------------------ */
  /* Main entry point                                                     */
  /* ------------------------------------------------------------------ */

  /**
   * GenericTable.parse(pages) -> { rows, anchors, excluded, confidence, notes }.
   * pages: array of pages; each page = array of {x, y, str|text, w?, cx?}
   * in PDF points, y-up.
   */
  GenericTable.parse = function (pages) {
    var doc = {
      anchors: {
        periodStart: null, periodEnd: null,
        prevBalanceMinor: null, newBalanceMinor: null,
        minPaymentMinor: null, dueDate: null, creditLimitMinor: null,
        totalsBySection: {}, currency: 'CAD', patterns: {}
      },
      excluded: [], notes: [], rows: [],
      currentSection: 'purchases',
      totalsTier: {},
      slashVotes: { ddmm: 0, mmdd: 0, amb: 0 },
      slashIsDDMM: true, slashAmbiguousUsed: false,
      rowIndex: 0, anyHeaderConfirmed: false,
      refundKeywordCount: 0, yearInferredCount: 0, fxNote: false
    };

    // ---- Pass A: lines + date/amount token extraction (per page) ----
    var pageData = [];
    for (var p = 0; p < (pages || []).length; p++) {
      var frags = normItems(pages[p]);
      var lines = buildLines(frags);
      var L = [];
      for (var li = 0; li < lines.length; li++) {
        var line = lines[li];
        var dates = [], amounts = [], ti = 0;
        while (ti < line.tokens.length) {
          var dp = parseDateAt(line.tokens, ti);
          if (dp) {
            dp.idx = ti;
            var lastTok = line.tokens[ti + dp.n - 1];
            dates.push({ parsed: dp, idx: ti, x: dp.x,
                         right: lastTok.x + Math.max(lastTok.t.length * 5.2, 1) });
            if (dp.slash) {
              if (dp.slash.a > 12) doc.slashVotes.ddmm++;
              else if (dp.slash.b > 12) doc.slashVotes.mmdd++;
              else doc.slashVotes.amb++;
            }
            ti += dp.n;
            continue;
          }
          var ap = parseAmountAt(line.tokens, ti, line.text);
          if (ap) { ap.idx = ti; ap.text = line.tokens[ti].t; amounts.push(ap); }
          ti++;
        }
        L.push({ line: line, dates: dates, amounts: amounts,
                 isRowLike: dates.length > 0 && amounts.length > 0, isRow: false });
      }
      var header = detectHeader(frags);
      if (header.confirmed) doc.anyHeaderConfirmed = true;
      var rowLikeDateToks = [], allDateToks = [], amtToks = [], q, r;
      var rowLikeLineCount = 0;
      for (q = 0; q < L.length; q++) {
        // Date columns are defined by transaction rows only: dates on
        // lines without an amount (statement period, due dates, section
        // date ranges like "Payments received Jul 28 to Aug 27, 2026")
        // must never create phantom date columns that swallow the
        // description band.
        for (r = 0; r < L[q].dates.length; r++) {
          allDateToks.push(L[q].dates[r]);
          if (L[q].isRowLike) rowLikeDateToks.push(L[q].dates[r]);
        }
        if (L[q].isRowLike) rowLikeLineCount++;
        for (r = 0; r < L[q].amounts.length; r++) amtToks.push(L[q].amounts[r]);
      }
      // Corroboration: a lone row-like line on a headerless page must not
      // get to define the date columns by itself (e.g. a payment-slip
      // instruction line "…cheque May 11, 2026 $10.00" becoming its own
      // transaction). With fewer than two row-like lines and no confirmed
      // header, fall back to all page dates — the legacy behaviour.
      var dateToks = (rowLikeDateToks.length &&
                      (rowLikeLineCount >= 2 || header.confirmed))
        ? rowLikeDateToks : allDateToks;
      pageData.push({ lines: L, cols: discoverColumns(dateToks, amtToks, header),
                      header: header, pageIdx: p,
                      rowLikeCount: L.filter(function (x) { return x.isRowLike; }).length });
    }

    // ---- Slash-date convention: document majority, dd/mm default ----
    var v = doc.slashVotes;
    doc.slashIsDDMM = v.ddmm !== v.mmdd ? v.ddmm > v.mmdd : true;
    if (v.ddmm + v.mmdd + v.amb > 0) {
      doc.notes.push('slash dates read as ' + (doc.slashIsDDMM ? 'dd/mm' : 'mm/dd') +
        ' (' + v.ddmm + ' voted dd/mm, ' + v.mmdd + ' voted mm/dd, ' + v.amb +
        ' ambiguous) — ' + (v.ddmm === v.mmdd ? 'no majority; Canadian dd/mm assumed' : 'document majority wins'));
    }

    var allLines = [];
    pageData.forEach(function (pd) {
      pd.lines.forEach(function (x) { allLines.push(x); });
    });

    // ---- Statement period first (year inference needs it) ----
    prescanPeriod(allLines, doc);

    // ---- Pass B: classify lines, assemble rows ----
    pageData.forEach(function (pd) { parsePageLines(pd, doc); });

    // ---- Anchors from non-row lines ----
    extractAnchors(allLines, doc);

    // ---- Validation: parsed rows vs stated section totals ----
    var purchaseGross = 0, payAbs = 0, i;
    for (i = 0; i < doc.rows.length; i++) {
      var rr = doc.rows[i];
      if (rr.section === 'purchases' && rr.amountMinor > 0) purchaseGross += rr.amountMinor;
      if (rr.section === 'payments' && rr.amountMinor < 0) payAbs += -rr.amountMinor;
    }
    var T = doc.anchors.totalsBySection;
    var confidence = 0.9;
    if (!doc.anyHeaderConfirmed) {
      confidence -= 0.15;
      doc.notes.push('no table header recognised on any page — columns inferred from geometry alone');
    }
    if (!doc.anchors.periodStart) confidence -= 0.1;
    if (doc.anchors.newBalanceMinor == null) {
      confidence -= 0.05;
      doc.notes.push('new/statement balance not found');
    }
    if (T.purchases != null) {
      if (Math.abs(purchaseGross - T.purchases) > 1) {
        confidence -= 0.25;
        doc.notes.push('rows do not reconcile with stated total — needs review ' +
          '(parsed positive purchases ' + purchaseGross + ' vs stated ' + T.purchases + ' minor units)');
      }
    } else {
      doc.notes.push('no stated purchase total found for reconciliation');
    }
    if (T.payments != null && payAbs > 0 && Math.abs(payAbs - (-T.payments)) > 1) {
      confidence -= 0.15;
      doc.notes.push('parsed payments ' + payAbs + ' do not match stated ' + (-T.payments) + ' minor units — needs review');
    }
    var needReview = 0;
    for (i = 0; i < doc.rows.length; i++) if (doc.rows[i].needsReview) needReview++;
    if (doc.rows.length && needReview / doc.rows.length > 0.15) {
      confidence -= 0.1;
      doc.notes.push(needReview + ' of ' + doc.rows.length + ' rows flagged for review');
    }
    if (doc.yearInferredCount) {
      doc.notes.push(doc.yearInferredCount + ' row date(s) had no printed year — year inferred from the statement period');
    }
    if (doc.refundKeywordCount) {
      doc.notes.push(doc.refundKeywordCount + ' row(s) signed by refund wording alone — flagged for review, never silently trusted');
    }
    if (doc.fxNote) {
      doc.notes.push('foreign-currency detail lines folded into descriptions; amounts are the converted Canadian-dollar figures');
    }
    doc.notes.push('currency assumed CAD (Canadian card statements); amounts are integer minor units');
    confidence = Math.max(0.05, Math.min(0.99, Math.round(confidence * 100) / 100));

    // Strip internal fields before returning.
    for (i = 0; i < doc.rows.length; i++) {
      delete doc.rows[i]._y;
      delete doc.rows[i]._section;
    }

    return {
      rows: doc.rows, anchors: doc.anchors, excluded: doc.excluded,
      confidence: confidence, notes: doc.notes
    };
  };

  /**
   * GenericTable.parseFrags(frags) — convenience wrapper accepting the flat
   * [{page, x, y, cx, text}] shape produced by Parsers.collectPageItems.
   */
  GenericTable.parseFrags = function (frags) {
    var byPage = {}, order = [], i;
    for (i = 0; i < (frags || []).length; i++) {
      var f = frags[i] || {};
      var pg = +f.page || 1;
      if (!byPage[pg]) { byPage[pg] = []; order.push(pg); }
      byPage[pg].push({ x: f.x, y: f.y, cx: f.cx, w: 0,
                        str: (f.text != null ? f.text : f.str) });
    }
    order.sort(function (a, b) { return a - b; });
    var pages = order.map(function (pg) { return byPage[pg]; });
    return GenericTable.parse(pages);
  };

  /* ------------------------------------------------------------------ */
  /* Exports                                                              */
  /* ------------------------------------------------------------------ */

  if (typeof module !== 'undefined' && module.exports) module.exports = GenericTable;
  if (typeof window !== 'undefined') window.GenericTable = GenericTable;
  else if (typeof self !== 'undefined') self.GenericTable = GenericTable;
  else if (typeof global !== 'undefined') global.GenericTable = GenericTable;

})();
