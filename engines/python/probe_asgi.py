import os, sys, json, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from starlette.testclient import TestClient
from main import app

with TestClient(app) as c:
    msgs = []
    with c.websocket_connect("/ws") as ws:
        deadline = time.time() + 4
        # drain any immediate broadcasts (SCOREBOARD on connect, STATE_UPDATE tick, METRICS)
        while time.time() < deadline:
            try:
                raw = ws.receive(timeout=1.0)
                msgs.append(raw)
            except Exception:
                break
    print(f"connected + drained {len(msgs)} messages")
    for m in msgs[:20]:
        mt = m.get("type")
        if mt == "SCOREBOARD":
            print("  SCOREBOARD:", json.dumps(m["data"]["entries"]), "submitted=", m["data"]["submitted"])
        elif mt == "STATE_UPDATE":
            d = m["data"]
            print(f"  STATE pid={d['currentPiece']['piece']} rot={d['currentPiece']['rotation']} pos=({d['currentPiece']['position']['x']},{d['currentPiece']['position']['y']}) next=[{','.join(str(x) for x in d['nextQueue'])}] score={d['stats']['score']} level={d['stats']['level']} lines={d['stats']['linesCleared']} gameOver={d['gameOver']} ghostY={d['ghostY']}")
        elif mt == "ENGINE_METRICS":
            p = m["payload"]
            print(f"  METRICS cpuUsagePercent={p.get('cpuUsagePercent')} rssMemoryMB={p.get('rssMemoryMB')}")
        else:
            print("  OTHER", mt)

    # now exercise requests through a second connection
    with c.websocket_connect("/ws") as ws2:
        for _, obj in [
            (None, {"type":"INPUT","payload":{"action":"HARD_DROP"}}),
            (None, {"type":"SUBMIT_SCORE","payload":{"name":"alice","score":420}}),
            (None, {"type":"REQUEST_SCOREBOARD"}),
            (None, {"type":"NEW_GAME"}),
        ]:
            ws2.send_json(obj)
        got = []
        deadline = time.time() + 3
        while time.time() < deadline:
            try:
                got.append(ws2.receive(timeout=0.8))
            except Exception:
                break
    print(f"post-requests drained {len(got)} messages")
    for m in got[:15]:
        mt = m.get("type")
        if mt == "SCOREBOARD":
            print("  SCOREBOARD:", json.dumps(m["data"]["entries"]), "submitted=", m["data"]["submitted"])
        elif mt == "STATE_UPDATE":
            d = m["data"]
            print(f"  STATE pid={d['currentPiece']['piece']} gameOver={d['gameOver']}")
        else:
            print("  POST", mt, json.dumps(m.get("data","")))
