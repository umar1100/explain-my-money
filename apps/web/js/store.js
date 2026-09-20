/* ============================================================================
 * store.js — "Explain My Money" Gate 1 prototype: on-device persistence
 * ----------------------------------------------------------------------------
 * Global `Store`, async API. Primary backend: IndexedDB ('emmdb', v1).
 * Fallback: localStorage (prefix 'emm_') with an IDENTICAL async API when
 * IndexedDB is unavailable (e.g. private-browsing edge cases, non-browser
 * test harnesses).
 *
 * PRIVACY INVARIANTS:
 *  - Data NEVER leaves the device. There is no sync, no fetch, no beacon,
 *    no telemetry anywhere in this file.
 *  - Store.exportAll() exists ONLY so the user can explicitly export their
 *    own data as JSON (user-initiated download in app.js). Nothing is sent
 *    anywhere.
 *  - Store.wipeAll() deletes everything on-device. The Privacy screen must
 *    confirm with the user BEFORE calling it.
 *
 * SCHEMA (v1). Entity/field names mirror the SQLite validation-harness
 * schema so the two implementations stay aligned:
 *   sourceFiles(id, sha256, fileName, importedAt, rowCount)
 *   accounts(id, name, type)
 *   statements(id, accountId, sourceFileId, periodStart, periodEnd,
 *              reportedStartMinor, reportedEndMinor, createdAt)
 *   txns(id, statementId, rawDateText, rawDescription, rawAmountText,
 *        rawCurrency, date, amountMinor, currency, merchantRaw, kind,
 *        kindConfidence, kindReason, classificationSource, category,
 *        spendAmountMinor, excluded, confidence, status, receiptId, _error)
 *     indexes: statementId, date, kind, status
 *   merchants(id, merchantRaw, displayName, defaultCategory)
 *   receipts(id, date, amountMinor, merchantRaw, createdAt)
 *   receiptLineItems(id, receiptId, description, amountMinor)
 *     index: receiptId
 *   matches(id, txnId, receiptId, score, reasons, status, createdAt)
 *   allocations(id, txnId, categoryId, amountMinor)
 *     index: txnId
 *   refundLinks(id, purchaseTxnId, refundTxnId, createdAt)
 *   categories(id, name, parentId)
 *   householdRules(id, enabled, priority, matchMerchant, kind, label,
 *                  source, createdAt)
 *   corrections(id, txnId, field, oldValue, newValue, createdAt)
 *   auditEvents(id, eventType, entityType, entityId, details, timestamp)
 *     index: timestamp
 *   briefings(id, periodStart, periodEnd, scopeLabel, factsJson, createdAt)
 *   qaEvidence(id, checkName, result, details, createdAt)
 *
 * SCHEMA (v2) additions (Phase 2: Plan tab):
 *   budgets(id, category, month 'YYYY-MM', limitMinor)
 *   goals(id, name, targetMinor, savedMinor, targetDate 'YYYY-MM-DD'|null,
 *         note, createdAt)
 *   prefs: natural-key store (keyPath 'key', NO autoIncrement).
 *     Holds single-value UI/app preferences, e.g. {key:'sub_dismissed_x', value:'1'}.
 *     Keys are arbitrary non-numeric strings; toKey() coerces numeric strings,
 *     so callers must use non-numeric keys.
 *
 * ES2019-compatible plain script: no modules, no bundler. Exposes global
 * `Store`. Load order in index.html: engine.js, store.js, app.js.
 * ========================================================================== */
(function () {
  'use strict';

  var Store = {};

  /** Schema version. Bump when object stores/indexes change (add migration). */
  Store.SCHEMA_VERSION = 2;
  Store.DB_NAME = 'emmdb';

  var LS_PREFIX = 'emm_';

  // Object-store definitions. Default keyPath is 'id' with autoIncrement;
  // a store may override with its own keyPath/autoIncrement (e.g. prefs).
  var STORES = {
    sourceFiles:      { indexes: [{ name: 'sha256', keyPath: 'sha256', unique: false }] },
    accounts:         { indexes: [] },
    statements:       { indexes: [] },
    txns:             { indexes: [
      { name: 'statementId', keyPath: 'statementId', unique: false },
      { name: 'date', keyPath: 'date', unique: false },
      { name: 'kind', keyPath: 'kind', unique: false },
      { name: 'status', keyPath: 'status', unique: false }
    ] },
    merchants:        { indexes: [] },
    receipts:         { indexes: [] },
    receiptLineItems: { indexes: [{ name: 'receiptId', keyPath: 'receiptId', unique: false }] },
    matches:          { indexes: [] },
    allocations:      { indexes: [{ name: 'txnId', keyPath: 'txnId', unique: false }] },
    refundLinks:      { indexes: [] },
    categories:       { indexes: [] },
    householdRules:   { indexes: [] },
    corrections:      { indexes: [] },
    auditEvents:      { indexes: [{ name: 'timestamp', keyPath: 'timestamp', unique: false }] },
    briefings:        { indexes: [] },
    qaEvidence:       { indexes: [] },
    budgets:          { indexes: [] },
    goals:            { indexes: [] },
    prefs:            { keyPath: 'key', autoIncrement: false, indexes: [] }
  };

  var STORE_NAMES = Object.keys(STORES);

  /** Primary-key field for a store (default 'id'; prefs uses 'key'). */
  function keyField(store) {
    var def = STORES[store];
    return (def && def.keyPath) || 'id';
  }

  /** Sort records by primary key: numeric for 'id' stores, lexical otherwise. */
  function sortByKey(arr, store) {
    var kf = keyField(store);
    arr.sort(function (a, b) {
      if (kf === 'id') return ((a && a.id) || 0) - ((b && b.id) || 0);
      var ak = String((a && a[kf]) || ''), bk = String((b && b[kf]) || '');
      if (ak < bk) return -1;
      if (ak > bk) return 1;
      return 0;
    });
    return arr;
  }

  var backend = null; // 'idb' | 'local'
  var db = null;
  var openPromise = null;

  function idbAvailable() {
    try { return typeof indexedDB !== 'undefined' && indexedDB !== null; }
    catch (e) { return false; }
  }

  function lsAvailable() {
    try {
      if (typeof localStorage === 'undefined' || localStorage === null) return false;
      var k = '__emm_probe__';
      localStorage.setItem(k, '1');
      localStorage.removeItem(k);
      return true;
    } catch (e) { return false; }
  }

  function reqToPromise(req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('IndexedDB request failed')); };
    });
  }

  function txComplete(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error || new Error('IndexedDB transaction failed')); };
      tx.onabort = function () { reject(tx.error || new Error('IndexedDB transaction aborted')); };
    });
  }

  function openIdb() {
    return new Promise(function (resolve, reject) {
      var req;
      try {
        req = indexedDB.open(Store.DB_NAME, Store.SCHEMA_VERSION);
      } catch (e) { reject(e); return; }
      req.onupgradeneeded = function () {
        var d = req.result;
        for (var i = 0; i < STORE_NAMES.length; i++) {
          var name = STORE_NAMES[i];
          var def = STORES[name];
          var os;
          if (d.objectStoreNames.contains(name)) {
            os = req.transaction.objectStore(name);
          } else {
            os = d.createObjectStore(name, {
              keyPath: def.keyPath || 'id',
              autoIncrement: (def.autoIncrement === undefined) ? true : def.autoIncrement
            });
          }
          var idxDefs = def.indexes;
          for (var j = 0; j < idxDefs.length; j++) {
            var idef = idxDefs[j];
            if (!os.indexNames.contains(idef.name)) {
              os.createIndex(idef.name, idef.keyPath, { unique: !!idef.unique });
            }
          }
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error || new Error('IndexedDB open failed')); };
      req.onblocked = function () { reject(new Error('IndexedDB open blocked')); };
    });
  }

  /* ---------------- localStorage backend helpers ---------------- */

  function lsKey(store) { return LS_PREFIX + store; }
  function lsSeqKey(store) { return LS_PREFIX + '__seq_' + store; }

  function lsRead(store) {
    var raw = null;
    try { raw = localStorage.getItem(lsKey(store)); } catch (e) { raw = null; }
    if (!raw) return {};
    try { return JSON.parse(raw) || {}; } catch (e) { return {}; }
  }

  function lsWrite(store, records) {
    try { localStorage.setItem(lsKey(store), JSON.stringify(records)); }
    catch (e) { throw new Error('localStorage write failed (quota?): ' + e.message); }
  }

  function lsNextId(store) {
    var seq = 1;
    try {
      var raw = localStorage.getItem(lsSeqKey(store));
      if (raw) seq = parseInt(raw, 10) || 1;
    } catch (e) { seq = 1; }
    try { localStorage.setItem(lsSeqKey(store), String(seq + 1)); } catch (e) {}
    return seq;
  }

  /* ---------------- public API ---------------- */

  /**
   * Store.open() -> Promise<'idb'|'local'>.
   * Opens the on-device database, choosing IndexedDB first and falling back
   * to localStorage. Safe to call multiple times (single-flight).
   */
  Store.open = function () {
    if (openPromise) return openPromise;
    openPromise = new Promise(function (resolve, reject) {
      if (idbAvailable()) {
        openIdb().then(function (d) {
          db = d;
          backend = 'idb';
          resolve(backend);
        }, function () {
          // IndexedDB failed (blocked, denied): try localStorage fallback.
          if (lsAvailable()) { backend = 'local'; resolve(backend); }
          else { openPromise = null; reject(new Error('No on-device storage available (IndexedDB failed, localStorage unavailable)')); }
        });
      } else if (lsAvailable()) {
        backend = 'local';
        resolve(backend);
      } else {
        openPromise = null;
        reject(new Error('No on-device storage available'));
      }
    });
    return openPromise;
  };

  /** Which backend is active ('idb' | 'local' | null if not opened). */
  Store.backend = function () { return backend; };

  function ensureOpen() {
    if (backend) return Promise.resolve(backend);
    return Store.open();
  }

  /**
   * Store.put(store, obj) -> Promise<id>.
   * Insert (no primary key) or upsert (primary key present). The primary key
   * field comes from the store def: 'id' for auto-increment stores, 'key'
   * for prefs. Returns the record's primary key.
   */
  Store.put = function (store, obj) {
    return ensureOpen().then(function () {
      if (STORES[store] === undefined) return Promise.reject(new Error('Unknown store: ' + store));
      obj = obj || {};
      var kf = keyField(store);
      var kval = obj[kf];
      if (backend === 'idb') {
        var tx = db.transaction(store, 'readwrite');
        var os = tx.objectStore(store);
        var req = (kval === null || kval === undefined) ? os.add(obj) : os.put(obj);
        return reqToPromise(req).then(function (key) {
          return txComplete(tx).then(function () { return key; });
        });
      }
      // localStorage fallback: identical semantics.
      var records = lsRead(store);
      var id = (kval === null || kval === undefined) ? lsNextId(store) : kval;
      obj[kf] = id;
      records[String(id)] = obj;
      lsWrite(store, records);
      return id;
    });
  };

  /**
   * Normalize a primary key for IndexedDB. 'id' stores are auto-increment
   * numbers — but DOM data-id attributes arrive as strings ("1" !== 1 in
   * IndexedDB). Coerce numeric strings to numbers; leave everything else
   * alone. Callers of the natural-key 'prefs' store must use NON-numeric
   * string keys (numeric strings would be coerced and miss).
   */
  function toKey(id) {
    if (typeof id === 'string' && id !== '' && !isNaN(Number(id))) return Number(id);
    return id;
  }

  /** Store.get(store, id) -> Promise<object|null>. */
  Store.get = function (store, id) {
    return ensureOpen().then(function () {
      if (STORES[store] === undefined) return Promise.reject(new Error('Unknown store: ' + store));
      if (backend === 'idb') {
        var tx = db.transaction(store, 'readonly');
        return reqToPromise(tx.objectStore(store).get(toKey(id))).then(function (v) {
          return (v === undefined) ? null : v;
        });
      }
      var records = lsRead(store);
      var v = records[String(id)];
      return (v === undefined) ? null : v;
    });
  };

  /** Store.all(store) -> Promise<object[]> (all records, key-ascending). */
  Store.all = function (store) {
    return ensureOpen().then(function () {
      if (STORES[store] === undefined) return Promise.reject(new Error('Unknown store: ' + store));
      if (backend === 'idb') {
        var tx = db.transaction(store, 'readonly');
        return reqToPromise(tx.objectStore(store).getAll()).then(function (arr) {
          return sortByKey(arr, store);
        });
      }
      var records = lsRead(store);
      var out = Object.keys(records).map(function (k) { return records[k]; });
      return sortByKey(out, store);
    });
  };

  /**
   * Store.query(store, index, value) -> Promise<object[]>.
   * IndexedDB: uses the named index. localStorage fallback: filters on the
   * record field with the same name as the index.
   */
  Store.query = function (store, index, value) {
    return ensureOpen().then(function () {
      if (STORES[store] === undefined) return Promise.reject(new Error('Unknown store: ' + store));
      if (backend === 'idb') {
        var tx = db.transaction(store, 'readonly');
        var os = tx.objectStore(store);
        if (!os.indexNames.contains(index)) {
          return Promise.reject(new Error('Unknown index "' + index + '" on store "' + store + '"'));
        }
        return reqToPromise(os.index(index).getAll(IDBKeyRange.only(value)));
      }
      var records = lsRead(store);
      var out = [];
      var keys = Object.keys(records);
      for (var i = 0; i < keys.length; i++) {
        var rec = records[keys[i]];
        if (rec && rec[index] === value) out.push(rec);
      }
      return sortByKey(out, store);
    });
  };

  /** Store.delete(store, id) -> Promise<void>. */
  Store.delete = function (store, id) {
    return ensureOpen().then(function () {
      if (STORES[store] === undefined) return Promise.reject(new Error('Unknown store: ' + store));
      if (backend === 'idb') {
        var tx = db.transaction(store, 'readwrite');
        return reqToPromise(tx.objectStore(store).delete(toKey(id))).then(function () {
          return txComplete(tx);
        });
      }
      var records = lsRead(store);
      delete records[String(id)];
      lsWrite(store, records);
    });
  };

  /**
   * Store.logAudit(eventType, entityType, entityId, details) -> Promise<id>.
   * Append-only audit trail: every pipeline stage and every user correction
   * must log here. Never edited or deleted except by wipeAll().
   */
  Store.logAudit = function (eventType, entityType, entityId, details) {
    var entry = {
      eventType: eventType || 'unknown',
      entityType: entityType || null,
      entityId: (entityId === undefined) ? null : entityId,
      details: (details === undefined) ? null : details,
      timestamp: Date.now()
    };
    return Store.put('auditEvents', entry);
  };

  /**
   * Store.exportAll() -> Promise<object> mapping store name -> record array.
   * For EXPLICIT user-initiated JSON export only. This function serializes;
   * it never transmits anything anywhere.
   */
  Store.exportAll = function () {
    return ensureOpen().then(function () {
      var result = {};
      var chain = Promise.resolve();
      STORE_NAMES.forEach(function (name) {
        chain = chain.then(function () {
          return Store.all(name).then(function (rows) { result[name] = rows; });
        });
      });
      return chain.then(function () {
        result._exportMeta = {
          schemaVersion: Store.SCHEMA_VERSION,
          backend: backend,
          exportedAt: new Date().toISOString()
        };
        return result;
      });
    });
  };

  /**
   * Store.wipeAll() -> Promise<void>.
   * Deletes EVERYTHING on-device (all stores / all localStorage keys).
   * The Privacy screen MUST confirm with the user before this is called.
   * There is no recovery: by design, nothing was ever sent anywhere, so
   * nothing can be restored from anywhere.
   */
  Store.wipeAll = function () {
    return ensureOpen().then(function () {
      if (backend === 'idb') {
        var tx = db.transaction(STORE_NAMES, 'readwrite');
        var chain = Promise.resolve();
        STORE_NAMES.forEach(function (name) {
          chain = chain.then(function () {
            return reqToPromise(tx.objectStore(name).clear());
          });
        });
        return chain.then(function () { return txComplete(tx); });
      }
      for (var i = 0; i < STORE_NAMES.length; i++) {
        try {
          localStorage.removeItem(lsKey(STORE_NAMES[i]));
          localStorage.removeItem(lsSeqKey(STORE_NAMES[i]));
        } catch (e) {}
      }
    });
  };

  var _g = (typeof window !== 'undefined') ? window
         : (typeof global !== 'undefined') ? global
         : this;
  _g.Store = Store;
})();
