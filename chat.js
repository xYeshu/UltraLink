/* ==========================================================================
   UltraLink — chat layer
   Loaded ONLY on chat.html, AFTER main.js. Adds:
     - A conversation log persisted to sessionStorage
     - Push-to-transmit half-duplex coordination (mute RX during TX)
     - RX interception via MutationObserver on #rxMessage (no engine edits)
   The engine (main.js) is reused entirely unchanged — we drive it through the
   same DOM elements it already binds to (#sendBtn, #listenBtn, #stopListenBtn).
   ========================================================================== */
(() => {
  "use strict";

  const $ = id => document.getElementById(id);
  const log = $("chatLog");
  const ptt = $("ptt");
  const statusBanner = $("chatStatus");
  const statusText = $("chatStatusText");
  const txText = $("txText");

  // Engine handles (bound by main.js; we just click them)
  const sendBtn = $("sendBtn");
  const listenBtn = $("listenBtn");
  const stopListenBtn = $("stopListenBtn");
  const rxMessageEl = $("rxMessage");

  if (!log || !ptt || !sendBtn || !listenBtn || !rxMessageEl) {
    console.error("[chat] required elements missing — engine did not bind");
    return;
  }

  // ---------- History store (sessionStorage) ----------
  const STORAGE_KEY = "ultramodem.chatHistory";
  let history = loadHistory();

  function loadHistory(){
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }
  function saveHistory(){
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(history)); } catch {}
  }

  function timeStr(ts){
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function renderHistory(){
    log.innerHTML = "";
    for (const m of history) {
      const row = document.createElement("div");
      row.className = `msg ${m.dir}`;
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      bubble.textContent = m.text;
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = `${m.dir === "out" ? "sent" : m.dir === "in" ? "received" : ""} · ${timeStr(m.time)}`;
      row.appendChild(bubble);
      row.appendChild(meta);
      log.appendChild(row);
    }
    log.scrollTop = log.scrollHeight;
  }

  function appendMessage(dir, text){
    history.push({ dir, text, time: Date.now() });
    // Cap history so sessionStorage doesn't grow unbounded.
    if (history.length > 200) history = history.slice(-200);
    saveHistory();
    renderHistory();
  }

  // ---------- Link status banner ----------
  function setStatus(state, text){
    statusBanner.classList.remove("listening", "transmitting", "offline");
    statusBanner.classList.add(state);
    statusText.textContent = text;
  }

  // ---------- RX interception ----------
  // The engine writes a decoded message to #rxMessage on checksum OK. We watch
  // that element and mirror each new value into the chat log. Guarded against
  // duplicate firings with a last-seen token.
  let lastRxText = null;
  const rxObserver = new MutationObserver(() => {
    const text = rxMessageEl.textContent;
    if (!text || text === lastRxText) return;
    // The engine's empty placeholder is "Waiting for transmission…" — ignore it.
    if (/waiting for transmission/i.test(text)) return;
    lastRxText = text;
    appendMessage("in", text);
  });
  rxObserver.observe(rxMessageEl, { childList: true, characterData: true, subtree: true, characterDataOldValue: false });

  // ---------- TX interception ----------
  // Half-duplex: while transmitting we must stop listening so our own speaker
  // output doesn't loop back into our mic (self-decode). We drive the engine by
  // clicking its hidden buttons in sequence:
  //   stopListenBtn  →  sendBtn  →  (wait for sendBtn to re-enable)  →  listenBtn
  let transmitting = false;

  async function transmit(){
    if (transmitting) return;
    const text = txText.value;
    if (!text) { flashPtt("Nothing to send"); return; }

    transmitting = true;
    ptt.classList.add("transmitting");
    ptt.textContent = "Transmitting…";
    ptt.disabled = true;
    setStatus("transmitting", `Transmitting “${text}”`);

    // 1) Stop listening (mute our own decode path).
    if (!stopListenBtn.disabled) stopListenBtn.click();

    // 2) Give the mic graph a beat to tear down before we blast audio.
    await sleep(150);

    // 3) Fire the engine's send. We watch sendBtn.disabled to know when the
    //    oscillator has finished (engine re-enables it on osc.onended).
    sendBtn.click();

    // Capture the text now (engine clears nothing, but be safe).
    const sentText = txText.value;

    await waitForSendComplete();

    // 4) Append to our own history.
    appendMessage("out", sentText);

    // 5) Resume listening.
    if (!listenBtn.disabled) listenBtn.click();

    transmitting = false;
    ptt.classList.remove("transmitting");
    ptt.textContent = "Hold to transmit";
    ptt.disabled = false;
    setStatus("listening", "Listening for incoming messages");
  }

  function waitForSendComplete(){
    // Engine disables sendBtn during TX and re-enables on osc.onended.
    // If it's already enabled (engine bailed early, e.g. empty), resolve now.
    return new Promise(resolve => {
      if (!sendBtn.disabled) return resolve();
      const iv = setInterval(() => {
        if (!sendBtn.disabled) { clearInterval(iv); resolve(); }
      }, 50);
      // Safety timeout — never hang the PTT if something goes wrong.
      setTimeout(() => { clearInterval(iv); resolve(); }, 30000);
    });
  }

  function flashPtt(msg){
    const orig = ptt.textContent;
    ptt.textContent = msg;
    setTimeout(() => { if (!transmitting) ptt.textContent = orig; }, 1200);
  }

  function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

  // ---------- PTT bindings ----------
  // "Hold to transmit" — mousedown/touchstart begins, mouseup/leave ends.
  // Since our TX is fire-and-forget over the oscillator (not continuous), a
  // simple click also works; we bind both click and hold for flexibility.
  ptt.addEventListener("click", transmit);

  // Enter in the compose box = transmit (feels natural for chat).
  txText.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      transmit();
    }
  });

  // ---------- Connect button: starts the engine listening ----------
  const connectBtn = $("connectBtn");
  if (connectBtn) {
    connectBtn.addEventListener("click", () => {
      listenBtn.click();
      // Engine updates micStatus asynchronously after getUserMedia resolves.
      // Watch for it to flip to LIVE, then update our banner.
      const check = setInterval(() => {
        const ms = $("micStatus");
        if (ms && ms.classList.contains("on")) {
          clearInterval(check);
          connectBtn.style.display = "none";
          ptt.style.display = "block";
          setStatus("listening", "Listening for incoming messages");
        }
      }, 100);
      // Stop polling after 10s regardless.
      setTimeout(() => clearInterval(check), 10000);
    });
  }

  // ---------- Init ----------
  renderHistory();
  setStatus("offline", "Click Connect to start listening");
})();
