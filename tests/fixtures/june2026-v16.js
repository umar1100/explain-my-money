/* Fictional June-2026 ledger reproducing Umar's reported v15 screen
   (37 transactions, mixed PDF-positive / CSV-negative amount conventions).
   Canonical math: gross $15,749.43, refunds $798.41, net $14,951.02.
   Old signed-sum math on the same rows: $8,209.44. All merchants fictional.
   Shared by tests/june-repro-v16.node.js and tests/home-consistency-v16.node.js. */
'use strict';

let seq = 0;
function T(o) {
  return Object.assign({
    id: 'june' + (++seq), merchantRaw: 'FICTIONAL', amountMinor: 100,
    kind: 'purchase', category: 'shopping', date: '2026-06-15', statementId: 'st-june',
    excluded: 0, status: 'active',
  }, o);
}
function p(merchant, amountMinor, category, date, kind) {
  return T({ merchantRaw: merchant, amountMinor: amountMinor, category: category,
    date: date || '2026-06-15', kind: kind || 'purchase' });
}

function juneTxns() {
  seq = 0;
  return [
    // shopping gross $12,027.27
    p('BIGBOX ONLINE', 775499, 'shopping', '2026-06-03'),
    p('BIGBOX ONLINE', 250000, 'shopping', '2026-06-09'),
    p('GADGET HUT', -114501, 'shopping', '2026-06-14'),
    p('BOOK NOOK', -62727, 'shopping', '2026-06-21'),
    p('BIGBOX ONLINE REFUND', -39920, 'shopping', '2026-06-25', 'refund'), // PDF-style refund (negative)
    // other gross $2,488.15
    p('CITY PARKING', 147944, 'other', '2026-06-02'),
    p('LOTTO KIOSK', -100871, 'other', '2026-06-28'),
    p('PAYPROCESS REBATE', 39921, 'other', '2026-06-27', 'refund'), // CSV-style refund (positive)
    // groceries $585.76 (mixed conventions)
    p('FRESHCART', 16500, 'groceries', '2026-06-01'),
    p('FRESHCART', 8000, 'groceries', '2026-06-08'),
    p('CORNER GREENS', -500, 'groceries', '2026-06-04'),
    p('CORNER GREENS', -6200, 'groceries', '2026-06-11'),
    p('BULK MART', -4800, 'groceries', '2026-06-13'),
    p('FRESHCART', -7300, 'groceries', '2026-06-16'),
    p('BULK MART', -3900, 'groceries', '2026-06-18'),
    p('CORNER GREENS', -4100, 'groceries', '2026-06-22'),
    p('FRESHCART', -3600, 'groceries', '2026-06-24'),
    p('BULK MART', -3676, 'groceries', '2026-06-29'),
    // household $393.75
    p('FIXIT HARDWARE', -7000, 'household', '2026-06-05'),
    p('FIXIT HARDWARE', -8200, 'household', '2026-06-10'),
    p('HOME GOODS', -5300, 'household', '2026-06-12'),
    p('FIXIT HARDWARE', -4400, 'household', '2026-06-17'),
    p('HOME GOODS', -6100, 'household', '2026-06-20'),
    p('CLEAN SUPPLY', -3900, 'household', '2026-06-23'),
    p('CLEAN SUPPLY', -1500, 'household', '2026-06-26'),
    p('CLEAN SUPPLY', -500, 'household', '2026-06-26'),
    p('CLEAN SUPPLY', -2475, 'household', '2026-06-27'),
    // subscriptions $254.50
    p('STREAMFLIX', -1599, 'subscriptions', '2026-06-06'),
    p('MUSIC WAVE', -1099, 'subscriptions', '2026-06-07'),
    p('CLOUD DRIVE', -299, 'subscriptions', '2026-06-09'),
    p('NEWS DAILY', -1299, 'subscriptions', '2026-06-11'),
    p('FIT APP', -1999, 'subscriptions', '2026-06-15'),
    p('GAME PASS', -19155, 'subscriptions', '2026-06-19'),
    // money movement (never spend)
    T({ merchantRaw: 'PAYMENT RECEIVED - THANK YOU', amountMinor: 400000, spendAmountMinor: 0, kind: 'payment', excluded: 1, category: 'uncategorized', date: '2026-06-20' }),
    T({ merchantRaw: 'PAYMENT RECEIVED - THANK YOU', amountMinor: 353998, spendAmountMinor: 0, kind: 'payment', excluded: 1, category: 'uncategorized', date: '2026-06-28' }),
    T({ merchantRaw: 'E-TRANSFER SENT', amountMinor: -50000, spendAmountMinor: 0, kind: 'transfer', excluded: 1, category: 'uncategorized', date: '2026-06-22' }),
    T({ merchantRaw: 'ANNUAL FEE', amountMinor: -12000, spendAmountMinor: 0, kind: 'fee', excluded: 1, category: 'uncategorized', date: '2026-06-01' }),
  ];
}

/* Canonical expectations for the fixture. */
const EXPECTED = {
  count: 37,
  grossMinor: 1574943,   // $15,749.43 — also the receipt denominator
  refundsMinor: 79841,   // $798.41
  netMinor: 1495102,     // $14,951.02
  oldSignedHeroMinor: 820944, // $8,209.44 — what the v15 signed-sum math showed
  bars: { shopping: 1162807, other: 208894, groceries: 58576, household: 39375, subscriptions: 25450 },
};

function juneStatement() {
  return {
    id: 'st-june', name: 'June 2026', accountLabel: 'Main Visa ••4242',
    parser: 'fixture', createdAt: Date.now(),
    periodStart: '2026-06-01', periodEnd: '2026-06-30',
    txnCount: 37,
  };
}

module.exports = { juneTxns: juneTxns, juneStatement: juneStatement, EXPECTED: EXPECTED };
