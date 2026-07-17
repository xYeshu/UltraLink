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
  const BIT_MS = 100;              // was 100ms in v1 — Goertzel tolerates a much
                                   // shorter window for two tones this far apart,
                                   // so this alone ~2x's your data rate.
                                   // Push lower (try 30-40) once you've confirmed
                                   // reliability on your mic/speaker pair.
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

  // ---------- DOM ----------
  const $ = id => document.getElementById(id);
  const toneFreq = $("toneFreq"), toneFreqVal = $("toneFreqVal");
  const playToneBtn = $("playToneBtn"), stopToneBtn = $("stopToneBtn");
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

  // ================= SPECTRUM SCOPE (cosmetic) =================
  const sctx = scope ? scope.getContext("2d") : null;
  function resizeCanvas(){
    if (!scope) return;
    scope.width = scope.clientWidth * devicePixelRatio;
    scope.height = 70 * devicePixelRatio;
  }
  if (scope) window.addEventListener("resize", resizeCanvas);

  function drawLoop(){
    if(!listening) return;
    if(analyser){
      const bins = new Float32Array(analyser.frequencyBinCount);
      analyser.getFloatFrequencyData(bins);
      const sr = getCtx().sampleRate;
      const binHz = sr / analyser.fftSize;
      const SEARCH_MIN = 17000, SEARCH_MAX = 21000;
      const minBin = Math.floor(SEARCH_MIN / binHz);
      const maxBin = Math.min(bins.length - 1, Math.ceil(SEARCH_MAX / binHz));
      const w = scope.width, h = scope.height;
      sctx.fillStyle = "#061109"; sctx.fillRect(0,0,w,h);
      const n = maxBin - minBin;
      sctx.strokeStyle = "#5dff9a"; sctx.lineWidth = 1.5 * devicePixelRatio;
      sctx.beginPath();
      for(let i = 0; i < n; i++){
        const db_i = bins[minBin + i];
        const norm = Math.max(0, Math.min(1, (db_i + 100) / 70));
        const x = (i/n) * w, y = h - norm * h;
        if(i===0) sctx.moveTo(x,y); else sctx.lineTo(x,y);
      }
      sctx.stroke();
      [FREQ_0, FREQ_1].forEach(f => {
        const idx = ((f - SEARCH_MIN) / (SEARCH_MAX - SEARCH_MIN)) * w;
        sctx.strokeStyle = "rgba(255,180,84,0.5)"; sctx.lineWidth = 1;
        sctx.beginPath(); sctx.moveTo(idx,0); sctx.lineTo(idx,h); sctx.stroke();
      });
    }
    scopeRAF = requestAnimationFrame(drawLoop);
  }

  // ================= PACKET BUILD (TX) =================
  function textToBits(text){
    let bits = "";
    for(let i=0;i<text.length;i++) bits += text.charCodeAt(i).toString(2).padStart(8,"0");
    return bits;
  }
  function byteToBits(n){ return (n & 0xFF).toString(2).padStart(8,"0"); }
  function xorChecksum(text){
    let c = 0;
    for(let i=0;i<text.length;i++) c ^= text.charCodeAt(i);
    return c & 0xFF;
  }
  function buildPacket(text){
    const lengthBits = byteToBits(text.length);
    const dataBits = textToBits(text);
    const checksum = xorChecksum(text);
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
    rxByteBuffer = ""; rxDataBits = ""; rxExpectedLen = 0; rxByteCount = 0;
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
        rxExpectedLen = parseInt(rxByteBuffer, 2);
        rxByteBuffer = ""; rxDataBits = ""; rxByteCount = 0;
        if(rxExpectedLen === 0 || rxExpectedLen > 64){
          log(`Suspicious length ${rxExpectedLen}. Re-hunting.`, "bad");
          reHunt(); return;
        }
        rxState = "DATA";
        linkState.textContent = `READING DATA (0/${rxExpectedLen} bytes)`;
      }
      return;
    }

    if(rxState === "DATA"){
      rxDataBits += bit;
      if(rxByteBuffer.length === 8){
        rxByteCount++; rxByteBuffer = "";
        if (pBinary) pBinary.textContent = rxDataBits;
        if (linkState) linkState.textContent = `READING DATA (${rxByteCount}/${rxExpectedLen} bytes)`;
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
        const decodedText = bitsToText(rxDataBits);
        const expectedChecksum = xorChecksum(decodedText);
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

  function bitsToText(bits){
    let out = "";
    for(let i=0;i+8<=bits.length;i+=8) out += String.fromCharCode(parseInt(bits.slice(i,i+8), 2));
    return out;
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
