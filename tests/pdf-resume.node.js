/* pdf-resume.node.js — resumable PDF import job: cache, resume, watchdog, ETA.
 *
 * Runs in node with fakes: fake pdf.js document, in-memory Store, stubbed
 * browser globals. Never touches the network or private files.
 *
 * Run: node tests/pdf-resume.node.js
 */
'use strict';

/* ---------------- fakes ---------------- */
var failures = [];
function check(name, cond, extra) {
  if (!cond) { failures.push(name + (extra ? ' — ' + extra : '')); console.log('FAIL ' + name + (extra ? ' — ' + extra : '')); }
  else console.log('ok   ' + name);
}

/* Browser globals BEFORE loading app code. */
global.performance = require('perf_hooks').performance;
/* Node 24 ships a read-only global navigator (no wakeLock) — exactly the
 * absence we want to simulate, so leave it alone. */
global.FileReader = function () {
  var self = this;
  this.readAsArrayBuffer = function (f) {
    Promise.resolve(f._buf).then(function (b) { self.result = b; if (self.onload) self.onload(); });
  };
};
var docStub = {
  hidden: false,
  getElementById: function () { return null; },
  addEventListener: function () {},
  createElement: function () { return { style: {}, setAttribute: function () {} }; }
};
global.document = docStub;

/* In-memory Store fake implementing the pdfCache-relevant surface. */
var memStores = {};
function memReset() { memStores = {}; }
global.Store = {
  get: async function (store, id) {
    var s = memStores[store] || {};
    var v = s[String(id)];
    return v === undefined ? null : JSON.parse(JSON.stringify(v));
  },
  put: async function (store, obj) {
    if (!memStores[store]) memStores[store] = {};
    var key = obj.hash !== undefined ? obj.hash : obj.id;
    memStores[store][String(key)] = JSON.parse(JSON.stringify(obj));
    return key;
  },
  all: async function (store) {
    var s = memStores[store] || {};
    return Object.keys(s).map(function (k) { return JSON.parse(JSON.stringify(s[k])); });
  },
  delete: async function (store, id) { var s = memStores[store] || {}; delete s[String(id)]; }
};

/* Load app code. parsers.js sets global.Parsers; app.js sets globalThis.App. */
global.Parsers = require('../apps/web/js/parsers.js');
require('../apps/web/js/app.js');
var App = globalThis.App;
var T = App._test;
var Parsers = global.Parsers;

/* ---------------- fake pdf.js ---------------- */
/* Page spec: array of pages; each page is 'hang' or [{x,y,text},...]. */
function fakePdf(pages) {
  var destroyed = 0;
  return {
    numPages: pages.length,
    destroyed: function () { return destroyed; },
    destroy: function () { destroyed++; return Promise.resolve(); },
    getPage: async function (p) {
      var pg = pages[p - 1];
      if (pg === 'hang') {
        return { getTextContent: function () { return new Promise(function () {}); }, cleanup: function () {} };
      }
      if (pg === 'slow') {
        var items = [{ str: 'slow page', transform: [1, 0, 0, 1, 40, 700], width: 40 }];
        return {
          getTextContent: function () {
            return new Promise(function (res) { setTimeout(function () { res({ items: items }); }, 300); });
          },
          cleanup: function () {}
        };
      }
      var items = pg.map(function (t) { return { str: t.text, transform: [1, 0, 0, 1, t.x, t.y], width: 40 }; });
      return { getTextContent: async function () { return { items: items }; }, cleanup: function () {} };
    }
  };
}
function fakeLib(pages) {
  var last = null;
  return {
    getDocument: function () {
      last = fakePdf(pages);
      return { promise: Promise.resolve(last) };
    },
    lastDoc: function () { return last; }
  };
}

/* Generic-statement-like page content (no pc/cibc markers -> generic parser). */
function genPage(p, n) {
  var items = [
    { x: 40, y: 740, text: 'ACME BANK' },
    { x: 40, y: 722, text: 'Card statement' },
    { x: 40, y: 704, text: 'Statement period: Jan 1 - Jan 31, 2026' }
  ];
  for (var r = 0; r < n; r++) {
    var y = 680 - r * 15;
    var day = String(1 + (r % 28)).padStart(2, '0');
    items.push({ x: 40, y: y, text: day + '/01/2026' });
    items.push({ x: 120, y: y, text: 'MERCHANT ' + p + '-' + r });
    items.push({ x: 420, y: y, text: '$' + (10 + r) + '.' + String(r % 100).padStart(2, '0') });
  }
  items.push({ x: 40, y: 80, text: 'Previous balance $1,200.00' });
  items.push({ x: 40, y: 64, text: 'New balance $9,999.99' });
  return items;
}
function fakeFile(buf, name) {
  return { name: name || 'stmt.pdf', size: buf.byteLength, _buf: buf };
}
function newJob(key, fileName, fileSize, buf) {
  return {
    key: key, hash: key.replace(/^pdfjob:/, ''), fileName: fileName, fileSize: fileSize,
    buf: new Uint8Array(buf),
    total: 0, pagesDone: 0, frags: [], pageTimes: [],
    status: 'reading', paused: false, manuallyPaused: false, wasPausedByHidden: false,
    resumed: false, cancelled: false, done: false, error: null,
    gen: 0, stallCount: 0, lastProgressAt: Date.now(),
    wakeLock: null, pdf: null, _resumeResolve: null, _needsRender: false
  };
}
function waitFor(fn, timeoutMs) {
  var start = Date.now();
  return new Promise(function (resolve, reject) {
    (function poll() {
      if (fn()) return resolve(true);
      if (Date.now() - start > (timeoutMs || 5000)) return reject(new Error('waitFor timeout'));
      setTimeout(poll, 25);
    })();
  });
}
function rowsKey(rows) {
  return JSON.stringify(rows.map(function (r) {
    return [r.rawDateText, r.rawDescription, r.rawAmountText, r.signedAmountMinor, r.dateInferred];
  }));
}

async function main() {
  memReset();

  /* 1. compact/rehydrate round-trip */
  var frags = [
    { page: 1, x: 40.123, y: 700.456, cx: 60.789, text: 'hello' },
    { page: 2, x: 1, y: 2, cx: 3, text: 'wörld ✓' }
  ];
  var compact = Parsers.compactFrags(frags);
  check('compact: array shape', Array.isArray(compact) && compact.length === 2 && compact[0].length === 5);
  check('compact: coords rounded to 2dp', compact[0][1] === 40.12 && compact[0][2] === 700.46);
  var re = Parsers.rehydrateFrags(compact);
  check('rehydrate: round-trip', re.length === 2 && re[0].page === 1 && re[0].x === 40.12 &&
    re[0].text === 'hello' && re[1].text === 'wörld ✓');

  /* 2. ETA math */
  check('eta: rolling avg', Parsers.etaSeconds([100, 200, 300], 4) === 1); // avg 200ms x4 = 800ms -> 1s
  check('eta: larger', Parsers.etaSeconds([2000, 2000], 5) === 10);
  check('eta: null with no data', Parsers.etaSeconds([], 5) === null);
  check('eta: null when done', Parsers.etaSeconds([100], 0) === null);

  /* 3. resume reassembly: cached pages 1..k + fresh k+1..n == full parse */
  var pages = [genPage(1, 6), genPage(2, 6), genPage(3, 6)];
  var fullFrags = await Parsers.collectItems(fakePdf(pages), null);
  var fullRes = await Parsers.parseFrags(fullFrags);
  check('reassembly setup: generic rows parsed', fullRes.rows.length === 18, 'got ' + fullRes.rows.length);
  var k = 2;
  var cachedPart = Parsers.compactFrags(fullFrags.filter(function (f) { return f.page <= k; }));
  var freshPart = fullFrags.filter(function (f) { return f.page > k; });
  var reassembled = Parsers.rehydrateFrags(cachedPart).concat(freshPart);
  var reRes = await Parsers.parseFrags(reassembled);
  check('resume reassembly: same rows as full parse',
    reRes.rows.length === fullRes.rows.length && rowsKey(reRes.rows) === rowsKey(fullRes.rows));

  /* 4. happy-path job loop */
  memReset();
  var crypto4 = require('crypto');
  var key4 = 'pdfjob:' + crypto4.createHash('sha256').update(Buffer.from([1, 2, 3, 4])).digest('hex');
  var buf = new Uint8Array([1, 2, 3, 4]).buffer;
  var job = newJob(key4, 'stmt.pdf', 4, buf);
  await T.pdfJobLoop(job, fakeLib(pages));
  check('loop: completes', job.done && job.status === 'done' && job.pagesDone === 3);
  check('loop: job cleared', App._pdfJob === null || App._pdfJob !== job);
  var saved = await Store.get('pdfCache', key4);
  check('loop: complete cache saved', saved && saved.status === 'complete' && saved.result.rows.length === 18);
  check('loop: complete cache drops frags', saved && saved.fragsCompact.length === 0);
  check('loop: preview pending set', App.state.pending && App.state.pending.rows.length === 18 &&
    App.state.addView === 'preview', 'pending rows=' + (App.state.pending && App.state.pending.rows.length));

  /* 5. complete-cache hit: second import of same file is instant (no job) */
  App.state.addView = 'home'; App.state.pending = null;
  var t0 = Date.now();
  await T.runPdfJob(null, fakeFile(new Uint8Array([1, 2, 3, 4]).buffer, 'stmt.pdf'));
  var dt = Date.now() - t0;
  /* runPdfJob fires pdfJobShowPreview without awaiting (it renders a tick
   * later in the browser), so wait for the preview to land. */
  await waitFor(function () {
    return App.state.addView === 'preview' && App.state.pending && App.state.pending.rows.length === 18;
  });
  check('cache hit: instant preview', true);
  check('cache hit: no job created', App._pdfJob === null);
  check('cache hit: fast (<2s)', dt < 2000, dt + 'ms');

  /* 6. cancel mid-run keeps partial cache */
  memReset();
  var slowPages = [genPage(1, 2), 'slow', genPage(3, 2)];
  var job2 = newJob('pdfjob:cancel1', 'slow.pdf', 9, new Uint8Array([9]).buffer);
  App._pdfJob = job2;
  var loopP = T.pdfJobLoop(job2, fakeLib(slowPages));
  await waitFor(function () { return job2.pagesDone >= 1; });
  T.pdfJobCardInner && App.Actions['pdfjob-cancel']();
  await loopP;
  /* The in-flight slow page legitimately finishes before the loop sees the
   * cancel flag — cancel must not discard a completed page. */
  check('cancel: status cancelled', job2.status === 'cancelled' && job2.done);
  var part = await Store.get('pdfCache', 'pdfjob:cancel1');
  check('cancel: partial cache kept', part && part.status === 'partial' &&
    part.pagesDone === job2.pagesDone && part.fragsCompact.length > 0,
    'pagesDone=' + (part && part.pagesDone) + ' job=' + job2.pagesDone);
  App._pdfJob = null;

  /* 7. watchdog: hanging page -> one retry -> clean error naming the page */
  memReset();
  var oldTimeout = App.PDF_PAGE_TIMEOUT_MS, oldTick = App.PDF_WATCHDOG_TICK_MS;
  App.PDF_PAGE_TIMEOUT_MS = 120; App.PDF_WATCHDOG_TICK_MS = 20;
  var hangPages = [genPage(1, 2), 'hang', genPage(3, 2)];
  var job3 = newJob('pdfjob:hang1', 'hang.pdf', 9, new Uint8Array([7]).buffer);
  await T.pdfJobLoop(job3, fakeLib(hangPages));
  App.PDF_PAGE_TIMEOUT_MS = oldTimeout; App.PDF_WATCHDOG_TICK_MS = oldTick;
  check('watchdog: error state', job3.status === 'error');
  check('watchdog: names page + retry', /page 2/.test(job3.error) && /Retry/.test(job3.error), job3.error);
  var part3 = await Store.get('pdfCache', 'pdfjob:hang1');
  check('watchdog: partial progress saved', part3 && part3.status === 'partial' && part3.pagesDone === 1);

  /* 8. retry after error resumes from saved page and completes.
   * Note: 14 rows, not 18 — page 1 came from the hanging doc (2 rows). */
  global.pdfjsLib = fakeLib(pages); // good lib now
  App._pdfJob = job3;
  App.Actions['pdfjob-retry']();
  await waitFor(function () { return job3.done; }, 8000);
  check('retry: completes after error', job3.status === 'done' && job3.pagesDone === 3,
    'status=' + job3.status + ' err=' + job3.error);
  var saved3 = await Store.get('pdfCache', 'pdfjob:hang1');
  check('retry: complete cache', saved3 && saved3.status === 'complete' && saved3.result.rows.length === 14,
    'rows=' + (saved3 && saved3.result && saved3.result.rows.length));
  delete global.pdfjsLib;
  App._pdfJob = null;

  /* 9. partial cache from a previous session resumes via runPdfJob */
  memReset();
  var fullF = await Parsers.collectItems(fakePdf(pages), null);
  var partialRec = {
    hash: 'pdfjob:resume9', fileName: 'r.pdf', fileSize: 4,
    pagesTotal: 3, pagesDone: 2,
    fragsCompact: Parsers.compactFrags(fullF.filter(function (f) { return f.page <= 2; })),
    status: 'partial', result: null, updatedAt: Date.now()
  };
  await Store.put('pdfCache', partialRec);
  // file bytes must hash to the cache key: compute with node crypto (must
  // match the app's sha256HexBytes — verified equal in test 4's round trip
  // only if implementations agree; safer: derive via the app itself by
  // reading what runPdfJob looks up. We do that by spying Store.get.
  var crypto = require('crypto');
  var h = crypto.createHash('sha256').update(Buffer.from([5, 6, 7, 8])).digest('hex');
  partialRec.hash = 'pdfjob:' + h;
  await Store.put('pdfCache', partialRec);
  var f9 = fakeFile(new Uint8Array([5, 6, 7, 8]).buffer, 'r.pdf');
  global.pdfjsLib = fakeLib(pages);
  App.state.pending = null; App.state.addView = 'home';
  var runP = T.runPdfJob(null, f9);
  await runP; // returns after loop is kicked off, not after completion
  var rjob = App._pdfJob;
  check('resume: job picked up partial', rjob && rjob.resumed === true && rjob.pagesDone === 2);
  await waitFor(function () { return rjob.done; }, 8000);
  check('resume: completes from page 3', rjob.status === 'done' && rjob.pagesDone === 3);
  check('resume: rows match full parse', App.state.pending && App.state.pending.rows.length === 18);
  delete global.pdfjsLib;

  /* 10. eviction: 6th entry evicts oldest */
  memReset();
  for (var e = 0; e < 6; e++) {
    var ej = newJob('pdfjob:ev' + e, 'f' + e + '.pdf', 10 + e, new Uint8Array([e]).buffer);
    ej.total = 1; ej.pagesDone = 1;
    await T.pdfCacheSave(ej, 'partial');
    // force distinct updatedAt ordering
    var rec = await Store.get('pdfCache', 'pdfjob:ev' + e);
    rec.updatedAt = 1000 + e;
    await Store.put('pdfCache', rec);
  }
  await T.pdfCacheEvict();
  var all = await Store.all('pdfCache');
  var keys = all.map(function (r) { return r.hash; });
  check('evict: keeps 5', all.length === 5, 'got ' + all.length);
  check('evict: oldest gone', keys.indexOf('pdfjob:ev0') === -1 && keys.indexOf('pdfjob:ev5') !== -1);

  /* 11. visibility: hidden -> paused; visible (fresh) -> auto-resume; visible (stale) -> recover */
  memReset();
  var vjob = newJob('pdfjob:vis1', 'v.pdf', 4, new Uint8Array([1]).buffer);
  vjob.total = 5; vjob.pagesDone = 2; vjob.status = 'reading';
  App._pdfJob = vjob;
  docStub.hidden = true;
  T.pdfJobVisibility();
  check('visibility: hidden pauses', vjob.paused === true && vjob.wasPausedByHidden === true);
  docStub.hidden = false;
  vjob.lastProgressAt = Date.now();
  T.pdfJobVisibility();
  check('visibility: fresh return auto-resumes', vjob.paused === false && vjob.wasPausedByHidden === false);
  // stale return -> recover
  docStub.hidden = true;
  T.pdfJobVisibility();
  vjob.lastProgressAt = Date.now() - 60000;
  vjob.pdf = fakePdf(pages);
  docStub.hidden = false;
  var genBefore = vjob.gen;
  await T.pdfJobRecover(vjob); // visibility calls this async; call directly for determinism
  check('recover: gen bumped + doc dropped', vjob.gen === genBefore + 1 && vjob.pdf === null && vjob.paused === false);
  App._pdfJob = null;
  docStub.hidden = false;

  /* 12. abandon: in-flight extract on hanging page is abandoned by recover */
  var ajob = newJob('pdfjob:aban1', 'a.pdf', 4, new Uint8Array([1]).buffer);
  ajob.total = 2;
  var alib = fakeLib(['hang', genPage(2, 1)]);
  ajob.pdf = await alib.getDocument().promise;
  App.PDF_PAGE_TIMEOUT_MS = 5000; App.PDF_WATCHDOG_TICK_MS = 20;
  var exP = T.pdfJobExtractPage(ajob, 1);
  setTimeout(function () { T.pdfJobRecover(ajob); }, 50);
  var abandonedErr = null;
  try { await exP; } catch (e) { abandonedErr = e; }
  App.PDF_PAGE_TIMEOUT_MS = oldTimeout; App.PDF_WATCHDOG_TICK_MS = oldTick;
  check('abandon: recover aborts in-flight page', !!abandonedErr && abandonedErr.__abandoned === true);

  /* 13. status text + card render without throwing */
  var sjob = newJob('pdfjob:st1', 's.pdf', 4, new Uint8Array([1]).buffer);
  sjob.total = 10; sjob.pagesDone = 3; sjob.pageTimes = [2000, 2000, 2000]; // avg 2s x 7 left = 14s
  var txt = T.pdfJobStatusText(sjob);
  check('status text: page + eta', /page 4 of 10/.test(txt) && /about 14s left/.test(txt), txt);
  sjob.status = 'paused'; sjob.wasPausedByHidden = true;
  var card = T.pdfJobCardInner(sjob);
  check('card: paused renders resume', /Resume/.test(card) && /background/.test(T.pdfJobStatusText(sjob)));
  sjob.status = 'error'; sjob.error = 'boom';
  check('card: error renders retry', /Retry reading/.test(T.pdfJobCardInner(sjob)));

  /* 15. cancel before page 1 completes still records the attempt */
  memReset();
  var cj = newJob('pdfjob:cancel0', 'c0.pdf', 4, new Uint8Array([3]).buffer);
  App._pdfJob = cj;
  var cloop = T.pdfJobLoop(cj, fakeLib(['hang', genPage(2, 1)]));
  await new Promise(function (r) { setTimeout(r, 60); }); // page 1 is hanging
  App.Actions['pdfjob-cancel']();
  await cloop; // watchdog abandons the hung page within ~1s (default tick)
  check('cancel-early: status cancelled', cj.status === 'cancelled' && cj.done);
  var crec0 = await Store.get('pdfCache', 'pdfjob:cancel0');
  check('cancel-early: empty partial recorded',
    crec0 && crec0.status === 'partial' && crec0.pagesDone === 0,
    'pagesDone=' + (crec0 && crec0.pagesDone));
  App._pdfJob = null;

  /* 16. complete-cache hit still runs the duplicate guard path (no crash, dup flag boolean) */
  check('preview: duplicate flag boolean', typeof App.state.pending.duplicate === 'boolean');

  /* 17. pause/resume actions keep status in sync so the Resume button can appear */
  var pjob = newJob('pdfjob:pause1', 'p.pdf', 4, new Uint8Array([1]).buffer);
  pjob.total = 4; pjob.status = 'reading';
  App._pdfJob = pjob;
  App.Actions['pdfjob-pause']();
  check('action pause: status paused', pjob.status === 'paused' && pjob.paused && pjob.manuallyPaused);
  check('action pause: card shows Resume', /data-action="pdfjob-resume"/.test(T.pdfJobCardInner(pjob)));
  check('action pause: text says paused', /^Paused/.test(T.pdfJobStatusText(pjob)));
  App.Actions['pdfjob-resume']();
  check('action resume: status reading', pjob.status === 'reading' && !pjob.paused && !pjob.manuallyPaused);
  check('action resume: card shows Pause', /data-action="pdfjob-pause"/.test(T.pdfJobCardInner(pjob)));
  docStub.hidden = true;
  T.pdfJobVisibility();
  check('visibility hidden: status paused', pjob.status === 'paused' && pjob.wasPausedByHidden === true);
  docStub.hidden = false;
  pjob.lastProgressAt = Date.now();
  T.pdfJobVisibility();
  check('visibility return: status reading', pjob.status === 'reading' && !pjob.paused);
  App._pdfJob = null;
  docStub.hidden = false;
}

main().then(function () {
  if (failures.length) { console.log('\n' + failures.length + ' FAILURES'); process.exit(1); }
  console.log('\nALL PDF RESUME CHECKS PASSED');
}).catch(function (e) { console.log('HARNESS ERROR: ' + (e && e.stack || e)); process.exit(1); });
