// ─── Imports & Types ──────────────────────────────────────────────
import React, { useState, useEffect, useRef } from 'react';
import type { ScoreEntry } from './components/Scoreboard';
import { GameOverOverlay } from './components/GameOverOverlay';
import { Scoreboard } from './components/Scoreboard';
import { MetricsHUD } from './components/MetricsHUD';
import { EngineSelector } from './components/EngineSelector';

// ── Engine routing table ─────────────────────────────────────────────
// Each engine exposes its WebSocket on a distinct mount path (see the nginx
// routes + docker compose `EXPOSE`/port map). Prod runs all four engines as
// containers on homelab_media_net, so every backend is reachable and selectable;
// switching reroutes both the game WS and scoreboard to the chosen engine.
interface EngineOpt {
  id: string;
  name: string;
  language: string;
  wsPath: string;   // WebSocket mount on the current origin
}
const ENGINES: EngineOpt[] = [
  { id: 'go',     name: 'Go',      language: 'Gorilla WebSocket + net/http',   wsPath: '/ws/go-engine' },
  { id: 'rust',   name: 'Rust',    language: 'Axum + tokio-tungstenite',       wsPath: '/ws/rust-engine' },
  // Node keeps its verified live prod mount (bare /ws). This is the ONLY
  // engine deployed in production and must never change — game WS + scoreboard
  // both rely on it.
  { id: 'node',   name: 'Node.js', language: 'Fastify + @fastify/websocket',   wsPath: '/ws' },
  { id: 'python', name: 'Python',  language: 'FastAPI + websockets',           wsPath: '/ws/python-engine' },
];
const wsPathFor = (id: string) =>
  ENGINES.find(e => e.id === id)?.wsPath ?? '/ws';

const ROWS = 20;
const COLS = 10;
const CELL = 32;

// Piece IDs (node engine uses numeric enums: I=1..L=7)
const PIECE_ID_TO_NAME: Record<number, string> = {
  1: 'I', 2: 'O', 3: 'T', 4: 'S', 5: 'Z', 6: 'J', 7: 'L'
};

// Piece shapes [pieceName][rotation] = [[dy,dx],...] relative offsets
// Matches engine: grid_y = position.y + dy, grid_x = position.x + dx
// SHAPES derived from the engine ground truth (node/python/go/rust).
// Engine is single source of truth for rot index + [dy,dx] frame; this table
// must stay byte-identical with `engines/*/dist` dumps so the board renders
// exactly where the engine places each piece (origin read from state, see below).
// Regenerate via _dumps/gen_frontend_shapes.mjs — do not hand-edit.
const SHAPES: Record<string, number[][][]> = {
  I: [
    [[-1,-2],[0,-2],[1,-2],[2,-2]],   // rot 0
    [[-2,1],[-2,0],[-2,-1],[-2,-2]],   // rot 1
    [[1,2],[0,2],[-1,2],[-2,2]],   // rot 2
    [[2,-1],[2,0],[2,1],[2,2]]    // rot 3
  ],
  O: [
    [[0,0],[-1,0],[0,-1],[-1,-1]],   // rot 0
    [[0,0],[0,1],[-1,0],[-1,1]],
    [[0,0],[1,0],[0,1],[1,1]],
    [[0,0],[0,-1],[1,0],[1,-1]]
  ],
  T: [
    [[-1,0],[0,0],[1,0],[0,1]],   // rot 0
    [[0,1],[0,0],[0,-1],[1,0]],
    [[1,0],[0,0],[-1,0],[0,-1]],
    [[0,-1],[0,0],[0,1],[-1,0]]
  ],
  S: [
    [[-1,1],[0,1],[0,0],[1,0]],   // rot 0
    [[1,1],[1,0],[0,0],[0,-1]],
    [[1,-1],[0,-1],[0,0],[-1,0]],
    [[-1,-1],[-1,0],[0,0],[0,1]]
  ],
  Z: [
    [[-1,-1],[0,-1],[0,0],[1,0]],   // rot 0
    [[-1,1],[-1,0],[0,0],[0,-1]],
    [[1,1],[0,1],[0,0],[-1,0]],
    [[1,-1],[1,0],[0,0],[0,1]]
  ],
  J: [
    [[-1,-1],[0,-1],[1,-1],[1,0]],   // rot 0
    [[-1,1],[-1,0],[-1,-1],[0,-1]],
    [[1,1],[0,1],[-1,1],[-1,0]],
    [[1,-1],[1,0],[1,1],[0,1]]
  ],
  L: [
    [[-1,1],[0,1],[1,1],[1,0]],   // rot 0
    [[1,1],[1,0],[1,-1],[0,-1]],
    [[1,-1],[0,-1],[-1,-1],[-1,0]],
    [[-1,-1],[-1,0],[-1,1],[0,1]]
  ]
};

const COLORS: Record<string, string> = {
  I:'#22d3ee', O:'#fbbf24', T:'#a78bfa', S:'#34d399', Z:'#f87171', J:'#60a5fa', L:'#fb923c'
};

const PIECE_BG: Record<string, string> = {
  I:'#083344', O:'#451a03', T:'#2e1065', S:'#064e3b', Z:'#7f1d1d', J:'#1e3a5f', L:'#431407'
};

// hex -> rgba, for rendering the ghost piece as a translucent silhouette tint.
function hexToRgba(hex: string, alpha: number): string {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

type Act = 'LEFT'|'RIGHT'|'DOWN'|'ROTATE_CW'|'ROTATE_CCW'|'HOLD'|'SOFT_DROP'|'HARD_DROP';
interface PState {
  grid: any[][];
  piece: {name:string;rot:number;x:number;y:number} | null;
  ghostY: number;
  next: string[];
  hold: string | null;
  score: number;
  level: number;
  lines: number;
  running: boolean;
  gameOver: boolean;
}
const makeGrid = (): (string|null)[][] => Array.from({length:20}, () => Array(10).fill(null));
const initial: PState = { grid:makeGrid(), piece:null, ghostY:-1, next:[], hold:null, score:0, level:1, lines:0, running:false, gameOver:false };

// Reusable centered tetrimino preview for the NEXT / HOLD boxes.
// Draws only the colored silhouette (no faint grid behind), auto-scaled so every
// orientation fits and is centered inside a fixed-size rounded box.
function PreviewPiece({ pieceName, orderIndex }: { pieceName: string | null; orderIndex: number }) {
  const imminent = orderIndex === 0;
  const color = COLORS[pieceName || 'I'];
  if (!pieceName || !SHAPES[pieceName] || !SHAPES[pieceName][0]) return null;
  const SIZE = 64;            // box size
  const rot = SHAPES[pieceName][0];
  const minDy = Math.min(...rot.map(r => r[0]));
  const maxDy = Math.max(...rot.map(r => r[0]));
  const minDx = Math.min(...rot.map(r => r[1]));
  const maxDx = Math.max(...rot.map(r => r[1]));
  const extX = maxDx - minDx + 1;   // cells wide
  const extY = maxDy - minDy + 1;   // cells tall
  const cell = Math.floor(SIZE / Math.max(extX, extY)); // fits the largest dim in the box
  const padX = Math.round((SIZE - extX * cell) / 2);
  const padY = Math.round((SIZE - extY * cell) / 2);
  return (
    <div style={{
      width: SIZE, height: SIZE, borderRadius: 10,
      background: imminent ? '#0f172a' : '#111826',
      display: 'grid', placeItems: 'center', position: 'relative',
      outline: imminent ? '2px solid #00ff88' : '2px solid transparent',
      outlineOffset: 2,
      opacity: imminent ? 1 : Math.max(0.4, 1 - 0.16 * orderIndex), // later tiles dim so the first is clearly "next"
    }}>
      {/* Green outline below/above the box already marks the imminent next piece; no label inside */}
      {rot.map(([dy, dx], j) => (
        <div key={j} style={{
          position: 'absolute',
          left: padX + (dx - minDx) * cell,
          top: padY + (dy - minDy) * cell,
          width: cell - 1, height: cell - 1, borderRadius: 2,
          background: color,
        }} />
      ))}
    </div>
  );
}

// ─── Game Component ────────────────────────────────────────────────
export default function Tetris() {
  const [s, setS] = useState<PState>(initial);
  const [ctrl, setCtrl] = useState<{ok:boolean;name:string}>({ok:false,name:''});
  const [metricsHistory, setMetricsHistory] = useState<{cpu:number;memory:number}[]>([]);
  // Active engine + live reachability (ONLINE/OFFLINE states for the selector).
  // Reached by attempting a short-lived WS handshake on each engine's mount;
  // offline engines simply render DISABLED. Probe is best-effort and only
  // meaningful in multi-engine dev; prod is node-only so this stays quiet.
  const [activeEngine, setActiveEngine] = useState<string>('node');
  const [reachable, setReachable] = useState<Record<string,boolean>>({ node: true });
  const ws = useRef<WebSocket|null>(null);
  // Scoreboard lives on its own always-on socket so the top-5 is available on
  // the splash/game-over screens (which run with !s.running and no game WS).
  const boardWs = useRef<WebSocket|null>(null);
  const [board, setBoard] = useState<ScoreEntry[]>([]);
  const [finalStats, setFinalStats] = useState({ score: 0, lines: 0, level: 1 });
  const [savedThisRound, setSavedThisRound] = useState(false);
  const lastBtn = useRef(new Map<number,boolean>());
  // HOLD is a clean edge-triggered press-to-swap on every keypress (Shift/LB/F);
  // no per-press toggle state needed — the engine handles the swap.
  // Timestamp (ms) of the last HOLD we actually sent. Used to absorb keyboard
  // auto-repeat so a held Shift can't fire rapid HOLDs that swap back and forth.
  // Unlike a boolean latch, this can never get "stuck", so a missed keyup can't
  // permanently silence subsequent presses.
  const lastHoldSentRef = useRef(0);
  const HOLD_DEBOUNCE_MS = 180;
  const dropIntervalRef = useRef<ReturnType<typeof setInterval>|null>(null);
  const gameLoopRef = useRef<ReturnType<typeof setInterval>|null>(null);
  // When a fresh round starts, flip this so the game-socket's onopen fires a
  // NEW_GAME to the engine. The shared engine freezes permanently after a loss,
  // so every new round MUST reset it or we'd hit an instant game-over screen.
  const expectNewGameRef = useRef(false);
  const speed = 1000;
  const levelSpeed = 500 - (s.level-1)*50;
  const currentSpeed = Math.max(80, levelSpeed);

  // ── WebSocket connect + initial kick ──────────────────────────────
  useEffect(() => {
    if (!s.running) return; // Only connect when game starts running
    if (ws.current?.readyState === WebSocket.OPEN) return;
    try {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      // Route to the currently selected engine so switching backends actually
      // plays on that engine (not always node at bare /ws).
      ws.current = new WebSocket(`${proto}://${window.location.host}${wsPathFor(activeEngine)}`);

      ws.current.onopen = () => {
        console.log('[WS] open');
        // Fresh round started (keyboard/gamepad or reconnect): tell the engine
        // to reset. It froze permanently after a loss, so this is required or we
        // land on an instant game-over screen with no way to play again.
        if (expectNewGameRef.current) {
          expectNewGameRef.current = false;
          ws.current?.send(JSON.stringify({ type: 'NEW_GAME' }));
        }
      };
      ws.current.onerror = (e: Event) => console.error('[WS]', e);
      ws.current.onclose = () => {
        console.log('[WS] closed');
        setS(p => ({...p, running: false}));
        clearInterval(dropIntervalRef.current!);
        clearInterval(gameLoopRef.current!);
        ws.current = null;
      };
      ws.current.onmessage = (ev: MessageEvent) => {
        try {
          const msg = JSON.parse(ev.data);

          // Host runtime metrics -> SYSTEM METRICS panel (engine broadcasts ~1/s).
          if (msg.type === 'ENGINE_METRICS') {
            const m = msg.payload || {};
            setMetricsHistory(prev => {
              const sample = {
                cpu: Number(m.cpuUsagePercent) || 0,
                memory: Number(m.rssMemoryMB) || 0,
              };
              // Rolling buffer (~60s at ~1Hz).
              return prev.length >= 60 ? [...prev.slice(1), sample] : [...prev, sample];
            });
            return;
          }

          if (msg.type !== 'STATE_UPDATE') return;
          const d = msg.data;

          // Normalize engine camelCase → frontend format
          const cp = d.currentPiece || d.current_piece;
          let piece: PState['piece'] = null;
          if (cp) {
            const nameRaw = cp.piece ?? cp.type;
            const name = typeof nameRaw === 'number' ? PIECE_ID_TO_NAME[nameRaw] : String(nameRaw);
            piece = {
              name,
              rot: cp.rotation ?? 0,
              x: (cp.position ? cp.position.x : cp.x) ?? 0,
              y: (cp.position ? cp.position.y : cp.y) ?? 0
            };
          }

          const nq = d.nextQueue || d.next_queue;
          const next = Array.isArray(nq) ? nq.map((v:any) => typeof v==='number' ? PIECE_ID_TO_NAME[v]||'I' : String(v)) : s.next;

          let hold: string | null = null;
          if (d.held) {
            const ht = d.held.piece ?? d.held.type;
            hold = typeof ht === 'number' ? PIECE_ID_TO_NAME[ht] ?? null : (String(ht) || null);
          } else if (typeof d.hold_piece === 'string') {
            hold = d.hold_piece || null;
          }

          const updatedGrid = (d.grid || p.grid).map((row:any[]) => row.map((c:any) => {
            if (!c) return null;
            if (typeof c === 'number') return COLORS[PIECE_ID_TO_NAME[c]] || '#fff';
            return String(c);
          }));
          const updatedGhostY = typeof d.ghostY === 'number' ? d.ghostY : -1;
          const go = !!d.gameOver;

          // Capture the final run stats the instant the engine signals a loss so
          // the game-over screen shows real numbers after the running state ends.
          if (go) {
            setFinalStats({
              score: d.stats?.score ?? s.score,
              lines: d.stats?.linesCleared ?? s.lines,
              level: d.stats?.level ?? 1,
            });
          }

          setS({
            grid: updatedGrid,
            piece: piece || null,
            ghostY: updatedGhostY,
            next: next || [],
            hold: hold || null,
            score: d.stats?.score ?? 0,
            level: d.stats?.level ?? 1,
            lines: d.stats?.linesCleared ?? 0,
            running: !go,
            gameOver: go
          });
        } catch(e) { console.error('[WS] parse', e); }
      };
    } catch(e) { console.error('[WS] fail', e); }
    return () => { ws.current?.close(); ws.current = null; };
  }, [s.running, activeEngine]); // Reconnect on start AND when backend switches

  // ── Scoreboard save: POST a final score to the top-5 board ───────────
  const submitScore = (rawName: string) => {
    const nm = rawName.trim() || 'Player';
    if (!boardWs.current || boardWs.current.readyState !== WebSocket.OPEN) return;
    boardWs.current.send(JSON.stringify({ type: 'SUBMIT_SCORE', payload: { name: nm, score: finalStats.score } }));
    setSavedThisRound(true);
  };

  // ── Scoreboard socket (always connected) — fetch + stay live for submits ──
  useEffect(() => {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    // Scoreboard follows the active engine so submits land on the backend you're playing.
    const url = `${proto}://${window.location.host}${wsPathFor(activeEngine)}`;
    let stopped = false;

    // registerClient() broadcasts SCOREBOARD on connect, but we also
    // REQUEST_SCOREBOARD so the board load is deterministic if that path ever
    // changes.
    const wire = (w: WebSocket) => {
      w.onopen = () => w.send(JSON.stringify({ type: 'REQUEST_SCOREBOARD' }));
      w.onerror = () => {};
      w.onmessage = (ev: MessageEvent) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'SCOREBOARD') {
            setBoard((msg.data?.entries as ScoreEntry[]) ?? []);
            // Server marks the authoritative "saved" confirm with submitted:true.
            if (msg.data?.submitted) setSavedThisRound(true);
          }
        } catch { /* ignore non-JSON */ }
      };
      w.onclose = () => { if (!stopped) setTimeout(() => connect(), 1000); };
    };

    const connect = () => {
      if (stopped || boardWs.current?.readyState === WebSocket.OPEN) return;
      const w = new WebSocket(url);
      boardWs.current = w;
      wire(w);
    };

    connect();

    return () => { stopped = true; boardWs.current?.close(); boardWs.current = null; };
  }, []);

  // ── Send input action over the live (game) WebSocket ─────────────────
  const send = (a: Act) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({ type: 'INPUT', payload: { action: a } }));
    }
  };

  // ── Start game: flip running → triggers the WS-connect effect above ─
  const startGame = () => {
    if (s.running) return;
    setSavedThisRound(false);
    // A fresh round must reset the shared engine. If the game socket is already
    // open we're typically replaying after a loss (the onclose/null only happens
    // on disconnect), so tell it to reset right now; otherwise the pending
    // expectNewGameRef gate fires when the freshly-created socket opens.
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({ type: 'NEW_GAME' }));
      // Handled inline; leave the reconnect gate untouched so a later genuine
      // reconnect also resets the engine.
    } else {
      expectNewGameRef.current = true;
    }
    setS(p => ({ ...p, running: true }));
  };

  // ── Reachability probe ────────────────────────────────────────────
  // Attempt a short-lived WS handshake to every engine; mark ONLINE on open,
  // OFFLINE if it fails/times out. Re-polls so containers that come up later
  // (dev) flip from DISABLED → selectable without a reload.
  const probeReachable = React.useCallback(() => {
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const next: Record<string, boolean> = {};
    ENGINES.forEach((eng) => {
      let done = false;
      try {
        const w = new WebSocket(`${proto}://${window.location.host}${eng.wsPath}`);
        w.onopen = () => { done = true; next[eng.id] = true; try { w.close(); } catch {} };
        w.onerror = () => { if (!done) { done = true; next[eng.id] = false; } };
        w.onclose = () => { if (!done) { done = true; next[eng.id] = false; } };
        setTimeout(() => { if (!done) { done = true; next[eng.id] = false; try { w.close(); } catch {} } }, 1500);
      } catch {
        next[eng.id] = false;
      }
    });
    setReachable((cur) => ({ ...cur, ...next }));
  }, []);
  React.useEffect(() => {
    probeReachable();
    const t = setInterval(probeReachable, 15000);
    return () => { clearInterval(t); };
  }, [probeReachable]);

  // ── Engine switcher ───────────────────────────────────────────────
  const switchEngine = (id: string) => {
    // Only refuse a CONFIRMED-offline backend (=== false). Undefined = probe not
    // finished yet or known-up, so allow the switch. This prevents the selector from
    // being permanently stuck on node when no async reachability check has run yet.
    if (reachable[id] === false) return;
    setActiveEngine(id);
    setS(p => ({...p, running: false}));
    ws.current?.close();
    clearInterval(dropIntervalRef.current!);
    clearInterval(gameLoopRef.current!);

      // Close any live socket and drop the handle. The game-WS effect (now keyed
      // on activeEngine via wsPathFor) creates a fresh, fully-wired socket the
      // moment play starts on the newly selected backend. We must NOT leave a
      // bare handshake socket here — it would carry no message handler.
      setS(p => ({...p, running: false}));
      ws.current?.close();
      ws.current = null;
      clearInterval(dropIntervalRef.current!);
      clearInterval(gameLoopRef.current!);
  };

  // ── Gamepad polling ───────────────────────────────────────────────
  useEffect(() => {
    const gpMap = new Map<number, Act>([
      [0,'ROTATE_CW'],   // A / ✓
      [1,'ROTATE_CCW'],  // B / ○
      [2,'MOVE_LEFT'],   // X / △
      [3,'MOVE_RIGHT'],  // Y / □
      [4,'HOLD'],        // LB (press twice for swap)
      [5,'SOFT_DROP'],   // RB
      [6,'HARD_DROP'],   // RT
      [7,'HARD_DROP']    // LT
    ]);
    const poll = () => {
      const gp = navigator.getGamepads()?.[0];
      if (gp) {
        if (!ctrl.ok) setCtrl({ok:true, name: gp.id||'Gamepad'});
        for (let i=0;i<gp.buttons.length;i++) {
          const p = gp.buttons[i].pressed;
          const prev = lastBtn.current.get(i)||false;
          // First button press on the start screen launches the game.
          if (!s.running && p && !prev) {
            startGame();
          } else if (p && !prev && gpMap.has(i)) {
            send(gpMap.get(i)!);
          }
          lastBtn.current.set(i, p);
        }
        // Stick input only matters while actually playing.
        if (!s.running) return;
        // Left stick → horizontal move
        const lx = gp.axes[0];
        if (lx < -0.5) send('MOVE_LEFT');
        else if (lx > 0.5) send('MOVE_RIGHT');
        // Right stick X → also move
        const rx = gp.axes[4] ?? gp.axes[2] ?? 0;
        if (Math.abs(rx) > 0.5) send(rx < 0 ? 'MOVE_LEFT' : 'MOVE_RIGHT');
      } else {
        if (ctrl.ok) setCtrl({ok:false, name:''});
      }
    };
    gameLoopRef.current = setInterval(poll, 20);
    return () => clearInterval(gameLoopRef.current!);
  }, [s.running, s.hold]);

  // ── Key handler ───────────────────────────────────────────────────
  useEffect(() => {
    const downKeys = new Set<string>();
    const onDown = (e: KeyboardEvent) => {
      // While typing into the name field, let that input own its keys — its own
      // Enter handler saves rather than starting a new game.
      if (!s.running && e.target instanceof HTMLInputElement) return;
      if (!s.running) {
        // On the start/game-over screen any key begins a new session (unless it
        // belongs to an open name field — handled above).
        e.preventDefault();
        startGame();
        return;
      }
      e.preventDefault();
      const actMap: Record<string, Act> = {
        ArrowLeft: 'MOVE_LEFT', ArrowRight: 'MOVE_RIGHT',
        ArrowDown: 'SOFT_DROP', ArrowUp: 'HARD_DROP',
        KeyA: 'ROTATE_CCW', KeyD: 'ROTATE_CW',
        KeyS: 'SOFT_DROP', KeyW: 'ROTATE_CW',
        Space: 'HARD_DROP',
        ShiftLeft: 'HOLD', ShiftRight: 'HOLD', KeyF: 'HOLD'
      };
      const act = actMap[e.code];
      if (act) {
        if (act === 'HOLD') {
          // Debounce HOLD by wall-clock time instead of a key-down latch, so OS
          // auto-repeat is absorbed but two genuine taps still both get sent.
          const now = Date.now();
          if (now - lastHoldSentRef.current >= HOLD_DEBOUNCE_MS) send(act);
          lastHoldSentRef.current = now;
        } else {
          send(act);
        }
      }
      return;
    };
    const onUp = (_e: KeyboardEvent) => {
      // No latch to reset — time-based debounce has no stuck state.
      downKeys.delete(_e.key.toLowerCase());
    };

    window.addEventListener('keydown', onDown);
    window.addEventListener('keyup', onUp);
    return () => { window.removeEventListener('keydown', onDown); window.removeEventListener('keyup', onUp); };
  }, [s.running, s.hold]);

  // ── Render board (grid + ghost + piece) ───────────────────────────
  function renderBoard() {
    // Convert engine numeric IDs (1-7) to cells. A cell carries its color and,
    // for the ghost, a `ghost` flag so it renders as a translucent silhouette
    // instead of the same solid block as the active piece.
    type Cell = { color: string | null; ghost?: boolean } | null;
    const grid: Cell[][] = s.grid.map((row:any[]) => 
      row.map((c:any): Cell => {
        if (!c) return null;  // 0, null, undefined → null
        if (typeof c === 'number') return { color: COLORS[PIECE_ID_TO_NAME[c]] || '#fff' };
        return { color: String(c) };
      })
    );

    // Draw ghost piece — translucent tint of the falling piece's color where it
    // will land. Only fill cells that aren't already occupied by a settled block.
    if (s.piece && s.ghostY !== -1) {
      const coords = SHAPES[s.piece.name]?.[s.piece.rot] ?? [];
      for (const [dy,dx] of coords) {
        const gx = s.piece.x + dx;
        const gy = s.ghostY + dy;
        if (gy >= 0 && gy < ROWS && gx >= 0 && gx < COLS && !grid[gy][gx]) {
          grid[gy][gx] = { color: COLORS[s.piece.name], ghost: true };
        }
      }
    }

    // Draw active piece — solid, always on top.
    if (s.piece) {
      const coords = SHAPES[s.piece.name]?.[s.piece.rot] ?? [];
      for (const [dy,dx] of coords) {
        const x = s.piece!.x + dx;
        const y = s.piece!.y + dy;
        if (y >= 0 && y < ROWS && x >= 0 && x < COLS) {
          grid[y][x] = { color: COLORS[s.piece!.name], ghost: false };
        }
      }
    }

    return (
      <div style={{display:'flex',flexDirection:'column',gap:1,background:'#334155',border:'2px solid #00ff88',padding:4,borderRadius:6}}>
        {grid.map((row,yi) => (
          <div key={yi} style={{display:'flex'}}>
            {row.map((cell,xj) => (
              <div key={`${yi}-${xj}`} style={{width:CELL,height:CELL,background: cell ? (cell.ghost ? hexToRgba(cell.color!, 0.25) : cell.color!) : '#0f172a', border: cell?.ghost ? '1px solid rgba(255,255,255,0.4)' : 'none', boxSizing:'border-box'}} />
            ))}
          </div>
        ))}
      </div>
    );
  }

  // ── Score / Level display ────────────────────────────────────────
  function StatsPanel() {
    return (
      <div style={{display:'flex',flexDirection:'column',gap:12,background:'#0f172a',padding:16,borderRadius:8,border:'1px solid #334155'}}>
        <div><div style={{color:'#94a3b8',fontSize:12,textTransform:'uppercase'}}>{'Level ' + s.level}</div>
          <div style={{color:'#00ff88',fontSize:24,fontWeight:'bold'}}>{s.score.toLocaleString()}</div></div>
        <div><div style={{color:'#94a3b8',fontSize:12,textTransform:'uppercase'}}>{'Lines ' + s.lines}</div></div>
      </div>
    );
  }

  // ── Start screen / Game-over overlay ────────────────────────────
  if (!s.running) {
    // Qualified for the board this round? Only the name prompt appears when so.
    const qualified = board.length < 5 || finalStats.score > (board[board.length - 1]?.score ?? -1);

    if (s.gameOver) {
      return (
        <GameOverOverlay
          score={finalStats.score}
          lines={finalStats.lines}
          level={finalStats.level}
          board={board}
          qualified={qualified}
          submitted={savedThisRound}
          onSubmit={submitScore}
        />
      );
    }

    return (
      <div style={{minHeight:'100vh',background:'#0f172a',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:24}}>
        <h1 style={{color:'#00ff88',fontSize:48,textShadow:'0 0 20px #00ff8850'}}>TETRIS</h1>
        <EngineSelector
          engines={ENGINES}
          activeId={activeEngine}
          reachable={reachable}
          // Block only a CONFIRMED-offline backend (=== false). Any other select
          // goes through immediately so switching never hangs until the async probe
          // cycle finishes. Unknown (undefined) is treated as "probe in flight" = ok to try.
          onSwitch={(eng) => { if (reachable[eng.id] === false) return; switchEngine(eng.id); }}
        />
        <div style={{width:340}}><Scoreboard entries={board} /></div>
        <div style={{background:'#0f172a',padding:20,borderRadius:12}}>
          <p style={{color:'#e2e8f0',fontSize:18,lineHeight:1.6,margin:0}}>
            Press any key or gamepad button to start<br/>
            <span style={{color:'#94a3b8',fontSize:15}}>← → move · A D rotate · ↑↓ fall speed · Space hard drop</span>
          </p>
        </div>
      </div>
    );
  }

  // ── Active game layout ────────────────────────────────────────────
  return (
    <div style={{minHeight:'100vh',background:'#0f172a',padding:20}}>
      {/* Header */}
      <div style={{maxWidth:800,margin:'0 auto 12px',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
        <h2 style={{color:'#00ff88',fontSize:24,margin:0}}>TETRIS</h2>
        {ctrl.ok && <span style={{background:'#00d9a520',border:'1px solid #00d9a5',color:'#00ff88',padding:'3px 10px',borderRadius:6,fontSize:12}}>🎮 {ctrl.name}</span>}
      </div>

      <div style={{maxWidth:1400,margin:'0 auto',display:'flex',justifyContent:'center',gap:24}}>
        {/* ─── Left Panel: System Metrics Only (CPU/RAM) ───────── */}
        <div style={{width:200,display:'flex',flexDirection:'column',gap:16}}>
          {/* Performance metrics — sparkline over the rolling buffer */}
          <MetricsHUD engineName={ENGINES.find(e => e.id === activeEngine)?.name ?? 'Node'} history={metricsHistory} />
        </div>

        {/* ─── Main Game Board ───────────────────────────────── */}
        <div style={{display:'flex',flexDirection:'column',alignItems:'center',gap:16}}>
          {renderBoard()}
          <StatsPanel />
        </div>

        {/* ─── Right Panel: Next & Hold Pieces + Controls ────── */}
        <div style={{display:'flex',flexDirection:'column',gap:16}}>
          {/* Next Piece */}
          <div style={{background:'#1e293b',padding:16,borderRadius:12,border:'1px solid #334155'}}>
            <h3 style={{color:'#00ff88',fontSize:14,margin:'0 0 12px'}}>NEXT</h3>
            <div style={{display:'flex',gap:6,alignItems:'stretch'}}>
              {s.next.map((pieceName,i) => (
                <PreviewPiece key={i} pieceName={pieceName} orderIndex={i} />
              ))}
              {s.next.length > 0 && (
                <span style={{color:'#475569',fontSize:10,lineHeight:'64px',paddingLeft:2}}>← next</span>
              )}
            </div>
          </div>

          {/* Hold Piece */}
          <div style={{background:'#1e293b',padding:16,borderRadius:12,border:'1px solid #334155'}}>
            <h3 style={{color:'#00ff88',fontSize:14,margin:'0 0 12px'}}>HOLD</h3>
            {s.hold ? (
              <PreviewPiece pieceName={s.hold} orderIndex={0} />
            ) : (
              <div style={{width:64,height:64,borderRadius:8,display:'grid',placeItems:'center',background:'#111826'}}>
                <span style={{color:'#64748b',fontSize:10}}>Empty</span>
              </div>
            )}
          </div>

          {/* Controls Help */}
          <div style={{background:'#0f172a',padding:16,borderRadius:12,border:'1px solid #334155'}}>
            <h3 style={{color:'#00ff88',fontSize:14,margin:'0 0 12px'}}>CONTROLS</h3>
            <div style={{display:'grid',gap:6,fontSize:12}}>
              <div style={{color:'#e2e8f0'}}><b>← →</b> Move Left/Right</div>
              <div style={{color:'#e2e8f0'}}><b>A D</b> Rotate Counter/Clockwise</div>
              <div style={{color:'#e2e8f0'}}><b>↑ ↓</b> Soft Drop / Fast Fall</div>
              <div style={{color:'#e2e8f0'}}><b>Space</b> Hard Drop</div>
              <div style={{color:'#e2e8f0'}}><b>H / F / Shift / LB</b> Hold then press again to swap back</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
