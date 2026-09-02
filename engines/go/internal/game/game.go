// Package game implements the shared Tetris wire-protocol engine for Go.
// getState() emits canonical camelCase JSON matching the node reference so all
// four engines are byte-semantically equivalent on the wire (see docs/POLYGLOT_PROTOCOL.md).
package game

import (
	"crypto/rand"
	"encoding/json"
	"math/big"
)

const (
	ArenaW      = 10
	ArenaH      = 20
	LockDelay   = 500 // ms
	DefaultTick = 100 // ms broadcast cadence (tick loop)

	gravityBaseMS = 500 // slowest descent step (level 1)
	gravityStepMS = 50  // extra speed per level
	gravityMinMS  = 80  // fastest descent step cap
)

// Piece ID space matches the protocol contract: I=1..L=7.
var pieces = []int{1, 2, 3, 4, 5, 6, 7}

// shapes[piece][rot] is the 4-cell footprint as (row,col) offsets from origin.
//
// This table is BYTE-IDENTICAL to engines/node's BASE-derived SHAPES (rot0..3,
// each rotation a pure 90 deg clockwise transform of the previous). It defines
// the coordinate space every engine emits coordinates in. Because the frontend
// renders ALL engines with its own Node-derived shape table, any divergence here
// made Go emit positions/ghost that render off-center and mis-shaded shadow vs.
// node/rust/python. See POLYGLOT_PROTOCOL.md (single source of truth).
var shapes = map[int][4][4][2]int{
	1: { // I
		{{-1, -2}, {0, -2}, {1, -2}, {2, -2}},
		{{-2, 1}, {-2, 0}, {-2, -1}, {-2, -2}},
		{{1, 2}, {0, 2}, {-1, 2}, {-2, 2}},
		{{2, -1}, {2, 0}, {2, 1}, {2, 2}},
	},
	2: { // O (never rotates)
		{{0, 0}, {-1, 0}, {0, -1}, {-1, -1}},
		{{0, 0}, {0, 1}, {-1, 0}, {-1, 1}},
		{{0, 0}, {1, 0}, {0, 1}, {1, 1}},
		{{0, 0}, {0, -1}, {1, 0}, {1, -1}},
	},
	3: { // T
		{{-1, 0}, {0, 0}, {1, 0}, {0, 1}},
		{{0, 1}, {0, 0}, {0, -1}, {1, 0}},
		{{1, 0}, {0, 0}, {-1, 0}, {0, -1}},
		{{0, -1}, {0, 0}, {0, 1}, {-1, 0}},
	},
	4: { // S
		{{-1, 1}, {0, 1}, {0, 0}, {1, 0}},
		{{1, 1}, {1, 0}, {0, 0}, {0, -1}},
		{{1, -1}, {0, -1}, {0, 0}, {-1, 0}},
		{{-1, -1}, {-1, 0}, {0, 0}, {0, 1}},
	},
	5: { // Z
		{{-1, -1}, {0, -1}, {0, 0}, {1, 0}},
		{{-1, 1}, {-1, 0}, {0, 0}, {0, -1}},
		{{1, 1}, {0, 1}, {0, 0}, {-1, 0}},
		{{1, -1}, {1, 0}, {0, 0}, {0, 1}},
	},
	6: { // J
		{{-1, -1}, {0, -1}, {1, -1}, {1, 0}},
		{{-1, 1}, {-1, 0}, {-1, -1}, {0, -1}},
		{{1, 1}, {0, 1}, {-1, 1}, {-1, 0}},
		{{1, -1}, {1, 0}, {1, 1}, {0, 1}},
	},
	7: { // L
		{{-1, 1}, {0, 1}, {1, 1}, {1, 0}},
		{{1, 1}, {1, 0}, {1, -1}, {0, -1}},
		{{1, -1}, {0, -1}, {-1, -1}, {-1, 0}},
		{{-1, -1}, {-1, 0}, {-1, 1}, {0, 1}},
	},
}

type Position struct {
	X int `json:"x"`
	Y int `json:"y"`
}

// ActivePiece mirrors node/rust: piece id + rotation + position.
type ActivePiece struct {
	Piece int      `json:"piece"`
	Rot   int      `json:"rotation"`
	Pos   Position `json:"position"`
}

// Held uses canonical key "held" with inner {piece, used}. Piece is nil when
// nothing has been held yet.
type Held struct {
	Piece *int `json:"piece"`
	Used  bool `json:"used"`
}

type Stats struct {
	Score        int   `json:"score"`
	Level        int   `json:"level"`
	LinesCleared int64 `json:"linesCleared"`
}

// State is the canonical STATE_UPDATE.data object. All JSON keys are camelCase.
type State struct {
	Grid      [][]int      `json:"grid"`
	Active    *ActivePiece `json:"currentPiece,omitempty"`
	GhostY    int          `json:"ghostY"`
	NextQueue []int        `json:"nextQueue"`
	Held      Held         `json:"held"`
	Stats     Stats        `json:"stats"`
	TickCount int64        `json:"tickCount"`
	LockRem   float64      `json:"lockDelayRemaining"`
	GameOver  bool         `json:"gameOver"`
}

// MarshalJSON guarantees currentPiece is emitted as JSON null (not the omitted
// field) when there is no active piece, matching node/rust option semantics.
func (s State) MarshalJSON() ([]byte, error) {
	type alias struct {
		Grid      [][]int      `json:"grid"`
		Active    *ActivePiece `json:"currentPiece"`
		GhostY    int          `json:"ghostY"`
		NextQueue []int        `json:"nextQueue"`
		Held      Held         `json:"held"`
		Stats     Stats        `json:"stats"`
		TickCount int64        `json:"tickCount"`
		LockRem   float64      `json:"lockDelayRemaining"`
		GameOver  bool         `json:"gameOver"`
	}
	return json.Marshal(alias{
		Grid: s.Grid, Active: s.Active, GhostY: s.GhostY, NextQueue: s.NextQueue,
		Held: s.Held, Stats: s.Stats, TickCount: s.TickCount, LockRem: s.LockRem, GameOver: s.GameOver,
	})
}

// bag is a materialized draw sequence with lazy lookahead, mirroring the node
// BagRandomizer: next() consumes one; getLookahead(n) peeks n without advancing pos.
type bag struct {
	seq    []int
	pos    int
	cursor int
}

func newBag() *bag { return &bag{} }

func (b *bag) resuffle() []int {
	b2 := make([]int, 7)
	copy(b2, pieces)
	for i := len(b2) - 1; i > 0; i-- {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(i+1)))
		if err != nil || n.Sign() < 0 {
			continue
		}
		j := int(n.Int64())
		b2[i], b2[j] = b2[j], b2[i]
	}
	return b2
}

func (b *bag) extend(idx int) {
	for b.cursor <= idx {
		for _, p := range b.resuffle() {
			if b.cursor > idx {
				break
			}
			b.seq = append(b.seq, p)
			b.cursor++
		}
	}
}

func (b *bag) next() int {
	b.extend(b.pos)
	p := b.seq[b.pos]
	b.pos++
	return p
}

// getLookahead peeks n upcoming pieces (imminent first), consuming nothing.
func (b *bag) getLookahead(n int) []int {
	out := make([]int, 0, n)
	for k := 0; k < n; k++ {
		b.extend(b.pos + k)
		out = append(out, b.seq[b.pos+k])
	}
	return out
}

type Game struct {
	grid         [ArenaH][ArenaW]int
	bag          *bag
	active       *ActivePiece
	ghostY       int
	held         Held
	stats        Stats
	tickN        int64
	lockRem      float64
	paused       bool
	gameOver     bool
	locked       bool    // lock-delay armed (piece can't step down)
	gravityAccum float64 // ms accumulated toward the next descent step
	nextBuffer   []int   // 5-deep non-consuming peek, refreshed on draw/spawn/hold
}

func NewGame() *Game {
	g := &Game{bag: newBag()}
	spawnNext(g)
	return g
}

// spawnColumn centers the piece's rotation-0 footprint on the board, matching
// node's Math.round() formula exactly. Plain integer division floors half-cases,
// which dropped width-2 footprints (I vertical, O, Z, J) a column off-center —
// that was the "not centered / spawn at same x for everything" bug. Node:
//
//	minCol = Math.round((ARENA_W - 1 - span) / 2); return minCol - minX
func spawnColumn(p int) int {
	row0 := shapes[p][0]
	minX, maxX := 1<<30, -(1 << 30)
	for _, off := range row0 {
		if off[1] < minX {
			minX = off[1]
		}
		if off[1] > maxX {
			maxX = off[1]
		}
	}
	span := maxX - minX
	// (ArenaW-1-span+1)/2 == round((ArenaW-1-span)/2) for non-negative numerators,
	// replicating Math.round's half-up rounding without pulling in math.Round.
	leftCol := (ArenaW - 1 - span + 1) / 2
	return leftCol - minX
}

func spawnNew(p int) *ActivePiece {
	return &ActivePiece{Piece: p, Rot: 0, Pos: Position{X: spawnColumn(p), Y: 0}}
}

func spawnNext(g *Game) {
	p := g.bag.next()
	g.active = spawnNew(p)
	if !g.okAt(p, 0, g.active.Pos.X, g.active.Pos.Y) {
		g.gameOver = true // no room to drop a fresh piece at top -> freeze
		g.active = nil
		return
	}
	// Fresh piece starts clean: no pending lock or accumulated gravity.
	g.locked = false
	g.gravityAccum = 0
	g.syncNextBuffer()
	g.recalcGhost()
}

func (g *Game) okAt(piece, rot, px, py int) bool {
	for _, off := range shapes[piece][rot] {
		y, x := py+off[0], px+off[1]
		if x < 0 || x >= ArenaW || y >= ArenaH {
			return false
		}
		if y >= 0 && g.grid[y][x] != 0 {
			return false
		}
	}
	return true
}

// canStepDown reports whether the active piece can descend one cell.
func (g *Game) canStepDown() bool {
	if g.active == nil {
		return false
	}
	return g.okAt(g.active.Piece, g.active.Rot, g.active.Pos.X, g.active.Pos.Y+1)
}

// gravityInterval is the per-cell descent interval (ms) for the current level,
// matching node exactly: max(gravityMinMS, gravityBaseMS-(level-1)*gravityStepMS),
// where level 0 counts as 1. Slow at the lowest level, accelerating by step ms.
func (g *Game) gravityInterval() float64 {
	level := g.stats.Level
	if level < 1 {
		level = 1
	}
	interval := float64(gravityBaseMS) - float64(level-1)*float64(gravityStepMS)
	if interval < gravityMinMS {
		interval = gravityMinMS
	}
	return interval
}

func (g *Game) ok(ap *ActivePiece) bool {
	return g.okAt(ap.Piece, ap.Rot, ap.Pos.X, ap.Pos.Y)
}

// syncNextBuffer refreshes the display peek buffer from the materialized stream.
func (g *Game) syncNextBuffer() {
	g.nextBuffer = g.bag.getLookahead(5)
}

// reset clears the board and stats and starts a fresh game (NEW_GAME handler).
func (g *Game) Reset() {
	for y := range g.grid {
		for x := range g.grid[y] {
			g.grid[y][x] = 0
		}
	}
	g.stats = Stats{}
	g.held = Held{Piece: nil, Used: false}
	g.tickN = 0
	g.lockRem = -1
	g.gameOver = false
	spawnNext(g)
	g.syncNextBuffer()
}

func (g *Game) recalcGhost() {
	if g.active == nil {
		g.ghostY = -1
		return
	}
	gy := g.active.Pos.Y
	for gy+1 < ArenaH && g.okAt(g.active.Piece, g.active.Rot, g.active.Pos.X, gy+1) {
		gy++
	}
	g.ghostY = gy
}

func (g *Game) moveTo(ap *ActivePiece, nx, ny int) bool {
	if g.okAt(ap.Piece, ap.Rot, nx, ny) {
		ap.Pos = Position{X: nx, Y: ny}
		g.lockRem = LockDelay
		g.recalcGhost()
		return true
	}
	return false
}

func (g *Game) MoveLeft() bool {
	if g.active == nil {
		return false
	}
	return g.moveTo(g.active, g.active.Pos.X-1, g.active.Pos.Y)
}

func (g *Game) MoveRight() bool {
	if g.active == nil {
		return false
	}
	return g.moveTo(g.active, g.active.Pos.X+1, g.active.Pos.Y)
}

// wallKicks returns SRS kick offsets. diff==1 => CW else CCW.
func wallKicks(piece, fromRot, toRot int) [][2]int {
	diff := (toRot - fromRot + 4) % 4
	switch piece {
	case 6, 7: // J or L
		if diff == 1 || diff == 3 {
			return [][2]int{{0, 0}, {-1, 0}, {-1, -1}, {0, 2}, {-1, 2}}
		}
		return [][2]int{{0, 0}, {1, 0}, {1, -1}, {0, 2}, {1, 2}}
	case 3, 4, 5: // T, S, Z
		if diff == 1 || diff == 3 {
			return [][2]int{{0, 0}, {-1, 0}, {-1, 1}, {0, -2}, {-1, -2}}
		}
		return [][2]int{{0, 0}, {1, 0}, {1, -1}, {0, 2}, {1, 2}}
	case 1: // I
		if diff == 1 {
			return [][2]int{{0, 0}, {-2, 0}, {1, 0}, {-2, 1}, {1, -2}}
		}
		return [][2]int{{0, 0}, {2, 0}, {-1, 0}, {2, -1}, {-1, 2}}
	default: // O
		return [][2]int{{0, 0}}
	}
}

func (g *Game) RotateCW() bool {
	if g.active == nil || g.active.Piece == 2 {
		return false
	}
	nr := (g.active.Rot + 1) % 4
	for _, off := range wallKicks(g.active.Piece, g.active.Rot, nr) {
		nx, ny := g.active.Pos.X+off[0], g.active.Pos.Y+off[1]
		if g.okAt(g.active.Piece, nr, nx, ny) {
			g.active.Rot = nr
			g.active.Pos = Position{X: nx, Y: ny}
			g.lockRem = LockDelay
			g.recalcGhost()
			return true
		}
	}
	return false
}

func (g *Game) RotateCCW() bool {
	if g.active == nil || g.active.Piece == 2 {
		return false
	}
	nr := (g.active.Rot + 3) % 4 // -1 mod 4
	for _, off := range wallKicks(g.active.Piece, g.active.Rot, nr) {
		nx, ny := g.active.Pos.X+off[0], g.active.Pos.Y+off[1]
		if g.okAt(g.active.Piece, nr, nx, ny) {
			g.active.Rot = nr
			g.active.Pos = Position{X: nx, Y: ny}
			g.lockRem = LockDelay
			g.recalcGhost()
			return true
		}
	}
	return false
}

func (g *Game) SoftDrop() int {
	if g.active == nil {
		return 0
	}
	n := 0
	// Single-cell step per call (node parity). A held Down key fires many
	// SOFT_DROP messages via OS auto-repeat, so the piece falls gradually.
	// Walking to the bottom here would make soft drop read like a hard drop.
	if g.moveTo(g.active, g.active.Pos.X, g.active.Pos.Y+1) {
		n++
		g.stats.Score += n // single-cell scoring per node parity
	}
	return n
}

func (g *Game) HardDrop() int {
	if g.active == nil {
		return 0
	}
	n := 0
	for g.okAt(g.active.Piece, g.active.Rot, g.active.Pos.X, g.active.Pos.Y+1) {
		g.moveTo(g.active, g.active.Pos.X, g.active.Pos.Y+1)
		n++
	}
	g.stats.Score += n * 2 // hard drop scoring
	g.commitLock()
	return n
}

func (g *Game) Hold() bool {
	if g.active == nil {
		return false
	}
	cur := g.active.Piece
	if g.held.Piece != nil && g.held.Used {
		// SWAP: promote held piece, keep scheduled queue.
		ph := cur
		g.held = Held{Piece: &ph, Used: true}
		ap := spawnNew(*g.held.Piece)
		g.active = ap
	} else {
		// First hold: park current from bag, pull fresh.
		gh := cur
		g.held = Held{Piece: &gh, Used: true}
		g.active = spawnNew(g.bag.next())
	}
	if g.active != nil && !g.ok(g.active) {
		g.gameOver = true
		g.active = nil
		return false
	}
	g.lockRem = -1
	g.syncNextBuffer()
	g.recalcGhost()
	return true
}

// clearLines removes fully-filled rows and compacts the stack down by the
// number of cleared rows, matching node's clearLines() byte-for-byte in behavior.
//
// The pre-fix version used a backwards copy that never emptied row y, so once a
// bottom row was detected full it re-detected as full forever: every real line
// clear hung the engine (the reported "stuck on line creation / new piece won't
// drop" regression). Node's algorithm shifts rows [0..y-1] down into [1..y],
// clears the top row, then RE-EXAMINES index y without decrementing — so a
// second full row that just slid into position is caught in the same pass.
func (g *Game) clearLines() int {
	cleared := 0
	y := ArenaH - 1
	for y >= 0 {
		full := true
		for _, c := range g.grid[y] {
			if c == 0 {
				full = false
				break
			}
		}
		if full {
			cleared++
			// Shift every row above down by one into the cleared slot. copy needs
			// slices, so slice the fixed-width rows ([]int) explicitly.
			for r := y; r > 0; r-- {
				copy(g.grid[r][:], g.grid[r-1][:])
			}
			// Fresh empty row at the top.
			for x := range g.grid[0] {
				g.grid[0][x] = 0
			}
			// Intentionally do NOT decrement y: the row now sitting at index y is
			// whatever slid down from above, and must be re-checked in this pass so
			// multiple adjacent full rows clear together. Mirrors node's while loop.
		} else {
			y--
		}
	}
	return cleared
}

func (g *Game) commitLock() {
	if g.active != nil {
		for _, off := range shapes[g.active.Piece][g.active.Rot] {
			y, x := g.active.Pos.Y+off[0], g.active.Pos.X+off[1]
			if y >= 0 && y < ArenaH && x >= 0 && x < ArenaW {
				g.grid[y][x] = g.active.Piece
			}
		}
	}
	cleared := g.clearLines()
	if cleared > 0 {
		bonus := map[int]int{1: 100, 2: 300, 3: 500, 4: 800}[cleared]
		g.stats.LinesCleared += int64(cleared)
		g.stats.Score += bonus * g.stats.Level
		g.stats.Level = int(g.stats.LinesCleared/10) + 1
	}
	spawnNext(g)
}

// Tick advances gravity by dtMs (time-accumulated, level-scaled) and runs the
// lock-delay countdown. Returns true once a piece locks + spawns during this step.
// The descent is time-based, not tick-count based, so it stays correct regardless
// of broadcast cadence — matching node's gravityAccum model exactly.
func (g *Game) Tick(dtMs float64) bool {
	if dtMs < 0 || dtMs > 5000 {
		dtMs = DefaultTick // clamp after stalls to avoid spiral-of-death
	}
	spawned := false
	if g.active != nil && !g.gameOver {
		// --- Gravity: time-accumulated descent. Independent of the caller's dt
		// granularity so speed stays correct regardless of tick rate.
		if !g.locked {
			g.gravityAccum += dtMs
			interval := g.gravityInterval()
			for g.gravityAccum >= interval && g.canStepDown() {
				g.moveTo(g.active, g.active.Pos.X, g.active.Pos.Y+1)
				g.gravityAccum -= interval
			}
			// Settled on the bottom: arm the lock delay (guard !g.locked so a
			// stuck-at-bottom piece re-arms only once).
			if !g.canStepDown() {
				g.lockRem = LockDelay
				g.locked = true
			}
		}
		// --- Lock countdown, then commit once the delay elapses.
		if g.locked {
			g.lockRem -= dtMs
			if g.lockRem <= 0 {
				g.commitLock()
				spawned = true
			}
		}
	} else if g.gameOver || g.active == nil {
		// No active piece (game over): still drain any residual lock state.
		if g.lockRem >= 0 {
			g.lockRem -= dtMs
			if g.lockRem <= 0 && g.locked {
				g.locked = false
			}
		}
	}
	return spawned
}

// GetState returns the canonical state. Active stays nil when no active piece,
// so MarshalJSON emits currentPiece as null.
func (g *Game) GetState() State {
	grid := make([][]int, ArenaH)
	for y := range grid {
		grid[y] = make([]int, ArenaW)
		copy(grid[y], g.grid[y][:])
	}
	nq := g.nextBuffer
	if nq == nil {
		nq = []int{}
	}
	held := g.held
	if held.Piece == nil {
		held = Held{Piece: nil, Used: false}
	}
	return State{
		Grid:      grid,
		Active:    g.active, // nil => currentPiece:null on the wire
		GhostY:    g.ghostY,
		NextQueue: nq,
		Held:      held,
		Stats:     g.stats,
		TickCount: g.tickN,
		LockRem:   g.lockRem,
		GameOver:  g.gameOver,
	}
}

func (g *Game) ExportState() string {
	b, err := json.Marshal(g.GetState())
	if err != nil {
		return "{}"
	}
	return string(b)
}

func (g *Game) ImportState(data string) error {
	var st State
	if err := json.Unmarshal([]byte(data), &st); err != nil {
		return err
	}
	for y := 0; y < ArenaH && y < len(st.Grid); y++ {
		for x := 0; x < ArenaW && x < len(st.Grid[y]); x++ {
			if st.Grid[y][x] >= 0 {
				g.grid[y][x] = st.Grid[y][x]
			}
		}
	}
	if st.Active != nil && st.Active.Piece > 0 {
		g.active = &ActivePiece{Piece: st.Active.Piece, Rot: st.Active.Rot, Pos: st.Active.Pos}
	} else {
		spawnNext(g)
	}
	g.ghostY = st.GhostY
	h := st.Held
	if h.Piece == nil {
		h = Held{Piece: nil, Used: false}
	}
	g.held = h
	g.stats = st.Stats
	g.tickN = st.TickCount
	if g.nextBuffer == nil {
		g.syncNextBuffer()
	}
	return nil
}

func (g *Game) Pause()  { g.paused = true }
func (g *Game) Resume() { g.paused = false }
