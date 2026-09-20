/* Explain My Money — optional BYOK language-model adapter.
 *
 * HARD RULES (from the product design):
 *  - The deterministic local engine owns all facts. The model may only
 *    PHRASE already-computed facts; it can never compute, reclassify, or
 *    alter a total. Model output is presentation-only.
 *  - The app works fully offline without any key. This adapter is inert
 *    unless the user explicitly enables it and provides their own key.
 *  - The API key lives in memory only — it is never written to storage.
 *  - Calls go directly from the device to the user's chosen provider.
 *    There is no proxy, no logging, no telemetry.
 *  - Every outbound payload is shown to the user BEFORE sending
 *    (pre-send preview) and requires explicit confirmation.
 *
 * Privacy modes:
 *  - 'off'        : nothing leaves the device (default).
 *  - 'aggregates' : only aggregated facts (totals, deltas, category names).
 *  - 'detailed'   : user-approved relevant transaction/merchant detail.
 */
window.LLM = (() => {
  'use strict';

  const SETTINGS_KEY = 'emm-llm-settings-v1';
  let apiKey = null; // memory only, never persisted

  function getSettings() {
    try {
      return Object.assign(
        { enabled: false, baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', privacyMode: 'off' },
        JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')
      );
    } catch (e) { return { enabled: false, baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', privacyMode: 'off' }; }
  }

  function saveSettings(s) {
    const { enabled, baseUrl, model, privacyMode } = Object.assign(getSettings(), s);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ enabled, baseUrl, model, privacyMode }));
  }

  function setKey(k) { apiKey = (k || '').trim() || null; }
  function clearKey() { apiKey = null; }
  function hasKey() { return !!apiKey; }

  function isActive() {
    const s = getSettings();
    return s.enabled && s.privacyMode !== 'off' && !!apiKey;
  }

  // Build the ONLY payload the model may ever see: an evidence packet.
  // Account numbers are never stored by the app, so only display labels
  // (e.g. "Chase ···4242") can appear here.
  function buildPacket(facts, mode, approvedDetails) {
    const packet = {
      scope: facts.scope,                 // { period, accounts: [labels], currency }
      facts: facts.metrics,               // [{ metric, amount_minor }] — precomputed
      drivers: facts.drivers,             // [{ group, delta_minor, transaction_ids, confidence }]
      unresolved: facts.unresolved,       // [{ transaction_id, impact_minor }]
      privacy_mode: mode
    };
    if (mode === 'detailed') {
      packet.approved_detail = approvedDetails || [];
    }
    return packet;
  }

  const SYSTEM_PROMPT = [
    'You phrase precomputed personal-finance facts in plain language.',
    'HARD RULES:',
    '1. Never compute, infer, or change any number. Repeat the given figures exactly.',
    '2. Never invent merchants, transactions, or categories. Only reference the IDs and labels provided.',
    '3. State uncertainty exactly as given; never hide it.',
    '4. Reply with JSON only: {"phrasing": "..."}.',
    '5. Never give financial advice (no "you should", no affordability judgments).'
  ].join('\n');

  async function callProvider(packet, kind, onPreview) {
    const s = getSettings();
    if (!isActive()) return null;
    const payload = {
      model: s.model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify({ kind, evidence_packet: packet }) }
      ]
    };
    // Pre-send preview: the caller shows this to the user and must resolve true.
    const approved = await onPreview({
      provider: s.baseUrl, model: s.model,
      privacyMode: s.privacyMode,
      payload
    });
    if (!approved) return null;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45000);
    try {
      const res = await fetch(s.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
        body: JSON.stringify(payload),
        signal: ctrl.signal
      });
      if (!res.ok) throw new Error('Provider returned HTTP ' + res.status);
      const data = await res.json();
      const content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      const parsed = JSON.parse(content || '{}');
      return typeof parsed.phrasing === 'string' ? parsed.phrasing : null;
    } catch (e) {
      return null; // any failure → caller falls back to deterministic wording
    } finally {
      clearTimeout(timer);
    }
  }

  // Build the exact outbound request WITHOUT sending it, so the UI can
  // show a byte-identical pre-send preview and bind approval to it.
  function previewPayload(facts, kind, approvedDetails) {
    const s = getSettings();
    const packet = buildPacket(facts, s.privacyMode, approvedDetails);
    return {
      provider: s.baseUrl,
      model: s.model,
      privacyMode: s.privacyMode,
      request: {
        model: s.model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify({ kind, evidence_packet: packet }) }
        ]
      }
    };
  }

  // Phrase a monthly briefing. Returns { text, source: 'llm'|'deterministic' }.
  async function phraseBriefing(facts, deterministicText, onPreview) {
    const s = getSettings();
    if (!isActive()) return { text: deterministicText, source: 'deterministic' };
    const packet = buildPacket(facts, s.privacyMode);
    const phrasing = await callProvider(packet, 'briefing', onPreview);
    if (!phrasing) return { text: deterministicText, source: 'deterministic' };
    return { text: phrasing, source: 'llm' };
  }

  // Phrase an answer. The answer's FACTS are computed locally first;
  // the model only rewords the deterministic answer text.
  async function phraseAnswer(facts, deterministicText, onPreview, approvedDetails) {
    const s = getSettings();
    if (!isActive()) return { text: deterministicText, source: 'deterministic' };
    const packet = buildPacket(facts, s.privacyMode, approvedDetails);
    const phrasing = await callProvider(packet, 'answer', onPreview);
    if (!phrasing) return { text: deterministicText, source: 'deterministic' };
    return { text: phrasing, source: 'llm' };
  }

  return {
    getSettings, saveSettings,
    setKey, clearKey, hasKey, isActive,
    buildPacket, previewPayload, phraseBriefing, phraseAnswer
  };
})();
