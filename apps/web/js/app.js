/* ============================================================================
 * Explain My Money — Gate 1 mobile web UI (workstream W2)
 * ----------------------------------------------------------------------------
 * Single-page, on-device app. HARD RULES:
 *   - No backend, no telemetry, no cloud, no CDN. No network calls for
 *     financial processing or storage (the only exceptions: optional
 *     user-approved BYO-key AI phrasing, and the opt-in online merchant
 *     lookup which sends merchant names only).
 *   - All data lives in IndexedDB via the Store contract (js/store.js).
 *   - All money math/formatting goes through the Engine contract (js/engine.js).
 *   - This file never calls fetch(), never builds a remote URL, never loads
 *     an external resource. Verified by grep: no "fetch(" anywhere.
 *
 * Contract (VERIFIED against web/js/engine.js + web/js/store.js, 2026-09-19):
 *   V1  Engine.parseCSV(text) -> {rows, errors}; rows are OBJECTS with
 *       {rawDateText, rawDescription, rawAmountText, rawCurrency} — column
 *       detection is the Engine's job. errors: [{row, reason}].
 *   V2  normalizeRows mutates in place, adds {date, amountMinor (int|null),
 *       currency, merchantRaw, _error, _errorReasons}. Amounts keep CSV sign.
 *   V3  classifyRows(rows, rules) sets {kind, kindConfidence, kindReason,
 *       classificationSource, spendAmountMinor, excluded (0|1), confidence}.
 *       Engine.KINDS is an ARRAY of kind ids.
 *   V4  applyRules(rows, rules) wants flat rules {id, enabled, priority,
 *       matchMerchant, kind, label}; skips rows with
 *       classificationSource==='user'. We store householdRules FLAT in that
 *       shape (+ ruleType/scopeDescription/appMatch metadata).
 *   V5  makeRuleFromCorrection({merchantRaw|merchant, kind, label?}, pastRows)
 *       -> {rule, scopeDescription}; kind-only (throws otherwise).
 *   V6  scoreReceiptMatch(txn, receipt) reads receipt.{amountMinor, date,
 *       merchantRaw|description}; returns [score, reasons]; acceptance
 *       threshold Engine.RECEIPT_MATCH_THRESHOLD (0.85).
 *   V7  reconcile(rows, reported=null) -> {grossPurchasesMinor,
 *       refundsTotalMinor, refundCount, excludedTotalMinor, netSpendMinor,
 *       unresolvedCount, signedRowsSumMinor, balanceCheck, gapMinor}. SIGNED
 *       minor units; excluded counts only when excluded===1. reported:
 *       {startMinor, endMinor}. Card-account equation: the Engine treats
 *       purchases as + and refunds/payments as −, so
 *       (reported.end − reported.start) == SUM(signedAmountMinor) within
 *       ±1 minor unit. reported comes from PDF account summaries and is
 *       persisted on the statement record (CSV imports have no baseline).
 *   V7b Parsers.parsePdf(arrayBuffer, pdfjsLib) -> {format, institution,
 *       templateId, rows, meta, unparsed[]}. On-device pdf.js extraction;
 *       rows carry {rawDateText, rawDescription, rawAmountText, rawCurrency,
 *       signedAmountMinor, dateInferred, section, pageNumber, ...}.
 *       Refuses to guess: any unparsed table line throws.
 *   V8  buildBriefing(...) -> facts {periodStart, periodEnd, scopeLabel,
 *       netSpendMinor, grossPurchasesMinor, refundsTotalMinor, categoryTotals,
 *       deltas[], topDrivers[], refundsSummary, unresolvedCount,
 *       receiptCoveragePct, evidenceTxnIds[], balanceCheck, gapMinor}.
 *       renderBriefingText applies an honesty rule (no final number while
 *       unresolved > 0). Receipt coverage counts txns with receiptId set —
 *       app.js stamps receiptId on confirmed matches.
 *   V9  Store: IndexedDB (localStorage fallback), keyPath 'id'. put() with an
 *       id upserts; without, it auto-increments. Field names follow the
 *       schema comment in store.js (txns.category, receipts.amountMinor /
 *       merchantRaw, auditEvents.timestamp, briefings.factsJson, ...).
 *       query(store, index, value) has indexes on txns(statementId,date,kind,
 *       status); sQuery() still falls back to all()+filter.
 *  Display: money ALWAYS via Engine.fmtMoney. Signed values are shown as-is
 *  on txn rows (they match the CSV); labeled spend MAGNITUDES (strip,
 *  headlines, answers) use spendAbs() = fmtMoney(|minor|) so "net spend"
 *  never reads "-$1,421.53".
 * ========================================================================== */
(function () {
'use strict';

/* ---------------- tiny DOM + string utils ---------------- */

function $(sel, root) { return (root || document).querySelector(sel); }
function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

/** Escape for HTML interpolation. */
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Yield to the UI thread (keeps the pipeline responsive). */
function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }

/** Short hash for display. */
function shortHash(h) { h = String(h || ''); return h.length > 12 ? h.slice(0, 12) + '…' : h; }

/* ---------------- sync SHA-256 (no WebCrypto dependency) ----------------
 * File hashes must work on file:// pages where crypto.subtle may be
 * unavailable (non-secure context). This compact implementation is
 * synchronous and dependency-free.
 *   sha256Hex(str)       — Input: JS string (UTF-8 encoded).
 *   sha256HexBytes(u8)   — Input: Uint8Array / byte array (e.g. a PDF).
 * Test vector: sha256Hex('abc') =
 *   ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
 */
function sha256OfBytes(bytes) {
  var K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  var l = bytes.length, bitLen = l * 8;
  var withPad = l + 1;
  while (withPad % 64 !== 56) withPad++;
  var buf = new Array(withPad + 8);
  for (var i = 0; i < l; i++) buf[i] = bytes[i] & 0xff;
  buf[l] = 0x80;
  for (i = l + 1; i < withPad; i++) buf[i] = 0;
  // 64-bit length, big-endian (high 32 bits assumed 0 for realistic inputs)
  for (i = 0; i < 4; i++) buf[withPad + i] = 0;
  buf[withPad + 4] = (bitLen >>> 24) & 0xff; buf[withPad + 5] = (bitLen >>> 16) & 0xff;
  buf[withPad + 6] = (bitLen >>> 8) & 0xff;  buf[withPad + 7] = bitLen & 0xff;

  var H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  var w = new Array(64);
  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }
  for (var b = 0; b < buf.length; b += 64) {
    for (i = 0; i < 16; i++)
      w[i] = ((buf[b+i*4]<<24)|(buf[b+i*4+1]<<16)|(buf[b+i*4+2]<<8)|buf[b+i*4+3]) >>> 0;
    for (i = 16; i < 64; i++) {
      var s0 = rotr(w[i-15],7)^rotr(w[i-15],18)^(w[i-15]>>>3);
      var s1 = rotr(w[i-2],17)^rotr(w[i-2],19)^(w[i-2]>>>10);
      w[i] = (w[i-16]+s0+w[i-7]+s1) >>> 0;
    }
    var a=H[0],bb=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
    for (i = 0; i < 64; i++) {
      var S1=rotr(e,6)^rotr(e,11)^rotr(e,25), ch=(e&f)^(~e&g);
      var t1=(h+S1+ch+K[i]+w[i])>>>0;
      var S0=rotr(a,2)^rotr(a,13)^rotr(a,22), mj=(a&bb)^(a&c)^(bb&c);
      var t2=(S0+mj)>>>0;
      h=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=bb;bb=a;a=(t1+t2)>>>0;
    }
    H[0]=(H[0]+a)>>>0;H[1]=(H[1]+bb)>>>0;H[2]=(H[2]+c)>>>0;H[3]=(H[3]+d)>>>0;
    H[4]=(H[4]+e)>>>0;H[5]=(H[5]+f)>>>0;H[6]=(H[6]+g)>>>0;H[7]=(H[7]+h)>>>0;
  }
  var out='';
  for (i=0;i<8;i++){ var x=H[i]; for(var s=28;s>=0;s-=4) out+='0123456789abcdef'[(x>>>s)&0xf]; }
  return out;
}
function sha256Hex(str) {
  var bytes = unescape(encodeURIComponent(str)); // UTF-8
  var arr = new Array(bytes.length);
  for (var i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i) & 0xff;
  return sha256OfBytes(arr);
}
/** SHA-256 over raw bytes (ArrayBuffer view or plain byte array). */
function sha256HexBytes(u8) {
  var arr = new Array(u8.length);
  for (var i = 0; i < u8.length; i++) arr[i] = u8[i] & 0xff;
  return sha256OfBytes(arr);
}

/* ---------------- formatting (money ALWAYS via Engine) ---------------- */

/** Amount display: ALWAYS the Engine's formatter, no local fallback (contract). */
function money(minor) {
  return Engine.fmtMoney(minor);
}

/** ISO date -> "Aug 4, 2026". */
function fmtDate(iso) {
  if (!iso) return '—';
  var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso));
  if (!m) return String(iso);
  var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return months[+m[2] - 1] + ' ' + (+m[3]) + ', ' + m[1];
}

/** YYYY-MM label -> "August 2026". */
function fmtPeriod(ym) {
  var m = /^(\d{4})-(\d{2})/.exec(String(ym || ''));
  if (!m) return String(ym || '—');
  var months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return months[+m[2] - 1] + ' ' + m[1];
}

function prettify(s) {
  return String(s == null ? '' : s).replace(/_/g, ' ')
    .replace(/\b\w/g, function (c) { return c.toUpperCase(); });
}

/** Human label for a kind id; defensive about Engine.KINDS shape (A2). */
function kindLabel(kind) {
  var K = (typeof Engine !== 'undefined') ? Engine.KINDS : undefined;
  if (K) {
    if (Array.isArray(K)) {
      for (var i = 0; i < K.length; i++) {
        var k = K[i];
        if (k === kind) return prettify(k);
        if (k && typeof k === 'object' && (k.id === kind || k.kind === kind))
          return k.label || k.name || prettify(kind);
      }
    } else if (typeof K === 'object') {
      var v = K[kind];
      if (v != null) return (typeof v === 'string') ? v : (v.label || v.name || prettify(kind));
    }
  }
  return prettify(kind);
}

/** Download a file; works fully offline (Blob + object URL). */
function download(filename, content, mime) {
  var blob = (content instanceof Blob) ? content : new Blob([content], { type: mime || 'application/octet-stream' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1500);
}

function readFileAsText(file) {
  return new Promise(function (res, rej) {
    var fr = new FileReader();
    fr.onload = function () { res(String(fr.result || '')); };
    fr.onerror = function () { rej(new Error('Could not read file')); };
    fr.readAsText(file);
  });
}

function readFileAsArrayBuffer(file) {
  return new Promise(function (res, rej) {
    var fr = new FileReader();
    fr.onload = function () { res(fr.result); };
    fr.onerror = function () { rej(new Error('Could not read file')); };
    fr.readAsArrayBuffer(file);
  });
}

/* ---------------- on-device PDF engine (pdf.js, vendored) ----------------
 * pdf.min.js is loaded as a classic script; the worker file lives at
 * vendor/pdf.worker.min.js (same-origin, zero network at runtime).
 */
var _pdfWorkerReady = false;
function ensurePdfWorker() {
  if (_pdfWorkerReady) return;
  var lib = (typeof pdfjsLib !== 'undefined') ? pdfjsLib : null;
  if (!lib) throw new Error('PDF engine failed to load.');
  lib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  _pdfWorkerReady = true;
}

/* ---------------- Store helpers (defensive; A3, A7) ---------------- */

function audit(eventType, entityType, entityId, details) {
  try {
    var p = Store.logAudit(eventType, entityType, entityId, details || {});
    if (p && typeof p.then === 'function') p.catch(function () {});
  } catch (e) { /* audit must never break the UI */ }
}

async function sAll(store) {
  try { var r = await Store.all(store); return Array.isArray(r) ? r : []; }
  catch (e) { return []; }
}
async function sGet(store, id) {
  try { return await Store.get(store, id); } catch (e) { return null; }
}
/** Indexed query with an all()+filter fallback (A3). */
async function sQuery(store, index, value, field) {
  try {
    var r = await Store.query(store, index, value);
    if (Array.isArray(r)) return r;
  } catch (e) { /* fall through to scan */ }
  var all = await sAll(store);
  return all.filter(function (o) { return o && o[(field || index)] === value; });
}

/** Normalize a txn object to the fields the UI needs.
    W1 rows carry: date, amountMinor (int, SIGNED exactly as in the CSV —
    statement convention is purchases negative, refunds positive),
    currency, merchantRaw, kind, kindConfidence, kindReason,
    classificationSource, category, spendAmountMinor, excluded (0|1),
    confidence, status, receiptId, _error, _errorReasons. */
function nt(t) {
  t = t || {};
  var cat = (t.category !== null && t.category !== undefined && t.category !== '')
    ? t.category : (t.categoryId || null);
  return {
    id: t.id,
    statementId: t.statementId,
    rowIndex: t.rowIndex,
    desc: t.merchantRaw != null ? t.merchantRaw : (t.rawDescription || t.description || ''),
    rawDesc: t.rawDescription || t.raw_description || '',
    date: t.date || null,
    rawDate: t.rawDateText || '',
    amountMinor: (t.amountMinor !== null && t.amountMinor !== undefined) ? t.amountMinor : 0,
    rawAmount: t.rawAmountText || '',
    currency: t.currency || t.rawCurrency || '',
    kind: t.kind || 'uncertain',
    kindConfidence: (t.kindConfidence !== null && t.kindConfidence !== undefined) ? t.kindConfidence : null,
    kindReason: t.kindReason || '',
    classificationSource: t.classificationSource || '',
    spendAmountMinor: t.spendAmountMinor,
    excluded: !!t.excluded,
    confidence: t.confidence || '',
    status: t.status || 'new',
    category: cat,
    splits: t.splits || null, // per-category split shares [{category, amountMinor}] or null
    receiptId: t.receiptId || null,
    error: t._error ? (t._errorReasons || []).join('; ') : null,
    _error: !!t._error, // preserved: App.needsReview routes error rows to review
    _raw: t
  };
}

function signedAmount(t) {
  // Display convention: signed amounts exactly as the Engine reports them
  // (statement CSV convention: purchases negative, refunds positive).
  return nt(t).amountMinor;
}

/** Spend magnitudes for labeled display: "net spend" must never read "-$X".
    Underlying signed values are untouched; txn rows show signed amounts. */
function spendAbs(minor) {
  return Engine.fmtMoney(Math.abs(minor || 0));
}

/** Core merchant token used for app-level (category) rules, which the Engine
    does not build (makeRuleFromCorrection is kind-only). */
function merchantCore(merchantRaw) {
  return String(merchantRaw || '').toUpperCase().replace(/[#\d].*$/, '').trim().replace(/\s+/g, ' ') || 'MERCHANT';
}

/** Positive dollars text from integer minor units: 1234 -> "12.34".
    Integer math only — no floats anywhere near money. */
function dollarsText(minor) {
  var m = Math.abs(minor || 0);
  return Math.floor(m / 100) + '.' + ('0' + (m % 100)).slice(-2);
}

/** Smart category label: registered category name, else prettified key
    (split/briefing keys can be merchant fallbacks). */
function catLabelSmart(k) {
  for (var i = 0; i < App.categories.length; i++)
    if (String(App.categories[i].id) === String(k)) return App.categories[i].name;
  return prettify(String(k == null ? '' : k));
}

/* ============================================================================
 * App shell: state, boot, tab router, event delegation
 * ========================================================================== */

var App = {
  state: {
    tab: 'add',            // month | statement | ask | add | more
    statementId: null,     // currently viewed statement
    sfilter: 'review',     // statement tab filter
    txnId: null,           // open txn detail
    more: 'menu',          // more submenu: menu | rules | privacy | accounts
    onboardStep: null,     // onboarding overlay step: null | 0 | 1 | 2
    askQ: null,            // open ask answer id
    askText: '',
    receiptMsg: '',
    ruleOffer: null,       // pending "make this a rule" offer
    pending: null,         // pending import (file parsed, not yet committed)
    pipe: null,            // pipeline session
    dupPairs: null,        // duplicate candidate pairs for current statement
    txnShown: 60,          // statement list page size (Show more appends 60)
    txnSearch: '',         // statement search query (trimmed, lowercase)
    splitForm: null,       // open split form {txnId, rows:[{cat,amt}], error}
    manualMsg: '',         // one-shot notice on the manual-entry form
    dataRev: 0,            // bumped on every txn/rule mutation; invalidates dup cache
    planView: 'budgets',   // plan tab sub-view: budgets | goals | subs
    budgetMonth: null,     // chosen budget month 'YYYY-MM' (default: latest statement period)
    month: null,           // month tab focus 'YYYY-MM' (default: latest month with transactions)
    budgetEditId: null,    // budget id being edited (form prefill)
    goalEditId: null,      // goal id being edited (form prefill)
    planMsg: '',           // one-shot notice shown at the top of the Plan tab
    homeCat: null,         // Home "Where it went" drill-down category key
    txnRet: null           // txn detail return route ('homecat' or null)
  },
  categories: [],          // seeded from Engine.defaultCategories()
  ready: false,
  engineMissing: false,
  _renderSeq: 0            // increments per render; async views write only if current
};

var TABS = ['home', 'activity', 'add', 'more'];
var TAB_TITLES = { home: 'Home', activity: 'Activity', add: 'Add', more: 'More' };
/* Internal (non-tab) routes still exist for deep links: 'statement' renders
 * inside Activity, 'month' renders the Home summary, 'plan' is opened from
 * the Home plan-highlights card, 'ask' is folded into Home. The mapping
 * below keeps the right bottom tab highlighted for each internal route. */
var TAB_HIGHLIGHT = { statement: 'activity', month: 'home', plan: 'home', ask: 'home', homecat: 'home' };
function tabHighlight(t) { return TAB_HIGHLIGHT[t] || t; }

/** Natural-key preference read: null when unset. (ES2019: no ??, use ternary.) */
App.prefGet = async function (key) {
  var r = await sGet('prefs', key);
  return (r && r.value !== undefined && r.value !== null) ? r.value : null;
};
/** Natural-key preference write. Keys must be non-numeric strings (see Store.toKey). */
App.prefSet = async function (key, value) {
  await Store.put('prefs', { key: key, value: value });
};

App.boot = async function () {
  if (typeof Engine === 'undefined' || typeof Store === 'undefined') {
    App.engineMissing = true;
    $('#view').innerHTML =
      '<div class="banner bad"><strong>Engine not loaded.</strong><br>' +
      'This UI needs <span class="mono">js/engine.js</span> and <span class="mono">js/store.js</span> ' +
      '(built by the engine workstream) before it can run. Everything else on this page is inert.</div>';
    return;
  }
  try { await Store.open(); }
  catch (e) {
    var blocked = e && e.code === 'EMM_BLOCKED';
    $('#view').innerHTML = '<div class="banner bad">' +
      (blocked
        ? '<strong>Your money data is open in another tab.</strong><br>' +
          'Please close other Explain My Money tabs, then reload this page.'
        : '<strong>Storage failed to open:</strong> ' +
          esc(e && e.message || e) + '<br>Try serving over http (see web/README.md).') +
      '</div>';
    return;
  }
  await App.seedCategories();

  var statements = await sAll('statements');
  if (statements.length) {
    statements.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
    App.state.statementId = statements[0].id;
    App.state.tab = 'home';
  } else {
    App.state.tab = 'add'; // first-run flow starts at Add
  }
  App.ready = true;
  App.render();
  wireGlobalEvents();
  App.maybeOnboard();
};

/** Seed categories from Engine.defaultCategories() once. */
App.seedCategories = async function () {
  var existing = await sAll('categories');
  App.categories = existing;
  if (existing.length) return;
  var cats = [];
  try { cats = Engine.defaultCategories() || []; } catch (e) { cats = []; }
  var seen = {};
  for (var i = 0; i < cats.length; i++) {
    var c = cats[i] || {};
    var id = c.id != null ? String(c.id) : 'cat-' + i;
    if (seen[id]) continue; seen[id] = 1;
    var rec = { id: id, name: c.name || prettify(id), parentId: c.parentId != null ? c.parentId : null };
    try { await Store.put('categories', rec); } catch (e) { /* keep going */ }
    App.categories.push(rec);
  }
  if (!seen['uncategorized']) {
    var u = { id: 'uncategorized', name: 'Uncategorized', parentId: null };
    try { await Store.put('categories', u); } catch (e) {}
    App.categories.push(u);
  }
};

function catName(id) {
  for (var i = 0; i < App.categories.length; i++)
    if (String(App.categories[i].id) === String(id)) return App.categories[i].name;
  return 'Uncategorized';
}

/* ---------------- router ---------------- */

App.go = function (tab, params) {
  params = params || {};
  App.state.tab = tab;
  if (params.statementId !== undefined) App.state.statementId = params.statementId;
  if (params.sfilter) App.state.sfilter = params.sfilter;
  if (params.txnId !== undefined) App.state.txnId = params.txnId;
  if (params.homeCat !== undefined) App.state.homeCat = params.homeCat;
  if (params.txnRet !== undefined) App.state.txnRet = params.txnRet;
  if (params.more) App.state.more = params.more;
  if (params.month) App.state.month = params.month;
  if (params.askQ !== undefined) { App.state.askQ = params.askQ; App.state.askText = params.askText || ''; }
  App.render();
  var v = $('#view');
  if (v) { v.scrollTop = 0; window.scrollTo(0, 0); }
};

App.render = function () {
  if (!App.ready || App.engineMissing) return;
  $all('.tab').forEach(function (b) {
    b.classList.toggle('active', b.dataset.tab === tabHighlight(App.state.tab));
    if (b.dataset.tab === tabHighlight(App.state.tab)) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  var seq = ++App._renderSeq; // async views must check this before writing
  var v = $('#view');
  var s = App.state;
  if (s.tab === 'add') App.vAdd(v, seq);
  else if (s.tab === 'activity') { s.txnId != null ? App.vTxnDetail(v, seq) : App.vStatement(v, seq); }
  else if (s.tab === 'home') App.vHome(v, seq);
  else if (s.tab === 'more') App.vMore(v, seq);
  // Internal routes (deep links; no bottom-tab button of their own):
  else if (s.tab === 'statement') { s.txnId != null ? App.vTxnDetail(v, seq) : App.vStatement(v, seq); }
  else if (s.tab === 'month') App.vHome(v, seq);
  else if (s.tab === 'plan') App.vPlan(v, seq);
  else if (s.tab === 'ask') App.vHome(v, seq); // Ask is folded into Home
  else if (s.tab === 'homecat') App.vHomeCat(v, seq); // Home category drill-down
  else App.vHome(v, seq);
  App.renderOnboarding(); // fixed overlay; no-op unless App.state.onboardStep set
};

/** Guarded view write: drops stale async renders so rapid navigation can't
 *  clobber the current screen. */
App.show = function (v, seq, html) {
  if (v && seq === App._renderSeq) v.innerHTML = html;
};

/* ---------------- global event delegation ---------------- */

var eventsWired = false;
function wireGlobalEvents() {
  if (eventsWired) return; eventsWired = true;
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-action]');
    if (!el || el.disabled) return;
    var a = el.getAttribute('data-action');
    if (App.Actions[a]) { e.preventDefault(); App.Actions[a](el.dataset, el, e); }
  });
  document.addEventListener('change', function (e) {
    var el = e.target.closest('[data-change]');
    if (!el) return;
    var c = el.getAttribute('data-change');
    if (App.Changes[c]) App.Changes[c](el);
  });
  // Pipe view re-renders while running; keep file inputs working after render.
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', function () { App.pdfJobVisibility(); });
  }
}

App.Actions = {};
App.Changes = {};

/* Navigation actions shared by all views. */
App.Actions.tab = function (d) {
  if (d.tab !== App.state.tab) App.state.txnId = null; // leaving a txn detail
  App.go(d.tab);
};
App.Actions['goto'] = function (d) {
  if (d.addview) App.state.addView = d.addview; // Add sub-views: home|preview|processing|receipts
  App.go(d.tab, { statementId: d.sid || undefined, sfilter: d.filter || undefined,
                  txnId: ('txn' in d && d.txn != null) ? d.txn : null,
                  month: d.month || undefined,
                  more: d.more || undefined });
};
App.Actions['open-txn'] = function (d) { App.go('statement', { txnId: d.id, txnRet: d.ret || null }); };
App.Actions['txn-back'] = function () {
  var ret = App.state.txnRet;
  App.state.txnRet = null;
  if (ret === 'homecat') App.go('homecat', { txnId: null });
  else App.go('statement', { txnId: null });
};
App.Actions['back-more'] = function () { App.go('more', { more: 'menu' }); };

/* ============================================================================
 * Screen 1 — Add statements (import) + Screen 2 — receipts (optional)
 * ========================================================================== */

/* ---------- Add home ---------- */

App.vAdd = function (v, seq) {
  var s = App.state;
  if (s.addView === 'reading') return App.vPdfReading(v, seq);
  if (s.addView === 'processing' && s.pipe) return App.vProcessing(v, seq);
  if (s.addView === 'receipts') return App.vReceipts(v, seq);
  if (s.addView === 'manual') return App.vManualEntry(v, seq);
  if (s.addView === 'preview' && s.pending) return App.vImportPreview(v, seq);
  return App.vAddHome(v, seq);
};

App.vAddHome = async function (v, seq) {
  var files = await sAll('sourceFiles');
  var receipts = await sAll('receipts');
  var html = '<h1>Add</h1>';
  // Persistent job card: a PDF read keeps running (or stays resumable)
  // even when the user leaves the reading view for another tab.
  var job = App._pdfJob;
  if (job && !job.done && job.status !== 'done') {
    html += '<div class="card" id="pdfjob-card">' + App.pdfJobCardInner(job) + '</div>';
  }
  if (!files.length) {
    html += '<div class="banner info"><strong>Welcome — your data stays on this phone.</strong><br>' +
      'Import a credit-card statement (PDF or CSV) to build your first clean ledger. ' +
      'Nothing is uploaded, synced, or sent anywhere. Ever.</div>';
  }
  html +=
    '<div class="card">' +
      '<h3 style="margin-top:0">Import a statement</h3>' +
      '<p class="small">Pick a <strong>PDF</strong> statement or a <strong>.csv</strong> export from your bank or card issuer. ' +
      'We show you what was detected and the row count <em>before</em> anything is imported.</p>' +
      '<label class="filepick" for="stmt-file">' +
        '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 16V4m0 0 4 4m-4-4L8 8"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/></svg>' +
        'Choose statement file' +
      '</label>' +
      '<input type="file" id="stmt-file" class="hidden-file" accept=".pdf,.csv,text/csv,application/pdf" data-change="statement-file">' +
      '<details class="more"><summary>Supported formats</summary>' +
        '<ul class="list-plain">' +
          '<li><strong>Statement PDF</strong> — any bank or credit-card statement, read entirely on this device:<br>' +
          '<span class="small">Familiar layouts (President\u2019s Choice Financial Mastercard, CIBC Costco World Mastercard) ' +
          'are read exactly. Unfamiliar layouts get a careful heuristic read, and uncertain rows are flagged for your review. ' +
          'Large statements can take a minute on a phone \u2014 progress is shown while reading, and you can leave ' +
          'this tab: reading resumes where it stopped.</span></li>' +
          '<li><strong>CSV</strong> — supported now. Any column order; we detect date / description / amount columns.</li>' +
        '</ul>' +
      '</details>' +
    '</div>';

  html +=
    '<div class="card">' +
      '<div class="section-head"><h3 style="margin:0">Manual entry</h3><span class="pill dim">no file needed</span></div>' +
      '<p class="small">Add a single transaction by hand — a cash purchase, a refund, anything missing from your statements. ' +
      'It lands in a “Manual entries” statement and flows through Month, Statement, and Plan like any other row.</p>' +
      '<div class="btn-row"><button class="btn ghost" data-action="goto" data-tab="add" data-addview="manual">Add a manual transaction</button></div>' +
    '</div>';

  html +=
    '<div class="card">' +
      '<div class="section-head"><h3 style="margin:0">Receipts</h3><span class="pill dim">optional</span></div>' +
      '<p class="small">' + (receipts.length ? receipts.length + ' saved.' : 'None yet.') +
      ' Receipts help explain mixed-merchant trips (Costco, Amazon) and improve evidence quality. ' +
      'You can skip this entirely.</p>' +
      '<div class="btn-row">' +
        '<button class="btn ghost" data-action="goto" data-tab="add" data-addview="receipts">Add receipts</button>' +
      '</div>' +
    '</div>';

  if (files.length) {
    html += '<h2>Imported files</h2>';
    files.slice().sort(function (a, b) { return (b.importedAt || 0) - (a.importedAt || 0); }).forEach(function (f) {
      html += '<div class="card"><strong>' + esc(f.fileName || 'statement.csv') + '</strong><br>' +
        '<span class="small">' + (f.rowCount || 0) + ' rows · hash <span class="mono">' + esc(shortHash(f.sha256)) + '</span></span></div>';
    });
  }
  App.show(v, seq, html);
};

/* ---------- manual transaction entry ---------- */

App.vManualEntry = function (v, seq) {
  var n = new Date();
  var today = n.getFullYear() + '-' + ('0' + (n.getMonth() + 1)).slice(-2) + '-' + ('0' + n.getDate()).slice(-2);
  var html = '<button class="linklike" data-action="goto" data-tab="add" data-addview="home">← Back to Add</button>';
  html += '<h1>Manual transaction</h1>';
  if (App.state.manualMsg) { html += '<div class="banner warn">' + esc(App.state.manualMsg) + '</div>'; App.state.manualMsg = ''; }
  html += '<div class="card">' +
    '<label class="f" for="man-date">Date</label><input type="date" id="man-date" value="' + esc(today) + '">' +
    '<label class="f" for="man-desc">Description</label>' +
    '<input type="text" id="man-desc" autocomplete="off" placeholder="e.g. Farmers market">' +
    '<label class="f" for="man-amount">Amount (e.g. 12.34)</label>' +
    '<input type="text" id="man-amount" inputmode="decimal" autocomplete="off" placeholder="0.00">' +
    '<label class="f" for="man-cat">Category</label><select id="man-cat">' +
    App.categories.map(function (c) {
      return '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>';
    }).join('') + '</select>' +
    '<label class="f" for="man-kind">Type</label><select id="man-kind">' +
    '<option value="purchase">Purchase</option><option value="refund">Refund</option></select>' +
    '<div class="btn-row" style="margin-top:8px"><button class="btn" data-action="manual-save">Save transaction</button></div>' +
    '<p class="tiny" style="margin-bottom:0">Saved into a “Manual entries” statement for that month. ' +
    'Whole dollars and cents only — no commas. The statement has no reported balances, so no balance check runs on it.</p></div>';
  App.show(v, seq, html);
};

/** Find or create the "Manual entries" account + the per-month manual
 * statement. One statement per calendar month keeps the statement picker
 * tidy; the picker shows them as "Manual entries · YYYY-MM". */
App.manualStatementFor = async function (monthPrefix) {
  if (!/^\d{4}-\d{2}$/.test(monthPrefix || '')) throw new Error('manualStatementFor: need YYYY-MM');
  var y = +monthPrefix.slice(0, 4), m = +monthPrefix.slice(5, 7);
  var lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  var accounts = await sAll('accounts');
  var acct = accounts.filter(function (a) { return a.name === 'Manual entries' && a.type === 'manual'; })[0];
  if (!acct) {
    var acctId = await Store.put('accounts', { name: 'Manual entries', type: 'manual', createdAt: Date.now() });
    acct = await sGet('accounts', acctId);
  }
  var periodStart = monthPrefix + '-01';
  var stmts = await sAll('statements');
  var st = stmts.filter(function (s) {
    return s.manual === true && String(s.accountId) === String(acct.id) && s.periodStart === periodStart;
  })[0];
  if (!st) {
    var stId = await Store.put('statements', {
      accountId: acct.id, sourceFileId: null,
      periodStart: periodStart,
      periodEnd: monthPrefix + '-' + ('0' + lastDay).slice(-2),
      reportedStartMinor: null, reportedEndMinor: null,
      manual: true, createdAt: Date.now(),
      periodLabel: monthPrefix, scopeLabel: 'Manual entries · ' + monthPrefix,
      rowCount: 0
    });
    st = await sGet('statements', stId);
  }
  return st;
};

App.Actions['manual-save'] = async function () {
  var fail = function (msg) { App.state.manualMsg = msg; App.render(); };
  var date = $('#man-date') ? $('#man-date').value : '';
  var desc = $('#man-desc') ? $('#man-desc').value.trim() : '';
  var raw = $('#man-amount') ? $('#man-amount').value.trim() : '';
  var cat = $('#man-cat') ? $('#man-cat').value : '';
  var kind = $('#man-kind') ? $('#man-kind').value : 'purchase';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return fail('Pick a date.');
  if (!desc) return fail('Enter a description.');
  if (!cat) return fail('Choose a category.');
  if (kind !== 'purchase' && kind !== 'refund') kind = 'purchase';
  var minor = App.parseDollarsToMinor(raw);
  if (minor === null || minor <= 0)
    return fail('Enter a valid amount like 12.34 (digits and an optional decimal point — no commas, no negatives).');
  var st;
  try { st = await App.manualStatementFor(date.slice(0, 7)); }
  catch (e) { return fail('Could not prepare the manual statement: ' + (e.message || e)); }
  var existing = await sQuery('txns', 'statementId', st.id);
  // Stored shape mirrors commitPipeline: CSV sign convention (purchases
  // negative, refunds positive); spendAmountMinor is the spend magnitude.
  var id = await Store.put('txns', {
    statementId: st.id, manual: true, date: date,
    merchantRaw: desc.toUpperCase().replace(/\s+/g, ' ').trim(),
    rawDescription: desc, rawDateText: date, rawAmountText: raw,
    amountMinor: kind === 'purchase' ? -minor : minor,
    kind: kind, category: cat, spendAmountMinor: minor,
    currency: 'CAD', excluded: 0, status: 'new', classificationSource: 'manual',
    rowIndex: existing.length, createdAt: Date.now()
  });
  audit('txn.manual_added', 'txn', id,
    { statementId: st.id, kind: kind, amountMinor: minor, category: cat, date: date });
  App.state.manualMsg = '';
  App.state.addView = 'home'; // next visit to Add starts at home, not this form
  App.bumpDataRev();
  App.go('statement', { statementId: st.id });
};

/* ---------- file chosen -> parse + preview ---------- */

App.Changes['statement-file'] = async function (input) {
  var file = input.files && input.files[0];
  if (!file) return;
  var v = $('#view');
  v.innerHTML = '<div class="empty"><div class="spin" style="margin:0 auto 12px"></div>Reading file…</div>';
  var isPdf = /\.pdf$/i.test(file.name || '');

  if (isPdf) { App.runPdfJob(input, file); return; }

  var text;
  try { text = await readFileAsText(file); }
  catch (e) { v.innerHTML = '<div class="banner bad">Could not read that file.</div>'; return; }

  var parsed;
  try { parsed = Engine.parseCSV(text); }
  catch (e) {
    v.innerHTML = '<div class="banner bad"><strong>Could not parse CSV:</strong> ' + esc(e.message || e) + '</div>';
    return;
  }
  // V1: parseCSV owns column detection; rows are objects with
  // {rawDateText, rawDescription, rawAmountText, rawCurrency}.
  var rows = (parsed && parsed.rows) || [];
  var errors = (parsed && parsed.errors) || [];
  if (!rows.length) {
    v.innerHTML = '<div class="banner warn">No data rows found in this file. Check that it is a statement CSV with a header row.</div>';
    return;
  }
  var hash = sha256Hex(text);
  var dup = (await sAll('sourceFiles')).some(function (f) { return f.sha256 === hash; });

  App.state.pending = {
    fileName: file.name, fileSize: file.size, text: text,
    rows: rows, errors: errors, hash: hash, duplicate: dup,
    fileKind: 'csv', formatLabel: 'Generic CSV', templateId: null, pdfMeta: null
  };
  App.state.addView = 'preview';
  App.render();
  input.value = '';
};

/* ---------- PDF statement chosen -> on-device parse + preview ---------- */

/* ---------- resumable PDF import job ----------
 * Why this exists: on iPhone, leaving the tab mid-read suspends the page
 * and can kill the pdf.js worker, so a single long await chain hangs
 * forever with no error. Instead we read page by page, persist partial
 * progress to the on-device pdfCache after every page, and can resume
 * from the last completed page — after backgrounding, a stall, or even
 * a full app restart (re-pick the file; the hash matches the cache).
 * A completed parse is cached too, so importing the same file twice is
 * instant. All state lives on-device; nothing is uploaded.
 *
 * Job lifecycle: runPdfJob creates the job -> pdfJobLoop runs in the
 * background (never awaited by UI code) -> completion sets pending and
 * goes to the preview; errors/cancel keep the partial cache for resume.
 * The loop never writes into a view element directly: progress ticks
 * update #pdfjob-prog in place when present; structural transitions set
 * job._needsRender and call App.render() (guarded by the seq check).
 */
App._pdfJob = null; // active/cancelled/errored job, or null

/** Per-page watchdog: abandon a page the pdf.js worker never finishes. */
App.PDF_PAGE_TIMEOUT_MS = 90000;
/** Watchdog tick granularity (also lets a recover() abandon in-flight work). */
App.PDF_WATCHDOG_TICK_MS = 1000;
/** Stall threshold for the background-return check. */
App.PDF_STALL_MS = 30000;
/** Max pdfCache entries; oldest evicted first. */
App.PDF_CACHE_MAX = 5;

App.pdfJobYield = function () {
  return new Promise(function (res) { setTimeout(res, 0); });
};

App.pdfJobWaitResume = function (job) {
  return new Promise(function (res) { job._resumeResolve = res; });
};

App.pdfJobNotifyResume = function (job) {
  var r = job._resumeResolve;
  job._resumeResolve = null;
  if (typeof r === 'function') { try { r(); } catch (e) {} }
};

/** Screen wake lock so iOS doesn't sleep the display mid-read. Best-effort. */
App.pdfJobWakeLock = function (job) {
  try {
    var nav = (typeof navigator !== 'undefined') ? navigator : null;
    if (!nav || !nav.wakeLock || typeof nav.wakeLock.request !== 'function') return;
    if (job.wakeLock && typeof job.wakeLock.release === 'function') {
      try { job.wakeLock.release(); } catch (e) {}
    }
    job.wakeLock = null;
    nav.wakeLock.request('screen').then(function (wl) {
      job.wakeLock = wl;
      if (wl && typeof wl.addEventListener === 'function') {
        wl.addEventListener('release', function () { if (job.wakeLock === wl) job.wakeLock = null; });
      }
    }, function () { /* denied or unavailable — reading still works */ });
  } catch (e) { /* never break the job for a lock */ }
};

App.pdfJobReleaseWakeLock = function (job) {
  try {
    if (job.wakeLock && typeof job.wakeLock.release === 'function') job.wakeLock.release();
  } catch (e) {}
  job.wakeLock = null;
};

/** Rolling-average ETA text for the progress display. Pure-ish. */
App.pdfJobEtaText = function (job) {
  var remaining = (job.total || 0) - (job.pagesDone || 0);
  if (!job.total || remaining <= 0) return '';
  var secs = Parsers.etaSeconds(job.pageTimes, remaining);
  if (secs === null) return '';
  if (secs < 3) return 'almost done…';
  return 'about ' + secs + 's left';
};

App.pdfJobStatusText = function (job) {
  if (job.status === 'parsing') return 'All ' + job.total + ' pages read — building your statement…';
  if (job.status === 'paused') {
    return 'Paused — ' + (job.wasPausedByHidden
      ? 'this tab was put in the background. It resumes when you return.'
      : 'tap Resume to continue.') + ' Page ' + job.pagesDone + ' of ' + job.total + ' is saved.';
  }
  var base = 'Reading page ' + Math.min(job.pagesDone + 1, job.total || 1) + ' of ' + (job.total || '…') + ' on this device…';
  var eta = App.pdfJobEtaText(job);
  return base + (eta ? ' ' + eta : '') + (job.resumed ? ' (resumed where it stopped)' : '');
};

/** Shared status card inner HTML for the reading view + Add-home job card. */
App.pdfJobCardInner = function (job) {
  var pct = job.total ? Math.round(100 * job.pagesDone / job.total) : 0;
  var head = '<strong>' + esc(job.fileName || 'statement.pdf') + '</strong><br>';
  if (job.status === 'error') {
    return head + '<div class="banner bad" style="margin:8px 0"><strong>Reading paused:</strong> ' +
      esc(job.error || 'unknown error') + '</div>' +
      '<div class="btn-row"><button class="btn" data-action="pdfjob-retry">Retry reading</button>' +
      '<button class="btn ghost" data-action="pdfjob-dismiss">Dismiss</button></div>';
  }
  if (job.status === 'cancelled') {
    return head + '<p class="small">Cancelled — progress through page ' + job.pagesDone + ' of ' + job.total +
      ' is saved on this device. Pick the file again to resume.</p>' +
      '<div class="btn-row"><button class="btn ghost" data-action="pdfjob-dismiss">Dismiss</button></div>';
  }
  var bar = '<div class="pbar" aria-hidden="true"><div class="pfill" id="pdfjob-bar" style="width:' + pct + '%"></div></div>';
  var prog = '<span id="pdfjob-prog">' + esc(App.pdfJobStatusText(job)) + '</span>';
  if (job.status === 'paused') {
    return head + '<p class="small">' + prog + '</p>' + bar +
      '<div class="btn-row"><button class="btn" data-action="pdfjob-resume">Resume</button>' +
      '<button class="btn ghost" data-action="pdfjob-cancel">Cancel</button></div>';
  }
  return head + '<div class="empty" style="padding:12px"><div class="spin" style="margin:0 auto 12px"></div>' +
    prog + '</div>' + bar +
    '<div class="btn-row"><button class="btn ghost" data-action="pdfjob-pause">Pause</button>' +
    '<button class="btn ghost" data-action="pdfjob-cancel">Cancel</button></div>';
};

/** In-place progress update; full re-render only on structural transitions. */
App.pdfJobRender = function (job) {
  if (typeof document !== 'undefined' && document.getElementById) {
    var el = document.getElementById('pdfjob-prog');
    if (el) el.textContent = App.pdfJobStatusText(job);
    var bar = document.getElementById('pdfjob-bar');
    if (bar && job.total) bar.style.width = Math.round(100 * job.pagesDone / job.total) + '%';
  }
  if (job._needsRender) {
    job._needsRender = false;
    if (App.state && App.state.tab === 'add') App.render();
  }
};

/** Persist partial/complete progress to the on-device pdfCache. Best-effort. */
App.pdfCacheSave = async function (job, status, result) {
  var rec = {
    hash: job.key,
    fileName: job.fileName,
    fileSize: job.fileSize,
    pagesTotal: job.total,
    pagesDone: job.pagesDone,
    fragsCompact: status === 'complete' ? [] : Parsers.compactFrags(job.frags),
    status: status,
    result: status === 'complete' ? (result || null) : null,
    updatedAt: Date.now()
  };
  try { await Store.put('pdfCache', rec); } catch (e) { /* cache is best-effort */ }
};

/** Evict oldest pdfCache entries beyond App.PDF_CACHE_MAX. Best-effort. */
App.pdfCacheEvict = async function () {
  try {
    var all = await Store.all('pdfCache');
    if (!all || all.length <= App.PDF_CACHE_MAX) return;
    all.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    for (var i = App.PDF_CACHE_MAX; i < all.length; i++) {
      try { await Store.delete('pdfCache', all[i].hash); } catch (e) {}
    }
  } catch (e) {}
};

/** Open a fresh pdf.js document from the job's pristine buffer copy. */
App.pdfJobOpenDoc = async function (job, lib) {
  var data = new Uint8Array(job.buf); // copy: pdf.js may detach the buffer we hand it
  var pdf = await lib.getDocument({ data: data, useWorkerFetch: false, isEvalSupported: false }).promise;
  return pdf;
};

/**
 * Extract one page with a watchdog. Rejects with __abandoned when the job
 * was recovered (gen bumped) or cancelled mid-page, or __timeout when the
 * worker stalls. The caller, not this function, decides retry policy.
 */
App.pdfJobExtractPage = function (job, p) {
  var gen = job.gen;
  var timeoutMs = App.PDF_PAGE_TIMEOUT_MS;
  var tickMs = App.PDF_WATCHDOG_TICK_MS;
  var start = Date.now();
  return new Promise(function (resolve, reject) {
    var settled = false;
    function finish(fn, val) { if (!settled) { settled = true; clearInterval(timer); fn(val); } }
    function abandoned() { var e = new Error('abandoned'); e.__abandoned = true; return e; }
    var timer = setInterval(function () {
      if (job.cancelled || job.gen !== gen) finish(reject, abandoned());
      else if (Date.now() - start > timeoutMs) finish(reject, new Error('__timeout__'));
    }, tickMs);
    var pdf = job.pdf;
    if (!pdf) { finish(reject, abandoned()); return; }
    Parsers.collectPageItems(pdf, p).then(
      function (frags) { finish(resolve, frags); },
      function (err) { finish(reject, err || new Error('page extraction failed')); }
    );
  });
};

/** The background page loop. Never throws to callers; errors land on the job. */
App.pdfJobLoop = async function (job, libOverride) {
  /* NOTE: the second parameter must NOT be named pdfjsLib — that would shadow
   * the global pdf.js handle and break every call that omits the override
   * (retry, visibility auto-resume, runPdfJob), yielding "engine failed to load". */
  var lib = libOverride ||
    ((typeof window !== 'undefined' && window.pdfjsLib) ? window.pdfjsLib :
      ((typeof pdfjsLib !== 'undefined') ? pdfjsLib : null));
  try {
    if (!lib || typeof lib.getDocument !== 'function') throw new Error('PDF engine failed to load.');
    App.pdfJobWakeLock(job);
    job.pdf = await App.pdfJobOpenDoc(job, lib);
    job.total = job.pdf.numPages;
    job.lastProgressAt = Date.now();
    await App.pdfCacheSave(job, 'partial');
    App.pdfJobRender(job);
    while (job.pagesDone < job.total) {
      if (job.cancelled) break;
      while (job.paused && !job.cancelled) await App.pdfJobWaitResume(job);
      if (job.cancelled) break;
      if (!job.pdf) job.pdf = await App.pdfJobOpenDoc(job, lib);
      var p = job.pagesDone + 1;
      var gen = job.gen;
      var t0 = Date.now();
      var frags = null;
      try {
        frags = await App.pdfJobExtractPage(job, p);
      } catch (e) {
        if (job.cancelled) break;
        if (e && e.__abandoned) continue; // recovered mid-page; doc re-opens at loop top
        job.stallCount = (job.stallCount || 0) + 1;
        if (job.stallCount > 1) {
          throw new Error('Could not read page ' + p + ' of ' + job.fileName +
            ' (the reader stalled). Progress through page ' + job.pagesDone +
            ' of ' + job.total + ' is saved on this device — tap Retry to resume.');
        }
        // One retry with a fresh document before giving up on the page.
        try { if (job.pdf && job.pdf.destroy) await job.pdf.destroy(); } catch (e2) {}
        job.pdf = null;
        continue;
      }
      if (job.gen !== gen) continue; // stale success after a recover — retry the page
      var dt = Date.now() - t0;
      job.pageTimes.push(dt);
      if (job.pageTimes.length > 5) job.pageTimes.shift();
      for (var i = 0; i < frags.length; i++) job.frags.push(frags[i]);
      job.pagesDone = p;
      job.stallCount = 0;
      job.lastProgressAt = Date.now();
      await App.pdfCacheSave(job, 'partial');
      App.pdfJobRender(job);
      await App.pdfJobYield();
    }
    if (job.cancelled) {
      // Persist whatever we have — even an empty partial when cancelled before
      // page 1 — so a re-import never silently drops the attempt from history.
      await App.pdfCacheSave(job, 'partial');
      App.pdfJobFinish(job, 'cancelled');
      return;
    }
    job.status = 'parsing';
    job._needsRender = true;
    App.pdfJobRender(job);
    var result = await Parsers.parseFrags(job.frags);
    var rows = (result && result.rows) || [];
    if (!rows.length) throw new Error('No transaction rows found in this PDF.');
    await App.pdfCacheSave(job, 'complete', result);
    App.pdfCacheEvict();
    App.pdfJobShowPreview(job, result);
    App.pdfJobFinish(job, 'done');
  } catch (e) {
    job.error = (e && e.message) || String(e);
    App.pdfJobFinish(job, 'error');
  }
};

/** Terminal bookkeeping. 'done' clears the job; error/cancel keep it for Retry/Dismiss. */
App.pdfJobFinish = function (job, how) {
  job.done = true;
  job.status = how;
  App.pdfJobReleaseWakeLock(job);
  App.pdfJobNotifyResume(job);
  var pdf = job.pdf; job.pdf = null;
  if (pdf && typeof pdf.destroy === 'function') { try { pdf.destroy(); } catch (e) {} }
  if (how === 'done') App._pdfJob = null;
  else { job._needsRender = true; App.pdfJobRender(job); }
};

/** Destroy the hung document and let the loop re-open it; abandon in-flight work. */
App.pdfJobRecover = async function (job) {
  job.gen++;
  job.paused = false;
  job.wasPausedByHidden = false;
  job.manuallyPaused = false;
  job.status = 'reading';
  try { if (job.pdf && typeof job.pdf.destroy === 'function') await job.pdf.destroy(); } catch (e) {}
  job.pdf = null;
  job.lastProgressAt = Date.now();
  App.pdfJobNotifyResume(job);
  job._needsRender = true;
  App.pdfJobRender(job);
};

/** visibilitychange: pause when hidden; on return, resume or recover. */
App.pdfJobVisibility = function () {
  var job = App._pdfJob;
  if (!job || job.done || job.cancelled) return;
  if (typeof document === 'undefined') return;
  if (document.hidden) {
    if (job.status === 'reading') {
      job.paused = true;
      job.wasPausedByHidden = true;
      job.status = 'paused'; // card + text reflect the background pause
      job._needsRender = true;
      App.pdfJobRender(job);
    }
    return;
  }
  // Visible again.
  App.pdfJobWakeLock(job);
  if (job.manuallyPaused) return; // user paused it themselves — wait for Resume
  if (job.wasPausedByHidden) {
    // While hidden-paused the status is 'paused'; a stall means iOS likely
    // killed the reader, so re-open the document and resume from the cache.
    var stalled = Date.now() - job.lastProgressAt > App.PDF_STALL_MS;
    if (stalled) App.pdfJobRecover(job);
    else {
      job.wasPausedByHidden = false;
      job.paused = false;
      job.status = 'reading';
      job.lastProgressAt = Date.now();
      App.pdfJobNotifyResume(job);
      job._needsRender = true;
      App.pdfJobRender(job);
    }
  }
};

/** Build the import preview from a parse result (fresh or cached). */
App.pdfJobShowPreview = async function (jobLike, result) {
  var rows = (result && result.rows) || [];
  var hash = jobLike.hash;
  var dup = false;
  try { dup = (await sAll('sourceFiles')).some(function (f) { return f.sha256 === hash; }); } catch (e) {}
  var isGenericPdf = result.templateId === 'generic_statement_v1';
  App.state.pending = {
    fileName: jobLike.fileName, fileSize: jobLike.fileSize, text: null,
    rows: rows, errors: [], hash: hash, duplicate: dup,
    fileKind: 'pdf',
    formatLabel: isGenericPdf ? 'Generic statement (heuristic read)' : result.institution + ' statement',
    templateId: result.templateId, pdfMeta: result.meta || null,
    pdfWarnings: result.warnings || []
  };
  App.state.addView = 'preview';
  App.render();
};

/** Entry point from the file picker. Replaces the old fire-and-forget handlePdfFile. */
App.runPdfJob = async function (input, file) {
  if (input) input.value = '';
  var active = App._pdfJob;
  if (active && !active.done && (active.status === 'reading' || active.status === 'parsing' || active.status === 'paused')) {
    // A read is already in flight — show it instead of starting a second one.
    App.state.tab = 'add';
    App.state.addView = 'reading';
    App.render();
    return;
  }
  var buf;
  try { buf = await readFileAsArrayBuffer(file); }
  catch (e) {
    App._pdfJob = null;
    App.state.pdfJobError = 'Could not read that file.';
    App.state.tab = 'add';
    App.state.addView = 'reading';
    App.render();
    return;
  }
  var u8 = new Uint8Array(buf);
  var hash = sha256HexBytes(u8);
  var key = 'pdfjob:' + hash;
  var cached = null;
  try { cached = await Store.get('pdfCache', key); } catch (e) { cached = null; }
  if (cached && cached.status === 'complete' && cached.fileSize === file.size &&
      cached.result && cached.result.rows && cached.result.rows.length) {
    // Instant: this exact file was fully read before. The preview still
    // runs the normal duplicate-file guard via sourceFiles.
    App.pdfJobShowPreview({ fileName: file.name, fileSize: file.size, hash: hash }, cached.result);
    return;
  }
  var job = {
    key: key, hash: hash, fileName: file.name, fileSize: file.size,
    buf: u8.slice(0), // pristine copy; pdf.js may detach the buffer we hand it
    total: 0, pagesDone: 0, frags: [], pageTimes: [],
    status: 'reading', paused: false, manuallyPaused: false, wasPausedByHidden: false,
    resumed: false, cancelled: false, done: false, error: null,
    gen: 0, stallCount: 0, lastProgressAt: Date.now(),
    wakeLock: null, pdf: null, _resumeResolve: null, _needsRender: false
  };
  if (cached && cached.status === 'partial' && cached.fileSize === file.size &&
      (cached.pagesTotal || 0) > 0 && (cached.pagesDone || 0) > 0 &&
      cached.fragsCompact && cached.fragsCompact.length) {
    job.frags = Parsers.rehydrateFrags(cached.fragsCompact);
    job.pagesDone = cached.pagesDone;
    job.total = cached.pagesTotal;
    job.resumed = true;
  }
  App._pdfJob = job;
  App.state.pdfJobError = '';
  App.state.tab = 'add';
  App.state.addView = 'reading';
  App.render();
  App.pdfJobLoop(job); // background; all errors land on the job, never throw here
};

/* Job control actions (buttons in the reading view + Add-home job card). */
App.Actions['pdfjob-pause'] = function () {
  var job = App._pdfJob;
  if (!job || job.done || job.cancelled) return;
  job.paused = true;
  job.manuallyPaused = true;
  job.status = 'paused'; // card swaps Pause -> Resume, text explains the state
  job._needsRender = true;
  App.pdfJobRender(job);
};
App.Actions['pdfjob-resume'] = function () {
  var job = App._pdfJob;
  if (!job || job.done || job.cancelled) return;
  job.paused = false;
  job.manuallyPaused = false;
  job.wasPausedByHidden = false;
  job.status = 'reading';
  job.lastProgressAt = Date.now(); // a long pause is not a stall
  App.pdfJobWakeLock(job);
  App.pdfJobNotifyResume(job);
  job._needsRender = true;
  App.pdfJobRender(job);
};
App.Actions['pdfjob-cancel'] = function () {
  var job = App._pdfJob;
  if (!job || job.done || job.cancelled) return;
  job.cancelled = true;
  job.paused = false;
  job.manuallyPaused = false;
  App.pdfJobNotifyResume(job);
  // The loop breaks, keeps the partial cache, and finishes as cancelled.
};
App.Actions['pdfjob-retry'] = function () {
  var job = App._pdfJob;
  if (!job || job.status !== 'error') return;
  job.error = null;
  job.cancelled = false;
  job.done = false;
  job.paused = false;
  job.manuallyPaused = false;
  job.wasPausedByHidden = false;
  job.stallCount = 0;
  job.status = 'reading';
  App.state.tab = 'add';
  App.state.addView = 'reading';
  App.render();
  App.pdfJobLoop(job);
};
App.Actions['pdfjob-dismiss'] = function () {
  App._pdfJob = null;
  App.state.pdfJobError = '';
  App.state.addView = 'home';
  App.render();
};

/** The "reading" sub-view of Add: live job status, never a dead spinner. */
App.vPdfReading = function (v, seq) {
  var html = '<h1>Add</h1>';
  var job = App._pdfJob;
  if (App.state.pdfJobError && !job) {
    html += '<div class="banner bad"><strong>Could not read that file.</strong> ' +
      esc(App.state.pdfJobError) + '</div>';
  } else if (!job) {
    html += '<div class="empty">No PDF is being read right now.</div>';
  } else {
    html += '<div class="card">' + App.pdfJobCardInner(job) + '</div>';
    html += '<p class="small">You can leave this tab — reading resumes where it stopped, ' +
      'even if this tab was put in the background. If the reader stalls, progress is saved ' +
      'and you can retry from the last completed page.</p>';
  }
  html += '<button class="btn ghost" data-action="goto" data-tab="add" data-addview="home">Back to Add</button>';
  App.show(v, seq, html);
};

App.vImportPreview = function (v, seq) {
  var p = App.state.pending;
  var html = '<h1>Import preview</h1>';
  html += '<div class="card"><strong>' + esc(p.fileName) + '</strong><br>' +
    '<span class="small">' + p.fileSize + ' bytes · ' + p.rows.length + ' data rows · ' +
    p.errors.length + ' parse issue' + (p.errors.length === 1 ? '' : 's') + ' · ' +
    'SHA-256 <span class="mono">' + esc(shortHash(p.hash)) + '</span></span></div>';

  if (p.duplicate) {
    html += '<div class="banner warn"><strong>Already imported.</strong> A file with this exact content ' +
      '(hash <span class="mono">' + esc(shortHash(p.hash)) + '</span>) is already in your ledger. ' +
      'Importing again would duplicate every transaction, so we skip it.</div>' +
      '<button class="btn ghost" data-action="goto" data-tab="add" data-addview="home">Back</button>';
    App.show(v, seq, html);
    return;
  }

  html += '<div class="card"><h3 style="margin-top:0">Detected fields</h3>';
  if (p.fileKind === 'pdf') {
    var meta = p.pdfMeta || {};
    var isGeneric = p.templateId === 'generic_statement_v1';
    html += '<p class="small">Detected format: <strong>' + esc(p.formatLabel || 'PDF statement') + '</strong>' +
      (p.templateId ? ' <span class="mono tiny">' + esc(p.templateId) + '</span>' : '') +
      '<br>Read entirely on this device — the PDF never left your phone. ' +
      (isGeneric
        ? 'This layout is unfamiliar, so rows were detected with careful heuristics rather than an exact template. ' +
          'Uncertain rows are flagged for your review below — nothing is silently trusted.'
        : 'Every table line parsed; nothing was guessed.') + '</p>';
    if (isGeneric && p.pdfWarnings && p.pdfWarnings.length) {
      html += '<div class="banner warn" style="margin-top:8px"><strong>Heuristic read — please spot-check:</strong><ul class="list-plain">';
      p.pdfWarnings.forEach(function (w) { html += '<li>• ' + esc(w) + '</li>'; });
      html += '</ul></div>';
    }
    if (meta.period_start || meta.period_end) {
      html += '<p class="small">Statement period: <strong>' + esc(fmtDate(meta.period_start)) +
        ' – ' + esc(fmtDate(meta.period_end)) + '</strong></p>';
    }
    if (typeof meta.reported_start_balance_minor === 'number' &&
        typeof meta.reported_end_balance_minor === 'number') {
      html += '<p class="small">Reported balances: ' + money(meta.reported_start_balance_minor) +
        ' → ' + money(meta.reported_end_balance_minor) +
        ' — the pipeline will prove the rows add up to this.</p>';
    }
  } else {
    html += '<p class="small">The importer detected the statement columns and mapped them to these fields. ' +
      'The pipeline reads exactly this.</p>';
  }
  html +=
    '<table class="kv"><tr><th>date</th><td>rawDateText' + (p.fileKind === 'pdf' ? ' (+ statement-period year)' : '') + '</td></tr>' +
    '<tr><th>description / merchant</th><td>rawDescription</td></tr>' +
    '<tr><th>amount</th><td>rawAmountText' + (p.fileKind === 'pdf' ? ' (section-aware signing)' : '') + '</td></tr>' +
    '<tr><th>currency</th><td>rawCurrency (default CAD)</td></tr></table></div>';

  html += '<div class="card"><h3 style="margin-top:0">First rows (as detected)</h3><table class="kv">';
  var show = Math.min(3, p.rows.length);
  for (var i = 0; i < show; i++) {
    var o = p.rows[i];
    html += '<tr><th>Row ' + (i + 1) + '</th><td>' +
      esc(String(o.rawDateText || '')) + ' · ' +
      esc(String(o.rawDescription || '').slice(0, 42)) + ' · ' +
      esc(String(o.rawAmountText || '')) + '</td></tr>';
  }
  html += '</table></div>';

  if (p.errors.length) {
    html += '<details class="more"><summary>Parse issues (' + p.errors.length + ')</summary><ul class="list-plain">';
    p.errors.slice(0, 8).forEach(function (er) {
      var line = (er && typeof er === 'object' && er.row !== undefined)
        ? ('row ' + er.row + ': ' + (er.reason || '')) : JSON.stringify(er);
      html += '<li>' + esc(line) + '</li>';
    });
    html += '</ul></details>';
  }

  // For PDF imports we already detected the institution and statement period —
  // pre-fill them so the user only confirms.
  var preAcct = '', prePeriod = '';
  if (p.fileKind === 'pdf' && p.pdfMeta) {
    preAcct = (p.formatLabel || '').replace(/\s+statement$/i, '');
    if (p.pdfMeta.period_start) prePeriod = String(p.pdfMeta.period_start).slice(0, 7);
  }
  html += '<div class="card"><h3 style="margin-top:0">Label this statement</h3>' +
    '<label class="f" for="acct-name">Account nickname</label>' +
    '<input type="text" id="acct-name" placeholder="e.g. Main Visa" autocomplete="off"' +
      (preAcct ? ' value="' + esc(preAcct) + '"' : '') + '>' +
    '<label class="f" for="acct-last4">Last 4 digits <span class="tiny">(last-4 only — never the full number)</span></label>' +
    '<input type="text" id="acct-last4" inputmode="numeric" maxlength="4" placeholder="1234" autocomplete="off">' +
    '<label class="f" for="period-label">Period <span class="tiny">(YYYY-MM; blank = auto-detect from dates)</span></label>' +
    '<input type="text" id="period-label" placeholder="2026-08" autocomplete="off"' +
      (prePeriod ? ' value="' + esc(prePeriod) + '"' : '') + '></div>';

  html += '<button class="btn" data-action="confirm-import">Import &amp; process</button>' +
    '<button class="btn ghost" data-action="goto" data-tab="add" data-addview="home">Cancel</button>' +
    '<p class="tiny">Importing writes an audit event. Re-importing the same file is skipped by content hash.</p>';
  App.show(v, seq, html);
};

App.Actions['confirm-import'] = async function () {
  var p = App.state.pending;
  if (!p) return;
  // Re-check idempotency at commit time (hash of file text).
  var dup = (await sAll('sourceFiles')).some(function (f) { return f.sha256 === p.hash; });
  if (dup) {
    $('#view').innerHTML = '<div class="banner warn"><strong>Already imported.</strong> Nothing was duplicated.</div>' +
      '<button class="btn ghost" data-action="goto" data-tab="add" data-addview="home">Back</button>';
    audit('import.duplicate_skipped', 'sourceFile', null, { hash: p.hash, fileName: p.fileName });
    return;
  }
  var acctName = ($('#acct-name') && $('#acct-name').value.trim()) || 'Card';
  var last4 = ($('#acct-last4') && $('#acct-last4').value.replace(/\D/g, '').slice(0, 4)) || '••••';
  var periodLabel = ($('#period-label') && $('#period-label').value.trim()) || '';

  // Raw rows straight from the Engine's parser (columns already detected).
  // PDF rows additionally carry parser-authoritative signedAmountMinor
  // (section-aware signing), dateInferred (statement-period year), and
  // template extras (section, spendCategoryRaw, fx*); all are preserved.
  var rawRows = p.rows.map(function (r, i) {
    var o = {
      rowIndex: i,
      rawDateText: String(r.rawDateText != null ? r.rawDateText : ''),
      rawDescription: String(r.rawDescription != null ? r.rawDescription : ''),
      rawAmountText: String(r.rawAmountText != null ? r.rawAmountText : ''),
      rawCurrency: String(r.rawCurrency != null ? r.rawCurrency : '')
    };
    if (typeof r.signedAmountMinor === 'number') o.signedAmountMinor = r.signedAmountMinor;
    if (r.dateInferred) o.dateInferred = String(r.dateInferred);
    // Heuristic-parse certainty (generic PDF template only): the engine
    // routes confidence:'low' rows into the review queue.
    if (r.confidence === 'low' || r.confidence === 'medium' || r.confidence === 'high') o.confidence = r.confidence;
    if (r.confidenceNote) o.confidenceNote = String(r.confidenceNote);
    if (r.section) o.section = String(r.section);
    if (r.spendCategoryRaw) o.spendCategoryRaw = String(r.spendCategoryRaw);
    if (r.fxOriginalAmount) o.fxOriginalAmount = String(r.fxOriginalAmount);
    if (r.fxCurrency) o.fxCurrency = String(r.fxCurrency);
    if (r.fxRate) o.fxRate = String(r.fxRate);
    if (r.pageNumber !== undefined) o.pageNumber = r.pageNumber;
    return o;
  });

  App.state.pipe = {
    fileName: p.fileName, fileSize: p.fileSize, text: p.text, hash: p.hash,
    accountName: acctName, last4: last4, periodLabel: periodLabel,
    fileKind: p.fileKind || 'csv', formatLabel: p.formatLabel || 'Generic CSV',
    templateId: p.templateId || null, pdfMeta: p.pdfMeta || null,
    rawRows: rawRows, parsed: { errors: p.errors, rowCount: p.rows.length },
    stages: {}, open: {}, status: 'idle', running: false, done: false,
    txns: [], allocations: [], matchSuggestions: [], refundLinks: [], recon: null,
    facts: null, briefingText: '', ids: {}
  };
  App.state.pending = null;
  App.state.addView = 'processing';
  App.render();
  App.runPipeline();
};

/* ============================================================================
 * Screen 3 — Processing pipeline
 * Visible staged pipeline: Ingest -> Extract -> Normalize -> Classify ->
 * Match -> Allocate -> Reconcile -> Explain. Each stage runs in chunks so the
 * UI stays responsive; each stage is expandable to show rows/decisions.
 * ========================================================================== */

var STAGE_DEFS = [
  { id: 'ingest',    name: 'Ingest' },
  { id: 'extract',   name: 'Extract' },
  { id: 'normalize', name: 'Normalize' },
  { id: 'classify',  name: 'Classify' },
  { id: 'match',     name: 'Match' },
  { id: 'allocate',  name: 'Allocate' },
  { id: 'reconcile', name: 'Reconcile' },
  { id: 'explain',   name: 'Explain' }
];

App.vProcessing = function (v, seq) {
  var pipe = App.state.pipe;
  var html = '<h1>Processing</h1>';
  html += '<div class="card"><strong>' + esc(pipe.fileName) + '</strong><br>' +
    '<span class="small">' + esc(pipe.accountName) + ' ····' + esc(pipe.last4) + '</span></div>';

  var done = STAGE_DEFS.filter(function (s) { return pipe.stages[s.id] && pipe.stages[s.id].status === 'done'; }).length;
  html += '<div class="progress" role="progressbar" aria-valuenow="' + done + '" aria-valuemax="8">' +
    '<div style="width:' + Math.round(done / 8 * 100) + '%"></div></div>';

  STAGE_DEFS.forEach(function (s, idx) {
    var st = pipe.stages[s.id] || { status: 'pending' };
    var cls = st.status === 'done' ? 'done' : (st.status === 'running' ? 'running' : '');
    html += '<div class="stage ' + cls + '">' +
      '<button class="stage-head" data-action="stage-toggle" data-stage="' + s.id + '" aria-expanded="' + (!!pipe.open[s.id]) + '">' +
        '<span class="n">' + (st.status === 'done' ? '✓' : (idx + 1)) + '</span>' +
        '<span class="t">' + s.name + '</span>' +
        (st.status === 'running' ? '<span class="spin"></span>' : '') +
        '<span class="c">' + esc(st.counts || (st.status === 'running' ? 'working…' : 'waiting')) + '</span>' +
      '</button>';
    if (pipe.open[s.id] && st.detail) {
      html += '<div class="stage-body">' + st.detail + '</div>';
    }
    html += '</div>';
  });

  if (pipe.done) {
    var r = pipe.recon || {};
    html += '<div class="banner ok"><strong>Done.</strong> ' + pipe.txns.length + ' transactions cleaned. ' +
      'Net spend <strong>' + spendAbs(r.netSpendMinor || 0) + '</strong>' +
      (r.unresolvedCount ? ' · <strong>' + r.unresolvedCount + '</strong> need your review.' : ' · nothing needs review.') +
      '</div>' +
      '<button class="btn" data-action="pipe-review">Review clean statement</button>' +
      '<button class="btn ghost" data-action="goto" data-tab="add" data-addview="receipts">Add receipts (optional)</button>' +
      '<button class="btn ghost" data-action="tab" data-tab="home">See your month</button>';
  } else if (pipe.failed) {
    html += '<div class="banner bad"><strong>Pipeline stopped:</strong> ' + esc(pipe.failed) + '</div>' +
      '<button class="btn ghost" data-action="goto" data-tab="add" data-addview="home">Back to Add</button>';
  }
  App.show(v, seq, html);
};

App.Actions['stage-toggle'] = function (d) {
  var pipe = App.state.pipe;
  if (!pipe) return;
  pipe.open[d.stage] = !pipe.open[d.stage];
  App.render();
};
App.Actions['pipe-review'] = function () {
  App.state.addView = 'home';
  App.go('statement', { statementId: App.state.pipe.ids.statementId, sfilter: 'review', txnId: null });
};

/** Enabled household rules, newest first. */
async function enabledRules() {
  var rules = await sAll('householdRules');
  return rules.filter(function (r) { return r.enabled !== false; })
    .sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
}
/** Household rules are stored FLAT in the Engine's applyRules shape
    (V4): {id, enabled, priority, matchMerchant, kind, label} + metadata. */
function rulePayloads(rules) { return rules; }

App.setStage = function (id, status, counts, detail) {
  var pipe = App.state.pipe;
  pipe.stages[id] = { status: status, counts: counts || '', detail: detail || '' };
  if (App.state.tab === 'add' && App.state.addView === 'processing') App.render();
};

async function chunked(rows, size, fn) {
  var out = [];
  for (var i = 0; i < rows.length; i += size) {
    var part = fn(rows.slice(i, i + size), i);
    out = out.concat(part);
    await tick();
  }
  return out;
}

App.runPipeline = async function () {
  var pipe = App.state.pipe;
  if (!pipe || pipe.running || pipe.done) return;
  pipe.running = true;
  try {
    await App.stageIngest(pipe);
    await App.stageExtract(pipe);
    await App.stageNormalize(pipe);
    await App.stageClassify(pipe);
    await App.stageMatch(pipe);
    await App.stageAllocate(pipe);
    await App.stageReconcile(pipe);
    await App.stageExplain(pipe);
    await App.commitPipeline(pipe);
    pipe.done = true;
    // Opt-in online merchant lookup: runs only after the import is fully
    // done, never delays the import itself. No-op while the feature is off.
    setTimeout(function () { App.runMerchantLookup(); }, 0);
  } catch (e) {
    pipe.failed = (e && e.message) || String(e);
  }
  pipe.running = false;
  if (App.state.tab === 'add' && App.state.addView === 'processing') App.render();
};

/* ---- individual stages ---- */

App.stageIngest = async function (pipe) {
  App.setStage('ingest', 'running', 'hashing…');
  await tick();
  var dup = (await sAll('sourceFiles')).some(function (f) { return f.sha256 === pipe.hash; });
  if (dup) throw new Error('File was already imported (hash match). Nothing duplicated.');
  App.setStage('ingest', 'done', '1 file · ' + pipe.fileSize + ' bytes',
    '<ul><li>File: <strong>' + esc(pipe.fileName) + '</strong> (' + pipe.fileSize + ' bytes)</li>' +
    '<li>SHA-256: <span class="mono">' + esc(pipe.hash) + '</span></li>' +
    '<li>Duplicate check: no existing file with this hash — proceeding.</li></ul>');
};

/** Reported {startMinor, endMinor} baseline from a PDF statement's account
 * summary, or null when the import has none (CSV). Used by reconcile(). */
function reportedBaseline(pipe) {
  var meta = pipe && pipe.pdfMeta;
  if (meta && typeof meta.reported_start_balance_minor === 'number' &&
      typeof meta.reported_end_balance_minor === 'number') {
    return {
      startMinor: meta.reported_start_balance_minor,
      endMinor: meta.reported_end_balance_minor
    };
  }
  return null;
}

App.stageExtract = async function (pipe) {
  App.setStage('extract', 'running', pipe.fileKind === 'pdf' ? 'PDF already parsed…' : 'parsing CSV…');
  await tick();
  var rows, errors, detail;
  if (pipe.fileKind === 'pdf') {
    // The PDF was fully parsed on-device before the preview (Parsers.parsePdf
    // refuses to guess: any unparsed table line aborts the import there).
    // rawRows already carry the parser's rows; nothing is re-derived here.
    rows = pipe.rawRows || [];
    errors = [];
    pipe.parsed = { errors: errors, rowCount: rows.length };
    detail = '<ul><li>Format: <strong>' + esc(pipe.formatLabel || 'PDF statement') + '</strong>' +
      (pipe.templateId ? ' <span class="mono tiny">' + esc(pipe.templateId) + '</span>' : '') + '</li>' +
      (pipe.templateId === 'generic_statement_v1'
        ? '<li>' + rows.length + ' data rows via heuristic read; low-confidence rows are flagged for your review.</li>'
        : '<li>' + rows.length + ' data rows; 0 unparsed lines (the parser refuses to guess).</li>') +
      '<li>Parser-authoritative signing and statement-period dates carried into normalization.</li></ul>';
  } else {
    var parsed = Engine.parseCSV(pipe.text); // authoritative re-parse for the pipeline
    rows = (parsed && parsed.rows) || [];
    errors = (parsed && parsed.errors) || [];
    pipe.parsed = { errors: errors, rowCount: rows.length };
    // V1: rows are objects with rawDateText/rawDescription/rawAmountText/rawCurrency.
    detail = '<ul><li>Detected fields: <strong>rawDateText</strong>, <strong>rawDescription</strong>, <strong>rawAmountText</strong>, <strong>rawCurrency</strong></li>' +
      '<li>' + rows.length + ' data rows; ' + errors.length + ' parse issue(s).</li></ul>';
    if (errors.length) {
      detail += '<ul>' + errors.slice(0, 5).map(function (e) {
        var line = (e && typeof e === 'object' && e.row !== undefined)
          ? ('row ' + e.row + ': ' + (e.reason || '')) : JSON.stringify(e);
        return '<li class="small">⚠ ' + esc(line) + '</li>';
      }).join('') + '</ul>';
    }
  }
  App.setStage('extract', 'done', rows.length + ' rows · ' + errors.length + ' issues', detail);
};

App.stageNormalize = async function (pipe) {
  App.setStage('normalize', 'running', 'normalizing…');
  var rawRows = pipe.rawRows;
  var normalized = await chunked(rawRows, 40, function (chunk) {
    try { return Engine.normalizeRows(chunk); } catch (e) { return chunk; }
  });
  // Merge defensively: normalized rows win, raw fields always present.
  pipe.txns = normalized.map(function (n, i) {
    var m = {}; var r = rawRows[i] || {};
    Object.keys(r).forEach(function (k) { m[k] = r[k]; });
    Object.keys(n || {}).forEach(function (k) { m[k] = n[k]; });
    return m;
  });
  var withDate = pipe.txns.filter(function (t) { return t.date; }).length;
  var detail = '<ul><li>Dates, signed minor-unit amounts, currency, merchant names normalized.</li>' +
    '<li>' + withDate + ' / ' + pipe.txns.length + ' rows have a parsed date.</li></ul>' +
    '<table class="kv"><tr><th>Raw → normalized (row 1)</th><td>' +
    esc(JSON.stringify(rawRows[0] || {})) + '<br>↓<br>' + esc(JSON.stringify(pipe.txns[0] || {})) +
    '</td></tr></table>';
  App.setStage('normalize', 'done', pipe.txns.length + ' rows normalized', detail);
};

App.stageClassify = async function (pipe) {
  App.setStage('classify', 'running', 'classifying…');
  var rules = await enabledRules();
  // No silent fallback: if the Engine fails, the stage fails loudly and the
  // pipeline aborts, so we never present unclassified rows as classified.
  var classified = await chunked(pipe.txns, 40, function (chunk) {
    return Engine.classifyRows(chunk, rulePayloads(rules));
  });
  pipe.txns = classified.map(function (c, i) {
    var m = pipe.txns[i] || {};
    Object.keys(c || {}).forEach(function (k) { m[k] = c[k]; });
    return m;
  });
  var counts = {};
  pipe.txns.forEach(function (t) { var k = t.kind || 'uncertain'; counts[k] = (counts[k] || 0) + 1; });
  var detail = '<ul>' + Object.keys(counts).sort().map(function (k) {
    return '<li><strong>' + counts[k] + '</strong> × ' + esc(kindLabel(k)) + '</li>';
  }).join('') + '<li class="small">' + rules.length + ' household rule(s) applied.</li></ul>';
  var unc = pipe.txns.filter(function (t) { return (t.kind || 'uncertain') === 'uncertain'; });
  if (unc.length) detail += '<p class="small">' + unc.length + ' uncertain — they go to your review queue.</p>';
  App.setStage('classify', 'done', Object.keys(counts).length + ' kinds · ' + (counts.uncertain || 0) + ' uncertain', detail);
};

App.stageMatch = async function (pipe) {
  App.setStage('match', 'running', 'scoring receipts…');
  var receipts = await sAll('receipts');
  var purchases = pipe.txns.map(function (t, i) { return { t: t, i: i }; })
    .filter(function (x) { return (x.t.kind === 'purchase' || x.t.kind === 'cash_advance') && !x.t.excluded; });
  var suggestions = [];
  var accept = Engine.RECEIPT_MATCH_THRESHOLD || 0.85; // V6
  var detail = '';
  if (!receipts.length) {
    detail = '<p class="small">No receipts saved yet — add them any time from the Add tab. Unmatched transactions simply stay unmatched; we never force a match.</p>';
  } else {
    detail = '<ul>';
    for (var ri = 0; ri < receipts.length; ri++) {
      var rc = receipts[ri];
      var scored = [];
      for (var pi = 0; pi < purchases.length; pi++) {
        var res;
        try { res = Engine.scoreReceiptMatch(purchases[pi].t, receiptForScore(rc, purchases[pi].t)); }
        catch (e) { continue; }
        var score = Array.isArray(res) ? res[0] : 0;
        var reasons = Array.isArray(res) ? res[1] : [];
        if (score >= 0.5) scored.push({ i: purchases[pi].i, score: score, reasons: reasons });
      }
      scored.sort(function (a, b) { return b.score - a.score; });
      var top = scored.slice(0, 3);
      top.forEach(function (s) {
        suggestions.push({ receiptId: rc.id, txnRowIndex: s.i, score: s.score, reasons: s.reasons, status: 'suggested' });
      });
      detail += '<li><strong>' + esc(rc.merchantRaw || 'Receipt') + '</strong> ' + money(Math.abs(rc.amountMinor || 0)) +
        ' — ' + (top.length ? top.length + ' candidate(s), best ' + Math.round(top[0].score * 100) + '%' +
          (top[0].score >= accept ? ' (likely)' : '') : 'no candidates ≥ 50%') + '</li>';
    }
    detail += '</ul><p class="small">Conservative: suggestions only. Confirm matches in Receipts; anything unmatched stays unmatched.</p>';
  }
  pipe.matchSuggestions = suggestions;
  App.setStage('match', 'done', receipts.length + ' receipts · ' + suggestions.length + ' suggestions', detail);
};

App.stageAllocate = async function (pipe) {
  App.setStage('allocate', 'running', 'categorizing…');
  var rules = await enabledRules();
  // No silent fallback: if the Engine fails, the stage fails loudly and the
  // pipeline aborts. Engine.autoCategorize: household rules with a category
  // win first, then built-in Canadian-merchant keyword suggestions (>= 0.6),
  // never overwriting user-set categories. Blank stays blank (honest).
  Engine.autoCategorize(pipe.txns, rulePayloads(rules));
  var byCat = {}, bySource = {};
  pipe.txns.forEach(function (t) {
    if (t.category) byCat[t.category] = (byCat[t.category] || 0) + 1;
    var src = t.categorySource || 'none';
    bySource[src] = (bySource[src] || 0) + 1;
  });
  pipe.allocations = pipe.txns.map(function (t, i) {
    var amt = t.spendAmountMinor;
    if (amt === null || amt === undefined) amt = t.amountMinor;
    return { rowIndex: i, categoryId: t.category || null, amountMinor: amt,
             basis: t.categoryReason || 'default: no category matched' };
  });
  var nCat = Object.keys(byCat).length;
  var detail = '<ul>' + Object.keys(byCat).sort().map(function (c) {
    return '<li><strong>' + byCat[c] + '</strong> → ' + esc(catName(c)) + '</li>';
  }).join('') + '</ul>' +
    '<p class="small">' + (bySource.rule || 0) + ' by household rule · ' +
    (bySource.auto || 0) + ' automatic · ' + (bySource.user || 0) + ' kept from your corrections.</p>' +
    '<p class="small">Change any transaction\'s category in the statement view — you can turn a correction into a reusable rule.</p>';
  App.setStage('allocate', 'done', nCat + ' categories used', nCat ? detail : '<p class="small">No spend to categorize.</p>');
};

App.stageReconcile = async function (pipe) {
  App.setStage('reconcile', 'running', 'reconciling…');
  await tick();
  var recon;
  var reported = reportedBaseline(pipe);
  try { recon = Engine.reconcile(pipe.txns, reported); }
  catch (e) {
    // Last-resort local math mirroring the Engine's corrected card-account
    // equation: (reported_end - reported_start) == SUM(signedAmountMinor).
    // Mirrors Engine.reconcile: excluded/duplicate rows never count toward
    // spend, but still feed the excluded total and the balance-check sum.
    var g = 0, rfSigned = 0, rfCount = 0, ex = 0, un = 0, sSum = 0, sKnown = true;
    pipe.txns.forEach(function (t) {
      var amt = (t.amountMinor === null || t.amountMinor === undefined) ? 0 : t.amountMinor;
      var isX = t.excluded === 1 || t.status === 'duplicate';
      if (!isX) {
        if (t.kind === 'purchase') g += amt;
        else if (t.kind === 'refund') { rfSigned += amt; rfCount++; }
      }
      if (t.excluded === 1) ex += amt;
      if (App.needsReview(t)) un++;
      if (t.signedAmountMinor === null || t.signedAmountMinor === undefined) sKnown = false;
      else sSum += t.signedAmountMinor;
    });
    var bc = 'no_baseline', gap = 0;
    if (reported && sKnown) {
      gap = (reported.endMinor - reported.startMinor) - sSum;
      bc = (gap >= -1 && gap <= 1) ? 'ok' : 'gap';
    }
    recon = { grossPurchasesMinor: g, refundsTotalMinor: -rfSigned, refundCount: rfCount,
      excludedTotalMinor: ex, netSpendMinor: g + rfSigned, unresolvedCount: un,
      signedRowsSumMinor: sSum, balanceCheck: bc, gapMinor: gap };
  }
  pipe.recon = recon;
  pipe.reported = reported;
  var detail = '<ul>' +
    '<li>Gross purchases: <strong>' + spendAbs(recon.grossPurchasesMinor) + '</strong></li>' +
    '<li>Refunds: <strong>' + spendAbs(recon.refundsTotalMinor) + '</strong></li>' +
    '<li>Excluded: <strong>' + spendAbs(recon.excludedTotalMinor) + '</strong></li>' +
    '<li>Net spend: <strong>' + spendAbs(recon.netSpendMinor) + '</strong></li>' +
    '<li>Unresolved: <strong>' + (recon.unresolvedCount || 0) + '</strong></li>';
  if (reported) {
    detail += '<li>Reported balance: <strong>' + money(reported.startMinor) + ' → ' +
      money(reported.endMinor) + '</strong> (from the statement\u2019s account summary)</li>' +
      '<li>Row movement total: <strong>' + money(recon.signedRowsSumMinor) + '</strong></li>' +
      '<li>Balance check: <strong>' + esc(String(recon.balanceCheck)) + '</strong>' +
      (recon.balanceCheck === 'gap'
        ? ' — gap of ' + money(recon.gapMinor) + '. The rows do not add up to the reported balances; something is missing or mis-signed.'
        : ' — every row accounted for.') + '</li>';
  } else {
    detail += '<li class="small">Balance check: ' + esc(String(recon.balanceCheck)) +
      ' (no reported balances in this file).</li>';
  }
  detail += '</ul>';
  App.setStage('reconcile', 'done',
    spendAbs(recon.netSpendMinor || 0) + ' net · ' + (recon.unresolvedCount || 0) + ' unresolved' +
    (reported ? ' · balance ' + recon.balanceCheck : ''), detail);
};

App.stageExplain = async function (pipe) {
  App.setStage('explain', 'running', 'writing briefing…');
  await tick();
  var dates = pipe.txns.map(function (t) { return t.date; }).filter(Boolean).sort();
  var periodStart = dates[0] || null, periodEnd = dates[dates.length - 1] || null;
  var periodLabel = pipe.periodLabel || (periodStart ? periodStart.slice(0, 7) : 'statement');
  pipe.periodStart = periodStart; pipe.periodEnd = periodEnd; pipe.periodLabel = periodLabel;
  var scopeLabel = fmtPeriod(periodLabel) + ' · ' + pipe.accountName + ' ••' + pipe.last4;
  pipe.scopeLabel = scopeLabel;
  // Previous statement's txns for "what changed".
  var prevRows = [];
  try {
    var stmts = (await sAll('statements')).sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
    if (stmts.length) prevRows = await sQuery('txns', 'statementId', stmts[0].id);
  } catch (e) { prevRows = []; }
  var facts = null, text = '';
  try {
    facts = Engine.buildBriefing(pipe.txns, periodStart, periodEnd, prevRows, scopeLabel, pipe.reported || null);
    text = Engine.renderBriefingText(facts);
  } catch (e) {
    text = 'Briefing engine error: ' + (e.message || e) + '. The ledger below is still complete and auditable.';
  }
  pipe.facts = facts; pipe.briefingText = text;
  App.setStage('explain', 'done', 'briefing ready',
    '<pre class="brief" style="margin:0">' + esc(text).slice(0, 1200) + (text.length > 1200 ? '…' : '') + '</pre>');
};

/* ---- commit: persist the pipeline result ---- */

App.commitPipeline = async function (pipe) {
  var now = Date.now();
  // Field names follow the W1 schema comment in store.js (V9).
  var sourceFileId = await Store.put('sourceFiles', {
    fileName: pipe.fileName, sha256: pipe.hash, size: pipe.fileSize,
    importedAt: now, rowCount: pipe.txns.length
  });
  audit('import.completed', 'sourceFile', sourceFileId, { fileName: pipe.fileName, rows: pipe.txns.length });

  var accountId = await Store.put('accounts', { name: pipe.accountName, type: 'card', last4: pipe.last4, createdAt: now });
  var reported = pipe.reported || reportedBaseline(pipe);
  var statementId = await Store.put('statements', {
    sourceFileId: sourceFileId, accountId: accountId,
    periodStart: pipe.periodStart, periodEnd: pipe.periodEnd,
    // Reported balances from the statement's account summary (PDF only);
    // null when the import had no reported baseline (CSV).
    reportedStartMinor: reported ? reported.startMinor : null,
    reportedEndMinor: reported ? reported.endMinor : null,
    templateId: pipe.templateId || null, createdAt: now,
    periodLabel: pipe.periodLabel, scopeLabel: pipe.scopeLabel, rowCount: pipe.txns.length
  });
  audit('statement.imported', 'statement', statementId, { period: pipe.periodLabel, rows: pipe.txns.length });
  pipe.ids = { sourceFileId: sourceFileId, accountId: accountId, statementId: statementId };

  // Txns (ids assigned by Store).
  var rowToId = {};
  for (var i = 0; i < pipe.txns.length; i++) {
    var t = pipe.txns[i];
    t.statementId = statementId; t.rowIndex = i;
    if (!t.status) t.status = 'new';
    var id = await Store.put('txns', t);
    rowToId[i] = id;
    if (i % 40 === 0) await tick();
  }

  // Match suggestions (confirm later in Receipts).
  for (var m = 0; m < pipe.matchSuggestions.length; m++) {
    var ms = pipe.matchSuggestions[m];
    await Store.put('matches', {
      receiptId: ms.receiptId, txnId: rowToId[ms.txnRowIndex],
      score: ms.score, reasons: ms.reasons, status: 'suggested', createdAt: now
    });
  }
  if (pipe.matchSuggestions.length)
    audit('match.suggested', 'statement', statementId, { count: pipe.matchSuggestions.length });

  // Allocations.
  for (var a = 0; a < pipe.allocations.length; a++) {
    var al = pipe.allocations[a];
    if (!al.categoryId) continue;
    await Store.put('allocations', {
      statementId: statementId, txnId: rowToId[al.rowIndex],
      categoryId: al.categoryId, amountMinor: al.amountMinor, basis: al.basis, createdAt: now
    });
    if (a % 40 === 0) await tick();
  }

  // Refund links (suggested): same merchant, matching amount, purchase before refund.
  // One suggested original per refund; the most recent eligible purchase wins
  // (consistent with the cross-statement rule below).
  var refunds = [], purchases = [];
  pipe.txns.forEach(function (t, i) {
    if (t.kind === 'refund') refunds.push(i);
    else if ((t.kind === 'purchase' || t.kind === 'cash_advance') && !t.excluded) purchases.push(i);
  });
  function merchKey(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
  for (var r = 0; r < refunds.length; r++) {
    var rt = pipe.txns[refunds[r]];
    var rk = merchKey(rt.merchantRaw || rt.rawDescription);
    var ra = Math.abs(rt.amountMinor || 0);
    var bestQ = -1;
    for (var q = 0; q < purchases.length; q++) {
      var pt = pipe.txns[purchases[q]];
      if (merchKey(pt.merchantRaw || pt.rawDescription) !== rk) continue;
      if (Math.abs(Math.abs(pt.amountMinor || 0) - ra) > 1) continue;
      if (rt.date && pt.date && rt.date < pt.date) continue;
      if (bestQ === -1 ||
          String(pt.date || '') > String(pipe.txns[purchases[bestQ]].date || '')) bestQ = q;
    }
    if (bestQ !== -1) {
      await Store.put('refundLinks', {
        statementId: statementId, refundTxnId: rowToId[refunds[r]], purchaseTxnId: rowToId[purchases[bestQ]],
        basis: 'same merchant + matching amount', status: 'suggested', createdAt: now
      });
    }
  }
  // Cross-statement: a refund with no in-statement match may return a purchase
  // from an earlier statement. Match the most recent eligible purchase
  // (same merchant, matching amount, purchase on/before refund). One link per
  // refund; never re-link a refund that already has one.
  var alreadyLinked = {};
  (await sAll('refundLinks')).forEach(function (l) { alreadyLinked[String(l.refundTxnId)] = 1; });
  var priorTxns = await sAll('txns'); // this statement's rows are stored by now
  for (var r2 = 0; r2 < refunds.length; r2++) {
    var rid2 = rowToId[refunds[r2]];
    if (alreadyLinked[String(rid2)]) continue;
    var rt2 = pipe.txns[refunds[r2]];
    var rk2 = merchKey(rt2.merchantRaw || rt2.rawDescription);
    var ra2 = Math.abs(rt2.amountMinor || 0);
    var best = null;
    for (var p2 = 0; p2 < priorTxns.length; p2++) {
      var pt2 = priorTxns[p2];
      if (String(pt2.statementId) === String(statementId)) continue; // other statements only
      if (pt2.kind !== 'purchase' && pt2.kind !== 'cash_advance') continue;
      if (pt2.excluded) continue;
      if (pt2.status === 'duplicate') continue;
      if (merchKey(pt2.merchantRaw || pt2.rawDescription) !== rk2) continue;
      if (Math.abs(Math.abs(pt2.amountMinor || 0) - ra2) > 1) continue;
      if (rt2.date && pt2.date && rt2.date < pt2.date) continue;
      if (!best || String(pt2.date || '') > String(best.date || '')) best = pt2;
    }
    if (best) {
      await Store.put('refundLinks', {
        statementId: statementId, refundTxnId: rid2, purchaseTxnId: best.id,
        basis: 'same merchant + matching amount (earlier statement)', status: 'suggested', createdAt: now
      });
    }
    if (r2 % 20 === 0) await tick();
  }
  // Reverse cross-statement: this import can also be the missing PURCHASE
  // side for refunds imported earlier (refund statement imported before the
  // purchase statement). Link still-unlinked prior refunds to the most
  // recent eligible purchase in THIS statement. Without this, import order
  // alone decided whether return attribution worked.
  var priorRefunds = (await sAll('txns')).filter(function (t) {
    return t && t.kind === 'refund' && !t.excluded &&
      String(t.statementId) !== String(statementId) &&
      !alreadyLinked[String(t.id)];
  });
  for (var r3 = 0; r3 < priorRefunds.length; r3++) {
    var pr = priorRefunds[r3];
    var prk = merchKey(pr.merchantRaw || pr.rawDescription);
    var pra = Math.abs(pr.amountMinor || 0);
    var best3 = null, best3Row = -1;
    for (var q3 = 0; q3 < purchases.length; q3++) {
      var pt3 = pipe.txns[purchases[q3]];
      if (merchKey(pt3.merchantRaw || pt3.rawDescription) !== prk) continue;
      if (Math.abs(Math.abs(pt3.amountMinor || 0) - pra) > 1) continue;
      if (pr.date && pt3.date && pr.date < pt3.date) continue;
      if (!best3 || String(pt3.date || '') > String(best3.date || '')) { best3 = pt3; best3Row = purchases[q3]; }
    }
    if (best3) {
      await Store.put('refundLinks', {
        statementId: pr.statementId, refundTxnId: pr.id, purchaseTxnId: rowToId[best3Row],
        basis: 'same merchant + matching amount (purchase imported later)', status: 'suggested', createdAt: now
      });
      alreadyLinked[String(pr.id)] = 1;
    }
    if (r3 % 20 === 0) await tick();
  }

  // Briefing (V9: factsJson per schema; facts/text kept for direct use).
  await Store.put('briefings', {
    statementId: statementId, periodStart: pipe.periodStart, periodEnd: pipe.periodEnd,
    scopeLabel: pipe.scopeLabel, factsJson: JSON.stringify(pipe.facts || null),
    facts: pipe.facts, text: pipe.briefingText, periodLabel: pipe.periodLabel, createdAt: now
  });

  App.state.statementId = statementId;
  App.bumpDataRev(); // new statement -> duplicate cache invalid
  App.state.txnShown = App.TXN_PAGE_SIZE; // new statement -> reset paging
};

/* ============================================================================
 * Screen 2 — Receipts (optional, skippable)
 * OCR is stubbed in Gate 1: the user enters merchant/date/total manually.
 * Matching is conservative via Engine.scoreReceiptMatch; unmatched stays
 * unmatched. Images are stored as blobs in the receipts store, on-device.
 * ========================================================================== */

App.vReceipts = async function (v, seq) {
  var receipts = await sAll('receipts');
  var matches = await sAll('matches');
  var confirmed = matches.filter(function (m) { return m.status === 'confirmed'; });
  var html = '<h1>Receipts</h1>';
  html += '<p class="small">Optional. Snap or upload receipts — on-device OCR pre-reads the merchant, date and total; ' +
    'you confirm or fix them. Matches are <strong>suggestions</strong> — you confirm them.</p>';

  // Coverage meter: matched spend / gross purchases of the current statement.
  var cov = await App.receiptCoverage();
  html += '<div class="card"><div class="section-head"><h3 style="margin:0">Coverage by spend</h3>' +
    '<span><strong>' + Math.round(cov.ratio * 100) + '%</strong></span></div>' +
    '<div class="meter"><div style="width:' + Math.round(cov.ratio * 100) + '%"></div></div>' +
    '<p class="small">' + spendAbs(cov.matchedMinor) + ' of ' + spendAbs(cov.grossMinor) + ' purchases explained by receipts' +
    (cov.scopeLabel ? ' · ' + esc(cov.scopeLabel) : '') + '.</p></div>';

  html += '<div class="card"><h3 style="margin-top:0">Add a receipt</h3>' +
    '<label class="filepick" for="receipt-file">' +
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 8h3l2-3h6l2 3h3v12H4z"/><circle cx="12" cy="13" r="3.5"/></svg>' +
    'Take photo / choose image</label>' +
    '<input type="file" id="receipt-file" class="hidden-file" accept="image/*" capture="environment" data-change="receipt-file">' +
    '<div id="receipt-preview"></div>' +
    '<label class="f" for="rc-merchant">Merchant</label><input type="text" id="rc-merchant" autocomplete="off" placeholder="e.g. Costco">' +
    '<label class="f" for="rc-date">Date</label><input type="date" id="rc-date">' +
    '<label class="f" for="rc-total">Total</label><input type="text" id="rc-total" inputmode="decimal" placeholder="0.00" autocomplete="off">' +
    '<button class="btn" data-action="save-receipt">Save receipt</button>' +
    (App.state.receiptMsg ? '<div class="banner warn">' + esc(App.state.receiptMsg) + '</div>' : '') +
    '</div>';

  if (!receipts.length) {
    html += '<div class="empty">No receipts yet. This step is optional — skip it any time.</div>';
  } else {
    html += '<h2>Saved (' + receipts.length + ')</h2>';
    receipts.slice().sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); }).forEach(function (rc) {
      var ms = matches.filter(function (m) { return String(m.receiptId) === String(rc.id); });
      var conf = ms.filter(function (m) { return m.status === 'confirmed'; })[0];
      var sugg = ms.filter(function (m) { return m.status === 'suggested'; });
      html += '<div class="card"><div style="display:flex;gap:10px;align-items:center">' +
        (rc._url ? '<img src="' + rc._url + '" alt="" style="width:64px;height:64px;object-fit:cover;border-radius:8px;background:#efece4">' : '') +
        '<div style="flex:1"><strong>' + esc(rc.merchantRaw || 'Receipt') + '</strong><br>' +
        '<span class="small">' + esc(rc.date || '') + ' · ' + money(Math.abs(rc.amountMinor || 0)) + '</span><br>' +
        (conf ? '<span class="pill ok">matched ✓</span>'
              : (sugg.length ? '<span class="pill warn">' + sugg.length + ' suggestion(s)</span>' : '<span class="pill dim">unmatched</span>')) +
        '</div></div>' +
        '<div class="btn-row" style="margin-top:8px">' +
          '<button class="btn ghost smallbtn" data-action="find-matches" data-id="' + esc(rc.id) + '">Find matches</button>' +
          '<button class="btn ghost smallbtn" data-action="del-receipt" data-id="' + esc(rc.id) + '">Delete</button>' +
        '</div>' +
        '<div id="match-' + esc(rc.id) + '"></div>' +
      '</div>';
    });
  }

  html += '<button class="btn ghost" data-action="goto" data-tab="add" data-addview="home">Done — back to Add</button>' +
    '<button class="btn ghost" data-action="tab" data-tab="home">Skip for now →</button>';
  App.show(v, seq, html);
  if (seq !== App._renderSeq) return; // superseded; skip thumbnail work

  // Rebuild object URLs for thumbnails (offline-safe blob URLs).
  receipts.forEach(function (rc) {
    if (rc.imageBlob && !rc._url) {
      try { rc._url = URL.createObjectURL(rc.imageBlob); } catch (e) {}
    }
  });
  if (receipts.some(function (rc) { return rc._url; })) {
    $all('.card img').forEach(function () {});
    App.vReceiptsThumbs(v, receipts);
  }
};

/** Fill thumbnails after render (keeps render synchronous). */
App.vReceiptsThumbs = function (v, receipts) {
  var map = {};
  receipts.forEach(function (rc) { if (rc._url) map[String(rc.id)] = rc._url; });
  $all('#view .card', v).forEach(function (card) {
    var btn = card.querySelector('[data-action="find-matches"]');
    if (btn && map[btn.dataset.id]) {
      var img = card.querySelector('img');
      if (!img) {
        img = document.createElement('img');
        img.alt = '';
        img.style.cssText = 'width:64px;height:64px;object-fit:cover;border-radius:8px;background:#efece4';
        var row = card.querySelector('div[style*="display:flex"]');
        if (row) row.insertBefore(img, row.firstChild);
      }
      img.src = map[btn.dataset.id];
    }
  });
};

/** Pure receipt-coverage math over an explicit txn list + confirmed
 * matches: ratio of gross purchase spend with a confirmed receipt. */
App.coverageOfTxns = function (txns, matches) {
  var gross = 0;
  (txns || []).forEach(function (t) {
    if ((t.kind === 'purchase' || t.kind === 'cash_advance') && !t.excluded)
      gross += Math.abs(t.spendAmountMinor != null ? t.spendAmountMinor : (t.amountMinor || 0));
  });
  var txnById = {};
  (txns || []).forEach(function (t) { txnById[String(t.id)] = t; });
  var matched = 0;
  (matches || []).forEach(function (m) {
    var t = txnById[String(m.txnId)];
    if (t) matched += Math.abs(t.spendAmountMinor != null ? t.spendAmountMinor : (t.amountMinor || 0));
  });
  return { ratio: gross > 0 ? Math.min(1, matched / gross) : 0, matchedMinor: matched, grossMinor: gross };
};

App.receiptCoverage = async function () {
  var stmts = await sAll('statements');
  if (!stmts.length) return { ratio: 0, matchedMinor: 0, grossMinor: 0, scopeLabel: '' };
  stmts.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
  var st = stmts[0];
  var txns = await sQuery('txns', 'statementId', st.id);
  var matches = (await sAll('matches')).filter(function (m) { return m.status === 'confirmed'; });
  var cov = App.coverageOfTxns(txns, matches);
  cov.scopeLabel = st.scopeLabel || st.periodLabel;
  return cov;
};

/** Month-scoped receipt coverage over an explicit txn list (all accounts,
 * selected month only). Matches can only attach to txns in the list. */
App.receiptCoverageFor = async function (txns) {
  var matches = (await sAll('matches')).filter(function (m) { return m.status === 'confirmed'; });
  return App.coverageOfTxns(txns, matches);
};

var pendingReceiptBlob = null;
var pendingReceiptOcr = null; // latest on-device OCR result for the pending photo

App.Changes['receipt-file'] = function (input) {
  var file = input.files && input.files[0];
  var prev = $('#receipt-preview');
  pendingReceiptOcr = null;
  if (!file) { pendingReceiptBlob = null; if (prev) prev.innerHTML = ''; return; }
  pendingReceiptBlob = file;
  if (prev && file.type.indexOf('image/') === 0) {
    var url = URL.createObjectURL(file);
    prev.innerHTML = '<img src="' + url + '" alt="receipt preview" style="width:100%;max-height:220px;object-fit:contain;border-radius:10px;background:#efece4;margin:8px 0">' +
      '<div id="ocr-status" class="small">Reading receipt on-device…</div>';
  }
  input.value = '';
  // On-device OCR prefill (non-blocking; manual entry always works).
  if (typeof OCR !== 'undefined' && OCR.scanReceipt && file.type.indexOf('image/') === 0) {
    try {
      OCR.scanReceipt(file, function (m) {
        var st = document.getElementById('ocr-status');
        if (st && m && m.status === 'recognizing text')
          st.textContent = 'Reading receipt on-device… ' + Math.round((m.progress || 0) * 100) + '%';
      }).then(function (r) {
        pendingReceiptOcr = r;
        var st = document.getElementById('ocr-status');
        var mEl = $('#rc-merchant'), dEl = $('#rc-date'), tEl = $('#rc-total');
        if (r && r.merchant_text && mEl && !mEl.value) mEl.value = r.merchant_text;
        if (r && r.receipt_date && dEl && !dEl.value) dEl.value = r.receipt_date;
        if (r && r.total_minor != null && tEl && !tEl.value) tEl.value = (r.total_minor / 100).toFixed(2);
        if (st) {
          var bits = [];
          if (r && r.merchant_text) bits.push('merchant: ' + r.merchant_text);
          if (r && r.total_minor != null) bits.push('total ' + (r.total_minor / 100).toFixed(2));
          if (r && r.line_items) bits.push(r.line_items.length + ' items');
          st.textContent = bits.length
            ? 'On-device read: ' + bits.join(' · ') + ' — check and fix as needed.'
            : 'Could not read this receipt — enter the fields manually.';
        }
      }).catch(function () {
        var st = document.getElementById('ocr-status');
        if (st) st.textContent = 'Could not read this receipt — enter the fields manually.';
      });
    } catch (e) { /* OCR is a convenience; manual entry remains */ }
  }
};

App.Actions['save-receipt'] = async function () {
  App.state.receiptMsg = '';
  var merchant = ($('#rc-merchant') && $('#rc-merchant').value.trim()) || '';
  var date = ($('#rc-date') && $('#rc-date').value) || '';
  var totalText = ($('#rc-total') && $('#rc-total').value.trim()) || '';
  if (!pendingReceiptBlob) { App.state.receiptMsg = 'Choose a photo first.'; App.render(); return; }
  if (!merchant) { App.state.receiptMsg = 'Enter the merchant name.'; App.render(); return; }
  var totalMinor = parseManualAmount(totalText);
  if (totalMinor == null) { App.state.receiptMsg = 'Enter the receipt total, e.g. 42.18.'; App.render(); return; }
  // V9 schema: receipts(id, date, amountMinor, merchantRaw, createdAt)
  // (+ imageBlob, currency, ocrConfidence, lineItems — on-device only).
  var rec = {
    imageBlob: pendingReceiptBlob, merchantRaw: merchant, date: date,
    amountMinor: totalMinor, currency: 'CAD', createdAt: Date.now(),
    ocrConfidence: pendingReceiptOcr ? pendingReceiptOcr.ocr_confidence : null,
    lineItems: pendingReceiptOcr ? pendingReceiptOcr.line_items : null
  };
  var id = await Store.put('receipts', rec);
  audit('receipt.added', 'receipt', id, { merchant: merchant, totalMinor: totalMinor,
    ocr: !!(pendingReceiptOcr && pendingReceiptOcr.ocr_confidence) });
  pendingReceiptBlob = null;
  pendingReceiptOcr = null;
  App.state.receiptMsg = '';
  App.render();
};

function parseManualAmount(text) {
  var m = /-?\$?\s*([\d,]+(?:\.\d{1,2})?)/.exec(String(text).replace(/,/g, ''));
  if (!m) return null;
  var v = Math.round(parseFloat(m[1]) * 100);
  return isNaN(v) ? null : v;
}

App.Actions['del-receipt'] = async function (d) {
  var rc = await sGet('receipts', d.id);
  if (!rc) return;
  await Store.delete('receipts', d.id);
  var ms = (await sAll('matches')).filter(function (m) { return String(m.receiptId) === String(d.id); });
  for (var i = 0; i < ms.length; i++) await Store.delete('matches', ms[i].id);
  // Clear the Engine's coverage handshake (V8: txns carry receiptId when linked).
  var txns = await sAll('txns');
  for (var j = 0; j < txns.length; j++) {
    if (String(txns[j].receiptId) === String(d.id)) { txns[j].receiptId = null; await Store.put('txns', txns[j]); }
  }
  audit('receipt.deleted', 'receipt', d.id, { merchant: rc.merchantRaw });
  App.render();
};

/** Score-time view of a receipt (V6).
    The Engine compares amountMinor by exact SIGNED equality, but receipts
    are stored as positive magnitudes while statement CSVs may carry
    purchases as negatives. Align the sign to the candidate txn so the
    comparison is a magnitude comparison — the same intent as the validation
    harness (|txn − receipt| ≤ 1). The stored receipt record is untouched,
    and the user still confirms every match. */
function receiptForScore(rc, txn) {
  var mag = Math.abs(rc.amountMinor || 0);
  return {
    amountMinor: ((txn.amountMinor || 0) < 0 ? -mag : mag),
    date: rc.date, merchantRaw: rc.merchantRaw, description: rc.merchantRaw
  };
}
/** Suggest matches for one receipt against the latest statement's purchases. */
App.Actions['find-matches'] = async function (d) {
  var safeId = (window.CSS && CSS.escape) ? CSS.escape(d.id) : String(d.id).replace(/[^a-zA-Z0-9_-]/g, '');
  var box = document.getElementById('match-' + safeId);
  var rc = await sGet('receipts', d.id);
  if (!rc) return;
  var stmts = await sAll('statements');
  if (!stmts.length) { if (box) box.innerHTML = '<p class="small">Import a statement first.</p>'; return; }
  stmts.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
  var txns = await sQuery('txns', 'statementId', stmts[0].id);
  var scored = [];
  txns.forEach(function (t) {
    if ((t.kind === 'purchase' || t.kind === 'cash_advance') && !t.excluded) {
      var res;
      // V6: the receipt record already has {amountMinor, date, merchantRaw};
      // receiptForScore aligns the stored positive magnitude to the txn's
      // sign convention before scoring.
      try { res = Engine.scoreReceiptMatch(t, receiptForScore(rc, t)); } catch (e) { return; }
      var score = Array.isArray(res) ? res[0] : 0;
      if (score >= 0.5) scored.push({ txn: t, score: score, reasons: Array.isArray(res) ? res[1] : [] });
    }
  });
  scored.sort(function (a, b) { return b.score - a.score; });
  var top = scored.slice(0, 3);
  if (!box) return;
  if (!top.length) {
    box.innerHTML = '<p class="small">No candidates scored ≥ 50%. It stays unmatched — that is the safe choice.</p>';
    return;
  }
  var html = '<p class="small"><strong>Match suggestions</strong> (confirm only if you are sure):</p>';
  top.forEach(function (s) {
    var t = nt(s.txn);
    html += '<div class="card" style="margin:6px 0"><div style="display:flex;gap:8px;align-items:center">' +
      '<div style="flex:1"><strong>' + esc(t.desc) + '</strong><br>' +
      '<span class="small">' + esc(t.date || '') + ' · ' + money(t.amountMinor) + ' · score ' + Math.round(s.score * 100) + '%</span><br>' +
      '<span class="tiny">' + esc((s.reasons || []).join(' · ')) + '</span></div>' +
      '<button class="btn ghost smallbtn" data-action="confirm-match" data-receipt="' + esc(rc.id) + '" data-txn="' + esc(t.id) + '">Confirm</button>' +
      '</div></div>';
  });
  box.innerHTML = html;
};

App.Actions['confirm-match'] = async function (d) {
  // Replace any earlier suggestion for the same pair with the confirmation.
  var existing = (await sAll('matches')).filter(function (m) {
    return String(m.receiptId) === String(d.receipt) && String(m.txnId) === String(d.txn);
  });
  for (var i = 0; i < existing.length; i++) await Store.delete('matches', existing[i].id);
  var id = await Store.put('matches', {
    receiptId: d.receipt, txnId: d.txn, status: 'confirmed',
    score: 1, reasons: ['confirmed by user'], createdAt: Date.now()
  });
  // V8 handshake: stamp receiptId on the txn so Engine.buildBriefing's
  // receipt coverage counts it.
  var txn = await sGet('txns', d.txn);
  if (txn) { txn.receiptId = d.receipt; await Store.put('txns', txn); }
  audit('match.confirmed', 'match', id, { receiptId: d.receipt, txnId: d.txn });
  App.render();
};

/* ============================================================================
 * Screen 4 — Clean statement
 * Reconciliation strip, filter tabs, review queue first, txn detail with
 * raw-vs-normalized, one-tap corrections, "make this a rule", duplicates.
 * ========================================================================== */

/** Tab key for a txn. */
function txnTab(t) {
  t = nt(t);
  if (t.excluded) return 'excluded';
  if (t.status === 'duplicate' || t.kind === 'duplicate-candidate') return 'duplicates';
  if (App.needsReview(t)) return 'uncertain';
  if (t.kind === 'refund') return 'refunds';
  if (t.kind === 'payment' || t.kind === 'transfer' || t.kind === 'fee') return 'payments';
  return 'purchases';
}

var SFILTERS = [
  ['review', 'Review'], ['purchases', 'Purchases'], ['refunds', 'Refunds'],
  ['payments', 'Payments & transfers'], ['duplicates', 'Duplicates'],
  ['uncertain', 'Uncertain'], ['excluded', 'Excluded']
];

/** A spend row (purchase/refund) with no category: it belongs in the review
 * queue ("Needs a category") while staying in its kind tab. Excluded and
 * duplicate rows are never flagged. */
function needsCategory(t) {
  t = t || {};
  var k = t.kind || 'uncertain';
  if (k !== 'purchase' && k !== 'refund') return false;
  var cat = (t.category !== null && t.category !== undefined && t.category !== '')
    ? t.category : (t.categoryId || null);
  if (cat) return false;
  if (t.excluded) return false;
  if (t.status === 'duplicate') return false;
  return true;
}

/** One shared rule for the review sign. The engine stamps confidence
 * 'needs_review' on every default-classified purchase (kindConfidence 0.6),
 * so the confidence band alone cannot be the trigger — it would flag every
 * transaction. A row needs a human look when the kind is unknown, the read
 * failed, the PDF read itself was uncertain (kindConfidence below 0.6), or
 * a spend row still has no category (the never-guess rule: unknown spend is
 * flagged, never silently trusted). A default-classified purchase that has
 * a category is resolved and shows no review sign. */
App.needsReview = function (t) {
  t = t || {};
  if (t.kind === 'uncertain') return true;
  if (t._error) return true;
  if (typeof t.kindConfidence === 'number' && t.kindConfidence < 0.6) return true;
  return needsCategory(t);
};

/** Review-queue rows for a txn list: App.needsReview rows — deduplicated,
 * so an uncategorized uncertain purchase counts once. */
App.reviewTxns = function (txns) {
  var seen = {}, out = [];
  (txns || []).forEach(function (t) {
    if (App.needsReview(t)) {
      var k = String(t.id);
      if (!seen[k]) { seen[k] = 1; out.push(t); }
    }
  });
  return out;
};

/** Map the Engine's reconcile balanceCheck for statements that carry no
 * reported baseline (CSV imports, manual-entry scopes): the Engine reports
 * 'no_baseline', which the UI presents as 'unavailable' — the check cannot
 * run without reported balances. A real baseline result ('ok'/'gap') is
 * never rewritten, and the 'no_baseline' mapping elsewhere is untouched. */
App.applyBalanceCheckPolicy = function (recon, statement) {
  var hasBaseline = !!(statement && typeof statement.reportedStartMinor === 'number' &&
    typeof statement.reportedEndMinor === 'number');
  if (recon && !hasBaseline && recon.balanceCheck === 'no_baseline') recon.balanceCheck = 'unavailable';
  return recon;
};

/** Pure txn search (node-testable): matches q against merchantRaw,
 * rawDescription, category id + name, amountMinor (minor-int text and
 * dollars text, e.g. "1234" and "12.34"), and date. The caller stores q
 * trimmed + lowercased (Changes['txn-search']); matching here is
 * defensive about case anyway. */
App.searchTxns = function (txns, q) {
  q = String(q == null ? '' : q).toLowerCase();
  if (!q) return (txns || []).slice();
  var out = [];
  (txns || []).forEach(function (t) {
    if (!t) return;
    var hay = [t.merchantRaw, t.rawDescription, t.category, catName(t.category), t.date];
    var a = (t.amountMinor === null || t.amountMinor === undefined) ? null : t.amountMinor;
    if (a !== null) hay.push(String(a), String(Math.abs(a)), dollarsText(a));
    if (hay.join(' ').toLowerCase().indexOf(q) !== -1) out.push(t);
  });
  return out;
};

App.vStatement = async function (v, seq) {
  var stmts = await sAll('statements');
  if (!stmts.length) {
    App.show(v, seq, '<h1>Statement</h1><div class="empty">No statements yet.<br><br>' +
      '<button class="btn" data-action="tab" data-tab="add">Add your first statement</button></div>');
    return;
  }
  stmts.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
  var st = stmts.filter(function (s) { return String(s.id) === String(App.state.statementId); })[0] || stmts[0];
  App.state.statementId = st.id;

  var txns = await sQuery('txns', 'statementId', st.id);
  txns.sort(function (a, b) { return (a.rowIndex || 0) - (b.rowIndex || 0); });
  App._stmtTxns = txns; // stable order for duplicate-candidate indexes

  var recon = null;
  var stmtReported = (st && typeof st.reportedStartMinor === 'number' && typeof st.reportedEndMinor === 'number')
    ? { startMinor: st.reportedStartMinor, endMinor: st.reportedEndMinor } : null;
  try { recon = Engine.reconcile(txns, stmtReported); } catch (e) { recon = null; }
  if (!recon) recon = { grossPurchasesMinor: 0, refundsTotalMinor: 0, excludedTotalMinor: 0, netSpendMinor: 0, unresolvedCount: 0, signedRowsSumMinor: 0, balanceCheck: 'unavailable', gapMinor: null };
  recon = App.applyBalanceCheckPolicy(recon, st);

  var counts = { review: 0, purchases: 0, refunds: 0, payments: 0, duplicates: 0, uncertain: 0, excluded: 0 };
  txns.forEach(function (t) {
    var k = txnTab(t); counts[k]++;
    if (k === 'uncertain' || k === 'duplicates') counts.review++;
    else if (needsCategory(t)) counts.review++; // uncategorized spend also needs a human look
  });

  var html = '<h1>Statement</h1>';
  if (stmts.length > 1) {
    html += '<label class="f" for="stmt-select">Statement</label><select id="stmt-select" data-change="statement-select">';
    stmts.forEach(function (s) {
      html += '<option value="' + esc(s.id) + '"' + (String(s.id) === String(st.id) ? ' selected' : '') + '>' +
        esc(s.scopeLabel || s.periodLabel || 'Statement') + '</option>';
    });
    html += '</select>';
  } else {
    html += '<p class="small">' + esc(st.scopeLabel || st.periodLabel || '') + ' · ' + txns.length + ' transactions</p>';
  }

  // Reconciliation strip: gross − refunds = net (the Engine sums SIGNED minor
  // units; we display labeled magnitudes so "net spend" never reads as a
  // negative). Excluded rows never enter gross, so they are an informational
  // note, not a subtraction line. When the statement carries reported
  // balances (PDF imports), the strip proves the rows add up to them.
  html += '<div class="strip" role="region" aria-label="Reconciliation">' +
    '<div class="s-row"><span>Gross purchases</span><span>' + spendAbs(recon.grossPurchasesMinor) + '</span></div>' +
    '<div class="s-row"><span>− Refunds</span><span>' + spendAbs(recon.refundsTotalMinor) + '</span></div>' +
    '<div class="s-row s-net"><span>Net spend</span><span>' + spendAbs(recon.netSpendMinor) + '</span></div>' +
    '<div class="s-note">' + (recon.unresolvedCount ? recon.unresolvedCount + ' unresolved · ' : '') +
    'balance check: ' + esc(String(recon.balanceCheck)) +
    (recon.gapMinor ? ' · gap ' + money(recon.gapMinor) : '') +
    (recon.excludedTotalMinor ? ' · excluded ' + spendAbs(recon.excludedTotalMinor) + ' (not counted)' : '') + '</div>';
  if (stmtReported) {
    html += '<div class="s-note">Reported: ' + money(stmtReported.startMinor) + ' → ' +
      money(stmtReported.endMinor) + ' · rows sum: ' + money(recon.signedRowsSumMinor) + '</div>';
  }
  html += '</div>';

  // Search box at the top of the statement list (change fires on Enter/blur).
  var q = (App.state.txnSearch || '').trim();
  html += '<div class="card" style="padding:8px 10px"><div style="display:flex;gap:8px;align-items:center">' +
    '<input type="search" id="txn-search" data-change="txn-search" placeholder="Search description, merchant, category, amount…" ' +
    'value="' + esc(App.state.txnSearch || '') + '" autocomplete="off" style="flex:1;min-width:0" aria-label="Search transactions">' +
    (q ? '<button class="btn ghost smallbtn" data-action="txn-search-clear">Clear</button>' : '') +
    '</div></div>';

  if (q) {
    // Search mode: chips are replaced by the result count + clear.
    var results = App._searchTxns = App.searchTxns(txns, q);
    html += '<div class="card"><div class="section-head"><h3 style="margin:0">' +
      results.length + ' result' + (results.length === 1 ? '' : 's') + ' for \u2018' + esc(q) + '\u2019</h3>' +
      '<button class="btn ghost smallbtn" data-action="txn-search-clear">Clear search</button></div></div>' +
      '<div id="txn-list">' + App.txnListHtml(results, 'search', counts, App.state.txnShown || App.TXN_PAGE_SIZE) + '</div>';
  } else {
    App._searchTxns = [];
    html += '<div class="tabs" role="tablist">';
    SFILTERS.forEach(function (f) {
      html += '<button class="chip' + (App.state.sfilter === f[0] ? ' on' : '') + '" role="tab" ' +
        'data-action="sfilter" data-f="' + f[0] + '">' + f[1] +
        '<span class="count">' + (counts[f[0]] || 0) + '</span></button>';
    });
    html += '</div><div id="txn-list">' + App.txnListHtml(txns, App.state.sfilter, counts, App.state.txnShown || App.TXN_PAGE_SIZE) + '</div>';
  }
  App._stmtCounts = counts; // for in-place "Show more" re-renders
  // Statement options: destructive actions live one tap down so the busy
  // transaction list stays clean. Tap-twice-to-confirm, like rule/budget/goal delete.
  html += '<details class="more"><summary>Statement options</summary>' +
    '<p class="small">Remove this statement and all ' + txns.length + ' of its transactions from this device. ' +
    'Receipts and other statements are kept. This cannot be undone.</p>' +
    '<button class="btn danger" data-action="statement-delete" data-id="' + esc(st.id) + '">Delete statement</button></details>';
  App.show(v, seq, html);
};

App.Changes['txn-search'] = function (el) {
  App.state.txnSearch = String(el.value || '').trim().toLowerCase();
  App.state.txnShown = App.TXN_PAGE_SIZE; // new query -> reset paging
  App.render();
};
App.Actions['txn-search-clear'] = function () {
  App.state.txnSearch = '';
  App.state.txnShown = App.TXN_PAGE_SIZE;
  App.render();
};

App.Changes['statement-select'] = function (el) {
  App.state.txnShown = App.TXN_PAGE_SIZE; // new statement -> reset paging
  App.go('statement', { statementId: el.value, txnId: null });
};
App.Actions.sfilter = function (d) { App.state.sfilter = d.f; App.state.txnId = null; App.state.txnShown = App.TXN_PAGE_SIZE; App.render(); };

/**
 * App.deleteStatement(statementId) -> Promise<{statementId, txnCount, matchCount}|null>.
 * Node-testable core of per-statement deletion: removes the statement record,
 * every txn carrying its statementId, and every row that references those
 * txns (matches, refund links, allocations). Writes a 'statement.deleted'
 * audit entry. Other statements are untouched. Returns null when the
 * statement does not exist.
 */
App.deleteStatement = async function (statementId) {
  var st = await sGet('statements', statementId);
  if (!st) return null;
  var txns = await sQuery('txns', 'statementId', st.id);
  var gone = {};
  for (var i = 0; i < txns.length; i++) gone[String(txns[i].id)] = 1;

  var nMatches = 0, nLinks = 0, nAllocs = 0;
  var matches = await sAll('matches');
  for (var m = 0; m < matches.length; m++) {
    if (gone[String(matches[m].txnId)]) { await Store.delete('matches', matches[m].id); nMatches++; }
  }
  var links = await sAll('refundLinks');
  for (var l = 0; l < links.length; l++) {
    if (gone[String(links[l].purchaseTxnId)] || gone[String(links[l].refundTxnId)]) {
      await Store.delete('refundLinks', links[l].id); nLinks++;
    }
  }
  var allocs = await sAll('allocations');
  for (var a = 0; a < allocs.length; a++) {
    if (gone[String(allocs[a].txnId)]) { await Store.delete('allocations', allocs[a].id); nAllocs++; }
  }
  for (var t = 0; t < txns.length; t++) { await Store.delete('txns', txns[t].id); }

  await Store.delete('statements', st.id);
  audit('statement.deleted', 'statement', st.id, {
    txnCount: txns.length, matchCount: nMatches, refundLinkCount: nLinks,
    allocationCount: nAllocs, periodLabel: st.periodLabel || st.scopeLabel || null
  });
  App.bumpDataRev();
  return { statementId: st.id, txnCount: txns.length, matchCount: nMatches };
};

/** Delete-statement button: same tap-twice-to-confirm pattern as rule/budget/goal delete. */
App.Actions['statement-delete'] = async function (d, el) {
  if (!el.dataset.armed) {
    el.dataset.armed = '1';
    el.textContent = 'Tap again to delete';
    setTimeout(function () { if (el.isConnected) { delete el.dataset.armed; el.textContent = 'Delete statement'; } }, 3000);
    return;
  }
  await App.deleteStatement(d.id);
  App.state.statementId = null;
  App.state.txnId = null;
  App.go('activity');
};

/** Duplicate candidate pairs for the current statement (indexes into App._stmtTxns).
 * Memoized: Engine.findDuplicateCandidates is O(n²), so we cache per
 * (statement, txn count, data revision). Every txn/rule mutation calls
 * App.bumpDataRev() to invalidate. */
App._dupCacheKey = function (statementId, txnCount, dataRev) {
  return String(statementId) + '|' + (txnCount || 0) + '|' + (dataRev || 0);
};
App.bumpDataRev = function () {
  App.state.dataRev = (App.state.dataRev || 0) + 1;
  App._dupCache = null;
};
App.dupPairs = function () {
  var txns = App._stmtTxns || [];
  var key = App._dupCacheKey(App.state.statementId, txns.length, App.state.dataRev);
  if (App._dupCache && App._dupCache.key === key) return App._dupCache.pairs;
  var pairs;
  try {
    pairs = Engine.findDuplicateCandidates(txns) || [];
    pairs = pairs.filter(function (p) { return Array.isArray(p) && txns[p[0]] && txns[p[1]]; });
  } catch (e) { pairs = []; }
  App._dupCache = { key: key, pairs: pairs };
  return pairs;
};

/** Pure pagination helper (node-testable): first `limit` rows + remainder. */
App._paginate = function (list, limit) {
  list = list || [];
  limit = Math.max(0, limit == null ? App.TXN_PAGE_SIZE : limit);
  return { rows: list.slice(0, limit), remaining: Math.max(0, list.length - limit) };
};
/** Statement list page size: rendering is capped so large statements stay smooth. */
App.TXN_PAGE_SIZE = 60;
App._moreBtn = function (remaining) {
  return '<button class="btn ghost" data-action="txn-more" style="width:100%;margin:8px 0">Show more (' +
    remaining + ' remaining)</button>';
};

App.txnRowHtml = function (t, ret) {
  t = nt(t);
  var amt = t.amountMinor;
  var cls = amt > 0 ? 't-amt pos' : 't-amt';
  var pills = '';
  if (t.status === 'duplicate') pills += ' <span class="pill bad">duplicate</span>';
  else if (App.needsReview(t)) pills += ' <span class="pill warn">review</span>';
  if (needsCategory(t)) pills += ' <span class="pill warn">no category</span>';
  // Opt-in merchant lookup: a low-confidence web suggestion never
  // categorizes the row — it shows as a hint in Review only (never-guess).
  if (!t.category && t.lookupHint) pills += ' <span class="pill dim">web suggests: ' + esc(t.lookupHint) + '</span>';
  if (t.excluded && t.status !== 'duplicate') pills += ' <span class="pill dim">excluded</span>';
  if (t.splits && t.splits.length) pills += ' <span class="pill dim">split</span>';
  return '<button class="txn" data-action="open-txn" data-id="' + esc(t.id) + '"' +
    (ret ? ' data-ret="' + esc(ret) + '"' : '') + '>' +
    '<span class="t-main"><span class="t-desc">' + esc(t.desc || '(no description)') + '</span><br>' +
    '<span class="t-sub">' + esc(fmtDate(t.date)) + ' · ' + esc(kindLabel(t.kind)) + pills + '</span></span>' +
    '<span class="' + cls + '">' + money(amt) + '</span></button>';
};

App.txnListHtml = function (txns, filter, counts, limit) {
  limit = limit == null ? App.TXN_PAGE_SIZE : limit;
  var html = '';
  if (filter === 'review') {
    var pairs = App.dupPairs();
    var unc = txns.filter(function (t) { return txnTab(t) === 'uncertain'; });
    // Every uncategorized spend row belongs in the "Needs a category"
    // section — even when it is also kind-uncertain (the common case: kind
    // confidence 'needs_review' puts purchases in the uncertain tab). Rows
    // shown there are not repeated in the plain uncertain list below.
    var noCat = txns.filter(function (t) { return needsCategory(t); });
    if (!pairs.length && !unc.length && !noCat.length)
      return '<div class="empty">Nothing needs review. 🎉</div>';
    html += '<p class="small"><strong>Review queue</strong> — resolve only what is material. ' +
      'Each fix can become a reusable rule.</p>';
    pairs.forEach(function (p) {
      var a = nt(App._stmtTxns[p[0]]), b = nt(App._stmtTxns[p[1]]);
      html += '<div class="card"><p class="small" style="margin-top:0"><strong>Possible duplicate</strong> — ' +
        esc(p[2] || 'similar transactions') + '</p><div class="duo">' +
        '<div class="txn"><span class="t-main"><span class="t-desc">' + esc(a.desc) + '</span><br>' +
          '<span class="t-sub">' + esc(fmtDate(a.date)) + '</span></span><span class="t-amt">' + money(a.amountMinor) + '</span>' +
          '<button class="btn ghost smallbtn" data-action="dup-markdup" data-id="' + esc(a.id) + '" data-other="' + esc(b.id) + '">Mark as duplicate</button></div>' +
        '<div class="txn"><span class="t-main"><span class="t-desc">' + esc(b.desc) + '</span><br>' +
          '<span class="t-sub">' + esc(fmtDate(b.date)) + '</span></span><span class="t-amt">' + money(b.amountMinor) + '</span>' +
          '<button class="btn ghost smallbtn" data-action="dup-markdup" data-id="' + esc(b.id) + '" data-other="' + esc(a.id) + '">Mark as duplicate</button></div>' +
        '</div><button class="btn ghost smallbtn" data-action="dup-keep" data-a="' + esc(a.id) + '" data-b="' + esc(b.id) + '">Keep both — not duplicates</button></div>';
    });
    var uncRest = unc.filter(function (t) { return !needsCategory(t); });
    var upg = App._paginate(uncRest, limit);
    upg.rows.forEach(function (t) { html += App.txnRowHtml(t); });
    if (upg.remaining) html += App._moreBtn(upg.remaining);
    if (noCat.length) {
      html += '<p class="small" style="margin-top:14px"><strong>Needs a category</strong> — ' +
        noCat.length + ' purchase' + (noCat.length === 1 ? '' : 's') +
        ' couldn\u2019t be categorized automatically. Tap one and choose its category, or run ' +
        'Auto-categorize under More.</p>';
      var ncg = App._paginate(noCat, limit);
      ncg.rows.forEach(function (t) { html += App.txnRowHtml(t); });
      if (ncg.remaining) html += App._moreBtn(ncg.remaining);
    }
    return html;
  }
  if (filter === 'search') {
    // Search results are pre-filtered by App.searchTxns; render as-is.
    var q = (App.state.txnSearch || '').trim();
    if (!txns.length) return '<div class="empty">No matches for \u2018' + esc(q) + '\u2019.</div>';
    var spg = App._paginate(txns, limit);
    spg.rows.forEach(function (t) { html += App.txnRowHtml(t); });
    if (spg.remaining) html += App._moreBtn(spg.remaining);
    return html;
  }
  var list = txns.filter(function (t) { return txnTab(t) === filter; });
  if (!list.length) {
    var names = { purchases: 'purchases', refunds: 'refunds', payments: 'payments, transfers or fees', duplicates: 'duplicates', uncertain: 'uncertain transactions', excluded: 'excluded transactions' };
    return '<div class="empty">No ' + (names[filter] || filter) + ' in this statement.</div>';
  }
  if (filter === 'duplicates') {
    html += '<p class="small">Marked duplicates are excluded from spend. Candidate pairs live in the <strong>Review</strong> tab.</p>';
  }
  var pg = App._paginate(list, limit);
  pg.rows.forEach(function (t) { html += App.txnRowHtml(t); });
  if (pg.remaining) html += App._moreBtn(pg.remaining);
  return html;
};
/** "Show more" appends the next page of rows in place (no full re-render,
 * so scroll position and the review queue stay put). */
App.Actions['txn-more'] = function () {
  App.state.txnShown = (App.state.txnShown || App.TXN_PAGE_SIZE) + App.TXN_PAGE_SIZE;
  var el = document.getElementById('txn-list');
  if (el) {
    var searchMode = (App.state.txnSearch || '').trim() !== '';
    var src = searchMode ? (App._searchTxns || []) : (App._stmtTxns || []);
    var flt = searchMode ? 'search' : App.state.sfilter;
    el.innerHTML = App.txnListHtml(src, flt, App._stmtCounts || {}, App.state.txnShown);
  }
};

/* ---------- txn detail ---------- */

App.vTxnDetail = async function (v, seq) {
  var t = await sGet('txns', App.state.txnId);
  if (!t) { App.go('statement', { txnId: null }); return; }
  t = nt(t); var raw = t._raw;

  var html = '<button class="linklike" data-action="txn-back">← Back to list</button>';
  html += '<h1 style="font-size:20px">' + esc(t.desc || '(no description)') + '</h1>';
  html += '<div class="headline-num">' + money(t.amountMinor) + '</div>';
  html += '<div><span class="pill">' + esc(kindLabel(t.kind)) + '</span> ' +
    (function () {
      // The engine's 'needs_review' band fires on every default-classified
      // purchase (kindConfidence 0.6), so label from kindConfidence instead:
      // only genuinely uncertain rows get the warn treatment.
      var kc = (typeof t.kindConfidence === 'number') ? t.kindConfidence : null;
      var uncertainRow = (t.kind === 'uncertain') || !!t._error || (kc !== null && kc < 0.6);
      var label = kc === null
        ? (t.confidence ? String(t.confidence).replace(/_/g, ' ') : '')
        : kc >= 0.95 ? 'confirmed' : kc >= 0.80 ? 'likely' : kc >= 0.6 ? 'assumed' : 'needs review';
      return label ? '<span class="pill ' + (uncertainRow ? 'warn' : 'dim') + '">' + esc(label) + '</span> ' : '';
    })() +
    (t.excluded ? '<span class="pill dim">excluded</span> ' : '') +
    (t.status === 'duplicate' ? '<span class="pill bad">duplicate</span>' : '') + '</div>';

  html += '<div class="card"><h3 style="margin-top:0">Classification</h3><table class="kv">' +
    '<tr><th>Kind</th><td>' + esc(kindLabel(t.kind)) + '</td></tr>' +
    '<tr><th>Why</th><td>' + esc(t.kindReason || '—') + '</td></tr>' +
    '<tr><th>Source</th><td>' + esc(t.classificationSource || '—') + '</td></tr>' +
    '<tr><th>Kind confidence</th><td>' + esc(t.kindConfidence != null ? t.kindConfidence : '—') + '</td></tr>' +
    '<tr><th>Category</th><td>' + esc(catName(t.category)) + '</td></tr>' +
    // Opt-in merchant lookup: a weak web suggestion never changes the
    // category — it shows as a hint only (never-guess).
    (!t.category && t.lookupHint ? '<tr><th>Web hint</th><td>web suggests: ' + esc(t.lookupHint) + '</td></tr>' : '') +
    '<tr><th>Status</th><td>' + esc(t.status) + '</td></tr></table></div>';

  // Per-category splits (purchases only, never excluded/duplicates).
  if (t.kind === 'purchase' && !t.excluded && t.status !== 'duplicate') {
    html += App.splitSectionHtml(t);
  }

  html += '<div class="card"><h3 style="margin-top:0">Normalized</h3><table class="kv">' +
    '<tr><th>Date</th><td>' + esc(t.date || '—') + '</td></tr>' +
    '<tr><th>Merchant</th><td>' + esc(t.desc || '—') + '</td></tr>' +
    '<tr><th>Amount</th><td>' + money(t.amountMinor) + ' ' + esc(t.currency) + '</td></tr>' +
    '<tr><th>Spend amount</th><td>' + (t.spendAmountMinor != null ? money(t.spendAmountMinor) : '—') + '</td></tr></table></div>';

  html += '<details class="more"><summary>Raw source row</summary><table class="kv">' +
    '<tr><th>Raw date</th><td class="mono">' + esc(t.rawDate) + '</td></tr>' +
    '<tr><th>Raw description</th><td class="mono">' + esc(t.rawDesc) + '</td></tr>' +
    '<tr><th>Raw amount</th><td class="mono">' + esc(t.rawAmount) + '</td></tr>' +
    '<tr><th>Row #</th><td>' + esc(t.rowIndex) + '</td></tr></table></details>';

  // Related: receipt matches + refund links.
  var rel = '';
  var ms = (await sAll('matches')).filter(function (m) { return String(m.txnId) === String(t.id); });
  if (ms.length) {
    rel += '<div class="card"><h3 style="margin-top:0">Receipts</h3>';
    for (var i = 0; i < ms.length; i++) {
      var rc = await sGet('receipts', ms[i].receiptId);
      rel += '<p class="small">' + (ms[i].status === 'confirmed' ? '✓ Confirmed' : '○ Suggested') +
        ' match: <strong>' + esc(rc ? rc.merchantRaw : 'receipt') + '</strong> ' +
        (ms[i].score ? '(' + Math.round(ms[i].score * 100) + '%)' : '') + '</p>';
    }
    rel += '</div>';
  }
  var links = (await sAll('refundLinks')).filter(function (l) {
    return String(l.refundTxnId) === String(t.id) || String(l.purchaseTxnId) === String(t.id);
  });
  if (links.length) {
    rel += '<div class="card"><h3 style="margin-top:0">Refund links</h3>';
    for (var j = 0; j < links.length; j++) {
      var otherId = String(links[j].refundTxnId) === String(t.id) ? links[j].purchaseTxnId : links[j].refundTxnId;
      var other = await sGet('txns', otherId);
      rel += '<p class="small">' + (String(links[j].refundTxnId) === String(t.id) ? 'Possible original purchase' : 'Possible refund') +
        ': <button class="src-txn" data-action="open-txn" data-id="' + esc(otherId) + '">' +
        esc(other ? (other.merchantRaw || other.rawDescription || '') : '(gone)') + '</button> ' +
        '<span class="tiny">(' + esc(links[j].basis || '') + ' · ' + esc(links[j].status || 'suggested') + ')</span></p>';
    }
    rel += '</div>';
  }
  html += rel;

  // Corrections.
  html += '<div class="card"><h3 style="margin-top:0">Correct this transaction</h3>';
  // Confirm-kind is offered when the kind itself is uncertain (unknown kind,
  // read error, or low kind confidence) — not for every default-classified
  // purchase. Category fixes are handled by the category selector below.
  var kc2 = (typeof t.kindConfidence === 'number') ? t.kindConfidence : null;
  if (t.kind === 'uncertain' || t._error || (kc2 !== null && kc2 < 0.6)) {
    html += '<button class="btn" data-action="confirm-kind" data-id="' + esc(t.id) + '">Confirm: it really is ' + esc(kindLabel(t.kind)) + '</button>';
  }
  var kinds = (Engine.KINDS && Engine.KINDS.slice()) || ['purchase', 'refund', 'payment', 'transfer', 'fee', 'cash_advance', 'uncertain'];
  html += '<label class="f" for="kind-sel">Change kind</label><select id="kind-sel" data-change="kind-select" data-id="' + esc(t.id) + '">' +
    '<option value="">— choose —</option>' +
    kinds.map(function (k) { return '<option value="' + k + '"' + (t.kind === k ? ' selected' : '') + '>' + esc(kindLabel(k)) + '</option>'; }).join('') +
    '</select>';
  html += '<label class="f" for="cat-sel">Change category</label><select id="cat-sel" data-change="cat-select" data-id="' + esc(t.id) + '">' +
    App.categories.map(function (c) {
      return '<option value="' + esc(c.id) + '"' + (String(t.category) === String(c.id) ? ' selected' : '') + '>' + esc(c.name) + '</option>';
    }).join('') + '</select>';
  html += '<button class="btn ghost" data-action="toggle-exclude" data-id="' + esc(t.id) + '">' +
    (t.excluded ? 'Include back in spend' : 'Exclude from spend') + '</button></div>';

  // Pending "make this a rule" offer.
  if (App.state.ruleOffer && String(App.state.ruleOffer.txnId) === String(t.id)) {
    var off = App.state.ruleOffer;
    html += '<div class="card" style="border-color:var(--accent)"><h3 style="margin-top:0">Make this a rule?</h3>' +
      '<p>' + esc(off.scopeDescription || 'This correction can be reused.') + '</p>';
    if (off.field === 'category') {
      // Category corrections: let the user pick the rule's category before
      // saving (the txn already got the chosen one via the detail form).
      html += '<label class="f" for="rule-cat-sel">Category this rule will apply</label>' +
        '<select id="rule-cat-sel" data-change="rule-cat-select">' +
        App.categories.map(function (c) {
          return '<option value="' + esc(c.id) + '"' + (String(off.newValue) === String(c.id) ? ' selected' : '') + '>' + esc(c.name) + '</option>';
        }).join('') + '</select>';
    }
    html += '<p class="small">The rule will apply to <strong>future imports</strong> automatically. You can disable or delete it any time under More → Rules.</p>' +
      '<div class="btn-row"><button class="btn" data-action="confirm-rule">Save rule</button>' +
      '<button class="btn ghost" data-action="cancel-rule">Not now</button></div></div>';
  }

  App.show(v, seq, html);
};

/* ---------- per-category splits ---------- */

/** Split section on the txn detail: current split table, the edit form, or
 * the entry button. Purchases only (the caller gates kind/excluded/status). */
App.splitSectionHtml = function (t) {
  var total = spendOf(t); // |spend| magnitude
  var html = '<div class="card"><h3 style="margin-top:0">Split across categories</h3>';
  if (t.splits && t.splits.length) {
    html += '<table class="kv">';
    t.splits.forEach(function (s) {
      html += '<tr><th>' + esc(catLabelSmart(s.category)) + '</th><td>' + money(s.amountMinor) + '</td></tr>';
    });
    var splitTotal = t.splits.reduce(function (a, s) { return a + (s.amountMinor || 0); }, 0);
    html += '</table><p class="small">Split total ' + money(splitTotal) + ' — matches the transaction\u2019s ' +
      money(total) + '.</p>' +
      '<div class="btn-row"><button class="btn ghost smallbtn" data-action="split-start" data-id="' + esc(t.id) + '">Edit split</button>' +
      '<button class="btn ghost smallbtn" data-action="split-remove" data-id="' + esc(t.id) + '">Remove split</button></div>';
  } else if (App.state.splitForm && String(App.state.splitForm.txnId) === String(t.id)) {
    html += App.splitFormHtml(t);
  } else {
    html += '<p class="small">Divide this ' + money(total) + ' purchase across up to 5 categories. ' +
      'The parts must add up exactly — budgets, movers, and briefings all honor the split.</p>' +
      '<button class="btn ghost" data-action="split-start" data-id="' + esc(t.id) + '">Split across categories</button>';
  }
  html += '</div>';
  return html;
};

App.splitFormHtml = function (t) {
  var f = App.state.splitForm;
  var total = spendOf(t);
  var html = '<p class="small">Split ' + money(total) + ' across categories — the parts must add up exactly.</p>';
  if (f.error) html += '<div class="banner bad">' + esc(f.error) + '</div>';
  f.rows.forEach(function (r, i) {
    html += '<div style="display:flex;gap:8px;margin-bottom:8px">' +
      '<select id="split-cat-' + i + '" style="flex:1;min-width:0" aria-label="Category for part ' + (i + 1) + '">' +
      '<option value="">— category —</option>' +
      App.categories.map(function (c) {
        return '<option value="' + esc(c.id) + '"' + (r.cat === c.id ? ' selected' : '') + '>' + esc(c.name) + '</option>';
      }).join('') + '</select>' +
      '<input type="text" id="split-amt-' + i + '" inputmode="decimal" autocomplete="off" placeholder="0.00" ' +
      'value="' + esc(r.amt) + '" style="width:110px" aria-label="Amount for part ' + (i + 1) + '"></div>';
  });
  html += '<div class="btn-row">' +
    (f.rows.length < 5 ? '<button class="btn ghost smallbtn" data-action="split-addrow" data-id="' + esc(t.id) + '">+ Add row</button>' : '') +
    '<button class="btn ghost smallbtn" data-action="split-even" data-id="' + esc(t.id) + '">Split evenly</button>' +
    '</div><div class="btn-row" style="margin-top:8px">' +
    '<button class="btn" data-action="split-save" data-id="' + esc(t.id) + '">Save split</button>' +
    '<button class="btn ghost" data-action="split-cancel">Cancel</button></div>';
  return html;
};

/** Read the live form inputs back into App.state.splitForm.rows (so + Add
 * row and Split evenly never lose what was already typed). */
function readSplitFormRows() {
  var f = App.state.splitForm;
  if (!f || typeof document === 'undefined') return;
  for (var i = 0; i < f.rows.length; i++) {
    var catEl = document.getElementById('split-cat-' + i);
    var amtEl = document.getElementById('split-amt-' + i);
    if (catEl) f.rows[i].cat = catEl.value;
    if (amtEl) f.rows[i].amt = amtEl.value;
  }
}

App.Actions['split-start'] = function (d) {
  App.state.splitForm = { txnId: d.id, rows: [{ cat: '', amt: '' }, { cat: '', amt: '' }], error: '' };
  App.render();
};
App.Actions['split-cancel'] = function () { App.state.splitForm = null; App.render(); };
App.Actions['split-addrow'] = function () {
  var f = App.state.splitForm;
  if (!f || f.rows.length >= 5) return;
  readSplitFormRows();
  f.rows.push({ cat: '', amt: '' });
  f.error = '';
  App.render();
};
App.Actions['split-even'] = function () {
  var f = App.state.splitForm;
  if (!f) return;
  readSplitFormRows();
  // Amounts come from the stored txn (integer math throughout).
  sGet('txns', f.txnId).then(function (txn) {
    if (!txn) return;
    var total = Math.abs((txn.spendAmountMinor != null ? txn.spendAmountMinor : txn.amountMinor) || 0);
    var shares = Engine.splitEvenly(total, f.rows.length);
    for (var i = 0; i < f.rows.length; i++) f.rows[i].amt = dollarsText(shares[i]);
    f.error = '';
    App.render();
  });
};
App.Actions['split-save'] = async function (d) {
  var t = await sGet('txns', d.id);
  var f = App.state.splitForm;
  if (!t || !f) return;
  var total = Math.abs((t.spendAmountMinor != null ? t.spendAmountMinor : t.amountMinor) || 0);
  var splits = [], sum = 0;
  for (var i = 0; i < f.rows.length; i++) {
    var catEl = document.getElementById('split-cat-' + i);
    var amtEl = document.getElementById('split-amt-' + i);
    var cat = catEl ? catEl.value : '';
    var rawAmt = amtEl ? amtEl.value : '';
    var amt = App.parseDollarsToMinor(rawAmt);
    if (!cat || amt === null || amt <= 0) {
      f.error = 'Every row needs a category and an amount over $0.00.';
      App.render(); return;
    }
    splits.push({ category: cat, amountMinor: amt });
    sum += amt;
    f.rows[i].cat = cat; f.rows[i].amt = rawAmt;
  }
  if (sum !== total) {
    f.error = 'Split amounts must add up to ' + money(total) + ' (currently ' + money(sum) + ').';
    App.render(); return;
  }
  t.splits = splits; // positive magnitudes, summing to exactly |spend|
  if (t.status === 'new') t.status = 'reviewed';
  await Store.put('txns', t);
  audit('txn.split_saved', 'txn', t.id, { splits: splits });
  App.state.splitForm = null;
  App.bumpDataRev();
  App.render();
};
App.Actions['split-remove'] = async function (d) {
  var t = await sGet('txns', d.id);
  if (!t || !t.splits) return;
  delete t.splits; // restores the single-category row
  await Store.put('txns', t);
  audit('txn.split_removed', 'txn', t.id, {});
  App.bumpDataRev();
  App.render();
};

/* ---------- corrections & rules ---------- */

App.applyCorrection = async function (txnId, field, newValue) {
  var t = await sGet('txns', txnId);
  if (!t) return;
  var oldValue = field === 'kind' ? (t.kind || 'uncertain')
    : (field === 'category' ? (t.category || 'uncategorized') : !!t.excluded);
  if (String(oldValue) === String(newValue)) return;

  if (field === 'kind') {
    t.kind = newValue;
    t.classificationSource = 'user'; // V4: applyRules never overrides user corrections
  }
  else if (field === 'category') {
    t.category = newValue;
    // A user-set category is sacred: autoCategorize and applyRules never
    // overwrite it (categorySource==='user'), and backfill skips it.
    t.categorySource = 'user';
    t.categoryConfidence = 1.0;
    t.categoryReason = 'set by user';
  }
  else if (field === 'excluded') t.excluded = newValue ? 1 : 0; // V7: reconcile checks ===1
  if (t.status === 'new') t.status = 'reviewed';
  await Store.put('txns', t); // put() with an existing id upserts
  App.bumpDataRev(); // txn changed -> duplicate cache invalid

  var corr = { txnId: txnId, field: field, oldValue: String(oldValue), newValue: String(newValue), createdAt: Date.now() };
  var corrId = await Store.put('corrections', corr);
  audit('correction.applied', 'txn', txnId, { field: field, oldValue: corr.oldValue, newValue: corr.newValue });

  // Offer a reusable household rule for future imports.
  // The Engine builds BOTH kind and category rules via makeRuleFromCorrection
  // (deterministic ids; category folded into the id hash). App-owned
  // appMatch payloads travel alongside for UI scope text and the dropdown.
  var pastRows = await sQuery('txns', 'statementId', t.statementId);
  var core = merchantCore(t.merchantRaw || t.rawDescription);
  var offer = null;
  if (field === 'kind') {
    try {
      var res = Engine.makeRuleFromCorrection(
        { merchantRaw: t.merchantRaw || t.rawDescription, kind: newValue,
          label: kindLabel(newValue) + ' — ' + core },
        pastRows);
      if (res && res.rule) {
        offer = { correctionId: corrId, txnId: txnId, field: field,
          oldValue: corr.oldValue, newValue: corr.newValue,
          rule: res.rule, scopeDescription: res.scopeDescription,
          appMatch: { merchantContains: res.rule.matchMerchant || core, field: field, value: newValue } };
      }
    } catch (e) { offer = null; }
  } else if (field === 'category') {
    try {
      var resC = Engine.makeRuleFromCorrection(
        { merchantRaw: t.merchantRaw || t.rawDescription, category: newValue,
          label: 'Category: ' + catName(newValue) + ' — ' + core },
        pastRows);
      if (resC && resC.rule) {
        offer = { correctionId: corrId, txnId: txnId, field: field,
          oldValue: corr.oldValue, newValue: corr.newValue,
          rule: resC.rule, scopeDescription: resC.scopeDescription,
          appMatch: { merchantContains: resC.rule.matchMerchant || core, field: field, setCategory: newValue } };
      }
    } catch (e) { offer = null; }
  }
  App.state.ruleOffer = offer;
  App.render();
};

App.Changes['kind-select'] = function (el) {
  if (el.value) App.applyCorrection(el.dataset.id, 'kind', el.value);
};
App.Changes['cat-select'] = function (el) {
  if (el.value) App.applyCorrection(el.dataset.id, 'category', el.value);
};
App.Actions['toggle-exclude'] = function (d) {
  sGet('txns', d.id).then(function (t) {
    if (t) App.applyCorrection(d.id, 'excluded', t.excluded ? 0 : 1);
  });
};
App.Actions['confirm-kind'] = function (d) {
  // "Confirm" records that a human reviewed an uncertain/low-confidence row.
  sGet('txns', d.id).then(async function (t) {
    if (!t) return;
    t.status = 'reviewed';
    await Store.put('txns', t);
    await Store.put('corrections', { txnId: d.id, field: 'kind', oldValue: t.kind, newValue: t.kind, confirmed: true, createdAt: Date.now() });
    audit('correction.confirmed', 'txn', d.id, { kind: t.kind });
    App.bumpDataRev();
    App.render();
  });
};

App.Actions['make-rule'] = function () { /* offer renders automatically after a correction */ };
/** Change the pending category rule's category before saving it. The
 * Engine rule is rebuilt so its deterministic id folds in the new
 * category; the appMatch payload keeps the UI scope text in sync. */
App.Changes['rule-cat-select'] = function (el) {
  var off = App.state.ruleOffer;
  if (!off || off.field !== 'category' || !el.value) return;
  off.newValue = el.value;
  try {
    var res = Engine.makeRuleFromCorrection(
      { merchantRaw: off.appMatch.merchantContains, category: el.value,
        label: 'Category: ' + catName(el.value) + ' — ' + off.appMatch.merchantContains },
      []);
    if (res && res.rule) { off.rule = res.rule; off.scopeDescription = res.scopeDescription; }
  } catch (e) { /* keep the previous offer on rebuild failure */ }
  off.appMatch.setCategory = el.value;
  App.render();
};
App.Actions['confirm-rule'] = async function () {
  var off = App.state.ruleOffer;
  if (!off) return;
  // V4/V9: store FLAT in the Engine's applyRules shape {id, enabled,
  // priority, matchMerchant, kind, category, label} + our metadata.
  // Deterministic ids (Engine.makeRuleFromCorrection) make re-saving the
  // same rule an upsert, not a duplicate.
  var ruleId = (off.rule && off.rule.id) ||
    ('catrule_' + sha256Hex(off.appMatch.merchantContains + '|' + off.newValue).slice(0, 16));
  var rec = {
    id: ruleId,
    enabled: true,
    priority: (off.rule && off.rule.priority) || 100,
    matchMerchant: (off.rule && off.rule.matchMerchant) || off.appMatch.merchantContains,
    kind: (off.rule && off.rule.kind) || null,
    // Category rides on the flat rule record: Engine.applyRules and
    // Engine.autoCategorize both honor it (rule.category wins over
    // built-in suggestions). Legacy appMatch.setCategory is kept for
    // already-stored rules; ruleCategoryOf() reads both.
    category: (off.rule && off.rule.category) || (off.field === 'category' ? off.newValue : null),
    label: (off.rule && off.rule.label) || ('Category: ' + catName(off.newValue)),
    source: 'correction',
    createdAt: Date.now(),
    ruleType: off.field === 'kind' ? 'kind_override' : 'category',
    scopeDescription: off.scopeDescription,
    appMatch: off.appMatch // app-level matcher (category rules; kind rules reuse matchMerchant)
  };
  var id = await Store.put('householdRules', rec);
  // Link the correction to its rule (upsert).
  var corr = await sGet('corrections', off.correctionId);
  if (corr) { corr.madeRuleId = id; await Store.put('corrections', corr); }
  audit('rule.created', 'householdRule', id, { field: off.field, value: off.newValue, scope: off.scopeDescription });
  App.state.ruleOffer = null;
  // A confirmed category rule teaches the existing ledger immediately:
  // similar transactions that were never categorized get the category now
  // (user-set categories are never touched). Kind rules stay future-only —
  // reclassifying kind retroactively would rewrite spend/excluded history.
  if (rec.category) {
    await App.runAutocatBackfill();
    return;
  }
  App.bumpDataRev(); // rules change classification -> duplicate cache invalid
  App.render();
};
App.Actions['cancel-rule'] = function () { App.state.ruleOffer = null; App.render(); };

/* ---------- duplicate decisions ---------- */

App.Actions['dup-keep'] = async function (d) {
  for (var k = 0; k < 2; k++) {
    var id = k === 0 ? d.a : d.b;
    var t = await sGet('txns', id);
    if (t) { t.status = 'reviewed'; await Store.put('txns', t); }
  }
  await Store.put('corrections', { txnId: d.a, field: 'duplicate', oldValue: 'candidate', newValue: 'keep-both', createdAt: Date.now() });
  audit('duplicate.kept', 'txn', d.a, { other: d.b });
  App.bumpDataRev();
  App.render();
};
App.Actions['dup-markdup'] = async function (d) {
  var t = await sGet('txns', d.id);
  if (!t) return;
  t.status = 'duplicate'; t.excluded = 1; // V7: duplicates don't count toward spend
  await Store.put('txns', t);
  await Store.put('corrections', { txnId: d.id, field: 'duplicate', oldValue: 'candidate', newValue: 'duplicate', createdAt: Date.now() });
  audit('duplicate.marked', 'txn', d.id, { kept: d.other });
  App.bumpDataRev();
  App.render();
};

/* ============================================================================
 * Screen 5 — Your Month (home after first import)
 * Renders Engine.renderBriefingText as the source of truth, plus structured
 * sections derived from contract-guaranteed data (txns + reconcile), with
 * driver cards linking to transactions. "This explanation is wrong" routes
 * to the underlying transactions in the Statement view.
 * ========================================================================== */

function spendOf(t) {
  var s = t.spendAmountMinor != null ? t.spendAmountMinor : t.amountMinor;
  return Math.abs(s || 0);
}

/* ---------------- Month: trends, movers, budgets summary (Phase 3) ---------------- */

/** Last n calendar months ending at `anchor` ('YYYY-MM'), oldest -> newest. */
function lastNMonths(anchor, n) {
  var out = [];
  var ym = anchor;
  for (var i = 0; i < n; i++) { out.unshift(ym); ym = prevMonthOf(ym); }
  return out;
}

/** Trends section: last 6 calendar months ending at the latest statement's
 * periodEnd (else the current month), via pure Engine.monthlyNetSpend. */
/** Net-spend trend chart. monthAnchor: 'YYYY-MM' to end the 6-month window
 * at (Month tab, month-scoped); defaults to the Plan/statement default. */
App.trendsHtml = async function (monthAnchor) {
  var stmts = await sAll('statements');
  var anchor = (/^\d{4}-\d{2}$/.test(monthAnchor || ''))
    ? monthAnchor : App.defaultBudgetMonth(stmts);
  var windowMonths = lastNMonths(anchor, 6);
  var monthly = [];
  try { monthly = Engine.monthlyNetSpend(await sAll('txns'), await sAll('refundLinks')) || []; } catch (e) { monthly = []; }
  var byMonth = {};
  var anyReturnAdj = false;
  monthly.forEach(function (r) {
    byMonth[r.month] = r.netMinor;
    if (r.returnAdjMinor) anyReturnAdj = true;
  });
  var present = 0;
  var data = windowMonths.map(function (m) {
    if (byMonth[m] !== undefined) present++;
    return { month: m, netMinor: byMonth[m] !== undefined ? byMonth[m] : 0 };
  });
  App._trendData = data; // picked up by the post-render draw call
  var html = '<h2>Trends</h2>';
  if (present < 2) {
    return html + '<div class="card"><p class="small" style="margin:0">Not enough history yet — ' +
      'trends appear once you have transactions in at least two months.</p></div>';
  }
  return html + '<div class="card"><canvas id="trend-canvas" width="680" height="240" ' +
    'style="width:100%;display:block" role="img" aria-label="Net spend per month, last 6 months"></canvas>' +
    '<p class="tiny" style="margin:8px 0 0">Net spend per month (after refunds), magnitudes.' +
    (anyReturnAdj ? ' Returns are attributed to the month of the original purchase.' : '') + '</p></div>';
};

/** Hand-rolled bar chart for monthly net spend. No dependencies: scales by
 * devicePixelRatio, draws one bar per month sized by |netMinor| (min 1px
 * for zero), month labels, and value labels via Engine.fmtMoney. */
App.drawTrends = function (canvas, data) {
  if (!canvas || !data || data.length < 2) return;
  var dpr = (typeof window !== 'undefined' && window.devicePixelRatio) ? window.devicePixelRatio : 1;
  var W = 680, H = 240;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  var ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  var accent = '#0e6e64', ink = '#1d1a15', muted = '#5f584c';
  try {
    var cs = (typeof getComputedStyle !== 'undefined' && typeof document !== 'undefined')
      ? getComputedStyle(document.documentElement) : null;
    if (cs) {
      accent = cs.getPropertyValue('--accent').trim() || accent;
      ink = cs.getPropertyValue('--ink').trim() || ink;
      muted = cs.getPropertyValue('--muted').trim() || muted;
    }
  } catch (e) { /* hardcoded palette fallback */ }
  var padT = 34, padB = 30, padX = 10;
  var baseY = H - padB, maxBarH = H - padT - padB;
  var maxV = 0;
  data.forEach(function (d) { maxV = Math.max(maxV, Math.abs(d.netMinor || 0)); });
  if (maxV === 0) maxV = 1;
  var n = data.length;
  var slot = (W - padX * 2) / n;
  var barW = Math.min(72, slot * 0.62);
  var monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  ctx.textAlign = 'center';
  data.forEach(function (d, i) {
    var mag = Math.abs(d.netMinor || 0);
    var h = Math.max(1, Math.round(mag / maxV * maxBarH));
    var x = padX + slot * i + (slot - barW) / 2;
    var y = baseY - h;
    ctx.fillStyle = accent;
    // Rounded-top bar (manual path: ES2019-safe, no roundRect dependency).
    var r = Math.min(5, barW / 2);
    ctx.beginPath();
    ctx.moveTo(x, y + h);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.lineTo(x + barW - r, y);
    ctx.quadraticCurveTo(x + barW, y, x + barW, y + r);
    ctx.lineTo(x + barW, y + h);
    ctx.closePath();
    ctx.fill();
    // Value label above the bar (magnitude, via Engine.fmtMoney).
    ctx.fillStyle = ink;
    ctx.font = '600 12px system-ui, sans-serif';
    ctx.fillText(Engine.fmtMoney(mag), x + barW / 2, y - 6);
    // Month label below the axis.
    var mm = /^(\d{4})-(\d{2})$/.exec(String(d.month || ''));
    ctx.fillStyle = muted;
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText(mm ? monthNames[+mm[2] - 1] : '', x + barW / 2, baseY + 18);
  });
};

/** Top-3 month-over-month movers: monthAnchor vs the previous month,
 * per-category spend deltas from split-aware totals. Categories at zero in
 * both months are skipped. */
App.moversHtml = async function (monthAnchor) {
  var stmts = await sAll('statements');
  var anchor = (/^\d{4}-\d{2}$/.test(monthAnchor || ''))
    ? monthAnchor : App.defaultBudgetMonth(stmts); // latest statement's period month
  var prev = prevMonthOf(anchor);
  var txns = await sAll('txns');
  var curT = {}, prevT = {};
  try {
    curT = Engine.splitAwareCategoryTotals(txns, anchor) || {};
    prevT = Engine.splitAwareCategoryTotals(txns, prev) || {};
  } catch (e) { curT = {}; prevT = {}; }
  var keys = {};
  Object.keys(curT).forEach(function (k) { keys[k] = 1; });
  Object.keys(prevT).forEach(function (k) { keys[k] = 1; });
  var movers = [];
  Object.keys(keys).forEach(function (k) {
    var c = curT[k] || 0, p = prevT[k] || 0;
    if (c === 0 && p === 0) return;
    movers.push({ category: k, delta: c - p });
  });
  movers.sort(function (a, b) { return Math.abs(b.delta) - Math.abs(a.delta); });
  movers = movers.slice(0, 3);
  var html = '<h2>Biggest movers</h2>';
  if (!movers.length) {
    return html + '<div class="card"><p class="small" style="margin:0">No category moved between ' +
      esc(fmtPeriod(prev)) + ' and ' + esc(fmtPeriod(anchor)) + '.</p></div>';
  }
  html += '<div class="card">';
  movers.forEach(function (m) {
    var up = m.delta > 0;
    html += '<div class="bar-row"><span class="b-label">' + esc(catLabelSmart(m.category)) + '</span>' +
      '<span class="b-amt">' + (up ? 'up ' : 'down ') + spendAbs(m.delta) + '</span></div>';
  });
  html += '<p class="tiny" style="margin-bottom:0">' + esc(fmtPeriod(anchor)) + ' vs ' +
    esc(fmtPeriod(prev)) + ' · split-aware.</p></div>';
  return html;
};

/** Budgets summary card for monthOverride (Home, month-scoped), else
 * App.state.budgetMonth (Plan view's chosen month) or the Plan default:
 * "X of Y on track" (on track = spent <= limit, split-aware). Hidden when
 * the month has no budgets. */
App.budgetSummaryHtml = async function (monthOverride) {
  var stmts = await sAll('statements');
  var month = (/^\d{4}-\d{2}$/.test(monthOverride || ''))
    ? monthOverride
    : (App.state.budgetMonth && /^\d{4}-\d{2}$/.test(App.state.budgetMonth)
      ? App.state.budgetMonth : App.defaultBudgetMonth(stmts));
  var budgets = (await sAll('budgets')).filter(function (b) { return b.month === month; });
  if (!budgets.length) return '';
  var txns = await sAll('txns');
  var onTrack = 0;
  budgets.forEach(function (b) {
    var spent = 0;
    try { spent = Engine.categorySpendMinor(txns, b.category, month); } catch (e) { spent = 0; }
    if (spent <= (b.limitMinor || 0)) onTrack++;
  });
  return '<h2>Budgets</h2><div class="card"><div class="section-head"><h3 style="margin:0">' +
    onTrack + ' of ' + budgets.length + ' on track</h3>' +
    '<button class="btn ghost smallbtn" data-action="tab" data-tab="plan">Open Plan</button></div>' +
    '<p class="small" style="margin-bottom:0">' + esc(fmtPeriod(month)) + ' budgets — spent vs limit, split-aware.</p></div>';
};

/* ============================================================================
 * Home tab (home after first import): slim summary on top (App.vHome),
 * full detail sections one tap down (App.monthDetailsHtml).
 * An OVERALL month view: aggregates ALL non-excluded transactions whose
 * date falls in the chosen calendar month (date prefix 'YYYY-MM', NOT
 * statement periods — periods span month boundaries), across every
 * statement on the device. Sections are the same honest building blocks
 * (Engine.buildBriefing / reconcile / split-aware totals), now month-
 * scoped, plus a per-account breakdown so each statement's contribution
 * and balance-check state stay visible. The aggregate balance check is
 * meaningless (balances never sum across accounts), so it reads
 * 'n/a (per-account below)'.
 * ========================================================================== */

/** Sorted 'YYYY-MM' months that have at least one transaction date. */
App.monthsWithData = function (txns) {
  var seen = {};
  (txns || []).forEach(function (t) {
    var m = /^(\d{4}-\d{2})-\d{2}$/.exec(String((t && t.date) || ''));
    if (m) seen[m[1]] = true;
  });
  return Object.keys(seen).sort();
};

/** Latest month present in any txn date ('YYYY-MM'), else null. */
App.latestTxnMonth = function (txns) {
  var months = App.monthsWithData(txns);
  return months.length ? months[months.length - 1] : null;
};

/** Transactions whose ISO date starts with the 'YYYY-MM' prefix. */
App.txnsInMonth = function (txns, month) {
  return (txns || []).filter(function (t) {
    return typeof t.date === 'string' && t.date.indexOf(month) === 0;
  });
};

/** How a statement's period covers a calendar month:
 * 'full' (periodStart <= month start AND periodEnd >= month end),
 * 'partial' (period overlaps the month but doesn't cover it),
 * 'outside' (no overlap — the statement still has txns dated in-month),
 * 'unknown' (missing/malformed period — never guess). */
App.statementCoverage = function (st, month) {
  var last = Engine._monthLastDay(month);
  var first = month + '-01';
  if (!st || last === null) return 'unknown';
  var ps = st.periodStart, pe = st.periodEnd;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ps || '') || !/^\d{4}-\d{2}-\d{2}$/.test(pe || '')) return 'unknown';
  if (ps <= first && pe >= last) return 'full';
  if (ps <= last && pe >= first) return 'partial';
  return 'outside';
};

App.Actions['month-prev'] = async function () {
  var months = App.monthsWithData(await sAll('txns'));
  var i = months.indexOf(App.state.month);
  if (i > 0) { App.state.month = months[i - 1]; App.render(); }
};
App.Actions['month-next'] = async function () {
  var months = App.monthsWithData(await sAll('txns'));
  var i = months.indexOf(App.state.month);
  if (i >= 0 && i < months.length - 1) { App.state.month = months[i + 1]; App.render(); }
};
App.Changes['month-select'] = function (el) {
  if (/^\d{4}-\d{2}$/.test(el.value || '')) { App.state.month = el.value; App.render(); }
};

/* ============================================================================
 * Home tab — a calm month summary.
 * One glance: month navigator, net-spend headline, review nudge, a one-line
 * Ask box, and plan highlights. Everything detailed (drivers, trends, the
 * full briefing text) lives one tap down inside a <details> disclosure.
 * Legacy route name vMonth kept as an alias so old deep links render it.
 * ========================================================================== */

/** All the data the Home view needs, computed once. Returns null when the
 *  ledger is empty (first-run state). */
App.monthContext = async function () {
  var txns = await sAll('txns');
  var stmts = await sAll('statements');
  if (!txns.length) return null;
  var months = App.monthsWithData(txns);
  if (!App.state.month || months.indexOf(App.state.month) === -1) {
    App.state.month = months[months.length - 1]; // default: latest month with data
  }
  var month = App.state.month;
  var prev = prevMonthOf(month);
  var lastDay = Engine._monthLastDay(month);

  var mTxns = App.txnsInMonth(txns, month);
  var pTxns = App.txnsInMonth(txns, prev);
  var stmtById = {};
  stmts.forEach(function (s) { stmtById[String(s.id)] = s; });

  // Engine briefing over the whole month, across ALL statements.
  var facts = null;
  try {
    facts = Engine.buildBriefing(mTxns, month + '-01', lastDay, pTxns.length ? pTxns : null, fmtPeriod(month), null);
  } catch (e) { facts = null; }
  var recon = null;
  try { recon = Engine.reconcile(mTxns, null); } catch (e) { recon = null; }
  if (!recon) recon = { grossPurchasesMinor: 0, refundsTotalMinor: 0, excludedTotalMinor: 0, netSpendMinor: 0, unresolvedCount: 0, signedRowsSumMinor: 0, balanceCheck: 'no_baseline', gapMinor: 0 };
  // Return-adjusted headline: refunds linked to purchases in other months are
  // attributed to the purchase's month, so the month you bought something
  // shows the true net. Components (gross/refunds) stay factual as-received.
  try {
    var retAdj = Engine.returnAdjustment(txns, await sAll('refundLinks'), month);
    if (retAdj) {
      recon.netSpendMinor += retAdj.deltaMinor;
      recon.returnAdjMinor = retAdj.movedMinor; // <= 0: returns attributed INTO this month
      recon.returnOutMinor = retAdj.deltaMinor - retAdj.movedMinor; // >= 0: refunds moved OUT
      // The briefing's headline number must agree with the hero: attribute it too.
      if (facts && typeof facts.netSpendMinor === 'number') facts.netSpendMinor += retAdj.deltaMinor;
    }
  } catch (e) { /* keep the unadjusted headline */ }
  // Cross-month refund moves, computed once: the per-account breakdown below
  // applies the same attribution as the headline (single source of truth).
  var retMoves = [];
  try { retMoves = Engine.refundMoves(txns, await sAll('refundLinks')) || []; } catch (e) { retMoves = []; }

  // Contributors: statements with transactions dated in this month.
  var byStmt = {};
  mTxns.forEach(function (t) {
    var k = String(t.statementId);
    if (!byStmt[k]) byStmt[k] = [];
    byStmt[k].push(t);
  });
  var contributors = Object.keys(byStmt).map(function (id) {
    return { id: id, statement: stmtById[id] || null, txns: byStmt[id] };
  });
  contributors.sort(function (a, b) {
    var ac = (a.statement && a.statement.createdAt) || 0;
    var bc = (b.statement && b.statement.createdAt) || 0;
    return bc - ac;
  });
  // Per-statement balance-check state: each statement's OWN import-time
  // check over its full rows (stored briefing facts); statements without
  // reported balances honestly read 'unavailable'.
  var briefs = await sAll('briefings');
  var latestFactsByStmt = {};
  briefs.forEach(function (b) {
    var k = String(b.statementId);
    if (!latestFactsByStmt[k] || (b.createdAt || 0) > (latestFactsByStmt[k].createdAt || 0)) {
      latestFactsByStmt[k] = { facts: b.facts, createdAt: b.createdAt || 0 };
    }
  });
  contributors.forEach(function (c) {
    var st = c.statement;
    var hasBaseline = !!(st && typeof st.reportedStartMinor === 'number' && typeof st.reportedEndMinor === 'number');
    var lf = latestFactsByStmt[c.id];
    c.checkState = (hasBaseline && lf && lf.facts && lf.facts.balanceCheck) ? String(lf.facts.balanceCheck) : 'unavailable';
    c.coverage = App.statementCoverage(st, month);
    var base = 0;
    try { base = Engine.reconcile(c.txns, null).netSpendMinor; } catch (e) { base = 0; }
    // Same return attribution as the headline, scoped to this account's
    // rows: a refund received this month for an earlier purchase moves out
    // (net rises); a later refund for this month's purchase moves in (net
    // falls). The breakdown then agrees with the hero number above.
    var ids = {};
    c.txns.forEach(function (t) { if (t && t.id !== null && t.id !== undefined) ids[String(t.id)] = 1; });
    var delta = 0;
    for (var mi = 0; mi < retMoves.length; mi++) {
      var mv = retMoves[mi];
      if (mv.fromMonth === month && mv.refund && ids[String(mv.refund.id)]) delta -= (mv.amountMinor || 0);
      else if (mv.toMonth === month && mv.purchase && ids[String(mv.purchase.id)]) delta += (mv.amountMinor || 0);
    }
    c.netMinor = base + delta;
  });

  var idx = months.indexOf(month);
  // Honest coverage note: periods only partially covering the month say so.
  var partialN = contributors.filter(function (c) { return c.coverage === 'partial'; }).length;
  var unknownN = contributors.filter(function (c) { return c.coverage === 'unknown' || c.coverage === 'outside'; }).length;
  var covNote = contributors.length + ' statement' + (contributors.length === 1 ? '' : 's') +
    ' contribute' + (contributors.length === 1 ? 's' : '') + ' to ' + esc(fmtPeriod(month));
  if (partialN) covNote += ' \u00b7 ' + partialN + ' partial';
  if (unknownN) covNote += ' \u00b7 ' + unknownN + ' without a full period';

  // Headline: the Engine's own first line (honesty rule — no final number
  // while anything is unresolved), plus the net figure as a magnitude.
  var headline = '';
  try { headline = facts ? String(Engine.renderBriefingText(facts).split('\n')[0] || '') : ''; } catch (e) { headline = ''; }

  var reviewTxns = App.reviewTxns(mTxns);
  var reviewN = reviewTxns.length;
  var noCatMonth = mTxns.filter(function (t) { return needsCategory(t); }).length;

  var cov = await App.receiptCoverageFor(mTxns);
  var rules = await sAll('householdRules');

  var deltas = facts ? (facts.deltas || []) : [];
  var drivers = facts ? (facts.topDrivers || []) : [];
  var rs = facts ? facts.refundsSummary : null;
  var move = mTxns.filter(function (t) { return ['refund', 'payment', 'transfer', 'fee'].indexOf(t.kind) !== -1 && !t.excluded; });

  var briefingText = '';
  try { briefingText = facts ? Engine.renderBriefingText(facts) : ''; } catch (e) { briefingText = ''; }

  return {
    months: months, month: month, idx: idx, prev: prev, covNote: covNote,
    headline: headline, recon: recon, facts: facts,
    mTxns: mTxns, pTxns: pTxns, contributors: contributors,
    reviewN: reviewN, noCatMonth: noCatMonth, cov: cov, rules: rules,
    deltas: deltas, drivers: drivers, rs: rs, move: move,
    briefingText: briefingText
  };
};

/** Month navigator: back | Month Year (dropdown) | next + coverage note. */
App.monthNavHtml = function (ctx) {
  var months = ctx.months, month = ctx.month, idx = ctx.idx;
  return '<div class="card"><div class="month-nav">' +
    '<button class="btn ghost" data-action="month-prev" aria-label="Previous month"' + (idx <= 0 ? ' disabled' : '') + '>&#8249;</button>' +
    '<select id="month-select" data-change="month-select" aria-label="Choose month">' +
    months.map(function (m) {
      return '<option value="' + m + '"' + (m === month ? ' selected' : '') + '>' + esc(fmtPeriod(m)) + '</option>';
    }).join('') + '</select>' +
    '<button class="btn ghost" data-action="month-next" aria-label="Next month"' + (idx >= months.length - 1 ? ' disabled' : '') + '>&#8250;</button>' +
    '</div><p class="small" style="margin-bottom:0">' + ctx.covNote + ' \u00b7 ' + ctx.mTxns.length + ' transactions</p></div>';
};

/** Return-attribution-aware refund components for one month's recon.
 *  outMinor (>=0): refunds received this month but counted in earlier
 *    purchase months. inMinor (>=0): returns from later months counted here.
 *  attrRefundsMinor: the refund magnitude actually netted against THIS
 *    month's spend, so grossPurchasesMinor - attrRefundsMinor always equals
 *    the (attributed) netSpendMinor. Pure. */
App.attributedRefunds = function (recon) {
  var r = recon || {};
  var outMinor = r.returnOutMinor || 0;
  var inMinor = -(r.returnAdjMinor || 0);
  if (outMinor < 0) outMinor = 0;
  if (inMinor < 0) inMinor = 0;
  return {
    outMinor: outMinor,
    inMinor: inMinor,
    attrRefundsMinor: (r.refundsTotalMinor || 0) - outMinor + inMinor
  };
};

/** Hero card: net spend after refunds for the month, with the gross/refund
 *  build-up and any return-attribution notes, plus the Engine's first line.
 *  The numbers here already include cross-month return attribution; the
 *  per-account breakdown below applies the same rule, so the two agree.
 *  The build-up always resolves: purchases minus attributed refunds equals
 *  the headline net. */
App.headlineHtml = function (ctx) {
  var r = ctx.recon || {};
  var at = App.attributedRefunds(r);
  var retNote = '';
  if (at.outMinor || at.inMinor) {
    retNote = '<p class="tiny" style="margin-bottom:0">Returns are counted in the month of the original purchase' +
      (at.outMinor ? ': ' + spendAbs(at.outMinor) + ' of this month\u2019s refunds belong to earlier months' : '') +
      (at.inMinor ? (at.outMinor ? ' \u00b7 ' : ': ') + spendAbs(at.inMinor) + ' from later returns counted here' : '') +
      '.</p>';
  }
  var buildup = '<span>' + spendAbs(r.grossPurchasesMinor) + ' purchases</span>';
  if ((r.refundsTotalMinor || 0) > 0 || at.outMinor || at.inMinor) {
    buildup += ' <span aria-hidden="true">&minus;</span> <span>' + spendAbs(at.attrRefundsMinor) + ' refunds</span>';
  }
  return '<div class="card hero"><div class="headline-label">Net spend &middot; ' + esc(fmtPeriod(ctx.month)) + '</div>' +
    '<div class="headline-num">' + spendAbs(r.netSpendMinor) + '</div>' +
    '<div class="hero-sub">' + buildup + '</div>' +
    retNote +
    '<p class="small" style="margin-bottom:0">' + esc(ctx.headline || ('Across ' + ctx.mTxns.length + ' transactions in ' + fmtPeriod(ctx.month) + ', all accounts.')) + '</p></div>';
};

/** Review nudge: one card when something needs a human look, else a quiet
 *  all-clear banner. Points at the Activity tab's review queue. */
App.homeReviewHtml = function (ctx) {
  if (!ctx.reviewN) return '<div class="banner ok">All clear \u2014 nothing needs review.</div>';
  return '<h2>Needs your review</h2><div class="card"><p><strong>' + ctx.reviewN + '</strong> transaction' + (ctx.reviewN === 1 ? '' : 's') +
    ' need' + (ctx.reviewN === 1 ? 's' : '') + ' a human look' +
    (ctx.noCatMonth ? ', including <strong>' + ctx.noCatMonth + '</strong> under \u201cNeeds a category\u201d' : '') + '.</p>' +
    '<button class="btn" data-action="goto" data-tab="activity" data-filter="review"' +
    (ctx.contributors.length ? ' data-sid="' + esc(ctx.contributors[0].id) + '"' : '') + '>Review now</button></div>';
};

/** "Where it went": top spend categories for the month as tappable bars.
 *  Same Engine top-drivers the old Month tab showed, promoted to Home so the
 *  breakdown is visible without digging. Tap a category to list every one of
 *  its transactions for the month. Refunds are already netted into the
 *  category totals. */
App.homeCategoriesHtml = function (ctx) {
  var head = '<div class="section-head"><h2>Where it went</h2>' +
    '<button class="linklike" data-action="wrong" data-filter="purchases">This explanation is wrong</button></div>';
  var drivers = (ctx.drivers || []).slice(0, 5);
  if (!drivers.length) {
    return head + '<div class="card"><p class="small" style="margin:0">No categorized spend in ' +
      esc(fmtPeriod(ctx.month)) + ' yet.</p></div>';
  }
  var max = 0, i;
  for (i = 0; i < drivers.length; i++) max = Math.max(max, Math.abs(drivers[i].totalMinor || 0));
  var html = head + '<div class="card">';
  for (i = 0; i < drivers.length; i++) {
    var d = drivers[i];
    var pct = max ? Math.round(100 * Math.abs(d.totalMinor || 0) / max) : 0;
    html += '<button class="driver" data-action="open-homecat" data-cat="' + esc(d.category || '') + '">' +
      '<span class="d-main"><span class="d-name">' + esc(catLabelSmart(d.category || '')) + '</span><br>' +
      '<span class="d-sub">' + (d.txnCount || 0) + ' transaction' + ((d.txnCount || 0) === 1 ? '' : 's') + '</span>' +
      '<span class="b-track" style="display:block;margin-top:6px"><span class="b-fill" style="width:' + pct + '%"></span></span></span>' +
      '<span class="d-amt">' + spendAbs(d.totalMinor) + '</span></button>';
  }
  html += '<p class="tiny" style="margin-bottom:0">Top categories for ' + esc(fmtPeriod(ctx.month)) +
    ', after refunds. Tap one to see its transactions.';
  var r = ctx.recon || {};
  if (r.returnOutMinor || r.returnAdjMinor) {
    html += ' Category totals count refunds in the month they were received;' +
      ' the net figure above attributes cross-month returns to the purchase month.';
  }
  html += '</p></div>';
  return html;
};

/** Drill-down target for "Where it went": every transaction behind one
 *  category bar for the selected month. Matches Engine.categoryMembers, so
 *  the listed rows always add up to the bar's total. */
App.Actions['open-homecat'] = function (d) {
  App.go('homecat', { homeCat: d.cat || null, txnId: null, txnRet: null });
};

App.vHomeCat = async function (v, seq) {
  var cat = App.state.homeCat;
  var ctx = await App.monthContext();
  if (!ctx || !cat) { App.go('home'); return; }
  var members = [];
  try { members = Engine.categoryMembers(ctx.mTxns, String(cat)) || []; } catch (e) { members = []; }
  var seen = {}, rows = [], total = 0;
  members.forEach(function (m) {
    total += m.shareMinor || 0;
    var id = String(m.txn && m.txn.id);
    if (!seen[id]) { seen[id] = 1; rows.push(m.txn); }
  });
  rows.sort(function (a, b) {
    var da = String(a.date || ''), db = String(b.date || '');
    if (da !== db) return da < db ? 1 : -1;
    return Math.abs(b.amountMinor || 0) - Math.abs(a.amountMinor || 0);
  });
  var html = '<button class="linklike" data-action="tab" data-tab="home">\u2190 Home</button>';
  html += '<h1>' + esc(catLabelSmart(cat)) + '</h1>';
  html += '<p class="small">' + rows.length + ' transaction' + (rows.length === 1 ? '' : 's') +
    ' \u00b7 ' + esc(fmtPeriod(ctx.month)) + ' \u00b7 total ' + spendAbs(total) + '</p>';
  html += '<div class="card">';
  if (!rows.length) html += '<div class="empty">No transactions in this category for ' + esc(fmtPeriod(ctx.month)) + '.</div>';
  rows.forEach(function (t) { html += App.txnRowHtml(t, 'homecat'); });
  html += '</div>';
  App.show(v, seq, html);
};

/** One-line Ask box with the answer below; the six priority questions live
 *  one tap down in "What can I ask?" so the screen stays calm. */
App.homeAskHtml = async function () {
  var html = '<h2>Ask about your money</h2>';
  html += '<div class="card"><div class="ask-row">' +
    '<input type="text" id="ask-free" placeholder="e.g. why did groceries rise?" value="' + esc(App.state.askText || '') + '" autocomplete="off" aria-label="Ask about your money">' +
    '<button class="btn" data-action="ask-submit">Ask</button></div>' +
    '<p class="tiny" style="margin-bottom:0">Answers are computed on this device from your ledger \u2014 nothing is uploaded.</p></div>';
  if (App.state.askQ) html += await App.answerHtml(App.state.askQ);
  else if (App.state.askText) html += await App.answerHtml('__free__');
  html += '<details class="more"><summary>What can I ask?</summary><div>' +
    QUESTIONS.map(function (q) {
      return '<button class="chip' + (App.state.askQ === q.id ? ' on' : '') + '" data-action="ask-chip" data-q="' + q.id + '">' + esc(q.label) + '</button>';
    }).join('') + '</div>' +
    '<p class="tiny">Free text is matched by keyword to one of the questions above. Anything else gets an honest \u201cI can\u2019t answer that yet\u201d.</p></details>';
  return html;
};

/** Excluded rows never enter gross/refunds/net, so they are an informational
 *  note — never a subtraction line (that would double-count them). Pure. */
App.excludedNoteHtml = function (recon) {
  var x = (recon || {}).excludedTotalMinor || 0;
  if (!x) return '';
  return '<p class="tiny" style="margin-bottom:0">Excluded by you: <strong>' +
    spendAbs(x) + '</strong> &mdash; left out of this total entirely.</p>';
};

/** Refunds & money-movement summary line. Honest about attribution: when
 *  cross-month returns moved refunds between months, "already subtracted
 *  from net spend" would be false, so the note breaks out what was received
 *  as-received, what was attributed to other months, and what actually
 *  reduced this month's net. Pure. */
App.refundsNoteHtml = function (recon, rs) {
  var r = recon || {};
  var total = rs ? rs.totalMinor : r.refundsTotalMinor;
  var count = rs ? rs.count : (r.refundCount || 0);
  var at = App.attributedRefunds(r);
  var s = 'Refunds received: <strong>' + spendAbs(total) + '</strong> across ' + count +
    ' transaction' + (count === 1 ? '' : 's');
  if (at.outMinor || at.inMinor) {
    var netted = (total || 0) - at.outMinor + at.inMinor;
    s += ' (as received).' +
      (at.outMinor ? ' ' + spendAbs(at.outMinor) + ' counted in earlier purchase months.' : '') +
      (at.inMinor ? ' ' + spendAbs(at.inMinor) + ' counted here from later returns.' : '') +
      ' Netted against this month\u2019s spend: <strong>' + spendAbs(netted) + '</strong>.';
  } else {
    s += ' (already subtracted from net spend).';
  }
  return '<p class="small">' + s + '</p>';
};

/** Plan highlights: the budget summary when budgets exist, else a single
 *  quiet card pointing at the full Plan. */
App.homePlanHtml = async function (ctx) {
  var sum = await App.budgetSummaryHtml(ctx.month);
  if (sum) return sum;
  return '<h2>Plan</h2><div class="card"><p class="small" style="margin-top:0">Set monthly budgets, savings goals, and track subscriptions \u2014 all computed on this device.</p>' +
    '<button class="btn ghost" data-action="tab" data-tab="plan">Open Plan</button></div>';
};

/** The detailed month sections (old Month tab body), kept intact but moved
 *  one tap down inside the "Month details" disclosure. */
App.monthDetailsHtml = async function (ctx) {
  var month = ctx.month, prev = ctx.prev, facts = ctx.facts, recon = ctx.recon;
  var html = '';
  // What changed: Engine deltas vs previous calendar month aggregate.
  html += '<div class="section-head"><h2>What changed</h2>' +
    '<button class="linklike" data-action="wrong" data-filter="purchases">This explanation is wrong</button></div>';
  if (ctx.deltas.length) {
    html += '<div class="card"><p class="tiny" style="margin-top:0">' + esc(fmtPeriod(month)) + ' vs ' + esc(fmtPeriod(prev)) + ' \u00b7 all accounts</p>';
    ctx.deltas.slice(0, 3).forEach(function (d) {
      var up = d.deltaMinor > 0;
      html += '<div class="bar-row"><span class="b-label">' + esc(catLabelSmart(d.category || '')) + '</span>' +
        '<span class="b-amt">' + (up ? 'up ' : 'down ') + spendAbs(d.deltaMinor) +
        ' <span class="tiny">(' + (d.txnCount || 0) + ' txn)</span></span></div>';
    });
    html += '</div>';
  } else {
    html += '<div class="card"><p style="margin:0">' + (ctx.pTxns.length
      ? 'Spending was flat across categories vs ' + esc(fmtPeriod(prev)) + '.'
      : 'No ' + esc(fmtPeriod(prev)) + ' data to compare against yet.') + '</p></div>';
  }

  // "Where it went" now lives on Home itself (App.homeCategoriesHtml); the
  // details keep the remaining deep-dives.

  // Refunds & money movement, month-scoped.
  html += '<div class="section-head"><h2>Refunds &amp; money movement</h2>' +
    '<button class="linklike" data-action="wrong" data-filter="refunds">This explanation is wrong</button></div>';
  if (ctx.move.length) {
    html += '<div class="card">';
    ctx.move.slice(0, 8).forEach(function (t) {
      t = nt(t);
      html += '<div class="bar-row"><span class="b-label">' + esc(t.desc) + '</span>' +
        '<span class="b-amt">' + money(t.amountMinor) + ' \u00b7 ' + esc(kindLabel(t.kind)) + '</span></div>';
    });
    html += App.refundsNoteHtml(recon, ctx.rs) + '</div>';
  } else html += '<p class="small">No refunds, payments, transfers or fees this month.</p>';

  // Per-account breakdown: each contributing statement's net spend for the
  // month + its own balance-check state. Tap to drill into the statement.
  html += '<h2>Per-account breakdown</h2><div class="card">';
  ctx.contributors.forEach(function (c) {
    var label = c.statement ? (c.statement.scopeLabel || c.statement.periodLabel || 'Statement') : '(statement removed)';
    var checkPill = c.checkState === 'ok' ? 'ok' : (c.checkState === 'gap' ? 'bad' : 'dim');
    html += '<button class="driver" data-action="goto" data-tab="activity" data-sid="' + esc(c.id) + '"' + (c.statement ? '' : ' disabled') + '>' +
      '<span class="d-main"><span class="d-name">' + esc(label) + '</span><br>' +
      '<span class="d-sub">' + c.txns.length + ' transaction' + (c.txns.length === 1 ? '' : 's') + ' \u00b7 ' +
      esc(c.coverage === 'full' ? 'full month' : (c.coverage === 'partial' ? 'partial month' : c.coverage)) +
      ' \u00b7 <span class="pill ' + checkPill + '">check: ' + esc(c.checkState) + '</span></span></span>' +
      '<span class="d-amt">' + spendAbs(c.netMinor) + '</span></button>';
  });
  html += '<p class="tiny" style="margin-bottom:0">Net spend per account for ' + esc(fmtPeriod(month)) +
    ', magnitudes, after return attribution. Tap an account to drill into its statement.</p></div>';

  // Evidence quality. The aggregate balance check is meaningless (balances
  // never sum across accounts) — per-statement states are above.
  html += '<h2>Evidence quality</h2><div class="card"><table class="kv">' +
    '<tr><th>Transactions</th><td>' + ctx.mTxns.length + ' across ' + ctx.contributors.length + ' statement' + (ctx.contributors.length === 1 ? '' : 's') + '</td></tr>' +
    '<tr><th>Receipt coverage</th><td>' + Math.round(ctx.cov.ratio * 100) + '% of ' + esc(fmtPeriod(month)) + ' purchases (' + spendAbs(ctx.cov.matchedMinor) + ' / ' + spendAbs(ctx.cov.grossMinor) + ')</td></tr>' +
    '<tr><th>Household rules</th><td>' + ctx.rules.length + ' (' + ctx.rules.filter(function (r) { return r.enabled !== false; }).length + ' active)</td></tr>' +
    '<tr><th>Unresolved</th><td>' + ctx.reviewN + '</td></tr>' +
    '<tr><th>Balance check</th><td>n/a (per-account above)</td></tr>' +
    '</table></div>';

  // Trends now live on Home itself (above); biggest movers stay here.
  html += await App.moversHtml(month);

  // Full deterministic briefing text (month-scoped facts).
  if (ctx.briefingText) {
    html += '<details class="more"><summary>Full briefing text</summary><pre class="brief">' + esc(ctx.briefingText) + '</pre>';
    if (typeof LLM !== 'undefined' && LLM.isActive()) {
      html += '<div style="margin-top:8px"><button class="btn ghost smallbtn" data-action="llm-rephrase-briefing">Rephrase with AI</button> <span class="tiny">Rewords only \u2014 the facts stay on this device.</span></div>';
      App._lastBriefing = {
        briefing: { text: ctx.briefingText, facts: facts },
        st: { periodLabel: month, scopeLabel: 'All accounts \u00b7 ' + fmtPeriod(month) },
        recon: recon
      };
    }
    html += '</details><div id="llm-preview"></div>';
  }
  return html;
};

App.vHome = async function (v, seq) {
  var ctx = await App.monthContext();
  if (!ctx) {
    App.show(v, seq, '<h1>Home</h1><div class="empty">Nothing here yet \u2014 import a statement to get your first briefing.<br><br>' +
      '<button class="btn" data-action="tab" data-tab="add">Add a statement</button></div>');
    return;
  }
  var html = '<h1>Home</h1>' + App.monthNavHtml(ctx) + App.headlineHtml(ctx);
  html += App.homeReviewHtml(ctx);
  html += App.homeCategoriesHtml(ctx);
  html += await App.trendsHtml(ctx.month);
  html += await App.homeAskHtml();
  html += await App.homePlanHtml(ctx);
  html += '<details class="more"><summary>Month details</summary>' +
    await App.monthDetailsHtml(ctx) + '</details>';
  App.show(v, seq, html);
  // Hand-rolled trend chart: draw after the canvas is in the DOM.
  if (seq === App._renderSeq && typeof document !== 'undefined') {
    var c = document.getElementById('trend-canvas');
    if (c) App.drawTrends(c, App._trendData || []);
  }
};

/** Legacy route name: the old Month tab now renders the Home summary. */
App.vMonth = App.vHome;



/** Headline: prefer the Engine briefing's first line (honesty rule), else a
    derived sentence. */
App.briefHeadline = function (briefing, st, recon) {
  try {
    if (briefing && briefing.text) {
      var first = String(briefing.text).split('\n')[0];
      if (first) return first;
    }
    if (briefing && briefing.facts) {
      var f = briefing.facts;
      if (f.headline) return String(f.headline);
      if (f.summary) return String(f.summary);
    }
  } catch (e) {}
  return 'Across ' + (st.rowCount || 0) + ' transactions in ' + fmtPeriod(st.periodLabel) + '.';
};

App.Actions.wrong = function (d) {
  // "This explanation is wrong" -> the underlying transactions.
  App.go('statement', { sfilter: d.filter || 'review', txnId: null });
};

/* Ask lives on the Home tab now (one-line box + "What can I ask?" details).
 * The optional AI phrasing settings moved to More > AI phrasing. The
 * QUESTIONS list, answerHtml/buildAnswer/matchQuestion, and the
 * 'ask-chip' / 'ask-submit' actions below still power the Home ask box. */

var QUESTIONS = [
  { id: 'q-spend',     label: 'Actual spend after refunds?', keys: ['spend', 'total', 'much', 'net', 'actually'] },
  { id: 'q-change',    label: 'Why did spending change?',    keys: ['why', 'change', 'rose', 'fell', 'increase', 'decrease', 'higher', 'lower', 'versus', 'vs', 'compared'] },
  { id: 'q-grocery',   label: 'Groceries / household?',      keys: ['grocer', 'food', 'loblaw', 'costco', 'household', 'supermarket'] },
  { id: 'q-mixed',     label: 'Mixed-merchant contents?',    keys: ['mixed', 'amazon', 'what did i buy', 'contents', 'inside'] },
  { id: 'q-move',      label: 'Payments, transfers, fees?',  keys: ['payment', 'transfer', 'fee', 'duplicate', 'cash'] },
  { id: 'q-uncertain', label: 'What remains uncertain?',     keys: ['uncertain', 'unsure', 'unknown', 'review', 'missing', 'left'] }
];

App.Actions['ask-chip'] = function (d) { App.state.askQ = d.q; App.state.askText = ''; App.render(); };
App.Actions['ask-submit'] = function () {
  var t = $('#ask-free') && $('#ask-free').value.trim();
  App.state.askText = t || '';
  App.state.askQ = null;
  App.render();
};

/* ---------------- optional AI phrasing (BYO key, off by default) ----------------
 * The deterministic engine owns every number. The LLM only rewords text the
 * app already computed. Approval is per-call: the exact provider URL, model,
 * privacy mode, and request payload are shown first, and sending proceeds
 * only after the user approves that exact combination. Changing any of them
 * afterwards cancels the send automatically.
 */

/** Fingerprint binding the approval to provider URL, model, privacy mode,
 *  and the exact request payload — so a setting changed after preview
 *  cannot silently redirect or reshape an approved send. */
function approvalBinding(prev) {
  return JSON.stringify({ provider: prev.provider, model: prev.model, privacyMode: prev.privacyMode, request: prev.request });
}

App.llmSettingsHtml = function () {
  if (typeof LLM === 'undefined') return '<p class="small">AI module failed to load.</p>';
  var s = LLM.getSettings();
  var h = '<label class="switch"><input type="checkbox" data-change="llm-enabled"' + (s.enabled ? ' checked' : '') + '> Enable AI phrasing</label>';
  h += '<label class="f" for="llm-base">API base URL (OpenAI-compatible)</label>' +
    '<input type="text" id="llm-base" data-change="llm-baseurl" value="' + esc(s.baseUrl) + '" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="https://api.openai.com/v1">';
  h += '<label class="f" for="llm-model">Model</label>' +
    '<input type="text" id="llm-model" data-change="llm-model" value="' + esc(s.model) + '" autocomplete="off" autocapitalize="none" spellcheck="false">';
  h += '<label class="f" for="llm-key">API key ' +
    (LLM.hasKey() ? '<span class="pill ok">set for this session</span>' : '<span class="pill dim">not set</span>') + '</label>' +
    '<input type="password" id="llm-key" data-change="llm-key" autocomplete="off" placeholder="sk-… (kept in memory only, never stored)">';
  if (LLM.hasKey()) h += '<div style="margin:4px 0"><button class="btn ghost smallbtn" data-action="llm-forget-key">Forget key now</button></div>';
  h += '<div class="f">What may leave this device</div>' +
    '<label class="radio"><input type="radio" name="llm-mode" data-change="llm-mode" value="off"' + (s.privacyMode === 'off' ? ' checked' : '') + '> Off — nothing leaves (default)</label>' +
    '<label class="radio"><input type="radio" name="llm-mode" data-change="llm-mode" value="aggregates"' + (s.privacyMode === 'aggregates' ? ' checked' : '') + '> Aggregates only — totals, deltas, category names</label>' +
    '<label class="radio"><input type="radio" name="llm-mode" data-change="llm-mode" value="detailed"' + (s.privacyMode === 'detailed' ? ' checked' : '') + '> Detailed — approved transaction detail only</label>';
  h += '<p class="tiny">The key is held in memory and forgotten when the app closes. In <em>aggregates</em> mode payloads never include account numbers, receipt images, or raw transaction rows.</p>';
  return h;
};

App.Changes['llm-enabled'] = function (el) { LLM.saveSettings({ enabled: el.checked }); App.render(); };
App.Changes['llm-baseurl'] = function (el) { LLM.saveSettings({ baseUrl: String(el.value || '').trim() }); };
App.Changes['llm-model'] = function (el) { LLM.saveSettings({ model: String(el.value || '').trim() }); };
App.Changes['llm-key'] = function (el) { LLM.setKey(el.value); /* no re-render: keeps focus while typing */ };
App.Changes['llm-mode'] = function (el) { LLM.saveSettings({ privacyMode: el.value }); App.render(); };
App.Actions['llm-forget-key'] = function () { LLM.clearKey(); App.render(); };

function stripTags(h) {
  return String(h || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

App.llmFactsForAnswer = function (ctx) {
  var r = ctx.recon || {};
  var facts = ctx.facts || {};
  return {
    scope: { period: ctx.st.periodLabel, accounts: [ctx.st.scopeLabel || ctx.st.accountLabel || 'card'], currency: 'CAD' },
    metrics: [
      { metric: 'net_spend', amount_minor: r.netSpendMinor || 0 },
      { metric: 'gross_purchases', amount_minor: r.grossPurchasesMinor || 0 },
      { metric: 'refunds', amount_minor: r.refundsTotalMinor || 0 },
      { metric: 'unresolved_count', count: r.unresolvedCount || 0 }
    ],
    drivers: (facts.topDrivers || []).slice(0, 5).map(function (d) {
      return { group: String(d.category), delta_minor: d.totalMinor || 0, confidence: 1 };
    }),
    unresolved: []
  };
};

/** Detailed mode: only the merchant/date/amount evidence already shown in
 *  the answer card — nothing raw beyond what the user already sees. */
App.llmDetailsForAnswer = function (ctx, ans) {
  var out = [];
  var byId = {};
  (ctx.txns || []).forEach(function (t) { byId[String(t.id)] = t; });
  ((ans && ans.txnIds) || []).slice(0, 12).forEach(function (id) {
    var t = byId[String(id)];
    if (t) out.push({ merchant: String(t.merchantRaw || t.rawDescription || '').slice(0, 60),
                      date: t.date, amount_minor: t.amountMinor, kind: t.kind });
  });
  return out;
};

App.Actions['llm-rephrase-answer'] = async function () {
  var box = document.getElementById('llm-preview');
  if (!box || !App._lastAnswer || typeof LLM === 'undefined') return;
  var ctx = App._lastAnswer.ctx, ans = App._lastAnswer.ans;
  var facts = App.llmFactsForAnswer(ctx);
  var detText = ans.title + '\n' + stripTags(ans.body);
  var details = App.llmDetailsForAnswer(ctx, ans);
  var prev = LLM.previewPayload(facts, 'answer', details);
  var payloadStr = JSON.stringify(prev.request, null, 2);
  App._llmApproved = { kind: 'answer', facts: facts, detText: detText, details: details, binding: approvalBinding(prev) };
  box.innerHTML = '<div class="banner warn"><strong>Pre-send preview — nothing has been sent.</strong>' +
    '<p class="small">Provider: ' + esc(prev.provider) + ' · model ' + esc(prev.model) + ' · sharing: ' + esc(prev.privacyMode) + '</p>' +
    '<pre class="brief" style="max-height:240px;overflow:auto">' + esc(payloadStr) + '</pre>' +
    '<div class="btn-row"><button class="btn" data-action="llm-send-answer">Approve &amp; send once</button>' +
    '<button class="btn ghost" data-action="llm-cancel">Cancel</button></div></div>';
  box.scrollIntoView({ block: 'nearest' });
};

App.Actions['llm-send-answer'] = async function () {
  var box = document.getElementById('llm-preview');
  var ap = App._llmApproved;
  if (!box || !ap || ap.kind !== 'answer') return;
  var cur = LLM.previewPayload(ap.facts, 'answer', ap.details);
  if (approvalBinding(cur) !== ap.binding) {
    box.innerHTML = '<div class="banner bad">The provider, model, privacy mode, or payload changed since you previewed it — cancelled for safety.</div>';
    App._llmApproved = null; return;
  }
  box.innerHTML = '<p class="small">Asking for phrasing…</p>';
  var res = await LLM.phraseAnswer(ap.facts, ap.detText, function () { return Promise.resolve(true); }, ap.details);
  App._llmApproved = null;
  box.innerHTML = res.source === 'llm'
    ? '<div class="banner ok"><strong>AI phrasing</strong> <span class="pill dim">words only — facts unchanged</span><p style="margin:6px 0 0">' + esc(res.text) + '</p></div>'
    : '<div class="banner warn">Phrasing unavailable — the deterministic answer above stands.</div>';
};

App.llmFactsForBriefing = function (briefing, st, recon) {
  var facts = (briefing && briefing.facts) || {};
  return {
    scope: { period: st.periodLabel, accounts: [st.scopeLabel || st.accountLabel || 'card'], currency: 'CAD' },
    metrics: [
      { metric: 'net_spend', amount_minor: recon.netSpendMinor || 0 },
      { metric: 'gross_purchases', amount_minor: recon.grossPurchasesMinor || 0 },
      { metric: 'refunds', amount_minor: recon.refundsTotalMinor || 0 },
      { metric: 'unresolved_count', count: recon.unresolvedCount || 0 }
    ],
    drivers: (facts.topDrivers || []).slice(0, 5).map(function (d) {
      return { group: String(d.category), delta_minor: d.totalMinor || 0, confidence: 1 };
    }),
    unresolved: []
  };
};

App.Actions['llm-rephrase-briefing'] = async function () {
  var box = document.getElementById('llm-preview');
  var lb = App._lastBriefing;
  if (!box || !lb || typeof LLM === 'undefined') return;
  var facts = App.llmFactsForBriefing(lb.briefing, lb.st, lb.recon);
  var detText = String(lb.briefing.text || '');
  var prev = LLM.previewPayload(facts, 'briefing', null);
  var payloadStr = JSON.stringify(prev.request, null, 2);
  App._llmApproved = { kind: 'briefing', facts: facts, detText: detText, binding: approvalBinding(prev) };
  box.innerHTML = '<div class="banner warn"><strong>Pre-send preview — nothing has been sent.</strong>' +
    '<p class="small">Provider: ' + esc(prev.provider) + ' · model ' + esc(prev.model) + ' · sharing: ' + esc(prev.privacyMode) + '</p>' +
    '<pre class="brief" style="max-height:240px;overflow:auto">' + esc(payloadStr) + '</pre>' +
    '<div class="btn-row"><button class="btn" data-action="llm-send-briefing">Approve &amp; send once</button>' +
    '<button class="btn ghost" data-action="llm-cancel">Cancel</button></div></div>';
  box.scrollIntoView({ block: 'nearest' });
};

App.Actions['llm-send-briefing'] = async function () {
  var box = document.getElementById('llm-preview');
  var ap = App._llmApproved;
  if (!box || !ap || ap.kind !== 'briefing') return;
  var cur = LLM.previewPayload(ap.facts, 'briefing', null);
  if (approvalBinding(cur) !== ap.binding) {
    box.innerHTML = '<div class="banner bad">The provider, model, privacy mode, or payload changed since you previewed it — cancelled for safety.</div>';
    App._llmApproved = null; return;
  }
  box.innerHTML = '<p class="small">Asking for phrasing…</p>';
  var res = await LLM.phraseBriefing(ap.facts, ap.detText, function () { return Promise.resolve(true); });
  App._llmApproved = null;
  box.innerHTML = res.source === 'llm'
    ? '<div class="banner ok"><strong>AI phrasing</strong> <span class="pill dim">words only — facts unchanged</span><p style="margin:6px 0 0">' + esc(res.text) + '</p></div>'
    : '<div class="banner warn">Phrasing unavailable — the deterministic briefing above stands.</div>';
};

App.Actions['llm-cancel'] = function () {
  App._llmApproved = null;
  var box = document.getElementById('llm-preview');
  if (box) box.innerHTML = '';
};

function questionLabel(id) {
  var q = QUESTIONS.filter(function (x) { return x.id === id; })[0];
  return q ? q.label : id;
}

/** Build the ledger context once per Ask render. */
App.askCtx = async function () {
  var stmts = await sAll('statements');
  if (!stmts.length) return null;
  stmts.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
  var st = stmts[0];
  var txns = await sQuery('txns', 'statementId', st.id);
  var prevTxns = [], prevLabel = '';
  if (stmts[1]) { prevTxns = await sQuery('txns', 'statementId', stmts[1].id); prevLabel = stmts[1].periodLabel; }
  var recon = null;
  var askReported = (st && typeof st.reportedStartMinor === 'number' && typeof st.reportedEndMinor === 'number')
    ? { startMinor: st.reportedStartMinor, endMinor: st.reportedEndMinor } : null;
  try { recon = Engine.reconcile(txns, askReported); } catch (e) {
    recon = { grossPurchasesMinor: 0, refundsTotalMinor: 0, excludedTotalMinor: 0, netSpendMinor: 0, unresolvedCount: 0, signedRowsSumMinor: 0, balanceCheck: 'unavailable', gapMinor: null };
  }
  var briefs = (await sAll('briefings')).filter(function (b) { return String(b.statementId) === String(st.id); });
  briefs.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
  var facts = (briefs[0] && briefs[0].facts) || null;
  var receipts = await sAll('receipts');
  var rules = await sAll('householdRules');
  var confidence = (recon.unresolvedCount || 0) === 0 ? 'high' : ((recon.unresolvedCount || 0) <= 5 ? 'medium' : 'low');
  return { st: st, txns: txns, prevTxns: prevTxns, prevLabel: prevLabel, recon: recon,
           facts: facts, receipts: receipts, rules: rules, confidence: confidence };
};

App.answerHtml = async function (qid) {
  var ctx = await App.askCtx();
  if (!ctx) return '<div class="empty">Import a statement first — there is no ledger to answer from yet.</div>';
  var ans;
  if (qid === '__free__') {
    var match = App.matchQuestion(App.state.askText);
    if (!match) {
      ans = { title: '“' + App.state.askText + '”',
        body: '<p>I can’t answer that from your ledger yet. Gate 1 answers the six questions above, deterministically, from your transactions. ' +
              'Try one of the chips — or rephrase with words like <em>spend</em>, <em>groceries</em>, <em>refund</em>, <em>uncertain</em>.</p>',
        txnIds: [], basis: 'no matching priority question', confidence: 'n/a' };
    } else { qid = match; }
  }
  if (!ans) ans = await App.buildAnswer(qid, ctx);
  App._lastAnswer = { ans: ans, ctx: ctx, qid: qid };
  return App.answerCard(ans, ctx);
};

App.matchQuestion = function (text) {
  var t = ' ' + String(text || '').toLowerCase() + ' ';
  var best = null, bestScore = 0;
  QUESTIONS.forEach(function (q) {
    var s = 0;
    q.keys.forEach(function (k) { if (t.indexOf(k) !== -1) s++; });
    if (s > bestScore) { bestScore = s; best = q.id; }
  });
  return bestScore > 0 ? best : null;
};

/* ---------- the six deterministic answers ---------- */

App.buildAnswer = async function (qid, ctx) {
  var txns = ctx.txns, recon = ctx.recon;
  var ids = function (list) { return list.map(function (t) { return t.id; }); };
  var purch = txns.filter(function (t) { return (t.kind === 'purchase' || t.kind === 'cash_advance') && !t.excluded; });

  if (qid === 'q-spend') {
    // V7: the Engine reports SIGNED minor units; labeled totals are magnitudes.
    // V15: excluded/duplicate rows never enter gross, so they are NOT a
    // subtraction line (the old table subtracted them twice over). The table
    // resolves: gross − refunds = net.
    return { title: 'How much did you actually spend?',
      body: '<p>Your <strong>actual spend after refunds</strong> was <strong>' + spendAbs(recon.netSpendMinor) + '</strong>.</p>' +
        '<table class="kv"><tr><th>Gross purchases</th><td>' + spendAbs(recon.grossPurchasesMinor) + '</td></tr>' +
        '<tr><th>− Refunds</th><td>' + spendAbs(recon.refundsTotalMinor) + '</td></tr>' +
        '<tr><th>= Net spend</th><td><strong>' + spendAbs(recon.netSpendMinor) + '</strong></td></tr></table>' +
        App.excludedNoteHtml(recon) +
        '<p class="small">Payments and transfers are money movement, not spending — they never enter this total.</p>',
      txnIds: ids(purch), basis: purch.length + ' purchase transactions', confidence: ctx.confidence };
  }

  if (qid === 'q-change') {
    var deltas = ctx.facts ? (ctx.facts.deltas || []) : [];
    if (!ctx.prevTxns.length && !deltas.length)
      return { title: 'Why did spending change?', body: '<p>This is your first statement on this device, so there is no previous month to compare against.</p>',
        txnIds: [], basis: 'no previous period', confidence: 'n/a' };
    var prevRecon = null;
    try { prevRecon = Engine.reconcile(ctx.prevTxns, null); } catch (e) { prevRecon = { netSpendMinor: 0 }; }
    var delta = (recon.netSpendMinor || 0) - (prevRecon.netSpendMinor || 0);
    var body = '<p>Net spend went from <strong>' + spendAbs(prevRecon.netSpendMinor) + '</strong> to <strong>' +
      spendAbs(recon.netSpendMinor) + '</strong> — ' + (delta >= 0 ? 'up ' : 'down ') + '<strong>' + spendAbs(delta) + '</strong>.</p>';
    if (deltas.length) {
      body += '<p>The biggest drivers (Engine deltas):</p><ul class="list-plain">' + deltas.slice(0, 3).map(function (d) {
        return '<li><strong>' + esc(prettify(String(d.category || ''))) + '</strong> ' + (d.deltaMinor >= 0 ? 'up ' : 'down ') + spendAbs(d.deltaMinor) + '</li>';
      }).join('') + '</ul>';
    } else body += '<p class="small">No single category moved materially — the change is spread across many small transactions.</p>';
    return { title: 'Why did spending change?', body: body, txnIds: ids(purch),
      basis: 'this period vs ' + fmtPeriod(ctx.prevLabel), confidence: ctx.confidence };
  }

  if (qid === 'q-grocery') {
    var gids = App.categories.filter(function (c) { return /grocer|food|household|dining/i.test(c.name); }).map(function (c) { return String(c.id); });
    var g = txns.filter(function (t) { return gids.indexOf(String(nt(t).category)) !== -1 && !nt(t).excluded; });
    var tot = g.reduce(function (s, t) { return s + spendOf(t); }, 0);
    var body;
    if (!g.length) {
      body = '<p>No transactions are categorized as groceries/food/household yet. Set categories on the Statement view — ' +
        'you can turn each correction into a rule so future imports categorize themselves.</p>';
    } else {
      body = '<p>Grocery / food / household spend: <strong>' + spendAbs(tot) + '</strong> across ' + g.length + ' transactions.</p>';
      if (ctx.prevTxns.length) {
        var pg = ctx.prevTxns.filter(function (t) { return gids.indexOf(String(nt(t).category)) !== -1 && !nt(t).excluded; });
        var ptot = pg.reduce(function (s, t) { return s + spendOf(t); }, 0);
        var d = tot - ptot;
        body += '<p>Last period: ' + spendAbs(ptot) + ' — ' + (d >= 0 ? 'up ' : 'down ') + spendAbs(d) + '.</p>';
      }
    }
    return { title: 'Groceries / household', body: body, txnIds: ids(g),
      basis: g.length + ' categorized transactions', confidence: g.length ? ctx.confidence : 'low (uncategorized)' };
  }

  if (qid === 'q-mixed') {
    var mixed = purch.filter(function (t) { return /costco|amazon|walmart|target|canadian tire/i.test(t.merchantRaw || t.rawDescription || ''); });
    var body = '<p class="small">A statement row can’t show <em>what</em> was inside a mixed-merchant trip — only the total. ' +
      'Receipts fill this gap; coverage is currently ' + Math.round((await App.receiptCoverage()).ratio * 100) + '%.</p>';
    if (!mixed.length) body += '<p>No Costco/Amazon-type mixed-merchant purchases this period.</p>';
    else {
      body += '<ul class="list-plain">' + mixed.map(function (t) {
        return '<li><strong>' + esc(t.merchantRaw || t.rawDescription) + '</strong> — ' + money(t.amountMinor) +
          ' <span class="tiny">(' + esc(fmtDate(t.date)) + ')</span></li>';
      }).join('') + '</ul>';
    }
    return { title: 'Mixed-merchant contents', body: body, txnIds: ids(mixed),
      basis: mixed.length + ' mixed-merchant transactions', confidence: mixed.length ? 'medium (totals only)' : 'high' };
  }

  if (qid === 'q-move') {
    var move = txns.filter(function (t) { return ['payment', 'transfer', 'fee'].indexOf(t.kind) !== -1 || t.status === 'duplicate'; });
    var explain = { payment: 'Money you sent to pay the card — not spending.', transfer: 'Money moved between your own accounts — not spending.',
      fee: 'A charge from the issuer — shown separately from purchases.', duplicate: 'A row you marked as double-counted — excluded from spend.' };
    var body = '<p class="small">None of these are household spending. They are money movement or corrections:</p>';
    if (!move.length) body += '<p>No payments, transfers, fees or duplicates this period.</p>';
    else body += '<ul class="list-plain">' + move.map(function (t) {
      var key = t.status === 'duplicate' ? 'duplicate' : t.kind;
      return '<li><strong>' + esc(t.merchantRaw || t.rawDescription) + '</strong> — ' + money(t.amountMinor) +
        ' · ' + esc(kindLabel(key)) + '<br><span class="small">' + esc(explain[key] || '') + '</span></li>';
    }).join('') + '</ul>';
    return { title: 'Payments, transfers, duplicates, fees', body: body, txnIds: ids(move),
      basis: move.length + ' money-movement transactions', confidence: ctx.confidence };
  }

  if (qid === 'q-uncertain') {
    var un = txns.filter(function (t) { var k = txnTab(t); return k === 'uncertain' || k === 'duplicates'; });
    var body;
    if (!un.length) body = '<p>Nothing is uncertain — every transaction is classified and reconciled. 🎉</p>';
    else {
      body = '<p><strong>' + un.length + '</strong> transaction' + (un.length === 1 ? '' : 's') + ' still need' +
        (un.length === 1 ? 's' : '') + ' a human decision:</p><ul class="list-plain">' +
        un.map(function (t) {
          return '<li><strong>' + esc(t.merchantRaw || t.rawDescription) + '</strong> — ' + money(t.amountMinor) +
            ' <span class="tiny">(' + esc(t.kindReason || kindLabel(t.kind)) + ')</span></li>';
        }).join('') + '</ul><p class="small">Resolve them in the review queue; each fix can become a rule.</p>';
    }
    return { title: 'What remains uncertain', body: body, txnIds: ids(un),
      basis: un.length + ' unresolved transactions', confidence: un.length ? 'low (by definition)' : 'high' };
  }

  return { title: 'Unknown question', body: '<p>I can’t answer that from your ledger yet.</p>', txnIds: [], basis: 'n/a', confidence: 'n/a' };
};

/** Answer card with the evidence footer. */
App.answerCard = async function (ans, ctx) {
  var html = '<div class="qa"><div class="q">' + esc(ans.title) + '</div><div class="a">' + ans.body + '</div>';
  html += '<div class="evidence">' +
    '<div class="ev-row"><strong>Period &amp; scope:</strong> ' + esc(ctx.st.scopeLabel || fmtPeriod(ctx.st.periodLabel)) + '</div>' +
    '<div class="ev-row"><strong>Evidence basis:</strong> ' + esc(ans.basis) + ' · ' + ctx.txns.length + ' transactions on file · ' +
    ctx.receipts.length + ' receipts · ' + ctx.rules.length + ' household rules</div>' +
    '<div class="ev-row"><strong>Confidence:</strong> ' + esc(ans.confidence) + '</div>';
  if (ans.txnIds && ans.txnIds.length) {
    html += '<div class="ev-row"><strong>Sources:</strong><br>';
    for (var i = 0; i < Math.min(ans.txnIds.length, 12); i++) {
      var t = await sGet('txns', ans.txnIds[i]);
      if (t) html += '<button class="src-txn" data-action="open-txn" data-id="' + esc(t.id) + '">' +
        esc(String(t.merchantRaw || t.rawDescription || '').slice(0, 22)) + ' ' + money(t.amountMinor) + '</button>';
    }
    if (ans.txnIds.length > 12) html += '<span class="tiny">+' + (ans.txnIds.length - 12) + ' more</span>';
    html += '</div>';
  }
  if (typeof LLM !== 'undefined' && LLM.isActive())
    html += '<div class="ev-row"><button class="btn ghost smallbtn" data-action="llm-rephrase-answer">Rephrase with AI</button> <span class="tiny">Rewords only — the facts stay on this device.</span></div>';
  html += '</div></div><div id="llm-preview"></div>';
  return html;
};

/* ============================================================================
 * More — household rules, privacy & data
 * ========================================================================== */

App.vMore = async function (v, seq) {
  var m = App.state.more;
  if (m === 'rules') return App.vRules(v, seq);
  if (m === 'privacy') return App.vPrivacy(v, seq);
  if (m === 'accounts') return App.vAccounts(v, seq);
  if (m === 'ai') return App.vAi(v, seq);
  if (m === 'lookup') return App.vLookup(v, seq);
  var rules = await sAll('householdRules');
  var active = rules.filter(function (r) { return r.enabled !== false; }).length;
  var accounts = await sAll('accounts');
  var txns = await sAll('txns');
  var hasSample = txns.some(function (t) { return t && t.sampleBatch === 'v2-sample'; });
  App.show(v, seq, '<h1>More</h1>' +
    '<div class="card"><div class="section-head"><h3 style="margin:0">Accounts</h3><span class="pill">' + accounts.length + ' account' + (accounts.length === 1 ? '' : 's') + '</span></div>' +
    '<p class="small">Every card or account with imported statements. Rename an account, see its totals, and spot months missing statements.</p>' +
    '<button class="btn ghost" data-action="goto" data-tab="more" data-more="accounts">Manage accounts</button></div>' +
    '<div class="card"><div class="section-head"><h3 style="margin:0">Sample data</h3><span class="pill ' + (hasSample ? 'ok' : 'dim') + '">' + (hasSample ? 'loaded' : 'off') + '</span></div>' +
    (hasSample
      ? '<p class="small">Sample statements (“Sample data · YYYY-MM”) are loaded alongside your real statements. They are clearly labeled and can be removed any time.</p>' +
        '<button class="btn ghost" data-action="sample-remove">Remove sample data</button>'
      : '<p class="small">Explore the app with realistic demo data: 3 months of labeled sample statements (~85 transactions). Nothing is uploaded; remove it any time.</p>' +
        '<button class="btn ghost" data-action="sample-add">Try with sample data</button>') +
    '</div>' +
    '<div class="card"><div class="section-head"><h3 style="margin:0">Household rules</h3><span class="pill">' + active + ' active</span></div>' +
    '<p class="small">Corrections you turned into reusable rules. They apply to future imports automatically.</p>' +
    '<button class="btn ghost" data-action="goto" data-tab="more" data-more="rules">Manage rules</button></div>' +
    '<div class="card"><h3 style="margin:0 0 6px">Auto-categorize</h3>' +
    '<p class="small">Assign categories to imported transactions that don’t have one yet — your household rules first, then built-in Canadian merchant keywords. <strong>Never overwrites categories you set yourself.</strong></p>' +
    (App.state.backfillMsg ? '<div class="banner ok">' + esc(App.state.backfillMsg) + '</div>' : '') +
    '<button class="btn ghost" data-action="autocat-backfill">Auto-categorize transactions</button></div>' +
    '<div class="card"><h3 style="margin:0 0 6px">Privacy &amp; data</h3>' +
    '<p class="small"><strong>Your data stays on this device.</strong> The only network use is optional AI phrasing (which you preview and approve per call) and the opt-in merchant lookup (merchant names only). Export or delete any time.</p>' +
    '<button class="btn ghost" data-action="goto" data-tab="more" data-more="privacy">Privacy, export &amp; delete</button></div>' +
    '<div class="card"><div class="section-head"><h3 style="margin:0">AI phrasing</h3><span class="pill ' + (App.llmOn() ? 'ok' : 'dim') + '">' + (App.llmOn() ? 'on' : 'off') + '</span></div>' +
    '<p class="small">Optional. Rewords an answer in plainer language — the numbers are still computed on this device and never change. Off by default; every send needs your approval.</p>' +
    '<button class="btn ghost" data-action="goto" data-tab="more" data-more="ai">AI phrasing settings</button></div>' +
    '<div class="card"><div class="section-head"><h3 style="margin:0">Merchant lookup</h3><span class="pill ' + (App.lookupOn() ? 'ok' : 'dim') + '">' + (App.lookupOn() ? 'on' : 'off') + '</span></div>' +
    '<p class="small">Optional. Identifies unknown merchants with a one-time web search each — only the merchant name ever leaves this device. Off by default; needs your own free search key.</p>' +
    '<button class="btn ghost" data-action="goto" data-tab="more" data-more="lookup">Merchant lookup settings</button></div>' +
    '<div class="card"><h3 style="margin:0 0 6px">Take the tour again</h3>' +
    '<p class="small">Replay the 3-step first-run walkthrough.</p>' +
    '<button class="btn ghost" data-action="onboard-replay">Replay tour</button></div>');
};

/** Whether optional AI phrasing is currently enabled (BYO key, off by default). */
App.llmOn = function () {
  try { return typeof LLM !== 'undefined' && !!LLM.getSettings().enabled; }
  catch (e) { return false; }
};

/** More > AI phrasing: the optional BYO-key rewording settings. Off by
 *  default; nothing leaves the device until the user previews and approves
 *  the exact payload, every time. */
App.vAi = async function (v, seq) {
  var html = '<button class="linklike" data-action="back-more">\u2190 More</button><h1>AI phrasing</h1>' +
    '<div class="card"><p class="small" style="margin-top:0">Rephrases an answer in plainer words. ' +
    'The numbers are always computed on this device first and never change. ' +
    '<strong>Off by default</strong> \u2014 nothing leaves this device until you preview and approve ' +
    'the exact provider, model, privacy mode, and payload, every time. Your key is kept in memory only and forgotten when the app closes.</p>' +
    App.llmSettingsHtml() + '</div>';
  App.show(v, seq, html);
};

/* ---------------- online merchant lookup (opt-in, BYO Tavily key) --------
 * Identifies merchants the built-in keyword rules don't recognize, with one
 * web search per merchant. Privacy posture:
 *  - OFF by default; enabling it changes nothing until a key is set.
 *  - Only the merchant NAME is ever sent (Lookup.assertMerchantOnly runs
 *    before every send). Amounts, dates, accounts: never.
 *  - The key lives on this device only (localStorage), in memory while the
 *    app runs, never logged, never committed. Deleting it turns the
 *    feature off.
 *  - Clear identifications (>=2 agreeing web results) become household
 *    rules you can edit/delete; weaker evidence shows as a hint chip in
 *    Review; ambiguous merchants stay silent in Review (never-guess).
 */

/** Whether the lookup feature is currently live (enabled + key present). */
App.lookupOn = function () {
  try { return typeof Lookup !== 'undefined' && Lookup.isActive(); }
  catch (e) { return false; }
};

App.lookupSettingsHtml = function () {
  if (typeof Lookup === 'undefined') return '<p class="small">Lookup module failed to load.</p>';
  var s = Lookup.getSettings();
  var h = '<label class="switch"><input type="checkbox" data-change="lookup-enabled"' + (s.enabled ? ' checked' : '') + '> Enable merchant lookup</label>';
  h += '<label class="f" for="lookup-key">Tavily API key ' +
    (Lookup.hasKey() ? '<span class="pill ok">saved on this device</span>' : '<span class="pill dim">not set</span>') + '</label>' +
    '<input type="password" id="lookup-key" data-change="lookup-key" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="tvly-… (stored on this device only)">';
  h += '<div style="margin:4px 0"><button class="btn ghost smallbtn" data-action="lookup-test">Test connection</button>';
  if (Lookup.hasKey()) h += ' <button class="btn ghost smallbtn" data-action="lookup-forget-key">Delete key (turns lookup off)</button>';
  h += '</div>';
  if (App._lookupTest && App._lookupTest.message) h += '<div class="banner dim"><p class="small" style="margin:0">' + esc(App._lookupTest.message) + '</p></div>';
  if (s.lastStatus) h += '<div class="banner dim"><p class="small" style="margin:0">' + esc(s.lastStatus) + '</p></div>';
  h += '<div class="f">How to get a free key</div>' +
    '<p class="small">1. Sign up at <strong>tavily.com</strong> — the free “Researcher” plan includes 1,000 searches a month (at signup, look for the small “Continue on Free” text).<br>' +
    '2. Copy the API key from your Tavily dashboard (it starts with <code>tvly-</code>).<br>' +
    '3. Paste it above.</p>';
  h += '<p class="tiny">Off by default. When on, only the merchant <em>name</em> is sent to Tavily — never amounts, dates, or account info. Each merchant is looked up once ever; clear identifications become reusable household rules. The key never leaves this device except in direct HTTPS calls to Tavily.</p>';
  return h;
};

/** More > Merchant lookup: the opt-in web-identification settings. */
App.vLookup = async function (v, seq) {
  var html = '<button class="linklike" data-action="back-more">\u2190 More</button><h1>Merchant lookup</h1>' +
    '<div class="card"><p class="small" style="margin-top:0">Identifies merchants the built-in rules don\u2019t recognize, with a one-time web search per merchant. ' +
    'Clear matches are categorized automatically and saved as household rules you can edit or delete; uncertain ones stay in your review queue with a hint.</p>' +
    App.lookupSettingsHtml() + '</div>';
  App.show(v, seq, html);
};

App.Changes['lookup-enabled'] = function (el) { Lookup.saveSettings({ enabled: !!el.checked }); App.render(); };
App.Changes['lookup-key'] = function (el) { Lookup.setKey(el.value); /* no re-render: keeps focus while typing */ };
App.Actions['lookup-forget-key'] = function () { Lookup.clearKey(); Lookup.saveSettings({ enabled: false }); App.render(); };

/** "Test connection": one synthetic probe, exact plain-language result. */
App.Actions['lookup-test'] = function () {
  if (typeof Lookup === 'undefined') return;
  App._lookupTest = { message: 'Testing the connection…', at: Date.now() };
  App.render();
  var fetchFn = (typeof fetch !== 'undefined') ? fetch : null;
  Promise.resolve().then(function () { return Lookup.testConnection(fetchFn); }).then(function (r) {
    App._lookupTest = { message: String((r && r.message) || 'The test could not run. Try again.'), at: Date.now() };
    App.render();
  }, function () {
    App._lookupTest = { message: 'The test could not run. Try again.', at: Date.now() };
    App.render();
  });
};

/** Non-blocking toast used for lookup progress (works on any tab). */
App._lookupToast = function (text, sticky) {
  try {
    var el = document.getElementById('lookup-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'lookup-toast';
      el.className = 'lookup-toast';
      document.body.appendChild(el);
    }
    el.textContent = String(text || '');
    el.style.display = 'block';
    if (el._t) { clearTimeout(el._t); el._t = null; }
    if (!sticky) el._t = setTimeout(function () { el.style.display = 'none'; }, 30000);
  } catch (e) {}
};
App._lookupToastHide = function () {
  try {
    var el = document.getElementById('lookup-toast');
    if (el) { if (el._t) { clearTimeout(el._t); el._t = null; } el.style.display = 'none'; }
  } catch (e) {}
};

/**
 * App.runMerchantLookup(): identify still-uncategorized merchants via the
 * web. Never blocks: it runs after import/backfill complete, shows a
 * non-blocking progress toast, and re-renders once at the end. When the
 * feature is off (default) this is a no-op.
 */
App.runMerchantLookup = async function () {
  if (typeof Lookup === 'undefined' || !Lookup.isActive()) return;
  var txns;
  try { txns = await sAll('txns'); } catch (e) { return; }
  var cands;
  try { cands = Lookup.candidates(txns); } catch (e) { return; }
  if (!cands.length) return;
  App._lookupToast('Looking up ' + cands.length + ' merchant' + (cands.length === 1 ? '' : 's') + '\u2026');
  var summary = null;
  try {
    summary = await Lookup.processTxns(txns, {
      fetchFn: (typeof fetch !== 'undefined') ? fetch : null,
      getRules: function () { return sAll('householdRules'); },
      putRule: function (r) { return Store.put('householdRules', r); },
      putTxn: function (t) { return Store.put('txns', t); },
      onProgress: function (done, total) {
        App._lookupToast('Looking up merchants\u2026 ' + done + '/' + total);
      },
      audit: function (ev, et, id, d) { audit(ev, et, id, d); }
    });
  } catch (e) {
    summary = null; // processTxns already degrades per-merchant; this is belt & braces
  }
  App._lookupToastHide();
  if (summary && summary.ran && (summary.auto || summary.hints)) {
    App._lookupToast(Lookup.statusText(summary), true);
    setTimeout(App._lookupToastHide, 8000);
  }
  App.bumpDataRev();
  App.render();
  return summary;
};

App.vAccounts = async function (v, seq) {
  var accounts = await sAll('accounts');
  var statements = await sAll('statements');
  var txns = await sAll('txns');
  accounts.sort(function (a, b) {
    var an = String(a && a.name || '').toLowerCase(), bn = String(b && b.name || '').toLowerCase();
    return an < bn ? -1 : (an > bn ? 1 : 0);
  });
  var html = '<button class="linklike" data-action="back-more">← More</button><h1>Accounts</h1>';
  if (!accounts.length) {
    html += '<div class="empty">No accounts yet.<br><span class="small">Import a statement or try the sample data from the More menu.</span></div>';
    App.show(v, seq, html);
    return;
  }
  accounts.forEach(function (a) {
    var id = a && a.id;
    var acctStmts = statements.filter(function (s) { return s && String(s.accountId) === String(id); });
    var stmtIds = {};
    acctStmts.forEach(function (s) { stmtIds[s.id] = 1; });
    var acctTxns = txns.filter(function (t) { return t && stmtIds[t.statementId]; });
    var total = 0;
    for (var i = 0; i < acctTxns.length; i++) total += spendOf(acctTxns[i]);
    // Coverage strip: 12 months ending at the latest statement month (or now).
    var latest = null;
    acctStmts.forEach(function (s) {
      var m = String((s.periodEnd || s.periodStart || '')).slice(0, 7);
      if (/^\d{4}-\d{2}$/.test(m) && (!latest || m > latest)) latest = m;
    });
    var anchor = latest || planCurrentMonth();
    var months = lastNMonths(anchor, 12);
    var strip = '';
    for (var k = 0; k < months.length; k++) {
      var hit = Engine.monthCovered(acctStmts, months[k]);
      strip += '<span class="cov ' + (hit ? 'hit' : 'miss') + '" title="' + months[k] + '" aria-label="' + months[k] + (hit ? ': statement present' : ': missing') + '"></span>';
    }
    html += '<div class="card"><div class="acct-head">' +
      '<input type="text" class="acct-name" value="' + esc(a.name || '') + '" data-change="account-rename" data-id="' + esc(id) + '" aria-label="Account name">' +
      '<span class="pill' + (a.sampleBatch === 'v2-sample' ? ' ok' : ' dim') + '">' + esc(a.type || 'account') + '</span></div>' +
      '<p class="small" style="margin:4px 0 8px">spent ' + money(total) + ' across ' + acctTxns.length + ' transaction' + (acctTxns.length === 1 ? '' : 's') + '</p>' +
      '<div class="cov-strip" role="img" aria-label="Statement coverage for the last 12 months">' + strip + '</div>' +
      '<p class="tiny" style="margin:6px 0 0"><span class="cov hit legend"></span> has a statement &nbsp; <span class="cov miss legend"></span> missing &nbsp;·&nbsp; last 12 months ending ' + anchor + '</p>' +
      '</div>';
  });
  html += '<p class="tiny">Rename an account by editing its name above — the change is saved and logged automatically. The coverage strip shows at a glance which months have statements; a hollow month means that month’s data is missing.</p>';
  App.show(v, seq, html);
};

App.Changes['account-rename'] = async function (el) {
  var a = await sGet('accounts', el.dataset.id);
  if (!a) { App.render(); return; }
  var next = String(el.value || '').trim();
  if (!next || next === a.name) { App.render(); return; } // revert on blank/unchanged
  var old = a.name;
  a.name = next;
  await Store.put('accounts', a); // upsert: id present
  audit('account.renamed', 'account', a.id, { from: old, to: next });
  App.render();
};

/* ---------------- Sample data (More menu) ---------------- */

/**
 * App.Actions['autocat-backfill']: run Engine.autoCategorize over ALL stored
 * transactions. Rows with a user-set category (categorySource==='user' or
 * classificationSource==='user') are never touched. Reports how many
 * transactions newly received a category. Also runs automatically right
 * after the user confirms a new category rule, so one correction teaches
 * the whole existing ledger.
 */
App.runAutocatBackfill = async function () {
  var txns = await sAll('txns');
  var rules = rulePayloads(await enabledRules());
  var before = {};
  txns.forEach(function (t) { before[String(t.id)] = t.category || ''; });
  Engine.autoCategorize(txns, rules);
  var added = 0, refreshed = 0;
  for (var i = 0; i < txns.length; i++) {
    var t = txns[i];
    var was = before[String(t.id)] || '';
    var now = t.category || '';
    if (now !== was) {
      await Store.put('txns', t);
      if (!was && now) added++;
      else refreshed++;
    }
  }
  audit('categories.backfilled', 'ledger', null, { added: added, refreshed: refreshed, total: txns.length });
  App.state.backfillMsg = 'Auto-categorized ' + added + ' of ' + txns.length +
    ' transaction' + (txns.length === 1 ? '' : 's') + '.' +
    (refreshed ? ' ' + refreshed + ' refreshed by newer rules.' : '') +
    ' Your own categories were never touched.';
  App.bumpDataRev();
  App.render();
  // Opt-in online merchant lookup: identifies whatever the local rules left
  // unknown. Runs after the local backfill, never instead of it.
  setTimeout(function () { App.runMerchantLookup(); }, 0);
  return { added: added, refreshed: refreshed, total: txns.length };
};
App.Actions['autocat-backfill'] = function () { return App.runAutocatBackfill(); };

/** Insert Engine.sampleData(seed) into the stores, remapping local stmtKeys to real statement ids. */
App.insertSampleData = async function (data) {
  var acctId = await Store.put('accounts', data.account);
  var keyToId = {};
  // Stamp createdAt in insertion order (oldest month -> newest) so the
  // newest sample month sorts as "latest" in the Month/Statement views.
  // The Engine output stays pure (createdAt 0); stamping is an app-layer
  // insert concern and does not affect sampleData determinism.
  var now = Date.now();
  for (var i = 0; i < data.statements.length; i++) {
    var src = data.statements[i], st = {}, k;
    for (k in src) if (src.hasOwnProperty(k) && k !== 'stmtKey') st[k] = src[k];
    st.accountId = acctId;
    st.createdAt = now - (data.statements.length - 1 - i);
    keyToId[src.stmtKey] = await Store.put('statements', st);
  }
  for (var j = 0; j < data.txns.length; j++) {
    var tsrc = data.txns[j], tx = {};
    for (var k2 in tsrc) if (tsrc.hasOwnProperty(k2) && k2 !== 'stmtKey') tx[k2] = tsrc[k2];
    tx.statementId = keyToId[tsrc.stmtKey] || null;
    await Store.put('txns', tx);
  }
  return { accountId: acctId, statements: data.statements.length, txns: data.txns.length };
};

App.Actions['sample-add'] = async function () {
  var txns0 = await sAll('txns');
  if (txns0.some(function (t) { return t && t.sampleBatch === 'v2-sample'; })) { App.go('home'); return; }
  var n = await App.insertSampleData(Engine.sampleData(42));
  audit('sample.created', 'ledger', null, { seed: 42, batch: 'v2-sample', statements: n.statements, txns: n.txns });
  App.bumpDataRev();
  App.go('home');
};

App.Actions['sample-remove'] = async function (d, el) {
  if (!el || !el.dataset.armed) {
    if (el) {
      el.dataset.armed = '1';
      el.textContent = 'Tap again to remove sample data';
      setTimeout(function () {
        if (el.isConnected) { delete el.dataset.armed; el.textContent = 'Remove sample data'; }
      }, 3000);
    }
    return;
  }
  var removed = { txns: 0, statements: 0, accounts: 0 };
  var txns = await sAll('txns'), stmts = await sAll('statements'), accts = await sAll('accounts');
  for (var i = 0; i < txns.length; i++)
    if (txns[i] && txns[i].sampleBatch === 'v2-sample') { await Store.delete('txns', txns[i].id); removed.txns++; }
  for (var j = 0; j < stmts.length; j++)
    if (stmts[j] && stmts[j].sampleBatch === 'v2-sample') { await Store.delete('statements', stmts[j].id); removed.statements++; }
  for (var k = 0; k < accts.length; k++)
    if (accts[k] && accts[k].sampleBatch === 'v2-sample') { await Store.delete('accounts', accts[k].id); removed.accounts++; }
  audit('sample.removed', 'ledger', null, removed);
  App.bumpDataRev();
  App.go('more', { more: 'menu' });
};

/* ---------------- Onboarding (first-run 3-step tour) ---------------- */

var ONBOARD_STEPS = [
  { title: 'Add a statement',
    body: 'Import a CSV or PDF bank statement. Everything is read on this device — nothing is ever uploaded.' },
  { title: 'See your month',
    body: 'Your spending explained with evidence, on the Home tab. Every claim links back to the transactions behind it.' },
  { title: 'Ask anything',
    body: 'Ask “Where did my money go?” in the Home ask box and get answers with cited transactions — all computed on-device.' }
];

/** First-run hook: show the tour when there are no statements and it was never finished/skipped. */
App.maybeOnboard = async function () {
  if (!App.ready) return;
  var statements = await sAll('statements');
  if (statements.length) return;
  if (await App.prefGet('onboarded') === '1') return;
  App.state.onboardStep = 0;
  App.render();
};

/** Fixed-position first-run overlay (#onboard); no-op unless onboardStep is set. DOM-guarded for node tests. */
App.renderOnboarding = function () {
  if (typeof document === 'undefined') return;
  var step = App.state.onboardStep;
  var old = document.getElementById('onboard');
  if (step === null || step === undefined) { if (old) old.remove(); return; }
  step = Math.min(2, Math.max(0, step));
  var cur = ONBOARD_STEPS[step];
  var btns = '';
  if (step > 0) btns += '<button class="btn ghost" data-action="onboard-back">Back</button>';
  if (step < 2) btns += '<button class="btn" data-action="onboard-next">Next</button>';
  else btns += '<button class="btn" data-action="onboard-done">Done</button>';
  btns += '<button class="btn ghost" data-action="onboard-skip">Skip</button>';
  var html = '<div class="onboard-card"><div class="onboard-step">Step ' + (step + 1) + ' of 3</div>' +
    '<h2>' + esc(cur.title) + '</h2><p>' + esc(cur.body) + '</p>' +
    '<div class="btn-row">' + btns + '</div></div>';
  if (old) old.innerHTML = html;
  else {
    var d = document.createElement('div');
    d.id = 'onboard';
    d.innerHTML = html;
    document.body.appendChild(d);
  }
};

App.finishOnboarding = async function () {
  await App.prefSet('onboarded', '1');
  App.state.onboardStep = null;
  App.render();
};

App.Actions['onboard-next'] = function () {
  var next = (App.state.onboardStep || 0) + 1;
  if (next > 2) { App.finishOnboarding(); return; }
  App.state.onboardStep = next;
  App.render();
};
App.Actions['onboard-back'] = function () {
  App.state.onboardStep = Math.max(0, (App.state.onboardStep || 0) - 1);
  App.render();
};
App.Actions['onboard-skip'] = function () { App.finishOnboarding(); };
App.Actions['onboard-done'] = function () { App.finishOnboarding(); };
App.Actions['onboard-replay'] = function () { App.state.onboardStep = 0; App.render(); };

App.vRules = async function (v, seq) {
  var rules = await sAll('householdRules');
  rules.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
  var html = '<button class="linklike" data-action="back-more">← More</button><h1>Household rules</h1>';
  if (!rules.length) {
    html += '<div class="empty">No rules yet.<br><span class="small">Correct a transaction in the Statement view and choose “Make this a rule”.</span></div>';
  }
  rules.forEach(function (r) {
    var on = r.enabled !== false;
    // Flat V4 shape: {id, enabled, priority, matchMerchant, kind, category,
    // label} + legacy appMatch.setCategory for older category rules.
    var ruleCat = r.category || (r.appMatch && r.appMatch.setCategory) || null;
    var effect = r.kind ? ('kind → ' + kindLabel(r.kind))
      : ('category → ' + esc(catName(ruleCat)));
    html += '<div class="rule"><div class="r-head">' +
      '<span class="r-name">' + esc(r.label || (r.ruleType === 'category' ? 'Category rule' : 'Kind rule')) + '</span>' +
      '<span class="pill ' + (on ? 'ok' : 'dim') + '">' + (on ? 'on' : 'off') + '</span></div>' +
      '<div class="r-scope">' + esc(r.scopeDescription || '(no description)') + '</div>' +
      (r.matchMerchant ? '<div class="tiny">Matches merchant containing “' + esc(r.matchMerchant) + '” → ' + effect + '</div>' : '');
    if (r.ruleType === 'category' || (!r.kind && ruleCat)) {
      // Let the user change the rule's category; stored on both the flat
      // field and the legacy appMatch so old and new readers agree.
      html += '<label class="f" for="rule-cat-' + esc(r.id) + '">Category</label>' +
        '<select id="rule-cat-' + esc(r.id) + '" data-change="rule-cat-change" data-id="' + esc(r.id) + '">' +
        App.categories.map(function (c) {
          return '<option value="' + esc(c.id) + '"' + (String(ruleCat) === String(c.id) ? ' selected' : '') + '>' + esc(c.name) + '</option>';
        }).join('') + '</select>';
    }
    html += '<div class="r-actions">' +
      '<label class="switch"><input type="checkbox" data-change="rule-toggle" data-id="' + esc(r.id) + '"' + (on ? ' checked' : '') + '> Enabled</label>' +
      '<button class="btn ghost smallbtn" data-action="rule-delete" data-id="' + esc(r.id) + '">Delete</button>' +
      '</div></div>';
  });
  html += '<p class="tiny">Disabling is reversible. Deletion is logged in the audit trail; re-create the rule from a new correction to restore it.</p>';
  App.show(v, seq, html);
};

App.Changes['rule-toggle'] = async function (el) {
  var r = await sGet('householdRules', el.dataset.id);
  if (!r) return;
  r.enabled = el.checked;
  await Store.put('householdRules', r);
  audit(el.checked ? 'rule.enabled' : 'rule.disabled', 'householdRule', r.id, {});
  App.bumpDataRev();
  App.render();
};

/** Change a category rule's category (writes both the flat field and the
 * legacy appMatch.setCategory so old and new readers agree). */
App.Changes['rule-cat-change'] = async function (el) {
  var r = await sGet('householdRules', el.dataset.id);
  if (!r || !el.value) { App.render(); return; }
  var old = r.category || (r.appMatch && r.appMatch.setCategory) || null;
  r.category = el.value;
  if (r.appMatch) r.appMatch.setCategory = el.value;
  await Store.put('householdRules', r);
  audit('rule.category_changed', 'householdRule', r.id, { from: old, to: el.value });
  App.bumpDataRev();
  App.render();
};

App.Actions['rule-delete'] = async function (d, el) {
  if (!el.dataset.armed) {
    el.dataset.armed = '1';
    el.textContent = 'Tap again to delete';
    setTimeout(function () { if (el.isConnected) { delete el.dataset.armed; el.textContent = 'Delete'; } }, 3000);
    return;
  }
  var r = await sGet('householdRules', d.id);
  await Store.delete('householdRules', d.id);
  audit('rule.deleted', 'householdRule', d.id, { ruleType: r && r.ruleType, scope: r && r.scopeDescription });
  App.bumpDataRev();
  App.render();
};

App.vPrivacy = async function (v, seq) {
  var html = '<button class="linklike" data-action="back-more">← More</button><h1>Privacy &amp; data</h1>';
  html += '<div class="banner info"><strong>Your data never leaves this device.</strong><br>' +
    'This app has no backend, sends no telemetry, and loads nothing from the internet. ' +
    'Your financial data makes zero network calls — the only exception is optional AI phrasing ' +
    '(off by default), which contacts only the provider you configure, only after you preview and approve each payload.</div>';

  var backend = Store.backend();
  var backendLabel = backend === 'idb' ? 'IndexedDB' : backend === 'local' ? 'localStorage' : 'unavailable';
  html += '<div class="card"><h3 style="margin-top:0">What’s stored, where</h3>' +
    '<table class="kv">' +
    '<tr><th>Ledger &amp; rules</th><td>' + esc(backendLabel) + ' on this device — statements, transactions, merchants, categories, household rules, corrections, matches, allocations, refund links, briefings, audit events</td></tr>' +
    '<tr><th>Receipt photos</th><td>' + esc(backendLabel) + ', as image blobs — never uploaded</td></tr>' +
    '<tr><th>Cookies / localStorage</th><td>' + (backend === 'local' ? 'In use as the fallback store on this browser (IndexedDB unavailable here)' : 'Not used for your data') + '</td></tr>' +
    '<tr><th>Network</th><td>Zero requests for your financial data (verify in devtools). Optional AI phrasing is the only network use, and only with your per-call approval.</td></tr></table></div>';

  var nStmt = (await sAll('statements')).length;
  var nTxn = (await sAll('txns')).length;
  var nRcpt = (await sAll('receipts')).length;
  html += '<div class="card"><h3 style="margin-top:0">Where your data lives</h3>' +
    '<table class="kv">' +
    '<tr><th>Storage in use</th><td>' + esc(backendLabel) + ' — on this device only</td></tr>' +
    '<tr><th>Statements</th><td>' + nStmt + '</td></tr>' +
    '<tr><th>Transactions</th><td>' + nTxn + '</td></tr>' +
    '<tr><th>Receipts</th><td>' + nRcpt + '</td></tr></table>' +
    '<p class="small">Your data lives only in this browser, on this device. ' +
    'Opening the link in a different browser, a private tab, or another app will show an empty app — ' +
    'that is expected, your data is still here.</p></div>';

  html += '<div class="card"><h3 style="margin-top:0">Export</h3>' +
    '<p class="small">Take your data with you — still without any network involved.</p>' +
    '<div class="btn-row"><button class="btn ghost" data-action="export-json">Ledger JSON</button>' +
    '<button class="btn ghost" data-action="export-csv">Transactions CSV</button></div></div>';

  var events = await sAll('auditEvents');
  events.sort(function (a, b) { return (b.at || b.createdAt || 0) - (a.at || a.createdAt || 0); });
  html += '<details class="more"><summary>Recent activity (' + events.length + ' audit events)</summary>';
  if (!events.length) html += '<p class="small">No activity yet.</p>';
  else {
    html += '<ul class="list-plain">' + events.slice(0, 10).map(function (e) {
      var when = e.timestamp || e.at || e.createdAt;
      return '<li><span class="mono">' + esc(e.eventType || e.type || '?') + '</span> <span class="tiny">' +
        esc(e.entityType || '') + ' ' + esc(e.entityId != null ? String(e.entityId) : '') + ' · ' +
        esc(when ? new Date(when).toLocaleString() : '') + '</span></li>';
    }).join('') + '</ul>';
  }
  html += '</details>';

  html += '<div class="card" style="border-color:var(--danger)"><h3 style="margin-top:0">Delete everything</h3>' +
    '<p class="small">Wipes the entire on-device database: statements, transactions, receipts, rules, briefings, audit trail. This cannot be undone.</p>' +
    '<label class="f" for="wipe-confirm">Type <span class="mono">DELETE</span> to confirm</label>' +
    '<input type="text" id="wipe-confirm" autocomplete="off" placeholder="DELETE">' +
    '<button class="btn danger" data-action="wipe-go">Delete everything</button></div>';

  App.show(v, seq, html);
};

App.Actions['export-json'] = async function () {
  var data = null;
  try { data = await Store.exportAll(); } catch (e) { data = { error: String(e) }; }
  var stamp = new Date().toISOString().slice(0, 10);
  download('explain-my-money-ledger-' + stamp + '.json', JSON.stringify(data, null, 2), 'application/json');
  audit('export.created', 'ledger', null, { format: 'json' });
};

App.Actions['export-csv'] = async function () {
  var txns = await sAll('txns');
  var cols = ['id', 'statementId', 'rowIndex', 'date', 'merchantRaw', 'rawDescription', 'amountMinor', 'currency', 'kind', 'category', 'excluded', 'status', 'confidence', 'kindReason'];
  var q = function (v) { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  var lines = [cols.join(',')];
  txns.forEach(function (t) { lines.push(cols.map(function (c) { return q(t[c]); }).join(',')); });
  var stamp = new Date().toISOString().slice(0, 10);
  download('explain-my-money-transactions-' + stamp + '.csv', lines.join('\n'), 'text/csv');
  audit('export.created', 'ledger', null, { format: 'csv', rows: txns.length });
};

App.Actions['wipe-go'] = async function () {
  var input = $('#wipe-confirm');
  if (!input || input.value.trim() !== 'DELETE') {
    if (input) { input.style.borderColor = 'var(--danger)'; input.focus(); }
    return;
  }
  audit('data.wipe_requested', 'ledger', null, {});
  try { await Store.wipeAll(); } catch (e) { /* fall through to reset */ }
  // Reset in-memory state; categories re-seed on next boot.
  App.state = { tab: 'add', addView: 'home', statementId: null, sfilter: 'review', txnId: null,
                more: 'menu', onboardStep: null, askQ: null, askText: '', receiptMsg: '', ruleOffer: null,
                pending: null, pipe: null, dupPairs: null, txnShown: 60, txnSearch: '',
                splitForm: null, manualMsg: '', dataRev: 0,
                planView: 'budgets', budgetMonth: null, budgetEditId: null,
                goalEditId: null, planMsg: '', month: null, backfillMsg: '',
                homeCat: null, txnRet: null };
  App.categories = [];
  await App.seedCategories();
  App.go('add');
};

/* ============================================================================
 * Plan view (Phase 2): budgets, goals, subscriptions — opened from Home
 * ----------------------------------------------------------------------------
 * All money inputs go through App.parseDollarsToMinor — strict, integer-only:
 * an optional "$", 1-9 digits, optional .NN cents. Commas are NOT accepted
 * (they are ambiguous across locales), negatives are not allowed; anything
 * else returns null and the UI refuses to save instead of guessing.
 * Tracking language only: budgets/goals report what happened, never advice
 * like "you can afford X".
 * ========================================================================== */

/**
 * App.parseDollarsToMinor(text) -> int minor units, or null.
 * Strict: /^\$?\s*(\d{1,9})(?:\.(\d{1,2}))?\s*$/. Integer math only —
 * no parseFloat anywhere near money. Commas rejected (-> null) by design.
 */
App.parseDollarsToMinor = function (text) {
  var m = /^\$?\s*(\d{1,9})(?:\.(\d{1,2}))?\s*$/.exec(String(text == null ? '' : text));
  if (!m) return null;
  var dollars = m[1], cents = m[2] || '';
  while (cents.length < 2) cents += '0';
  var minor = 0;
  for (var i = 0; i < dollars.length; i++) minor = minor * 10 + (dollars.charCodeAt(i) - 48);
  minor = minor * 100 + (cents.charCodeAt(0) - 48) * 10 + (cents.charCodeAt(1) - 48);
  return minor;
};

/** Dismiss-slug for a subscription: normalized merchant with [^a-z0-9]+ -> '_'. */
App.subDismissSlug = function (merchant) {
  return Engine._normSubMerchant(merchant).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
};

/* ---------------- Plan shell ---------------- */

App.Actions['plan-view'] = function (d) {
  App.state.planView = d.pv || 'budgets';
  App.state.budgetEditId = null;
  App.state.goalEditId = null;
  App.render();
};

App.vPlan = async function (v, seq) {
  var s = App.state;
  if (s.planView !== 'goals' && s.planView !== 'subs') s.planView = 'budgets';
  var html = '<h1>Plan</h1>';
  if (s.planMsg) { html += '<div class="banner info">' + esc(s.planMsg) + '</div>'; s.planMsg = ''; }
  html += '<div class="tabs" role="tablist">';
  var views = [['budgets', 'Budgets'], ['goals', 'Goals'], ['subs', 'Subscriptions']];
  for (var i = 0; i < views.length; i++) {
    html += '<button class="chip' + (s.planView === views[i][0] ? ' on' : '') + '" role="tab" ' +
      'data-action="plan-view" data-pv="' + views[i][0] + '">' + views[i][1] + '</button>';
  }
  html += '</div>';
  if (s.planView === 'goals') html += await App.vPlanGoals();
  else if (s.planView === 'subs') html += await App.vPlanSubs();
  else html += await App.vPlanBudgets();
  App.show(v, seq, html);
};

/* ---------------- Plan: budgets ---------------- */

function planCurrentMonth() {
  var n = new Date();
  return n.getFullYear() + '-' + ('0' + (n.getMonth() + 1)).slice(-2);
}

function prevMonthOf(ym) {
  var y = +String(ym).slice(0, 4), m = +String(ym).slice(5, 7);
  m -= 1;
  if (m < 1) { m = 12; y -= 1; }
  return y + '-' + ('0' + m).slice(-2);
}

/** Default month for budget views: the latest statement's periodEnd month,
 * else the current calendar month. Shared by the Plan view and Home
 * view's budget summary card. */
App.defaultBudgetMonth = function (stmts) {
  var curMonth = planCurrentMonth();
  var sorted = (stmts || []).slice().sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
  if (sorted.length) {
    var pe = /^(\d{4})-(\d{2})/.exec(String(sorted[0].periodEnd || ''));
    if (pe) return pe[1] + '-' + pe[2];
  }
  return curMonth;
};

App.vPlanBudgets = async function () {
  var stmts = await sAll('statements');
  var curMonth = planCurrentMonth();
  var defMonth = App.defaultBudgetMonth(stmts);
  if (!App.state.budgetMonth || !/^\d{4}-\d{2}$/.test(App.state.budgetMonth)) {
    App.state.budgetMonth = defMonth;
  }
  var month = App.state.budgetMonth;
  var readOnly = month < curMonth; // past months: actuals only, no editing

  var html = '<div class="card"><label class="f" for="budget-month">Month</label>' +
    '<input type="month" id="budget-month" data-change="budget-month" value="' + esc(month) + '">' +
    '<p class="tiny" style="margin-bottom:0">Showing ' + esc(fmtPeriod(month)) +
    (readOnly ? ' — past months are read-only.' : '') + '</p></div>';

  var budgets = (await sAll('budgets')).filter(function (b) { return b.month === month; });
  budgets.sort(function (a, b) { return String(a.category).localeCompare(String(b.category)); });
  var txns = await sAll('txns');

  html += '<div class="card"><h3 style="margin-top:0">Budgets for ' + esc(fmtPeriod(month)) + '</h3>';
  if (!budgets.length) {
    html += '<p class="small" style="margin-bottom:0">' +
      (readOnly ? 'No budgets were set for this month.' : 'No budgets set yet — add one below or copy last month\u2019s.') + '</p>';
  } else {
    budgets.forEach(function (b) {
      var spent = 0;
      try { spent = Engine.categorySpendMinor(txns, b.category, month); } catch (e) { spent = 0; }
      var limit = b.limitMinor || 0;
      var over = spent > limit;
      var pct = limit > 0 ? Math.min(100, Math.round(spent * 100 / limit)) : (spent > 0 ? 100 : 0);
      html += '<div class="bar-row"' + (over ? ' style="border-left:3px solid var(--danger);padding-left:6px"' : '') + '>' +
        '<span class="b-label">' + esc(catName(b.category)) + '</span>' +
        '<span class="b-track"><span class="b-fill" style="width:' + pct + '%;' +
        (over ? 'background:var(--danger);' : '') + '"></span></span>' +
        '<span class="b-amt">' + money(spent) + ' / ' + money(limit) + '</span></div>';
      if (over) {
        html += '<div><span class="pill bad">Over budget by ' + money(spent - limit) + '</span></div>';
      }
      if (!readOnly) {
        html += '<div class="btn-row" style="margin:4px 0 10px">' +
          '<button class="btn ghost smallbtn" data-action="budget-edit" data-id="' + esc(b.id) + '">Edit</button>' +
          '<button class="btn ghost smallbtn" data-action="budget-delete" data-id="' + esc(b.id) + '">Delete</button></div>';
      }
    });
  }
  html += '</div>';

  if (!readOnly) {
    var editing = App.state.budgetEditId ? (await sGet('budgets', App.state.budgetEditId)) : null;
    html += '<div class="card"><h3 style="margin-top:0">' + (editing ? 'Edit budget' : 'Add a budget') + '</h3>' +
      '<label class="f" for="budget-cat">Category</label><select id="budget-cat">';
    for (var i = 0; i < App.categories.length; i++) {
      var c = App.categories[i];
      var sel = (editing && String(editing.category) === String(c.id)) ? ' selected' : '';
      html += '<option value="' + esc(c.id) + '"' + sel + '>' + esc(c.name) + '</option>';
    }
    html += '</select>' +
      '<label class="f" for="budget-limit">Monthly limit (e.g. 400 or 400.00)</label>' +
      '<input type="text" id="budget-limit" inputmode="decimal" autocomplete="off" placeholder="400.00"' +
      (editing ? ' value="' + (Math.floor(editing.limitMinor / 100)) + '.' +
        ('0' + (editing.limitMinor % 100)).slice(-2) + '"' : '') + '>' +
      '<div class="btn-row"><button class="btn" data-action="budget-save">' +
      (editing ? 'Save changes' : 'Add budget') + '</button>';
    if (editing) html += '<button class="btn ghost" data-action="budget-cancel">Cancel</button>';
    html += '</div><p class="tiny" style="margin-bottom:0">Whole dollars and cents only — no commas.</p></div>';

    var prev = prevMonthOf(month);
    html += '<div class="card"><button class="btn ghost" data-action="budget-copy">' +
      'Copy ' + esc(fmtPeriod(prev)) + '\u2019s budgets</button>' +
      '<p class="tiny" style="margin-bottom:0">Copies each of last month\u2019s budgets into ' +
      esc(fmtPeriod(month)) + ' unless that category already has one.</p></div>';
  }
  return html;
};

App.Changes['budget-month'] = function (el) {
  if (/^\d{4}-\d{2}$/.test(el.value || '')) {
    App.state.budgetMonth = el.value;
    App.state.budgetEditId = null;
    App.render();
  }
};

App.Actions['budget-edit'] = function (d) {
  App.state.budgetEditId = d.id;
  App.render();
};

App.Actions['budget-cancel'] = function () {
  App.state.budgetEditId = null;
  App.render();
};

App.Actions['budget-save'] = async function () {
  var catEl = $('#budget-cat'), limEl = $('#budget-limit');
  var cat = catEl ? catEl.value : '';
  var amt = App.parseDollarsToMinor(limEl ? limEl.value : '');
  if (!cat) { App.state.planMsg = 'Choose a category.'; App.render(); return; }
  if (amt === null || amt <= 0) {
    App.state.planMsg = 'Enter a valid limit like 400 or 400.00 (digits and an optional decimal point — no commas, no negatives).';
    App.render(); return;
  }
  var month = App.state.budgetMonth;
  if (App.state.budgetEditId) {
    var b = await sGet('budgets', App.state.budgetEditId);
    if (!b) { App.state.budgetEditId = null; App.render(); return; }
    b.category = cat; b.limitMinor = amt;
    await Store.put('budgets', b);
    audit('budget.updated', 'budget', b.id, { month: b.month, category: cat, limitMinor: amt });
    App.state.budgetEditId = null;
  } else {
    var dup = (await sAll('budgets')).filter(function (x) {
      return x.month === month && String(x.category) === String(cat);
    });
    if (dup.length) {
      App.state.planMsg = 'That category already has a budget for this month — edit it instead.';
      App.render(); return;
    }
    var id = await Store.put('budgets', { category: cat, month: month, limitMinor: amt });
    audit('budget.created', 'budget', id, { month: month, category: cat, limitMinor: amt });
  }
  App.bumpDataRev();
  App.render();
};

App.Actions['budget-delete'] = async function (d, el) {
  if (!el.dataset.armed) {
    el.dataset.armed = '1';
    el.textContent = 'Tap again to delete';
    setTimeout(function () { if (el.isConnected) { delete el.dataset.armed; el.textContent = 'Delete'; } }, 3000);
    return;
  }
  var b = await sGet('budgets', d.id);
  await Store.delete('budgets', d.id);
  audit('budget.deleted', 'budget', d.id, { month: b && b.month, category: b && b.category, limitMinor: b && b.limitMinor });
  App.bumpDataRev();
  App.render();
};

App.Actions['budget-copy'] = async function () {
  var month = App.state.budgetMonth;
  var prev = prevMonthOf(month);
  var all = await sAll('budgets');
  var prevB = all.filter(function (b) { return b.month === prev; });
  var have = {};
  all.filter(function (b) { return b.month === month; }).forEach(function (b) { have[String(b.category)] = 1; });
  var n = 0;
  for (var i = 0; i < prevB.length; i++) {
    if (have[String(prevB[i].category)]) continue;
    await Store.put('budgets', { category: prevB[i].category, month: month, limitMinor: prevB[i].limitMinor });
    n++;
  }
  audit('budget.copied', 'budget', null, { from: prev, to: month, count: n });
  App.state.planMsg = n > 0
    ? ('Copied ' + n + ' budget' + (n === 1 ? '' : 's') + ' from ' + fmtPeriod(prev) + '.')
    : ('No budgets to copy from ' + fmtPeriod(prev) + '.');
  App.bumpDataRev();
  App.render();
};

/* ---------------- Plan: goals ---------------- */

App.vPlanGoals = async function () {
  var goals = await sAll('goals');
  goals.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
  var html = '';
  if (!goals.length) {
    html += '<div class="empty">No goals yet — name one below and track what you\u2019ve set aside toward it.</div>';
  }
  goals.forEach(function (g) {
    var saved = g.savedMinor || 0, target = g.targetMinor || 0;
    var done = target > 0 && saved >= target;
    var pct = target > 0 ? Math.min(100, Math.round(saved * 100 / target)) : (saved > 0 ? 100 : 0);
    html += '<div class="card"><h3 style="margin-top:0">' + esc(g.name || 'Goal') +
      (done ? ' <span class="pill ok">Complete \uD83C\uDF89</span>' : '') + '</h3>';
    html += '<div class="bar-row"><span class="b-label">Saved</span>' +
      '<span class="b-track"><span class="b-fill" style="width:' + pct + '%"></span></span>' +
      '<span class="b-amt">' + money(saved) + ' / ' + money(target) + '</span></div>';
    if (g.targetDate) html += '<p class="small">Target date: ' + esc(fmtDate(g.targetDate)) + '</p>';
    if (g.note) html += '<p class="small">' + esc(g.note) + '</p>';
    html += '<div class="btn-row" style="align-items:center">' +
      '<input type="text" id="contrib-' + esc(g.id) + '" inputmode="decimal" autocomplete="off" ' +
      'placeholder="Log amount, e.g. 25.00" style="flex:1;min-width:0">' +
      '<button class="btn smallbtn" data-action="goal-contrib" data-id="' + esc(g.id) + '">Log</button>' +
      '<button class="btn ghost smallbtn" data-action="goal-edit" data-id="' + esc(g.id) + '">Edit</button>' +
      '<button class="btn ghost smallbtn" data-action="goal-delete" data-id="' + esc(g.id) + '">Delete</button></div></div>';
  });

  var editing = App.state.goalEditId ? (await sGet('goals', App.state.goalEditId)) : null;
  html += '<div class="card"><h3 style="margin-top:0">' + (editing ? 'Edit goal' : 'Add a goal') + '</h3>' +
    '<label class="f" for="goal-name">Name</label>' +
    '<input type="text" id="goal-name" autocomplete="off" placeholder="e.g. Emergency fund"' +
    (editing ? ' value="' + esc(editing.name) + '"' : '') + '>' +
    '<label class="f" for="goal-target">Target amount (e.g. 1000 or 1000.00)</label>' +
    '<input type="text" id="goal-target" inputmode="decimal" autocomplete="off" placeholder="1000.00"' +
    (editing ? ' value="' + (Math.floor(editing.targetMinor / 100)) + '.' +
      ('0' + (editing.targetMinor % 100)).slice(-2) + '"' : '') + '>' +
    '<label class="f" for="goal-date">Target date (optional)</label>' +
    '<input type="date" id="goal-date"' + (editing && editing.targetDate ? ' value="' + esc(editing.targetDate) + '"' : '') + '>' +
    '<label class="f" for="goal-note">Note (optional)</label>' +
    '<input type="text" id="goal-note" autocomplete="off"' +
    (editing && editing.note ? ' value="' + esc(editing.note) + '"' : '') + '>' +
    '<div class="btn-row"><button class="btn" data-action="goal-save">' +
    (editing ? 'Save changes' : 'Add goal') + '</button>';
  if (editing) html += '<button class="btn ghost" data-action="goal-cancel">Cancel</button>';
  html += '</div></div>';
  return html;
};

App.Actions['goal-edit'] = function (d) {
  App.state.goalEditId = d.id;
  App.render();
};

App.Actions['goal-cancel'] = function () {
  App.state.goalEditId = null;
  App.render();
};

App.Actions['goal-save'] = async function () {
  var nameEl = $('#goal-name'), tgtEl = $('#goal-target'), dateEl = $('#goal-date'), noteEl = $('#goal-note');
  var name = nameEl ? String(nameEl.value || '').replace(/^\s+|\s+$/g, '') : '';
  var target = App.parseDollarsToMinor(tgtEl ? tgtEl.value : '');
  var tdate = dateEl && /^\d{4}-\d{2}-\d{2}$/.test(dateEl.value || '') ? dateEl.value : null;
  var note = noteEl ? String(noteEl.value || '').replace(/^\s+|\s+$/g, '') : '';
  if (!name) { App.state.planMsg = 'Give the goal a name.'; App.render(); return; }
  if (target === null || target <= 0) {
    App.state.planMsg = 'Enter a valid target like 1000 or 1000.00 (digits and an optional decimal point — no commas, no negatives).';
    App.render(); return;
  }
  if (App.state.goalEditId) {
    var g = await sGet('goals', App.state.goalEditId);
    if (!g) { App.state.goalEditId = null; App.render(); return; }
    g.name = name; g.targetMinor = target; g.targetDate = tdate; g.note = note || null;
    await Store.put('goals', g);
    audit('goal.updated', 'goal', g.id, { name: name, targetMinor: target });
    App.state.goalEditId = null;
  } else {
    var id = await Store.put('goals', {
      name: name, targetMinor: target, savedMinor: 0, targetDate: tdate,
      note: note || null, createdAt: Date.now()
    });
    audit('goal.created', 'goal', id, { name: name, targetMinor: target });
  }
  App.bumpDataRev();
  App.render();
};

App.Actions['goal-contrib'] = async function (d) {
  var input = document.getElementById('contrib-' + d.id);
  var amt = App.parseDollarsToMinor(input ? input.value : '');
  if (amt === null || amt <= 0) {
    App.state.planMsg = 'Enter a valid amount like 25.00 to log a contribution.';
    App.render(); return;
  }
  var g = await sGet('goals', d.id);
  if (!g) return;
  g.savedMinor = (g.savedMinor || 0) + amt; // integer math only
  await Store.put('goals', g);
  audit('goal.contributed', 'goal', g.id, { amountMinor: amt, savedMinor: g.savedMinor });
  App.bumpDataRev();
  App.render();
};

App.Actions['goal-delete'] = async function (d, el) {
  if (!el.dataset.armed) {
    el.dataset.armed = '1';
    el.textContent = 'Tap again to delete';
    setTimeout(function () { if (el.isConnected) { delete el.dataset.armed; el.textContent = 'Delete'; } }, 3000);
    return;
  }
  var g = await sGet('goals', d.id);
  await Store.delete('goals', d.id);
  audit('goal.deleted', 'goal', d.id, { name: g && g.name });
  if (String(App.state.goalEditId) === String(d.id)) App.state.goalEditId = null;
  App.bumpDataRev();
  App.render();
};

/* ---------------- Plan: subscriptions ---------------- */

var SUB_CADENCE_LABELS = { monthly: 'Monthly', weekly: 'Weekly', yearly: 'Yearly' };

App.vPlanSubs = async function () {
  var txns = await sAll('txns');
  var subs = [];
  try { subs = Engine.detectSubscriptions(txns) || []; } catch (e) { subs = []; }
  var visible = [];
  var total = 0;
  for (var i = 0; i < subs.length; i++) {
    var slug = App.subDismissSlug(subs[i].merchant);
    var dismissed = await App.prefGet('sub_dismissed_' + slug);
    if (dismissed) continue;
    visible.push({ sub: subs[i], slug: slug });
    total += subs[i].monthlyCostMinor || 0;
  }

  var html = '<div class="card"><div class="headline-label">Recurring charges detected</div>' +
    '<div class="headline-num">\u2248 ' + money(total) + '/mo</div>' +
    '<p class="small" style="margin-bottom:0">Across ' + visible.length + ' subscription' +
    (visible.length === 1 ? '' : 's') + '. Detected on-device from your statements — ' +
    'dismiss anything that isn\u2019t really recurring. Nothing here is a recommendation.</p></div>';

  if (!visible.length) {
    html += '<div class="empty">No recurring charges detected yet.<br>' +
      '<span class="small">Subscriptions appear after at least 3 matching charges with a steady monthly, weekly, or yearly cadence.</span></div>';
    return html;
  }
  visible.forEach(function (vs) {
    var s = vs.sub;
    var cad = SUB_CADENCE_LABELS[s.cadence] || s.cadence;
    html += '<div class="card"><div class="bar-row"><span class="b-label">' + esc(s.displayName) + '</span>' +
      '<span class="b-amt">' + money(s.amountMinor) + ' · ' + esc(cad) + '</span></div>' +
      '<p class="small" style="margin:4px 0">' + s.occurrences + ' charge' + (s.occurrences === 1 ? '' : 's') +
      ' · last ' + esc(fmtDate(s.lastDate)) + ' · next expected ' + esc(fmtDate(s.nextExpected)) +
      ' · \u2248 ' + money(s.monthlyCostMinor) + '/mo</p>' +
      '<div class="btn-row" style="align-items:center">' +
      (s.priceChanged ? '<span class="pill warn">Price changed</span>' : '') +
      '<button class="btn ghost smallbtn" data-action="sub-dismiss" data-slug="' + esc(vs.slug) + '">Dismiss</button></div></div>';
  });
  return html;
};

App.Actions['sub-dismiss'] = async function (d) {
  if (!d.slug) return;
  await App.prefSet('sub_dismissed_' + d.slug, '1');
  audit('sub.dismissed', 'subscription', d.slug, {});
  App.render();
};

/* Test hooks: pure helpers exposed for node smoke tests (no DOM needed). */
App._test = {
  deleteStatement: App.deleteStatement,
  sha256Hex: sha256Hex, esc: esc, money: money, spendAbs: spendAbs, fmtDate: fmtDate, fmtPeriod: fmtPeriod,
  prettify: prettify, kindLabel: kindLabel, merchantCore: merchantCore, receiptForScore: receiptForScore,
  parseManualAmount: parseManualAmount, spendOf: spendOf, txnTab: txnTab, dollarsText: dollarsText,
  searchTxns: App.searchTxns, applyBalanceCheckPolicy: App.applyBalanceCheckPolicy,
  defaultBudgetMonth: App.defaultBudgetMonth, catLabelSmart: catLabelSmart,
  parseDollarsToMinor: App.parseDollarsToMinor, subDismissSlug: App.subDismissSlug,
  matchQuestion: App.matchQuestion, shortHash: shortHash,
  _paginate: App._paginate, _dupCacheKey: App._dupCacheKey, TXN_PAGE_SIZE: App.TXN_PAGE_SIZE,
  /* Auto-categorization (Problem A) + Month aggregation (Problem B). */
  needsCategory: needsCategory, needsReview: App.needsReview, reviewTxns: App.reviewTxns, monthsWithData: App.monthsWithData,
  latestTxnMonth: App.latestTxnMonth, txnsInMonth: App.txnsInMonth,
  statementCoverage: App.statementCoverage,
  /* PDF job controller (node-testable via the fakes in tests/pdf-resume.node.js). */
  runPdfJob: App.runPdfJob, pdfJobLoop: App.pdfJobLoop,
  pdfJobExtractPage: App.pdfJobExtractPage, pdfJobVisibility: App.pdfJobVisibility,
  pdfJobRecover: App.pdfJobRecover, pdfJobStatusText: App.pdfJobStatusText,
  pdfJobEtaText: App.pdfJobEtaText, pdfJobCardInner: App.pdfJobCardInner,
  pdfCacheSave: App.pdfCacheSave, pdfCacheEvict: App.pdfCacheEvict,
  pdfJobShowPreview: App.pdfJobShowPreview, vPdfReading: App.vPdfReading
};

/* ============================================================================
 * Global export + init
 * ========================================================================== */

if (typeof window !== 'undefined') window.App = App;
else if (typeof globalThis !== 'undefined') globalThis.App = App;

if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('DOMContentLoaded', function () { App.boot(); });
}

})();
