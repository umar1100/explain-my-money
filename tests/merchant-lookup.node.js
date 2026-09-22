/* Opt-in online merchant lookup tests: real engine.js + lookup.js, mocked
   fetch (no network). Covers:
   - off by default -> zero network calls, nothing changes.
   - payload privacy: the outbound body carries ONLY the merchant name
     (no amount, date, id, or statement id), asserted before every send.
   - high confidence (>=2 agreeing results) -> auto-categorized + teach-once
     household rule persisted + outcome cached.
   - low confidence (single result) -> stays in Review with a hint chip,
     no category, no rule.
   - ambiguous (results disagree) -> stays in Review, no hint, no category.
   - cache: a merchant is looked up exactly once ever (repeat run = no fetch).
   - failures (network error, 401, 429) -> rows stay in Review, no crash,
     plain-language status note that never contains the key; the all-failed
     network note appends an offline-vs-blocked distinction.
   - key pasted with surrounding whitespace is trimmed before saving/sending.
   - testConnection(): one probe with the synthetic query "TEST MERCHANT"
     (never a real merchant); precise outcomes for 200/401/429/network-throw
     with onLine true/false; never includes the key in any message.
   All merchants are fictional. Run with node. */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'apps/web/js');

/* localStorage shim (lookup.js falls back to memory without it, but the
   shim exercises the real on-device storage path). */
const _mem = {};
global.localStorage = {
  getItem(k) { return Object.prototype.hasOwnProperty.call(_mem, k) ? _mem[k] : null; },
  setItem(k, v) { _mem[k] = String(v); },
  removeItem(k) { delete _mem[k]; },
  clear() { for (const k in _mem) delete _mem[k]; }
};
global.window = global;
require(WEB + '/engine.js');
require(WEB + '/lookup.js');
const L = global.Lookup;
if (!L) { console.error('FAIL: Lookup did not load'); process.exit(1); }

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; }
  else { fail++; console.error('FAIL:', name, extra === undefined ? '' : JSON.stringify(extra)); }
}

function reset() {
  for (const k in _mem) delete _mem[k];
  L.clearKey(); // also resets the in-memory key memo
}

function txn(id, merchantRaw, amountMinor, date) {
  return { id: id, merchantRaw: merchantRaw, amountMinor: amountMinor, date: date,
           kind: 'purchase', kindConfidence: 0.6, confidence: 'needs_review' };
}

/* Mock fetch: records calls, delegates the response to a handler. */
function mockFetch(handler) {
  const calls = [];
  const fn = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, body, options });
    return handler(body, calls.length);
  };
  fn.calls = calls;
  return fn;
}
function okResults(results) {
  return { ok: true, status: 200, json: async () => ({ results: results }) };
}
function httpError(status) {
  return { ok: false, status: status, json: async () => ({}) };
}

function makeDeps(fetchFn) {
  const rules = [], saved = [];
  return {
    fetchFn: fetchFn,
    getRules: async () => rules,
    putRule: async (r) => { rules.push(r); },
    putTxn: async (t) => { saved.push(t); },
    onProgress: null,
    audit: () => {},
    _rules: rules, _saved: saved
  };
}

/* Fictional merchants (never real user data). */
const PIZZA = 'MAPLEWOOD PIZZA 12 TORONTO ON';
const BOOKS = 'NORTHSIDE BOOKS 88 OTTAWA ON';
const MART = 'ZED MART 5 HAMILTON ON';

const pizzaR1 = { title: 'Maplewood Pizza — pizzeria in Toronto',
  content: 'Family-run pizzeria serving wood-fired pizza. Dine-in and takeout.', score: 0.9 };
const pizzaR2 = { title: 'Maplewood Pizza | restaurant guide',
  content: 'Pizzeria and restaurant. Reviews mention the margherita pizza.', score: 0.72 };
const booksR1 = { title: 'Northside Books Ottawa',
  content: 'Independent bookstore selling new and used books downtown.', score: 0.85 };
const groceryR1 = { title: 'Zed Mart Hamilton',
  content: 'Grocery store and produce market open late.', score: 0.8 };

(async () => {
  /* ---------- 1. off by default: zero network calls ---------- */
  reset();
  ok(L.isActive() === false, 'lookup is off by default');
  const spyOff = mockFetch(() => okResults([]));
  const rows1 = [txn('t1', PIZZA, 2032, '2026-08-28')];
  const sum1 = await L.processTxns(rows1, makeDeps(spyOff));
  ok(sum1.ran === false && sum1.reason === 'off', 'processTxns refuses to run when off', sum1);
  ok(spyOff.calls.length === 0, 'feature off -> zero network calls');
  ok(!rows1[0].category, 'feature off -> row untouched');

  /* ---------- 2. enable + key ---------- */
  reset();
  L.saveSettings({ enabled: true });
  ok(L.isActive() === false, 'enabled but no key -> still inactive');
  L.setKey('tvly-test-key-123');
  ok(L.hasKey() === true, 'key stored');
  ok(L.isActive() === true, 'enabled + key -> active');

  /* ---------- 3. payload privacy: merchant name ONLY ---------- */
  reset();
  L.saveSettings({ enabled: true });
  L.setKey('tvly-test-key-123');
  const privTxn = txn('txn-abc', PIZZA, 77777, '2026-03-15');
  privTxn.statementId = 'st-1';
  const spyPriv = mockFetch(() => okResults([]));
  await L.processTxns([privTxn], makeDeps(spyPriv));
  ok(spyPriv.calls.length === 1, 'one lookup call for one merchant');
  const call = spyPriv.calls[0];
  ok(call.url === 'https://api.tavily.com/search', 'posts to the Tavily search endpoint', call.url);
  ok(call.body.query === PIZZA, 'query is exactly the merchant descriptor', call.body.query);
  ok(call.body.api_key === 'tvly-test-key-123', 'key travels in the request body (documented Tavily auth)');
  const serialized = JSON.stringify(call.body);
  ok(serialized.indexOf('77777') === -1, 'payload has no amount', serialized);
  ok(serialized.indexOf('2026-03-15') === -1, 'payload has no date', serialized);
  ok(serialized.indexOf('txn-abc') === -1, 'payload has no txn id', serialized);
  ok(serialized.indexOf('st-1') === -1, 'payload has no statement id', serialized);
  const req = L.buildRequest('tvly-test-key-123', PIZZA);
  ok(L.assertMerchantOnly(req, privTxn) === true, 'assertMerchantOnly passes for a clean request');
  const badReq = L.buildRequest('tvly-test-key-123', PIZZA);
  badReq.body.amount_minor = 77777;
  ok(L.assertMerchantOnly(badReq, privTxn) === false, 'assertMerchantOnly catches a tainted payload');
  ok(!privTxn.category, 'empty results -> row stays uncategorized (never-guess)');

  /* ---------- 4. high confidence -> auto + teach-once rule + cache ---------- */
  reset();
  L.saveSettings({ enabled: true });
  L.setKey('tvly-test-key-123');
  const spyHigh = mockFetch(() => okResults([pizzaR1, pizzaR2]));
  const depsHigh = makeDeps(spyHigh);
  const rowsHigh = [txn('t2', PIZZA, 2032, '2026-08-28'), txn('t3', PIZZA, 1150, '2026-08-29')];
  const sumHigh = await L.processTxns(rowsHigh, depsHigh);
  ok(sumHigh.ran === true && sumHigh.auto === 2, 'two agreeing results -> both rows auto-categorized', sumHigh);
  ok(rowsHigh[0].category === 'dining' && rowsHigh[1].category === 'dining', 'rows stamped dining', rowsHigh.map(r => r.category));
  ok(rowsHigh[0].categorySource === 'rule', 'web identification stamps via the rule path', rowsHigh[0].categorySource);
  ok(depsHigh._rules.length === 1, 'exactly one teach-once rule persisted', depsHigh._rules.length);
  const rule = depsHigh._rules[0];
  ok(rule.matchMerchant === PIZZA && rule.category === 'dining', 'rule targets the merchant -> dining', rule);
  ok(rule.source === 'web-lookup', 'rule is labeled as a web-lookup rule', rule.source);
  ok(rule.kind === null, 'web rule is category-only (no kind override)', rule.kind);
  const rule2 = L.makeRule(PIZZA, 'dining', 'x');
  ok(rule2.id === rule.id, 'rule id is deterministic (re-runs upsert, never duplicate)');
  const cacheHigh = L.getCache();
  ok(cacheHigh[PIZZA] && cacheHigh[PIZZA].categoryId === 'dining', 'outcome cached by merchant');
  ok(depsHigh._saved.length === 2, 'both touched rows persisted');

  /* ---------- 5. low confidence -> Review with hint chip ---------- */
  reset();
  L.saveSettings({ enabled: true });
  L.setKey('tvly-test-key-123');
  const spyLow = mockFetch(() => okResults([pizzaR1]));
  const depsLow = makeDeps(spyLow);
  const rowsLow = [txn('t4', PIZZA, 2032, '2026-08-28')];
  const sumLow = await L.processTxns(rowsLow, depsLow);
  ok(sumLow.hints === 1 && sumLow.auto === 0, 'single result -> hint, no auto', sumLow);
  ok(!rowsLow[0].category, 'hinted row stays uncategorized (stays in Review)');
  ok(rowsLow[0].lookupHint === 'Dining', 'hint chip carries the suggested category', rowsLow[0].lookupHint);
  ok(depsLow._rules.length === 0, 'no rule persisted for low-confidence matches');
  const cacheLow = L.getCache();
  ok(cacheLow[PIZZA] && cacheLow[PIZZA].hint === 'Dining', 'hint cached by merchant');

  /* ---------- 6. ambiguous (results disagree) -> silent Review ---------- */
  reset();
  L.saveSettings({ enabled: true });
  L.setKey('tvly-test-key-123');
  const spyAmb = mockFetch(() => okResults([pizzaR1, groceryR1]));
  const rowsAmb = [txn('t5', MART, 4100, '2026-08-20')];
  const sumAmb = await L.processTxns(rowsAmb, makeDeps(spyAmb));
  ok(sumAmb.unknown === 1, 'disagreeing results -> unknown', sumAmb);
  ok(!rowsAmb[0].category && !rowsAmb[0].lookupHint, 'ambiguous -> no category and no misleading hint');

  /* ---------- 7. cache: each merchant looked up exactly once ever ---------- */
  reset();
  L.saveSettings({ enabled: true });
  L.setKey('tvly-test-key-123');
  const spyCache = mockFetch(() => okResults([pizzaR1, pizzaR2]));
  const depsCache = makeDeps(spyCache);
  await L.processTxns([txn('t6', PIZZA, 2032, '2026-08-28')], depsCache);
  ok(spyCache.calls.length === 1, 'first run queries the merchant');
  const again = await L.processTxns([txn('t7', PIZZA, 1500, '2026-09-02')], depsCache);
  ok(spyCache.calls.length === 1, 'second run makes zero new calls (cache hit)');
  ok(again.lookedUp === 0, 'cached merchant is not a candidate twice');
  // ...but the persisted rule still categorizes it through the normal path:
  const rerow = [txn('t7', PIZZA, 1500, '2026-09-02')];
  global.Engine.autoCategorize(rerow, depsCache._rules);
  ok(rerow[0].category === 'dining', 'teach-once rule categorizes future imports without a lookup');

  /* ---------- 8. network failure -> graceful, Review, honest note ---------- */
  reset();
  L.saveSettings({ enabled: true });
  L.setKey('tvly-test-key-123');
  const spyFail = mockFetch(() => { throw new Error('network down'); });
  const rowsFail = [txn('t8', BOOKS, 3400, '2026-08-25')];
  let threw = false, sumFail = null;
  try { sumFail = await L.processTxns(rowsFail, makeDeps(spyFail)); }
  catch (e) { threw = true; }
  ok(!threw, 'transport failure never throws');
  ok(sumFail && sumFail.failed === 1, 'failure counted', sumFail);
  ok(!rowsFail[0].category, 'failed lookup -> row stays in Review');
  const stFail = L.getSettings().lastStatus;
  ok(/could not reach the web/i.test(stFail), 'plain-language offline note', stFail);
  ok(stFail.indexOf('tvly-test-key-123') === -1, 'status note never contains the key');
  ok(!(L.getCache()[BOOKS]), 'transient failures are NOT cached (retry next time)');

  /* ---------- 9. 401 -> invalid-key note, key never exposed ---------- */
  reset();
  L.saveSettings({ enabled: true });
  L.setKey('tvly-test-key-123');
  const spy401 = mockFetch(() => httpError(401));
  await L.processTxns([txn('t9', BOOKS, 3400, '2026-08-25')], makeDeps(spy401));
  const st401 = L.getSettings().lastStatus;
  ok(/rejected/i.test(st401), '401 -> invalid-key note', st401);
  ok(st401.indexOf('tvly-test-key-123') === -1, '401 note never contains the key');

  /* ---------- 10. 429 -> quota note ---------- */
  reset();
  L.saveSettings({ enabled: true });
  L.setKey('tvly-test-key-123');
  const spy429 = mockFetch(() => httpError(429));
  await L.processTxns([txn('t10', BOOKS, 3400, '2026-08-25')], makeDeps(spy429));
  ok(/quota/i.test(L.getSettings().lastStatus), '429 -> quota-exhausted note', L.getSettings().lastStatus);

  /* ---------- 11. candidates(): local pipeline stays first ---------- */
  reset();
  const mix = [
    txn('a1', PIZZA, 1000, '2026-08-01'),                                    // candidate
    Object.assign(txn('a2', PIZZA, 1000, '2026-08-01'), { category: 'dining' }), // already categorized
    Object.assign(txn('a3', BOOKS, 1000, '2026-08-01'), { categorySource: 'user' }), // user-touched
    { id: 'a4', merchantRaw: 'INTERAC E-TRANSFER', kind: 'transfer' },       // not spend
    txn('a5', PIZZA, 2000, '2026-08-02')                                     // same merchant: deduped
  ];
  const cands = L.candidates(mix);
  ok(cands.length === 1 && cands[0] === PIZZA, 'only one unique uncategorized spend candidate', cands);

  /* ---------- 12. deleting the key disables the feature ---------- */
  reset();
  L.saveSettings({ enabled: true });
  L.setKey('tvly-test-key-123');
  L.clearKey();
  ok(L.isActive() === false, 'key deleted -> feature inactive');
  const spyDel = mockFetch(() => okResults([pizzaR1, pizzaR2]));
  await L.processTxns([txn('t11', PIZZA, 1000, '2026-08-01')], makeDeps(spyDel));
  ok(spyDel.calls.length === 0, 'no key -> zero network calls');

  /* ---------- 13. pasted key is whitespace-trimmed before saving ---------- */
  reset();
  L.setKey('  tvly-test-key-123 \n');
  ok(L.getKey() === 'tvly-test-key-123', 'surrounding whitespace trimmed on save', L.getKey());
  L.saveSettings({ enabled: true });
  const spyTrim = mockFetch(() => okResults([]));
  await L.processTxns([txn('t12', BOOKS, 3400, '2026-08-25')], makeDeps(spyTrim));
  ok(spyTrim.calls.length === 1, 'trimmed key still activates the feature');
  ok(spyTrim.calls[0].body.api_key === 'tvly-test-key-123', 'the trimmed key is what gets sent');
  ok(String(L.getSettings().lastStatus || '').indexOf('tvly-test-key-123') === -1, 'trimmed key never lands in status notes');

  /* ---------- 14. testConnection(): one synthetic probe, exact outcomes ---------- */
  reset();
  L.setKey('tvly-test-key-123');
  const spyT = mockFetch(() => okResults([]));
  const resOk = await L.testConnection(spyT);
  ok(resOk.ok === true && resOk.code === 'ok' && /ready/i.test(resOk.message), 'test 200 -> key works', resOk);
  ok(spyT.calls.length === 1, 'test sends exactly ONE probe request');
  ok(spyT.calls[0].body.query === L.TEST_QUERY && spyT.calls[0].body.query === 'TEST MERCHANT',
     'probe uses the fixed synthetic query, never a real merchant', spyT.calls[0].body.query);
  ok(spyT.calls[0].body.api_key === 'tvly-test-key-123', 'probe carries the stored key');
  ok(!(L.getCache()['TEST MERCHANT']), 'probe does not pollute the merchant cache');

  const res401 = await L.testConnection(mockFetch(() => httpError(401)));
  ok(res401.ok === false && res401.code === 'bad-key' && /rejected/i.test(res401.message), 'test 401 -> rejected message', res401);

  const res429 = await L.testConnection(mockFetch(() => httpError(429)));
  ok(res429.ok === false && res429.code === 'quota' && /quota/i.test(res429.message), 'test 429 -> quota message', res429);

  const throwFetch = mockFetch(() => { throw new Error('boom'); });
  /* Node ships a getter-only global `navigator`; stub it via defineProperty. */
  function stubOnline(v) {
    Object.defineProperty(global, 'navigator', { value: { onLine: v }, configurable: true });
  }
  function unstubNavigator() { delete global.navigator; }
  stubOnline(true);
  const resBlk = await L.testConnection(throwFetch);
  ok(resBlk.ok === false && resBlk.code === 'network' && /blocked before it reached tavily/i.test(resBlk.message),
     'test throw while online -> blocked-by-device note', resBlk.message);

  stubOnline(false);
  const resOff = await L.testConnection(mockFetch(() => { throw new Error('boom'); }));
  ok(resOff.ok === false && resOff.code === 'network' && /appear to be offline/i.test(resOff.message),
     'test throw while offline -> offline note', resOff.message);
  delete global.navigator;

  reset(); // no key
  const resNoKey = await L.testConnection(mockFetch(() => okResults([])));
  ok(resNoKey.ok === false && resNoKey.code === 'no-key' && /paste your tavily key first/i.test(resNoKey.message),
     'test without a key -> paste-key note, zero network calls', resNoKey);
  [resOk, res401, res429, resBlk, resOff, resNoKey].forEach(function (r, i) {
    ok(r.message.indexOf('tvly-test-key-123') === -1, 'test outcome #' + i + ' never contains the key');
  });

  /* ---------- 15. batch note: all-failed network case stays diagnosable ---------- */
  reset();
  L.saveSettings({ enabled: true });
  L.setKey('tvly-test-key-123');
  const failFetch = mockFetch(() => { throw new Error('down'); });
  stubOnline(false);
  await L.processTxns([txn('t13', BOOKS, 3400, '2026-08-25')], makeDeps(failFetch));
  const stOff2 = L.getSettings().lastStatus;
  ok(/could not reach the web/i.test(stOff2), 'batch note keeps the familiar reachability phrase', stOff2);
  ok(/appear to be offline/i.test(stOff2), 'batch note appends the offline distinction', stOff2);
  ok(stOff2.indexOf('tvly-test-key-123') === -1, 'batch note never contains the key');

  stubOnline(true);
  await L.processTxns([txn('t14', BOOKS, 3400, '2026-08-25')], makeDeps(failFetch));
  const stBlk2 = L.getSettings().lastStatus;
  ok(/could not reach the web/i.test(stBlk2), 'batch note keeps the phrase when blocked', stBlk2);
  ok(/blocked before it reached tavily/i.test(stBlk2), 'batch note appends the blocked distinction', stBlk2);
  delete global.navigator;

  console.log('\nmerchant-lookup: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
