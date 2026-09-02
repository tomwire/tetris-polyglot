"""Tetris Engine — Python/FastAPI entry point.

Parity with engines/node/src/main.ts + ws.ts on a single port (HTTP_PORT):
  * GET  /health            -> "OK"
  * GET  /metrics           -> Prometheus text (scraped by Caddy -> /api/python-engine/metrics)
  * WS   /ws                -> upgrade; handles INPUT / EXPORT_STATE / IMPORT_STATE /
                               REQUEST_SCOREBOARD / SUBMIT_SCORE / NEW_GAME

Single shared Game() instance for all clients (same model as node). Two loops:
  * 20 Hz server-side gravity tick  -> broadcasts STATE_UPDATE to every client
  * ~1 s runtime metrics            -> broadcasts ENGINE_METRICS
                                       (payload.cpuUsagePercent, payload.rssMemoryMB)
On connect a SCOREBOARD is pushed so the panel loads before play starts.
"""

import asyncio
import json
import os
import re
import resource
import time as _time
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import Response

from game import Game


# ──────────────── Constants ────────────────
TICK_MS = 50                     # 20 Hz gravity state broadcast (matches node)
METRICS_INTERVAL_MS = 1000       # ~1s runtime metrics broadcast
MAX_ENTRIES = 5                  # scoreboard size (matches node)
NAME_MAX_LEN = 12

# Persistent high-score board. Same on-disk shape as node scores.ts:
#   { "entries": [ { name, score, ts }, ... ] }  sorted by score desc, capped at MAX_ENTRIES.
SCORES_FILE = os.environ.get("SCORES_FILE") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "data", "scores.json"
)

_engine_name = os.getenv("ENGINE_NAME", "python-engine")


# ──────────────── Shared state ────────────────
_game = Game()
active_clients: set[WebSocket] = set()


# ──────────────── State serialization ────────────────
def _canonical_state(st) -> dict:
    """Render GameState as the protocol's canonical camelCase contract (POLYGLOT_PROTOCOL.md §STATE_UPDATE),
    matching node exactly: currentPiece/ghostY/nextQueue/held/stats./tickCount/
    lockDelayRemaining/gameOver. Canonical keys win; no reliance on frontend alias fallbacks."""
    def pos(x):
        return {"x": x.x, "y": x.y}
    cp = st.current_piece
    cur = ({
        "piece": cp.piece,
        "rotation": cp.rotation,
        "position": pos(cp.position),
    } if cp else None)
    h = st.held
    stats = st.stats
    return {
        "grid": [[int(v) for v in row] for row in st.grid],
        "currentPiece": cur,
        "ghostY": int(st.ghost_y),
        "nextQueue": [int(v) for v in (st.next_queue or [])],
        "held": {"piece": h.piece, "used": bool(h.used)},
        "stats": {
            "score": int(stats.score),
            "level": int(stats.level),
            "linesCleared": int(stats.lines_cleared),
        },
        "tickCount": int(st.tick_count),
        "lockDelayRemaining": int(st.lock_delay_remaining) if st.lock_delay_remaining is not None else -1,
        "gameOver": bool(st.game_over),
    }


# ──────────────── Scoreboard persistence (node scores.ts parity) ────────────────
_SCORE_RE = re.compile(r"[^A-Za-z0-9 _'-]")


def _load_scores() -> list[dict]:
    try:
        with open(SCORES_FILE, "r", encoding="utf-8") as fh:
            parsed = json.load(fh)
        entries = parsed.get("entries", []) if isinstance(parsed, dict) else []
        clean = []
        for e in entries:
            if (isinstance(e, dict) and isinstance(e.get("name"), str)
                    and isinstance(e.get("score"), (int, float))):
                clean.append({"name": str(e["name"]), "score": float(e["score"]),
                              "ts": float(e.get("ts") or 0)})
        return _sort_entries(clean)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return []


def _sort_entries(entries: list[dict]) -> list[dict]:
    # Sort by score desc; ties broken by newer ts first.
    return sorted(entries, key=lambda e: (-e["score"], -e["ts"]))[:MAX_ENTRIES]


def _persist(entries: list[dict]) -> None:
    try:
        os.makedirs(os.path.dirname(SCORES_FILE), exist_ok=True)
        tmp = f"{SCORES_FILE}.tmp-{os.getpid()}-{int(_time.time() * 1000)}"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump({"entries": entries}, fh, indent=2)
        os.replace(tmp, SCORES_FILE)
    except OSError:
        pass  # Best-effort; board stays in memory for this run.


def _sanitize_name(name):
    if not isinstance(name, str):
        return "Player"
    clean = _SCORE_RE.sub("", name).strip()[:NAME_MAX_LEN]
    return clean or "Player"


def top_scores(n: int = MAX_ENTRIES) -> list[dict]:
    entries = _sort_entries(_load_scores())
    return entries[:n] if n > 0 else entries


def submit_score(name, score):
    """Insert a final score; keep top MAX_ENTRIES and persist. Returns (submitted, entries)."""
    try:
        score_num = float(score)
    except (TypeError, ValueError):
        return False, top_scores()
    if not (score_num >= 0):
        return False, top_scores()

    entries = _sort_entries(_load_scores())
    qualified = len(entries) < MAX_ENTRIES or score_num > entries[-1]["score"]
    if not qualified:
        return False, entries

    entries.append({"name": _sanitize_name(name), "score": score_num, "ts": int(_time.time() * 1000)})
    entries = _sort_entries(entries)[:MAX_ENTRIES]
    _persist(entries)
    return True, entries


def _score_payload(entries: list[dict]) -> list[dict]:
    return [{"name": e["name"], "score": int(e["score"])} for e in entries]


# ──────────────── Emit / broadcast helpers (node main.ts parity) ────────────────
def _emit(obj: dict) -> None:
    """Broadcast a JSON object to every connected client, fire-and-forget per ws."""
    for ws in list(active_clients):
        asyncio.ensure_future(_safe_send(ws, obj))


async def _safe_send(ws: WebSocket, obj: dict) -> None:
    try:
        await ws.send_json(obj)
    except Exception:
        active_clients.discard(ws)


def _emit_once(ws: WebSocket, obj: dict) -> None:
    """Send directly to one ws (used for synchronous request replies)."""
    asyncio.ensure_future(_safe_send(ws, obj))


# ──────────────── Broadcast loops (node main.ts parity) ────────────────
async def tick_loop() -> None:
    counter = 0
    while True:
        try:
            await asyncio.sleep(TICK_MS / 1000.0)
            counter += 1
            if not counter % 20:
                print(f"[tick] #{counter} clients={len(active_clients)}", flush=True)
            # Game.tick() self-manages its own dt internally and returns bool; do NOT pass a dt arg.
            _game.tick()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            print(f"[tick] error: {e}", flush=True)
            continue
        _emit({"type": "STATE_UPDATE", "data": _canonical_state(_game.get_state())})


async def metrics_loop() -> None:
    while True:
        await asyncio.sleep(METRICS_INTERVAL_MS / 1000.0)
        cpu_count = os.cpu_count() or 1

        # Peak RSS (KB on Linux) -> MB; whole-host CPU% from 1-min load avg across cores.
        try:
            rss_mb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024.0
        except Exception:
            rss_mb = 0.0
        try:
            cpu_percent = min(100.0, max(0.0, (os.getloadavg()[0] / cpu_count) * 100.0))
        except (OSError, AttributeError):
            cpu_percent = 0.0

        _emit({"type": "ENGINE_METRICS", "payload": {
            "cpuUsagePercent": round(cpu_percent, 1),
            "rssMemoryMB": round(rss_mb, 1),
            "timestamp": int(_time.time() * 1000),
        }})


# ──────────────── ASGI lifecycle: register broadcast loops ────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    print("[lifespan] starting broadcast loops", flush=True)
    try:
        t1 = asyncio.ensure_future(tick_loop())
        t2 = asyncio.ensure_future(metrics_loop())
    except Exception as e:
        print(f"[lifespan] task start failed: {e}", flush=True)
        raise
    try:
        yield
    finally:
        for t in (t1, t2):
            t.cancel()


app = FastAPI(title="Tetris Engine (Python)", lifespan=lifespan)


# ──────────────── HTTP routes ────────────────
@app.get("/health")
async def health():
    return "OK"


@app.get("/metrics")
async def metrics():
    st = _game.get_state()
    rss_kb = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss  # KB (Linux)
    lines = [
        "# HELP tetris_active_sessions Number of active sessions",
        "# TYPE tetris_active_sessions gauge",
        f'tetris_active_sessions{{engine="{_engine_name}"}} {len(active_clients)}',
        "",
        "# HELP tetris_lines_cleared_total Total lines cleared",
        "# TYPE tetris_lines_cleared_total counter",
        f'tetris_lines_cleared_total{{engine="{_engine_name}"}} {st.stats.lines_cleared}',
        "",
        "# HELP process_rss_bytes RSS memory in bytes",
        "# TYPE process_rss_bytes gauge",
        f'process_rss_bytes{{engine="{_engine_name}"}} {int(rss_kb * 1024)}',
    ]
    return Response("\n".join(lines), media_type="text/plain; version=0.0.4; charset=utf-8")


# ──────────────── WS lifecycle + dispatch (node ws.ts parity) ────────────────
async def on_accept(websocket: WebSocket) -> None:
    await websocket.accept()
    active_clients.add(websocket)
    print(f"[ws] connection #{len(active_clients)}", flush=True)
    # Push the current board so the scoreboard panel loads immediately on connect.
    _emit({"type": "SCOREBOARD", "data": {
        "entries": _score_payload(top_scores()), "submitted": False}})


async def on_disconnect(ws: WebSocket) -> None:
    active_clients.discard(ws)


@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket) -> None:
    await on_accept(websocket)
    try:
        while True:
            raw = await websocket.receive_text()
            await handle_ws_message(websocket, raw)
    except WebSocketDisconnect:
        pass
    finally:
        await on_disconnect(websocket)


async def handle_ws_message(ws: WebSocket, raw: str) -> None:
    try:
        msg = json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        _emit_once(ws, {"type": "ERROR", "message": "invalid JSON"})
        return

    mtype = str(msg.get("type") or "").upper()
    payload = msg.get("payload") or {}

    if mtype == "INPUT":
        await handle_input(ws, payload)
    elif mtype == "EXPORT_STATE":
        state_str = _game.export_state()
        _game.pause()
        _emit_once(ws, {"type": "STATE_UPDATE", "data": {"state_export": state_str, "paused": True}})
    elif mtype == "IMPORT_STATE":
        await handle_import(ws, payload)
    elif mtype == "REQUEST_SCOREBOARD":
        _emit_once(ws, {"type": "SCOREBOARD", "data": {
            "entries": _score_payload(top_scores()), "submitted": False}})
    elif mtype == "SUBMIT_SCORE":
        submitted, entries = submit_score(payload.get("name"), payload.get("score"))
        # Broadcast updated board to every connected client (shared board stays consistent).
        _emit({"type": "SCOREBOARD", "data": {
            "entries": _score_payload(entries), "submitted": submitted}})
        _emit_once(ws, {"type": "SCOREBOARD", "data": {
            "entries": _score_payload(entries), "submitted": submitted}})
    elif mtype == "NEW_GAME":
        # Unfreeze any prior loss + start a fresh round so all clients see the new piece.
        _game.new_game()
        _emit({"type": "STATE_UPDATE", "data": _canonical_state(_game.get_state())})
    else:
        _emit_once(ws, {"type": "ERROR", "message": f"unknown message type: {mtype}"})


async def handle_input(ws: WebSocket, payload: dict) -> None:
    action = str(payload.get("action") or "").upper()
    if action == "MOVE_LEFT":
        _game.move_left()
    elif action == "MOVE_RIGHT":
        _game.move_right()
    elif action == "ROTATE_CW":
        _game.rotate_cw()
    elif action == "ROTATE_CCW":
        _game.rotate_ccw()
    elif action == "SOFT_DROP":
        _game.soft_drop()
    elif action == "HARD_DROP":
        _game.hard_drop()
    elif action == "HOLD":
        _game.hold()
    elif action in ("GRAVITY", ""):
        # Server-side gravity handles descent; ignore client GRAVITY / no-op.
        return
    else:
        _emit_once(ws, {"type": "ERROR", "message": f"unknown action: {action}"})
        return

    _emit_once(ws, {"type": "STATE_UPDATE", "data": _canonical_state(_game.get_state())})


async def handle_import(ws: WebSocket, payload: dict) -> None:
    state_str = payload.get("state")
    if not isinstance(state_str, str):
        _emit_once(ws, {"type": "ERROR", "message": "IMPORT_STATE requires payload.state"})
        return
    try:
        ok = _game.import_state(state_str)
    except ValueError as e:
        _emit_once(ws, {"type": "ERROR", "message": f"import error: {e}"})
        return
    if ok:
        _game.resume()
        _emit_once(ws, {"type": "STATE_UPDATE", "data": _canonical_state(_game.get_state())})
    else:
        _emit_once(ws, {"type": "ERROR", "message": "import failed — invalid state"})


# ──────────────── Entry point ────────────────
if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("HTTP_PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port)
