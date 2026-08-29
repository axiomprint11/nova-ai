/**
 * Speech-to-text for the Axiom chat interfaces.
 *
 * Uses the browser's built-in SpeechRecognition, so there is no extra service to
 * pay for or configure. Chrome and Edge support it; Safari partially; Firefox
 * does not, and there the mic button simply doesn't appear rather than failing
 * when clicked.
 *
 * Usage:
 *   AxiomSpeech.attach({
 *     button: micButtonEl,
 *     input:  textareaEl,
 *     onFinal: () => autoResize(textareaEl)   // optional
 *   });
 */
(function (global) {
  var SR = global.SpeechRecognition || global.webkitSpeechRecognition || null;

  function supported() { return !!SR; }

  function attach(opts) {
    var btn = opts.button, input = opts.input;
    if (!btn || !input) return null;

    if (!SR) {
      // No point showing a control that can't work.
      btn.style.display = 'none';
      return null;
    }

    var rec = new SR();
    rec.continuous = true;        // keep listening through natural pauses
    rec.interimResults = true;    // show words as they're spoken
    rec.lang = opts.lang || 'en-US';

    var listening = false;
    // Text that was already in the box when dictation started, so interim
    // results replace only the dictated part.
    var baseText = '';
    var finalText = '';
    var stopTimer = null;

    function setState(on) {
      listening = on;
      btn.classList.toggle('rec', on);
      btn.title = on ? 'Stop dictating' : 'Dictate a message';
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    }

    function render(interim) {
      var joined = (baseText + finalText + interim).replace(/\s+/g, ' ').trimStart();
      input.value = joined;
      if (opts.onInput) opts.onInput();
    }

    rec.onresult = function (e) {
      var interim = '';
      for (var i = e.resultIndex; i < e.results.length; i++) {
        var chunk = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += chunk + ' ';
        else interim += chunk;
      }
      render(interim);
      // Some browsers don't fire onend on silence; stop ourselves after a pause.
      clearTimeout(stopTimer);
      stopTimer = setTimeout(function () { if (listening) stop(); }, opts.silenceMs || 3000);
    };

    rec.onerror = function (e) {
      // 'no-speech' and 'aborted' are routine; only surface real problems.
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        if (opts.onError) opts.onError('Microphone permission was blocked. Allow it in the browser address bar.');
      } else if (e.error === 'audio-capture') {
        if (opts.onError) opts.onError('No microphone found.');
      }
      setState(false);
    };

    rec.onend = function () {
      clearTimeout(stopTimer);
      setState(false);
      if (opts.onFinal) opts.onFinal(input.value);
    };

    // Ask for the mic explicitly first. SpeechRecognition's own prompt is easy to
    // miss and its errors are vague; getUserMedia gives a clear prompt and tells
    // us precisely why it failed — which matters most inside an iframe, where the
    // parent page must have delegated the permission.
    async function ensureMic() {
      if (!global.navigator || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return true;
      try {
        var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        // We only needed the permission; recognition opens its own capture.
        stream.getTracks().forEach(function (t) { t.stop(); });
        return true;
      } catch (err) {
        var inFrame = global.self !== global.top;
        var msg;
        if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
          msg = inFrame
            ? 'The microphone is blocked for this embedded chat. Click the padlock in the address bar, ' +
              'set Microphone to Allow for this site, then reload the page. If it still fails, open the ' +
              'chat in its own tab.'
            : 'Microphone permission was denied. Click the padlock in the address bar and set Microphone to Allow.';
        } else if (err && err.name === 'NotFoundError') {
          msg = 'No microphone was found on this computer.';
        } else {
          msg = 'Could not open the microphone' + (err && err.name ? ' (' + err.name + ')' : '') + '.';
        }
        if (opts.onError) opts.onError(msg, { inFrame: inFrame, name: err && err.name });
        return false;
      }
    }

    async function start() {
      if (!(await ensureMic())) { setState(false); return; }
      baseText = input.value ? input.value.replace(/\s*$/, ' ') : '';
      finalText = '';
      try { rec.start(); setState(true); }
      catch (e) { /* already started */ }
    }
    function stop() {
      clearTimeout(stopTimer);
      try { rec.stop(); } catch (e) {}
      setState(false);
    }

    btn.addEventListener('click', function (e) {
      e.preventDefault();
      if (listening) stop(); else start();
    });

    // Never leave the mic open when the page goes away.
    global.addEventListener('beforeunload', function () { if (listening) stop(); });

    return { start: start, stop: stop, isListening: function () { return listening; } };
  }

  global.AxiomSpeech = { supported: supported, attach: attach };
})(window);
