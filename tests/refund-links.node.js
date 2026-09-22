/* Refund-link import pipeline + Home attribution tests: real engine.js +
   app.js (UI logic) with an in-memory Store shim and a minimal DOM stub.
   No network. Run with node.

   Covers (fictional merchants only):
   - Chronological import (purchase statement, then refund statement):
     cross-statement suggested link is created.
   - Reverse import order (refund statement first, purchase statement
     second): the link is STILL created by the purchase-imported-later pass.
   - Same-statement: the most recent eligible purchase wins the link.
   - No duplicate links when later unrelated statements import.
   - Home monthContext: the hero headline and the per-account breakdown
     agree after cross-month return attribution.
   - Home hero + category-breakdown HTML builders render the right numbers.
*/
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'apps/web/js');

/* ---------- minimal DOM stub (subset of e2e.node.js) ---------- */
function makeEl(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    children: [], dataset: {}, style: {},
    _innerHTML: '', value: '', files: null, type: '',
    id: '', className: '',
    set innerHTML(h) { this._innerHTML = String(h); },
    get innerHTML() { return this._innerHTML; },
    setAttribute() {}, getAttribute() { return null; },
    appendChild(c) { this.children.push(c); return c; },
    insertBefore(c) { this.children.unshift(c); return c; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
    focus() {}, click() {}, remove() {}, closest() { return null; },
  };
  return el;
}
const viewEl = makeEl('div'); viewEl.id = 'view';
const elementsById = { view: viewEl };
global.document = {
  getElementById(id) { return elementsById[id] || null; },
  querySelector(sel) {
    if (sel === '#view') return viewEl;
    const m = /^#([\w-]+)$/.exec(sel);
    return m ? (elementsById[m[1]] || null) : null;
  },
  querySelectorAll() { return []; },
  createElement(tag) { return makeEl(tag); },
  addEventListener() {},
  body: makeEl('body'),
};
global.window = global;
global.CSS = { escape: (s) => String(s) };
global.URL = { createObjectURL: () => 'blob:stub' };
global.requestAnimationFrame = (fn) => setTimeout(fn, 0);

/* ---------- in-memory Store shim (same API semantics as store.js) ---------- */
const memDB = {};
let autoId = 1;
global.Store = {
  async put(store, obj) {
    memDB[store] = memDB[store] || {};
    obj = Object.assign({}, obj);
    if (obj.id === null || obj.id === undefined) obj.id = 'id' + (autoId++);
    memDB[store][String(obj.id)] = obj;
    return obj.id;
  },
  async get(store, id) {
    const t = memDB[store] || {};
    const r = t[String(id)];
    return r ? Object.assign({}, r) : null;
  },
  async all(store) {
    const t = memDB[store] || {};
    return Object.keys(t).map((k) => Object.assign({}, t[k]));
  },
  async query(store, index, value) {
    const t = memDB[store] || {};
    return Object.keys(t).map((k) => Object.assign({}, t[k]))
      .filter((r) => String(r[index]) === String(value));
  },
  async delete(store, id) { const t = memDB[store] || {}; delete t[String(id)]; },
  async logAudit(eventType, entityType, entityId, details) {
    return this.put('auditEvents', { eventType, entityType, entityId, details, timestamp: Date.now() });
  },
  async wipeAll() { for (const k of Object.keys(memDB)) memDB[k] = {}; },
  async exportAll() {
    const out = {};
    for (const k of Object.keys(memDB)) out[k] = await this.all(k);
    return out;
  },
};

/* ---------- load real engine + app ---------- */
global.window = global;
require(WEB + '/engine.js');
require(WEB + '/app.js');
const E = global.Engine, App = global.App;

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; }
  else { fail++; console.error('FAIL:', name, extra === undefined ? '' : JSON.stringify(extra)); }
}

function txn(date, amountMinor, merchantRaw, kind) {
  return {
    date: date, amountMinor: amountMinor, merchantRaw: merchantRaw, kind: kind,
    excluded: 0, confidence: 'likely', category: null, status: 'new',
  };
}

async function commit(name, periodStart, periodEnd, txns) {
  await App.commitPipeline({
    fileName: name + '.csv', hash: 'hash-' + name, fileSize: 100,
    accountName: 'Test Card', last4: '9999',
    periodStart: periodStart, periodEnd: periodEnd,
    periodLabel: periodStart.slice(0, 7), scopeLabel: 'Test Card ' + periodStart.slice(0, 7),
    txns: txns, matchSuggestions: [], allocations: [], facts: null, briefingText: '',
  });
}

async function main() {
  /* --- 1. Chronological import: purchase statement, then refund statement --- */
  await Store.wipeAll();
  await commit('jul', '2026-07-01', '2026-07-31', [
    txn('2026-07-10', 5000, 'MAPLE BOOKS #42', 'purchase'),
  ]);
  await commit('aug', '2026-08-01', '2026-08-31', [
    txn('2026-08-05', -5000, 'MAPLE BOOKS #42', 'refund'),
  ]);
  let links = await Store.all('refundLinks');
  ok(links.length === 1, 'chronological import: one cross-statement link', links.length);
  ok(links[0] && links[0].status === 'suggested', 'link status is suggested', links[0] && links[0].status);

  const txns = await Store.all('txns');
  const adjJul = E.returnAdjustment(txns, links, '2026-07');
  ok(adjJul && adjJul.deltaMinor === -5000, 'July headline delta -5000 (refund attributed in)', adjJul);
  const adjAug = E.returnAdjustment(txns, links, '2026-08');
  ok(adjAug && adjAug.deltaMinor === 5000, 'August headline delta +5000 (refund moved out)', adjAug);

  /* --- 2. Reverse import order: refund statement first --- */
  await Store.wipeAll();
  await commit('aug2', '2026-08-01', '2026-08-31', [
    txn('2026-08-05', -7500, 'NORTHWIND OUTFITTERS', 'refund'),
  ]);
  let linksEarly = await Store.all('refundLinks');
  ok(linksEarly.length === 0, 'refund imported alone: no link yet (nothing to match)', linksEarly.length);
  await commit('jul2', '2026-07-01', '2026-07-31', [
    txn('2026-07-10', 7500, 'NORTHWIND OUTFITTERS', 'purchase'),
  ]);
  links = await Store.all('refundLinks');
  ok(links.length === 1, 'reverse import order: link created by purchase-imported-later pass', links.length);
  const txns2 = await Store.all('txns');
  const rf2 = txns2.find((t) => t.kind === 'refund');
  const pu2 = txns2.find((t) => t.kind === 'purchase');
  ok(String(links[0].refundTxnId) === String(rf2.id) &&
     String(links[0].purchaseTxnId) === String(pu2.id),
     'reverse link points at the right rows');
  const adjJul2 = E.returnAdjustment(txns2, links, '2026-07');
  ok(adjJul2 && adjJul2.deltaMinor === -7500, 'reverse order: July attribution still works', adjJul2);

  /* --- 3. Same-statement: most recent eligible purchase wins --- */
  await Store.wipeAll();
  await commit('sep', '2026-09-01', '2026-09-30', [
    txn('2026-09-02', 2000, 'HARBOUR GROCERS', 'purchase'),
    txn('2026-09-20', 2000, 'HARBOUR GROCERS', 'purchase'),
    txn('2026-09-25', -2000, 'HARBOUR GROCERS', 'refund'),
  ]);
  links = await Store.all('refundLinks');
  ok(links.length === 1, 'same-statement: exactly one link', links.length);
  const txns3 = await Store.all('txns');
  const linked3 = txns3.find((t) => String(t.id) === String(links[0].purchaseTxnId));
  ok(linked3 && linked3.date === '2026-09-20', 'same-statement: most recent purchase wins', linked3 && linked3.date);

  /* --- 4. No duplicates when a later unrelated statement imports --- */
  await commit('oct', '2026-10-01', '2026-10-31', [
    txn('2026-10-03', 999, 'UNRELATED MART', 'purchase'),
  ]);
  links = await Store.all('refundLinks');
  ok(links.length === 1, 'no duplicate links after unrelated import', links.length);

  /* --- 5. Home monthContext: headline and per-account breakdown agree --- */
  await Store.wipeAll();
  App.state.month = null;
  await commit('julA', '2026-07-01', '2026-07-31', [
    txn('2026-07-10', 10000, 'MAPLE BOOKS #42', 'purchase'),
  ]);
  await commit('augA', '2026-08-01', '2026-08-31', [
    txn('2026-08-05', -10000, 'MAPLE BOOKS #42', 'refund'),
    txn('2026-08-06', 5000, 'MAPLE BOOKS #42', 'purchase'),
  ]);

  App.state.month = '2026-07';
  const ctxJul = await App.monthContext();
  ok(ctxJul && ctxJul.recon.netSpendMinor === 0, 'July hero net = 0 after attribution', ctxJul && ctxJul.recon.netSpendMinor);
  ok(ctxJul.contributors.length === 1 && ctxJul.contributors[0].netMinor === 0,
     'July per-account breakdown = 0 (agrees with hero)', ctxJul && ctxJul.contributors.map((c) => c.netMinor));

  App.state.month = '2026-08';
  const ctxAug = await App.monthContext();
  // August: +5000 purchase, -10000 refund moved out -> net 5000.
  ok(ctxAug && ctxAug.recon.netSpendMinor === 5000, 'August hero net = 5000 (refund moved out)', ctxAug && ctxAug.recon.netSpendMinor);
  ok(ctxAug.contributors.length === 1 && ctxAug.contributors[0].netMinor === 5000,
     'August per-account breakdown = 5000 (agrees with hero)', ctxAug && ctxAug.contributors.map((c) => c.netMinor));
  ok(!!(ctxAug.recon.returnOutMinor), 'August hero carries the returnOut note', ctxAug && ctxAug.recon);

  /* --- 6. Home hero + category-breakdown HTML builders --- */
  // Self-consistent fixture: $100 gross, $18.65 received refunds, $50 moved
  // IN from later returns -> attributed refunds $68.65, net $31.35.
  const heroCtx = {
    month: '2026-08',
    recon: {
      grossPurchasesMinor: 10000, refundsTotalMinor: 1865, refundCount: 1,
      netSpendMinor: 3135, returnAdjMinor: -5000, returnOutMinor: 0,
    },
    headline: 'Engine first line.',
    mTxns: [],
  };
  const hero = App.headlineHtml(heroCtx);
  ok(hero.includes('$31.35'), 'hero shows net spend $31.35', hero.slice(0, 160));
  ok(hero.includes('$100.00') && hero.includes('$68.65'), 'hero shows purchases/attributed-refunds build-up', hero.slice(0, 400));
  ok(hero.includes('August 2026'), 'hero labels the month', hero.slice(0, 160));
  ok(hero.includes('from later returns counted here'),
     'hero explains the return attribution');

  const catCtx = {
    month: '2026-08',
    mTxns: [{ id: 'x1', merchantRaw: 'RCSS #1012', category: 'groceries', kind: 'purchase', date: '2026-08-21', amountMinor: 2600 }],
    drivers: [
      { category: 'groceries', totalMinor: 8000, txnCount: 3 },
      { category: 'dining', totalMinor: 4000, txnCount: 2 },
    ],
  };
  const cats = App.homeCategoriesHtml(catCtx);
  ok(cats.includes('Where it went'), 'categories section headed', cats.slice(0, 120));
  ok(cats.includes('Groceries') && cats.includes('Dining'), 'categories listed', cats.slice(0, 600));
  ok(cats.includes('$80.00') && cats.includes('$40.00'), 'category amounts shown', cats.slice(0, 900));
  ok(cats.includes('data-action="open-homecat"'), 'categories open the drill-down list');

  const emptyCats = App.homeCategoriesHtml({ month: '2026-08', mTxns: [], drivers: [] });
  ok(emptyCats.includes('No categorized spend'), 'empty drivers: quiet empty state');

  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
