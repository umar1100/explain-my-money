/* Home/Month cross-view consistency (v16): the real app.js rendering over the
   fictional June-2026 fixture (tests/fixtures/june2026-v16.js) must show ONE
   set of numbers everywhere:
     hero net == sum of category bars == briefing headline == per-account
     total == receipt-coverage denominator's month gross.
   Also: no-baseline movers show no fabricated deltas; with a May baseline
   they show real up/down deltas. In-memory Store shim + minimal DOM stub,
   no network. Run with node. */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'apps/web/js');
const J = require('./fixtures/june2026-v16.js');
const EXP = J.EXPECTED;

/* ---------- minimal DOM stub ---------- */
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

/* ---------- in-memory Store shim ---------- */
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
  async wipeAll() { for (const k of Object.keys(memDB)) memDB[k] = {}; },
};

require(WEB + '/engine.js');
require(WEB + '/app.js');
const E = global.Engine, App = global.App;

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; }
  else { fail++; console.error('FAIL:', name, extra === undefined ? '' : JSON.stringify(extra)); }
}
function money(minor) { return '$' + (minor / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

async function seedJune() {
  await Store.wipeAll();
  await Store.put('statements', J.juneStatement());
  for (const t of J.juneTxns()) await Store.put('txns', t);
  App.state.month = '2026-06';
}

async function main() {
  /* ---------- Phase 1: June only (no May baseline) ---------- */
  await seedJune();
  const ctx = await App.monthContext();
  ok(ctx && ctx.month === '2026-06', 'monthContext resolves June 2026', ctx && ctx.month);

  // Hero: one net number, with the gross/refund build-up.
  const hero = App.headlineHtml(ctx);
  ok(hero.indexOf(money(EXP.netMinor)) !== -1, 'hero shows canonical net $14,951.02');
  ok(hero.indexOf(money(EXP.grossMinor) + ' purchases') !== -1, 'hero purchases line = canonical gross $15,749.43', hero.slice(0, 400));
  ok(hero.indexOf(money(EXP.oldSignedHeroMinor)) === -1, 'hero does NOT show the old signed-sum $8,209.44');
  ok(hero.indexOf('-$') === -1, 'hero has no negative labeled totals');

  // Category bars: the same five figures, summing exactly to the hero net.
  const cats = App.homeCategoriesHtml(ctx);
  for (const k of Object.keys(EXP.bars)) {
    ok(cats.indexOf(money(EXP.bars[k])) !== -1, 'category card shows ' + k + ' ' + money(EXP.bars[k]));
  }
  const engBars = E.totalsByCategory(ctx.mTxns).totals;
  const barSum = Object.keys(engBars).reduce((s, k) => s + engBars[k], 0);
  ok(barSum === ctx.recon.netSpendMinor, 'category bars sum EXACTLY to hero net', { barSum: barSum, hero: ctx.recon.netSpendMinor });

  // Briefing: same headline as the hero, magnitudes only.
  ok(ctx.briefingText.indexOf('-$') === -1, 'briefing text has no -$');
  ok(ctx.headline === ctx.briefingText.split('\n')[0], 'home headline == briefing first line');
  ok(ctx.headline.indexOf(money(EXP.netMinor)) !== -1, 'headline carries canonical net');

  // Receipt coverage: denominator is the month's canonical gross.
  ok(ctx.cov && ctx.cov.grossMinor === EXP.grossMinor, 'receipt denominator == canonical gross $15,749.43', ctx.cov);

  // Per-account breakdown agrees with the hero (single account, no attribution).
  ok(ctx.contributors.length === 1, 'one contributing statement', ctx.contributors.length);
  ok(ctx.contributors[0].netMinor === ctx.recon.netSpendMinor, 'per-account net == hero net',
    { acct: ctx.contributors[0].netMinor, hero: ctx.recon.netSpendMinor });

  // Month details reconciliation strip: gross - refunds = net.
  const details = await App.monthDetailsHtml(ctx);
  ok(details.indexOf(money(EXP.grossMinor)) !== -1, 'details strip shows gross $15,749.43');
  ok(details.indexOf(money(EXP.refundsMinor)) !== -1, 'details strip shows refunds $798.41');
  ok(details.indexOf(money(EXP.netMinor)) !== -1, 'details strip shows net $14,951.02');

  // Movers with NO May data: no fabricated deltas.
  const moversNoBase = await App.moversHtml('2026-06');
  ok(moversNoBase.indexOf('No May 2026 data to compare against yet.') !== -1, 'movers say no baseline exists');
  ok(moversNoBase.indexOf('up $') === -1 && moversNoBase.indexOf('down $') === -1, 'movers show no fabricated deltas');

  /* ---------- Phase 2: add a May baseline, movers must be real ---------- */
  let mseq = 0;
  function mayT(o) {
    return Object.assign({
      id: 'may' + (++mseq), merchantRaw: 'FICTIONAL', amountMinor: 100,
      kind: 'purchase', category: 'other', date: '2026-05-15', statementId: 'st-may',
      excluded: 0, status: 'active',
    }, o);
  }
  await Store.put('statements', {
    id: 'st-may', name: 'May 2026', accountLabel: 'Main Visa ••4242', parser: 'fixture',
    createdAt: Date.now() - 1000, periodStart: '2026-05-01', periodEnd: '2026-05-31', txnCount: 4,
  });
  // May: shopping net $18,500.00, groceries $1,000.00, other $500.00 (all PDF-style positive).
  await Store.put('txns', mayT({ merchantRaw: 'BIGBOX ONLINE', amountMinor: 2000000, category: 'shopping', date: '2026-05-10' }));
  await Store.put('txns', mayT({ merchantRaw: 'BIGBOX ONLINE REFUND', amountMinor: -150000, category: 'shopping', date: '2026-05-20', kind: 'refund' }));
  await Store.put('txns', mayT({ merchantRaw: 'FRESHCART', amountMinor: 100000, category: 'groceries', date: '2026-05-12' }));
  await Store.put('txns', mayT({ merchantRaw: 'CITY PARKING', amountMinor: 50000, category: 'other', date: '2026-05-14' }));
  App.state.month = '2026-06';
  const movers = await App.moversHtml('2026-06');
  ok(movers.indexOf('No May 2026 data') === -1, 'movers no longer claim missing baseline');
  // shopping: 1,162,807 vs 1,850,000 -> down $6,871.93 ; other: 208,894 vs 50,000 -> up $1,588.94
  ok(movers.indexOf('down $6,871.93') !== -1, 'movers: shopping down $6,871.93 (net of refunds)', movers.slice(0, 600));
  ok(movers.indexOf('up $1,588.94') !== -1, 'movers: other up $1,588.94');
  ok(movers.indexOf('down $414.24') !== -1, 'movers: groceries down $414.24 (net of refunds)');

  // June hero is unchanged by May's arrival (month-scoped math).
  const ctx2 = await App.monthContext();
  ok(ctx2.recon.netSpendMinor === EXP.netMinor, 'June hero net unchanged with May present', ctx2.recon.netSpendMinor);

  console.log('\nHOME-CONSISTENCY-V16: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
