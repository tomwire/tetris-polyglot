// Tetris game engine — TypeScript implementation of the unified protocol contract.
// Implements: 7-bag randomizer, SRS wall kicks, lock delay, line clearing, state export/import.

export const ARENA_W = 10;
export const ARENA_H = 20;
export const LOCK_DELAY_MS = 500;
// Deprecated placeholder — gravity is now level-scaled via GRAVITY_STEP_* below.
// Kept exported so nothing importing it breaks, but the engine no longer uses it.
export const DEFAULT_TICK_MS = 100;

// Level-scaled descent: one cell drops every `gravityInterval()` ms. Slow at the
// lowest level, accelerating GRAVITY_STEP_MS per level down to GRAVITY_MIN_MS.
const GRAVITY_BASE_MS = 500; // slowest descent step (level 1)
const GRAVITY_STEP_MS = 50; // extra speed per level
const GRAVITY_MIN_MS = 80; // fastest descent step (cap)

// Piece IDs (1-7) matching protocol contract
export enum Piece { I = 1, O = 2, T = 3, S = 4, Z = 5, J = 6, L = 7 }

export interface Position { x: number; y: number }

export interface ActivePiece {
  piece: Piece;
  rotation: number;
  position: Position;
}

export interface HoldState {
  piece: Piece | null;
  used: boolean;
}

export interface Stats {
  score: number;
  level: number;
  linesCleared: number;
}

export interface GameState {
  grid: number[][]; // ARENA_H rows × ARENA_W cols; 0=empty, 1-7=piece color
  currentPiece: ActivePiece | null;
  ghostY: number;
  nextQueue: Piece[];
  held: HoldState;
  stats: Stats;
  tickCount: number;
  lockDelayRemaining: number; // ms; -1 = not locking
  gameOver: boolean;            // true once a piece can't spawn at the top (lost)
}

// Piece shapes: [piece][rotation] = [(rowOffset, colOffset), ...]
const SHAPES: Map<Piece, number[][][]> = new Map();

// Base tetrominoes: one representative orientation each. Every rotation state is
// derived by applying a pure 90 deg clockwise transform (r,c) -> (c,-r), so each
// state is guaranteed to be exactly a quarter-turn of the previous one. This is a
// single source of truth per piece — hand-transcribed shape tables were the root
// cause of rotations morphing into invalid shapes.
const BASE: Record<Piece, number[][]> = {
  [Piece.I]: [[-1,-2],[0,-2],[1,-2],[2,-2]],
  [Piece.O]: [[0,0],[-1,0],[0,-1],[-1,-1]],
  [Piece.T]: [[-1,0],[0,0],[1,0],[0,1]],
  [Piece.S]: [[-1,1],[0,1],[0,0],[1,0]],
  [Piece.Z]: [[-1,-1],[0,-1],[0,0],[1,0]],
  [Piece.J]: [[-1,-1],[0,-1],[1,-1],[1,0]],
  [Piece.L]: [[-1,1],[0,1],[1,1],[1,0]],
};

function initShapes() {
  const cw = (cells: number[][]) => cells.map(([r, c]) => [c, -r]);
  for (const p of [Piece.I, Piece.O, Piece.T, Piece.S, Piece.Z, Piece.J, Piece.L]) {
    let base = BASE[p];
    const states: number[][][] = [];
    for (let k = 0; k < 4; k++) {
      states.push(base.map(cell => [...cell]));
      base = cw(base);
    }
    SHAPES.set(p, states);
  }
}

initShapes();

// Spawn column so each tetromino's rotation-0 footprint centers on the board.
// Board is ARENA_W wide (cols 0..ARENA_W-1); its geometric center is
// (ARENA_W-1)/2 = 4.5. The old code spawned EVERY piece at a single fixed x,
// which only centered width-2 pieces whose footprint already straddled 4.5
// (T/S/L). Width-1 and asymmetric footprints (I vertical, O, Z, J) landed one
// or more columns off-center. This picks the x that centers whatever footprint
// this piece actually has, so I/Z/O/J all drop dead-center like standard Tetris.
function spawnColumn(piece: Piece): number {
  const dxs = SHAPES.get(piece)![0].map(([, c]) => c); // rotation-0 column offsets
  const span = Math.max(...dxs) - Math.min(...dxs);    // footprint width in cells - 1
  const minCol = Math.round(((ARENA_W - 1 - span) / 2)); // leftmost col for a centered footprint
  return minCol - Math.min(...dxs);                     // adjust so the piece origin lands correctly
}

// SRS Wall Kick tables (simplified — all non-I pieces share a base set)
function wallKicks(piece: Piece, fromRot: number, toRot: number): [number, number][] {
  const diff = ((toRot - fromRot) % 4 + 4) % 4;
  
  switch (piece) {
    case Piece.J:
    case Piece.L:
      return diff === 1 || diff === 3 // CW transition
        ? [[0,0],[-1,0],[-1,-1],[0,2],[-1,2]]
        : [[0,0],[1,0],[1,-1],[0,2],[1,2]];
    
    case Piece.T:
    case Piece.S:
    case Piece.Z:
      return diff === 1 || diff === 3
        ? [[0,0],[-1,0],[-1,1],[0,-2],[-1,-2]]
        : [[0,0],[1,0],[1,-1],[0,2],[1,2]];
    
    case Piece.I:
      // I-piece has separate kick tables (not shown for brevity)
      return diff === 1 ? [[0,0],[-2,0],[1,0],[-2,1],[1,-2]]
                        : [[0,0],[2,0],[-1,0],[2,-1],[-1,2]];
    
    case Piece.O:
      return [[0,0]]; // O never kicks
  }
}

// 7-bag randomizer with deterministic lookahead.
//
// A single flat `seq` array holds the materialized draw sequence (fresh
// independent shuffle per bag). Both next() [draw] and getLookahead(n) [peek]
// read from that same array, so what the display queues up can never disagree
// with what actually spawns. Peek only advances the materialize cursor; draw is
// the only thing that moves `pos`. Neither mutates the other's view.
class BagRandomizer {
  private seq: Piece[] = [];
  private pos = 0;          // next index to draw (consumes one)
  private cursor = 0;       // how many pieces of `seq` are materialized

  constructor() { this.extend(1); }

  private resuffle(): Piece[] {
    const b: Piece[] = [Piece.I, Piece.O, Piece.T, Piece.S, Piece.Z, Piece.J, Piece.L];
    // Fisher-Yates shuffle
    for (let i = 6; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [b[i], b[j]] = [b[j], b[i]];
    }
    return b;
  }

  // Materialize the sequence up to and including index `idx` (lazy bag pulls).
  private extend(idx: number): void {
    while (this.cursor <= idx) {
      for (const p of this.resuffle()) {
        if (this.cursor > idx) break;
        this.seq.push(p);
        this.cursor++;
      }
    }
  }

  // Draw the next piece, advancing the stream by one.
  next(): Piece {
    this.extend(this.pos);
    return this.seq[this.pos++];
  }

  // Peek `n` upcoming pieces (imminent first), consuming nothing.
  getLookahead(n = 5): Piece[] {
    const out: Piece[] = [];
    for (let k = 0; k < n; k++) {
      const idx = this.pos + k;
      this.extend(idx);
      out.push(this.seq[idx]);
    }
    return out;
  }
}

// ──────────────────────────────────────────────
// Game Engine
// ──────────────────────────────────────────────

export class Game {
  private grid: number[][] = [];
  private bag: BagRandomizer;
  private nextQueueBuffer: Piece[] = [];  // lookahead buffer for display
  private active: ActivePiece | null = null;
  private ghostY = -1;
  private held: HoldState = { piece: null, used: false };
  private stats: Stats = { score: 0, level: 0, linesCleared: 0 };
  private tickCount = 0;
  private lockRem = -1; // ms remaining; -1 = not locking
  private locked = false;
  private gravityAccum = 0; // ms accumulated toward the next descent step
  private lastTick = Date.now();
  private paused = false;
  private gameOver = false; // true once there's no room to spawn a fresh piece at the top

  constructor() {
    for (let y = 0; y < ARENA_H; y++) {
      this.grid.push(new Array(ARENA_W).fill(0));
    }
    this.bag = new BagRandomizer();
    this.spawnNext();
  }

  /**
   * Start a brand-new game from the top: clear the board, reset stats and
   * — critically — unfreeze any lost state so a fresh piece can spawn.
   *
   * The engine is a single shared Game instance for all clients, so this is the
   * ONLY way to recover after a loss. Without it the first game-over freezes
   * gameOver=true + active=null permanently and every subsequent connection sees
   * an instant game-over screen (unplayable).
   */
  public newGame(): void {
    this.gameOver = false; // must clear before spawnNext(), else it bails out
    // A new game must start playable. Clear any stale pause left by a prior
    // EXPORT_STATE (the frontend's engine-switcher pauses the shared engine on
    // exit); otherwise gravity stays frozen and active.y never descends until
    // restart. Same guard as python/rust keep in step for cross-engine parity.
    this.paused = false;
    this.reset();
  }

  private reset() {
    for (let y = 0; y < ARENA_H; y++) {
      this.grid[y].fill(0);
    }
    this.stats = { score: 0, level: 0, linesCleared: 0 };
    this.held = { piece: null, used: false };
    this.tickCount = 0;
    this.lockRem = -1;
    this.gravityAccum = 0;
    this.spawnNext();
    this.syncNextQueue();
  }

  private spawnNext() {
    if (this.gameOver) return; // game already lost — stay frozen
    const p = this.bag.next();
    this.active = { piece: p, rotation: 0, position: { x: spawnColumn(p), y: 0 } };
    if (!this.okAt(this.active)) {
      // No room to drop a fresh piece at the top of the board → game over.
      // Previously this called this.reset() (silent restart), which made it
      // impossible to ever signal a loss. Freeze instead: null out the active
      // piece so gravity/movement no-op while the settled stack stays visible.
      this.gameOver = true;
      this.active = null;
      return;
    }
    this.syncNextQueue();
    this.gravityAccum = 0; // fresh piece starts with no accumulated gravity time
    this.recalcGhost();
  }

  /** Per-cell descent interval (ms) for the current level. Level 0 counts as 1. */
  private gravityInterval(): number {
    const level = Math.max(1, this.stats.level);
    // Matches the classic 500-(level-1)*50 with an 80ms floor.
    return Math.max(GRAVITY_MIN_MS, GRAVITY_BASE_MS - (level - 1) * GRAVITY_STEP_MS);
  }

  /** True if the active piece can step down one cell without collision. */
  private canStepDown(): boolean {
    if (!this.active) return false;
    const cand = {
      piece: this.active.piece,
      rotation: this.active.rotation,
      position: { x: this.active.position.x, y: this.active.position.y + 1 },
    };
    return this.okAt(cand);
  }

  private syncNextQueue() {
    // The flat `seq` stream has already advanced past the active piece and the
    // held piece (both were consumed via BagRandomizer.next()), so getLookahead()
    // returns only genuinely-future pieces, imminent first. No name-filtering:
    // it would wrongly drop a piece that legitimately repeats within the 5-slot
    // horizon of the 7-bag randomizer.
    this.nextQueueBuffer = this.bag.getLookahead(5);
  }

  private okAt(ap: ActivePiece): boolean {
    const shape = SHAPES.get(ap.piece)![ap.rotation];
    for (const [dy, dx] of shape) {
      const y = ap.position.y + dy;
      const x = ap.position.x + dx;
      if (x < 0 || x >= ARENA_W || y >= ARENA_H) return false;
      if (y >= 0 && this.grid[y][x] !== 0) return false;
    }
    return true;
  }

  private okPos(piece: Piece, rot: number, px: number, py: number): boolean {
    const shape = SHAPES.get(piece)![rot];
    for (const [dy, dx] of shape) {
      const y = py + dy;
      const x = px + dx;
      if (x < 0 || x >= ARENA_W || y >= ARENA_H) return false;
      if (y >= 0 && this.grid[y][x] !== 0) return false;
    }
    return true;
  }

  private moveTo(ap: ActivePiece, nx: number, ny: number): boolean {
    const candidate = { piece: ap.piece, rotation: ap.rotation, position: { x: nx, y: ny } };
    if (this.okAt(candidate)) {
      ap.position = { x: nx, y: ny };
      this.lockRem = LOCK_DELAY_MS;
      this.locked = false;
      this.recalcGhost();
      return true;
    }
    return false;
  }

  private recalcGhost() {
    if (!this.active) { this.ghostY = -1; return; }
    let gy = this.active.position.y;
    while (gy + 1 < ARENA_H && this.okPos(this.active.piece, this.active.rotation, this.active.position.x, gy + 1)) {
      gy += 1;
    }
    this.ghostY = gy;
  }

  // Movement actions — return true on success
  moveLeft(): boolean {
    if (this.gameOver || !this.active) return false;
    return this.moveTo(this.active, this.active.position.x - 1, this.active.position.y);
  }

  moveRight(): boolean {
    if (this.gameOver || !this.active) return false;
    return this.moveTo(this.active, this.active.position.x + 1, this.active.position.y);
  }

  rotateCW(): boolean {
    if (!this.active || this.gameOver || this.active.piece === Piece.O) return false;
    const nr = (this.active.rotation + 1) % 4;
    for (const [kx, ky] of wallKicks(this.active.piece, this.active.rotation, nr)) {
      const nx = this.active.position.x + kx;
      const ny = this.active.position.y + ky;
      if (this.okAt({ piece: this.active.piece, rotation: nr, position: { x: nx, y: ny } })) {
        this.active.rotation = nr;
        this.active.position = { x: nx, y: ny };
        this.lockRem = LOCK_DELAY_MS;
        this.locked = false;
        this.recalcGhost();
        return true;
      }
    }
    return false;
  }

  rotateCCW(): boolean {
    if (!this.active || this.gameOver || this.active.piece === Piece.O) return false;
    const nr = this.active.rotation === 0 ? 3 : this.active.rotation - 1;
    for (const [kx, ky] of wallKicks(this.active.piece, this.active.rotation, nr)) {
      const nx = this.active.position.x + kx;
      const ny = this.active.position.y + ky;
      if (this.okAt({ piece: this.active.piece, rotation: nr, position: { x: nx, y: ny } })) {
        this.active.rotation = nr;
        this.active.position = { x: nx, y: ny };
        this.lockRem = LOCK_DELAY_MS;
        this.locked = false;
        this.recalcGhost();
        return true;
      }
    }
    return false;
  }

  softDrop(): number {
    // Single-cell step per call. A held Down key (OS auto-repeat) fires many
    // SOFT_DROP messages, so the piece falls fast but gradual — unlike hard
    // drop, which commits immediately. Descending to the bottom here would make
    // soft drop read exactly like a hard drop.
    if (this.gameOver || !this.active) return 0;
    let n = 0;
    if (this.moveTo(this.active, this.active.position.x, this.active.position.y + 1)) {
      n++;
      this.stats.score += n; // soft drop scoring
    }
    return n;
  }

  hardDrop(): number {
    let n = 0;
    if (this.gameOver || !this.active) return 0;
    // Descend to the bottom (counting cells for scoring), then commit + clear.
    while (this.moveTo(this.active, this.active.position.x, this.active.position.y + 1)) {
      n++;
    }
    this.stats.score += n * 2; // hard drop scoring
    this.commitLock();
    return n;
  }

  hold(): boolean {
    if (this.gameOver || !this.active) return false;
    const cur = this.active.piece;

    if (this.held.piece !== null && this.held.used) {
      // SWAP (second+ hold): promote the previously-held piece back to the top,
      // and drop the current piece into the now-free slot. No bag draw here —
      // both pieces are already scheduled, so the lookahead queue is untouched.
      const promoted = this.held.piece!;
      this.held.piece = cur;
      this.active = { piece: promoted, rotation: 0, position: { x: spawnColumn(promoted), y: 0 } };
    } else {
      // FIRST hold: park the current piece and pull a fresh one from the bag.
      this.held.piece = cur;
      this.held.used = true;
      const newP = this.bag.next();
      this.active = { piece: newP, rotation: 0, position: { x: spawnColumn(newP), y: 0 } };
    }

    if (!this.okAt(this.active)) {
      // The swapped-in piece can't be placed at the top → game over.
      this.gameOver = true;
      this.active = null;
      return false;
    }
    // Fresh active starts with no pending lock/gravity state.
    this.locked = false;
    this.lockRem = -1;
    this.gravityAccum = 0;
    this.syncNextQueue();
    this.recalcGhost();
    return true;
  }

  tick(dt: number): boolean {
    if (this.paused) return false;
    if (!this.active) return false;

    let spawned = false;

    // --- Gravity: time-accumulated descent, level-scaled. Independent of the
    // caller's dt granularity so speed stays correct regardless of tick rate.
    if (!this.locked) {
      this.gravityAccum += dt;
      const interval = this.gravityInterval();
      while (this.gravityAccum >= interval &&
             this.moveTo(this.active, this.active.position.x, this.active.position.y + 1)) {
        this.gravityAccum -= interval;
      }

      // Settled on the bottom: begin the lock delay. Guarded by !this.locked so a
      // stuck-at-bottom piece re-arms only once (the old code reset it to full on
      // every tick, so lockRem oscillated 500->450 and never elapsed).
      if (!this.canStepDown() && !this.locked) {
        this.lockRem = LOCK_DELAY_MS;
        this.locked = true;
      }
    }

    // --- Lock countdown, then commit once the delay elapses.
    if (this.locked) {
      this.lockRem -= dt;
      if (this.lockRem <= 0) {
        this.commitLock();
        spawned = true;
      }
    }

    return spawned;
  }

  /** Write the active piece to the grid, clear lines (+score/level), spawn next. */
  private commitLock() {
    if (this.active) {
      const shape = SHAPES.get(this.active.piece)![this.active.rotation];
      for (const [dy, dx] of shape) {
        const y = this.active.position.y + dy;
        const x = this.active.position.x + dx;
        if (y >= 0 && y < ARENA_H && x >= 0 && x < ARENA_W) {
          this.grid[y][x] = this.active.piece;
        }
      }
    }
    const cleared = this.clearLines();
    if (cleared > 0) {
      const bonus = { 1: 100, 2: 300, 3: 500, 4: 800 }[cleared] || 0;
      this.stats.linesCleared += cleared;
      this.stats.score += bonus * this.stats.level;
      this.stats.level = Math.floor(this.stats.linesCleared / 10) + 1;
    }
    this.spawnNext();
    this.lockRem = -1;
    this.locked = false;
  }

  private clearLines(): number {
    let cleared = 0;
    let y = ARENA_H - 1;
    while (y >= 0) {
      if (this.grid[y].every(c => c !== 0)) {
        cleared++;
        // Shift rows down by one
        for (let r = y; r > 0; r--) {
          this.grid[r] = [...this.grid[r - 1]];
        }
        this.grid[0] = new Array(ARENA_W).fill(0);
      } else {
        y--;
      }
    }
    return cleared;
  }

  // State accessors
  getState(): GameState {
    const gridCopy = this.grid.map(row => [...row]);
    return {
      grid: gridCopy,
      currentPiece: this.active ? { ...this.active } : null,
      ghostY: this.ghostY,
      nextQueue: this.nextQueueBuffer.slice(),
      held: { ...this.held },
      stats: { ...this.stats },
      tickCount: this.tickCount,
      lockDelayRemaining: this.lockRem,
      gameOver: this.gameOver,
    };
  }

  exportState(): string {
    return JSON.stringify(this.getState());
  }

  importState(data: string): boolean {
    try {
      const st: GameState = JSON.parse(data);
      
      // Restore grid
      for (let y = 0; y < Math.min(st.grid.length, ARENA_H); y++) {
        for (let x = 0; x < Math.min(st.grid[y].length, ARENA_W); x++) {
          this.grid[y][x] = st.grid[y][x];
        }
      }

      // Restore active piece
      if (st.currentPiece) {
        this.active = { ...st.currentPiece };
        if (!this.okAt(this.active)) return false;
      } else {
        this.spawnNext();
      }

      this.ghostY = st.ghostY;
      this.held = st.held;
      this.stats = st.stats;
      this.tickCount = st.tickCount;
      this.lockRem = st.lockDelayRemaining;
      this.paused = false;
      return true;
    } catch (e) {
      console.error('Import state error:', e);
      return false;
    }
  }

  pause() { this.paused = true; }
  resume() { this.paused = false; }
  isPaused(): boolean { return this.paused; }
}
