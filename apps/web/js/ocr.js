/* Explain My Money — on-device receipt OCR adapter.
 * Uses vendored Tesseract.js (no network): tesseract.min.js,
 * tesseract-worker.min.js, tesseract-core.wasm.js/.wasm, eng.traineddata
 * all live under vendor/. Images never leave the device.
 */
window.OCR = (() => {
  'use strict';

  let workerPromise = null;

  async function getWorker(onProgress) {
    if (!workerPromise) {
      workerPromise = (async () => {
        const worker = await Tesseract.createWorker('eng', Tesseract.OEM.LSTM, {
          workerPath: 'vendor/tesseract-worker.min.js',
          corePath: 'vendor/tesseract-core.wasm.js',
          langPath: 'vendor',
          cacheMethod: 'none',
          logger: (m) => { if (onProgress) { try { onProgress(m); } catch (e) {} } }
        });
        return worker;
      })();
    }
    return workerPromise;
  }

  async function releaseWorker() {
    if (workerPromise) {
      try { (await workerPromise).terminate(); } catch (e) {}
      workerPromise = null;
    }
  }

  // Downscale very large images for speed; keep aspect ratio.
  async function prepareImage(source) {
    const bitmap = await createImageBitmap(source);
    const MAX = 2000;
    const scale = Math.min(1, MAX / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, w, h);
    if (bitmap.close) bitmap.close();
    return canvas;
  }

  async function recognizeImage(source, onProgress) {
    const worker = await getWorker(onProgress);
    const canvas = await prepareImage(source);
    const { data } = await worker.recognize(canvas);
    return {
      text: data.text || '',
      confidence: typeof data.confidence === 'number' ? data.confidence : null,
      words: (data.words || []).map((w) => ({ text: w.text, confidence: w.confidence }))
    };
  }

  const AMOUNT_RE = /\$?\s?(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})\b/;
  const DATE_RES = [
    /\b(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})\b/,
    /\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/,
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/i
  ];
  const MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
  const SKIP_ITEM_RE = /sub\s*total|total|tax|hst|gst|pst|qst|tip|gratuity|tender|change|cash|debit|credit|visa|mastercard|amex|balance|amount due|thank you|receipt|invoice|store\s*#|transaction|auth|approval/i;

  function parseAmount(s) {
    const m = String(s).match(AMOUNT_RE);
    if (!m) return null;
    return parseInt(m[1].replace(/,/g, ''), 10) * 100 + parseInt(m[2], 10);
  }

  function parseDate(s) {
    for (const re of DATE_RES) {
      const m = String(s).match(re);
      if (!m) continue;
      try {
        if (re === DATE_RES[0]) {
          return iso(m[1], m[2], m[3]);
        } else if (re === DATE_RES[1]) {
          let y = m[3]; if (y.length === 2) y = '20' + y;
          return iso(y, m[1], m[2]);
        } else {
          return iso(m[3], String(MONTHS[m[1].toLowerCase().slice(0,3)]), m[2]);
        }
      } catch (e) { /* keep trying */ }
    }
    return null;
  }

  function iso(y, mo, d) {
    const yy = parseInt(y, 10), mm = parseInt(mo, 10), dd = parseInt(d, 10);
    if (!(yy >= 1990 && yy <= 2100 && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31)) throw new Error('bad date');
    return yy + '-' + String(mm).padStart(2, '0') + '-' + String(dd).padStart(2, '0');
  }

  // Deterministic, conservative receipt field extraction from OCR text.
  // Anything uncertain is returned with low confidence for the review queue.
  function parseReceiptText(text) {
    const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
    const out = {
      merchant_text: null, merchant_confidence: 0,
      receipt_date: null, date_confidence: 0,
      total_minor: null, total_confidence: 0,
      tax_minor: null,
      line_items: [],
      raw_text: text
    };
    if (!lines.length) return out;

    // Merchant: first plausible line (letters, not just numbers/symbols).
    for (const line of lines.slice(0, 6)) {
      if (/[a-zA-Z]{3,}/.test(line) && line.length <= 48 && !/receipt|invoice/i.test(line)) {
        out.merchant_text = line.replace(/\s*#\d+.*$/, '').trim();
        out.merchant_confidence = 0.7;
        break;
      }
    }

    // Date: first parseable date in the text.
    for (const line of lines) {
      const d = parseDate(line);
      if (d) { out.receipt_date = d; out.date_confidence = 0.75; break; }
    }

    // Total: scan from the bottom for a "total" line with an amount.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (/total/i.test(line) && !/sub\s*total/i.test(line)) {
        const amt = parseAmount(line);
        if (amt != null) { out.total_minor = amt; out.total_confidence = 0.8; break; }
      }
    }
    // Fallback: largest amount in the bottom third.
    if (out.total_minor == null) {
      const tail = lines.slice(Math.floor(lines.length * 0.66));
      let best = null;
      for (const line of tail) {
        const amt = parseAmount(line);
        if (amt != null && (best == null || amt > best)) best = amt;
      }
      if (best != null) { out.total_minor = best; out.total_confidence = 0.45; }
    }

    for (const line of lines) {
      if (/^\s*(tax|hst|gst|pst|qst)\b/i.test(line)) {
        const amt = parseAmount(line);
        if (amt != null) { out.tax_minor = amt; break; }
      }
    }

    // Line items: lines ending with an amount, excluding summary/tender lines.
    for (const line of lines) {
      if (SKIP_ITEM_RE.test(line)) continue;
      const m = line.match(/^(.*?)\s+(\$?\s?\d{1,3}(?:,\d{3})*|\d+\.\d{2})\s*$/);
      if (!m) continue;
      const desc = m[1].trim();
      const amt = parseAmount(m[2]);
      if (!desc || desc.length < 2 || amt == null) continue;
      if (/^\d+$/.test(desc.replace(/\s/g, ''))) continue;
      out.line_items.push({ description_raw: desc.slice(0, 80), amount_minor: amt });
    }

    return out;
  }

  async function scanReceipt(fileOrBlob, onProgress) {
    const ocr = await recognizeImage(fileOrBlob, onProgress);
    const parsed = parseReceiptText(ocr.text);
    parsed.ocr_confidence = ocr.confidence;
    return parsed;
  }

  return { getWorker, releaseWorker, recognizeImage, parseReceiptText, scanReceipt };
})();
