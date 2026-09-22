/* Home "Where it went" drill-down tests: real engine.js.
   Engine.categoryMembers must return exactly the rows behind a category bar,
   so the drill-down list always adds up to the bar's total:
   - members match totalsByCategory for every category key
   - split transactions contribute their share to each touched category
   - excluded / duplicate rows never appear
   - payments and transfers never appear
   - shareMinor sums to the category total for every key
   All merchants are fictional. Run with node. */
'use strict';
const path = require('path');
const WEB = path.join(__dirname, '..', 'apps/web/js');
global.window = global;
require(WEB + '/engine.js');
const E = global.Engine;
if (!E || typeof E.categoryMembers !== 'function') {
  console.error('FAIL: Engine.categoryMembers missing'); process.exit(1);
}

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; }
  else { fail++; console.error('FAIL:', name, extra === undefined ? '' : JSON.stringify(extra)); }
}

function row(id, o) {
  return Object.assign({
    id: id, merchantRaw: 'MERCHANT', desc: 'MERCHANT', amountMinor: 100,
    kind: 'purchase', category: '', date: '2026-09-10', statementId: 'st-1',
    split: null, excluded: 0, status: 'active', splits: null
  }, o);
}

/* Fictional fixture month. */
const rows = [
  row('t1', { merchantRaw: 'FRESHCART MARKET', desc: 'FRESHCART MARKET', amountMinor: 10000, category: 'groceries' }),
  row('t2', { merchantRaw: 'FRESHCART MARKET', desc: 'FRESHCART MARKET', amountMinor: 5000, category: 'groceries' }),
  row('t3', { merchantRaw: 'FRESHCART MARKET', desc: 'FRESHCART MARKET', amountMinor: -2000, kind: 'refund', category: 'groceries' }),
  row('t4', { merchantRaw: 'BIGBOX STORES', desc: 'BIGBOX STORES', amountMinor: 9000, category: 'groceries',
    splits: [{ category: 'groceries', amountMinor: 6000 }, { category: 'dining', amountMinor: 3000 }] }),
  row('t5', { merchantRaw: 'FRESHCART MARKET', desc: 'FRESHCART MARKET', amountMinor: 2500, category: 'groceries', excluded: 1 }),
  row('t6', { merchantRaw: 'FRESHCART MARKET', desc: 'FRESHCART MARKET', amountMinor: 4000, category: 'groceries', status: 'duplicate', excluded: 1 }),
  row('t7', { merchantRaw: 'NOVA BEANS', desc: 'NOVA BEANS', amountMinor: 1500, category: '' }),
  row('t8', { merchantRaw: 'CARD PAYMENT', desc: 'CARD PAYMENT', amountMinor: -20000, kind: 'payment', category: 'groceries' })
];

const mem = E.categoryMembers(rows, 'groceries');
ok(Array.isArray(mem), 'categoryMembers returns an array');
ok(mem.map(m => m.txn.id).join(',') === 't1,t2,t3,t4',
   'groceries members are exactly the contributing rows (no excluded/dup/payment)', mem.map(m => m.txn.id));
const gsum = mem.reduce((s, m) => s + m.shareMinor, 0);
ok(gsum === 19000, 'groceries shares sum to 19000 (100+50-20+60)', gsum);

const cat = E.totalsByCategory(rows);
ok(cat.totals.groceries === 19000, 'totalsByCategory groceries matches the member sum', cat.totals.groceries);
ok(cat.totals.dining === 3000, 'totalsByCategory dining is the split share', cat.totals.dining);
ok(cat.totals['NOVA BEANS'] === 1500, 'uncategorized key is the merchant name', cat.totals['NOVA BEANS']);

/* Sweep: for every category key, member shares sum to the bar total. */
Object.keys(cat.totals).forEach(k => {
  const ms = E.categoryMembers(rows, k);
  const sum = ms.reduce((s, m) => s + m.shareMinor, 0);
  ok(sum === cat.totals[k], 'members add up to the bar total: ' + k, { sum, total: cat.totals[k] });
});

const dining = E.categoryMembers(rows, 'dining');
ok(dining.length === 1 && dining[0].txn.id === 't4' && dining[0].shareMinor === 3000,
   'split share lands in each touched category', dining);

const beans = E.categoryMembers(rows, 'NOVA BEANS');
ok(beans.length === 1 && beans[0].txn.id === 't7',
   'merchant-name key drill-down finds the uncategorized row', beans.map(m => m.txn.id));

ok(E.categoryMembers(rows, 'no-such-category').length === 0, 'unknown key -> empty list');

const ids = mem.map(m => m.txn.id);
ok(ids.indexOf('t5') === -1 && ids.indexOf('t6') === -1,
   'excluded and duplicate rows never appear in the drill-down');
ok(ids.indexOf('t8') === -1, 'payment rows never appear in the drill-down');

ok(typeof E.categoryKeyFor === 'function', 'Engine.categoryKeyFor is exposed');
ok(E.categoryKeyFor(row('x', { category: '' , merchantRaw: 'NOVA BEANS' })) === 'NOVA BEANS',
   'categoryKeyFor falls back to the merchant name');

console.log(`home-drilldown: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
