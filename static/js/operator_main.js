// static/js/operator_main.js
// Full-featured operator UI script for Pro-TKD-Scoring
// - socket.io client
// - server-authoritative timer rendering (smooth)
// - optional client-side majority scoring (1.3s window) if server emits raw ref presses
// - quorum HUD, replay overlays, decline glow, gamjeom handling, undo, new match, event feed
//
// IMPORTANT:
//  - If you want true server-side majority scoring, also update server to emit 'ref_press' events
//    to operator room and/or to implement the server aggregation (preferred).
//  - This client supports both: it will listen for server 'ref_press' if present and handle majority locally
//    (controlled by CLIENT_SIDE_MAJORITY). If server already applies scores on each ref press, keep
//    CLIENT_SIDE_MAJORITY = false to avoid double-awarding.

(function () {
  "use strict";

  // ---------- CONFIG ----------
  const socket = io();                  // socket.io auto-load
  const CODE = window.MACHINE_CODE || (window.location.pathname.split("/").pop() || "UNKNOWN");
  const SCORING_WINDOW_MS = 1300;       // 1.3 seconds scoring window
  const TICK_MS = 200;                  // UI tick for timer & animations
  const EVENT_FEED_LIMIT = 120;
  const CLIENT_SIDE_MAJORITY = false;   // <--- set true ONLY if server emits raw 'ref_press' events and server avoids immediate scoring
  const QUIET_LOG = false;              // set true to suppress console noise

  // ---------- State ----------
  let machineState = null;              // last safe_state from server
  let prevState = null;                 // previous snapshot to diff events
  let timerState = { running: false, remaining: 0, last_started: null }; // last timer payload
  let refsList = [];                    // last remote_status.remotes array
  let scoringBuffer = [];               // [{refId, color, pts, ts}] client votes buffer (for CLIENT_SIDE_MAJORITY)
  let quorumNeeded = 1;                 // number required for majority
  let localRefIdBySlot = {};            // mapping slot index -> local ref id (if server provides ids in future)
  let connected = false;

  // ---------- DOM helpers ----------
  const $ = (id) => document.getElementById(id);
  const qsAll = (sel) => Array.from(document.querySelectorAll(sel));
  const nowMs = () => Date.now();

  function mmss_seconds(s) {
    const secs = Math.max(0, Math.floor(s));
    const m = String(Math.floor(secs / 60)).padStart(2, "0");
    const sec = String(secs % 60).padStart(2, "0");
    return `${m}:${sec}`;
  }

  function humanTime() {
    const d = new Date();
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  function log(...args) { if (!QUIET_LOG) console.log("[op]", ...args); }
  function err(...args) { console.error("[op]", ...args); }

  // ---------- UI painting helpers ----------
  function setPlayerNames(state) {
    try {
      const rn = state.red_name || state.names?.red || "RED";
      const bn = state.blue_name || state.names?.blue || "BLUE";
      if ($("name_red")) $("name_red").textContent = rn;
      if ($("name_blue")) $("name_blue").textContent = bn;
    } catch (e) {
      /* ignore */
    }
  }

  function paintScores(state) {
    try {
      if ($("score_red")) $("score_red").textContent = state.scores.red;
      if ($("score_blue")) $("score_blue").textContent = state.scores.blue;
      if ($("gj_red")) $("gj_red").textContent = state.gamjeom.red;
      if ($("gj_blue")) $("gj_blue").textContent = state.gamjeom.blue;
    } catch (e) { /* ignore */ }
  }

  function paintRoundLights(state) {
    try {
      const rw = state.round_wins || { red: 0, blue: 0 };
      for (let i = 1; i <= 3; i++) {
        const elr = $(`rw_red_${i}`), elb = $(`rw_blue_${i}`);
        if (elr) elr.className = "dot" + (rw.red >= i ? " on red" : "");
        if (elb) elb.className = "dot" + (rw.blue >= i ? " on blue" : "");
      }
    } catch (e) { /* ignore */ }
  }

  function paintIVR(state) {
    try {
      const ivr = state.ivr_available || { red: 0, blue: 0 };
      const red = $("ivr_red"), blue = $("ivr_blue");
      if (red) red.className = "card-icon" + (ivr.red > 0 ? " on red" : "");
      if (blue) blue.className = "card-icon" + (ivr.blue > 0 ? " on blue" : "");
    } catch (e) { /* ignore */ }
  }

  function paintStateToUI(state) {
    if (!state) return;
    setPlayerNames(state);
    paintScores(state);
    paintRoundLights(state);
    paintIVR(state);
    if ($("round_no")) $("round_no").textContent = state.round;
    if ($("state_text")) $("state_text").textContent = (state.status || "").toString().charAt(0).toUpperCase() + (state.status || "").toString().slice(1);
  }

  // Animate a score bump (small visual flash)
  function animateScoreBump(color) {
    try {
      const el = color === "red" ? $("score_red") : $("score_blue");
      if (!el) return;
      el.animate([{ transform: "scale(1)" }, { transform: "scale(1.06)" }, { transform: "scale(1)" }], { duration: 220, easing: "cubic-bezier(.2,.9,.25,1)" });
    } catch (e) { /* ignore */ }
  }

  // ---------- Event feed ----------
  function addEventFeedLine(txt) {
    try {
      const ul = $("event_feed");
      if (!ul) return;
      const li = document.createElement("li");
      li.textContent = `[${humanTime()}] ${txt}`;
      ul.insertBefore(li, ul.firstChild);
      // trim
      while (ul.children.length > EVENT_FEED_LIMIT) ul.removeChild(ul.lastChild);
    } catch (e) { /* ignore */ }
  }

  // ---------- Quorum HUD ----------
  function updateQuorumHUD(currentVotes = 0, needed = null) {
    try {
      const hud = $("quorum_hud");
      if (!hud) return;
      // get needed from remote_status fallback
      if (needed === null) {
        needed = quorumNeeded;
      } else {
        quorumNeeded = needed;
      }
      if ($("quorum_needed")) $("quorum_needed").textContent = String(needed);
      if ($("quorum_current")) $("quorum_current").textContent = String(currentVotes);
      const pct = Math.min(100, Math.round((currentVotes / Math.max(1, needed)) * 100));
      if ($("quorum_fill")) $("quorum_fill").style.width = `${pct}%`;
    } catch (e) { /* ignore */ }
  }

  // ---------- Referees list UI ----------
  function paintRefsList(remotesPayload) {
    try {
      const wrap = $("refs_list");
      if (!wrap) return;
      wrap.innerHTML = "";
      refsList = remotesPayload.remotes || [];
      quorumNeeded = remotesPayload.needed || Math.max(1, Math.ceil(refsList.length / 2));
      refsList.forEach((r, idx) => {
        // build ref-box
        const box = document.createElement("div");
        box.className = "ref-box";
        box.id = `ref_box_${idx + 1}`;
        const top = document.createElement("div");
        top.className = "ref-top";
        top.innerHTML = `<div class="ref-name">#${idx + 1} ${escapeHtml(r.name || ("Ref " + (idx + 1)))}</div>`;
        const lights = document.createElement("div");
        lights.className = "lights";
        const lightConn = document.createElement("span"); lightConn.className = "light" + (r.connected ? " on blue" : "");
        const lightAct = document.createElement("span"); lightAct.className = "light" + (r.active ? " on yellow" : "");
        lights.appendChild(lightConn); lights.appendChild(lightAct);
        top.appendChild(lights);
        const small = document.createElement("div");
        small.className = "small";
        small.textContent = r.tested ? "Tested ✅" : "Awaiting test";
        box.appendChild(top);
        box.appendChild(small);
        wrap.appendChild(box);
      });

      // update quorum hud
      updateQuorumHUD(0, quorumNeeded);
    } catch (e) {
      err("paintRefsList error", e);
    }
  }

  // Sanitize text for small usages
  function escapeHtml(s) {
    return String(s || "").replace(/[&<>"']/g, function (m) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[m];
    });
  }

  // ---------- Timer rendering ----------
  // server sends timer payload: { running: bool, remaining: float (sec), last_started: epoch_seconds|null }
  function applyTimerPayload(t) {
    if (!t) return;
    timerState.running = !!t.running;
    timerState.remaining = Number(t.remaining || 0);
    timerState.last_started = t.last_started || null;
    // toggle UI classes
    const timerEl = $("timer");
    if (timerEl) {
      timerEl.classList.remove("running", "paused", "break");
      if (machineState && machineState.status === "break") timerEl.classList.add("break");
      else if (timerState.running) timerEl.classList.add("running");
      else timerEl.classList.add("paused");
    }
  }

  // Fast UI tick for timer display
  function timerTick() {
    const timerEl = $("timer");
    if (!timerEl) return;
    let rem = Number(timerState.remaining || 0);
    if (timerState.running && timerState.last_started) {
      const elapsed = (Date.now() / 1000) - Number(timerState.last_started || (Date.now() / 1000));
      rem = Math.max(0, rem - elapsed);
    }
    timerEl.textContent = mmss_seconds(rem);
  }

  // ---------- Scoring buffer & majority logic (optional) ----------
  // This code activates only if CLIENT_SIDE_MAJORITY = true AND server emits 'ref_press' events.
  // 'ref_press' expected payload: { ref_slot: <1-based index>, color: "red"|"blue", points: 1|2|3, ts: epoch_ms, ref_id?:string }
  function onRefPress(evt) {
    // evt may come either as payload or event: { ref_slot, color, points, ts }
    const now = nowMs();
    const refSlot = evt.ref_slot || evt.slot || evt.slot_index || evt.refIndex;
    const color = evt.color;
    const pts = Number(evt.points || evt.pts || 1);
    const refId = evt.ref_id || `slot_${refSlot}`;
    scoringBuffer.push({ refId, refSlot, color, pts, ts: now });

    // purge older entries older than window
    scoringBuffer = scoringBuffer.filter(x => now - x.ts <= SCORING_WINDOW_MS);

    // compute counts per color
    const byColor = {};
    scoringBuffer.forEach(s => {
      byColor[s.color] = byColor[s.color] || new Set();
      byColor[s.color].add(s.refId);
    });

    // check majority
    const needed = quorumNeeded || Math.max(1, Math.ceil(refsList.length / 2));
    updateQuorumHUD(Object.keys(byColor).reduce((max, c) => Math.max(max, (byColor[c] && byColor[c].size) || 0), 0), needed);

    for (const [c, set] of Object.entries(byColor)) {
      if (set.size >= needed) {
        // award server-side via operator_adjust_score
        log("Majority reached", c, "by", Array.from(set));
        socket.emit("operator_adjust_score", { code: CODE, color: c, delta: 1 });
        addEventFeedLine(`+1 ${c.toUpperCase()} (majority by ${set.size}/${needed})`);
        // clear scoring buffer to avoid duplicate awards
        scoringBuffer = [];
        updateQuorumHUD(0, needed);
        break;
      }
    }
  }

  // If server doesn't emit ref_press but DOES emit ref_score events, we still react to state diffs.

  // ---------- Server socket bindings ----------
  socket.on("connect", () => {
    connected = true;
    log("connected -> joining operator room", CODE);
    socket.emit("operator_join", { code: CODE });
  });

  socket.on("disconnect", (reason) => {
    connected = false;
    addEventFeedLine(`Disconnected (${reason || "unknown"})`);
  });

  socket.on("connect_error", (err) => {
    err && err.message && addEventFeedLine(`Connection error: ${err.message}`);
  });

  // authoritative state (trimmed) from server
  socket.on("state", ({ state }) => {
    try {
      if (!state) return;
      // Save prev for diffing
      prevState = machineState ? JSON.parse(JSON.stringify(machineState)) : null;
      machineState = Object.assign({}, machineState || {}, state);
      // plugin: if server includes nested names in 'state' merge them
      // paint UI
      paintStateToUI(machineState);
      // detect score change events by diffing prevState -> machineState
      detectStateDiffEvents(prevState, machineState);
    } catch (e) {
      err("state handler error", e);
    }
  });

  // remote status lists connection/tested/active and 'needed' quorum
  socket.on("remote_status", (payload) => {
    try {
      if (!payload) return;
      paintRefsList(payload);
      // if operator page receives remote_status, update quorum HUD baseline
      updateQuorumHUD(0, payload.needed || Math.max(1, Math.ceil((payload.remotes || []).length / 2)));
    } catch (e) { err("remote_status handler", e); }
  });

  // timer event
  socket.on("timer", (t) => {
    try {
      applyTimerPayload(t);
      // immediate paint
      timerTick();
    } catch (e) { err("timer handler", e); }
  });

  // server told us to go back to setup (e.g. ref disconnected)
  socket.on("force_setup", ({ reason }) => {
    addEventFeedLine(`Returning to setup: ${reason || "server"}`);
    setTimeout(() => { window.location.href = "/operator/setup"; }, 250);
  });

  // round over -> reset scores and show overlay
  socket.on("round_over", ({ winner, round, round_wins }) => {
    // zero scores for next round
    try {
      if (machineState) {
        machineState.scores.red = 0;
        machineState.scores.blue = 0;
        paintScores(machineState);
        if (round_wins) machineState.round_wins = round_wins;
        paintRoundLights(machineState);
      }
    } catch (e) {}
    addEventFeedLine(winner ? `Round ${round} → ${winner.toUpperCase()} won` : `Round ${round} ended (draw)`);
    // show overlay briefly (optional)
    if (winner) {
      $("winner_name") && ($("winner_name").textContent = winner.toUpperCase());
      showOverlayWinner();
    }
  });

  // match over
  socket.on("match_over", ({ winner, round_wins }) => {
    addEventFeedLine(`Match over: ${winner.toUpperCase()}`);
    if ($("winner_name")) $("winner_name").textContent = (winner || "—").toUpperCase();
    showOverlayWinner();
  });

  // ivr overlay (operator requested replay)
  socket.on("ivr_overlay", ({ color, refs }) => {
    openReplayOverlay(color, refs);
    addEventFeedLine(`Replay requested for ${String(color).toUpperCase()}`);
  });

  // vote counts for IVR
  socket.on("ivr_votes", ({ count }) => {
    // light up first `count` boxes
    for (let i = 1; i <= 20; i++) {
      const box = $(`ivr_box_${i}`);
      if (!box) break;
      if (i <= count) box.classList.add("on");
      else box.classList.remove("on");
    }
    addEventFeedLine(`Replay votes: ${count}`);
  });

  // IVR result (accepted or not)
  socket.on("ivr_result", ({ accepted, color, cancelled }) => {
    if (accepted) {
      addEventFeedLine(`Replay accepted for ${color.toUpperCase()}`);
      // close overlay gracefully
      setTimeout(() => closeReplayOverlay(), 900);
    } else if (cancelled) {
      addEventFeedLine(`Replay cancelled`);
      closeReplayOverlay();
    } else {
      addEventFeedLine(`Replay rejected for ${color.toUpperCase()}`);
      // if overlay still visible, mark boxes as declined (red glow)
      // server may not indicate which refs declined; just show a red tint on all boxes briefly
      for (let i = 1; i <= 20; i++) {
        const b = $(`ivr_box_${i}`);
        if (!b) break;
        b.classList.add("declined");
      }
      setTimeout(() => {
        for (let i = 1; i <= 20; i++) {
          const b = $(`ivr_box_${i}`);
          if (!b) break;
          b.classList.remove("declined");
        }
        closeReplayOverlay();
      }, 1400);
    }
  });

  // Optional server raw press events (if implemented server-side).
  // payload: { ref_slot, color, points, ts, ref_id? }
  socket.on("ref_press", (payload) => {
    // Only act if we want client-side majority scoring.
    if (CLIENT_SIDE_MAJORITY) {
      onRefPress(payload);
    } else {
      // if not using client majority, we still show a brief activity highlight
      highlightRefActivity(payload && (payload.ref_slot || payload.slot || payload.refIndex));
      addEventFeedLine(`Ref press: ${payload.color} +${payload.points || 1}`);
    }
  });

  // If server emits individual ref_score events (server-forwarded),
  // show a UI animation and feed entry (note: server might already update 'state' with new scores)
  socket.on("ref_score", (payload) => {
    // payload might be { ref_slot, color, points }
    try {
      const c = payload.color || payload.side || "red";
      animateScoreBump(c);
      addEventFeedLine(`Ref ${payload.ref_slot || payload.ref || "?"} scored ${c.toUpperCase()} +${payload.points || 1}`);
    } catch (e) { /* ignore */ }
  });

  // Referee gamjeom signal (if server emits)
  socket.on("ref_gamjeom", (payload) => {
    try {
      addEventFeedLine(`Ref ${payload.ref_slot || "?"} gam-jeom for ${String(payload.color || "red").toUpperCase()}`);
    } catch (e) {}
  });

  // If server emits explicit declines with ref id info (optional)
  socket.on("ref_decline", ({ ref_slot }) => {
    const box = $(`ivr_box_${ref_slot}`);
    if (box) {
      box.classList.add("declined");
      addEventFeedLine(`Ref ${ref_slot} declined replay`);
      setTimeout(() => box.classList.remove("declined"), 1800);
    }
  });

  // Generic toast from server
  socket.on("toast", ({ msg }) => { if (msg) addEventFeedLine(msg); });

  // ---------- UI interactions wiring ----------
  function wireControls() {
    // time ops
    document.querySelectorAll(".timeops .btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const act = btn.dataset.t;
        socket.emit("timer_ctrl", { code: CODE, action: act });
      });
    });

    // corners ops
    document.querySelectorAll(".corner .ops .btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const act = btn.dataset.act;
        const color = btn.dataset.color;
        if (act === "adj") {
          const delta = parseInt(btn.dataset.delta || "0", 10) || 0;
          socket.emit("operator_adjust_score", { code: CODE, color, delta });
          addEventFeedLine(`Operator: ${delta >= 0 ? "+" : ""}${delta} ${String(color).toUpperCase()}`);
        } else if (act === "gj") {
          socket.emit("operator_gamjeom", { code: CODE, color });
          addEventFeedLine(`Operator: Gam-jeom ${String(color).toUpperCase()}`);
        } else if (act === "undo") {
          socket.emit("operator_undo", { code: CODE });
          addEventFeedLine("Operator: Undo");
        } else if (act === "declare") {
          if (confirm(`Declare ${color.toUpperCase()} winner?`)) {
            socket.emit("operator_declare_match", { code: CODE, color });
            addEventFeedLine(`Operator: Declared ${color.toUpperCase()}`);
          }
        } else if (act === "replay") {
          openReplayOverlay(color, refsList.length || 1);
          socket.emit("operator_request_replay", { code: CODE, color });
          addEventFeedLine(`Operator requested replay for ${String(color).toUpperCase()}`);
        }
      });
    });

    // replay overlay close
    const rc = $("overlay_replay_close");
    if (rc) rc.addEventListener("click", () => {
      closeReplayOverlay();
      socket.emit("operator_replay_result_ack", { code: CODE });
    });

    // winner overlay close
    const wc = $("overlay_winner_close");
    if (wc) wc.addEventListener("click", () => {
      hideOverlayWinner();
    });

    // new match
    const nm = $("new_match");
    if (nm) nm.addEventListener("click", () => {
      if (!confirm("Start a new match (resets state)?")) return;
      socket.emit("new_match", { code: CODE });
      addEventFeedLine("Operator: New match");
    });

    // category input
    const categoryInput = $("category_input");
    if (categoryInput) {
      let t = null;
      categoryInput.addEventListener("input", (e) => {
        clearTimeout(t);
        t = setTimeout(() => {
          socket.emit("operator_set_category", { code: CODE, category: e.target.value });
        }, 300);
      });
    }

    // proceed if ready (not on this main page but left in for completeness)
    const proceedBtn = $("proceed_if_ready");
    if (proceedBtn) proceedBtn.addEventListener("click", () => {
      socket.emit("operator_proceed_if_ready", { code: CODE });
    });
  }

  // ---------- Overlays ----------
  function openReplayOverlay(color, refsCount) {
    try {
      const overlay = $("overlay_replay");
      const side = $("overlay_replay_side");
      const boxes = $("overlay_replay_boxes");
      if (!overlay || !boxes) return;
      boxes.innerHTML = "";
      side && (side.textContent = (color || "").toUpperCase());
      for (let i = 0; i < Math.max(1, refsCount || 1); i++) {
        const b = document.createElement("div");
        b.className = "overlay-box";
        b.id = `ivr_box_${i + 1}`;
        b.textContent = `Ref ${i + 1}`;
        boxes.appendChild(b);
      }
      overlay.classList.remove("hidden");
    } catch (e) { err("openReplayOverlay", e); }
  }

  function closeReplayOverlay() {
    const overlay = $("overlay_replay");
    if (!overlay) return;
    overlay.classList.add("hidden");
    const boxes = $("overlay_replay_boxes");
    if (boxes) boxes.innerHTML = "";
  }

  function showOverlayWinner() {
    const o = $("overlay_winner");
    if (!o) return;
    o.classList.remove("hidden");
    // large visual animation could be added
    setTimeout(() => {
      // auto-close after few seconds optionally
    }, 800);
  }

  function hideOverlayWinner() {
    const o = $("overlay_winner");
    if (!o) return;
    o.classList.add("hidden");
  }

  // ---------- State diff detection for events ----------
  function detectStateDiffEvents(prev, current) {
    try {
      if (!current) return;
      // scores changed?
      if (prev && prev.scores) {
        const pr = prev.scores.red || 0, pb = prev.scores.blue || 0;
        const cr = current.scores.red || 0, cb = current.scores.blue || 0;
        if (cr !== pr) {
          const delta = cr - pr;
          addEventFeedLine(`${delta > 0 ? "+" : ""}${delta} RED (${pr} → ${cr})`);
          animateScoreBump("red");
        }
        if (cb !== pb) {
          const delta = cb - pb;
          addEventFeedLine(`${delta > 0 ? "+" : ""}${delta} BLUE (${pb} → ${cb})`);
          animateScoreBump("blue");
        }
      }

      // gamjeom changed
      if (prev && prev.gamjeom) {
        const gr = (current.gamjeom && current.gamjeom.red) || 0;
        const gpr = (prev.gamjeom && prev.gamjeom.red) || 0;
        if (gr !== gpr) addEventFeedLine(`Gam-jeom RED: ${gpr} → ${gr}`);
        const gb = (current.gamjeom && current.gamjeom.blue) || 0;
        const gpb = (prev.gamjeom && prev.gamjeom.blue) || 0;
        if (gb !== gpb) addEventFeedLine(`Gam-jeom BLUE: ${gpb} → ${gb}`);
      }

      // round wins
      if (prev && prev.round_wins) {
        const rwr = (current.round_wins && current.round_wins.red) || 0;
        const pwr = (prev.round_wins && prev.round_wins.red) || 0;
        if (rwr !== pwr) addEventFeedLine(`Round wins: RED ${pwr} → ${rwr}`);
        const rwb = (current.round_wins && current.round_wins.blue) || 0;
        const pwb = (prev.round_wins && prev.round_wins.blue) || 0;
        if (rwb !== pwb) addEventFeedLine(`Round wins: BLUE ${pwb} → ${rwb}`);
      }
    } catch (e) { err("diff events error", e); }
  }

  // ---------- Small UI helpers ----------
  function highlightRefActivity(slotIndex) {
    try {
      if (!slotIndex) return;
      const el = $(`ref_box_${slotIndex}`);
      if (!el) return;
      el.animate([{ transform: "translateY(0)" }, { transform: "translateY(-4px)" }, { transform: "translateY(0)" }], { duration: 260, easing: "cubic-bezier(.2,.9,.25,1)" });
      // add temporary active class to light
      const act = el.querySelector(".lights .light:nth-child(2)");
      if (act) {
        act.classList.add("on", "yellow");
        setTimeout(() => { act.classList.remove("on", "yellow"); }, 700);
      }
    } catch (e) { /* ignore */ }
  }

  // ---------- Startup wiring ----------
  function start() {
    try {
      wireControls();
      // start timer tick
      setInterval(timerTick, TICK_MS);
      addEventFeedLine(`Operator UI ready (code ${CODE})`);
      // initial join attempt
      if (socket && socket.connected) {
        socket.emit("operator_join", { code: CODE });
      }
    } catch (e) {
      err("start error", e);
    }
  }

  // Kick off
  start();

  // expose a few helpers for console debugging (optional)
  window.__TKD_OP = {
    socket,
    CODE,
    forceStateUpdate: (s) => { machineState = s; paintStateToUI(s); },
    scoringBuffer,
    setClientMajority: (v) => { /* runtime toggle */ window.__TKD_OP._CLIENT_SIDE = v; }
  };

})();
