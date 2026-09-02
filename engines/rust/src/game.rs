// Core Tetris game engine — Rust implementation.
// Implements: 7-bag randomizer, SRS wall kicks (J/L/T/S/Z/I), lock delay, line clears, state export/import.

use serde::{Deserialize, Serialize};

pub const ARENA_W: usize = 10;
pub const ARENA_H: usize = 20;
pub const LOCK_DELAY_MS: i64 = 500;

// Level-scaled gravity (classic Tetris feel), independent of tick granularity.
// Per-cell descent interval = max(80, 500 - (level-1)*50) ms; level 0 counts as 1.
pub const GRAVITY_BASE_MS: i64 = 500;   // slowest descent step (level 1)
pub const GRAVITY_STEP_MS: i64 = 50;    // extra speed per level
pub const GRAVITY_MIN_MS: i64 = 80;     // fastest descent step (floor)

/// Piece type IDs matching the protocol contract (1-7).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum Piece { I = 1, O = 2, T = 3, S = 4, Z = 5, J = 6, L = 7 }

impl Piece {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            1 => Some(Self::I), 2 => Some(Self::O), 3 => Some(Self::T),
            4 => Some(Self::S), 5 => Some(Self::Z), 6 => Some(Self::J),
            7 => Some(Self::L), _ => None,
        }
    }
}

// ──────────────────────────────────────────────
// Piece shapes: [rotation][cell] = (row_offset, col_offset)
// Base tetrominoes: one representative orientation each. Every rotation state is
// derived at compile time by applying a pure 90 deg clockwise transform (r, c) ->
// (c, -r), so each state is exactly a quarter-turn of the previous — hand-typed
// tables were the root cause of rotations morphing into invalid shapes.
// ──────────────────────────────────────────────

const fn rot_cw(cells: [(i32, i32); 4]) -> [(i32, i32); 4] {
    [
        (cells[0].1, -cells[0].0),
        (cells[1].1, -cells[1].0),
        (cells[2].1, -cells[2].0),
        (cells[3].1, -cells[3].0),
    ]
}

const fn rot_n(mut cells: [(i32, i32); 4], n: usize) -> [(i32, i32); 4] {
    let mut cur = cells;
    let mut k = 0;
    while k < n {
        cur = rot_cw(cur);
        k += 1;
    }
    cur
}

const SHAPE_I: [(i32, i32); 4] = [(-1,-2),(0,-2),(1,-2),(2,-2)];
const SHAPE_O: [(i32, i32); 4] = [(0,0),(-1,0),(0,-1),(-1,-1)];
const SHAPE_T: [(i32, i32); 4] = [(-1,0),(0,0),(1,0),(0,1)];
const SHAPE_S: [(i32, i32); 4] = [(-1,1),(0,1),(0,0),(1,0)];
const SHAPE_Z: [(i32, i32); 4] = [(-1,-1),(0,-1),(0,0),(1,0)];
const SHAPE_J: [(i32, i32); 4] = [(-1,-1),(0,-1),(1,-1),(1,0)];
const SHAPE_L: [(i32, i32); 4] = [(-1,1),(0,1),(1,1),(1,0)];

// All 28 shapes compiled from bases: I×4, O×4, T×4, S×4, Z×4, J×4, L×4.
const SHAPE_TABLE: [[[(i32, i32); 4]; 4]; 7] = [
    [SHAPE_I, rot_cw(SHAPE_I), rot_n(SHAPE_I, 2), rot_n(SHAPE_I, 3)],
    [SHAPE_O, rot_cw(SHAPE_O), rot_n(SHAPE_O, 2), rot_n(SHAPE_O, 3)],
    [SHAPE_T, rot_cw(SHAPE_T), rot_n(SHAPE_T, 2), rot_n(SHAPE_T, 3)],
    [SHAPE_S, rot_cw(SHAPE_S), rot_n(SHAPE_S, 2), rot_n(SHAPE_S, 3)],
    [SHAPE_Z, rot_cw(SHAPE_Z), rot_n(SHAPE_Z, 2), rot_n(SHAPE_Z, 3)],
    [SHAPE_J, rot_cw(SHAPE_J), rot_n(SHAPE_J, 2), rot_n(SHAPE_J, 3)],
    [SHAPE_L, rot_cw(SHAPE_L), rot_n(SHAPE_L, 2), rot_n(SHAPE_L, 3)],
];

fn piece_shapes(p: Piece, r: usize) -> &'static [(i32, i32); 4] {
    let idx = (p as u8 - 1) as usize;
    &SHAPE_TABLE[idx][r % 4]
}

/// SRS wall kick offsets. Returns offsets to try for a rotation transition.
fn wall_kicks(piece: Piece, from_rot: usize, to_rot: usize) -> &'static [(i32, i32)] {
    let diff = if to_rot >= from_rot { to_rot - from_rot } else { 4 - (from_rot - to_rot) };
    match piece {
        Piece::J | Piece::L => {
            if diff == 1 || diff == 3 { // CW transition
                &[(0,0),(-1,0),(-1,-1),(0,2),(-1,2)]
            } else {
                &[(0,0),(1,0),(1,-1),(0,2),(1,2)]
            }
        }
        Piece::T | Piece::S | Piece::Z => {
            if diff == 1 || diff == 3 {
                &[(0,0),(-1,0),(-1,1),(0,-2),(-1,-2)]
            } else {
                &[(0,0),(1,0),(1,-1),(0,2),(1,2)]
            }
        }
        Piece::I => match (piece, from_rot, to_rot) {
            (Piece::I, 0, 1) => &[(0,0),(-2,0),(1,0),(-2,1),(1,-2)],
            (Piece::I, 1, 2) => &[(0,0),(-2,0),(1,0),(-2,-1),(1,2)],
            (Piece::I, 2, 3) => &[(0,0),(2,0),(-1,0),(2,-1),(-1,2)],
            (Piece::I, 3, 0) => &[(0,0),(2,0),(-1,0),(2,1),(-1,-2)],
            _ => &[(0,0)],
        },
        Piece::O => &[(0,0)],
    }
}

// ──────────────────────────────────────────────
// Serializable state (matches protocol contract)
// ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Position { pub x: i32, pub y: i32 }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivePiece {
    pub piece: u8,        // 1-7
    pub rotation: usize,
    pub position: Position,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HeldState {
    pub piece: Option<u8>,
    pub used: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub score: u32,
    pub level: u32,
    pub lines_cleared: u32,
}

// camelCase serialized keys — match the canonical protocol contract
// (POLYGLOT_PROTOCOL.md §STATE_UPDATE) so node/python/rust emit identical shapes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameState {
    pub grid: [[u8; ARENA_W]; ARENA_H],
    pub current_piece: Option<ActivePiece>,
    pub ghost_y: i32,
    pub next_queue: Vec<u8>,
    pub held: HeldState,
    pub stats: Stats,
    pub tick_count: u64,
    pub lock_delay_remaining: i64,
    pub game_over: bool, // true once a piece can't spawn at the top (lost)
}

// ──────────────────────────────────────────────
// 7-bag randomizer
// ──────────────────────────────────────────────

// 7-bag randomizer — node-parity materialized stream.
//
// `seq` is a single flattened array of ALL pieces, filled bag-by-bag so there is
// a continuous independent shuffle per bag. Both `next()` [draw] and the
// peek-based lookahead read from that same array, so the display "nextQueue"
// can never disagree with what actually spawns. Peek only advances the
// materialize `cursor`; draw is the only thing that moves `pos`. Neither mutates
// the other's view (mirroring node's BagRandomizer exactly).
#[derive(Default)]
struct Bag {
    seq: Vec<u8>,       // fully materialized stream (bag by bag)
    pos: usize,         // next index to draw (consumes one)
    cursor: usize,      // how many pieces of `seq` are currently materialized
}

impl Bag {
    fn new() -> Self {
        let mut b = Self::default();
        b.extend(1); // constructor mirrors node's extend(1)
        b
    }

    /// Materialize the stream up to and including index `idx` (lazy bag pulls).
    fn extend(&mut self, idx: usize) {
        while self.cursor <= idx {
            for p in Self::shuffle() {
                if self.cursor > idx { break; }
                self.seq.push(p);
                self.cursor += 1;
            }
        }
    }

    /// Fisher-Yates shuffle of one bag: [1,2,3,4,5,6,7] permuted.
    fn shuffle() -> [u8; 7] {
        let mut b = [0u8; 7];
        for (i, slot) in b.iter_mut().enumerate() { *slot = (i as u8) + 1; }
        // Non-zero LCG seed so the modulo never degenerates to all-zeros.
        let mut s: u32 = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap_or_default()
            .subsec_nanos() as u32
            | 1;
        for i in (0..7).rev() {
            s = s.wrapping_mul(1664525).wrapping_add(1013904223);
            let j = (s as usize) % (i + 1);
            b.swap(i, j);
        }
        b
    }

    /// Draw the next piece, advancing the stream by one.
    fn next(&mut self) -> u8 {
        self.extend(self.pos);
        let p = self.seq[self.pos];
        self.pos += 1;
        self.extend(self.pos + 4); // keep the peek buffer warm
        p
    }

    /// Peek at the next `n` upcoming pieces WITHOUT advancing `pos`, so the
    /// display's "next" queue can never disagree with what actually spawns.
    fn get_lookahead(&mut self, n: usize) -> Vec<u8> {
        let mut out = Vec::with_capacity(n);
        for k in 0..n {
            self.extend(self.pos + k);
            out.push(self.seq[self.pos + k]);
        }
        out
    }
}

// ──────────────────────────────────────────────
// Game Engine
// ──────────────────────────────────────────────

pub struct Game {
    grid: [[u8; ARENA_W]; ARENA_H],
    bag: Bag,
    active: Option<ActivePiece>,
    ghost_y: i32,
    held: HeldState,
    stats: Stats,
    tick_count: u64,
    lock_rem: i64,
    locked: bool,
    last_tick: std::time::Instant,
    gravity_acc: i64,
    paused: bool,
    game_over: bool, // true once a piece can't spawn at the top (lost)
    /// Next 5 upcoming pieces — node-parity peek buffer for `nextQueue`.
    next_buffer: Vec<u8>,
}

impl Game {
    pub fn new() -> Self {
        let mut g = Self {
            grid: [[0u8; ARENA_W]; ARENA_H], bag: Bag::new(), active: None,
            ghost_y: -1, held: HeldState { piece: None, used: false },
            stats: Stats { score: 0, level: 0, lines_cleared: 0 },
            tick_count: 0, lock_rem: -1, locked: false,
            last_tick: std::time::Instant::now(), gravity_acc: 0, paused: false,
            game_over: false, next_buffer: Vec::new(),
        };
        g.spawn();
        g
    }

    /// Start a fresh round. Clear `game_over` BEFORE reset()/spawn() or the
    // spawner bails out and the board stays frozen at game-over forever.
    pub fn new_game(&mut self) {
        self.game_over = false;
        self.reset();
    }

    fn reset(&mut self) {
        for row in &mut self.grid { *row = [0u8; ARENA_W]; }
        self.stats = Stats { score: 0, level: 0, lines_cleared: 0 };
        self.held = HeldState { piece: None, used: false };
        self.tick_count = 0; self.lock_rem = -1; self.gravity_acc = 0;
        self.spawn();
    }

    /// Center each tetromino on its rotation-0 column span so it drops like
    /// standard Tetris (mirrors node's `spawnColumn`) instead of a fixed x for
    /// every piece. Without this the long I-piece spawns off to the left.
    fn spawn_column(p: u8) -> i32 {
        let cells = SHAPE_TABLE[(p - 1) as usize][0];
        let dxs: Vec<i32> = cells.iter().map(|cell| cell.1).collect();
        let span = *dxs.iter().max().unwrap() - *dxs.iter().min().unwrap();
        // round-half-up to match node's Math.round((ARENA_W-1-span)/2)
        let min_col = ((ARENA_W as i32 - 1 - span) as f64 / 2.0 + 0.5).floor() as i32;
        min_col - dxs.into_iter().min().unwrap()
    }

    fn spawn(&mut self) {
        if self.game_over { return; } // already lost — stay frozen
        let pid = self.bag.next();
        if Piece::from_u8(pid).is_some() {
            self.active = Some(ActivePiece { piece: pid, rotation: 0, position: Position { x: Self::spawn_column(pid), y: 0 } });
            if !self.ok_at(self.active.as_ref().unwrap()) {
                // No room to drop a fresh piece at the top of the board → game
                // over. Freeze (null active) instead of resetting — a silent
                // restart hid losses. Mirrors node's spawnNext.
                self.game_over = true;
                self.next_buffer = Vec::new();
                self.active = None;
                return;
            }
            self.next_buffer = self.bag.get_lookahead(5);
            self.locked = false; self.lock_rem = -1; self.gravity_acc = 0;
            self.recalc_ghost();
        }
    }

    fn ok_at(&self, ap: &ActivePiece) -> bool {
        for &(dy, dx) in piece_shapes(Piece::from_u8(ap.piece).unwrap(), ap.rotation) {
            let y = ap.position.y + dy;
            let x = ap.position.x + dx;
            if x < 0 || x >= ARENA_W as i32 || y >= ARENA_H as i32 { return false; }
            if y >= 0 && self.grid[y as usize][x as usize] != 0 { return false; }
        }
        true
    }

    fn ok_pos(&self, pid: u8, rot: usize, px: i32, py: i32) -> bool {
        let p = Piece::from_u8(pid).unwrap();
        for &(dy, dx) in piece_shapes(p, rot) {
            let y = py + dy; let x = px + dx;
            if x < 0 || x >= ARENA_W as i32 || y >= ARENA_H as i32 { return false; }
            if y >= 0 && self.grid[y as usize][x as usize] != 0 { return false; }
        }
        true
    }

    /// True if the active piece can occupy one cell directly below. Pure `&self`:
    /// callers own the piece locally and commit it themselves, so we never hold a
    /// borrow on `self.active` while also borrowing all of `self`.
    fn can_step_down_pos(&self, ap: &ActivePiece) -> Option<i32> {
        if self.ok_pos(ap.piece, ap.rotation, ap.position.x, ap.position.y + 1) {
            Some(ap.position.y + 1)
        } else { None }
    }

    fn recalc_ghost(&mut self) {
        if let Some(ref ap) = self.active {
            let mut gy = ap.position.y;
            while gy + 1 < ARENA_H as i32 && self.ok_pos(ap.piece, ap.rotation, ap.position.x, gy + 1) {
                gy += 1;
            }
            self.ghost_y = gy;
        } else { self.ghost_y = -1; }
    }

    pub fn move_left(&mut self) -> bool {
        if let Some(ap) = std::mem::take(&mut self.active) {
            let (nx, ny) = (ap.position.x - 1, ap.position.y);
            Self::apply_move(self, ap, nx, ny)
        } else { false }
    }
    pub fn move_right(&mut self) -> bool {
        if let Some(ap) = std::mem::take(&mut self.active) {
            let (nx, ny) = (ap.position.x + 1, ap.position.y);
            Self::apply_move(self, ap, nx, ny)
        } else { false }
    }

    /// Try to move the active piece to (nx,ny). Owns the piece for the call so we
    /// never hold a `ref`/`ref mut` on `self.active` while also borrowing all of
    /// `self`. Commits back to `self.active` only when it is in a known state —
    /// on success the new position, on failure the original (unchanged) piece.
    fn apply_move(&mut self, mut ap: ActivePiece, nx: i32, ny: i32) -> bool {
        let cand = ActivePiece { piece: ap.piece, rotation: ap.rotation,
            position: Position { x: nx, y: ny } };
        if !self.ok_at(&cand) {
            self.active = Some(ap); // unchanged; restore
            return false;
        }
        ap.position = Position { x: nx, y: ny };
        self.lock_rem = LOCK_DELAY_MS; self.locked = false;
        self.active = Some(ap);
        self.recalc_ghost();
        true
    }

    pub fn rotate_cw(&mut self) -> bool {
        if let Some(ap) = std::mem::take(&mut self.active) {
            // Capture fields before moving `ap` (passing ap + ap.rotation in one
            // call would be use-after-move).
            let pid = ap.piece;
            let rot = ap.rotation;
            Self::do_rotate(self, ap, Piece::from_u8(pid).unwrap(), rot, (rot + 1) % 4)
        } else { false }
    }

    /// Try to rotate `ap` via SRS wall kicks. Owns the piece for the call so we
    /// never hold a `ref`/`ref mut` on `self.active` while also borrowing all of
    /// `self`. Restores the ORIGINAL piece if no kick is valid.
    fn do_rotate(&mut self, mut ap: ActivePiece, p: Piece, from: usize, to: usize) -> bool {
        if p == Piece::O { self.active = Some(ap); return false; }
        let mut chosen: Option<(usize, Position)> = None;
        for &(kx, ky) in wall_kicks(p, from, to) {
            let nx = ap.position.x + kx; let ny = ap.position.y + ky;
            let cand = ActivePiece { piece: ap.piece, rotation: to, position: Position { x: nx, y: ny } };
            if self.ok_at(&cand) { chosen = Some((to, Position { x: nx, y: ny })); break; }
        }
        match chosen {
            Some((rot, pos)) => {
                ap.rotation = rot; ap.position = pos;
                self.active = Some(ap);
                self.lock_rem = LOCK_DELAY_MS; self.locked = false;
                self.recalc_ghost();
                true
            }
            None => { self.active = Some(ap); /* restored original */ false },
        }
    }

    pub fn rotate_ccw(&mut self) -> bool {
        if let Some(ap) = std::mem::take(&mut self.active) {
            let pid = ap.piece;
            let rot = ap.rotation;
            let next = if rot == 0 { 3 } else { rot - 1 };
            Self::do_rotate(self, ap, Piece::from_u8(pid).unwrap(), rot, next)
        } else { false }
    }

    pub fn soft_drop(&mut self) -> u32 {
        let mut n = 0u32;
        if let Some(mut ap) = std::mem::take(&mut self.active) {
            // Single-cell step per call (node parity). A held Down key fires many
            // SOFT_DROP messages via OS auto-repeat, so the piece falls gradually.
            // Walking to the bottom here would make soft drop read like a hard drop.
            if let Some(ny) = self.can_step_down_pos(&ap) { ap.position.y = ny; n += 1; }
            // Descending clears the pending lock (mirrors node's moveTo).
            self.lock_rem = LOCK_DELAY_MS; self.locked = false;
            self.active = Some(ap);   // commit stepped position (unchanged if it never moved)
            self.recalc_ghost();
        }
        self.stats.score += n; // soft drop scoring
        n
    }

    pub fn hard_drop(&mut self) -> u32 {
        let mut n = 0u32;
        if let Some(mut ap) = std::mem::take(&mut self.active) {
            // Descend to the floor, counting cells cleared (mirrors node).
            while self.ok_pos(ap.piece, ap.rotation, ap.position.x, ap.position.y + 1) { ap.position.y += 1; n += 1; }
            // Materialize at final position. `ap` is a local (not a borrow of
            // self.active), so writing into self.grid holds no conflicting borrow.
            for &(dy, dx) in piece_shapes(Piece::from_u8(ap.piece).unwrap(), ap.rotation) {
                let cy = ap.position.y + dy; let cx = ap.position.x + dx;
                if cy >= 0 && (cy as usize) < ARENA_H && cx >= 0 && (cx as usize) < ARENA_W {
                    self.grid[cy as usize][cx as usize] = ap.piece;
                }
            }
        }
        self.stats.score += n * 2;
        self.lock_after_drop();
        n
    }

    fn lock_after_drop(&mut self) {
        let cleared = self.clear_lines();
        if cleared > 0 {
            let bonus = match cleared { 1=>100, 2=>300, 3=>500, 4=>800, _=>0 };
            self.stats.lines_cleared += cleared;
            self.stats.score += bonus * self.stats.level;
            self.stats.level = (self.stats.lines_cleared / 10) + 1;
        }
        self.spawn();
    }

    pub fn hold(&mut self) -> bool {
        if self.active.is_none() {
            return false;
        }
        let cur_pid = self.active.as_ref().unwrap().piece;

        if self.held.piece.is_some() && self.held.used {
            // SWAP (2nd+ press): release the held piece to the top and stash the
            // active one. No bag draw — both pieces are already scheduled, so this
            // lets you hold -> swap back -> choose what to hold again.
            let promoted = Piece::from_u8(self.held.piece.unwrap()).unwrap();
            self.held.piece = Some(cur_pid);
            self.active = Some(ActivePiece { piece: promoted as u8, rotation: 0, position: Position { x: Self::spawn_column(promoted as u8), y: 0 } });
        } else {
            // FIRST hold: park the current piece and pull a fresh one from the bag.
            self.held.piece = Some(cur_pid);
            self.held.used = true;
            if let Some(new_p) = Piece::from_u8(self.bag.next()) {
                self.active = Some(ActivePiece { piece: new_p as u8, rotation: 0, position: Position { x: Self::spawn_column(new_p as u8), y: 0 } });
            }
        }

        // Verify the (possibly swapped/fresh) active piece can occupy the top
        // row; if not, reset. Uses an owned local so we never borrow self.active
        // while calling a &mut self method.
        let active = std::mem::take(&mut self.active);
        match active {
            Some(ap) => {
                if self.ok_at(&ap) { self.active = Some(ap); }
                else { self.reset(); }
            }
            None => {}
        }
        // Fresh active starts with no pending lock/gravity state.
        self.locked = false;
        self.lock_rem = -1;
        self.gravity_acc = 0;
        self.recalc_ghost();
        true
    }

    /// Per-cell descent interval (ms) for the current level.
    fn gravity_interval(&self) -> i64 {
        let level = self.stats.level.max(1) as i64;
        std::cmp::max(GRAVITY_MIN_MS, GRAVITY_BASE_MS - (level - 1) * GRAVITY_STEP_MS)
    }

    /// True if the active piece can step down one cell without collision.
    fn can_step_down(&self) -> bool {
        match &self.active {
            Some(ap) => {
                let cand = ActivePiece { piece: ap.piece, rotation: ap.rotation,
                    position: Position { x: ap.position.x, y: ap.position.y + 1 } };
                self.ok_at(&cand)
            }
            None => false,
        }
    }

    pub fn tick(&mut self) -> bool {
        if self.paused { return false; }
        let dt = self.last_tick.elapsed().as_millis() as i64;
        self.last_tick = std::time::Instant::now();

        let mut spawned = false;

        // --- Gravity: time-accumulated descent, level-scaled. Independent of the
        // caller's dt granularity so speed stays correct regardless of tick rate.
        if !self.locked {
            self.gravity_acc += dt;
            let interval = self.gravity_interval();
            while self.gravity_acc >= interval {
                // Try to step down one cell. Owns the piece locally so we never
                // hold a borrow on self.active across this &mut self call, then
                // re-arms lock state on each successful descent (node parity).
                let moved = if let Some(mut ap) = std::mem::take(&mut self.active) {
                    if self.can_step_down_pos(&ap).is_some() {
                        ap.position.y += 1;
                        self.lock_rem = LOCK_DELAY_MS; self.locked = false;
                        self.gravity_acc -= interval;
                        self.active = Some(ap);
                        true
                    } else { self.active = Some(ap); false }
                } else { false };
                if !moved { break; }
            }

            // Settled on the bottom: begin the lock delay. Guarded by !locked so a
            // stuck-at-bottom piece re-arms only once (the old code reset it to full
            // on every blocked tick, so lock_rem oscillated 500->450 and never elapsed).
            if !self.locked && !self.can_step_down() {
                self.lock_rem = LOCK_DELAY_MS;
                self.locked = true;
            }
        }

        // --- Lock countdown, then commit once the delay elapses.
        if self.locked {
            self.lock_rem -= dt;
            if self.lock_rem <= 0 {
                // Materialize the active piece into the grid. Takes it out to an
                // owned local so the grid write holds no conflicting borrow on
                // self.active; the caller then clears/locks/spawns.
                if let Some(ap) = std::mem::take(&mut self.active) {
                    for &(dy, dx) in piece_shapes(Piece::from_u8(ap.piece).unwrap(), ap.rotation) {
                        let y = ap.position.y + dy; let x = ap.position.x + dx;
                        if y >= 0 && (y as usize) < ARENA_H && x >= 0 && (x as usize) < ARENA_W {
                            self.grid[y as usize][x as usize] = ap.piece;
                        }
                    }
                }
                let cleared = self.clear_lines();
                if cleared > 0 {
                    let bonus = match cleared { 1=>100, 2=>300, 3=>500, 4=>800, _=>0 };
                    self.stats.lines_cleared += cleared;
                    self.stats.score += bonus * self.stats.level;
                    self.stats.level = (self.stats.lines_cleared / 10) + 1;
                }
                // Fresh piece starts with no pending lock/gravity state.
                self.locked = false; self.lock_rem = -1; self.gravity_acc = 0;
                self.spawn();
                spawned = true;
            }
        }

        spawned
    }

    fn clear_lines(&mut self) -> u32 {
        // Node parity: scan from the bottom row upward. On a full row, shift
        // every row ABOVE it down by one in a single pass (r = y..1), then zero
        // the top row. Shifting the whole column above — not just the adjacent
        // row — is what makes multi-line clears terminate: after the pass the
        // target row holds whatever was above it and can no longer read as full.
        let mut cleared = 0u32;
        let mut y = (ARENA_H - 1) as i32;
        while y >= 0 {
            if (0..ARENA_W).all(|x| self.grid[y as usize][x] != 0) {
                cleared += 1;
                // Shift every row above down by one (node parity). Copy into a
                // temporary first: indexing the same array twice in one statement
                // would overlap mutable/immutable borrows ([u8; ARENA_W] is Copy).
                for r in (1..=y as usize).rev() {
                    let tmp = self.grid[r - 1];
                    self.grid[r] = tmp;
                }
                self.grid[0] = [0u8; ARENA_W];
            } else { y -= 1; }
        }
        cleared
    }

    pub fn pause(&mut self) { self.paused = true; }
    pub fn resume(&mut self) { self.paused = false; }
    pub fn is_paused(&self) -> bool { self.paused }

    pub fn get_state(&self) -> GameState {
        let mut grid = [[0u8; ARENA_W]; ARENA_H];
        for y in 0..ARENA_H { grid[y] = self.grid[y]; }
        GameState {
            grid,
            current_piece: self.active.clone(),
            ghost_y: self.ghost_y,
            next_queue: self.next_buffer.clone(), // real node-parity peek buffer
            held: self.held.clone(),
            stats: self.stats.clone(),
            tick_count: self.tick_count,
            lock_delay_remaining: self.lock_rem,
            game_over: self.game_over,
        }
    }

    pub fn export_state(&self) -> String {
        serde_json::to_string(&self.get_state()).unwrap_or_default()
    }

    pub fn import_state(&mut self, data: &str) -> Result<(), String> {
        let st: GameState = serde_json::from_str(data).map_err(|e| e.to_string())?;
        for y in 0..ARENA_H {
            for x in 0..ARENA_W {
                self.grid[y][x] = st.grid.get(y).and_then(|r| r.get(x).copied()).unwrap_or(0);
            }
        }
        if let Some(ap) = st.current_piece {
            self.active = Some(ap);
            if !self.ok_at(self.active.as_ref().unwrap()) { return Err("invalid position".into()); }
        } else { self.spawn(); }
        self.ghost_y = st.ghost_y; self.held = st.held; self.stats = st.stats;
        self.tick_count = st.tick_count; self.lock_rem = st.lock_delay_remaining;
        self.paused = false; Ok(())
    }
}
