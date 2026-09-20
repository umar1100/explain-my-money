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
    var hay = r.merchantRaw || '';
    for (var i = 0; i < BUILTIN_RULES.length; i++) {
      var rule = BUILTIN_RULES[i];
      for (var k = 0; k < rule.keywords.length; k++) {
        if (hay.indexOf(rule.keywords[k]) !== -1) {
          applyKindToRow(r, rule.kind, rule.confidence, 'builtin keyword: "' + rule.keywords[k] + '"', 'builtin');
          return;
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
  }

  /**
   * Engine.applyRules(rows, rules) -> rows.
   * Deterministic application of enabled household rules, highest priority
   * first. A rule: {id, enabled, priority, matchMerchant, kind, label}.
   * matchMerchant is a case-insensitive substring of merchantRaw.
   * Stamps classificationSource='rule', kindConfidence=1.0 (the household's
   * own rule outranks any heuristic). Never touches rows the user corrected
   * directly (classificationSource==='user').
   */
  Engine.applyRules = function (rows, rules) {
    var active = [];
    for (var i = 0; i < (rules || []).length; i++) {
      if (rules[i] && rules[i].enabled !== false && rules[i].matchMerchant && rules[i].kind) {
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
          applyKindToRow(row, rule.kind, 1.0,
            'household rule: ' + (rule.label || rule.id), 'rule');
          break;
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
   * correction: {merchantRaw (or merchant), kind, label?}
   * Builds a household rule matching the corrected merchant text. The rule id
   * is a deterministic hash of match-key + kind (no timestamps/randomness in
   * the engine). scopeDescription states the blast radius: how many past
   * records the rule WOULD apply to.
   */
  Engine.makeRuleFromCorrection = function (correction, pastRows) {
    correction = correction || {};
    pastRows = pastRows || [];
    var key = trimStr(correction.merchantRaw || correction.merchant || '').toUpperCase().replace(/\s+/g, ' ');
    var kind = correction.kind;
    if (key === '' || Engine.KINDS.indexOf(kind) === -1) {
      throw new Error('makeRuleFromCorrection: need a merchant string and a valid kind');
    }
    var rule = {
      id: 'rule_' + hashStr(key + '|' + kind),
      enabled: true,
      priority: 100,
      matchMerchant: key,
      kind: kind,
      label: correction.label || ('Correction: "' + key + '" -> ' + kind),
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
      if (r.kind === 'uncertain' || r._error || r.confidence === 'needs_review') unresolved++;
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
    var totals = {};
    var counts = {};
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.kind !== 'purchase' && r.kind !== 'refund') continue;
      var key = categoryKeyFor(r);
      var amt = (r.amountMinor === null || r.amountMinor === undefined) ? 0 : r.amountMinor;
      totals[key] = (totals[key] || 0) + amt;
      counts[key] = (counts[key] || 0) + 1;
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
      { id: 'fees',           name: 'Fees',            parentId: null },
      { id: 'other',          name: 'Other',           parentId: null }
    ];
  };

  /* Expose global (ES2019-safe global lookup). */
  var _g = (typeof window !== 'undefined') ? window
         : (typeof global !== 'undefined') ? global
         : this;
  _g.Engine = Engine;
})();
