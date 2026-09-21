/* ============================================================================
 * engine.js — "Explain My Money" Gate 1 prototype: deterministic engine
 * ----------------------------------------------------------------------------
 * PURE FUNCTIONS ONLY. No DOM, no network, no storage, no randomness that
 * affects results (rule-id derivation is a deterministic hash).
 *
 * MONEY-HANDLING INVARIANTS (read before touching this file):
 *  1. Money is ALWAYS an integer count of minor units (cents) in fields named
 *     `*Minor`. NEVER use parseFloat / Number() on money text: binary floating
 *     point cannot represent most decimals exactly (0.1 + 0.2 !== 0.3).
 *  2. All parsing goes through parseAmountToMinor(), which does manual
 *     decimal-string parsing. Anything it cannot parse becomes
 *     amountMinor=null plus row._error=true — never a guessed number, never a
 *     silently dropped row.
 *  3. Sign convention: POSITIVE amountMinor = money left the household
 *     (a purchase / charge). NEGATIVE amountMinor = money came back
 *     (refund, credit, payment received). reconcile() documents how this maps
 *     to statement balances.
 *
 * PRIVACY INVARIANTS:
 *  - This file makes zero network calls and emits zero telemetry.
 *  - It never reads or writes persistent storage; rows are plain objects
 *    passed in by the caller (app.js hands them to Store separately).
 *
 * ES2019-compatible: no modules, no optional chaining, no nullish coalescing,
 * no BigInt, no String.replaceAll. Loaded via plain <script> tag; exposes
 * global `Engine`.
 * ========================================================================== */
(function () {
  'use strict';

  var Engine = {};

  /** Engine version for the Gate 1 prototype contract. */
  Engine.VERSION = '1.0.0-gate1';

  /** All transaction kinds. */
  Engine.KINDS = ['purchase', 'refund', 'payment', 'transfer', 'fee', 'cash_advance', 'uncertain'];

  /**
   * Minimum confidence for a receipt<->transaction link to be accepted.
   * Below this the pair is reported as NO match: omission is preferred over a
   * false link (design target: >=90% precision on accepted matches).
   */
  Engine.RECEIPT_MATCH_THRESHOLD = 0.85;

  /**
   * Tolerance (minor units) when comparing a computed end balance against a
   * reported one. Mirrors the Python validation harness
   * (backend/engine/reconcile.py::_BALANCE_TOLERANCE_MINOR = 1): source
   * statements whose printed totals were rounded may be off by one cent.
   */
  Engine.BALANCE_TOLERANCE_MINOR = 1;

  /**
   * Tie-break for ambiguous numeric dates like 05/06/2026 ('MDY' or 'DMY').
   * Deterministic default 'MDY'; the row is ALWAYS flagged with
   * _ambiguousDate=true when the tie-break was applied so the UI can surface
   * it instead of silently guessing.
   */
  Engine.DATE_ORDER = 'MDY';

  /* ------------------------------------------------------------------ */
  /* Small helpers                                                       */
  /* ------------------------------------------------------------------ */

  function isBlank(s) {
    return s === null || s === undefined || String(s).replace(/\s+/g, '') === '';
  }

  function trimStr(s) {
    return String(s == null ? '' : s).replace(/^\s+|\s+$/g, '');
  }

  // Deterministic 32-bit string hash (for rule ids derived from content).
  function hashStr(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 16777619) | 0;
    }
    return (h >>> 0).toString(36);
  }

  /* ================================================================== */
  /* CSV parsing                                                          */
  /* ================================================================== */

  // Parse one CSV line honoring RFC-4180 style double-quoted fields
  // (embedded commas, newlines are handled by splitting on lines first —
  //  multi-line quoted fields are NOT supported and will surface as errors).
  function parseCSVLine(line) {
    var fields = [];
    var cur = '';
    var inQuotes = false;
    var i = 0;
    while (i < line.length) {
      var c = line.charAt(i);
      if (inQuotes) {
        if (c === '"') {
          if (line.charAt(i + 1) === '"') { cur += '"'; i += 2; }
          else { inQuotes = false; i++; }
        } else { cur += c; i++; }
      } else {
        if (c === '"') { inQuotes = true; i++; }
        else if (c === ',') { fields.push(cur); cur = ''; i++; }
        else { cur += c; i++; }
      }
    }
    fields.push(cur);
    return { fields: fields, unterminated: inQuotes };
  }

  function normHeaderCell(s) {
    return trimStr(s).toLowerCase().replace(/_+/g, ' ').replace(/\s+/g, ' ');
  }

  var DATE_COLS = ['date', 'posted date', 'transaction date', 'trans date', 'post date', 'posting date'];
  var DESC_COLS = ['description', 'merchant', 'details', 'narrative', 'payee', 'name', 'memo'];
  var AMOUNT_COLS = ['amount', 'transaction amount', 'value', 'net amount', 'transaction value'];
  var CURRENCY_COLS = ['currency', 'curr', 'ccy'];

  function findCol(headerCells, variants) {
    for (var i = 0; i < headerCells.length; i++) {
      var h = normHeaderCell(headerCells[i]);
      for (var v = 0; v < variants.length; v++) {
        if (h === variants[v]) return i;
      }
    }
    return -1;
  }

  /**
   * Engine.parseCSV(text) -> {rows, errors}
   * rows: [{rawDateText, rawDescription, rawAmountText, rawCurrency}]
   * errors: [{row, reason}] — row is the 1-based DATA row number (header = 0).
   * Never silently drops a data row: anything that cannot become a row is
   * reported in errors[]. Truly blank lines are skipped (not data).
   */
  Engine.parseCSV = function (text) {
    var rows = [];
    var errors = [];
    if (isBlank(text)) {
      errors.push({ row: 0, reason: 'empty input: no CSV text provided' });
      return { rows: rows, errors: errors };
    }
    // Strip UTF-8 BOM if present.
    var src = String(text).replace(/^\uFEFF/, '');
    var lines = src.split(/\r\n|\r|\n/);

    var headerIdx = -1;
    var headerCells = null;
    for (var li = 0; li < lines.length; li++) {
      if (!isBlank(lines[li])) { headerIdx = li; headerCells = parseCSVLine(lines[li]).fields; break; }
    }
    if (headerIdx === -1) {
      errors.push({ row: 0, reason: 'no header row found: file contains only blank lines' });
      return { rows: rows, errors: errors };
    }

    var dateCol = findCol(headerCells, DATE_COLS);
    var descCol = findCol(headerCells, DESC_COLS);
    var amountCol = findCol(headerCells, AMOUNT_COLS);
    var currencyCol = findCol(headerCells, CURRENCY_COLS);

    var missing = [];
    if (dateCol === -1) missing.push('date (tried: ' + DATE_COLS.join(', ') + ')');
    if (descCol === -1) missing.push('description (tried: ' + DESC_COLS.join(', ') + ')');
    if (amountCol === -1) missing.push('amount (tried: ' + AMOUNT_COLS.join(', ') + ')');
    if (missing.length > 0) {
      errors.push({ row: 0, reason: 'header is missing required column(s): ' + missing.join('; ') });
      return { rows: rows, errors: errors };
    }

    var dataRowNo = 0;
    for (var r = headerIdx + 1; r < lines.length; r++) {
      var line = lines[r];
      if (isBlank(line)) continue; // blank line: not a data row, skip (documented)
      dataRowNo++;
      var parsed = parseCSVLine(line);
      if (parsed.unterminated) {
        errors.push({ row: dataRowNo, reason: 'unterminated quoted field' });
        continue;
      }
      var f = parsed.fields;
      var allEmpty = true;
      for (var k = 0; k < f.length; k++) { if (!isBlank(f[k])) { allEmpty = false; break; } }
      if (allEmpty) continue; // line of empty fields: not a data row, skip (documented)

      var need = Math.max(dateCol, descCol, amountCol);
      if (f.length <= need) {
        errors.push({ row: dataRowNo, reason: 'expected at least ' + (need + 1) + ' column(s), found ' + f.length });
        continue;
      }
      var rawDateText = trimStr(f[dateCol]);
      var rawDescription = trimStr(f[descCol]);
      var rawAmountText = trimStr(f[amountCol]);
      var rawCurrency = currencyCol === -1 ? 'CAD' : (trimStr(f[currencyCol]) || 'CAD');
      if (isBlank(rawDateText) && isBlank(rawDescription) && isBlank(rawAmountText)) {
        continue; // effectively blank row
      }
      if (isBlank(rawAmountText)) {
        errors.push({ row: dataRowNo, reason: 'amount field is empty (money is never guessed)' });
        continue;
      }
      rows.push({
        rawDateText: rawDateText,
        rawDescription: rawDescription,
        rawAmountText: rawAmountText,
        rawCurrency: rawCurrency
      });
    }
    return { rows: rows, errors: errors };
  };

  /* ================================================================== */
  /* Normalization                                                        */
  /* ================================================================== */

  var MONTH_ABBR = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

  function daysInMonth(y, m) {
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
  }

  function validYMD(y, m, d) {
    if (!(y >= 1000 && y <= 9999 && m >= 1 && m <= 12 && d >= 1)) return false;
    return d <= daysInMonth(y, m);
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /** True for a plausible YYYY-MM-DD string (parser-inferred dates). */
  function looksLikeISODate(s) {
    if (typeof s !== 'string') return false;
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimStr(s));
    if (!m) return false;
    var y = +m[1], mo = +m[2], d = +m[3];
    return validYMD(y, mo, d);
  }

  /**
   * Parse a date string to ISO YYYY-MM-DD.
   * Accepted: YYYY-MM-DD (also YYYY/MM/DD), MM/DD/YYYY, DD/MM/YYYY,
   * DD-Mon-YY / DD-Mon-YYYY (also with spaces).
   * Returns {iso, ambiguous} or null when unparseable/invalid.
   * Ambiguous MM/DD vs DD/MM (both parts <= 12) is resolved by
   * Engine.DATE_ORDER and flagged ambiguous=true.
   */
  function parseDateToISO(s) {
    var t = trimStr(s);
    if (t === '') return null;
    var m, y, mo, d, ambiguous;
    ambiguous = false;
    m = t.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
    if (m) {
      y = +m[1]; mo = +m[2]; d = +m[3];
      return validYMD(y, mo, d) ? { iso: y + '-' + pad2(mo) + '-' + pad2(d), ambiguous: false } : null;
    }
    m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) {
      var a = +m[1], b = +m[2]; y = +m[3];
      if (a > 12 && b > 12) return null;
      if (a > 12) { d = a; mo = b; }              // must be DD/MM/YYYY
      else if (b > 12) { mo = a; d = b; }         // must be MM/DD/YYYY
      else {
        ambiguous = true;                          // both plausible: tie-break
        if (Engine.DATE_ORDER === 'DMY') { d = a; mo = b; }
        else { mo = a; d = b; }
      }
      return validYMD(y, mo, d) ? { iso: y + '-' + pad2(mo) + '-' + pad2(d), ambiguous: ambiguous } : null;
    }
    m = t.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[-\s](\d{2}|\d{4})$/);
    if (m) {
      d = +m[1];
      var mon = MONTH_ABBR[m[2].toLowerCase()];
      if (!mon) return null;
      y = +m[3];
      if (m[3].length === 2) y += (y >= 70 ? 1900 : 2000); // pivot 70: 00-69 -> 2000s
      return validYMD(y, mon, d) ? { iso: y + '-' + pad2(mon) + '-' + pad2(d), ambiguous: false } : null;
    }
    return null;
  }

  /**
   * Manual decimal-string -> integer minor units. NEVER parseFloat.
   * Handles: "$1,234.56", "1,234.56", "(42.18)" (parentheses = negative),
   * "-42.18", "42.18CR"/"CR 42.18" (CR = credit = negative), "42.18DR".
   * Returns {minor} or {error: reason}. Unparseable input is NEVER coerced.
   */
  function parseAmountToMinor(s) {
    var t = trimStr(s);
    if (t === '') return { error: 'empty amount text' };
    var negative = false;

    // (42.18) — accounting parentheses mean negative.
    var pm = t.match(/^\((.*)\)$/);
    if (pm) { negative = true; t = trimStr(pm[1]); }

    // Leading/trailing CR (credit -> negative) or DR (debit -> positive).
    var crm = t.match(/^(CR|DR)\s*(.+)$/i);
    var crm2 = t.match(/^(.+?)\s*(CR|DR)$/i);
    if (crm) { if (crm[1].toUpperCase() === 'CR') negative = true; t = trimStr(crm[2]); }
    else if (crm2) { if (crm2[2].toUpperCase() === 'CR') negative = true; t = trimStr(crm2[1]); }

    // Leading minus sign.
    if (t.charAt(0) === '-') {
      if (negative) return { error: 'multiple negation markers in amount: ' + s };
      negative = true;
      t = trimStr(t.slice(1));
    }
    if (t.charAt(0) === '+') t = trimStr(t.slice(1));

    // Strip currency symbols, thousands separators, spaces.
    // NOTE: CAD-centric. European "1.234,56" is deliberately NOT supported —
    // guessing the decimal separator would corrupt money.
    t = t.replace(/[$€£¥₹\s,]/g, '');

    var dm = t.match(/^(\d+)(?:\.(\d+))?$/);
    if (!dm) return { error: 'unparseable amount: ' + s };
    if (dm[2] !== undefined && dm[2].length > 2) {
      return { error: 'more than 2 decimal places (not rounded, flagged instead): ' + s };
    }
    var dollars = dm[1].replace(/^0+(?=\d)/, '') || '0';
    var centsStr = (dm[2] || '');
    while (centsStr.length < 2) centsStr += '0';
    // Integer arithmetic only — no floats anywhere near money.
    var minor = 0;
    for (var i = 0; i < dollars.length; i++) minor = minor * 10 + (dollars.charCodeAt(i) - 48);
    minor = minor * 100 + (centsStr.charCodeAt(0) - 48) * 10 + (centsStr.charCodeAt(1) - 48);
    if (negative) minor = -minor;
    return { minor: minor };
  }

  /**
   * Conservative merchant normalization.
   * Only case + whitespace are normalized here. NO token stripping, NO
   * truncation, NO "noise word" removal at this stage — aggressive cleaning
   * risks merging distinct merchants. Deeper cleaning (for duplicate keys)
   * happens in merchantKeyForDedupe() and is documented there.
   */
  function normalizeMerchant(desc) {
    return trimStr(desc).toUpperCase().replace(/\s+/g, ' ');
  }

  // Stricter key used ONLY for duplicate candidacy: alphanumerics only.
  function merchantKeyForDedupe(merchantRaw) {
    return String(merchantRaw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  /**
   * Engine.normalizeRows(rows) -> rows (mutated in place, also returned).
   * Adds: date (ISO or null), amountMinor (int or null), currency,
   * merchantRaw, _error (bool), _errorReasons ([string]), _ambiguousDate.
   * All raw* fields are preserved untouched.
   *
   * Date resolution order: parse the raw date text first; when that has no
   * year to parse (statement "dd/mm" or "Mar 20" prints), fall back to the
   * parser-supplied dateInferred ISO date (mirrors backend/engine).
   *
   * Amount resolution order: when the parser supplied signedAmountMinor
   * (statement templates whose section/sign knowledge the raw text cannot
   * carry — e.g. CIBC's "Your payments" table prints positives for money
   * INTO the account), it is authoritative and used as amountMinor
   * directly. Otherwise the raw amount text is parsed. signedAmountMinor
   * is always stamped (falling back to amountMinor) because reconcile()
   * sums it across ALL rows for the card-account balance equation.
   */
  Engine.normalizeRows = function (rows) {
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      r._error = false;
      r._errorReasons = [];

      var pd = parseDateToISO(r.rawDateText);
      if (pd === null && looksLikeISODate(r.dateInferred)) {
        r.date = trimStr(r.dateInferred);
      } else if (pd === null) {
        r.date = null;
        r._error = true;
        r._errorReasons.push('unparseable date: "' + r.rawDateText + '"');
      } else {
        r.date = pd.iso;
        if (pd.ambiguous) r._ambiguousDate = true;
      }

      if (typeof r.signedAmountMinor === 'number' && isFinite(r.signedAmountMinor) &&
          Math.floor(r.signedAmountMinor) === r.signedAmountMinor) {
        // Parser-authoritative signing (PDF templates). rawAmountText is
        // kept exactly as printed; the sign interpretation lives here.
        r.amountMinor = r.signedAmountMinor;
      } else {
        var pa = parseAmountToMinor(r.rawAmountText);
        if (pa.error) {
          r.amountMinor = null;
          r._error = true;
          r._errorReasons.push(pa.error);
        } else {
          r.amountMinor = pa.minor;
        }
        r.signedAmountMinor = (r.amountMinor === null || r.amountMinor === undefined)
          ? null : r.amountMinor;
      }

      r.currency = trimStr(r.rawCurrency || 'CAD').toUpperCase() || 'CAD';
      r.merchantRaw = normalizeMerchant(r.rawDescription);
    }
    return rows;
  };

  /* ================================================================== */
  /* Classification                                                       */
  /* ================================================================== */

  // Built-in keyword rules, applied IN ORDER; first match wins.
  // Confidence reflects keyword reliability (a rule created from a user
  // correction always wins with confidence 1.0 — see applyRules).
  var BUILTIN_RULES = [
    { kind: 'payment',  confidence: 0.90, keywords: ['PAYMENT RECEIVED', 'THANK YOU', 'AUTOPAY', 'AUTOMATIC PAYMENT'] },
    { kind: 'transfer', confidence: 0.90, keywords: ['E-TRANSFER', 'ETRANSFER', 'TRANSFER', 'BILL PAYMENT', 'BILL PAY'] },
    { kind: 'refund',   confidence: 0.90, keywords: ['REFUND', 'CREDIT ADJUSTMENT', 'RETURNED', 'CREDIT MEMO'] },
    { kind: 'fee',      confidence: 0.85, keywords: ['ANNUAL FEE', 'INTEREST CHARGE', 'INTEREST CHARGED', 'LATE FEE'] },
    { kind: 'cash_advance', confidence: 0.85, keywords: ['CASH ADVANCE'] }
  ];

  function confidenceBand(c) {
    if (c >= 0.95) return 'confirmed';
    if (c >= 0.80) return 'likely';
    return 'needs_review';
  }

  // Derive spend/excluded fields from kind. Single source of truth so
  // classifyRows and applyRules can never disagree.
  function applyKindToRow(r, kind, kindConfidence, kindReason, source) {
    r.kind = kind;
    r.kindConfidence = kindConfidence;
    r.kindReason = kindReason;
    r.classificationSource = source; // 'rule' | 'builtin' | 'user'
    if (kind === 'purchase' || kind === 'refund') {
      // purchase: amountMinor as-is (positive = spend).
      // refund: amountMinor as-is (negative credits reduce net spend).
      r.excluded = 0;
      r.spendAmountMinor = (r.amountMinor === null || r.amountMinor === undefined) ? 0 : r.amountMinor;
    } else {
      // payment / transfer / fee / cash_advance / uncertain: money movement
      // or unclassifiable — excluded from spend, never counted silently.
      // cash_advance is real cash outflow but is money-movement (like an ATM
      // withdrawal), so it is excluded from *spend* and shown separately.
      r.excluded = 1;
      r.spendAmountMinor = 0;
    }
    r.confidence = confidenceBand(kindConfidence);
  }

  function classifyBuiltin(r) {
    // Parser-level parse confidence ('high'|'medium'|'low', set by the
    // generic PDF template only). 'low' rows must land in the review queue
    // rather than being silently trusted: after classification below they
    // are downgraded to needs_review. Validated templates never set
    // r.confidence, so their behaviour is unchanged.
    var parserConfidence = r.confidence;
    var hay = r.merchantRaw || '';
    for (var i = 0; i < BUILTIN_RULES.length; i++) {
      var rule = BUILTIN_RULES[i];
      for (var k = 0; k < rule.keywords.length; k++) {
        if (hay.indexOf(rule.keywords[k]) !== -1) {
          applyKindToRow(r, rule.kind, rule.confidence, 'builtin keyword: "' + rule.keywords[k] + '"', 'builtin');
          return downgradeHeuristic(r, parserConfidence);
        }
      }
    }
    var descEmpty = isBlank(hay);
    var amtZero = (r.amountMinor === 0);
    var amtNull = (r.amountMinor === null || r.amountMinor === undefined);
    if (descEmpty || amtZero || amtNull) {
      applyKindToRow(r, 'uncertain', 0.40, 'default: amount is zero/missing or description is empty', 'builtin');
    } else {
      applyKindToRow(r, 'purchase', 0.60, 'default: no rule matched, treated as purchase', 'builtin');
    }
    downgradeHeuristic(r, parserConfidence);
  }

  /**
   * Rows the heuristic PDF reader flagged as uncertain (confidence 'low')
   * are capped at needs_review so the statement list, reconcile counts,
   * and txn detail all treat them as review-queue items. Household rules
   * and user corrections outrank the heuristic and are never downgraded;
   * already-uncertain rows are already in the queue.
   */
  function downgradeHeuristic(r, parserConfidence) {
    if (parserConfidence !== 'low') return;
    if (r.classificationSource === 'user' || r.classificationSource === 'rule') return;
    if (r.kind === 'uncertain' || r.confidence === 'needs_review') return;
    applyKindToRow(r, r.kind, 0.40,
      'heuristic PDF read is uncertain (' + (r.confidenceNote || 'low parse confidence') +
      ') — flagged for your review', r.classificationSource || 'builtin');
  }

  /**
   * Engine.applyRules(rows, rules) -> rows.
   * Deterministic application of enabled household rules, highest priority
   * first. A rule: {id, enabled, priority, matchMerchant, kind, category,
   * label}. matchMerchant is a case-insensitive substring of merchantRaw.
   * Applies rule.kind (stamps classificationSource='rule', kindConfidence=1.0
   * — the household's own rule outranks any heuristic) and/or rule.category
   * (stamps categorySource='rule', categoryConfidence=1.0). Legacy
   * app-level category rules carry their category in appMatch.setCategory
   * and are honored too. Never touches rows the user corrected directly
   * (classificationSource==='user'). Category-only rules do NOT stamp
   * classificationSource, so built-in kind classification still runs for
   * those rows.
   */
  Engine.applyRules = function (rows, rules) {
    var active = [];
    for (var i = 0; i < (rules || []).length; i++) {
      if (rules[i] && rules[i].enabled !== false && rules[i].matchMerchant &&
          (rules[i].kind || ruleCategoryOf(rules[i]))) {
        active.push(rules[i]);
      }
    }
    // ES2019 sort is stable: equal priorities keep original order.
    active.sort(function (a, b) { return (b.priority || 0) - (a.priority || 0); });
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      if (row.classificationSource === 'user') continue;
      var hay = row.merchantRaw || '';
      for (var a = 0; a < active.length; a++) {
        var rule = active[a];
        if (hay.indexOf(String(rule.matchMerchant).toUpperCase()) !== -1) {
          var label = 'household rule: ' + (rule.label || rule.id);
          var changed = false;
          if (rule.kind) {
            applyKindToRow(row, rule.kind, 1.0, label, 'rule');
            changed = true;
          }
          var cat = ruleCategoryOf(rule);
          if (cat) {
            stampCategory(row, cat, 'rule', 1.0, label);
            changed = true;
          }
          if (changed) break;
        }
      }
    }
    return rows;
  };

  /**
   * Engine.classifyRows(rows, rules=[]) -> rows.
   * Rules-first: household rules, then built-in keyword rules in order,
   * then purchase (0.6) / uncertain (0.4) defaults.
   * Rows already corrected by the user (classificationSource==='user')
   * are left untouched.
   */
  Engine.classifyRows = function (rows, rules) {
    rules = rules || [];
    Engine.applyRules(rows, rules);
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].classificationSource === 'user' || rows[i].classificationSource === 'rule') continue;
      classifyBuiltin(rows[i]);
    }
    return rows;
  };

  /**
   * Engine.makeRuleFromCorrection(correction, pastRows) -> {rule, scopeDescription}.
   * correction: {merchantRaw (or merchant), kind?, category?, label?}
   * Builds a household rule matching the corrected merchant text. The rule id
   * is a deterministic hash of match-key + kind + category (kind-only rules
   * keep their historic id shape; adding a category changes the id, so a
   * category-bearing rule never collides with a kind-only one).
   * scopeDescription states the blast radius: how many past records the rule
   * WOULD apply to.
   */
  Engine.makeRuleFromCorrection = function (correction, pastRows) {
    correction = correction || {};
    pastRows = pastRows || [];
    var key = trimStr(correction.merchantRaw || correction.merchant || '').toUpperCase().replace(/\s+/g, ' ');
    var kind = correction.kind;
    var kindOk = Engine.KINDS.indexOf(kind) !== -1;
    var category = trimStr(correction.category || '');
    if (category !== '' && !KNOWN_CATEGORY_IDS[category]) {
      throw new Error('makeRuleFromCorrection: unknown category "' + category + '"');
    }
    if (key === '' || (!kindOk && category === '')) {
      throw new Error('makeRuleFromCorrection: need a merchant string and a valid kind or category');
    }
    // Deterministic id: kind-only rules keep the historic hash input
    // (key|kind) so existing stored rules stay upsert-stable; the category
    // is folded in whenever one is present.
    var hashInput = key + '|' + (kindOk ? kind : '');
    if (category !== '') hashInput += '|' + category;
    var rule = {
      id: 'rule_' + hashStr(hashInput),
      enabled: true,
      priority: 100,
      matchMerchant: key,
      kind: kindOk ? kind : null,
      category: category === '' ? null : category,
      label: correction.label || ('Correction: "' + key + '" -> ' + (kindOk ? kind : category)),
      source: 'correction'
    };
    var n = 0;
    for (var i = 0; i < pastRows.length; i++) {
      var hay = pastRows[i] ? (pastRows[i].merchantRaw || '') : '';
      if (hay.indexOf(key) !== -1) n++;
    }
    return {
      rule: rule,
      scopeDescription: 'Would apply to ' + n + ' of ' + pastRows.length +
        ' past record(s) (merchant contains "' + key + '").'
    };
  };

  /* ================================================================== */
  /* Duplicates (flag only — never auto-merge)                            */
  /* ================================================================== */

  /**
   * Engine.findDuplicateCandidates(rows) -> [[idxA, idxB, reason], ...]
   * Candidate key: same date + same amountMinor + same deduped merchant key.
   * Rows with null date/amount are skipped (cannot be compared safely).
   * Returns index pairs into the input array; merging is a USER decision.
   */
  Engine.findDuplicateCandidates = function (rows) {
    var byKey = {};
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r.date || r.amountMinor === null || r.amountMinor === undefined) continue;
      var mkey = merchantKeyForDedupe(r.merchantRaw);
      if (mkey === '') continue;
      var key = r.date + '|' + r.amountMinor + '|' + mkey;
      if (!byKey[key]) byKey[key] = [];
      var group = byKey[key];
      for (var g = 0; g < group.length; g++) {
        out.push([group[g], i, 'same date, amount and merchant']);
      }
      group.push(i);
    }
    return out;
  };

  /* ================================================================== */
  /* Reconciliation                                                       */
  /* ================================================================== */

  /**
   * Engine.reconcile(rows, reported=null) -> {...}
   *
   * SIGN CONVENTION (kept consistent everywhere):
   *   positive amountMinor = money left the household (purchases/charges)
   *   negative amountMinor = money came back (refunds/credits/payments)
   * netSpendMinor = grossPurchasesMinor + signedRefundTotal
   *               = grossPurchasesMinor - refundsTotalMinor
   * where refundsTotalMinor is the POSITIVE display magnitude of refunds.
   *
   * BALANCE CHECK (corrected card-account equation, mirrors
   * backend/engine/reconcile.py):
   *   reported.endMinor - reported.startMinor == SUM(signedAmountMinor)
   * over ALL rows of the statement — payments and transfers included.
   * signedAmountMinor is card-account-centric (charges raise the balance,
   * payments/credits lower it) and is supplied by the statement parser,
   * whose section/sign knowledge is needed to compute it; for rows
   * without a parser value it falls back to amountMinor (same convention).
   * If reported={startMinor,endMinor} are statement balances (e.g. for a
   * credit card, the balance OWED, positive when you owe), the gap is
   * (end - start) - signedSum; any non-zero gap beyond tolerance is
   * REPORTED, never hidden.
   */
  /* Review-sign predicate. The engine stamps confidence 'needs_review' on
   * every default-classified purchase (kindConfidence 0.6), so the band
   * alone cannot be the trigger — it would flag every transaction. A row
   * needs a human look when the kind is unknown, the read failed, the PDF
   * read itself was uncertain (kindConfidence below 0.6), or a spend row
   * still has no category (never-guess: unknown spend is flagged, never
   * silently trusted). A default-classified purchase that already has a
   * category is resolved. Single source of truth: App.needsReview in app.js
   * is the same predicate for the UI. */
  function rowNeedsReview(r) {
    r = r || {};
    if (r.kind === 'uncertain') return true;
    if (r._error) return true;
    if (typeof r.kindConfidence === 'number' && r.kindConfidence < 0.6) return true;
    var k = r.kind || 'uncertain';
    if (k !== 'purchase' && k !== 'refund') return false;
    var cat = (r.category !== null && r.category !== undefined && r.category !== '')
      ? r.category : (r.categoryId || null);
    if (cat) return false;
    if (r.excluded) return false;
    if (r.status === 'duplicate') return false;
    return true;
  }
  Engine.rowNeedsReview = rowNeedsReview;

  Engine.reconcile = function (rows, reported) {
    var gross = 0, refundSigned = 0, excludedTotal = 0;
    var unresolved = 0;
    var refundCount = 0;
    var signedSum = 0, signedKnown = true;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var amt = (r.amountMinor === null || r.amountMinor === undefined) ? 0 : r.amountMinor;
      if (r.kind === 'purchase') gross += amt;
      else if (r.kind === 'refund') { refundSigned += amt; refundCount++; }
      if (r.excluded === 1) excludedTotal += amt;
      if (rowNeedsReview(r)) unresolved++;
      var samt = r.signedAmountMinor;
      if (samt === null || samt === undefined) signedKnown = false;
      else signedSum += samt;
    }
    var refundsTotalMinor = -refundSigned; // positive display magnitude
    var netSpendMinor = gross + refundSigned; // == gross - refundsTotalMinor
    var result = {
      grossPurchasesMinor: gross,
      refundsTotalMinor: refundsTotalMinor,
      refundCount: refundCount,
      excludedTotalMinor: excludedTotal,
      netSpendMinor: netSpendMinor,
      unresolvedCount: unresolved,
      signedRowsSumMinor: signedSum,
      balanceCheck: 'no_baseline',
      gapMinor: 0
    };
    if (reported && typeof reported.startMinor === 'number' && typeof reported.endMinor === 'number' &&
        signedKnown) {
      var gap = (reported.endMinor - reported.startMinor) - signedSum;
      result.gapMinor = gap;
      result.balanceCheck = (gap >= -Engine.BALANCE_TOLERANCE_MINOR && gap <= Engine.BALANCE_TOLERANCE_MINOR) ? 'ok' : 'gap';
    }
    return result;
  };

  /**
   * Engine.monthlyNetSpend(txns, links) -> [{month 'YYYY-MM', netMinor,
   *   returnAdjMinor}, ...] oldest -> newest.
   * Groups txns by calendar month (valid ISO dates only) and reports each
   * month's net spend = Engine.reconcile(monthTxns, null).netSpendMinor
   * (signed minor units; the app displays magnitudes).
   * links (optional): refund-link rows {refundTxnId, purchaseTxnId, status}.
   * A refund linked to a purchase in a DIFFERENT month is attributed to the
   * purchase's month (return-adjusted spend: the month you bought it shows
   * the true net). Same-month links change nothing. Rejected links are
   * ignored. returnAdjMinor is the signed total of returns attributed INTO
   * that month (negative = returns reduced this month's net), 0 when no
   * link moved anything. Pure: txns and links are never mutated.
   */
  Engine.monthlyNetSpend = function (txns, links) {
    var byMonth = {};
    txns = txns || [];
    for (var i = 0; i < txns.length; i++) {
      var t = txns[i];
      if (!t || typeof t.date !== 'string') continue;
      var m = /^(\d{4})-(\d{2})-\d{2}$/.exec(t.date);
      if (!m) continue;
      var key = m[1] + '-' + m[2];
      if (!byMonth[key]) byMonth[key] = [];
      byMonth[key].push(t);
    }
    var intoAdj = {};
    var moves = Engine.refundMoves(txns, links);
    for (var v = 0; v < moves.length; v++) {
      var mv = moves[v];
      if (!byMonth[mv.fromMonth] || !byMonth[mv.toMonth]) continue;
      var idx = byMonth[mv.fromMonth].indexOf(mv.refund);
      if (idx === -1) continue;
      byMonth[mv.fromMonth].splice(idx, 1);
      byMonth[mv.toMonth].push(mv.refund);
      intoAdj[mv.toMonth] = (intoAdj[mv.toMonth] || 0) + mv.amountMinor;
    }
    var months = Object.keys(byMonth).sort();
    var out = [];
    for (var k = 0; k < months.length; k++) {
      var rec = null;
      try { rec = Engine.reconcile(byMonth[months[k]], null); } catch (e) { rec = null; }
      out.push({ month: months[k], netMinor: rec ? rec.netSpendMinor : 0,
                 returnAdjMinor: intoAdj[months[k]] || 0 });
    }
    return out;
  };

  /**
   * Engine.refundMoves(txns, links) -> [{refund, purchase, fromMonth, toMonth,
   *   amountMinor}]. Pure helper behind return-adjusted monthly spend: for
   * each refund link whose refund and purchase fall in different calendar
   * months, the refund's signed amount (refunds are negative) moves from the
   * refund's month to the purchase's month. Rejected links and same-month
   * links produce no move.
   */
  Engine.refundMoves = function (txns, links) {
    var byId = {};
    (txns || []).forEach(function (t) {
      if (t && t.id !== null && t.id !== undefined) byId[String(t.id)] = t;
    });
    var moves = [];
    (links || []).forEach(function (l) {
      if (!l || l.status === 'rejected') return;
      var rf = byId[String(l.refundTxnId)], pu = byId[String(l.purchaseTxnId)];
      if (!rf || !pu || rf.kind !== 'refund') return;
      var rm = Engine._monthOf(rf.date), pm = Engine._monthOf(pu.date);
      if (!rm || !pm || rm === pm) return;
      moves.push({ refund: rf, purchase: pu, fromMonth: rm, toMonth: pm,
                   amountMinor: rf.amountMinor || 0 });
    });
    return moves;
  };

  /** 'YYYY-MM-DD' -> 'YYYY-MM', else null. */
  Engine._monthOf = function (dateStr) {
    var m = /^(\d{4}-\d{2})-\d{2}$/.exec(String(dateStr || ''));
    return m ? m[1] : null;
  };

  /**
   * Engine.returnAdjustment(txns, links, month) -> {deltaMinor, movedMinor,
   *   linkCount} | null. The signed delta to ADD to a month's reconcile()
   * net so returns are attributed to the month of the original purchase:
   * refunds received in `month` for earlier purchases move out (net rises),
   * refunds received later for `month`'s purchases move in (net falls).
   * movedMinor is the signed total attributed INTO the month (for labeling);
   * null when no link affects the month. Pure.
   */
  Engine.returnAdjustment = function (txns, links, month) {
    if (!/^\d{4}-\d{2}$/.test(String(month || ''))) return null;
    var moves = Engine.refundMoves(txns, links);
    var delta = 0, movedIn = 0, n = 0;
    for (var i = 0; i < moves.length; i++) {
      var mv = moves[i];
      if (mv.fromMonth === month) { delta -= mv.amountMinor; n++; }
      else if (mv.toMonth === month) { delta += mv.amountMinor; movedIn += mv.amountMinor; n++; }
    }
    if (!n) return null;
    return { deltaMinor: delta, movedMinor: movedIn, linkCount: n };
  };

  /* ================================================================== */
  /* Briefing (deterministic facts only — NO LLM)                          */
  /* ================================================================== */

  function categoryKeyFor(r) {
    var c = trimStr(r.category || '');
    if (c !== '') return c;
    var m = trimStr(r.merchantRaw || '');
    return m !== '' ? m : 'Uncategorized';
  }

  function totalsByCategory(rows) {
    // Spend rows only: purchases (positive) and refunds (negative credits).
    // Split-aware: a split purchase contributes each split's share to its
    // split category. Share sign follows the txn's signed spend, so a split
    // purchase sums to exactly the row's original signed spend and briefing
    // deltas stay in the same sign convention as unsplit rows.
    var totals = {};
    var counts = {};
    var expanded = Engine.expandSplits(rows);
    var counted = {};
    for (var i = 0; i < expanded.length; i++) {
      var ex = expanded[i], r = ex.txn;
      if (!r) continue;
      if (r.kind !== 'purchase' && r.kind !== 'refund') continue;
      var key = trimStr(ex.category) !== '' ? ex.category : categoryKeyFor(r);
      var amt;
      if (ex.fromSplit) {
        var tAmt = (r.amountMinor === null || r.amountMinor === undefined) ? 0 : r.amountMinor;
        amt = tAmt < 0 ? -(ex.amountMinor || 0) : (ex.amountMinor || 0);
      } else {
        amt = (r.amountMinor === null || r.amountMinor === undefined) ? 0 : r.amountMinor;
      }
      totals[key] = (totals[key] || 0) + amt;
      // counts track SOURCE rows per category (a split txn counts once).
      var ck = ex.row + '|' + key;
      if (!counted[ck]) { counted[ck] = 1; counts[key] = (counts[key] || 0) + 1; }
    }
    return { totals: totals, counts: counts };
  }

  /**
   * Engine.buildBriefing(rows, periodStart, periodEnd, prevRows=null, scopeLabel='', reported=null)
   * -> facts object with ONLY deterministic, computed values. Any natural-
   * language explanation is generated elsewhere (and must cite these facts).
   * reported is an optional {startMinor, endMinor} baseline for the balance
   * check (statement parsers supply it from the account summary).
   */
  Engine.buildBriefing = function (rows, periodStart, periodEnd, prevRows, scopeLabel, reported) {
    rows = rows || [];
    prevRows = prevRows || null;
    var rec = Engine.reconcile(rows, reported || null);
    var cur = totalsByCategory(rows);

    var categoryTotals = {};
    var keys = Object.keys(cur.totals);
    for (var i = 0; i < keys.length; i++) categoryTotals[keys[i]] = cur.totals[keys[i]];

    var deltas = [];
    if (prevRows) {
      var prev = totalsByCategory(prevRows);
      var seen = {};
      var all = keys.concat(Object.keys(prev.totals));
      for (var j = 0; j < all.length; j++) {
        var k = all[j];
        if (seen[k]) continue;
        seen[k] = true;
        deltas.push({
          category: k,
          deltaMinor: (cur.totals[k] || 0) - (prev.totals[k] || 0),
          txnCount: cur.counts[k] || 0
        });
      }
      deltas.sort(function (a, b) {
        return Math.abs(b.deltaMinor) - Math.abs(a.deltaMinor);
      });
    }

    var topDrivers = [];
    for (var t = 0; t < keys.length; t++) {
      topDrivers.push({ category: keys[t], totalMinor: cur.totals[keys[t]], txnCount: cur.counts[keys[t]] });
    }
    topDrivers.sort(function (a, b) { return Math.abs(b.totalMinor) - Math.abs(a.totalMinor); });
    topDrivers = topDrivers.slice(0, 5);

    // Receipt coverage: share of purchase rows that carry a linked receipt id.
    // Rows carry receiptId when app.js links a receipt; engine never invents it.
    var purchaseCount = 0, coveredCount = 0;
    for (var p = 0; p < rows.length; p++) {
      if (rows[p].kind === 'purchase') {
        purchaseCount++;
        if (rows[p].receiptId) coveredCount++;
      }
    }
    var receiptCoveragePct = purchaseCount === 0 ? null :
      Math.round((coveredCount * 1000) / purchaseCount) / 10;

    var evidenceTxnIds = [];
    for (var e = 0; e < rows.length; e++) {
      if (rows[e].kind === 'purchase' || rows[e].kind === 'refund') {
        evidenceTxnIds.push(rows[e].id !== undefined && rows[e].id !== null ? rows[e].id : 'row#' + e);
      }
    }

    return {
      periodStart: periodStart || null,
      periodEnd: periodEnd || null,
      scopeLabel: scopeLabel || '',
      netSpendMinor: rec.netSpendMinor,
      grossPurchasesMinor: rec.grossPurchasesMinor,
      refundsTotalMinor: rec.refundsTotalMinor,
      categoryTotals: categoryTotals,
      deltas: deltas,
      topDrivers: topDrivers,
      refundsSummary: { count: rec.refundCount, totalMinor: rec.refundsTotalMinor },
      unresolvedCount: rec.unresolvedCount,
      receiptCoveragePct: receiptCoveragePct,
      evidenceTxnIds: evidenceTxnIds,
      balanceCheck: rec.balanceCheck,
      gapMinor: rec.gapMinor,
      signedRowsSumMinor: rec.signedRowsSumMinor,
      reportedStartMinor: (reported && typeof reported.startMinor === 'number') ? reported.startMinor : null,
      reportedEndMinor: (reported && typeof reported.endMinor === 'number') ? reported.endMinor : null
    };
  };

  /**
   * Engine.renderBriefingText(facts) -> plain-text briefing.
   * HONESTY RULE: if there is a material unresolved gap (transactions still
   * needing review, or a balance gap vs a reported baseline), the headline
   * says so plainly INSTEAD of presenting a false clean total.
   */
  Engine.renderBriefingText = function (facts) {
    facts = facts || {};
    var period = facts.scopeLabel || ((facts.periodStart || '?') + ' to ' + (facts.periodEnd || '?'));
    var lines = [];
    var materialGap = (facts.unresolvedCount || 0) > 0 ||
      (facts.balanceCheck === 'gap' && facts.gapMinor !== 0);

    if (materialGap) {
      lines.push('We can\'t give you a final number for ' + period + ' yet.');
      if ((facts.unresolvedCount || 0) > 0) {
        lines.push(facts.unresolvedCount + ' transaction(s) still need your review, so any total below is preliminary.');
      }
      if (facts.balanceCheck === 'gap') {
        lines.push('The numbers don\'t reconcile with the reported balance (gap of ' +
          Engine.fmtMoney(facts.gapMinor) + '). Something is missing or miscategorized.');
      }
    } else {
      lines.push('You spent ' + Engine.fmtMoney(facts.netSpendMinor || 0) + ' in ' + period +
        ' \u2014 after ' + Engine.fmtMoney(facts.refundsTotalMinor || 0) + ' in refunds.');
    }
    lines.push('');

    // What changed (vs previous period, if provided)
    lines.push('What changed');
    var deltas = facts.deltas || [];
    if (deltas.length === 0) {
      lines.push('- No previous period to compare against.');
    } else {
      var shown = 0;
      for (var i = 0; i < deltas.length && shown < 3; i++) {
        var d = deltas[i];
        if (d.deltaMinor === 0) continue;
        var dir = d.deltaMinor > 0 ? 'up' : 'down';
        lines.push('- ' + d.category + ': ' + dir + ' ' + Engine.fmtMoney(Math.abs(d.deltaMinor)) +
          ' (' + d.txnCount + ' transaction(s) this period).');
        shown++;
      }
      if (shown === 0) lines.push('- Spending was flat across categories.');
    }
    lines.push('');

    // Where it went
    lines.push('Where it went');
    var drivers = facts.topDrivers || [];
    if (drivers.length === 0) {
      lines.push('- No categorized spend in this period.');
    } else {
      for (var t = 0; t < drivers.length; t++) {
        lines.push('- ' + drivers[t].category + ': ' + Engine.fmtMoney(drivers[t].totalMinor) +
          ' across ' + drivers[t].txnCount + ' transaction(s).');
      }
    }
    lines.push('');

    // Refunds & money movement
    lines.push('Refunds & money movement');
    var rs = facts.refundsSummary || { count: 0, totalMinor: 0 };
    lines.push('- Refunds/credits: ' + rs.count + ' transaction(s), ' +
      Engine.fmtMoney(rs.totalMinor || 0) + ' back.');
    lines.push('- Gross purchases before refunds: ' + Engine.fmtMoney(facts.grossPurchasesMinor || 0) + '.');
    lines.push('');

    // Needs your review
    lines.push('Needs your review');
    if ((facts.unresolvedCount || 0) === 0) {
      lines.push('- Nothing outstanding. Every transaction is classified.');
    } else {
      lines.push('- ' + facts.unresolvedCount + ' transaction(s) need review (uncertain kind, ' +
        'unparseable data, or low confidence). They are excluded from the totals above.');
    }
    lines.push('');

    // Evidence quality
    lines.push('Evidence quality');
    var ids = facts.evidenceTxnIds || [];
    lines.push('- ' + ids.length + ' transaction(s) back every number above.');
    if (facts.receiptCoveragePct === null || facts.receiptCoveragePct === undefined) {
      lines.push('- Receipt coverage: no purchases in this period.');
    } else {
      lines.push('- Receipt coverage: ' + facts.receiptCoveragePct + '% of purchases have a linked receipt.');
    }
    lines.push('- All figures are computed on-device from your statements. No estimates, no cloud.');
    return lines.join('\n');
  };

  /* ================================================================== */
  /* Receipt matching (omission preferred over false matches)             */
  /* ================================================================== */

  function tokenize(s) {
    var toks = String(s || '').toUpperCase().split(/[^A-Z0-9]+/);
    var out = [];
    for (var i = 0; i < toks.length; i++) {
      if (toks[i].length > 2) out.push(toks[i]);
    }
    return out;
  }

  function daysBetweenISO(a, b) {
    var pa = a.split('-'), pb = b.split('-');
    var da = Date.UTC(+pa[0], +pa[1] - 1, +pa[2]);
    var db = Date.UTC(+pb[0], +pb[1] - 1, +pb[2]);
    return Math.abs(Math.round((da - db) / 86400000));
  }

  /**
   * Engine.scoreReceiptMatch(txn, receipt) -> [score 0..1, reasons[]].
   * txn/receipt: {amountMinor, date (ISO YYYY-MM-DD), merchantRaw}.
   * Scoring: amount equality 0.5, date within 3 days up to 0.3, merchant
   * token overlap up to 0.2. Scores BELOW Engine.RECEIPT_MATCH_THRESHOLD
   * (0.85) must be treated as NO match — omission is preferred (the design
   * target is >=90% precision on accepted matches, so the bar is high).
   */
  Engine.scoreReceiptMatch = function (txn, receipt) {
    txn = txn || {};
    receipt = receipt || {};
    var score = 0;
    var reasons = [];

    if (txn.amountMinor !== null && txn.amountMinor !== undefined &&
        txn.amountMinor === receipt.amountMinor) {
      score += 0.5;
      reasons.push('amount matches exactly (' + Engine.fmtMoney(txn.amountMinor) + ')');
    } else {
      reasons.push('amount does not match');
    }

    if (txn.date && receipt.date) {
      var dd = daysBetweenISO(txn.date, receipt.date);
      if (dd === 0) { score += 0.3; reasons.push('same date'); }
      else if (dd <= 3) { score += 0.2; reasons.push('date within 3 days (' + dd + ' day(s) apart)'); }
      else reasons.push('dates ' + dd + ' days apart (too far)');
    } else {
      reasons.push('date missing on one side');
    }

    var tt = tokenize(txn.merchantRaw);
    var rt = tokenize(receipt.merchantRaw || receipt.description);
    if (tt.length > 0 && rt.length > 0) {
      var set = {};
      for (var i = 0; i < rt.length; i++) set[rt[i]] = true;
      var inter = 0;
      var seenT = {};
      for (var j = 0; j < tt.length; j++) {
        if (!seenT[tt[j]]) { seenT[tt[j]] = true; if (set[tt[j]]) inter++; }
      }
      var union = 0;
      var seenU = {};
      var k;
      for (k = 0; k < tt.length; k++) { if (!seenU[tt[k]]) { seenU[tt[k]] = true; union++; } }
      for (k = 0; k < rt.length; k++) { if (!seenU[rt[k]]) { seenU[rt[k]] = true; union++; } }
      var jacc = union === 0 ? 0 : inter / union;
      if (jacc >= 0.5) { score += 0.2; reasons.push('strong merchant token overlap'); }
      else if (inter > 0) { score += 0.1; reasons.push('partial merchant token overlap'); }
      else reasons.push('no merchant token overlap');
    } else {
      reasons.push('merchant text missing on one side');
    }

    if (score > 1) score = 1;
    // Round to 2dp with integer math (still no floats for decisions that
    // matter; the threshold comparison below uses the rounded value).
    score = Math.round(score * 100) / 100;
    if (score < Engine.RECEIPT_MATCH_THRESHOLD) {
      reasons.push('below acceptance threshold ' + Engine.RECEIPT_MATCH_THRESHOLD +
        ' — treated as NO match (omission preferred)');
    }
    return [score, reasons];
  };

  /* ================================================================== */
  /* Splits: one purchase across several categories                     */
  /* ================================================================== */

  /**
   * Engine.splitEvenly(totalMinor, n) -> [shareMinor, ...] (n integer shares).
   * Divides a positive magnitude into n integer shares: base=floor(total/n)
   * each, and the first `total % n` rows get one extra penny — remainder
   * pennies go to the first rows (the largest shares). The shares always
   * sum to exactly totalMinor. Integer math only.
   */
  Engine.splitEvenly = function (totalMinor, n) {
    var total = Math.abs(Math.floor(totalMinor || 0));
    n = Math.floor(n || 0);
    if (n <= 0 || total <= 0) return [];
    var base = Math.floor(total / n);
    var rem = total - base * n;
    var out = [];
    for (var i = 0; i < n; i++) out.push(base + (i < rem ? 1 : 0));
    return out;
  };

  // A stored split is valid only when every row has a non-blank category, a
  // positive integer magnitude, and the parts sum to exactly |spend|.
  // Invalid splits are treated as unsplit (the single-category row) —
  // a corrupt split must never silently change a total.
  function validSplit(splits, txn) {
    if (!Array.isArray(splits) || splits.length === 0) return false;
    var total = 0;
    for (var i = 0; i < splits.length; i++) {
      var s = splits[i] || {};
      if (trimStr(s.category) === '') return false;
      var a = s.amountMinor;
      if (typeof a !== 'number' || !isFinite(a) || Math.floor(a) !== a || a <= 0) return false;
      total += a;
    }
    if (!txn) return false;
    var m = txn.spendAmountMinor;
    if (m === null || m === undefined) m = txn.amountMinor;
    return total === Math.abs(m || 0);
  }

  /**
   * Engine.expandSplits(txns) -> [{txn, row, category, amountMinor, fromSplit}]
   * Expands per-category splits: a txn carrying a valid t.splits
   * ([{category, amountMinor}] positive magnitudes summing to exactly |spend|)
   * yields one row per split; anything else yields one row with the txn's own
   * category. amountMinor is always a positive MAGNITUDE — callers apply the
   * kind's sign convention themselves. row is the index into txns (for
   * stable per-txn counting).
   */
  Engine.expandSplits = function (txns) {
    var out = [];
    txns = txns || [];
    for (var i = 0; i < txns.length; i++) {
      var t = txns[i];
      if (!t) continue;
      if (validSplit(t.splits, t)) {
        for (var s = 0; s < t.splits.length; s++) {
          out.push({ txn: t, row: i, category: t.splits[s].category,
                     amountMinor: t.splits[s].amountMinor, fromSplit: true });
        }
      } else {
        var m = t.spendAmountMinor;
        if (m === null || m === undefined) m = t.amountMinor;
        out.push({ txn: t, row: i, category: t.category || '',
                   amountMinor: Math.abs(m || 0), fromSplit: false });
      }
    }
    return out;
  };

  /**
   * Engine.splitAwareCategoryTotals(txns, monthPrefix) -> {category: minor}.
   * Purchase-only spend totals for one 'YYYY-MM' month, honoring splits:
   * a split purchase contributes each split's magnitude to its split
   * category. Excluded and duplicate txns never count. Integer math only.
   * Category keys mirror buildBriefing's: the expanded category, falling
   * back to the merchant name when the row has no category.
   */
  Engine.splitAwareCategoryTotals = function (txns, monthPrefix) {
    var totals = {};
    var expanded = Engine.expandSplits(txns || []);
    for (var i = 0; i < expanded.length; i++) {
      var ex = expanded[i], t = ex.txn;
      if (!t || t.kind !== 'purchase') continue;
      if (t.excluded) continue;
      if (t.status === 'duplicate') continue;
      if (typeof t.date !== 'string' || t.date.indexOf(monthPrefix) !== 0) continue;
      var key = trimStr(ex.category) !== '' ? ex.category : categoryKeyFor(t);
      totals[key] = (totals[key] || 0) + (ex.amountMinor || 0);
    }
    return totals;
  };

  /* ================================================================== */
  /* Planning: budget spend + recurring-charge detection                  */
  /* ================================================================== */

  /**
   * Engine.categorySpendMinor(txns, categoryId, monthPrefix) -> int minor.
   * Spend magnitude summed over txns with kind==='purchase', matching
   * category, date starting with monthPrefix ('YYYY-MM'), not excluded,
   * and status!=='duplicate'. Split-aware via splitAwareCategoryTotals.
   * Integer math only.
   */
  Engine.categorySpendMinor = function (txns, categoryId, monthPrefix) {
    var totals = Engine.splitAwareCategoryTotals(txns, monthPrefix);
    var v = totals[String(categoryId)];
    return v === undefined ? 0 : v;
  };

  /**
   * Engine._normSubMerchant(raw) -> lowercase, whitespace-collapsed merchant
   * with trailing store-number tokens stripped ("#138", "no 138", "no. 12").
   * More aggressive than normalizeMerchant(): subscription grouping needs
   * "NETFLIX #138" and "NETFLIX" to land in one bucket.
   */
  Engine._normSubMerchant = function (raw) {
    var s = String(raw == null ? '' : raw).toLowerCase().replace(/\s+/g, ' ');
    s = s.replace(/^\s+|\s+$/g, '');
    s = s.replace(/\s*(#\s*\d+|no\.?\s*\d+)$/, '');
    return s.replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
  };

  // Median of a SORTED numeric array (even n -> average of the middle two).
  function medianSorted(sorted) {
    var n = sorted.length;
    if (n === 0) return 0;
    var mid = Math.floor(n / 2);
    if (n % 2 === 1) return sorted[mid];
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }

  // ISO date -> integer day number (UTC); day number -> ISO date.
  function utcDayNumber(iso) {
    var p = String(iso).split('-');
    return Math.floor(Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000);
  }
  function isoFromDayNumber(dn) {
    var d = new Date(dn * 86400000);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }

  /**
   * Engine.detectSubscriptions(txns) -> [ {merchant (normalized),
   *   displayName (most common raw text), cadence ('monthly'|'weekly'|'yearly'),
   *   amountMinor (median, rounded to int), occurrences, lastDate,
   *   nextExpected ('YYYY-MM-DD'), priceChanged, monthlyCostMinor}, ... ]
   * sorted by monthlyCostMinor desc.
   *
   * Heuristic, deliberately conservative (uncertain groups are DISCARDED,
   * never presented as fact):
   *  - only kind==='purchase', !excluded, status!=='duplicate', valid date;
   *  - group by normalized merchant; require >= 3 occurrences;
   *  - median gap between consecutive dates sets cadence:
   *      25-35 days -> monthly, 6-8 -> weekly, 360-370 -> yearly, else discard;
   *  - amounts (|amountMinor|): earlier occurrences must each sit within 5%
   *    of the earlier median (|a-m|*100 > m*5 discards the group). The LATEST
   *    occurrence is compared separately: a >5% move vs the earlier median
   *    sets priceChanged instead of discarding (needs >= 2 earlier, which the
   *    >= 3 occurrences rule guarantees). Zero-cost medians are discarded.
   *  - nextExpected = lastDate + median gap (UTC); monthlyCostMinor normalizes
   *    the median to a monthly figure (weekly: median*30/7, yearly: median/12).
   */
  Engine.detectSubscriptions = function (txns) {
    var groups = {};
    txns = txns || [];
    for (var i = 0; i < txns.length; i++) {
      var t = txns[i];
      if (!t || t.kind !== 'purchase') continue;
      if (t.excluded) continue;
      if (t.status === 'duplicate') continue;
      if (!looksLikeISODate(t.date)) continue;
      if (typeof t.amountMinor !== 'number' || !isFinite(t.amountMinor)) continue;
      var key = Engine._normSubMerchant(t.merchantRaw);
      if (!key) continue;
      if (!groups[key]) groups[key] = [];
      groups[key].push({ date: t.date, raw: t.merchantRaw, amount: Math.abs(t.amountMinor), order: i });
    }

    var out = [];
    var keys = Object.keys(groups);
    for (var g = 0; g < keys.length; g++) {
      var items = groups[keys[g]];
      if (items.length < 3) continue;
      items.sort(function (a, b) {
        if (a.date < b.date) return -1;
        if (a.date > b.date) return 1;
        return a.order - b.order;
      });

      // Gaps between consecutive DISTINCT dates (same-day repeats collapse;
      // they are re-purchases, not a cadence signal).
      var gaps = [];
      for (var d = 1; d < items.length; d++) {
        var gp = utcDayNumber(items[d].date) - utcDayNumber(items[d - 1].date);
        if (gp > 0) gaps.push(gp);
      }
      if (gaps.length < 2) continue; // < 3 distinct dates: no cadence to infer
      gaps.sort(function (a, b) { return a - b; });
      var medGap = medianSorted(gaps);
      var cadence = null;
      if (medGap >= 25 && medGap <= 35) cadence = 'monthly';
      else if (medGap >= 6 && medGap <= 8) cadence = 'weekly';
      else if (medGap >= 360 && medGap <= 370) cadence = 'yearly';
      if (!cadence) continue;

      // Amounts: earlier history must be stable; the latest occurrence is
      // evaluated separately as a possible price change.
      var earlier = [];
      for (d = 0; d < items.length - 1; d++) earlier.push(items[d].amount);
      earlier.sort(function (a, b) { return a - b; });
      var medEarlier = medianSorted(earlier);
      if (!(medEarlier > 0)) continue;
      var noisy = false;
      for (d = 0; d < earlier.length; d++) {
        if (Math.abs(earlier[d] - medEarlier) * 100 > medEarlier * 5) { noisy = true; break; }
      }
      if (noisy) continue;
      var latest = items[items.length - 1].amount;
      var priceChanged = Math.abs(latest - medEarlier) * 100 > medEarlier * 5;

      var allSorted = earlier.concat([latest]).sort(function (a, b) { return a - b; });
      var medMinor = Math.round(medianSorted(allSorted)); // minor units: int
      var monthlyCostMinor;
      if (cadence === 'weekly') monthlyCostMinor = Math.round(medMinor * 30 / 7);
      else if (cadence === 'yearly') monthlyCostMinor = Math.round(medMinor / 12);
      else monthlyCostMinor = medMinor;

      // displayName: most common raw merchant text (first-seen wins ties).
      var counts = {};
      var best = items[0].raw || '', bestN = 0;
      for (d = 0; d < items.length; d++) {
        var rn = items[d].raw || '';
        counts[rn] = (counts[rn] || 0) + 1;
        if (counts[rn] > bestN) { bestN = counts[rn]; best = rn; }
      }

      var lastDate = items[items.length - 1].date;
      out.push({
        merchant: keys[g],
        displayName: best,
        cadence: cadence,
        amountMinor: medMinor,
        occurrences: items.length,
        lastDate: lastDate,
        nextExpected: isoFromDayNumber(utcDayNumber(lastDate) + Math.round(medGap)),
        priceChanged: priceChanged,
        monthlyCostMinor: monthlyCostMinor
      });
    }
    out.sort(function (a, b) { return b.monthlyCostMinor - a.monthlyCostMinor; });
    return out;
  };

  /* ================================================================== */
  /* Money formatting                                                     */
  /* ================================================================== */

  /**
   * Engine.fmtMoney(minor) -> "$1,234.56". Handles negatives ("-$42.18").
   * Implemented manually (no locale APIs) so output is identical everywhere.
   */
  Engine.fmtMoney = function (minor) {
    var m = (minor === null || minor === undefined) ? 0 : minor;
    var neg = m < 0;
    var a = neg ? -m : m;
    var dollars = Math.floor(a / 100);
    var cents = a % 100;
    var ds = String(dollars).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '-' : '') + '$' + ds + '.' + (cents < 10 ? '0' : '') + cents;
  };

  /* ================================================================== */
  /* Categories                                                           */
  /* ================================================================== */

  /**
   * Engine.defaultCategories() -> [{id, name, parentId}].
   * Flat household category list for Gate 1 (parentId reserved for later).
   */
  Engine.defaultCategories = function () {
    return [
      { id: 'groceries',      name: 'Groceries',       parentId: null },
      { id: 'household',      name: 'Household',       parentId: null },
      { id: 'dining',         name: 'Dining',          parentId: null },
      { id: 'transport',      name: 'Transport',       parentId: null },
      { id: 'health_pharmacy', name: 'Health/Pharmacy', parentId: null },
      { id: 'subscriptions',  name: 'Subscriptions',   parentId: null },
      { id: 'shopping',       name: 'Shopping',        parentId: null },
      { id: 'leisure',        name: 'Leisure',         parentId: null },
      { id: 'fees',           name: 'Fees',            parentId: null },
      { id: 'other',          name: 'Other',           parentId: null }
    ];
  };

  // Known category ids (defensive: keyword rules can never invent one).
  var KNOWN_CATEGORY_IDS = {};
  (function () {
    var cats = Engine.defaultCategories();
    for (var i = 0; i < cats.length; i++) KNOWN_CATEGORY_IDS[cats[i].id] = true;
  })();

  /**
   * Engine.categoryKeywordRules: ORDERED list of {category, confidence,
   * keywords[]}. Applied FIRST MATCH WINS, so specific multi-word keys come
   * before their generic single-word cousins ('COSTCO GAS' -> transport must
   * beat 'COSTCO' -> groceries; 'UBER EATS' -> dining must beat 'UBER' ->
   * transport; 'CANADIAN TIRE GAS' -> transport must beat 'CANADIAN TIRE' ->
   * household). Alphanumeric-folded substring match against the uppercase
   * merchantRaw (punctuation/spacing-insensitive, see foldAlphaNum).
   *
   * Confidence: the rule's confidence applies when the matched keyword is
   * multi-word (specific); generic single-word matches are capped at 0.75.
   * Engine.autoCategorize only stamps suggestions at >= 0.6 — anything less
   * certain stays blank (honest: never invent a category).
   *
   * Canadian-merchant focused, but these are guesses with a stated
   * confidence, not facts: user corrections and household rules always win.
   */
  Engine.categoryKeywordRules = [
    // --- specific keys that must beat a generic rule below ---
    { category: 'transport', confidence: 0.95, keywords: ['COSTCO GAS', 'COSTCO FUEL', 'CANADIAN TIRE GAS', 'GO TRANSIT', 'PRESTO CARD', 'GREEN P PARKING', 'VIA RAIL'] },
    { category: 'groceries', confidence: 0.92, keywords: ['LOBLAWS', 'REAL CANADIAN SUPERSTORE', 'REAL CANADIAN', 'SUPERSTORE', 'RCSS', 'NO FRILLS', 'NOFRILLS', 'NOFR', 'SOBEYS', 'FRESHCO', 'FOOD BASICS', 'LONGOS', 'FORTINOS', 'FARM BOY', 'SAVE-ON-FOODS', 'SAVE ON FOODS', 'SAFEWAY', 'MARCHE ADONIS', 'T&T SUPERMARKET', 'H MART', 'COSTCO WHOLESALE'] },
    { category: 'dining', confidence: 0.92, keywords: ['TIM HORTONS', 'MCDONALD', 'KFC', 'POPEYES', 'DOMINOS', 'BONDUC', 'SKIPTHEDISHES', 'SKIP THE DISHES', 'DOORDASH', 'UBER EATS', 'PIZZA PIZZA', 'THE KEG', 'STEAKHOUSE', 'HARVEYS', 'WENDY', 'SUBWAY', 'STARBUCKS', 'SECOND CUP', 'SUSHI', 'ICE CREAM', 'RESTAURANT', 'FOOD COURT', 'PIZZERIA', 'COFFEE', 'CAFE'] },
    { category: 'health_pharmacy', confidence: 0.92, keywords: ['SHOPPERS DRUG', 'DRUG MART', 'SHOPPERS', 'REXALL', 'PHARMAPRIX', 'JEAN COUTU', 'PHARMACY', 'LIFE LABS', 'LIFELABS', 'DENTAL', 'OPTICAL', 'PHYSIO', 'WALK-IN CLINIC', 'MEDICAL CENTRE'] },
    { category: 'subscriptions', confidence: 0.92, keywords: ['NETFLIX', 'SPOTIFY', 'DISNEY+', 'AMAZON PRIME', 'PRIME VIDEO', 'YOUTUBE PREMIUM', 'APPLE.COM/BILL', 'GOOGLE ONE', 'DROPBOX', 'ICLOUD', 'MICROSOFT 365', 'ROGERS WIRELESS', 'ROGERS', 'BELL MOBILITY', 'TELUS', 'KOODO', 'FREEDOM MOBILE', 'FIDO', 'VIRGIN MOBILE', 'GOODLIFE FITNESS', 'GOODLIFE', 'FITNESS'] },
    { category: 'household', confidence: 0.88, keywords: ['HYDRO ONE', 'HYDRO', 'ENBRIDGE', 'ENERCARE', 'TORONTO WATER', 'CANADIAN TIRE', 'HOME DEPOT', 'RONA', 'LOWES', "LOWE'S", 'IKEA', 'DOLLARAMA', 'BED BATH', 'UTILITY', 'PROPERTY TAX'] },
    { category: 'shopping', confidence: 0.88, keywords: ['BEST BUY', 'SPORT CHEK', 'SPORTCHEK', 'WINNERS', 'HOMESENSE', 'MARKS WORK', 'AMAZON', 'COSTCO.CA'] },
    { category: 'leisure', confidence: 0.92, keywords: ['ROYAL CARIBBEAN', 'CARNIVAL CRUISE', 'NORWEGIAN CRUISE', 'DISNEY CRUISE', 'CRUISE LINE', 'AIRBNB', 'BOOKING.COM', 'EXPEDIA', 'HOTELS.COM', 'MARRIOTT', 'HILTON', 'WESTIN', 'HOLIDAY INN', 'FAIRMONT', 'RESORT', 'VACATION', 'CINEPLEX', 'LANDMARK CINEMA', 'TICKETMASTER', 'LIVE NATION', 'CONCERT'] },
    // --- generic single-word keys (lower confidence, still >= 0.6) ---
    { category: 'transport', confidence: 0.90, keywords: ['SHELL', 'ESSO', 'PETRO', 'PIONEER', 'ULTRAMAR', 'HUSKY', 'PRESTO', 'TTC', 'PARKING', 'UBER', 'LYFT', 'AIR CANADA', 'PORTER AIRLINES', 'WESTJET', 'AVIS', 'BUDGET RENT', 'TAXI'] },
    { category: 'groceries', confidence: 0.80, keywords: ['COSTCO', 'METRO', 'GROCERY', 'FOODS', 'PRODUCE', 'BAKERY', 'BUTCHER', 'MEAT MARKET'] },
    { category: 'leisure', confidence: 0.80, keywords: ['CRUISE', 'HOTEL', 'MOTEL', 'AIRBNB', 'CINEMA', 'THEATRE', 'THEATER', 'MOVIE', 'GOLF', 'SKI RESORT'] },
    { category: 'shopping', confidence: 0.80, keywords: ['WALMART', 'SEPHORA', 'OLD NAVY', 'ZARA', 'H&M'] },
    { category: 'fees', confidence: 0.90, keywords: ['ANNUAL FEE', 'LATE FEE', 'INTEREST CHARGE', 'INTEREST CHARGED', 'SERVICE CHARGE', 'BANK FEE', 'OVERDRAFT', 'CASH ADVANCE FEE', 'NSF FEE'] },
    { category: 'other', confidence: 0.70, keywords: ['LCBO', 'BEER STORE', 'CANADA POST', 'POST OFFICE', 'DONATION', 'CHARITY', 'GOVERNMENT', 'CITY OF'] }
  ];

  /**
   * Fold a string to uppercase alphanumerics for keyword matching, so
   * punctuation and spacing variants ('WAL-MART' vs 'WALMART', 'SAVE-ON-FOODS'
   * vs 'SAVE ON FOODS', 'H&M') match the same keyword. Folded matching is a
   * strict superset of plain substring matching: if hay contained kw, the
   * folded hay still contains the folded kw.
   */
  function foldAlphaNum(s) {
    return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  /**
   * Engine.suggestCategory(row) -> {categoryId, confidence, reason} | null.
   * Built-in, on-device category guess for one row. Honest by design:
   *  - kind==='fee' -> 'fees' @ 0.9 (a fee is a fee).
   *  - kind in (payment, transfer) -> null (money movement, not spend).
   *  - kind in (purchase, refund) -> first keyword-rule match (ordered, so
   *    specific beats generic); multi-word keyword -> rule confidence,
   *    generic single-word -> capped at 0.75. Matching is
   *    alphanumeric-folded (see foldAlphaNum).
   *  - anything else (uncertain, cash_advance, ...) -> null.
   *  - NO keyword match -> null. Blank stays blank; never invent a category.
   */
  Engine.suggestCategory = function (row) {
    row = row || {};
    var kind = row.kind;
    if (kind === 'fee') {
      return { categoryId: 'fees', confidence: 0.90, reason: 'kind is fee' };
    }
    if (kind === 'payment' || kind === 'transfer') return null;
    if (kind !== 'purchase' && kind !== 'refund') return null;
    var hay = String(row.merchantRaw || '');
    if (hay === '') return null;
    var hayFolded = foldAlphaNum(hay);
    var rules = Engine.categoryKeywordRules || [];
    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];
      if (!rule || !KNOWN_CATEGORY_IDS[rule.category]) continue;
      var kws = rule.keywords || [];
      for (var k = 0; k < kws.length; k++) {
        var kw = String(kws[k] || '').toUpperCase();
        if (kw !== '' && hayFolded.indexOf(foldAlphaNum(kw)) !== -1) {
          var multi = kw.indexOf(' ') !== -1;
          var conf = multi ? rule.confidence : Math.min(rule.confidence, 0.75);
          return { categoryId: rule.category, confidence: conf,
                   reason: 'merchant contains "' + kw + '" \u2192 ' + rule.category };
        }
      }
    }
    return null;
  };

  /** Stamp {category, categorySource, categoryConfidence, categoryReason}. */
  function stampCategory(row, category, source, confidence, reason) {
    row.category = category;
    row.categorySource = source; // 'rule' | 'auto' | 'user'
    row.categoryConfidence = confidence;
    row.categoryReason = reason;
  }

  /** Household rule's category: new flat `category`, else legacy
   * appMatch.setCategory (app-level category rules). */
  function ruleCategoryOf(rule) {
    if (!rule) return null;
    if (rule.category && KNOWN_CATEGORY_IDS[rule.category]) return rule.category;
    var ac = rule.appMatch && rule.appMatch.setCategory;
    if (ac && KNOWN_CATEGORY_IDS[ac]) return ac;
    return null;
  }

  /**
   * Engine.autoCategorize(rows, rules) -> rows.
   * Pipeline step AFTER classifyRows: assigns spend categories.
   *  - Rows the user touched (classificationSource==='user' or a user-set
   *    category, categorySource==='user') are NEVER overwritten.
   *  - A household rule carrying a category wins (matchMerchant substring,
   *    highest priority first): {categorySource:'rule', categoryConfidence:1.0}.
   *  - Otherwise the built-in keyword suggestion stamps the row only when
   *    confidence >= 0.6 ({categorySource:'auto'}).
   *  - No suggestion -> the row's category is left as-is (blank stays
   *    blank; honest, never invented).
   */
  Engine.autoCategorize = function (rows, rules) {
    rows = rows || [];
    rules = rules || [];
    var active = [];
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      if (!r || r.enabled === false || !r.matchMerchant) continue;
      var cat = ruleCategoryOf(r);
      if (!cat) continue;
      active.push({ rule: r, category: cat, key: String(r.matchMerchant).toUpperCase() });
    }
    // ES2019 sort is stable: equal priorities keep original order.
    active.sort(function (a, b) { return (b.rule.priority || 0) - (a.rule.priority || 0); });
    for (var t = 0; t < rows.length; t++) {
      var row = rows[t];
      if (!row) continue;
      if (row.classificationSource === 'user' || row.categorySource === 'user') continue;
      var hay = String(row.merchantRaw || '');
      var matched = null;
      for (var a = 0; a < active.length; a++) {
        if (hay.indexOf(active[a].key) !== -1) { matched = active[a]; break; }
      }
      if (matched) {
        stampCategory(row, matched.category, 'rule', 1.0,
          'household rule: ' + (matched.rule.label || matched.rule.id));
      } else {
        var sug = Engine.suggestCategory(row);
        if (sug && sug.confidence >= 0.6) {
          stampCategory(row, sug.categoryId, 'auto', sug.confidence, sug.reason);
        }
      }
    }
    return rows;
  };

  /* ================================================================== */
  /* Statement coverage + sample data (Phase 4)                           */
  /* ================================================================== */

  /**
   * Engine._mulberry32(seed) -> () -> [0,1).
   * Small seeded PRNG used only for synthetic sample data. Integer
   * arithmetic only (Math.imul, ^, >>>): the sequence is bit-identical on
   * every platform, so Engine.sampleData is deterministic per seed.
   */
  Engine._mulberry32 = function (seed) {
    var a = (seed === null || seed === undefined) ? 1 : (seed >>> 0);
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  /** Current calendar month as 'YYYY-MM' (local time). */
  Engine._currentMonth = function () {
    var n = new Date();
    return n.getFullYear() + '-' + ('0' + (n.getMonth() + 1)).slice(-2);
  };

  /** Previous calendar month as 'YYYY-MM' (pure; ES2019). */
  Engine._prevMonth = function (ym) {
    var y = +String(ym).slice(0, 4), m = +String(ym).slice(5, 7);
    m -= 1;
    if (m < 1) { m = 12; y -= 1; }
    return y + '-' + ('0' + m).slice(-2);
  };

  /** Last day of month ym as 'YYYY-MM-DD' (pure; null when ym is invalid). */
  Engine._monthLastDay = function (ym) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(ym || ''))) return null;
    var y = +ym.slice(0, 4), m = +ym.slice(5, 7);
    var d = (m === 2)
      ? (((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0) ? 29 : 28)
      : ((m === 4 || m === 6 || m === 9 || m === 11) ? 30 : 31);
    return ym + '-' + (d < 10 ? '0' : '') + d;
  };

  /**
   * Engine.monthCovered(statements, monthPrefix) -> bool.
   * True when any statement's [periodStart, periodEnd] overlaps month M
   * (ISO date strings compare lexicographically). A statement covers M if
   * periodStart <= last-day-of-M AND periodEnd >= first-day-of-M.
   * Missing/malformed periodStart or periodEnd counts as uncovered —
   * never guess.
   */
  Engine.monthCovered = function (statements, monthPrefix) {
    var ym = String(monthPrefix || '');
    var first = ym + '-01';
    var last = Engine._monthLastDay(ym);
    if (last === null) return false;
    statements = statements || [];
    for (var i = 0; i < statements.length; i++) {
      var s = statements[i] || {};
      var ps = s.periodStart, pe = s.periodEnd;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(ps || '') || !/^\d{4}-\d{2}-\d{2}$/.test(pe || '')) continue;
      if (ps <= last && pe >= first) return true;
    }
    return false;
  };

  /* Neutral fictional merchants for sample data (~4 per category). */
  var SAMPLE_MERCHANTS = {
    groceries:       ['FRESHCO', 'LOBLAWS', 'SOBEYS', 'COSTCO'],
    household:       ['CANADIAN TIRE', 'HOME DEPOT', 'DOLLARAMA', 'IKEA'],
    dining:          ['TIM HORTONS', 'STARBUCKS', 'PIZZA PIZZA', 'HARVEYS'],
    transport:       ['UBER', 'SHELL', 'PETRO-CANADA', 'TTC'],
    health_pharmacy: ['SHOPPERS DRUG', 'REXALL', 'DENTAL CARE', 'LIFE LABS'],
    subscriptions:   ['SPOTIFY', 'NETFLIX', 'DROPBOX', 'GITHUB'],
    shopping:        ['AMAZON', 'WALMART', 'BEST BUY', 'ZARA'],
    leisure:         ['ROYAL CARIBBEAN', 'AIRBNB', 'CINEPLEX', 'MARRIOTT'],
    fees:            ['BANK FEE', 'SERVICE FEE', 'ANNUAL FEE', 'OVERDRAFT FEE'],
    other:           ['POST OFFICE', 'CITY TAXES', 'DONATION', 'LIBRARY']
  };
  var SAMPLE_BATCH = 'v2-sample';

  /**
   * Engine.sampleData(seed, baseMonth) -> {account, statements, txns}.
   * Deterministic synthetic ledger for the "Try with sample data" button.
   * PURE: no Date.now(), no Math.random — the same (seed, baseMonth) pair
   * always yields JSON-identical output. baseMonth ('YYYY-MM', default
   * current month) anchors the 3 consecutive months (oldest -> newest).
   *
   * Shape notes for the app layer:
   *  - statements carry a local `stmtKey` (their 'YYYY-MM'); the app must
   *    remap it to the real statement id when inserting.
   *  - accountId on statements is null; the app fills it after inserting
   *    the account.
   *  - reportedStartMinor/EndMinor are null, so Engine.reconcile() reports
   *    balanceCheck 'no_baseline' -> the app maps this to 'unavailable'.
   *    Honest: synthetic data has no real balances to check against.
   *  - Every record is tagged sample:true + sampleBatch 'v2-sample' so the
   *    whole batch is findable and removable.
   */
  Engine.sampleData = function (seed, baseMonth) {
    var rnd = Engine._mulberry32(seed);
    var ym = /^\d{4}-(0[1-9]|1[0-2])$/.test(String(baseMonth || ''))
      ? String(baseMonth) : Engine._currentMonth();
    var m0 = Engine._prevMonth(Engine._prevMonth(ym));
    var m1 = Engine._prevMonth(ym);
    var months = [m0, m1, ym];

    var cats = Engine.defaultCategories().map(function (c) { return c.id; });
    var pickCat = function () { return cats[Math.floor(rnd() * cats.length)]; };
    var pickMerchant = function (cat) {
      var list = SAMPLE_MERCHANTS[cat] || SAMPLE_MERCHANTS.other;
      return list[Math.floor(rnd() * list.length)];
    };
    var dollarsTextMinor = function (minor) {
      var m = minor < 0 ? -minor : minor;
      return Math.floor(m / 100) + '.' + ('0' + (m % 100)).slice(-2);
    };

    var statements = months.map(function (m) {
      return {
        stmtKey: m,
        accountId: null,
        sourceFileId: null,
        periodStart: m + '-01',
        periodEnd: Engine._monthLastDay(m),
        scopeLabel: 'Sample data \u00B7 ' + m,
        reportedStartMinor: null,
        reportedEndMinor: null,
        createdAt: 0,
        sample: true,
        sampleBatch: SAMPLE_BATCH
      };
    });

    var txns = [];
    for (var mi = 0; mi < months.length; mi++) {
      var m = months[mi];
      var daysInMonth = +Engine._monthLastDay(m).slice(8, 10);
      var count = 26 + mi + Math.floor(rnd() * 7); // 26-34 per month
      var monthTxns = [];
      for (var i = 0; i < count; i++) {
        var r = rnd();
        var cat = pickCat();
        var merchant = pickMerchant(cat);
        var kind, amountMinor;
        if (r < 0.08) { // a few refunds (positive per CSV convention)
          kind = 'refund';
          amountMinor = 500 + Math.floor(rnd() * 4501); // $5.00-$50.00
        } else {        // mostly purchases (negative per CSV convention)
          kind = 'purchase';
          amountMinor = -(300 + Math.floor(rnd() * 17701)); // -$3.00 to -$180.00
        }
        var day = 1 + Math.floor(rnd() * daysInMonth);
        var dd = day < 10 ? '0' + day : String(day);
        var date = m + '-' + dd;
        monthTxns.push({
          stmtKey: m,
          statementId: null,
          rowIndex: 0, // assigned after sorting
          date: date,
          rawDateText: date,
          merchantRaw: merchant,
          rawDescription: merchant,
          rawAmountText: dollarsTextMinor(amountMinor),
          rawCurrency: 'CAD',
          amountMinor: amountMinor,
          spendAmountMinor: amountMinor < 0 ? -amountMinor : amountMinor,
          currency: 'CAD',
          kind: kind,
          kindConfidence: 'high',
          kindReason: 'sample data',
          classificationSource: 'sample',
          category: cat,
          excluded: 0,
          confidence: 'high',
          status: 'new',
          sample: true,
          sampleBatch: SAMPLE_BATCH
        });
      }
      // One payment per month (negative: money into the card account, per
      // the card-statement convention used by the generic parser).
      var payDay = 1 + Math.floor(rnd() * daysInMonth);
      var pdd = payDay < 10 ? '0' + payDay : String(payDay);
      var pdate = m + '-' + pdd;
      var payMinor = -(20000 + Math.floor(rnd() * 60001)); // -$200.00 to -$800.00
      monthTxns.push({
        stmtKey: m,
        statementId: null,
        rowIndex: 0,
        date: pdate,
        rawDateText: pdate,
        merchantRaw: 'ONLINE PAYMENT',
        rawDescription: 'ONLINE PAYMENT',
        rawAmountText: dollarsTextMinor(payMinor),
        rawCurrency: 'CAD',
        amountMinor: payMinor,
        spendAmountMinor: -payMinor,
        currency: 'CAD',
        kind: 'payment',
        kindConfidence: 'high',
        kindReason: 'sample data',
        classificationSource: 'sample',
        category: 'other',
        excluded: 0,
        confidence: 'high',
        status: 'new',
        sample: true,
        sampleBatch: SAMPLE_BATCH
      });
      monthTxns.sort(function (a, b) {
        if (a.date < b.date) return -1;
        if (a.date > b.date) return 1;
        return a.merchantRaw < b.merchantRaw ? -1 : 1;
      });
      for (var k = 0; k < monthTxns.length; k++) monthTxns[k].rowIndex = k;
      txns = txns.concat(monthTxns);
    }

    return {
      account: {
        name: 'Sample Bank',
        type: 'sample',
        createdAt: 0,
        sample: true,
        sampleBatch: SAMPLE_BATCH
      },
      statements: statements,
      txns: txns
    };
  };

  /* Expose global (ES2019-safe global lookup). */
  var _g = (typeof window !== 'undefined') ? window
         : (typeof global !== 'undefined') ? global
         : this;
  _g.Engine = Engine;
})();
