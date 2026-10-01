/**
 * Voice typing with a recording bar: tap the mic, talk, tap Done, and the words
 * land in the message box (to check and send). While recording, the composer
 * shows a live waveform, a timer, Cancel and Done — no half-heard words jumping
 * around in the box.
 *
 * Two ways to turn speech into text:
 *   - server: the browser records the microphone itself (16 kHz mono WAV) and
 *     opts.transcribe(blob) sends it to Nova, which asks the speech service.
 *     Works the same on every browser, including phones.
 *   - browser: when Nova has no speech service, the browser's own
 *     SpeechRecognition runs behind the same bar; it is restarted when the
 *     browser stops on a pause, and Android's repeated phrases are merged.
 *
 *   AxiomVoice.attach({
 *     button, input, host,                  // mic button, textarea, element the bar covers
 *     useServer: () => Promise<boolean>,    // is server transcription available?
 *     transcribe: async (wavBlob) => text,
 *     onText: (text) => {}, onError: (msg) => {}, onState: (state) => {}
 *   })
 */
(function (global) {
  var SR = global.SpeechRecognition || global.webkitSpeechRecognition || null;
  var AC = global.AudioContext || global.webkitAudioContext || null;
  var canRecord = !!(AC && global.navigator && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  var MAX_SECONDS = 120, RATE = 16000;

  var ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>';
  var ICON_OK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="5 12.5 10 17.5 19 7"/></svg>';

  function micError(err) {
    var inFrame = global.self !== global.top;
    if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError' || err === 'not-allowed' || err === 'service-not-allowed')) {
      return inFrame ? 'The microphone is blocked. Allow it for this site in the browser (the icon by the address), then try again.'
                     : 'Microphone permission was denied. Allow it in the browser and try again.';
    }
    if (err && (err.name === 'NotFoundError' || err === 'audio-capture')) return 'No microphone was found.';
    return 'Could not open the microphone. Please try again, or type your message.';
  }

  // Float32 chunks at the device rate -> 16 kHz 16-bit mono WAV.
  function toWav(chunks, inRate) {
    var n = 0, i, j;
    for (i = 0; i < chunks.length; i++) n += chunks[i].length;
    var all = new Float32Array(n), o = 0;
    for (i = 0; i < chunks.length; i++) { all.set(chunks[i], o); o += chunks[i].length; }
    var ratio = inRate / RATE, outLen = Math.floor(n / ratio);
    var buf = new ArrayBuffer(44 + outLen * 2), v = new DataView(buf);
    function str(p, s) { for (var k = 0; k < s.length; k++) v.setUint8(p + k, s.charCodeAt(k)); }
    str(0, 'RIFF'); v.setUint32(4, 36 + outLen * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, RATE, true); v.setUint32(28, RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, outLen * 2, true);
    for (i = 0; i < outLen; i++) {
      var a = Math.floor(i * ratio), b = Math.min(n, Math.floor((i + 1) * ratio)), sum = 0, c = 0;
      for (j = a; j < b; j++) { sum += all[j]; c++; }
      var s = Math.max(-1, Math.min(1, c ? sum / c : 0));
      v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return { blob: new Blob([buf], { type: 'audio/wav' }), seconds: outLen / RATE };
  }

  // Android repeats a phrase as it grows ("looking", "looking for", ...): keep the longest.
  function norm(s) { return String(s).toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
  function merge(list) {
    var out = [];
    list.forEach(function (t) {
      t = String(t || '').trim(); if (!t) return;
      var last = out[out.length - 1], nt = norm(t), nl = last != null ? norm(last) : null;
      if (nl != null && nt.indexOf(nl) === 0) out[out.length - 1] = t;
      else if (nl != null && nl.indexOf(nt) === 0) return;
      else out.push(t);
    });
    return out.join(' ');
  }

  function attach(opts) {
    var btn = opts.button, input = opts.input, host = opts.host || (btn && btn.parentNode);
    if (!btn || !input || !host) return null;
    if (!canRecord && !SR) { btn.style.display = 'none'; return null; }

    var mode = null;                                   // 'server' | 'browser'
    var modeP = Promise.resolve(opts.useServer ? opts.useServer() : false).then(function (ok) {
      mode = ok && canRecord ? 'server' : (SR ? 'browser' : null);
      if (!mode) btn.style.display = 'none';
      return mode;
    }, function () { mode = SR ? 'browser' : null; if (!mode) btn.style.display = 'none'; return mode; });

    // ---- the bar ----
    var bar = document.createElement('div');
    bar.className = 'av-bar'; bar.hidden = true;
    bar.innerHTML = '<button type="button" class="av-cancel" title="Cancel" aria-label="Cancel recording">' + ICON_X + '</button>' +
      '<span class="av-dot"></span><span class="av-time">0:00</span>' +
      '<canvas class="av-wave" aria-hidden="true"></canvas>' +
      '<span class="av-msg"></span>' +
      '<button type="button" class="av-done" title="Done — turn it into text" aria-label="Done, turn it into text">' + ICON_OK + '</button>';
    host.appendChild(bar);
    var cv = bar.querySelector('.av-wave'), tm = bar.querySelector('.av-time'), msg = bar.querySelector('.av-msg');
    var done = bar.querySelector('.av-done');

    var state = 'idle', attempt = 0, started = 0, levels = [], tick = null, raf = 0, lastVoice = 0;
    var stream = null, ctx = null, proc = null, an = null, chunks = [], inRate = 48000;
    var rec = null, prior = [], session = [], interim = '', ended = null;

    function setState(s, text) {
      state = s;
      host.classList.toggle('av-on', s !== 'idle');
      bar.hidden = s === 'idle';
      bar.classList.toggle('av-busy', s === 'converting');
      msg.textContent = text || '';
      done.disabled = s === 'converting';
      btn.classList.toggle('rec', s === 'recording');
      if (opts.onState) opts.onState(s);
    }
    function fail(m) { cleanup(); setState('idle'); if (opts.onError && m) opts.onError(m); }

    function draw() {
      var w = cv.clientWidth, h = cv.clientHeight, dpr = global.devicePixelRatio || 1;
      if (!w || !h) { raf = global.requestAnimationFrame(draw); return; }
      if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
      var g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
      var step = 4, n = Math.floor(w / step), col = getComputedStyle(cv).color || '#6366f1';
      g.fillStyle = col;
      for (var i = 0; i < n; i++) {
        var lv = levels[levels.length - n + i]; if (lv == null) lv = 0;
        var bh = Math.max(2, Math.min(h, h * lv));
        g.fillRect(i * step, (h - bh) / 2, 2.4, bh);
      }
      raf = global.requestAnimationFrame(draw);
    }
    function level() {
      if (an) {
        var d = new Uint8Array(an.fftSize); an.getByteTimeDomainData(d);
        var sum = 0; for (var i = 0; i < d.length; i++) { var x = (d[i] - 128) / 128; sum += x * x; }
        return Math.min(1, Math.sqrt(sum / d.length) * 5);
      }
      // Browser mode cannot share the microphone: move with the speech it hears.
      var talking = Date.now() - lastVoice < 900;
      return talking ? 0.25 + Math.random() * 0.6 : 0.04 + Math.random() * 0.05;
    }
    function startClock() {
      started = Date.now(); levels = [];
      tick = setInterval(function () {
        var s = Math.floor((Date.now() - started) / 1000);
        tm.textContent = Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
        levels.push(level()); if (levels.length > 400) levels.splice(0, 100);
        if (s >= MAX_SECONDS) finish();
      }, 80);
      raf = global.requestAnimationFrame(draw);
    }

    function cleanup() {
      clearInterval(tick); tick = null; if (raf) global.cancelAnimationFrame(raf); raf = 0;
      try { if (proc) { proc.onaudioprocess = null; proc.disconnect(); } } catch (e) {}
      try { if (stream) stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
      try { if (ctx) ctx.close(); } catch (e) {}
      proc = null; stream = null; ctx = null; an = null;
      if (rec) { var r = rec; rec = null; r.onend = null; r.onresult = null; r.onerror = null; try { r.abort(); } catch (e) {} }
    }

    // ---- server mode: record the microphone ourselves ----
    function startServer() {
      ctx = new AC();                                   // inside the tap, so phones allow sound capture
      chunks = []; inRate = ctx.sampleRate;
      setState('recording'); tm.textContent = '0:00';
      navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
        .then(function (s) {
          if (state !== 'recording' || !ctx) { s.getTracks().forEach(function (t) { t.stop(); }); return; }
          stream = s;
          if (ctx.state === 'suspended' && ctx.resume) ctx.resume();
          var src = ctx.createMediaStreamSource(s);
          an = ctx.createAnalyser(); an.fftSize = 1024; src.connect(an);
          proc = ctx.createScriptProcessor(4096, 1, 1);
          proc.onaudioprocess = function (e) { chunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
          var mute = ctx.createGain(); mute.gain.value = 0;
          src.connect(proc); proc.connect(mute); mute.connect(ctx.destination);
          startClock();
        }, function (err) { fail(micError(err)); });
    }
    function finishServer() {
      var rate = inRate, got = chunks; chunks = [];
      cleanup();
      var w = toWav(got, rate);
      if (w.seconds < 0.4) { setState('idle'); if (opts.onError) opts.onError('Hold on a moment longer — that recording was empty.'); return; }
      setState('converting', 'Turning it into text…');
      var my = ++attempt;                                // Cancel while converting drops the answer
      Promise.resolve().then(function () { return opts.transcribe(w.blob); }).then(function (text) {
        if (my !== attempt) return;
        setState('idle');
        text = String(text || '').trim();
        if (text) opts.onText(text); else if (opts.onError) opts.onError('I didn’t catch any words — please try again.');
      }, function (e) { if (my !== attempt) return; setState('idle'); if (opts.onError) opts.onError((e && e.message) || 'Could not turn that into text.'); });
    }

    // ---- browser mode: the browser's own recognition, behind the same bar ----
    function sessionText() { return merge(prior.concat([merge(session)])); }
    function startBrowser() {
      prior = []; session = []; interim = ''; ended = null;
      setState('recording'); tm.textContent = '0:00';
      // Ask for the microphone first: a clear prompt and a clear error. Then let it go —
      // recognition opens its own capture, and phones won't share it.
      var ask = canRecord ? navigator.mediaDevices.getUserMedia({ audio: true }).then(function (s) { s.getTracks().forEach(function (t) { t.stop(); }); })
                          : Promise.resolve();
      ask.then(function () {
        if (state !== 'recording') return;
        var restarts = 0;
        function begin() {
          var r = new SR(); rec = r;
          r.lang = opts.lang || 'en-US'; r.continuous = true; r.interimResults = true;
          r.onresult = function (e) {
            lastVoice = Date.now();
            var fin = [], tmp = '';
            for (var i = 0; i < e.results.length; i++) {
              if (e.results[i].isFinal) fin.push(e.results[i][0].transcript); else tmp += e.results[i][0].transcript;
            }
            session = fin; interim = tmp;
          };
          r.onspeechstart = function () { lastVoice = Date.now(); };
          r.onerror = function (e) {
            if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'audio-capture') { fail(micError(e.error)); }
          };
          r.onend = function () {
            // Fold this round in; keep listening until Done (the browser stops on pauses).
            if (session.length || interim) { prior.push(merge(session.concat(interim && !session.length ? [interim] : []))); }
            session = []; interim = '';
            if (rec !== r) return;
            if (ended) { var f = ended; ended = null; rec = null; f(); return; }
            if (state === 'recording' && restarts++ < 60) { setTimeout(function () { if (rec === r && state === 'recording') { try { begin(); } catch (e) { fail(micError()); } } }, 120); }
          };
          r.start();
        }
        try { begin(); startClock(); } catch (e) { fail(micError(e)); }
      }, function (err) { fail(micError(err)); });
    }
    function finishBrowser() {
      clearInterval(tick); tick = null;
      setState('converting', 'Turning it into text…');
      var r = rec, my = ++attempt;
      var finishUp = function () {
        if (my !== attempt) return;
        var text = sessionText();
        cleanup(); setState('idle');
        if (text) opts.onText(text); else if (opts.onError) opts.onError('I didn’t catch any words — please try again.');
      };
      if (!r) { finishUp(); return; }
      var t = setTimeout(function () { ended = null; if (interim) session = session.concat([interim]); prior.push(merge(session)); session = []; finishUp(); }, 2500);
      ended = function () { clearTimeout(t); finishUp(); };
      try { r.stop(); } catch (e) { clearTimeout(t); finishUp(); }
    }

    function finish() { if (state !== 'recording') return; if (mode === 'server') finishServer(); else finishBrowser(); }
    function cancel() { attempt++; cleanup(); setState('idle'); }

    btn.addEventListener('click', function (e) {
      e.preventDefault();
      if (state === 'recording') { finish(); return; }
      if (state !== 'idle') return;
      // The mode is normally known long before the first tap; start in the same tap.
      if (mode === 'server') startServer();
      else if (mode === 'browser') startBrowser();
      else modeP.then(function (m) { if (m === 'server') startServer(); else if (m === 'browser') startBrowser(); });
    });
    done.addEventListener('click', finish);
    bar.querySelector('.av-cancel').addEventListener('click', cancel);
    global.addEventListener('pagehide', cancel);

    return { cancel: cancel, finish: finish, state: function () { return state; } };
  }

  global.AxiomVoice = { attach: attach, _merge: merge, _toWav: toWav };
})(window);
