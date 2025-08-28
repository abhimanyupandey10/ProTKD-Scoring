# taekwondo-operator/app.py
# Flask + Flask-SocketIO for Taekwondo Semi-Sensor (operator + referees)
# - server-side majority scoring (1.3s window)
# - monotonic authoritative timer
# - remote status, test lights, IVR quorum, gamjeom, undo, new match
# - mobile-friendly socket settings

from __future__ import annotations
import os
import sys
import time, math, random, string, secrets, copy
from flask import Flask, render_template, request, redirect, url_for, session
from flask_socketio import SocketIO, emit, join_room, leave_room
from werkzeug.middleware.proxy_fix import ProxyFix

# ================== Config ==================
APP_HOST = "0.0.0.0"
APP_PORT = 5000

# Socket.IO tuning (mobile-friendly)
SOCKET_KW = dict(
    cors_allowed_origins="*",
    async_mode="threading",   # ✅ FIXED: force threading for exe
    ping_interval=20,
    ping_timeout=30,
    max_http_buffer_size=1_000_000
)

MASTER_PASS = "fighters123"

# Scoring window (in seconds) for server-side majority aggregation
SCORING_WINDOW = 1.3

# Use server-side majority aggregation by default (recommended)
SERVER_SIDE_MAJORITY = True

# ================== App init ==================
# ✅ FIXED: handle templates/static when frozen into exe
if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
    BASE_DIR = sys._MEIPASS
else:
    BASE_DIR = os.path.abspath(os.path.dirname(__file__))

app = Flask(
    __name__,
    static_url_path="/static",
    template_folder=os.path.join(BASE_DIR, "templates"),
    static_folder=os.path.join(BASE_DIR, "static")
)
app.wsgi_app = ProxyFix(app.wsgi_app)
app.config["SECRET_KEY"] = secrets.token_hex(16)
socketio = SocketIO(app, **SOCKET_KW)

# ================== Time helpers ==================
def monotonic() -> float:
    return time.monotonic()

def now_wall() -> float:
    return time.time()

# ================== Utilities ==================
def gen_machine_code(n=6) -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # avoid similar chars
    return ''.join(random.choices(alphabet, k=n))

def machine_room(code: str) -> str:
    return f"mc::{code}"

def quorum_required(m: dict) -> int:
    return max(1, math.ceil(len(m["remotes"]) / 2))

def clamp_int(x, lo, hi):
    try:
        v = int(x)
    except Exception:
        v = lo
    return max(lo, min(hi, v))

# ================== In-memory model ==================
machines: dict[str, dict] = {}

def new_machine_state(
    num_refs=3,
    round_time=120,
    break_time=60,
    match_password="1234",
    category="",
    red_name="RED",
    blue_name="BLUE",
):
    return {
        # config
        "created_at": now_wall(),
        "num_refs_cfg": int(num_refs),
        "round_time": int(round_time),
        "break_time": int(break_time),
        "match_password": match_password or "1234",
        "category": category or "",
        "red_name": (red_name or "RED")[:24],
        "blue_name": (blue_name or "BLUE")[:24],
        "rounds_to_win": 2,
        "ptg_gap": 12,

        # runtime
        "status": "connecting",   # connecting | running | paused | break | over
        "round": 1,
        "round_wins": {"red": 0, "blue": 0},
        "scores": {"red": 0, "blue": 0},
        "gamjeom": {"red": 0, "blue": 0},
        "ivr_available": {"red": 1, "blue": 1},
        "ivr_pending": None,      # {"color": "red"/"blue", "votes": set(sid)}
        "remotes": {},            # sid -> {"name", "connected_at", "last_activity_mono", "tested": bool}

        # vote buffer for server-side majority scoring
        "vote_buffer": [],        # list of {"sid", "color", "points", "ts_mono"}

        # authoritative timer model (monotonic-based)
        # remaining is valid WHEN NOT running. When running the true remaining = remaining_at_last_start - (monotonic - last_started_mono)
        "timer": {
            "running": False,
            "remaining": float(round_time),
            "last_started_mono": None,
        },

        "history": [],            # undo stack
        "last_timer_emit_mono": 0.0
    }
# ================== Serialization helpers ==================
def safe_state(m: dict) -> dict:
    """Return trimmed copy of the state for sending to clients."""
    st = {
        "status": m["status"],
        "round": m["round"],
        "rounds_to_win": m["rounds_to_win"],
        "round_wins": dict(m["round_wins"]),
        "scores": dict(m["scores"]),
        "gamjeom": dict(m["gamjeom"]),
        "ivr_available": dict(m["ivr_available"]),
        "category": m.get("category", ""),
        "red_name": m.get("red_name", "RED"),
        "blue_name": m.get("blue_name", "BLUE"),
    }
    return st

def remotes_payload(m: dict) -> dict:
    now_mono = monotonic()
    lst = []
    for i, (sid, r) in enumerate(m["remotes"].items(), start=1):
        active = (r.get("last_activity_mono") is not None and (now_mono - r["last_activity_mono"]) < 2.5)
        lst.append({
            "slot": i,
            "name": r.get("name") or f"Ref {i}",
            "connected": True,
            "active": active,
            "tested": bool(r.get("tested"))
        })
    return {"remotes": lst, "count": len(m["remotes"]), "needed": m["num_refs_cfg"]}

def current_room_for_state(m: dict) -> str | None:
    for code, st in machines.items():
        if st is m:
            return machine_room(code)
    return None

def push_history(m: dict, action: dict):
    m["history"].append(action)
    if len(m["history"]) > 128:
        m["history"] = m["history"][-128:]

# ================== Timer helpers (authoritative) ==================
def timer_payload(m: dict) -> dict:
    t = m["timer"]
    if t["running"] and t["last_started_mono"] is not None:
        elapsed = monotonic() - t["last_started_mono"]
        rem = max(0.0, t["remaining"] - elapsed)
        # send last_started in wall-clock seconds for the client to render smoothly
        return {"running": True, "remaining": rem, "last_started": time.time() - elapsed}
    else:
        return {"running": False, "remaining": float(t["remaining"]), "last_started": None}

def timer_start(m: dict):
    t = m["timer"]
    if not t["running"]:
        t["running"] = True
        t["last_started_mono"] = monotonic()

def timer_pause(m: dict):
    t = m["timer"]
    if t["running"] and t["last_started_mono"] is not None:
        elapsed = monotonic() - t["last_started_mono"]
        t["remaining"] = max(0.0, t["remaining"] - elapsed)
        t["running"] = False
        t["last_started_mono"] = None

def timer_reset_round(m: dict):
    t = m["timer"]
    t["running"] = False
    t["last_started_mono"] = None
    t["remaining"] = float(m["round_time"])

def timer_reset_break(m: dict):
    t = m["timer"]
    t["running"] = False
    t["last_started_mono"] = None
    t["remaining"] = float(m["break_time"])

# ================== Round / match logic ==================
def check_ptg_and_finalize_if_needed(m: dict):
    red, blue = m["scores"]["red"], m["scores"]["blue"]
    if abs(red - blue) >= int(m["ptg_gap"]):
        finalize_round(m, ("red" if red > blue else "blue"))

def end_round_by_time(m: dict):
    # Called when round timer reaches zero
    red, blue = m["scores"]["red"], m["scores"]["blue"]
    if red == blue:
        # draw -> enter break and allow operator to decide next
        m["status"] = "break"
        timer_reset_break(m)
        room = current_room_for_state(m)
        socketio.emit("round_over", {"winner": None, "round": m["round"], "round_wins": m["round_wins"]}, room=room)
        socketio.emit("state", {"state": safe_state(m)}, room=room)
    else:
        finalize_round(m, "red" if red > blue else "blue")

def finalize_round(m: dict, winner_color: str):
    # Add round win, reset scores to zero for next round, handle match-over
    if winner_color not in ("red", "blue"):
        return
    m["round_wins"][winner_color] += 1

    # stop timer and lock
    timer_pause(m)
    room = current_room_for_state(m)

    # reset scores at round end
    m["scores"] = {"red": 0, "blue": 0}
    # gamjeom typically carries forward? we reset gamjeom for new round per requirement
    m["gamjeom"] = {"red": 0, "blue": 0}

    if m["round_wins"][winner_color] >= m["rounds_to_win"]:
        m["status"] = "over"
        socketio.emit("match_over", {"winner": winner_color, "round_wins": m["round_wins"]}, room=room)
        socketio.emit("state", {"state": safe_state(m)}, room=room)
        return

    # else start break
    m["status"] = "break"
    timer_reset_break(m)
    # start break countdown automatically
    timer_start(m)
    socketio.emit("round_over", {"winner": winner_color, "round": m["round"], "round_wins": m["round_wins"]}, room=room)
    socketio.emit("state", {"state": safe_state(m)}, room=room)
    socketio.emit("timer", timer_payload(m), room=room)

def next_round(m: dict):
    m["round"] += 1
    m["scores"] = {"red": 0, "blue": 0}
    m["gamjeom"] = {"red": 0, "blue": 0}
    m["status"] = "running"
    timer_reset_round(m)

# ================== Vote buffer / server-side majority scoring ==================
def add_vote_to_buffer(m: dict, sid: str, color: str, points: int):
    # Append vote with monotonic timestamp
    m["vote_buffer"].append({"sid": sid, "color": color, "points": int(points), "ts_mono": monotonic()})

def clean_vote_buffer(m: dict):
    cutoff = monotonic() - SCORING_WINDOW
    m["vote_buffer"] = [v for v in m["vote_buffer"] if v["ts_mono"] >= cutoff]

def process_vote_buffer(m: dict):
    """
    Inspect vote_buffer for any (color,points) group that reached quorum within SCORING_WINDOW.
    If so, award that group's points to the color and remove those contributing votes.
    This requires agreement on both color and points value (strict).
    """
    clean_vote_buffer(m)
    if not m["vote_buffer"]:
        return False

    # Build groups by (color,points) -> set(sid)
    groups: dict[tuple, set] = {}
    now = monotonic()
    cutoff = now - SCORING_WINDOW
    for v in m["vote_buffer"]:
        if v["ts_mono"] < cutoff:
            continue
        key = (v["color"], int(v["points"]))
        if key not in groups:
            groups[key] = set()
        groups[key].add(v["sid"])

    needed = quorum_required(m)

    # Choose the best group that meets quorum (prefer more votes then higher points)
    eligible = []
    for (color, pts), sids in groups.items():
        if len(sids) >= needed:
            eligible.append((len(sids), pts, color, sids))
    if not eligible:
        return False

    # Sort: largest voter count first, then highest points
    eligible.sort(key=lambda x: (x[0], x[1]), reverse=True)
    count, pts, color, sids_set = eligible[0]

    # Apply award
    push_history(m, {"op": "score", "color": color, "delta": pts, "by": list(sids_set)})
    m["scores"][color] += pts

    # Remove votes that were used (by sid)
    m["vote_buffer"] = [v for v in m["vote_buffer"] if v["sid"] not in sids_set]

    # After awarding, check PTG or other end conditions
    check_ptg_and_finalize_if_needed(m)

    # Notify clients about applied ref score (gives operator visibility)
    room = current_room_for_state(m)
    socketio.emit("ref_score_applied", {"color": color, "points": pts, "by_count": len(sids_set), "by": list(sids_set)}, room=room)
    socketio.emit("state", {"state": safe_state(m)}, room=room)
    return True

# ================== Routes ==================
@app.route("/")
def root():
    return redirect(url_for("login"))

@app.route("/operator")
def operator_root():
    return redirect(url_for("login"))

@app.route("/favicon.ico")
def favicon():
    return ("", 204)

@app.route("/operator/login", methods=["GET"])
def login():
    code = session.get("machine_code") or gen_machine_code()
    session["machine_code"] = code
    return render_template("login.html", code=code)

@app.route("/operator/login_create", methods=["POST"])
def login_create():
    master = (request.form.get("master") or "").strip()
    if master != MASTER_PASS:
        return "Invalid master password.", 403

    code = session.get("machine_code") or gen_machine_code()
    session["machine_code"] = code

    def _int(v, default):
        try:
            return int(v)
        except Exception:
            return default

    num_refs     = clamp_int(_int(request.form.get("num_refs", 3), 3), 1, 7)
    round_time   = clamp_int(_int(request.form.get("round_time", 120), 120), 20, 600)
    break_time   = clamp_int(_int(request.form.get("break_time", 60), 60), 5, 600)
    match_pass   = (request.form.get("match_password") or "1234").strip()
    category     = (request.form.get("category") or "").strip()
    red_name     = (request.form.get("red") or "RED").strip()[:24]
    blue_name    = (request.form.get("blue") or "BLUE").strip()[:24]

    machines[code] = new_machine_state(
        num_refs=num_refs,
        round_time=round_time,
        break_time=break_time,
        match_password=match_pass,
        category=category,
        red_name=red_name,
        blue_name=blue_name
    )
    return redirect(url_for("setup"))

@app.route("/operator/setup")
def setup():
    code = session.get("machine_code")
    if not code or code not in machines:
        return redirect(url_for("login"))
    return render_template("setup.html", code=code)

@app.route("/operator/main")
def main_page():
    code = session.get("machine_code")
    if not code or code not in machines:
        return redirect(url_for("login"))
    return render_template("main.html", code=code)

@app.route("/referee")
def referee_page():
    return render_template("referee_stub.html")

# ================== Socket.IO: Operator ==================
@socketio.on("operator_join")
def operator_join(data):
    code = (data or {}).get("code")
    if not code or code not in machines:
        emit("error", {"msg": "Invalid code"})
        return
    join_room(machine_room(code))
    m = machines[code]
    emit("state", {"state": safe_state(m)}, room=request.sid)
    emit("remote_status", remotes_payload(m), room=request.sid)
    emit("timer", timer_payload(m), room=request.sid)

@socketio.on("operator_set_category")
def operator_set_category(data):
    code = (data or {}).get("code"); category = (data or {}).get("category") or ""
    if code in machines:
        machines[code]["category"] = category.strip()
        socketio.emit("state", {"state": safe_state(machines[code])}, room=machine_room(code))

@socketio.on("operator_set_names")
def operator_set_names(data):
    code = (data or {}).get("code")
    if code not in machines: return
    m = machines[code]
    rn = ((data or {}).get("red_name") or m.get("red_name")).strip()[:24]
    bn = ((data or {}).get("blue_name") or m.get("blue_name")).strip()[:24]
    m["red_name"] = rn
    m["blue_name"] = bn
    socketio.emit("state", {"state": safe_state(m)}, room=machine_room(code))

@socketio.on("operator_proceed_if_ready")
def operator_proceed_if_ready(data):
    code = (data or {}).get("code")
    if code not in machines: return
    m = machines[code]
    connected = len(m["remotes"]) >= m["num_refs_cfg"]
    tested = all(r.get("tested") for r in m["remotes"].values()) and connected
    if connected and tested and m["status"] in ("connecting", "paused"):
        m["status"] = "running"
        timer_reset_round(m)
        socketio.emit("proceed_main", room=machine_room(code))
        socketio.emit("state", {"state": safe_state(m)}, room=machine_room(code))
        socketio.emit("timer", timer_payload(m), room=machine_room(code))

@socketio.on("timer_ctrl")
def timer_ctrl(data):
    code = (data or {}).get("code"); action = (data or {}).get("action")
    if code not in machines: return
    m = machines[code]
    if action == "start" and m["status"] in ("running", "break"):
        timer_start(m)
    elif action == "pause":
        timer_pause(m)
    elif action == "reset_round":
        timer_reset_round(m)
    elif action == "reset_break":
        timer_reset_break(m)
    socketio.emit("timer", timer_payload(m), room=machine_room(code))
    socketio.emit("state", {"state": safe_state(m)}, room=machine_room(code))

@socketio.on("operator_adjust_score")
def operator_adjust_score(data):
    code = (data or {}).get("code"); color = (data or {}).get("color"); delta = int((data or {}).get("delta", 0))
    if code not in machines or color not in ("red","blue") or delta == 0: return
    m = machines[code]
    push_history(m, {"op": "score", "color": color, "delta": delta})
    m["scores"][color] = max(0, m["scores"][color] + delta)
    check_ptg_and_finalize_if_needed(m)
    socketio.emit("state", {"state": safe_state(m)}, room=machine_room(code))

@socketio.on("operator_gamjeom")
def operator_gamjeom(data):
    code = (data or {}).get("code"); color = (data or {}).get("color")
    if code not in machines or color not in ("red","blue"): return
    m = machines[code]
    push_history(m, {"op": "gamjeom", "color": color})
    m["gamjeom"][color] += 1
    other = "red" if color == "blue" else "blue"
    m["scores"][other] += 1
    check_ptg_and_finalize_if_needed(m)
    socketio.emit("state", {"state": safe_state(m)}, room=machine_room(code))

@socketio.on("operator_undo")
def operator_undo(data):
    code = (data or {}).get("code")
    if code not in machines: return
    m = machines[code]
    if not m["history"]:
        emit("toast", {"msg": "Nothing to undo"}, room=request.sid)
        return
    action = m["history"].pop()
    if action["op"] == "score":
        c, d = action["color"], action["delta"]
        m["scores"][c] = max(0, m["scores"][c] - d)
    elif action["op"] == "gamjeom":
        c = action["color"]; other = "red" if c == "blue" else "blue"
        m["gamjeom"][c] = max(0, m["gamjeom"][c] - 1)
        m["scores"][other] = max(0, m["scores"][other] - 1)
    socketio.emit("state", {"state": safe_state(m)}, room=machine_room(code))

@socketio.on("operator_declare_match")
def operator_declare_match(data):
    code = (data or {}).get("code"); color = (data or {}).get("color")
    if code not in machines or color not in ("red","blue"): return
    m = machines[code]
    m["round_wins"][color] = m["rounds_to_win"]
    m["status"] = "over"
    socketio.emit("match_over", {"winner": color, "round_wins": m["round_wins"]}, room=machine_room(code))
    socketio.emit("state", {"state": safe_state(m)}, room=machine_room(code))

@socketio.on("operator_request_replay")
def operator_request_replay(data):
    code = (data or {}).get("code"); color = (data or {}).get("color")
    if code not in machines or color not in ("red","blue"): return
    m = machines[code]
    if m["ivr_pending"] is not None: return
    if m["ivr_available"][color] <= 0: return
    m["ivr_pending"] = {"color": color, "votes": set()}
    socketio.emit("ivr_overlay", {"color": color, "refs": len(m["remotes"])}, room=machine_room(code))

@socketio.on("operator_replay_result_ack")
def operator_replay_result_ack(data):
    code = (data or {}).get("code")
    if code not in machines: return
    m = machines[code]
    m["ivr_pending"] = None
    socketio.emit("state", {"state": safe_state(m)}, room=machine_room(code))

@socketio.on("operator_next_round")
def operator_next_round(data):
    code = (data or {}).get("code")
    if code not in machines: return
    m = machines[code]
    if m["status"] == "over":
        return
    next_round(m)
    socketio.emit("state", {"state": safe_state(m)}, room=machine_room(code))
    socketio.emit("timer", timer_payload(m), room=machine_room(code))

@socketio.on("new_match")
def new_match(data):
    code = (data or {}).get("code")
    if code not in machines: return
    old = machines[code]
    machines[code] = new_machine_state(
        num_refs=old["num_refs_cfg"],
        round_time=old["round_time"],
        break_time=old["break_time"],
        match_password=old["match_password"],
        category=old["category"],
        red_name=old["red_name"],
        blue_name=old["blue_name"]
    )
    socketio.emit("force_setup", {"reason": "New match"}, room=machine_room(code))

# ================== Socket.IO: Referee ==================
@socketio.on("ref_join")
def ref_join(data):
    code = (data or {}).get("code"); passwd = (data or {}).get("password"); name = ((data or {}).get("name") or "Judge").strip()[:24]
    if not code or code not in machines:
        emit("ref_join_result", {"ok": False, "error": "Invalid code"})
        return
    m = machines[code]
    if passwd != m["match_password"]:
        emit("ref_join_result", {"ok": False, "error": "Wrong password"})
        return
    join_room(machine_room(code))
    m["remotes"][request.sid] = {
        "name": name or "Judge",
        "connected_at": now_wall(),
        "last_activity_mono": None,
        "tested": False
    }
    socketio.emit("remote_status", remotes_payload(m), room=machine_room(code))
    emit("ref_join_result", {"ok": True, "name": name})

@socketio.on("ref_rename")
def ref_rename(data):
    code = (data or {}).get("code"); passwd = (data or {}).get("password"); name = ((data or {}).get("name") or "").strip()[:24]
    if not code or code not in machines or not name: return
    m = machines[code]
    if passwd != m["match_password"]: return
    if request.sid not in m["remotes"]: return
    m["remotes"][request.sid]["name"] = name
    socketio.emit("remote_status", remotes_payload(m), room=machine_room(code))

@socketio.on("ref_activity")
def ref_activity(data):
    code = (data or {}).get("code"); passwd = (data or {}).get("password")
    if not code or code not in machines: return
    m = machines[code]
    if passwd != m["match_password"]: return
    if request.sid not in m["remotes"]: return
    m["remotes"][request.sid]["last_activity_mono"] = monotonic()
    m["remotes"][request.sid]["tested"] = True
    socketio.emit("remote_status", remotes_payload(m), room=machine_room(code))

@socketio.on("ref_press")
def ref_press(data):
    """
    Preferred referee event: 'ref_press' - referee presses +1/+2/+3 or accept/decline replay.
    Payload:
      { code, password, color: "red"|"blue", points: 1|2|3 }
    Server aggregates press events within SCORING_WINDOW and awards points only when majority reached.
    """
    code = (data or {}).get("code"); passwd = (data or {}).get("password")
    color = (data or {}).get("color"); pts = int((data or {}).get("points", 0))
    if not code or code not in machines: return
    if color not in ("red", "blue") or pts not in (1,2,3): return
    m = machines[code]
    if passwd != m["match_password"]: return
    if m["status"] != "running": return
    if request.sid not in m["remotes"]: return

    m["remotes"][request.sid]["last_activity_mono"] = monotonic()
    m["remotes"][request.sid]["tested"] = True

    if SERVER_SIDE_MAJORITY:
        # Add vote to buffer and attempt processing
        add_vote_to_buffer(m, request.sid, color, pts)
        processed = process_vote_buffer(m)
        # always emit remote_status so operator sees activity light
        socketio.emit("remote_status", remotes_payload(m), room=machine_room(code))
        # optionally emit the raw ref_press to operator room for UI trace
        socketio.emit("ref_press", {"ref": request.sid, "color": color, "points": pts}, room=machine_room(code))
    else:
        # legacy: apply immediately
        push_history(m, {"op": "score", "color": color, "delta": pts})
        m["scores"][color] += pts
        check_ptg_and_finalize_if_needed(m)
        socketio.emit("state", {"state": safe_state(m)}, room=machine_room(code))
        socketio.emit("remote_status", remotes_payload(m), room=machine_room(code))

@socketio.on("ref_score")
def ref_score(data):
    # Backwards-compatible: treat like ref_press but may be direct scoring depending on SERVER_SIDE_MAJORITY
    return ref_press(data)

@socketio.on("ref_gamjeom")
def ref_gamjeom(data):
    code = (data or {}).get("code"); passwd = (data or {}).get("password"); color = (data or {}).get("color")
    if not code or code not in machines or color not in ("red","blue"): return
    m = machines[code]
    if passwd != m["match_password"]: return
    if request.sid not in m["remotes"]: return
    m["remotes"][request.sid]["last_activity_mono"] = monotonic()
    m["remotes"][request.sid]["tested"] = True
    # Here we only notify operator UI; operator can press official gamjeom button to apply.
    socketio.emit("remote_status", remotes_payload(m), room=machine_room(code))
    socketio.emit("ref_gamjeom", {"ref": request.sid, "color": color}, room=machine_room(code))

@socketio.on("ref_accept_replay")
def ref_accept_replay(data):
    code = (data or {}).get("code"); passwd = (data or {}).get("password")
    if not code or code not in machines: return
    m = machines[code]
    if passwd != m["match_password"]: return
    if m["ivr_pending"] is None: return
    m["ivr_pending"]["votes"].add(request.sid)
    socketio.emit("ivr_votes", {"count": len(m["ivr_pending"]["votes"])}, room=machine_room(code))
    if len(m["ivr_pending"]["votes"]) >= quorum_required(m):
        color = m["ivr_pending"]["color"]
        # Accept: do not consume attempt (operator-defined policy)
        m["ivr_pending"] = None
        socketio.emit("ivr_result", {"accepted": True, "color": color}, room=machine_room(code))
        socketio.emit("state", {"state": safe_state(m)}, room=machine_room(code))

@socketio.on("ref_decline_replay")
def ref_decline_replay(data):
    code = (data or {}).get("code"); passwd = (data or {}).get("password")
    if not code or code not in machines: return
    m = machines[code]
    if passwd != m["match_password"]: return
    if m["ivr_pending"] is None: return
    # we keep tally of accepts only; if remaining possible accepts cannot reach quorum, treat as reject
    total = len(m["remotes"])
    yes = len(m["ivr_pending"]["votes"])
    needed = quorum_required(m)
    # if acceptance now impossible -> reject
    if yes + (total - yes) < needed:
        color = m["ivr_pending"]["color"]
        m["ivr_available"][color] = max(0, m["ivr_available"][color] - 1)  # consume
        m["ivr_pending"] = None
        socketio.emit("ivr_result", {"accepted": False, "color": color}, room=machine_room(code))
        socketio.emit("state", {"state": safe_state(m)}, room=machine_room(code))
    else:
        # simply update vote count (no change)
        socketio.emit("ivr_votes", {"count": yes}, room=machine_room(code))

@socketio.on("disconnect")
def on_disconnect():
    sid = request.sid
    for code, m in list(machines.items()):
        if sid in m["remotes"]:
            m["remotes"].pop(sid, None)
            # remove any pending votes by this sid
            m["vote_buffer"] = [v for v in m["vote_buffer"] if v["sid"] != sid]
            # Pause running timer and mark paused state
            timer_pause(m)
            if m["status"] != "over":
                m["status"] = "paused"
            socketio.emit("remote_status", remotes_payload(m), room=machine_room(code))
            socketio.emit("force_setup", {"reason": "Referee disconnected"}, room=machine_room(code))
            break

# ================== Background / Timer loop ==================
def timer_loop():
    TICK = 0.1
    while True:
        now_mono = monotonic()
        try:
            for code, m in list(machines.items()):
                room = machine_room(code)
                t = m["timer"]

                # process vote buffer periodically too (so votes can be processed even if ref_press not triggered exactly)
                if SERVER_SIDE_MAJORITY:
                    try:
                        processed = process_vote_buffer(m)
                        if processed:
                            # state emitted by process_vote_buffer
                            pass
                    except Exception:
                        pass

                if t["running"] and t["last_started_mono"] is not None:
                    elapsed = now_mono - t["last_started_mono"]
                    remaining = max(0.0, t["remaining"] - elapsed)

                    # rate-limited timer emit
                    if now_mono - m.get("last_timer_emit_mono", 0.0) >= 0.2:
                        socketio.emit("timer", timer_payload(m), room=room)
                        m["last_timer_emit_mono"] = now_mono

                    if remaining <= 0.0:
                        # timer reached zero
                        t["running"] = False
                        t["last_started_mono"] = None
                        t["remaining"] = 0.0

                        if m["status"] == "running":
                            end_round_by_time(m)
                        elif m["status"] == "break":
                            # break finished, go to paused with round reset
                            m["status"] = "paused"
                            timer_reset_round(m)
                            socketio.emit("state", {"state": safe_state(m)}, room=room)
                            socketio.emit("timer", timer_payload(m), room=room)
                else:
                    # emit periodic timer to keep clients in sync
                    if now_mono - m.get("last_timer_emit_mono", 0.0) >= 1.0:
                        socketio.emit("timer", timer_payload(m), room=room)
                        m["last_timer_emit_mono"] = now_mono

                # periodically refresh remote_status so 'active' lights decay
                # (limit to 1Hz roughly)
                if int(now_mono) % 1 == 0:
                    socketio.emit("remote_status", remotes_payload(m), room=room)

        except Exception:
            # swallow and keep loop alive
            pass

        socketio.sleep(TICK)

socketio.start_background_task(timer_loop)

# ================== Demo machine on boot (helpful while developing) ==================
if __name__ == "__main__":
    import threading, webbrowser, time

    if not machines:
        demo = gen_machine_code()
        machines[demo] = new_machine_state()
        print(f"[demo] Machine ready. Code: {demo}")

    def open_browser():
        # Give server a moment to start before opening browser
        time.sleep(1.5)
        webbrowser.open(f"http://127.0.0.1:{APP_PORT}/operator/login")

    threading.Thread(target=open_browser, daemon=True).start()
    socketio.run(app, host=APP_HOST, port=APP_PORT, debug=False)
