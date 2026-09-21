/* Statement-delete tests + Store blocked-open behavior.
   Real app.js (UI logic) with an in-memory Store shim; real store.js with a
   fake IndexedDB to exercise the EMM_BLOCKED path. Synthetic data only.
   No network. Run with node. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'apps/web/js');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.error('FAIL:', name, extra === undefined ? '' : JSON.stringify(extra)); }
}

/* ---------- minimal DOM stub (enough for app.js to load) ---------- */
function makeEl(tag) {
  const el = {
    tagName: (tag || 'div').toUpperCase(),
    children: [], dataset: {}, style: {},
    _innerHTML: '', value: '', files: null, type: '',
    id: '', className: '', isConnected: true, textContent: '',
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
  backend() { return 'local'; },
};
global.Store.open = async () => 'local';

require(WEB + '/engine.js');
require(WEB + '/app.js');
const App = global.App, T = App._test;

async function main() {
  console.log('== statement delete (synthetic)');
  // Two statements with txns, matches, refund links, allocations.
  const s1 = await global.Store.put('statements', { scopeLabel: 'Visa Aug', periodStart: '2026-08-01' });
  const s2 = await global.Store.put('statements', { scopeLabel: 'MC Aug', periodStart: '2026-08-01' });
  const t1a = await global.Store.put('txns', { statementId: s1, rawDescription: 'A1', amountMinor: 100 });
  const t1b = await global.Store.put('txns', { statementId: s1, rawDescription: 'A2', amountMinor: 200 });
  const t2a = await global.Store.put('txns', { statementId: s2, rawDescription: 'B1', amountMinor: 300 });
  const rc1 = await global.Store.put('receipts', { merchantRaw: 'SHOP' });
  const m1 = await global.Store.put('matches', { txnId: t1a, receiptId: rc1, score: 0.9 });   // -> deleted
  const m2 = await global.Store.put('matches', { txnId: t2a, receiptId: rc1, score: 0.8 });   // -> kept
  const l1 = await global.Store.put('refundLinks', { purchaseTxnId: t1b, refundTxnId: 'n/a' }); // -> deleted
  const l2 = await global.Store.put('refundLinks', { purchaseTxnId: t2a, refundTxnId: 'n/a' });  // -> kept
  const al1 = await global.Store.put('allocations', { txnId: t1a, categoryId: 'food', amountMinor: 100 }); // -> deleted
  const al2 = await global.Store.put('allocations', { txnId: t2a, categoryId: 'food', amountMinor: 300 }); // -> kept

  const res = await T.deleteStatement(s1);
  ok(res && res.txnCount === 2 && res.matchCount === 1, 'deleteStatement returns counts', res);

  ok((await global.Store.get('statements', s1)) === null, 'statement record removed');
  ok((await global.Store.all('statements')).length === 1, 'other statement untouched');
  const txns = await global.Store.all('txns');
  ok(txns.length === 1 && String(txns[0].id) === String(t2a), 'only other statement txns remain', txns.map(t => t.rawDescription));
  const matches = await global.Store.all('matches');
  ok(matches.length === 1 && String(matches[0].id) === String(m2), 'matches for deleted txns removed, others kept');
  const links = await global.Store.all('refundLinks');
  ok(links.length === 1 && String(links[0].id) === String(l2), 'refund links for deleted txns removed, others kept');
  const allocs = await global.Store.all('allocations');
  ok(allocs.length === 1 && String(allocs[0].id) === String(al2), 'allocations for deleted txns removed, others kept');
  const rcpts = await global.Store.all('receipts');
  ok(rcpts.length === 1, 'receipts are kept (not cascaded)');
  const audits = (await global.Store.all('auditEvents')).filter(e => e.eventType === 'statement.deleted');
  ok(audits.length === 1 && String(audits[0].entityId) === String(s1), 'statement.deleted audit entry written');

  const missing = await T.deleteStatement('nope');
  ok(missing === null, 'unknown statement id -> null');

  /* ---------- store.js: EMM_BLOCKED must not fork to localStorage ---------- */
  console.log('== store blocked-open behavior');
  function fakeReq(fire) {
    const req = {};
    setTimeout(() => { if (req[fire]) req[fire](); }, 0);
    return req;
  }
  const sandbox = { console };
  sandbox.window = sandbox; sandbox.global = sandbox; sandbox.self = sandbox;
  const _ls = {};
  sandbox.localStorage = {
    getItem: (k) => (k in _ls ? _ls[k] : null),
    setItem: (k, v) => { _ls[k] = String(v); },
    removeItem: (k) => { delete _ls[k]; },
  };
  // Case A: IndexedDB open fires onblocked -> Store.open rejects EMM_BLOCKED, no local fork.
  sandbox.indexedDB = { open: () => fakeReq('onblocked') };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(WEB, 'store.js'), 'utf8'), sandbox, { filename: 'store.js' });
  let blockedErr = null;
  try { await sandbox.Store.open(); } catch (e) { blockedErr = e; }
  ok(blockedErr && blockedErr.code === 'EMM_BLOCKED', 'blocked open rejects with EMM_BLOCKED', blockedErr && blockedErr.code);
  ok(sandbox.Store.backend() === null, 'blocked open does NOT fork to localStorage', sandbox.Store.backend());
  ok(/another tab/i.test(blockedErr && blockedErr.message || ''), 'blocked error message mentions another tab');

  // Case B: genuine IDB unavailability (indexedDB.open throws) -> localStorage fallback kept.
  const sandbox2 = { console };
  sandbox2.window = sandbox2; sandbox2.global = sandbox2; sandbox2.self = sandbox2;
  const _ls2 = {};
  sandbox2.localStorage = {
    getItem: (k) => (k in _ls2 ? _ls2[k] : null),
    setItem: (k, v) => { _ls2[k] = String(v); },
    removeItem: (k) => { delete _ls2[k]; },
  };
  sandbox2.indexedDB = { open: () => { throw new Error('denied'); } };
  vm.createContext(sandbox2);
  vm.runInContext(fs.readFileSync(path.join(WEB, 'store.js'), 'utf8'), sandbox2, { filename: 'store.js' });
  const be = await sandbox2.Store.open();
  ok(be === 'local' && sandbox2.Store.backend() === 'local', 'thrown open still falls back to localStorage');

  console.log(pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
