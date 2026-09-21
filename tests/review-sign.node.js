/* Review-sign regression tests: the review sign must flag genuinely uncertain
   rows — unknown kind, read errors, uncertain heuristic reads, or spend with
   no category — and NOT every default-classified purchase. Before this fix,
   Engine.classifyBuiltin stamped confidence 'needs_review' (kindConfidence
   0.6) on every ordinary purchase, and the UI treated that band as the review
   trigger, so literally every transaction showed the review sign.
   Real engine.js + app.js, minimal DOM stub, no network. Run with node. */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'apps/web/js');

/* ---------- minimal DOM stub (app.js touches document at load) ---------- */
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

require(WEB + '/engine.js');
require(WEB + '/app.js');
const E = global.Engine, App = global.App;

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; }
  else { fail++; console.error('FAIL:', name, extra === undefined ? '' : JSON.stringify(extra)); }
}

function base(over) {
  return Object.assign({
    id: 'x', date: '2026-08-17', amountMinor: 1865,
    merchantRaw: "JEROME & ALISHA'S NOFR AJAX ON",
    kind: 'purchase', kindConfidence: 0.6, confidence: 'needs_review',
    excluded: 0, status: 'new',
  }, over);
}

/* ---------- 1. Engine.rowNeedsReview predicate ---------- */
ok(E.rowNeedsReview(base({ category: 'groceries' })) === false,
   'categorized default purchase: no review');
ok(E.rowNeedsReview(base({})) === true,
   'uncategorized default purchase: review (never-guess)');
ok(E.rowNeedsReview(base({ kind: 'uncertain', kindConfidence: 0.4 })) === true,
   'uncertain kind: review');
ok(E.rowNeedsReview(base({ kindConfidence: 0.4, category: 'groceries' })) === true,
   'heuristic-uncertain read (0.4) with category: still review');
ok(E.rowNeedsReview(base({ kind: 'payment', kindConfidence: 0.9, confidence: 'likely' })) === false,
   'confident payment: no review');
ok(E.rowNeedsReview(base({ _error: true })) === true,
   'parse error: review');
ok(E.rowNeedsReview(base({ excluded: 1 })) === false,
   'excluded row: no review');
ok(E.rowNeedsReview(base({ kind: 'refund', category: 'groceries' })) === false,
   'categorized refund: no review');
ok(E.rowNeedsReview(base({ kind: 'refund' })) === true,
   'uncategorized refund: review');

/* ---------- 2. App.needsReview is the same predicate ---------- */
ok(App.needsReview(base({ category: 'groceries' })) === false, 'App: categorized purchase clear');
ok(App.needsReview(base({})) === true, 'App: uncategorized purchase flagged');
ok(App.needsReview(base({ kind: 'uncertain', kindConfidence: 0.4 })) === true, 'App: uncertain flagged');

/* ---------- 3. reconcile unresolvedCount counts only true review rows ---------- */
const recon = E.reconcile([
  base({ id: 'a', category: 'groceries' }),                       // clear
  base({ id: 'b' }),                                             // no category -> review
  base({ id: 'c', kind: 'uncertain', kindConfidence: 0.4 }),      // uncertain -> review
  base({ id: 'd', kind: 'payment', kindConfidence: 0.9, confidence: 'likely' }), // clear
], null);
ok(recon.unresolvedCount === 2, 'reconcile counts only genuine review rows', recon.unresolvedCount);

/* ---------- 4. App.reviewTxns: only review rows, deduped ---------- */
const q = App.reviewTxns([
  base({ id: 'a', category: 'groceries' }),
  base({ id: 'b' }),
  base({ id: 'b' }),
  base({ id: 'c', kind: 'uncertain', kindConfidence: 0.4 }),
]);
ok(q.length === 2 && q[0].id === 'b' && q[1].id === 'c',
   'reviewTxns returns only review rows, deduped', q.map(function (t) { return t.id; }));

/* ---------- 5. Row HTML: the review sign ---------- */
const htmlClear = App.txnRowHtml(base({ id: 'a', category: 'groceries' }));
ok(htmlClear.indexOf('>review<') === -1,
   'categorized default purchase shows NO review sign', htmlClear);
const htmlUnc = App.txnRowHtml(base({ id: 'c', kind: 'uncertain', kindConfidence: 0.4 }));
ok(htmlUnc.indexOf('>review<') !== -1, 'uncertain row shows review sign');
const htmlNoCat = App.txnRowHtml(base({ id: 'b' }));
ok(htmlNoCat.indexOf('>no category<') !== -1, 'uncategorized row shows no-category sign');
const htmlHeu = App.txnRowHtml(base({ id: 'd', kindConfidence: 0.4, category: 'groceries' }));
ok(htmlHeu.indexOf('>review<') !== -1, 'heuristic-uncertain row shows review sign');

/* ---------- 6. End-to-end: NOFR auto-categorized -> no review sign ---------- */
const rows = [{
  id: 't1', date: '2026-08-17', amountMinor: 1865,
  merchantRaw: "JEROME & ALISHA'S NOFR AJAX ON", excluded: 0,
}];
E.classifyRows(rows, []);
E.autoCategorize(rows, []);
ok(rows[0].category === 'groceries', 'NOFR auto-categorized to groceries', rows[0].category);
ok(rows[0].confidence === 'needs_review', 'kind band still needs_review (0.6 default)');
ok(App.needsReview(rows[0]) === false,
   'auto-categorized NOFR row: NO review sign (the reported bug)');
ok(App.reviewTxns(rows).length === 0, 'review queue empty for resolved row');

/* ---------- 7. Headline regression: 25 ordinary resolved purchases -> empty queue ---------- */
const many = [];
for (let i = 0; i < 25; i++) {
  many.push({
    id: 'm' + i, date: '2026-08-' + String(1 + (i % 27)).padStart(2, '0'),
    amountMinor: 1000 + i * 37, merchantRaw: 'MERCHANT ' + i, excluded: 0,
  });
}
E.classifyRows(many, []);
E.autoCategorize(many, []);
// merchants unknown to the category rules stay uncategorized -> they DO need review
const unknownStillFlagged = many.filter(function (t) { return App.needsReview(t); });
ok(unknownStillFlagged.length === many.length,
   'unknown merchants stay in review (never-guess preserved)', unknownStillFlagged.length);
// but once a category exists, the sign clears
many.forEach(function (t, i) { t.category = (i % 2 ? 'groceries' : 'dining'); });
ok(App.reviewTxns(many).length === 0,
   '25 resolved purchases -> empty review queue (bug: all were flagged)');

console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
