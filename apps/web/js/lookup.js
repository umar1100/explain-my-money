/* Explain My Money — opt-in online merchant lookup.
 *
 * HARD RULES (from the product design):
 *  - OFF by default. When off (or when no key is set), this module performs
 *    zero network calls and changes nothing.
 *  - Only the merchant NAME ever leaves the device — never amounts, dates,
 *    account labels, or any other transaction field. Lookup.buildRequest
 *    constructs the payload from the merchant string alone, and
 *    Lookup.assertMerchantOnly verifies that before every send.
 *  - The Tavily API key is the user's own (BYO). It is stored on this device
 *    only (localStorage), held in memory while the app runs, never logged,
 *    and sent only in direct HTTPS calls from the phone to Tavily's API.
 *    It is never committed, never proxied, never shown back in full.
 *  - Pipeline order: the built-in keyword rules (Engine.autoCategorize) run
 *    FIRST. Only still-uncategorized spend rows become lookup candidates.
 *  - Never-guess preserved: a merchant is auto-categorized only when at
 *    least TWO independent web results point at the same category.
 *    Anything weaker stays in Review — with a hint chip when there is
 *    single-result evidence, so one-tap triage stays fast.
 *  - Teach-once: a confident identification is persisted as a household
 *    rule (source 'web-lookup'), so that merchant is never looked up again.
 *    Every outcome (including "no confident result") is also cached by
 *    normalized merchant: each merchant is queried at most once ever.
 *  - Failures (no network, bad key, quota exhausted) stand down quietly:
 *    rows stay in Review and a plain-language note is stored in settings.
 *    The key itself is never written into any message. The settings view
 *    offers a "Test connection" button (Lookup.testConnection) that sends
 *    ONE probe with a fixed synthetic query ("TEST MERCHANT") and reports
 *    the exact outcome — distinguishing offline from blocked requests.
 *
 * Tavily request shape (verified against https://docs.tavily.com,
 * 2026-09-21): POST https://api.tavily.com/search with the key in the JSON
 * body as `api_key` (an `Authorization: Bearer` header is also accepted and
 * is sent as a fallback). Body: {api_key, query, search_depth:'basic',
 * max_results:5, include_answer:false, include_raw_content:false,
 * topic:'general'}. Response: {results:[{title, url, content, score}]}.
 * HTTP 401 = bad key, 429 = quota exhausted.
 */
window.Lookup = (() => {
  'use strict';

  var API_URL = 'https://api.tavily.com/search';
  var SETTINGS_KEY = 'emm-lookup-settings-v1';
  var KEY_KEY = 'emm-lookup-key-v1';
  var CACHE_KEY = 'emm-lookup-cache-v1';
  var CONCURRENCY = 3;
  var TOP_RESULTS = 3;
  var MIN_VOTES_FOR_AUTO = 2;   // auto-categorize needs >=2 agreeing results
  var MIN_SUGGEST_CONF = 0.6;   // same bar Engine.autoCategorize uses

  /* ---------- tiny storage layer (localStorage, memory fallback) ---------- */

  var memStore = {};
  function lsGet(k) {
    try {
      if (typeof localStorage !== 'undefined') {
        var v = localStorage.getItem(k);
        if (v !== null && v !== undefined) return v;
      }
    } catch (e) {}
    return Object.prototype.hasOwnProperty.call(memStore, k) ? memStore[k] : null;
  }
  function lsSet(k, v) {
    try {
      if (typeof localStorage !== 'undefined') { localStorage.setItem(k, String(v)); return; }
    } catch (e) {}
    memStore[k] = String(v);
  }
  function lsDel(k) {
    try { if (typeof localStorage !== 'undefined') localStorage.removeItem(k); } catch (e) {}
    delete memStore[k];
  }

  function hashStr(s) {
    var h = 5381;
    s = String(s || '');
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16);
  }

  /* ---------- settings ---------- */

  function defaultSettings() {
    return { enabled: false, lastStatus: '', lastRunAt: 0 };
  }
  function getSettings() {
    try {
      var s = JSON.parse(lsGet(SETTINGS_KEY) || '{}') || {};
      var d = defaultSettings();
      d.enabled = !!s.enabled;
      d.lastStatus = String(s.lastStatus || '');
      d.lastRunAt = +s.lastRunAt || 0;
      return d;
    } catch (e) { return defaultSettings(); }
  }
  function saveSettings(patch) {
    var s = getSettings();
    patch = patch || {};
    for (var k in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) s[k] = patch[k];
    }
    lsSet(SETTINGS_KEY, JSON.stringify({
      enabled: !!s.enabled,
      lastStatus: String(s.lastStatus || ''),
      lastRunAt: +s.lastRunAt || 0
    }));
  }
  function saveStatus(text) {
    saveSettings({ lastStatus: String(text || ''), lastRunAt: Date.now() });
  }

  /* ---------- API key: on-device only, in-memory while running ---------- */

  var memKey = null;
  var keyLoaded = false;
  function getKey() {
    if (!keyLoaded) { memKey = lsGet(KEY_KEY) || null; keyLoaded = true; }
    return memKey || null;
  }
  function setKey(k) {
    memKey = (k || '').trim() || null;
    keyLoaded = true;
    if (memKey) lsSet(KEY_KEY, memKey);
    else lsDel(KEY_KEY);
  }
  function clearKey() {
    memKey = null;
    keyLoaded = true;
    lsDel(KEY_KEY);
  }
  function hasKey() { return !!getKey(); }

  /** Feature is live only when the user enabled it AND a key is present. */
  function isActive() {
    return getSettings().enabled && hasKey();
  }

  /* ---------- outcome cache (merchant -> last lookup result) ---------- */

  function getCache() {
    try {
      var c = JSON.parse(lsGet(CACHE_KEY) || '{}');
      return (c && typeof c === 'object') ? c : {};
    } catch (e) { return {}; }
  }
  function saveCache(c) {
    try { lsSet(CACHE_KEY, JSON.stringify(c || {})); } catch (e) {}
  }
  function recordOutcome(merchant, categoryId, hintLabel) {
    var c = getCache();
    c[merchant] = { categoryId: categoryId || null, hint: hintLabel || null, at: Date.now() };
    var keys = Object.keys(c);
    if (keys.length > 2000) {
      // Drop the oldest entries; the cache is a quota-saver, not history.
      keys.sort(function (a, b) { return (c[a].at || 0) - (c[b].at || 0); });
      for (var i = 0; i < keys.length - 2000; i++) delete c[keys[i]];
    }
    saveCache(c);
  }

  /* ---------- merchant normalization ---------- */

  /** Cache/lookup key: uppercase, whitespace-collapsed merchant descriptor. */
  function normalizeMerchant(s) {
    return String(s || '').toUpperCase().replace(/\s+/g, ' ').trim();
  }

  /**
   * Lookup.candidates(txns) -> [normalizedMerchant...], unique.
   * Only spend rows (purchase/refund) that the local pipeline could not
   * categorize, that the user never touched, and that were never looked up.
   */
  function candidates(txns) {
    var cache = getCache();
    var seen = {};
    var out = [];
    (txns || []).forEach(function (t) {
      if (!t) return;
      var kind = t.kind;
      if (kind !== 'purchase' && kind !== 'refund') return;
      if (t.category) return;
      if (t.classificationSource === 'user' || t.categorySource === 'user') return;
      var m = normalizeMerchant(t.merchantRaw);
      if (!m) return;
      if (cache[m]) return;   // looked up before: never query twice
      if (seen[m]) return;
      seen[m] = 1;
      out.push(m);
    });
    return out;
  }

  /* ---------- request building (merchant name ONLY) ---------- */

  /**
   * Lookup.buildRequest(key, merchant) -> {url, options, body}.
   * The body is built from the merchant string alone — by construction it
   * cannot contain amounts, dates, accounts, or any other transaction
   * field. `body` is exposed so callers (and tests) can assert that.
   */
  function buildRequest(key, merchant) {
    var q = String(merchant || '').slice(0, 80);
    var body = {
      api_key: key,
      query: q,
      search_depth: 'basic',
      max_results: 5,
      include_answer: false,
      include_raw_content: false,
      topic: 'general'
    };
    return {
      url: API_URL,
      options: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Body `api_key` is the documented auth; the Bearer header is
          // accepted too and is sent as a fallback.
          'Authorization': 'Bearer ' + key
        },
        body: JSON.stringify(body)
      },
      body: body
    };
  }

  /**
   * Lookup.assertMerchantOnly(req, txn) -> bool.
   * Defense in depth: verify the outbound body carries the merchant query
   * and none of the txn's other fields (amount, date, ids). Called before
   * every send; a failure skips that merchant and is audited.
   */
  function assertMerchantOnly(req, txn) {
    if (!req || !req.body || !txn) return false;
    if (req.body.query !== String(txn.merchantRaw).slice(0, 80)) return false;
    var s = JSON.stringify(req.body);
    var banned = [];
    if (txn.amountMinor !== null && txn.amountMinor !== undefined && txn.amountMinor !== '') {
      banned.push(String(txn.amountMinor));
    }
    if (txn.date) banned.push(String(txn.date));
    if (txn.id) banned.push(String(txn.id));
    if (txn.statementId) banned.push(String(txn.statementId));
    for (var i = 0; i < banned.length; i++) {
      if (banned[i] && s.indexOf(banned[i]) !== -1) return false;
    }
    return true;
  }

  /* ---------- description -> category matching (reuses Engine rules) ---------- */

  function hasEngine() {
    return typeof Engine !== 'undefined' && Engine &&
      typeof Engine.suggestCategory === 'function';
  }

  function categoryName(id) {
    if (hasEngine() && typeof Engine.defaultCategories === 'function') {
      var cats = Engine.defaultCategories();
      for (var i = 0; i < cats.length; i++) {
        if (String(cats[i].id) === String(id)) return cats[i].name;
      }
    }
    return String(id || '');
  }

  /**
   * Lookup.classifyResults(results) -> {level, categoryId, hintLabel,
   *   confidence, evidence} | {level:'none'}.
   * Runs the app's own keyword rules over the top results' titles+snippets.
   *  - 'high': >=2 results independently suggest the same category
   *    (auto-categorize + teach-once rule).
   *  - 'low': exactly one result suggests a category (hint chip in Review).
   *  - 'none': no suggestion, or results disagree (ambiguous).
   */
  function classifyResults(results) {
    if (!hasEngine()) return { level: 'none' };
    var votes = {}; // categoryId -> {count, best, reason}
    var top = (results || []).slice(0, TOP_RESULTS);
    for (var i = 0; i < top.length; i++) {
      var r = top[i] || {};
      var text = String(r.title || '') + ' ' + String(r.content || '');
      if (!text.trim()) continue;
      var sug = null;
      try { sug = Engine.suggestCategory({ merchantRaw: text, kind: 'purchase' }); } catch (e) { sug = null; }
      if (sug && sug.categoryId && sug.confidence >= MIN_SUGGEST_CONF) {
        var v = votes[sug.categoryId] || { count: 0, best: 0, reason: '' };
        v.count += 1;
        if (sug.confidence > v.best) { v.best = sug.confidence; v.reason = sug.reason || ''; }
        votes[sug.categoryId] = v;
      }
    }
    var cats = Object.keys(votes);
    if (!cats.length) return { level: 'none' };
    cats.sort(function (a, b) { return votes[b].count - votes[a].count; });
    var winner = votes[cats[0]];
    if (winner.count >= MIN_VOTES_FOR_AUTO) {
      return { level: 'high', categoryId: cats[0], confidence: winner.best,
               hintLabel: categoryName(cats[0]), evidence: winner.reason };
    }
    if (cats.length === 1 && winner.count === 1) {
      return { level: 'low', categoryId: cats[0], confidence: winner.best,
               hintLabel: categoryName(cats[0]), evidence: winner.reason };
    }
    return { level: 'none' }; // scattered votes: ambiguous, say nothing
  }

  /* ---------- network ---------- */

  /**
   * Lookup.lookupOne(merchant, key, fetchFn, txn) -> {level,...}.
   * Throws on transport/HTTP errors (err.httpStatus when available).
   * When the source txn is supplied, the merchant-only payload assertion
   * runs before every send; a failure aborts that merchant's lookup.
   */
  async function lookupOne(merchant, key, fetchFn, txn) {
    var req = buildRequest(key, merchant);
    if (txn && !assertMerchantOnly(req, txn)) {
      throw new Error('merchant-only payload check failed');
    }
    var res = await fetchFn(req.url, req.options);
    if (!res || !res.ok) {
      var err = new Error('Search returned HTTP ' + (res && res.status));
      err.httpStatus = res && res.status;
      throw err;
    }
    var data = await res.json();
    return classifyResults(data && data.results);
  }

  /**
   * Lookup.run(merchants, key, {fetchFn, concurrency, onProgress}) ->
   *   [{merchant, ok, outcome|error, httpStatus}].
   * Per-merchant errors never abort the batch.
   */
  async function run(merchants, key, opts) {
    opts = opts || {};
    var fetchFn = opts.fetchFn;
    if (typeof fetchFn !== 'function') throw new Error('lookup.run: no fetch available');
    var list = merchants || [];
    var out = new Array(list.length);
    var done = 0;
    var i = 0;
    var workers = [];
    var n = Math.max(1, Math.min(opts.concurrency || CONCURRENCY, list.length));
    function note() {
      if (opts.onProgress) {
        try { opts.onProgress(done, list.length); } catch (e) {}
      }
    }
    async function worker() {
      while (i < list.length) {
        var idx = i;
        i += 1;
        var m = list[idx];
        var txnForAssert = null;
        try {
          var grp = opts.rowsByMerchant && opts.rowsByMerchant[m];
          if (grp && grp.length) txnForAssert = grp[0];
        } catch (e) {}
        try {
          var outcome = await lookupOne(m, key, fetchFn, txnForAssert);
          out[idx] = { merchant: m, ok: true, outcome: outcome };
        } catch (e) {
          out[idx] = { merchant: m, ok: false,
                       error: String((e && e.message) || e),
                       httpStatus: e && e.httpStatus };
        }
        done += 1;
        note();
      }
    }
    for (var w = 0; w < n; w++) workers.push(worker());
    await Promise.all(workers);
    return out;
  }

  /**
   * Lookup.networkHint() -> one plain-language sentence distinguishing
   * "you look offline" from "something on the device blocked the request".
   * Never includes the key. Used by both the connection test and the
   * batch-run note so a generic failure becomes diagnosable.
   */
  function networkHint() {
    try {
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        return 'You appear to be offline — reconnect and try again.';
      }
    } catch (e) {}
    return 'The request was blocked before it reached Tavily — check VPN, iCloud Private Relay, or a content/ad blocker, then test again.';
  }

  /**
   * Lookup.testConnection(fetchFn) -> {ok, code, message}.
   * Sends exactly ONE probe request with a fixed synthetic query
   * (Lookup.TEST_QUERY) — never a real merchant name — and translates the
   * outcome into plain language for the settings view. Never throws, never
   * logs or includes the key, never touches the merchant cache or rules.
   */
  var TEST_QUERY = 'TEST MERCHANT';
  async function testConnection(fetchFn) {
    if (typeof fetchFn !== 'function') {
      if (typeof fetch !== 'undefined') fetchFn = fetch;
      else return { ok: false, code: 'no-fetch',
        message: 'This browser could not run the test. Try again on the device where you use the app.' };
    }
    var key = getKey();
    if (!key) return { ok: false, code: 'no-key',
      message: 'Paste your Tavily key first, then test.' };
    try {
      await lookupOne(TEST_QUERY, key, fetchFn, null);
      return { ok: true, code: 'ok',
        message: 'Key works — merchant lookup is ready.' };
    } catch (e) {
      var st = e && e.httpStatus;
      if (st === 401) return { ok: false, code: 'bad-key',
        message: 'The key was rejected — double-check it in your Tavily dashboard.' };
      if (st === 429) return { ok: false, code: 'quota',
        message: 'The monthly search quota is used up — lookup resumes next month.' };
      return { ok: false, code: 'network',
        message: 'Could not reach Tavily. ' + networkHint() };
    }
  }

  /* ---------- teach-once rule ---------- */

  /**
   * Lookup.makeRule(merchantKey, categoryId, evidence) -> household rule
   * record in the flat shape Engine.autoCategorize honors. Deterministic id
   * so re-runs upsert instead of duplicating.
   */
  function makeRule(merchantKey, categoryId, evidence) {
    return {
      id: 'webr_' + hashStr(merchantKey + '|' + categoryId),
      enabled: true,
      priority: 100,
      matchMerchant: merchantKey,
      kind: null,
      category: categoryId,
      label: 'Web lookup: "' + merchantKey + '" \u2192 ' + categoryName(categoryId),
      source: 'web-lookup',
      createdAt: Date.now(),
      ruleType: 'category',
      scopeDescription: 'Merchant identified by a one-time web search' +
        (evidence ? ' (' + evidence + ')' : '') +
        '. Applies to future imports automatically; edit or delete it any time under More \u2192 Household rules.'
    };
  }

  function statusText(s) {
    s = s || {};
    var parts = [];
    if (s.auto) parts.push(s.auto + ' categorized');
    if (s.hints) parts.push(s.hints + ' hint' + (s.hints === 1 ? '' : 's'));
    if (s.unknown) parts.push(s.unknown + ' still unknown');
    return 'Merchant lookup: ' + (parts.length ? parts.join(' \u00B7 ') : 'nothing new found') + '.';
  }

  /**
   * Lookup.processTxns(txns, deps) -> summary.
   * Full flow: gate on isActive, find candidates, query, apply outcomes,
   * persist rules/txns/cache, store a plain-language status note.
   * deps: {fetchFn, getRules()->[rules], putRule(rule), putTxn(txn),
   *        onProgress(done,total), audit(eventType, entityType, entityId, details)}.
   * Never throws for per-merchant failures; returns a summary instead.
   */
  async function processTxns(txns, deps) {
    deps = deps || {};
    var summary = { ran: false, reason: '', lookedUp: 0, auto: 0, hints: 0, unknown: 0, failed: 0 };
    if (!isActive()) { summary.reason = 'off'; return summary; }
    var key = getKey();
    if (!key) {
      saveStatus('Add your Tavily search key in More \u2192 Merchant lookup to turn this on.');
      summary.reason = 'no-key';
      return summary;
    }
    var cands = candidates(txns);
    if (!cands.length) { summary.ran = true; return summary; }
    var fetchFn = deps.fetchFn || null;
    if (typeof fetchFn !== 'function' && typeof fetch !== 'undefined') fetchFn = fetch;
    if (typeof fetchFn !== 'function') { summary.reason = 'no-fetch'; return summary; }

    var rowsByM = {};
    (txns || []).forEach(function (t) {
      var m = normalizeMerchant(t && t.merchantRaw);
      if (m && cands.indexOf(m) !== -1) (rowsByM[m] = rowsByM[m] || []).push(t);
    });

    summary.ran = true;
    var results = await run(cands, key, {
      fetchFn: fetchFn,
      concurrency: CONCURRENCY,
      onProgress: deps.onProgress,
      rowsByMerchant: rowsByM
    });

    var existingRules = [];
    try { existingRules = (await deps.getRules()) || []; } catch (e) { existingRules = []; }
    function ruleExists(m, cat) {
      for (var i = 0; i < existingRules.length; i++) {
        var r = existingRules[i];
        if (r && r.enabled !== false &&
            String(r.matchMerchant || '').toUpperCase() === m && r.category === cat) return true;
      }
      return false;
    }

    var saw401 = false, saw429 = false;
    for (var k = 0; k < results.length; k++) {
      var r = results[k];
      var rows = rowsByM[r.merchant] || [];
      if (!r.ok) {
        summary.failed += rows.length;
        if (r.httpStatus === 401) saw401 = true;
        if (r.httpStatus === 429) saw429 = true;
        continue; // transient failure: do NOT cache, retry next time
      }
      summary.lookedUp += 1;
      var oc = r.outcome || { level: 'none' };
      if (oc.level === 'high') {
        var rule = makeRule(r.merchant, oc.categoryId, oc.evidence);
        if (!ruleExists(r.merchant, oc.categoryId)) {
          try { if (deps.putRule) await deps.putRule(rule); } catch (e) {}
          // getRules() may return a live array that putRule already
          // appended to — never record the same rule twice.
          if (existingRules.indexOf(rule) === -1) existingRules.push(rule);
        }
        // Stamp through the Engine so web rules behave exactly like
        // user-made category rules (categorySource 'rule').
        for (var z = 0; z < rows.length; z++) rows[z].lookupHint = null;
        if (hasEngine() && typeof Engine.autoCategorize === 'function') {
          try { Engine.autoCategorize(rows, [rule]); } catch (e) {}
        }
        summary.auto += rows.length;
        recordOutcome(r.merchant, oc.categoryId, null);
      } else if (oc.level === 'low') {
        for (var a = 0; a < rows.length; a++) rows[a].lookupHint = oc.hintLabel;
        summary.hints += rows.length;
        recordOutcome(r.merchant, null, oc.hintLabel);
      } else {
        summary.unknown += rows.length;
        recordOutcome(r.merchant, null, null);
      }
      for (var c = 0; c < rows.length; c++) {
        try { if (deps.putTxn) await deps.putTxn(rows[c]); } catch (e) {}
      }
    }

    var note;
    if (summary.lookedUp > 0) {
      note = statusText(summary);
    } else if (saw401) {
      note = 'The search key was rejected — check it in More \u2192 Merchant lookup. Nothing was categorized.';
    } else if (saw429) {
      note = 'The monthly search quota is used up — lookup resumes next month. Nothing was categorized.';
    } else if (summary.failed > 0) {
      // All attempts failed at the network level: keep the familiar phrase
      // but append the offline-vs-blocked distinction so it is actionable.
      note = 'Could not reach the web — lookup will try again next time. Nothing was categorized. ' + networkHint();
    } else {
      note = statusText(summary);
    }
    saveStatus(note); // never contains the key
    if (deps.audit) {
      try { deps.audit('lookup.run', 'ledger', null, summary); } catch (e) {}
    }
    return summary;
  }

  return {
    API_URL: API_URL,
    getSettings: getSettings,
    saveSettings: saveSettings,
    saveStatus: saveStatus,
    setKey: setKey,
    getKey: getKey,
    clearKey: clearKey,
    hasKey: hasKey,
    isActive: isActive,
    getCache: getCache,
    saveCache: saveCache,
    recordOutcome: recordOutcome,
    normalizeMerchant: normalizeMerchant,
    candidates: candidates,
    buildRequest: buildRequest,
    assertMerchantOnly: assertMerchantOnly,
    classifyResults: classifyResults,
    categoryName: categoryName,
    lookupOne: lookupOne,
    run: run,
    makeRule: makeRule,
    statusText: statusText,
    processTxns: processTxns,
    TEST_QUERY: TEST_QUERY,
    networkHint: networkHint,
    testConnection: testConnection
  };
})();
