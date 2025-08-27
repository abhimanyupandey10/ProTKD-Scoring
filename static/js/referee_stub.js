/* full referee client
   events used (matches app.py):
   OUT: ref_join, ref_activity, ref_score, ref_gamjeom, ref_accept_replay, ref_decline_replay
   IN:  ref_join_result, remote_status, state, ivr_overlay, ivr_votes, ivr_result, proceed_main, force_setup, match_over
*/

document.addEventListener("DOMContentLoaded", () => {
  // ---- DOM refs ----
  const nameEl = document.getElementById("name");
  const codeEl = document.getElementById("code");
  const pwEl = document.getElementById("pw");
  const connectBtn = document.getElementById("connectBtn");
  const disconnectBtn = document.getElementById("disconnectBtn");
  const statusText = document.getElementById("statusText");
  const statusDot = document.getElementById("statusDot");
  const connLight = document.getElementById("connLight");
  const actLight = document.getElementById("actLight");
  const controls = document.getElementById("controls");
  const hint = document.getElementById("hint");

  const ivrOverlay = document.getElementById("ivrOverlay");
  const ivrBoxes = document.getElementById("ivrBoxes");
  const ivrTitle = document.getElementById("ivrTitle");
  const ivrMsg = document.getElementById("ivrMsg");
  const ivrClose = document.getElementById("ivrClose");

  const scoreButtons = Array.from(document.querySelectorAll(".score-btn"));
  const gamjeomRed = document.getElementById("gamjeomRed");
  const gamjeomBlue = document.getElementById("gamjeomBlue");
  const acceptReplayBtn = document.getElementById("acceptReplay");
  const declineReplayBtn = document.getElementById("declineReplay");

  // ---- State ----
  let socket = null;
  let joined = false;
  let tested = false;
  let matchRunning = false;

  // ---- helpers ----
  function safeTrim(v){ return (v || "").toString().trim(); }
  function curName(){ return safeTrim(nameEl.value) || "Referee"; }
  function curCode(){ return safeTrim(codeEl.value); }
  function curPW(){ return safeTrim(pwEl.value); }

  function setStatus(txt, ok = true){
    statusText.textContent = txt;
    statusDot.style.background = ok ? "#22c55e" : "#ff6b6b";
  }
  function setConnLight(on){ connLight.classList.toggle("connected", !!on); }
  function setActLight(on){ actLight.classList.toggle("activity", !!on); }
  function showControls(yes){
    controls.classList.toggle("hidden", !yes);
    disconnectBtn.classList.toggle("hidden", !yes);
    connectBtn.classList.toggle("hidden", yes);
  }
  function flash(el){
    if(!el) return;
    el.style.transform = "scale(.98)";
    setTimeout(()=> el.style.transform = "", 100);
  }

  // -- Local storage convenience
  try {
    const lc = localStorage.getItem("tkd_last_code");
    const lp = localStorage.getItem("tkd_last_pw");
    const ln = localStorage.getItem("tkd_last_name");
    if(lc) codeEl.value = lc;
    if(lp) pwEl.value = lp;
    if(ln) nameEl.value = ln;
  } catch(e){}

  // ---- socket init ----
  function initSocket(){
    if(socket && socket.connected) return;
    socket = io({
      transports: ["websocket", "polling"],
      reconnectionAttempts: 8,
      reconnectionDelay: 800
    });

    socket.on("connect", () => {
      console.log("[ref] socket connected");
      setStatus("Connected to server — not joined", true);
    });

    socket.on("disconnect", (reason) => {
      console.warn("[ref] disconnected", reason);
      joined = false; tested = false; matchRunning = false;
      showControls(false);
      setConnLight(false); setActLight(false);
      setStatus("Disconnected from server", false);
    });

    socket.on("connect_error", (err) => {
      console.error("[ref] connect_error", err);
      setStatus("Connection failed", false);
    });

    // ref_join_result
    socket.on("ref_join_result", (res) => {
      console.log("[ref] ref_join_result", res);
      if(res && res.ok){
        joined = true;
        tested = false;
        setStatus("Joined to machine: " + (res.name || curName()), true);
        setConnLight(true);
        showControls(true);
        hint.textContent = "Press any scoring button once to test (operator will light the activity light).";
        // persist
        try{ localStorage.setItem("tkd_last_code", curCode()); localStorage.setItem("tkd_last_pw", curPW()); localStorage.setItem("tkd_last_name", curName()); }catch(e){}
      } else {
        joined = false;
        showControls(false);
        setConnLight(false); setActLight(false);
        setStatus("Join failed: " + (res && res.error ? res.error : "unknown"), false);
      }
    });

    // remote_status -> payload.remotes: [{slot,name,connected,active,tested}, ...]
    socket.on("remote_status", (payload) => {
      // find our remote by name (best-effort)
      try {
        const remotes = payload && payload.remotes;
        if(!Array.isArray(remotes)) return;
        const myName = curName().toLowerCase();
        let found = null;
        for(const r of remotes){
          if(!r || !r.name) continue;
          if(r.name.toLowerCase() === myName){ found = r; break; }
        }
        if(!found){
          for(const r of remotes){
            if(!r || !r.name) continue;
            if(r.name.toLowerCase().startsWith(myName.slice(0,4))){ found = r; break; }
          }
        }
        if(found){
          setConnLight(!!found.connected);
          setActLight(!!found.active);
          if(found.tested){
            tested = true;
            hint.textContent = "Test complete — wait for operator to proceed to main.";
          }
        }
      } catch(e){ console.warn(e); }
    });

    // state: includes status (connecting|running|break|paused|over)
    socket.on("state", ({ state }) => {
      if(!state) return;
      const s = (state.status || "").toString();
      matchRunning = (s === "running");
      if(matchRunning) setStatus("Match running — you can score", true);
      else if(s === "break") setStatus("Break — scoring paused", true);
      else setStatus("Waiting — " + (s || ""), true);
    });

    socket.on("proceed_main", () => {
      matchRunning = true;
      setStatus("Operator moved to main — match running", true);
    });

    socket.on("force_setup", ({ reason }) => {
      alert("Operator returned to setup: " + (reason || ""));
      joined = false; tested = false; matchRunning = false;
      showControls(false); setConnLight(false); setActLight(false);
      setStatus("Operator requested setup", false);
    });

    // IVR overlay and votes
    socket.on("ivr_overlay", ({ color, refs }) => {
      ivrBoxes.innerHTML = "";
      ivrTitle.textContent = "Video Replay — " + (color ? color.toUpperCase() : "");
      const n = Math.max(1, (refs || 1));
      for(let i=0;i<n;i++){
        const box = document.createElement("div");
        box.className = "ivr-box";
        box.id = "ivr-box-"+(i+1);
        box.textContent = "Ref " + (i+1);
        ivrBoxes.appendChild(box);
      }
      ivrMsg.textContent = "Press Accept/Decline to vote.";
      ivrOverlay.classList.remove("hidden");
      ivrOverlay.setAttribute("aria-hidden","false");
    });

    socket.on("ivr_votes", ({ count }) => {
      for(let i=1;i<=12;i++){
        const b = document.getElementById("ivr-box-"+i);
        if(!b) continue;
        b.classList.toggle("on", i <= (count || 0));
      }
    });

    socket.on("ivr_result", ({ accepted, color, cancelled }) => {
      if(cancelled) ivrMsg.textContent = "Replay cancelled by operator";
      else ivrMsg.textContent = accepted ? "Replay accepted" : "Replay rejected";
      setTimeout(()=>{ ivrOverlay.classList.add("hidden"); ivrOverlay.setAttribute("aria-hidden","true"); }, 700);
    });

    socket.on("match_over", ({ winner, round_wins }) => {
      setStatus("Match over — winner: " + (winner || "N/A"), true);
    });
  } // end initSocket

  // ---- UI actions ----
  connectBtn.addEventListener("click", () => {
    const code = curCode(), pw = curPW(), name = curName();
    if(!code){ alert("Please enter Machine code"); codeEl.focus(); return; }
    if(!pw){ alert("Please enter Match password"); pwEl.focus(); return; }
    if(!name){ alert("Please enter Device name"); nameEl.focus(); return; }
    if(!socket) initSocket();
    setStatus("Joining...", true);
    socket.emit("ref_join", { code, password: pw, name });
  });

  disconnectBtn.addEventListener("click", () => {
    if(socket){ try{ socket.disconnect(); } catch(e){ console.warn(e); } }
    joined = false; tested = false; matchRunning = false;
    showControls(false); setConnLight(false); setActLight(false);
    setStatus("Disconnected", false);
  });

  // scoring buttons: emit ref_activity then ref_score if match running (else used as test)
  scoreButtons.forEach(btn => {
    btn.addEventListener("click", () => {
      const color = btn.getAttribute("data-color");
      const points = parseInt(btn.getAttribute("data-points") || "1", 10);
      flash(btn);
      if(!socket || !socket.connected){ alert("Not connected to operator"); return; }
      // activity (testing)
      socket.emit("ref_activity", { code: curCode(), password: curPW() });
      // actual scoring only when match running
      if(matchRunning){
        socket.emit("ref_score", { code: curCode(), password: curPW(), color, points });
        setStatus(`Sent +${points} to ${color}`, true);
      } else {
        setStatus("Test sent — wait for operator to start match", true);
      }
    });
  });

  // gamjeom
  gamjeomRed.addEventListener("click", () => {
    flash(gamjeomRed);
    if(!socket || !socket.connected){ alert("Not connected"); return; }
    socket.emit("ref_activity", { code: curCode(), password: curPW() });
    socket.emit("ref_gamjeom", { code: curCode(), password: curPW(), color: "red" });
    setStatus("Gam-jeom (red) signalled", true);
  });
  gamjeomBlue.addEventListener("click", () => {
    flash(gamjeomBlue);
    if(!socket || !socket.connected){ alert("Not connected"); return; }
    socket.emit("ref_activity", { code: curCode(), password: curPW() });
    socket.emit("ref_gamjeom", { code: curCode(), password: curPW(), color: "blue" });
    setStatus("Gam-jeom (blue) signalled", true);
  });

  // video replay vote
  acceptReplayBtn.addEventListener("click", () => {
    flash(acceptReplayBtn);
    if(!socket || !socket.connected){ alert("Not connected"); return; }
    socket.emit("ref_accept_replay", { code: curCode(), password: curPW() });
    setStatus("Replay ACCEPT sent", true);
  });
  declineReplayBtn.addEventListener("click", () => {
    flash(declineReplayBtn);
    if(!socket || !socket.connected){ alert("Not connected"); return; }
    socket.emit("ref_decline_replay", { code: curCode(), password: curPW() });
    setStatus("Replay REJECT sent", false);
  });

  ivrClose.addEventListener("click", () => {
    ivrOverlay.classList.add("hidden");
    ivrOverlay.setAttribute("aria-hidden","true");
  });

  // helper to flash local buttons
  function flash(el){ if(!el) return; el.style.transform="scale(.98)"; setTimeout(()=>el.style.transform=""); }

  // Kickstart socket (so reconnection attempts start immediately)
  initSocket();
  showControls(false);
  setStatus("Ready — enter machine code, password and name, then Connect", true);

  // convenience store values
  codeEl.addEventListener("change", ()=>{ try{ localStorage.setItem("tkd_last_code", curCode()); }catch(e){} });
  pwEl.addEventListener("change", ()=>{ try{ localStorage.setItem("tkd_last_pw", curPW()); }catch(e){} });
  nameEl.addEventListener("change", ()=>{ try{ localStorage.setItem("tkd_last_name", curName()); }catch(e){} });

}); // DOMContentLoaded
