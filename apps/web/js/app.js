/* ============================================================================
 * Explain My Money — Gate 1 mobile web UI (workstream W2)
 * ----------------------------------------------------------------------------
 * Single-page, on-device app. HARD RULES:
 *   - No backend, no telemetry, no cloud, no CDN. No network calls for
 *     financial processing or storage (optional user-approved BYO-key AI
 *     phrasing is the sole exception).
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
    receiptId: t.receiptId || null,
    error: t._error ? (t._errorReasons || []).join('; ') : null,
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

/* ============================================================================
 * App shell: state, boot, tab router, event delegation
 * ========================================================================== */

var App = {
  state: {
    tab: 'add',            // month | statement | ask | add | more
    statementId: null,     // currently viewed statement
    sfilter: 'review',     // statement tab filter
    txnId: null,           // open txn detail
    more: 'menu',          // more submenu: menu | rules | privacy
    askQ: null,            // open ask answer id
    askText: '',
    receiptMsg: '',
    ruleOffer: null,       // pending "make this a rule" offer
    pending: null,         // pending import (file parsed, not yet committed)
    pipe: null,            // pipeline session
    dupPairs: null         // duplicate candidate pairs for current statement
  },
  categories: [],          // seeded from Engine.defaultCategories()
  ready: false,
  engineMissing: false,
  _renderSeq: 0            // increments per render; async views write only if current
};

var TABS = ['month', 'statement', 'ask', 'add', 'more'];
var TAB_TITLES = { month: 'Your Month', statement: 'Clean Statement', ask: 'Ask', add: 'Add', more: 'More' };

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
    $('#view').innerHTML = '<div class="banner bad"><strong>Storage failed to open:</strong> ' +
      esc(e && e.message || e) + '<br>Try serving over http (see web/README.md).</div>';
    return;
  }
  await App.seedCategories();

  var statements = await sAll('statements');
  if (statements.length) {
    statements.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
    App.state.statementId = statements[0].id;
    App.state.tab = 'month';
  } else {
    App.state.tab = 'add'; // first-run flow starts at Add
  }
  App.ready = true;
  App.render();
  wireGlobalEvents();
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
  if (params.more) App.state.more = params.more;
  if (params.askQ !== undefined) { App.state.askQ = params.askQ; App.state.askText = params.askText || ''; }
  App.render();
  var v = $('#view');
  if (v) { v.scrollTop = 0; window.scrollTo(0, 0); }
};

App.render = function () {
  if (!App.ready || App.engineMissing) return;
  $all('.tab').forEach(function (b) {
    b.classList.toggle('active', b.dataset.tab === App.state.tab);
    if (b.dataset.tab === App.state.tab) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  var seq = ++App._renderSeq; // async views must check this before writing
  var v = $('#view');
  var s = App.state;
  if (s.tab === 'add') App.vAdd(v, seq);
  else if (s.tab === 'statement') { s.txnId != null ? App.vTxnDetail(v, seq) : App.vStatement(v, seq); }
  else if (s.tab === 'month') App.vMonth(v, seq);
  else if (s.tab === 'ask') App.vAsk(v, seq);
  else if (s.tab === 'more') App.vMore(v, seq);
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
                  more: d.more || undefined });
};
App.Actions['open-txn'] = function (d) { App.go('statement', { txnId: d.id }); };
App.Actions['txn-back'] = function () { App.go('statement', { txnId: null }); };
App.Actions['back-more'] = function () { App.go('more', { more: 'menu' }); };

/* ============================================================================
 * Screen 1 — Add statements (import) + Screen 2 — receipts (optional)
 * ========================================================================== */

/* ---------- Add home ---------- */

App.vAdd = function (v, seq) {
  var s = App.state;
  if (s.addView === 'processing' && s.pipe) return App.vProcessing(v, seq);
  if (s.addView === 'receipts') return App.vReceipts(v, seq);
  if (s.addView === 'preview' && s.pending) return App.vImportPreview(v, seq);
  return App.vAddHome(v, seq);
};

App.vAddHome = async function (v, seq) {
  var files = await sAll('sourceFiles');
  var receipts = await sAll('receipts');
  var html = '<h1>Add</h1>';
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
          'are read exactly. Unfamiliar layouts get a careful heuristic read, and uncertain rows are flagged for your review.</span></li>' +
          '<li><strong>CSV</strong> — supported now. Any column order; we detect date / description / amount columns.</li>' +
        '</ul>' +
      '</details>' +
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

/* ---------- file chosen -> parse + preview ---------- */

App.Changes['statement-file'] = async function (input) {
  var file = input.files && input.files[0];
  if (!file) return;
  var v = $('#view');
  v.innerHTML = '<div class="empty"><div class="spin" style="margin:0 auto 12px"></div>Reading file…</div>';
  var isPdf = /\.pdf$/i.test(file.name || '');

  if (isPdf) return App.handlePdfFile(input, file, v);

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

App.handlePdfFile = async function (input, file, v) {
  var buf;
  try { buf = await readFileAsArrayBuffer(file); }
  catch (e) { v.innerHTML = '<div class="banner bad">Could not read that file.</div>'; return; }
  v.innerHTML = '<div class="empty"><div class="spin" style="margin:0 auto 12px"></div><span id="pdf-prog">Reading PDF on this device…</span></div>';
  var result;
  try {
    ensurePdfWorker();
    result = await Parsers.parsePdf(buf, (typeof pdfjsLib !== 'undefined') ? pdfjsLib : null,
      function (page, numPages) {
        var el = document.getElementById('pdf-prog');
        if (el) el.textContent = 'Reading page ' + page + ' of ' + numPages + ' on this device…';
      });
  } catch (e) {
    v.innerHTML = '<div class="banner bad"><strong>Could not parse this PDF:</strong> ' +
      esc(e.message || e) + '</div>' +
      '<button class="btn ghost" data-action="goto" data-tab="add" data-addview="home">Back</button>';
    return;
  }
  var rows = result.rows || [];
  if (!rows.length) {
    v.innerHTML = '<div class="banner warn">No transaction rows found in this PDF.</div>' +
      '<button class="btn ghost" data-action="goto" data-tab="add" data-addview="home">Back</button>';
    return;
  }
  var hash = sha256HexBytes(new Uint8Array(buf));
  var dup = (await sAll('sourceFiles')).some(function (f) { return f.sha256 === hash; });
  var isGenericPdf = result.templateId === 'generic_statement_v1';
  App.state.pending = {
    fileName: file.name, fileSize: file.size, text: null,
    rows: rows, errors: [], hash: hash, duplicate: dup,
    fileKind: 'pdf',
    formatLabel: isGenericPdf ? 'Generic statement (heuristic read)' : result.institution + ' statement',
    templateId: result.templateId, pdfMeta: result.meta || null,
    pdfWarnings: result.warnings || []
  };
  App.state.addView = 'preview';
  App.render();
  input.value = '';
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
      '<button class="btn ghost" data-action="tab" data-tab="month">See your month</button>';
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
  App.setStage('allocate', 'running', 'allocating…');
  var rules = (await enabledRules()).filter(function (r) { return r.ruleType === 'category' && r.appMatch; });
  var byCat = {};
  pipe.allocations = pipe.txns.map(function (t, i) {
    // V8: the Engine's categoryKeyFor falls back to the merchant name when
    // r.category is empty — so we ONLY stamp a category when a household
    // rule actually matched. Stamping 'uncategorized' everywhere would
    // collapse the whole briefing into one bucket.
    var catId = null, basis = 'default: no category rule matched';
    if (t.kind === 'purchase' || t.kind === 'cash_advance') {
      var mr = String(t.merchantRaw || t.rawDescription || '').toLowerCase();
      for (var ri = 0; ri < rules.length; ri++) {
        var sub = String(rules[ri].appMatch.merchantContains || '').toLowerCase();
        if (sub && mr.indexOf(sub) !== -1) { catId = rules[ri].appMatch.setCategory; basis = 'household rule #' + rules[ri].id; break; }
      }
    } else { basis = 'n/a: not spend'; }
    if (catId) byCat[catId] = (byCat[catId] || 0) + 1;
    // V9: the txn category field is `category` on the W1 schema (null = unset).
    t.category = catId;
    var amt = t.spendAmountMinor;
    if (amt === null || amt === undefined) amt = t.amountMinor;
    return { rowIndex: i, categoryId: catId, amountMinor: amt, basis: basis };
  });
  var detail = '<ul>' + Object.keys(byCat).map(function (c) {
    return '<li><strong>' + byCat[c] + '</strong> → ' + esc(catName(c)) + '</li>';
  }).join('') + '</ul><p class="small">Change any transaction\'s category in the statement view — you can turn a correction into a reusable rule.</p>';
  App.setStage('allocate', 'done', Object.keys(byCat).length + ' categories used', detail || '<p class="small">No spend to allocate.</p>');
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
    var g = 0, rfSigned = 0, rfCount = 0, ex = 0, un = 0, sSum = 0, sKnown = true;
    pipe.txns.forEach(function (t) {
      var amt = (t.amountMinor === null || t.amountMinor === undefined) ? 0 : t.amountMinor;
      if (t.kind === 'purchase') g += amt;
      else if (t.kind === 'refund') { rfSigned += amt; rfCount++; }
      if (t.excluded === 1) ex += amt;
      if ((t.kind || 'uncertain') === 'uncertain' || t.confidence === 'needs_review') un++;
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
  var refunds = [], purchases = [];
  pipe.txns.forEach(function (t, i) {
    if (t.kind === 'refund') refunds.push(i);
    else if ((t.kind === 'purchase' || t.kind === 'cash_advance') && !t.excluded) purchases.push(i);
  });
  function merchKey(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
  for (var r = 0; r < refunds.length; r++) {
    var rt = pipe.txns[refunds[r]];
    for (var q = 0; q < purchases.length; q++) {
      var pt = pipe.txns[purchases[q]];
      if (merchKey(rt.merchantRaw || rt.rawDescription) !== merchKey(pt.merchantRaw || pt.rawDescription)) continue;
      if (Math.abs(Math.abs(rt.amountMinor || 0) - Math.abs(pt.amountMinor || 0)) > 1) continue;
      if (rt.date && pt.date && rt.date < pt.date) continue;
      await Store.put('refundLinks', {
        statementId: statementId, refundTxnId: rowToId[refunds[r]], purchaseTxnId: rowToId[purchases[q]],
        basis: 'same merchant + matching amount', status: 'suggested', createdAt: now
      });
      break; // one suggested original per refund
    }
  }

  // Briefing (V9: factsJson per schema; facts/text kept for direct use).
  await Store.put('briefings', {
    statementId: statementId, periodStart: pipe.periodStart, periodEnd: pipe.periodEnd,
    scopeLabel: pipe.scopeLabel, factsJson: JSON.stringify(pipe.facts || null),
    facts: pipe.facts, text: pipe.briefingText, periodLabel: pipe.periodLabel, createdAt: now
  });

  App.state.statementId = statementId;
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
    '<button class="btn ghost" data-action="tab" data-tab="month">Skip for now →</button>';
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

App.receiptCoverage = async function () {
  var stmts = await sAll('statements');
  if (!stmts.length) return { ratio: 0, matchedMinor: 0, grossMinor: 0, scopeLabel: '' };
  stmts.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
  var st = stmts[0];
  var txns = await sQuery('txns', 'statementId', st.id);
  var gross = 0;
  txns.forEach(function (t) {
    if ((t.kind === 'purchase' || t.kind === 'cash_advance') && !t.excluded)
      gross += Math.abs(t.spendAmountMinor != null ? t.spendAmountMinor : (t.amountMinor || 0));
  });
  var matches = (await sAll('matches')).filter(function (m) { return m.status === 'confirmed'; });
  var txnById = {};
  txns.forEach(function (t) { txnById[String(t.id)] = t; });
  var matched = 0;
  matches.forEach(function (m) {
    var t = txnById[String(m.txnId)];
    if (t) matched += Math.abs(t.spendAmountMinor != null ? t.spendAmountMinor : (t.amountMinor || 0));
  });
  return { ratio: gross > 0 ? Math.min(1, matched / gross) : 0, matchedMinor: matched, grossMinor: gross,
           scopeLabel: st.scopeLabel || st.periodLabel };
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
  if (t.kind === 'uncertain' || t.confidence === 'needs_review') return 'uncertain';
  if (t.kind === 'refund') return 'refunds';
  if (t.kind === 'payment' || t.kind === 'transfer' || t.kind === 'fee') return 'payments';
  return 'purchases';
}

var SFILTERS = [
  ['review', 'Review'], ['purchases', 'Purchases'], ['refunds', 'Refunds'],
  ['payments', 'Payments & transfers'], ['duplicates', 'Duplicates'],
  ['uncertain', 'Uncertain'], ['excluded', 'Excluded']
];

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

  var counts = { review: 0, purchases: 0, refunds: 0, payments: 0, duplicates: 0, uncertain: 0, excluded: 0 };
  txns.forEach(function (t) {
    var k = txnTab(t); counts[k]++;
    if (k === 'uncertain' || k === 'duplicates') counts.review++;
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

  // Reconciliation strip: gross − refunds − exclusions = net (the Engine sums
  // SIGNED minor units; we display labeled magnitudes so "net spend" never
  // reads as a negative). When the statement carries reported balances (PDF
  // imports), the strip proves the rows add up to them.
  html += '<div class="strip" role="region" aria-label="Reconciliation">' +
    '<div class="s-row"><span>Gross purchases</span><span>' + spendAbs(recon.grossPurchasesMinor) + '</span></div>' +
    '<div class="s-row"><span>− Refunds</span><span>' + spendAbs(recon.refundsTotalMinor) + '</span></div>' +
    '<div class="s-row"><span>− Excluded</span><span>' + spendAbs(recon.excludedTotalMinor) + '</span></div>' +
    '<div class="s-row s-net"><span>Net spend</span><span>' + spendAbs(recon.netSpendMinor) + '</span></div>' +
    '<div class="s-note">' + (recon.unresolvedCount ? recon.unresolvedCount + ' unresolved · ' : '') +
    'balance check: ' + esc(String(recon.balanceCheck)) +
    (recon.gapMinor ? ' · gap ' + money(recon.gapMinor) : '') + '</div>';
  if (stmtReported) {
    html += '<div class="s-note">Reported: ' + money(stmtReported.startMinor) + ' → ' +
      money(stmtReported.endMinor) + ' · rows sum: ' + money(recon.signedRowsSumMinor) + '</div>';
  }
  html += '</div>';

  html += '<div class="tabs" role="tablist">';
  SFILTERS.forEach(function (f) {
    html += '<button class="chip' + (App.state.sfilter === f[0] ? ' on' : '') + '" role="tab" ' +
      'data-action="sfilter" data-f="' + f[0] + '">' + f[1] +
      '<span class="count">' + (counts[f[0]] || 0) + '</span></button>';
  });
  html += '</div><div id="txn-list">' + App.txnListHtml(txns, App.state.sfilter, counts) + '</div>';
  App.show(v, seq, html);
};

App.Changes['statement-select'] = function (el) {
  App.go('statement', { statementId: el.value, txnId: null });
};
App.Actions.sfilter = function (d) { App.state.sfilter = d.f; App.state.txnId = null; App.render(); };

/** Duplicate candidate pairs for the current statement (indexes into App._stmtTxns). */
App.dupPairs = function () {
  var txns = App._stmtTxns || [];
  try {
    var pairs = Engine.findDuplicateCandidates(txns) || [];
    return pairs.filter(function (p) { return Array.isArray(p) && txns[p[0]] && txns[p[1]]; });
  } catch (e) { return []; }
};

App.txnRowHtml = function (t) {
  t = nt(t);
  var amt = t.amountMinor;
  var cls = amt > 0 ? 't-amt pos' : 't-amt';
  var pills = '';
  if (t.status === 'duplicate') pills += ' <span class="pill bad">duplicate</span>';
  else if (t.kind === 'uncertain' || t.confidence === 'needs_review') pills += ' <span class="pill warn">review</span>';
  if (t.excluded && t.status !== 'duplicate') pills += ' <span class="pill dim">excluded</span>';
  return '<button class="txn" data-action="open-txn" data-id="' + esc(t.id) + '">' +
    '<span class="t-main"><span class="t-desc">' + esc(t.desc || '(no description)') + '</span><br>' +
    '<span class="t-sub">' + esc(fmtDate(t.date)) + ' · ' + esc(kindLabel(t.kind)) + pills + '</span></span>' +
    '<span class="' + cls + '">' + money(amt) + '</span></button>';
};

App.txnListHtml = function (txns, filter, counts) {
  var html = '';
  if (filter === 'review') {
    var pairs = App.dupPairs();
    var unc = txns.filter(function (t) { return txnTab(t) === 'uncertain'; });
    if (!pairs.length && !unc.length)
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
    unc.forEach(function (t) { html += App.txnRowHtml(t); });
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
  list.forEach(function (t) { html += App.txnRowHtml(t); });
  return html;
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
    (t.confidence ? '<span class="pill ' + (t.confidence === 'needs_review' ? 'warn' : 'dim') + '">' + esc(String(t.confidence).replace(/_/g, ' ')) + '</span> ' : '') +
    (t.excluded ? '<span class="pill dim">excluded</span> ' : '') +
    (t.status === 'duplicate' ? '<span class="pill bad">duplicate</span>' : '') + '</div>';

  html += '<div class="card"><h3 style="margin-top:0">Classification</h3><table class="kv">' +
    '<tr><th>Kind</th><td>' + esc(kindLabel(t.kind)) + '</td></tr>' +
    '<tr><th>Why</th><td>' + esc(t.kindReason || '—') + '</td></tr>' +
    '<tr><th>Source</th><td>' + esc(t.classificationSource || '—') + '</td></tr>' +
    '<tr><th>Kind confidence</th><td>' + esc(t.kindConfidence != null ? t.kindConfidence : '—') + '</td></tr>' +
    '<tr><th>Category</th><td>' + esc(catName(t.category)) + '</td></tr>' +
    '<tr><th>Status</th><td>' + esc(t.status) + '</td></tr></table></div>';

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
  if (t.kind === 'uncertain' || t.confidence === 'needs_review') {
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
      '<p>' + esc(off.scopeDescription || 'This correction can be reused.') + '</p>' +
      '<p class="small">The rule will apply to <strong>future imports</strong> automatically. You can disable or delete it any time under More → Rules.</p>' +
      '<div class="btn-row"><button class="btn" data-action="confirm-rule">Save rule</button>' +
      '<button class="btn ghost" data-action="cancel-rule">Not now</button></div></div>';
  }

  App.show(v, seq, html);
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
  else if (field === 'category') t.category = newValue;
  else if (field === 'excluded') t.excluded = newValue ? 1 : 0; // V7: reconcile checks ===1
  if (t.status === 'new') t.status = 'reviewed';
  await Store.put('txns', t); // put() with an existing id upserts

  var corr = { txnId: txnId, field: field, oldValue: String(oldValue), newValue: String(newValue), createdAt: Date.now() };
  var corrId = await Store.put('corrections', corr);
  audit('correction.applied', 'txn', txnId, { field: field, oldValue: corr.oldValue, newValue: corr.newValue });

  // Offer a reusable household rule for future imports.
  // V5: the Engine builds KIND rules only (makeRuleFromCorrection throws
  // otherwise). Category rules are app-level (we own category assignment).
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
    offer = { correctionId: corrId, txnId: txnId, field: field,
      oldValue: corr.oldValue, newValue: corr.newValue, rule: null,
      scopeDescription: 'Future rows from "' + core + '" will get the category "' + catName(newValue) + '".',
      appMatch: { merchantContains: core, field: field, setCategory: newValue } };
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
    App.render();
  });
};

App.Actions['make-rule'] = function () { /* offer renders automatically after a correction */ };
App.Actions['confirm-rule'] = async function () {
  var off = App.state.ruleOffer;
  if (!off) return;
  // V4/V9: store FLAT in the Engine's applyRules shape {id, enabled,
  // priority, matchMerchant, kind, label} + our metadata. Deterministic ids
  // make re-saving the same rule an upsert, not a duplicate.
  var ruleId = (off.rule && off.rule.id) ||
    ('catrule_' + sha256Hex(off.appMatch.merchantContains + '|' + off.newValue).slice(0, 16));
  var rec = {
    id: ruleId,
    enabled: true,
    priority: (off.rule && off.rule.priority) || 100,
    matchMerchant: (off.rule && off.rule.matchMerchant) || off.appMatch.merchantContains,
    kind: (off.rule && off.rule.kind) || null,
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
  App.render();
};
App.Actions['dup-markdup'] = async function (d) {
  var t = await sGet('txns', d.id);
  if (!t) return;
  t.status = 'duplicate'; t.excluded = 1; // V7: duplicates don't count toward spend
  await Store.put('txns', t);
  await Store.put('corrections', { txnId: d.id, field: 'duplicate', oldValue: 'candidate', newValue: 'duplicate', createdAt: Date.now() });
  audit('duplicate.marked', 'txn', d.id, { kept: d.other });
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

App.vMonth = async function (v, seq) {
  var stmts = await sAll('statements');
  if (!stmts.length) {
    App.show(v, seq, '<h1>Your Month</h1><div class="empty">Nothing here yet — import a statement to get your first briefing.<br><br>' +
      '<button class="btn" data-action="tab" data-tab="add">Add a statement</button></div>');
    return;
  }
  stmts.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
  var st = stmts.filter(function (s) { return String(s.id) === String(App.state.statementId); })[0] || stmts[0];
  App.state.statementId = st.id;
  var txns = await sQuery('txns', 'statementId', st.id);
  var briefs = (await sAll('briefings')).filter(function (b) { return String(b.statementId) === String(st.id); });
  briefs.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
  var briefing = briefs[0] || null;
  var facts = (briefing && briefing.facts) || null;

  var recon = null;
  var monthReported = (st && typeof st.reportedStartMinor === 'number' && typeof st.reportedEndMinor === 'number')
    ? { startMinor: st.reportedStartMinor, endMinor: st.reportedEndMinor } : null;
  try { recon = Engine.reconcile(txns, monthReported); } catch (e) { recon = null; }
  if (!recon) recon = { grossPurchasesMinor: 0, refundsTotalMinor: 0, excludedTotalMinor: 0, netSpendMinor: 0, unresolvedCount: 0, signedRowsSumMinor: 0, balanceCheck: 'unavailable' };

  var html = '<h1>Your Month</h1>';
  html += '<p class="small">' + esc(st.scopeLabel || fmtPeriod(st.periodLabel)) + ' · ' + txns.length + ' transactions</p>';

  // Headline: the Engine's own first line (V8 honesty rule — no final number
  // while anything is unresolved), plus the net figure as a magnitude.
  var headline = facts ? String((briefing.text || '').split('\n')[0] || '') : '';
  html += '<div class="card"><div class="headline-label">Net spend after refunds</div>' +
    '<div class="headline-num">' + spendAbs(recon.netSpendMinor) + '</div>' +
    '<p class="small" style="margin-bottom:0">' + esc(headline || ('Across ' + (st.rowCount || 0) + ' transactions in ' + fmtPeriod(st.periodLabel) + '.')) + '</p></div>';

  // What changed: Engine deltas vs previous period (V8).
  html += '<div class="section-head"><h2>What changed</h2>' +
    '<button class="linklike" data-action="wrong" data-filter="purchases">This explanation is wrong</button></div>';
  var deltas = facts ? (facts.deltas || []) : [];
  if (deltas.length) {
    html += '<div class="card">';
    deltas.slice(0, 3).forEach(function (d) {
      var up = d.deltaMinor > 0;
      html += '<div class="bar-row"><span class="b-label">' + esc(prettify(String(d.category || ''))) + '</span>' +
        '<span class="b-amt">' + (up ? 'up ' : 'down ') + spendAbs(d.deltaMinor) +
        ' <span class="tiny">(' + (d.txnCount || 0) + ' txn)</span></span></div>';
    });
    html += '</div>';
  } else {
    html += '<div class="card"><p style="margin:0">First statement on this device — no previous period to compare against yet.</p></div>';
  }

  // Where it went: Engine top drivers (V8), each linking to its transactions.
  html += '<div class="section-head"><h2>Where it went</h2>' +
    '<button class="linklike" data-action="wrong" data-filter="purchases">This explanation is wrong</button></div>';
  var drivers = facts ? (facts.topDrivers || []) : [];
  if (drivers.length) {
    var maxD = Math.max.apply(null, drivers.map(function (d) { return Math.abs(d.totalMinor || 0); }).concat([1]));
    drivers.slice(0, 5).forEach(function (d) {
      var link = App.driverTxnId(txns, d.category);
      html += '<button class="driver" data-action="open-txn" data-id="' + esc(link || '') + '"' + (link ? '' : ' disabled') + '>' +
        '<span class="d-main"><span class="d-name">' + esc(prettify(String(d.category || ''))) + '</span><br>' +
        '<span class="d-sub">' + (d.txnCount || 0) + ' transaction' + ((d.txnCount || 0) === 1 ? '' : 's') + '</span></span>' +
        '<span class="d-amt">' + spendAbs(d.totalMinor) + '</span></button>';
    });
  } else html += '<p class="small">No spend drivers this period.</p>';

  // Refunds & money movement.
  html += '<div class="section-head"><h2>Refunds &amp; money movement</h2>' +
    '<button class="linklike" data-action="wrong" data-filter="refunds">This explanation is wrong</button></div>';
  var rs = facts ? facts.refundsSummary : null;
  var move = txns.filter(function (t) { return ['refund', 'payment', 'transfer', 'fee'].indexOf(t.kind) !== -1 && !t.excluded; });
  if (move.length) {
    html += '<div class="card">';
    move.slice(0, 8).forEach(function (t) {
      t = nt(t);
      html += '<div class="bar-row"><span class="b-label">' + esc(t.desc) + '</span>' +
        '<span class="b-amt">' + money(t.amountMinor) + ' · ' + esc(kindLabel(t.kind)) + '</span></div>';
    });
    html += '<p class="small">Refunds received: <strong>' + spendAbs(rs ? rs.totalMinor : recon.refundsTotalMinor) + '</strong>' +
      (rs ? ' across ' + rs.count + ' transaction(s)' : '') + ' (already subtracted from net spend).</p></div>';
  } else html += '<p class="small">No refunds, payments, transfers or fees this period.</p>';

  // Needs your review.
  var unCount = facts ? (facts.unresolvedCount || 0) : (recon.unresolvedCount || 0);
  html += '<div class="section-head"><h2>Needs your review</h2>' +
    '<button class="linklike" data-action="wrong" data-filter="review">This explanation is wrong</button></div>';
  if (unCount) {
    html += '<div class="card"><p><strong>' + unCount + '</strong> transaction' + (unCount === 1 ? '' : 's') +
      ' need' + (unCount === 1 ? 's' : '') + ' a human look.</p>' +
      '<button class="btn" data-action="goto" data-tab="statement" data-filter="review">Open review queue</button></div>';
  } else html += '<div class="banner ok">All clear — nothing needs review.</div>';

  // Evidence quality.
  var cov = await App.receiptCoverage();
  var rules = await sAll('householdRules');
  html += '<h2>Evidence quality</h2><div class="card"><table class="kv">' +
    '<tr><th>Transactions</th><td>' + txns.length + '</td></tr>' +
    '<tr><th>Receipt coverage</th><td>' + Math.round(cov.ratio * 100) + '% of purchases (' + spendAbs(cov.matchedMinor) + ' / ' + spendAbs(cov.grossMinor) + ')</td></tr>' +
    (facts && facts.receiptCoveragePct != null ? '<tr><th>Coverage at import</th><td>' + facts.receiptCoveragePct + '%</td></tr>' : '') +
    '<tr><th>Household rules</th><td>' + rules.length + ' (' + rules.filter(function (r) { return r.enabled !== false; }).length + ' active)</td></tr>' +
    '<tr><th>Unresolved</th><td>' + unCount + '</td></tr>' +
    (facts ? '<tr><th>Balance check</th><td>' + esc(String(facts.balanceCheck)) + (facts.gapMinor ? ' · gap ' + money(facts.gapMinor) : '') + '</td></tr>' : '') +
    '</table></div>';

  // Full deterministic briefing text.
  if (briefing && briefing.text) {
    html += '<details class="more"><summary>Full briefing text</summary><pre class="brief">' + esc(briefing.text) + '</pre>';
    if (typeof LLM !== 'undefined' && LLM.isActive()) {
      html += '<div style="margin-top:8px"><button class="btn ghost smallbtn" data-action="llm-rephrase-briefing">Rephrase with AI</button> <span class="tiny">Rewords only — the facts stay on this device.</span></div>';
      App._lastBriefing = { briefing: briefing, st: st, recon: recon };
    }
    html += '</details><div id="llm-preview"></div>';
  }
  App.show(v, seq, html);
};

/** Find a txn id for a driver category (V8: categoryTotals keys are
    category ids, falling back to merchant names). */
App.driverTxnId = function (txns, category) {
  var c = String(category || '');
  for (var i = 0; i < txns.length; i++) {
    var t = nt(txns[i]);
    if (String(t.category) === c) return t.id;
  }
  var lc = c.toLowerCase();
  for (var j = 0; j < txns.length; j++) {
    var u = nt(txns[j]);
    if (u.desc.toLowerCase() === lc) return u.id;
  }
  return null;
};

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

/* ============================================================================
 * Screen 6 — Ask
 * Deterministic answers from ledger facts only. No LLM in Gate 1.
 * Free text is keyword-matched to the 6 priority questions; anything else
 * gets an honest "I can't answer that from your ledger yet."
 * The "AI phrasing (BYO key)" toggle is a labeled stub with a pre-send
 * scope preview — nothing leaves the device.
 * ========================================================================== */

var QUESTIONS = [
  { id: 'q-spend',     label: 'Actual spend after refunds?', keys: ['spend', 'total', 'much', 'net', 'actually'] },
  { id: 'q-change',    label: 'Why did spending change?',    keys: ['why', 'change', 'rose', 'fell', 'increase', 'decrease', 'higher', 'lower', 'versus', 'vs', 'compared'] },
  { id: 'q-grocery',   label: 'Groceries / household?',      keys: ['grocer', 'food', 'loblaw', 'costco', 'household', 'supermarket'] },
  { id: 'q-mixed',     label: 'Mixed-merchant contents?',    keys: ['mixed', 'amazon', 'what did i buy', 'contents', 'inside'] },
  { id: 'q-move',      label: 'Payments, transfers, fees?',  keys: ['payment', 'transfer', 'fee', 'duplicate', 'cash'] },
  { id: 'q-uncertain', label: 'What remains uncertain?',     keys: ['uncertain', 'unsure', 'unknown', 'review', 'missing', 'left'] }
];

App.vAsk = async function (v, seq) {
  var html = '<h1>Ask</h1>';
  html += '<p class="small">Answers are computed <strong>only</strong> from your on-device ledger. Optional AI phrasing (below) only rewords them — it never recomputes and never sees raw data without your per-call approval.</p>';
  html += '<div>';
  QUESTIONS.forEach(function (q) {
    html += '<button class="chip' + (App.state.askQ === q.id ? ' on' : '') + '" data-action="ask-chip" data-q="' + q.id + '">' + esc(q.label) + '</button>';
  });
  html += '</div>';

  if (App.state.askQ) html += await App.answerHtml(App.state.askQ);
  else if (App.state.askText) html += await App.answerHtml('__free__');

  html += '<div class="card"><h3 style="margin-top:0">Ask in your own words</h3>' +
    '<input type="text" id="ask-free" placeholder="e.g. why did groceries rise?" value="' + esc(App.state.askText || '') + '" autocomplete="off">' +
    '<button class="btn" data-action="ask-submit">Ask</button>' +
    '<p class="tiny">Free text is matched by keyword to one of the questions above. Anything else gets an honest “I can’t answer that yet”.</p></div>';

  // Optional AI phrasing (BYO key): rewords — never recomputes — the
  // deterministic answer. Off by default; nothing leaves the device
  // until you approve the exact payload, every time.
  html += '<div class="card"><h3 style="margin-top:0">AI phrasing <span class="pill dim">optional · bring your own key</span></h3>' +
    '<p class="small">Rephrases the deterministic answer above in plainer words. The facts are computed on this device and never change.</p>' +
    App.llmSettingsHtml() + '</div>';

  App.show(v, seq, html);
};

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
    return { title: 'How much did you actually spend?',
      body: '<p>Your <strong>actual spend after refunds</strong> was <strong>' + spendAbs(recon.netSpendMinor) + '</strong>.</p>' +
        '<table class="kv"><tr><th>Gross purchases</th><td>' + spendAbs(recon.grossPurchasesMinor) + '</td></tr>' +
        '<tr><th>− Refunds</th><td>' + spendAbs(recon.refundsTotalMinor) + '</td></tr>' +
        '<tr><th>− Excluded</th><td>' + spendAbs(recon.excludedTotalMinor) + '</td></tr>' +
        '<tr><th>= Net spend</th><td><strong>' + spendAbs(recon.netSpendMinor) + '</strong></td></tr></table>' +
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
  var rules = await sAll('householdRules');
  var active = rules.filter(function (r) { return r.enabled !== false; }).length;
  App.show(v, seq, '<h1>More</h1>' +
    '<div class="card"><div class="section-head"><h3 style="margin:0">Household rules</h3><span class="pill">' + active + ' active</span></div>' +
    '<p class="small">Corrections you turned into reusable rules. They apply to future imports automatically.</p>' +
    '<button class="btn ghost" data-action="goto" data-tab="more" data-more="rules">Manage rules</button></div>' +
    '<div class="card"><h3 style="margin:0 0 6px">Privacy &amp; data</h3>' +
    '<p class="small"><strong>Your data stays on this device.</strong> The only network use is optional AI phrasing, which you preview and approve per call. Export or delete any time.</p>' +
    '<button class="btn ghost" data-action="goto" data-tab="more" data-more="privacy">Privacy, export &amp; delete</button></div>');
};

App.vRules = async function (v, seq) {
  var rules = await sAll('householdRules');
  rules.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
  var html = '<button class="linklike" data-action="back-more">← More</button><h1>Household rules</h1>';
  if (!rules.length) {
    html += '<div class="empty">No rules yet.<br><span class="small">Correct a transaction in the Statement view and choose “Make this a rule”.</span></div>';
  }
  rules.forEach(function (r) {
    var on = r.enabled !== false;
    // Flat V4 shape: {id, enabled, priority, matchMerchant, kind, label}.
    var effect = r.kind ? ('kind → ' + kindLabel(r.kind))
      : ('category → ' + esc(catName(r.appMatch && r.appMatch.setCategory)));
    html += '<div class="rule"><div class="r-head">' +
      '<span class="r-name">' + esc(r.label || (r.ruleType === 'category' ? 'Category rule' : 'Kind rule')) + '</span>' +
      '<span class="pill ' + (on ? 'ok' : 'dim') + '">' + (on ? 'on' : 'off') + '</span></div>' +
      '<div class="r-scope">' + esc(r.scopeDescription || '(no description)') + '</div>' +
      (r.matchMerchant ? '<div class="tiny">Matches merchant containing “' + esc(r.matchMerchant) + '” → ' + effect + '</div>' : '') +
      '<div class="r-actions">' +
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
  App.render();
};

App.vPrivacy = async function (v, seq) {
  var html = '<button class="linklike" data-action="back-more">← More</button><h1>Privacy &amp; data</h1>';
  html += '<div class="banner info"><strong>Your data never leaves this device.</strong><br>' +
    'This app has no backend, sends no telemetry, and loads nothing from the internet. ' +
    'Your financial data makes zero network calls — the only exception is optional AI phrasing ' +
    '(off by default), which contacts only the provider you configure, only after you preview and approve each payload.</div>';

  html += '<div class="card"><h3 style="margin-top:0">What’s stored, where</h3>' +
    '<table class="kv">' +
    '<tr><th>Ledger &amp; rules</th><td>IndexedDB on this device — statements, transactions, merchants, categories, household rules, corrections, matches, allocations, refund links, briefings, audit events</td></tr>' +
    '<tr><th>Receipt photos</th><td>IndexedDB, as image blobs — never uploaded</td></tr>' +
    '<tr><th>Cookies / localStorage</th><td>Not used for your data</td></tr>' +
    '<tr><th>Network</th><td>Zero requests for your financial data (verify in devtools). Optional AI phrasing is the only network use, and only with your per-call approval.</td></tr></table></div>';

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
                more: 'menu', askQ: null, askText: '', receiptMsg: '', ruleOffer: null,
                pending: null, pipe: null, dupPairs: null };
  App.categories = [];
  await App.seedCategories();
  App.go('add');
};

/* Test hooks: pure helpers exposed for node smoke tests (no DOM needed). */
App._test = {
  sha256Hex: sha256Hex, esc: esc, money: money, spendAbs: spendAbs, fmtDate: fmtDate, fmtPeriod: fmtPeriod,
  prettify: prettify, kindLabel: kindLabel, merchantCore: merchantCore, receiptForScore: receiptForScore,
  parseManualAmount: parseManualAmount, spendOf: spendOf, txnTab: txnTab,
  matchQuestion: App.matchQuestion, shortHash: shortHash
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
