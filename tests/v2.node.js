/* v2 tests: Phase 1 pagination + dup-cache helpers; Phase 2 subscriptions;
   Phase 3 split math + budget spend calc + sample-data determinism;
   Phase 4 monthCovered + sampleData shape + mulberry32 determinism.
   Synthetic data only. No network. Run with node. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB = path.join(__dirname, '..', 'apps/web');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok   ' + name);
  else { failures++; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}

/* ---------- load engine.js + app.js into a DOM-less sandbox ---------- */
const sandbox = { console: console };
sandbox.window = sandbox;
sandbox.global = sandbox;
sandbox.self = sandbox;
const _ls = {};
sandbox.localStorage = {
  getItem: (k) => (k in _ls ? _ls[k] : null),
  setItem: (k, v) => { _ls[k] = String(v); },
  removeItem: (k) => { delete _ls[k]; }
};
vm.createContext(sandbox);
for (const f of ['js/engine.js', 'js/app.js']) {
  vm.runInContext(fs.readFileSync(path.join(WEB, f), 'utf8'), sandbox, { filename: f });
}
const App = sandbox.App;
const Engine = sandbox.Engine;
if (!App || !Engine) { console.error('FAIL: App/Engine did not load'); process.exit(1); }
const T = App._test;
if (!T || !T._paginate || !T._dupCacheKey) { console.error('FAIL: test hooks missing'); process.exit(1); }

/* ---------- Phase 1: pagination helper ---------- */
console.log('== Phase 1: pagination');
check('TXN_PAGE_SIZE is 60', T.TXN_PAGE_SIZE === 60, 'got ' + T.TXN_PAGE_SIZE);
const big = [];
for (let i = 0; i < 150; i++) big.push({ id: i });
let pg = T._paginate(big, 60);
check('150 rows, limit 60 -> 60 rows', pg.rows.length === 60, 'got ' + pg.rows.length);
check('150 rows, limit 60 -> 90 remaining', pg.remaining === 90, 'got ' + pg.remaining);
pg = T._paginate(big, 200);
check('limit above length -> 0 remaining', pg.rows.length === 150 && pg.remaining === 0);
pg = T._paginate([], 60);
check('empty list -> 0/0', pg.rows.length === 0 && pg.remaining === 0);
pg = T._paginate(big, 0);
check('limit 0 -> 0 rows, 150 remaining', pg.rows.length === 0 && pg.remaining === 150);
pg = T._paginate(null, 60);
check('null list -> 0/0', pg.rows.length === 0 && pg.remaining === 0);

/* ---------- Phase 1: dup-cache key ---------- */
console.log('== Phase 1: dup-cache invalidation key');
const k1 = T._dupCacheKey(7, 117, 0);
const k2 = T._dupCacheKey(7, 117, 0);
const k3 = T._dupCacheKey(7, 117, 1);
const k4 = T._dupCacheKey(7, 118, 0);
const k5 = T._dupCacheKey(8, 117, 0);
check('same inputs -> same key', k1 === k2);
check('dataRev bump -> key changes', k1 !== k3, k1 + ' vs ' + k3);
check('txn count change -> key changes', k1 !== k4);
check('statement change -> key changes', k1 !== k5);

/* ---------- Phase 2: Engine.categorySpendMinor ---------- */
console.log('== Phase 2: categorySpendMinor');
function mkT(date, amountMinor, kind, category, excluded, status, spendAmountMinor) {
  const t = { date: date, amountMinor: amountMinor, kind: kind, category: category,
              excluded: excluded, status: status };
  if (spendAmountMinor !== undefined) t.spendAmountMinor = spendAmountMinor;
  return t;
}
const spendTxns = [
  mkT('2026-08-03', 4200, 'purchase', 'groceries', 0, 'new'),
  mkT('2026-08-10', 1500, 'purchase', 'groceries', 0, 'new'),
  mkT('2026-08-12', 999, 'purchase', 'dining', 0, 'new'),        // other category
  mkT('2026-07-28', 5000, 'purchase', 'groceries', 0, 'new'),    // other month
  mkT('2026-08-15', 2500, 'purchase', 'groceries', 1, 'new'),    // excluded
  mkT('2026-08-16', 3000, 'purchase', 'groceries', 0, 'duplicate'), // duplicate
  mkT('2026-08-17', -800, 'refund', 'groceries', 0, 'new'),      // refund: not spend
  mkT('2026-08-20', 0, 'purchase', 'groceries', 0, 'new', 1100), // spendAmountMinor wins
];
check('sums only matching category+month', Engine.categorySpendMinor(spendTxns, 'groceries', '2026-08') === 6800,
  'got ' + Engine.categorySpendMinor(spendTxns, 'groceries', '2026-08'));
check('other category', Engine.categorySpendMinor(spendTxns, 'dining', '2026-08') === 999);
check('other month', Engine.categorySpendMinor(spendTxns, 'groceries', '2026-07') === 5000);
check('empty list -> 0', Engine.categorySpendMinor([], 'groceries', '2026-08') === 0);

/* ---------- Phase 2: App.parseDollarsToMinor ---------- */
console.log('== Phase 2: parseDollarsToMinor');
// Comma policy (documented choice): commas are NOT accepted -> null, because
// "1,000" vs "1.000" is locale-ambiguous; the UI asks for digits only.
check("'12.34' -> 1234", T.parseDollarsToMinor('12.34') === 1234);
check("'$12.34' -> 1234", T.parseDollarsToMinor('$12.34') === 1234);
check("'5' -> 500", T.parseDollarsToMinor('5') === 500);
check("'0.99' -> 99", T.parseDollarsToMinor('0.99') === 99);
check("whitespace ok -> 750", T.parseDollarsToMinor('  7.50  ') === 750);
check("'$1,000' -> null (commas rejected)", T.parseDollarsToMinor('$1,000') === null);
check("'1,000' -> null", T.parseDollarsToMinor('1,000') === null);
check("empty -> null", T.parseDollarsToMinor('') === null);
check("'abc' -> null", T.parseDollarsToMinor('abc') === null);
check("'-5' -> null (no negatives)", T.parseDollarsToMinor('-5') === null);
check("'12.345' -> null (max 2dp)", T.parseDollarsToMinor('12.345') === null);
check("'$' -> null", T.parseDollarsToMinor('$') === null);
check("null input -> null", T.parseDollarsToMinor(null) === null);

/* ---------- Phase 2: Engine.detectSubscriptions ---------- */
console.log('== Phase 2: detectSubscriptions');
function subT(merchantRaw, date, amountMinor, kind, excluded, status) {
  return { merchantRaw: merchantRaw, date: date, amountMinor: amountMinor,
           kind: kind || 'purchase', excluded: excluded || 0, status: status || 'new' };
}
const monthlyTxns = [
  subT('SPOTIFY', '2026-05-01', 1099),
  subT('SPOTIFY', '2026-06-01', 1099),
  subT('Spotify', '2026-07-01', 1099),
  subT('SPOTIFY #138', '2026-08-01', 1099),   // trailing store number normalizes away
  subT('SPOTIFY', '2026-08-02', 1099, 'refund'), // kind filter: refunds ignored
  subT('SPOTIFY', '2026-08-03', 1099, 'purchase', 1), // excluded filter
  subT('SPOTIFY', '2026-08-04', 1099, 'purchase', 0, 'duplicate'), // status filter
];
const weeklyTxns = [
  subT('GYM', '2026-08-01', 700),
  subT('GYM', '2026-08-08', 700),
  subT('GYM', '2026-08-15', 700),
  subT('GYM', '2026-08-22', 700),
];
const yearlyTxns = [
  subT('DOMAIN REG', '2024-03-01', 1499),
  subT('DOMAIN REG', '2025-03-01', 1499),
  subT('DOMAIN REG', '2026-03-01', 1499),
];
const twoTxns = [subT('TWICE', '2026-07-01', 500), subT('TWICE', '2026-08-01', 500)];
const irregularTxns = [
  subT('IRREG', '2026-05-01', 400),
  subT('IRREG', '2026-05-06', 400),
  subT('IRREG', '2026-05-11', 400),
  subT('IRREG', '2026-06-30', 400), // gaps 5,5,50 -> median 5: no cadence
];
const noisyTxns = [
  subT('NOISY', '2026-05-01', 1000),
  subT('NOISY', '2026-06-01', 1000),
  subT('NOISY', '2026-07-01', 1150), // 15% off the earlier median -> discard
  subT('NOISY', '2026-08-01', 1000),
];
const riserTxns = [
  subT('RISER', '2026-05-01', 1000),
  subT('RISER', '2026-06-01', 1000),
  subT('RISER', '2026-07-01', 1000),
  subT('RISER', '2026-08-01', 1200), // 20% jump on the LATEST only -> price change
];
const almostTxns = [
  subT('ALMOST', '2026-06-01', 300),
  subT('ALMOST', '2026-07-01', 300),
  subT('ALMOST', '2026-08-01', 300, 'purchase', 0, 'duplicate'), // filtered -> only 2 left
];
const allSubs = Engine.detectSubscriptions(
  monthlyTxns.concat(weeklyTxns, yearlyTxns, twoTxns, irregularTxns, noisyTxns, riserTxns, almostTxns));
function findSub(merchant) {
  for (let i = 0; i < allSubs.length; i++) if (allSubs[i].merchant === merchant) return allSubs[i];
  return null;
}
const m = findSub('spotify');
check('monthly detected', !!m && m.cadence === 'monthly');
check('monthly occurrences=4 (filters applied)', !!m && m.occurrences === 4, m && String(m.occurrences));
check('monthly amountMinor=1099', !!m && m.amountMinor === 1099);
check('monthly nextExpected 2026-09-01', !!m && m.nextExpected === '2026-09-01', m && m.nextExpected);
check('monthly displayName most common raw', !!m && m.displayName === 'SPOTIFY', m && m.displayName);
check('monthly cost 1099', !!m && m.monthlyCostMinor === 1099);
check('monthly not priceChanged', !!m && m.priceChanged === false);
const w = findSub('gym');
check('weekly detected', !!w && w.cadence === 'weekly');
check('weekly nextExpected 2026-08-29', !!w && w.nextExpected === '2026-08-29', w && w.nextExpected);
check('weekly monthlyCost = round(700*30/7) = 3000', !!w && w.monthlyCostMinor === 3000);
const y = findSub('domain reg');
check('yearly detected', !!y && y.cadence === 'yearly');
check('yearly nextExpected 2027-03-01', !!y && y.nextExpected === '2027-03-01', y && y.nextExpected);
check('yearly monthlyCost = round(1499/12) = 125', !!y && y.monthlyCostMinor === 125);
check('<3 occurrences excluded', findSub('twice') === null);
check('duplicate-only third occurrence excluded', findSub('almost') === null);
check('irregular cadence excluded', findSub('irreg') === null);
check('>5% amount variance excluded', findSub('noisy') === null);
const r = findSub('riser');
check('price change flagged', !!r && r.priceChanged === true);
check('price-changed group kept (not discarded)', !!r && r.occurrences === 4);
check('sorted by monthlyCostMinor desc', allSubs.length === 4 &&
  allSubs[0].merchant === 'gym' && allSubs[1].merchant === 'spotify' &&
  allSubs[2].merchant === 'riser' && allSubs[3].merchant === 'domain reg',
  allSubs.map((s) => s.merchant + ':' + s.monthlyCostMinor).join(', '));
check('empty input -> []', Engine.detectSubscriptions([]).length === 0);

/* ---------- Phase 2: merchant normalization + dismiss slug ---------- */
console.log('== Phase 2: normSubMerchant + subDismissSlug');
check("'NETFLIX #138' -> 'netflix'", Engine._normSubMerchant('NETFLIX #138') === 'netflix');
check("'ACME Store No 12' -> 'acme store'", Engine._normSubMerchant('ACME Store No 12') === 'acme store');
check('whitespace collapse', Engine._normSubMerchant('  Star   Bucks  ') === 'star bucks');
check("slug 'Netflix #138' -> 'netflix'", T.subDismissSlug('Netflix #138') === 'netflix');
check("slug 'ACME Store No 12' -> 'acme_store'", T.subDismissSlug('ACME Store No 12') === 'acme_store');
check('slug has only [a-z0-9_]', /^[a-z0-9_]+$/.test(T.subDismissSlug('Café & Bar #7!')));

/* ---------- Phase 3: Engine.monthlyNetSpend ---------- */
console.log('== Phase 3: monthlyNetSpend');
const trendTxns = [
  mkT('2026-07-28', -5000, 'purchase', 'groceries', 0, 'new'),
  mkT('2026-08-03', -4200, 'purchase', 'groceries', 0, 'new'),
  mkT('2026-08-10', -1500, 'purchase', 'dining', 0, 'new'),
  mkT('2026-08-17', 800, 'refund', 'groceries', 0, 'new'),
  mkT('n/a', -999, 'purchase', 'groceries', 0, 'new'), // invalid date: skipped
  mkT(null, -999, 'purchase', 'groceries', 0, 'new'),  // missing date: skipped
];
const monthly = Engine.monthlyNetSpend(trendTxns);
check('two months, oldest first', monthly.length === 2 && monthly[0].month === '2026-07' && monthly[1].month === '2026-08',
  JSON.stringify(monthly));
check('2026-07 net = 5000 (canonical: purchase magnitudes)', monthly[0].netMinor === 5000, 'got ' + monthly[0].netMinor);
check('2026-08 net = 4200+1500-800 = 4900 (canonical)', monthly[1].netMinor === 4900, 'got ' + monthly[1].netMinor);
check('equals reconcile(monthTxns, null).netSpendMinor',
  monthly[1].netMinor === Engine.reconcile(trendTxns.filter((t) => t.date && t.date.indexOf('2026-08') === 0), null).netSpendMinor);
check('empty input -> []', Engine.monthlyNetSpend([]).length === 0);

/* ---------- Phase 3: App.searchTxns ---------- */
console.log('== Phase 3: searchTxns');
App.categories.push({ id: 'groceries', name: 'Groceries', parentId: null });
App.categories.push({ id: 'transport', name: 'Transport', parentId: null });
const searchPool = [
  { merchantRaw: 'LOBLAWS #4521', rawDescription: 'LOBLAWS #4521', category: 'groceries', amountMinor: -8743, date: '2026-08-02', kind: 'purchase' },
  { merchantRaw: 'SHELL GAS', rawDescription: 'SHELL GAS', category: 'transport', amountMinor: -4500, date: '2026-08-05', kind: 'purchase' },
];
check('description match (case-insensitive)', T.searchTxns(searchPool, 'loblaw').length === 1);
check('merchant match uppercase query', T.searchTxns(searchPool, 'SHELL').length === 1);
check('category name match', T.searchTxns(searchPool, 'Groceries').length === 1);
check('category id match', T.searchTxns(searchPool, 'transport').length === 1);
check('amount dollars text "87.43"', T.searchTxns(searchPool, '87.43').length === 1);
check('amount minor int text "8743"', T.searchTxns(searchPool, '8743').length === 1);
check('date match', T.searchTxns(searchPool, '2026-08-05').length === 1);
check('no match -> []', T.searchTxns(searchPool, 'zzz-nope').length === 0);
check('empty query -> all', T.searchTxns(searchPool, '').length === 2);
check('null pool -> []', T.searchTxns(null, 'x').length === 0);

/* ---------- Phase 3: Engine.splitEvenly ---------- */
console.log('== Phase 3: splitEvenly');
const e3 = Engine.splitEvenly(1000, 3);
check('1000/3 -> [334,333,333]', e3.length === 3 && e3[0] === 334 && e3[1] === 333 && e3[2] === 333, JSON.stringify(e3));
check('shares sum exactly', e3.reduce((a, b) => a + b, 0) === 1000);
const e4 = Engine.splitEvenly(100, 4);
check('100/4 -> four 25s', e4.length === 4 && e4.every((x) => x === 25), JSON.stringify(e4));
const e5 = Engine.splitEvenly(5, 3);
check('5/3 -> [2,2,1], remainder to first rows', e5[0] === 2 && e5[1] === 2 && e5[2] === 1, JSON.stringify(e5));
check('n=0 -> []', Engine.splitEvenly(1000, 0).length === 0);
check('total=0 -> []', Engine.splitEvenly(0, 3).length === 0);

/* ---------- Phase 3: Engine.expandSplits ---------- */
console.log('== Phase 3: expandSplits');
const splitTxnA = { kind: 'purchase', category: 'groceries', amountMinor: -1000, spendAmountMinor: -1000,
  date: '2026-08-03', excluded: 0, status: 'new',
  splits: [{ category: 'groceries', amountMinor: 600 }, { category: 'dining', amountMinor: 400 }] };
const splitTxnB = { kind: 'purchase', category: 'groceries', amountMinor: -1000, spendAmountMinor: -1000,
  date: '2026-08-04', excluded: 0, status: 'new' };
const splitTxnBadSum = { kind: 'purchase', category: 'groceries', amountMinor: -1000, spendAmountMinor: -1000,
  date: '2026-08-05', excluded: 0, status: 'new',
  splits: [{ category: 'groceries', amountMinor: 300 }] }; // sums to 300, not 1000
const splitTxnBadCat = { kind: 'purchase', category: 'groceries', amountMinor: -1000, spendAmountMinor: -1000,
  date: '2026-08-06', excluded: 0, status: 'new',
  splits: [{ category: '', amountMinor: 1000 }] }; // blank category
const expanded = Engine.expandSplits([splitTxnA, splitTxnB, splitTxnBadSum, splitTxnBadCat]);
check('valid split -> 2 rows, invalid -> 1 row each (5 total)', expanded.length === 5, 'got ' + expanded.length);
check('split rows carry split category + positive magnitude',
  expanded[0].category === 'groceries' && expanded[0].amountMinor === 600 && expanded[0].fromSplit === true &&
  expanded[1].category === 'dining' && expanded[1].amountMinor === 400 && expanded[1].fromSplit === true);
check('unsplit row: own category, |spend| magnitude',
  expanded[2].category === 'groceries' && expanded[2].amountMinor === 1000 && expanded[2].fromSplit === false);
check('sum-mismatch split falls back to single row', expanded[3].fromSplit === false && expanded[3].amountMinor === 1000);
check('blank-category split falls back to single row', expanded[4].fromSplit === false);
check('row indexes point back to source txns', expanded[0].row === 0 && expanded[2].row === 1 && expanded[1].txn === splitTxnA);
check('empty input -> []', Engine.expandSplits([]).length === 0);

/* ---------- Phase 3: categorySpendMinor honors splits ---------- */
console.log('== Phase 3: split-aware categorySpendMinor');
const splitSpendTxns = [
  { kind: 'purchase', category: 'groceries', amountMinor: -1000, spendAmountMinor: -1000,
    date: '2026-08-03', excluded: 0, status: 'new',
    splits: [{ category: 'groceries', amountMinor: 600 }, { category: 'dining', amountMinor: 400 }] },
  mkT('2026-08-10', -1000, 'purchase', 'groceries', 0, 'new'), // magnitude 1000
];
check('groceries = 600 split + 1000 unsplit', Engine.categorySpendMinor(splitSpendTxns, 'groceries', '2026-08') === 1600,
  'got ' + Engine.categorySpendMinor(splitSpendTxns, 'groceries', '2026-08'));
check('dining = 400 split share', Engine.categorySpendMinor(splitSpendTxns, 'dining', '2026-08') === 400);
const directTotals = Engine.splitAwareCategoryTotals(splitSpendTxns, '2026-08');
check('splitAwareCategoryTotals keys', directTotals.groceries === 1600 && directTotals.dining === 400,
  JSON.stringify(directTotals));

/* ---------- Phase 3: buildBriefing driver aggregation honors splits ---------- */
console.log('== Phase 3: buildBriefing split wiring');
const bf = Engine.buildBriefing([splitTxnA], '2026-08-01', '2026-08-31', null, 'test', null);
check('categoryTotals split across categories', bf.categoryTotals.groceries === 600 && bf.categoryTotals.dining === 400,
  JSON.stringify(bf.categoryTotals));
check('split shares use canonical sign (purchases positive; sum = spend magnitude)', (bf.categoryTotals.groceries + bf.categoryTotals.dining) === 1000);
check('topDrivers list both split categories', bf.topDrivers.length === 2);

/* ---------- Phase 3: balance-check policy (app-level mapping) ---------- */
console.log('== Phase 3: applyBalanceCheckPolicy');
const noBase = Engine.reconcile([{ kind: 'purchase', amountMinor: -100, spendAmountMinor: -100 }], null);
check("Engine value with no reported baseline is 'no_baseline'", noBase.balanceCheck === 'no_baseline');
check("no baseline -> app shows 'unavailable'",
  T.applyBalanceCheckPolicy({ balanceCheck: 'no_baseline' }, {}).balanceCheck === 'unavailable');
check("no baseline + manual statement -> 'unavailable'",
  T.applyBalanceCheckPolicy({ balanceCheck: 'no_baseline' }, { manual: true, reportedStartMinor: null }).balanceCheck === 'unavailable');
check("real 'ok' with baseline is never rewritten",
  T.applyBalanceCheckPolicy({ balanceCheck: 'ok' }, { reportedStartMinor: 0, reportedEndMinor: 5 }).balanceCheck === 'ok');
check("real 'gap' is never rewritten",
  T.applyBalanceCheckPolicy({ balanceCheck: 'gap', gapMinor: 42 }, {}).balanceCheck === 'gap');

/* ---------- Phase 3: parseDollarsToMinor reuse for split inputs ---------- */
console.log('== Phase 3: parseDollarsToMinor (split inputs)');
check("'3.34' -> 334", T.parseDollarsToMinor('3.34') === 334);
check("'10' -> 1000", T.parseDollarsToMinor('10') === 1000);
check("'0.01' -> 1", T.parseDollarsToMinor('0.01') === 1);
check("split-even fill text round-trips", T.parseDollarsToMinor(T.dollarsText(334)) === 334);

/* ---------- Phase 3: defaultBudgetMonth ---------- */
console.log('== Phase 3: defaultBudgetMonth');
check('latest statement periodEnd month wins',
  T.defaultBudgetMonth([{ periodEnd: '2026-07-31', createdAt: 1 }, { periodEnd: '2026-08-31', createdAt: 2 }]) === '2026-08');
const _n = new Date();
const _cur = _n.getFullYear() + '-' + ('0' + (_n.getMonth() + 1)).slice(-2);
check('no statements -> current month', T.defaultBudgetMonth([]) === _cur, T.defaultBudgetMonth([]));

/* ---------- Phase 4: Engine._mulberry32 ---------- */
console.log('== Phase 4: _mulberry32');
var _r1 = Engine._mulberry32(7), _r2 = Engine._mulberry32(7);
var _seq1 = [_r1(), _r1(), _r1()], _seq2 = [_r2(), _r2(), _r2()];
check('same seed -> identical sequence', JSON.stringify(_seq1) === JSON.stringify(_seq2));
check('values in [0,1)', _seq1.every(function (x) { return x >= 0 && x < 1; }));
check('different seed -> different sequence',
  Engine._mulberry32(8)() !== Engine._mulberry32(9)());

/* ---------- Phase 4: Engine.monthCovered ---------- */
console.log('== Phase 4: monthCovered');
var _covStmts = [
  { periodStart: '2026-06-01', periodEnd: '2026-06-30' },
  { periodStart: '2026-08-01', periodEnd: '2026-08-31' },
  { periodStart: '2026-09-15', periodEnd: '2026-10-15' } // spans Sep + Oct
];
check('exact month covered', Engine.monthCovered(_covStmts, '2026-06') === true);
check('gap month uncovered (March)', Engine.monthCovered(_covStmts, '2026-03') === false);
check('month between statements uncovered (July)', Engine.monthCovered(_covStmts, '2026-07') === false);
check('spanning statement covers Sep', Engine.monthCovered(_covStmts, '2026-09') === true);
check('spanning statement covers Oct', Engine.monthCovered(_covStmts, '2026-10') === true);
check('adjacent month not covered (May)', Engine.monthCovered(_covStmts, '2026-05') === false);
check('missing periodStart -> uncovered', Engine.monthCovered([{ periodEnd: '2026-08-31' }], '2026-08') === false);
check('missing periodEnd -> uncovered', Engine.monthCovered([{ periodStart: '2026-08-01' }], '2026-08') === false);
check('empty list -> false', Engine.monthCovered([], '2026-08') === false);
check('null list -> false', Engine.monthCovered(null, '2026-08') === false);
check('invalid monthPrefix -> false', Engine.monthCovered(_covStmts, '2026-13') === false);
check('leap-year Feb boundary', Engine.monthCovered(
  [{ periodStart: '2024-02-01', periodEnd: '2024-02-29' }], '2024-02') === true);
check('single-day statement inside month', Engine.monthCovered(
  [{ periodStart: '2026-08-15', periodEnd: '2026-08-15' }], '2026-08') === true);

/* ---------- Phase 4: Engine.sampleData ---------- */
console.log('== Phase 4: sampleData');
var _s1 = Engine.sampleData(42, '2026-09');
var _s1b = Engine.sampleData(42, '2026-09');
var _s2 = Engine.sampleData(43, '2026-09');
check('same seed+baseMonth -> JSON-identical', JSON.stringify(_s1) === JSON.stringify(_s1b));
check('different seed -> different output', JSON.stringify(_s1) !== JSON.stringify(_s2));
check('account shape', _s1.account.name === 'Sample Bank' && _s1.account.type === 'sample' &&
  _s1.account.sample === true && _s1.account.sampleBatch === 'v2-sample');
check('3 statements', _s1.statements.length === 3);
var _smonths = _s1.statements.map(function (s) { return s.stmtKey; });
check('consecutive months ending at baseMonth', _smonths.join(',') === '2026-07,2026-08,2026-09', _smonths.join(','));
check('year-boundary anchoring', Engine.sampleData(42, '2026-01').statements
  .map(function (s) { return s.stmtKey; }).join(',') === '2025-11,2025-12,2026-01');
check('statement bounds + honest null baselines', _s1.statements.every(function (s) {
  return s.periodStart === s.stmtKey + '-01' && s.periodEnd === s.stmtKey + '-' +
    Engine._monthLastDay(s.stmtKey).slice(8, 10) &&
    s.reportedStartMinor === null && s.reportedEndMinor === null &&
    s.scopeLabel.indexOf('Sample data') === 0 && s.sampleBatch === 'v2-sample';
}));
var _perMonth = {}, _allInt = true, _purchOk = true, _refOk = true, _tagOk = true,
    _payCount = {}, _rowOk = {}, _riSeq = true, _catIds = {};
Engine.defaultCategories().forEach(function (c) { _catIds[c.id] = 1; });
_s1.txns.forEach(function (t) {
  _perMonth[t.stmtKey] = (_perMonth[t.stmtKey] || 0) + 1;
  if (!Number.isInteger(t.amountMinor) || !Number.isInteger(t.spendAmountMinor)) _allInt = false;
  if (t.kind === 'purchase' && !(t.amountMinor < 0 && t.amountMinor >= -18000 && t.amountMinor <= -300)) _purchOk = false;
  if (t.kind === 'refund' && !(t.amountMinor > 0)) _refOk = false;
  if (t.spendAmountMinor !== Math.abs(t.amountMinor)) _tagOk = false;
  if (t.sample !== true || t.sampleBatch !== 'v2-sample') _tagOk = false;
  if (t.currency !== 'CAD' || t.status !== 'new' || t.excluded !== 0) _tagOk = false;
  if (t.classificationSource !== 'sample') _tagOk = false;
  if (!_catIds[t.category]) _tagOk = false;
  if (t.kind === 'payment') _payCount[t.stmtKey] = (_payCount[t.stmtKey] || 0) + 1;
  (_rowOk[t.stmtKey] = _rowOk[t.stmtKey] || []).push(t.rowIndex);
});
check('25-36 txns per month (3 months)', ['2026-07', '2026-08', '2026-09'].every(function (m) {
  return _perMonth[m] >= 25 && _perMonth[m] <= 36;
}), JSON.stringify(_perMonth));
check('all amounts integer minor units', _allInt);
check('purchases negative, -$3..-$180', _purchOk);
check('refunds positive', _refOk);
check('spendAmountMinor=|amountMinor|, tagged, CAD/new/0, sample source, real category ids', _tagOk);
check('exactly one payment per month', Object.keys(_payCount).length === 3 &&
  Object.keys(_payCount).every(function (m) { return _payCount[m] === 1; }), JSON.stringify(_payCount));
Object.keys(_rowOk).forEach(function (k) {
  for (var i = 0; i < _rowOk[k].length; i++) if (_rowOk[k][i] !== i) _riSeq = false;
});
check('rowIndex sequential per statement', _riSeq);
check('no NaN/undefined leaks in JSON', JSON.stringify(_s1).indexOf('NaN') === -1 &&
  JSON.stringify(_s1).indexOf('undefined') === -1);
check('balanceCheck honest: reconcile w/ null reported -> no_baseline',
  Engine.reconcile(_s1.txns.filter(function (t) { return t.stmtKey === '2026-09'; }), null).balanceCheck === 'no_baseline');

console.log(failures === 0 ? '\nALL V2 CHECKS PASSED' : '\n' + failures + ' FAILURES');
process.exit(failures === 0 ? 0 : 1);
