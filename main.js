/* ==========================================================================
   ULTRALINK — receiver/transmitter engine v2
   Key upgrade over v1:
     - Bit sampling is driven by an audio-sample counter (via ScriptProcessorNode),
       not a setInterval() wall clock. No JS event-loop jitter, no drift.
     - Tone detection uses the Goertzel algorithm targeted at the two exact
       carrier frequencies, instead of a generic FFT peak search. Far better
       SNR for two known tones, and it ALWAYS returns a decisive winner
       (mag0 vs mag1) — no more "null" reads that silently eat a bit.
     - Preamble lock uses real correlation against the expected alternating
       pattern (tested at every sub-bit phase) instead of naive string
       matching against a timer-driven bit stream. Once locked, every
       subsequent bit is read from an exact sample-index boundary, so counts
       can't drift.
   ========================================================================== */

(() => {
  // ---------- TUNABLE CONSTANTS ----------
  const FREQ_0 = 18500;
  const FREQ_1 = 19500;
  let BIT_MS = 40;                 // ms per bit — the dominant speed lever (1000/BIT_MS
                                   // ≈ raw bits/sec). Goertzel tolerates a much shorter
                                   // window for two tones this far apart; 30–50ms works
                                   // on most mic/speaker pairs. NOTE: must match on BOTH
                                   // sender and receiver — RX samples on this boundary.
                                   // Selected at runtime via the SPEED MODE buttons
                                   // (FAST 30 / BALANCED 40 / RELIABLE 50), persisted to
                                   // localStorage so reloads keep the choice.
  const SUB_MS = 10;               // resolution used while hunting for the preamble
  const PREAMBLE = "1010101010101010"; // 16 bits
  const START_MARKER = "11111111";
  const END_MARKER = "00000000";
  const MIN_RATIO = 1.8;           // winning tone must beat the other by this factor
                                    // to count as a confident read during preamble hunt
  const RING_SECONDS = 3;          // how much raw audio history we keep

  // ---------- STATE ----------
  let audioCtx = null;
  let toneOsc = null;
  let micStream = null, analyser = null, micSource = null, processor = null;
  let listening = false;
  let scopeRAF = null;

  // ring buffer of raw mic samples
  let ring = null, ringLen = 0, totalWritten = 0, sampleRate = 48000;
  let bitSamples = 0, subStepSamples = 0;

  // demod state
  let mode = "HUNTING";            // HUNTING | LOCKED
  let huntNextEnd = 0;             // next window-end sample index to test while hunting
  let subTrace = [];                // {bit, m0, m1, end} during hunting
  let lockNextEnd = 0;             // next bit window-end sample index once locked
  let lockWatchdog = 0;            // sample index after which we give up and re-hunt

  let rxState = "HUNTING";          // packet parser state (separate from demod "mode")
  let rxRollingBits = "";
  let rxByteBuffer = "";
  let rxExpectedLen = 0;
  let rxDataBits = "";
  let rxByteCount = 0;
  let rxPacked = false;              // per-packet: was this frame sent 6-bit packed?

  // ---------- DOM ----------
  const $ = id => document.getElementById(id);
  const toneFreq = $("freqInput"), toneFreqVal = $("freqDisp");
  const playToneBtn = $("playBtn"), stopToneBtn = $("stopBtn");
  const micStatus = $("micStatus"), detFreq = $("detFreq");
  const detStrengthVal = $("detStrengthVal"), strengthBar = $("strengthBar");
  const decodedBit = $("decodedBit");
  const listenBtn = $("listenBtn"), stopListenBtn = $("stopListenBtn");
  const scope = $("scope");
  const txText = $("txText"), sendBtn = $("sendBtn");
  const txLen = $("txLen"), txChecksum = $("txChecksum"), txBits = $("txBits");
  const linkState = $("linkState");
  const pFreq = $("pFreq"), pBit = $("pBit"), pSync = $("pSync"),
        pBinary = $("pBinary"), pChecksum = $("pChecksum"), pText = $("pText");
  const rxBitsEl = $("rxBits"), rxMessage = $("rxMessage"), eventLog = $("eventLog");
  const speedModeWrap = $("speedMode");

  // Speed modes — confirmed-good bit periods (in ms) for typical mic/speaker pairs.
  // Each is a multiple of SUB_MS so the oversample math stays integer.
  const SPEED_MODES = [
    { id: "fast",      label: "FAST",      ms: 30, desc: "33 bps" },
    { id: "balanced",  label: "BALANCED",  ms: 40, desc: "25 bps" },
    { id: "reliable",  label: "RELIABLE",  ms: 50, desc: "20 bps" }
  ];
  const SPEED_DEFAULT_ID = "balanced";
  const SPEED_STORAGE_KEY = "ultramodem.speedMode";

  function loadSpeedModeId(){
    const saved = localStorage.getItem(SPEED_STORAGE_KEY);
    return SPEED_MODES.some(m => m.id === saved) ? saved : SPEED_DEFAULT_ID;
  }
  // Apply BIT_MS for a mode: update derived sample counts and, if live, resync the
  // demod so the next bit boundary is read at the new spacing.
  function applySpeedMode(modeId, opts){
    const mode = SPEED_MODES.find(m => m.id === modeId) ||
                 SPEED_MODES.find(m => m.id === SPEED_DEFAULT_ID);
    BIT_MS = mode.ms;
    if(sampleRate){
      bitSamples = Math.round(sampleRate * BIT_MS / 1000);
      subStepSamples = Math.round(sampleRate * SUB_MS / 1000);
      // Re-anchor the hunt/lock windows at the new spacing.
      if(listening){ resetDemodState(); rxState = "HUNTING"; }
    }
    // Reflect selection in the button group.
    if(speedModeWrap){
      speedModeWrap.querySelectorAll("[data-mode]").forEach(b => {
        const on = b.dataset.mode === mode.id;
        b.classList.toggle("active", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
    }
    if(opts && opts.persist) localStorage.setItem(SPEED_STORAGE_KEY, mode.id);
    return mode;
  }
  if(speedModeWrap){
    // Build the segmented button group once from SPEED_MODES.
    SPEED_MODES.forEach(m => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "mode-btn";
      b.dataset.mode = m.id;
      b.innerHTML = `<span class="mode-label">${m.label}</span>` +
                    `<span class="mode-desc">${m.ms}ms · ${m.desc}</span>`;
      b.addEventListener("click", () => {
        const mode = applySpeedMode(m.id, { persist: true });
        log(`Speed: ${mode.label} (${mode.ms}ms/bit, ~${mode.desc}). ` +
            `Make sure the OTHER device uses the same mode.`, "info");
      });
      speedModeWrap.appendChild(b);
    });
  }
  // Initial apply from saved/default.
  applySpeedMode(loadSpeedModeId());

  // ---------- COMPRESSION TOGGLE (6-bit packing) ----------
  // Sender-side opt-in (default OFF = original 8-bit behavior). The receiver
  // AUTO-DETECTS the mode per packet via bit 7 of the LENGTH field (the 0x80
  // bit is unused since messages cap at 64 bytes), so the receiver needs no
  // toggle — flip it on the sender anytime.
  let compress = false;
  const COMPRESS_STORAGE_KEY = "ultramodem.compress";
  const compressToggle = $("compressToggle");
  function setCompress(on, opts){
    compress = !!on;
    if(compressToggle){
      compressToggle.setAttribute("aria-pressed", compress ? "true" : "false");
      compressToggle.classList.toggle("active", compress);
      const st = compressToggle.querySelector(".toggle-state");
      if(st) st.textContent = compress ? "ON" : "OFF";
    }
    if(opts && opts.persist) localStorage.setItem(COMPRESS_STORAGE_KEY, compress ? "1" : "0");
  }
  if(compressToggle){
    setCompress(localStorage.getItem(COMPRESS_STORAGE_KEY) === "1");
    compressToggle.addEventListener("click", () => {
      setCompress(!compress, { persist: true });
      log(`Compression ${compress ? "ON (6-bit packing)" : "OFF (8-bit raw)"}. ` +
          `Receiver auto-detects — no change needed there.`, "info");
    });
  }

  function log(msg, cls){
    if (!eventLog) return;
    const d = document.createElement("div");
    d.className = cls || "";
    d.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
    eventLog.appendChild(d);
    eventLog.scrollTop = eventLog.scrollHeight;
  }

  function getCtx(){
    if(!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
  }

  // ================= TONE GENERATOR =================
  if (toneFreq) toneFreq.addEventListener("input", () => { toneFreqVal.textContent = toneFreq.value; });
  if (playToneBtn) playToneBtn.addEventListener("click", () => {
    const ctx = getCtx();
    if(ctx.state === "suspended") ctx.resume();
    toneOsc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.35;
    toneOsc.frequency.value = parseFloat(toneFreq.value);
    toneOsc.connect(gain).connect(ctx.destination);
    toneOsc.start();
    playToneBtn.disabled = true; stopToneBtn.disabled = false;
    log(`Playing test tone at ${toneFreq.value} Hz`, "info");
  });
  if (toneFreq) toneFreq.addEventListener("change", () => {
    if(toneOsc) toneOsc.frequency.setValueAtTime(parseFloat(toneFreq.value), getCtx().currentTime);
  });
  if (stopToneBtn) stopToneBtn.addEventListener("click", () => {
    if(toneOsc){ toneOsc.stop(); toneOsc.disconnect(); toneOsc = null; }
    playToneBtn.disabled = false; stopToneBtn.disabled = true;
    log("Test tone stopped");
  });

  // ================= GOERTZEL =================
  // Returns magnitude of `targetFreq` energy within `samples` (a Float32Array window).
  function goertzelMag(samples, targetFreq, sr){
    const N = samples.length;
    const k = Math.round(N * targetFreq / sr);
    const w = (2 * Math.PI / N) * k;
    const cosine = Math.cos(w), coeff = 2 * cosine, sine = Math.sin(w);
    let q0 = 0, q1 = 0, q2 = 0;
    for(let i = 0; i < N; i++){
      q0 = coeff * q1 - q2 + samples[i];
      q2 = q1; q1 = q0;
    }
    const real = q1 - q2 * cosine;
    const imag = q2 * sine;
    return Math.sqrt(real * real + imag * imag);
  }

  // Pull `len` samples ending at absolute sample index `end` out of the ring buffer.
  // Returns null if that range isn't available (too old or not written yet).
  function getWindow(end, len){
    const start = end - len;
    if(start < 0) return null;
    if(end > totalWritten) return null;
    if(totalWritten - start > ringLen) return null; // fell off the back of the ring
    const out = new Float32Array(len);
    const base = start % ringLen;
    if(base + len <= ringLen){
      out.set(ring.subarray(base, base + len));
    } else {
      const firstPart = ringLen - base;
      out.set(ring.subarray(base, ringLen), 0);
      out.set(ring.subarray(0, len - firstPart), firstPart);
    }
    return out;
  }

  // ================= MIC / RING BUFFER SETUP =================
  async function startListening(){
    try{
      micStream = await navigator.mediaDevices.getUserMedia({ audio: {
        echoCancellation:false, noiseSuppression:false, autoGainControl:false
      }});
    } catch(e){
      log("Microphone access denied or unavailable: " + e.message, "bad");
      return;
    }
    const ctx = getCtx();
    if(ctx.state === "suspended") ctx.resume();
    sampleRate = ctx.sampleRate;

    bitSamples = Math.round(sampleRate * BIT_MS / 1000);
    subStepSamples = Math.round(sampleRate * SUB_MS / 1000);
    ringLen = sampleRate * RING_SECONDS;
    ring = new Float32Array(ringLen);
    totalWritten = 0;

    micSource = ctx.createMediaStreamSource(micStream);

    // analyser purely for the visual spectrum scope (cosmetic, not used for decoding)
    analyser = ctx.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0.15;
    micSource.connect(analyser);

    // processor is the real decode path — sample-accurate, no timers
    const BUF = 2048;
    processor = ctx.createScriptProcessor(BUF, 1, 1);
    const gain = ctx.createGain();
    gain.gain.value = 0; // Mute the mic input from being played back
    micSource.connect(processor);
    processor.connect(gain);
    gain.connect(ctx.destination); // Connect to destination to keep the audio graph alive
    processor.onaudioprocess = onAudioProcess;

    listening = true;
    micStatus.textContent = "LIVE"; micStatus.className = "status-pill on";
    listenBtn.disabled = true; stopListenBtn.disabled = false;
    resetDemodState();
    resetReceiverState();
    resizeCanvas();
    log(`Microphone live. Bit=${BIT_MS}ms, window=${bitSamples} samples @ ${sampleRate}Hz.`, "info");

    drawLoop();
  }

  function stopListening(){
    listening = false;
    if(scopeRAF){ cancelAnimationFrame(scopeRAF); scopeRAF = null; }
    if(processor){ processor.onaudioprocess = null; processor.disconnect(); processor = null; }
    if(micStream){ micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    micStatus.textContent = "OFFLINE"; micStatus.className = "status-pill";
    listenBtn.disabled = false; stopListenBtn.disabled = true;
    linkState.textContent = "IDLE"; linkState.className = "status-pill";
    log("Stopped listening.");
  }

  if (listenBtn) listenBtn.addEventListener("click", startListening);
  if (stopListenBtn) stopListenBtn.addEventListener("click", stopListening);

  function onAudioProcess(e){
    const input = e.inputBuffer.getChannelData(0);
    for(let i = 0; i < input.length; i++){
      ring[totalWritten % ringLen] = input[i];
      totalWritten++;
    }
    stepDemod();
  }

  function resetDemodState(){
    mode = "HUNTING";
    huntNextEnd = bitSamples;
    subTrace = [];
    lockNextEnd = 0;
    lockWatchdog = 0;
  }

  // ================= DEMODULATOR STEP =================
  function stepDemod(){
    if(mode === "HUNTING"){
      while(totalWritten >= huntNextEnd){
        const win = getWindow(huntNextEnd, bitSamples);
        if(win){
          const m0 = goertzelMag(win, FREQ_0, sampleRate);
          const m1 = goertzelMag(win, FREQ_1, sampleRate);
          const bit = m1 > m0 ? "1" : "0";
          const ratio = Math.max(m0, m1) / (Math.min(m0, m1) + 1e-9);
          subTrace.push({ bit, ratio, end: huntNextEnd, m0, m1 });
          if(subTrace.length > 400) subTrace.shift();
          updateLiveReadout(m0, m1, bit, ratio);
          // If lock is successful, break out of the hunting loop immediately.
          if (tryLockPreamble()) break;
        }
        huntNextEnd += subStepSamples;
      }
    } else { // LOCKED
      while(totalWritten >= lockNextEnd){
        const win = getWindow(lockNextEnd, bitSamples);
        if(win){
          const m0 = goertzelMag(win, FREQ_0, sampleRate);
          const m1 = goertzelMag(win, FREQ_1, sampleRate);
          const bit = m1 > m0 ? "1" : "0";
          updateLiveReadout(m0, m1, bit, Math.max(m0,m1)/(Math.min(m0,m1)+1e-9));
          processBit(bit);
        }
        lockNextEnd += bitSamples;
        if(lockNextEnd > lockWatchdog){
          log("Lock timed out mid-packet (too long without completing). Re-hunting.", "bad");
          resetDemodState();
          rxState = "HUNTING";
          if (pSync) pSync.textContent = "—";
          linkState.textContent = "HUNTING FOR PREAMBLE"; linkState.className = "status-pill hunting";
          break;
        }
      }
    }
  }

  // Correlate the tail of subTrace against the expected preamble pattern at every
  // possible sub-bit phase, and lock on if one phase matches strongly enough.
  function tryLockPreamble(){
    const oversample = Math.round(bitSamples / subStepSamples);
    const need = PREAMBLE.length * oversample;
    if(subTrace.length < need) return false;

    let bestScore = -1, bestPhase = 0, bestEndIdx = -1;
    for(let phase = 0; phase < oversample; phase++){
      // sample one sub-entry per bit-period at this phase, from the tail backwards
      let score = 0, count = 0, idx = subTrace.length - 1 - phase;
      const picks = [];
      for(let b = PREAMBLE.length - 1; b >= 0 && idx >= 0; b--, idx -= oversample){
        picks.push(idx);
        count++;
      }
      if(count < PREAMBLE.length) continue;
      picks.reverse();
      for(let b = 0; b < PREAMBLE.length; b++){
        const entry = subTrace[picks[b]];
        if(entry.bit === PREAMBLE[b] && entry.ratio >= MIN_RATIO) score++;
      }
      if(score > bestScore){
        bestScore = score; bestPhase = phase; bestEndIdx = picks[picks.length - 1];
      }
    }

    if(bestScore >= PREAMBLE.length - 2){ // allow up to 2 noisy bits out of 16
      const lastPreambleEntry = subTrace[bestEndIdx];
      mode = "LOCKED";
      lockNextEnd = lastPreambleEntry.end + bitSamples; // right after preamble ends
      lockWatchdog = lockNextEnd + bitSamples * (8 + 8 + 64*8 + 8 + 8 + 20); // generous ceiling
      rxState = "START";
      rxByteBuffer = "";
      if (pSync) pSync.textContent = `LOCKED (${bestScore}/16)`;
      linkState.textContent = "SYNCED — READING START"; linkState.className = "status-pill on";
      log(`Preamble locked, phase=${bestPhase}, score=${bestScore}/16.`, "ok");
      return true;
    }

    return false;
  }

  function updateLiveReadout(m0, m1, bit, ratio){
    const winnerFreq = bit === "1" ? FREQ_1 : FREQ_0;
    const confident = ratio >= MIN_RATIO;
    if (detFreq) detFreq.textContent = confident ? `${winnerFreq} Hz` : "— Hz";
    const pct = Math.max(0, Math.min(100, Math.round((Math.log10(ratio) / Math.log10(8)) * 100)));
    if (detStrengthVal) detStrengthVal.textContent = pct + "%";
    if (strengthBar) strengthBar.style.width = pct + "%";
    if (decodedBit) decodedBit.textContent = confident ? bit : "–";
    if (pFreq) pFreq.textContent = confident ? winnerFreq : "—";
    if (pBit) pBit.textContent = confident ? bit : "—";
  }

  // ================= WATERFALL SPECTROGRAM =================
  // A scrolling time-frequency display: each animation frame, the existing image
  // shifts down one row and a fresh spectrum slice is painted at the top. Time
  // flows downward; the two carrier frequencies are marked with faint ticks so
  // you can watch bits land in the air. Monochrome intensity, no color noise.
  const sctx = scope ? scope.getContext("2d", { willReadFrequently: true }) : null;
  let scopeReady = false;     // canvas sized + cleared, ready to paint into
  const WF_SEARCH_MIN = 17000, WF_SEARCH_MAX = 21000; // Hz window we display
  let wfBins = null, wfBinCount = 0;
  let wfRowBuf = null;        // reused ImageData row buffer (avoids per-frame alloc)

  function resizeCanvas(){
    if (!scope) return;
    scope.width = Math.max(1, Math.floor(scope.clientWidth * devicePixelRatio));
    scope.height = Math.max(1, Math.floor(scope.clientHeight * devicePixelRatio));
    // (Re)initialize the bin→pixel column mapping and clear to background.
    if(analyser){
      wfBinCount = analyser.frequencyBinCount;
      wfBins = new Float32Array(wfBinCount);
    }
    if(sctx){
      sctx.fillStyle = "#ffffff";
      sctx.fillRect(0, 0, scope.width, scope.height);
    }
    scopeReady = true;
  }
  if (scope) window.addEventListener("resize", resizeCanvas);

  // Map an FFT bin to a canvas x-pixel within [0, w].
  function wfBinToX(binIdx, w, binHz){
    const hz = binIdx * binHz;
    const t = (hz - WF_SEARCH_MIN) / (WF_SEARCH_MAX - WF_SEARCH_MIN);
    return Math.max(0, Math.min(w - 1, Math.round(t * w)));
  }

  function drawLoop(){
    if(!listening) return;
    if(analyser && sctx && scopeReady){
      analyser.getFloatFrequencyData(wfBins);
      const sr = getCtx().sampleRate;
      const binHz = sr / analyser.fftSize;
      const w = scope.width, h = scope.height;
      if(h < 2) { scopeRAF = requestAnimationFrame(drawLoop); return; }

      // 1) Scroll existing content down by one device-pixel row.
      //    Copy rows [0 .. h-2] to [1 .. h-1]; leaves row 0 to be repainted.
      sctx.drawImage(scope, 0, 0, w, h - 1, 0, 1, w, h - 1);

      // 2) Paint the new top row directly into ImageData for speed.
      //    Intensity is a monochrome grayscale: silent → white, energy → black.
      if(!wfRowbuf || wfRowbuf.width !== w){
        wfRowbuf = sctx.createImageData(w, 1);
      }
      const data = wfRowbuf.data;
      // Fill white as the base.
      for(let x = 0; x < w; x++){
        const o = x * 4;
        data[o] = data[o+1] = data[o+2] = 255; data[o+3] = 255;
      }
      // Paint energy across the displayed frequency window.
      const minBin = Math.max(0, Math.floor(WF_SEARCH_MIN / binHz));
      const maxBin = Math.min(wfBinCount - 1, Math.ceil(WF_SEARCH_MAX / binHz));
      let prevX = -1;
      for(let b = minBin; b <= maxBin; b++){
        const db = wfBins[b];                                   // -Inf..0 dB
        // Map [-100, -30] dB → [0, 1] intensity; clamp.
        const t = Math.max(0, Math.min(1, (db + 100) / 70));
        // Perceptual-ish curve so faint tones are still visible.
        const intensity = Math.pow(t, 1.4);
        const v = Math.round(255 - intensity * 255);           // 255 white .. 0 black
        const x = wfBinToX(b, w, binHz);
        if(x === prevX) continue;                              // skip dup columns
        prevX = x;
        const o = x * 4;
        data[o] = data[o+1] = data[o+2] = v;
      }
      sctx.putImageData(wfRowbuf, 0, 0);

      // 3) Carrier marker ticks on the top row (faint gray).
      sctx.fillStyle = "#d4d4d4";
      [FREQ_0, FREQ_1].forEach(f => {
        const t = (f - WF_SEARCH_MIN) / (WF_SEARCH_MAX - WF_SEARCH_MIN);
        const x = Math.round(Math.max(0, Math.min(w - 1, t * w)));
        sctx.fillRect(x, 0, 1, 1);
      });
    }
    scopeRAF = requestAnimationFrame(drawLoop);
  }

  // ================= PACKET BUILD (TX) =================
  // 6-bit packed alphabet: 10 digits + 26 letters + space + 27 punctuation = 64
  // symbols, so each char costs 6 bits instead of 8 (~25% smaller payload).
  // Uppercase is folded to lowercase on send (round-trips as lowercase) — the one
  // lossy step, which is what holds the alphabet to 6 bits.
  const PACK_ALPHABET = `0123456789abcdefghijklmnopqrstuvwxyz .,?!'":;-_()@/+=#$%&*<>[]{}`;
  const PACK_LOOKUP = {};
  for(let i=0;i<PACK_ALPHABET.length;i++) PACK_LOOKUP[PACK_ALPHABET[i]] = i;

  // 6-bit symbol index for a char, or -1 if unsupported.
  function charToSymbol(ch){ return PACK_LOOKUP[ch.toLowerCase()] ?? -1; }

  // Encode text to packed symbols + a 6-bits-per-symbol bit string.
  // Returns { symbols, bits } on success or { error } if any char is unsupported.
  function encodeText(text){
    const symbols = []; let bits = "";
    for(let i=0;i<text.length;i++){
      const s = charToSymbol(text[i]);
      if(s < 0) return { error: `Unsupported character "${text[i]}" — use letters, digits, space, or basic punctuation.` };
      symbols.push(s);
      bits += s.toString(2).padStart(6,"0");
    }
    return { symbols, bits };
  }
  // XOR checksum over the transmitted symbol indices (not raw char codes).
  function symbolsChecksum(symbols){
    let c = 0;
    for(let i=0;i<symbols.length;i++) c ^= symbols[i];
    return c & 0xFF;
  }
  function byteToBits(n){ return (n & 0xFF).toString(2).padStart(8,"0"); }
  // buildPacket branches on the compress flag. The 0x80 bit of the LENGTH field
  // (unused, since messages cap at 64) signals the mode so the RX auto-detects.
  function buildPacket(text){
    const lengthBits = byteToBits(text.length | (compress ? 0x80 : 0x00));
    if(!compress){
      // Original 8-bit raw path.
      let dataBits = "";
      for(let i=0;i<text.length;i++) dataBits += text.charCodeAt(i).toString(2).padStart(8,"0");
      let checksum = 0;
      for(let i=0;i<text.length;i++) checksum ^= text.charCodeAt(i);
      checksum &= 0xFF;
      return {
        full: PREAMBLE + START_MARKER + lengthBits + dataBits + byteToBits(checksum) + END_MARKER,
        lengthBits, dataBits, checksumBits: byteToBits(checksum), checksum
      };
    }
    const enc = encodeText(text);
    if(enc.error) return { error: enc.error };
    const { symbols, bits: dataBits } = enc;
    const checksum = symbolsChecksum(symbols);
    const checksumBits = byteToBits(checksum);
    return {
      full: PREAMBLE + START_MARKER + lengthBits + dataBits + checksumBits + END_MARKER,
      lengthBits, dataBits, checksumBits, checksum
    };
  }

  function updateTxPreview(){
    if (!txText) return;
    const text = txText.value;
    if(!text){ txLen.textContent = "0 bytes"; txChecksum.textContent = "—"; txBits.textContent = "—"; return; }
    const pkt = buildPacket(text);
    if (txLen) txLen.textContent = text.length + " bytes";
    if(pkt.error){
      if (txChecksum) txChecksum.textContent = pkt.error;
      if (txBits) txBits.textContent = "—";
      return;
    }
    if (txChecksum) txChecksum.textContent = pkt.checksumBits + ` (${pkt.checksum})`;
    if (txBits) txBits.textContent = pkt.full;
  }
  if (txText){ txText.addEventListener("input", updateTxPreview); updateTxPreview(); }

  async function sendMessage(){
    const text = txText.value;
    if(!text){ log("Nothing to send.", "bad"); return; }
    const ctx = getCtx();
    if(ctx.state === "suspended") await ctx.resume();
    const pkt = buildPacket(text);
    if(pkt.error){ log(pkt.error, "bad"); return; }
    const bits = pkt.full;

    log(`Transmitting "${text}" — ${bits.length} bits @ ${BIT_MS}ms/bit (${(bits.length*BIT_MS/1000).toFixed(2)}s)`, "info");

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.4;
    osc.connect(gain).connect(ctx.destination);
    osc.start();

    const startTime = ctx.currentTime + 0.08; // small lead-in so the first bit isn't clipped
    for(let i=0;i<bits.length;i++){
      const f = bits[i] === "0" ? FREQ_0 : FREQ_1;
      osc.frequency.setValueAtTime(f, startTime + i * (BIT_MS/1000));
    }
    const totalDur = bits.length * (BIT_MS/1000);
    osc.stop(startTime + totalDur + 0.05);

    sendBtn.disabled = true;
    osc.onended = () => { sendBtn.disabled = false; log("Transmission complete.", "ok"); };
  }
  if (sendBtn) sendBtn.addEventListener("click", sendMessage);

  // ================= PACKET PARSER (unchanged logic, now fed decisive bits only) =================
  function resetReceiverState(){
    rxRollingBits = "";
    rxState = "HUNTING";
    rxByteBuffer = ""; rxDataBits = ""; rxExpectedLen = 0; rxByteCount = 0; rxPacked = false;
    if (pSync) pSync.textContent = "—";
    if (pBinary) pBinary.textContent = "—";
    if (pChecksum) pChecksum.textContent = "—";
    if (pText) pText.textContent = "—";
    if (rxBitsEl) rxBitsEl.innerHTML = "—";
  }

  function processBit(bit){
    rxRollingBits += bit;
    if(rxRollingBits.length > 400) rxRollingBits = rxRollingBits.slice(-400);
    renderRollingBits();

    rxByteBuffer += bit;

    if(rxState === "START"){
      if(rxByteBuffer.length === 8){
        if(rxByteBuffer === START_MARKER){
          rxState = "LENGTH"; rxByteBuffer = "";
          linkState.textContent = "READING LENGTH";
        } else {
          log("Start marker mismatch. Re-hunting.", "bad");
          reHunt();
        }
      }
      return;
    }

    if(rxState === "LENGTH"){
      if(rxByteBuffer.length === 8){
        const lengthField = parseInt(rxByteBuffer, 2);
        rxPacked = (lengthField & 0x80) !== 0;          // bit 7 = compression flag
        rxExpectedLen = lengthField & 0x7F;              // low 7 bits = char/symbol count
        rxByteBuffer = ""; rxDataBits = ""; rxByteCount = 0;
        if(rxExpectedLen === 0 || rxExpectedLen > 64){
          log(`Suspicious length ${rxExpectedLen}. Re-hunting.`, "bad");
          reHunt(); return;
        }
        rxState = "DATA";
        linkState.textContent = `READING DATA (0/${rxExpectedLen} ${rxPacked ? "symbols" : "bytes"}${rxPacked ? ", 6-bit" : ""})`;
      }
      return;
    }

    if(rxState === "DATA"){
      rxDataBits += bit;
      rxByteBuffer += bit; // kept for diagnostics; counting uses rxDataBits
      const bitsPerSymbol = rxPacked ? 6 : 8;
      if(rxDataBits.length % bitsPerSymbol === 0){
        rxByteCount = rxDataBits.length / bitsPerSymbol;
        rxByteBuffer = "";
        if (pBinary) pBinary.textContent = rxDataBits;
        if (linkState) linkState.textContent = `READING DATA (${rxByteCount}/${rxExpectedLen} ${rxPacked ? "symbols" : "bytes"})`;
        if(rxByteCount === rxExpectedLen){
          rxState = "CHECKSUM"; rxByteBuffer = "";
          linkState.textContent = "READING CHECKSUM";
        }
      }
      return;
    }

    if(rxState === "CHECKSUM"){
      if(rxByteBuffer.length === 8){
        const receivedChecksum = parseInt(rxByteBuffer, 2);
        let decodedText, expectedChecksum;
        if(rxPacked){
          const decoded = bitsToText(rxDataBits);
          decodedText = decoded.text;
          expectedChecksum = symbolsChecksum(decoded.symbols);
        } else {
          // Original 8-bit raw decode.
          decodedText = "";
          for(let i=0;i+8<=rxDataBits.length;i+=8)
            decodedText += String.fromCharCode(parseInt(rxDataBits.slice(i,i+8), 2));
          expectedChecksum = 0;
          for(let i=0;i<decodedText.length;i++) expectedChecksum ^= decodedText.charCodeAt(i);
          expectedChecksum &= 0xFF;
        }
        if (pChecksum) pChecksum.textContent = rxByteBuffer + ` (${receivedChecksum})`;
        if(receivedChecksum === expectedChecksum){
          if (pText) pText.textContent = decodedText;
          if (rxMessage){ rxMessage.textContent = decodedText; rxMessage.classList.remove("empty"); }
          linkState.textContent = "MESSAGE OK"; linkState.className = "status-pill on";
          log(`Received: "${decodedText}" — checksum OK`, "ok");
        } else {
          linkState.textContent = "CHECKSUM MISMATCH"; linkState.className = "status-pill err";
          log(`Checksum mismatch (expected ${expectedChecksum}, got ${receivedChecksum}).`, "bad");
        }
        rxState = "END"; rxByteBuffer = "";
      }
      return;
    }

    if(rxState === "END"){
      if(rxByteBuffer.length === 8){
        rxByteBuffer = "";
        reHunt();
      }
      return;
    }
  }

  function reHunt(){
    resetDemodState();
    rxState = "HUNTING";
    if (pSync) pSync.textContent = "—";
    linkState.textContent = "HUNTING FOR PREAMBLE"; linkState.className = "status-pill hunting";
  }

  // Decode a 6-bit-packed bit string back to text + symbol indices.
  function bitsToText(bits){
    let out = "", symbols = [];
    for(let i=0;i+6<=bits.length;i+=6){
      const s = parseInt(bits.slice(i,i+6), 2);
      symbols.push(s);
      out += PACK_ALPHABET[s] || "?";
    }
    return { text: out, symbols };
  }

  function renderRollingBits(){
    if (!rxBitsEl) return;
    const shown = rxRollingBits.slice(-96);
    rxBitsEl.innerHTML = shown.slice(0,-1) + (shown.length ? `<span class="cur">${shown.slice(-1)}</span>` : "");
  }

  // init
  if (listenBtn || sendBtn || playToneBtn) {
    resetReceiverState();
    log(`System ready. Bit period ${BIT_MS}ms. Press LISTEN on receiver, SEND on transmitter.`);
  }
})();
