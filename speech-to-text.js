/**
 * Speech to text for Nova's chats: a recording made in the browser (16 kHz mono
 * 16-bit WAV, built by public/axiom-voice.js) in, the words out.
 *
 * Which service, from .env:
 *   STT_PROVIDER=openai  + OPENAI_API_KEY      (the default when OPENAI_API_KEY is set)
 *                          STT_MODEL           (default gpt-4o-mini-transcribe)
 *   STT_PROVIDER=google  — Google Cloud Speech-to-Text with the existing service
 *                          account (gmail-key.json). The Speech-to-Text API must be
 *                          enabled, with billing, on that service account's project.
 *   neither              — provider() is null; the chat uses the browser's own
 *                          speech recognition instead.
 *
 * Recordings are never stored: they are sent to the service and dropped.
 */
'use strict';
const fs = require('fs');
const path = require('path');

// Words a print shop's customers say that a general model tends to get wrong.
const VOCAB = 'AxiomPrint, Nova, business cards, postcards, flyers, brochures, banners, vinyl banner, mesh banner, ' +
  'retractable banner, foam board, Gatorboard, coroplast, PVC, acrylic, aluminum, Dibond, decals, stickers, ' +
  'die cut, kiss cut, window cling, wall graphics, canvas, yard signs, A-frame, H-stakes, grommets, hemming, ' +
  'pole pockets, laminated, matte, gloss, soft touch, foil, spot UV, 16pt, 14pt, 100# cover, 100# text, ' +
  'saddle stitch, perfect bound, spiral bound, booklets, menus, NCR forms, envelopes, letterhead, bleed, ' +
  'die line, proof, turnaround, pickup, installation';

module.exports = function makeStt(opts) {
  opts = opts || {};
  const env = process.env;
  const keyFile = opts.keyFile || path.join(__dirname, 'gmail-key.json');
  const want = String(env.STT_PROVIDER || '').toLowerCase();

  function provider() {
    if (want === 'off' || want === 'browser') return null;
    if (want === 'google') return fs.existsSync(keyFile) ? 'google' : null;
    if (env.OPENAI_API_KEY) return 'openai';
    return null;
  }

  // ---- WAV: check it is what our recorder makes, and get the samples ----
  function readWav(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 44) throw new Error('not a recording');
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV recording');
    let off = 12, fmt = null, data = null;
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4), size = buf.readUInt32LE(off + 4);
      if (id === 'fmt ') fmt = { format: buf.readUInt16LE(off + 8), channels: buf.readUInt16LE(off + 10),
                                 rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
      if (id === 'data') { data = buf.subarray(off + 8, Math.min(buf.length, off + 8 + size)); break; }
      off += 8 + size + (size & 1);
    }
    if (!fmt || !data) throw new Error('not a WAV recording');
    if (fmt.format !== 1 || fmt.channels !== 1 || fmt.bits !== 16 || fmt.rate < 8000 || fmt.rate > 48000) throw new Error('unsupported recording format');
    return { rate: fmt.rate, pcm: data, seconds: data.length / 2 / fmt.rate };
  }

  // ---- OpenAI ----
  // Language: STT_LANGUAGE in .env forces one (e.g. en); otherwise the chat's hint (the script the customer
  // types in, or their browser language), otherwise the service detects it.
  const forced = () => { const l = String(env.STT_LANGUAGE || '').toLowerCase(); return l && l !== 'auto' ? l : null; };
  async function openai(buf, hint) {
    const lang = forced() || hint || null;
    const form = new FormData();
    form.append('file', new Blob([buf], { type: 'audio/wav' }), 'speech.wav');
    form.append('model', env.STT_MODEL || 'gpt-4o-mini-transcribe');
    if (lang) form.append('language', lang);
    // An English sentence here pulls other languages toward English, so it is only used for English.
    form.append('prompt', lang === 'en' ? 'A customer asking a print shop about products, prices and orders. ' + VOCAB + '.' : VOCAB + '.');
    form.append('response_format', 'json');
    const r = await fetch((env.OPENAI_BASE_URL || 'https://api.openai.com/v1') + '/audio/transcriptions', {
      method: 'POST', headers: { Authorization: 'Bearer ' + env.OPENAI_API_KEY }, body: form,
      signal: AbortSignal.timeout(45000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('openai ' + r.status + ' ' + String((j.error && j.error.message) || '').slice(0, 200));
    return String(j.text || '');
  }

  // ---- Google Cloud Speech-to-Text (v1, synchronous: at most 60 s per call) ----
  let gAuth = null;
  async function googleToken() {
    if (!gAuth) {
      const { google } = require('googleapis');
      const key = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
      gAuth = new google.auth.JWT({ email: key.client_email, key: key.private_key,
                                    scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    }
    const t = await gAuth.getAccessToken();
    return t && (t.token || t);
  }
  const GOOGLE_CODES = { en: 'en-US', hy: 'hy-AM', es: 'es-US', ru: 'ru-RU', ar: 'ar-SA', fa: 'fa-IR', ka: 'ka-GE', he: 'iw-IL',
    fr: 'fr-FR', de: 'de-DE', it: 'it-IT', pt: 'pt-BR', ko: 'ko-KR', ja: 'ja-JP', zh: 'cmn-Hans-CN', tl: 'fil-PH', vi: 'vi-VN', uk: 'uk-UA', tr: 'tr-TR' };
  async function google(wav, hint) {
    const token = await googleToken();
    const per = wav.rate * 2 * 55;                       // 55-second pieces
    const parts = [];
    for (let i = 0; i < wav.pcm.length; i += per) parts.push(wav.pcm.subarray(i, i + per));
    let out = '';
    for (const pcm of parts) {
      const r = await fetch('https://speech.googleapis.com/v1/speech:recognize', {
        method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          config: { encoding: 'LINEAR16', sampleRateHertz: wav.rate, languageCode: env.STT_LANGUAGE_CODE || GOOGLE_CODES[hint] || 'en-US',
                    enableAutomaticPunctuation: true, model: 'latest_long',
                    speechContexts: [{ phrases: VOCAB.split(/,\s*/).slice(0, 500) }] },
          audio: { content: Buffer.from(pcm).toString('base64') } }),
        signal: AbortSignal.timeout(45000) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error('google ' + r.status + ' ' + String((j.error && j.error.message) || '').slice(0, 200));
      out += (j.results || []).map(x => x.alternatives && x.alternatives[0] ? x.alternatives[0].transcript : '').join(' ') + ' ';
    }
    return out;
  }

  async function transcribe(buf, o) {
    const hint = o && /^[a-z]{2,3}$/.test(String(o.lang || '')) ? String(o.lang) : null;
    const p = provider();
    if (!p) { const e = new Error('speech to text is not set up'); e.code = 'off'; throw e; }
    const wav = readWav(buf);
    if (wav.seconds < 0.3) return '';
    const text = p === 'google' ? await google(wav, hint) : await openai(buf, hint);
    return text.replace(/\s+/g, ' ').trim();
  }

  return { provider, transcribe, readWav };
};
