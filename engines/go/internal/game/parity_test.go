package game

import (
	"testing"
)

// Reference conventions lifted verbatim from engines/node/src/game.ts and the
// live node build. Every engine must be byte-semantically equivalent on the wire
// (docs/POLYGLOT_PROTOCOL.md), so Go's emitted coordinates must match these EXACTLY.
var (
	nodeSpawn = map[int]int{1: 7, 2: 5, 3: 4, 4: 4, 5: 5, 6: 5, 7: 4}        // rotation-0 centered x
	nodeGhost = map[int]int{1: 17, 2: 19, 3: 18, 4: 18, 5: 18, 6: 18, 7: 18} // fresh empty ghostY @rot0
)

// nodeShapes mirrors engines/node's BASE-derived SHAPES, rotation 0..3 (CW).
var nodeShapes = map[int][4][4][2]int{
	1: {
		{{-1, -2}, {0, -2}, {1, -2}, {2, -2}},
		{{-2, 1}, {-2, 0}, {-2, -1}, {-2, -2}},
		{{1, 2}, {0, 2}, {-1, 2}, {-2, 2}},
		{{2, -1}, {2, 0}, {2, 1}, {2, 2}},
	},
	2: {
		{{0, 0}, {-1, 0}, {0, -1}, {-1, -1}},
		{{0, 0}, {0, 1}, {-1, 0}, {-1, 1}},
		{{0, 0}, {1, 0}, {0, 1}, {1, 1}},
		{{0, 0}, {0, -1}, {1, 0}, {1, -1}},
	},
	3: {
		{{-1, 0}, {0, 0}, {1, 0}, {0, 1}},
		{{0, 1}, {0, 0}, {0, -1}, {1, 0}},
		{{1, 0}, {0, 0}, {-1, 0}, {0, -1}},
		{{0, -1}, {0, 0}, {0, 1}, {-1, 0}},
	},
	4: {
		{{-1, 1}, {0, 1}, {0, 0}, {1, 0}},
		{{1, 1}, {1, 0}, {0, 0}, {0, -1}},
		{{1, -1}, {0, -1}, {0, 0}, {-1, 0}},
		{{-1, -1}, {-1, 0}, {0, 0}, {0, 1}},
	},
	5: {
		{{-1, -1}, {0, -1}, {0, 0}, {1, 0}},
		{{-1, 1}, {-1, 0}, {0, 0}, {0, -1}},
		{{1, 1}, {0, 1}, {0, 0}, {-1, 0}},
		{{1, -1}, {1, 0}, {0, 0}, {0, 1}},
	},
	6: {
		{{-1, -1}, {0, -1}, {1, -1}, {1, 0}},
		{{-1, 1}, {-1, 0}, {-1, -1}, {0, -1}},
		{{1, 1}, {0, 1}, {-1, 1}, {-1, 0}},
		{{1, -1}, {1, 0}, {1, 1}, {0, 1}},
	},
	7: {
		{{-1, 1}, {0, 1}, {1, 1}, {1, 0}},
		{{1, 1}, {1, 0}, {1, -1}, {0, -1}},
		{{1, -1}, {0, -1}, {-1, -1}, {-1, 0}},
		{{-1, -1}, {-1, 0}, {-1, 1}, {0, 1}},
	},
}

func TestShapesMatchNodeByteIdentical(t *testing.T) {
	for p := 1; p <= 7; p++ {
		for r := 0; r < 4; r++ {
			if shapes[p][r] != nodeShapes[p][r] {
				t.Fatalf("piece %d rot %d: go shape %+v != node shape %+v", p, r, shapes[p][r], nodeShapes[p][r])
			}
		}
	}
}

func TestSpawnColumnMatchesNode(t *testing.T) {
	for p := 1; p <= 7; p++ {
		if got := spawnColumn(p); got != nodeSpawn[p] {
			t.Fatalf("piece %d: spawn.x=%d want %d", p, got, nodeSpawn[p])
		}
	}
}

func TestFreshGhostMatchesNode(t *testing.T) {
	for p := 1; p <= 7; p++ {
		g := &Game{bag: newBag()}
		x := spawnColumn(p)
		g.active = &ActivePiece{Piece: p, Rot: 0, Pos: Position{X: x, Y: 0}}
		g.recalcGhost()
		if g.ghostY != nodeGhost[p] {
			t.Fatalf("piece %d: fresh ghostY=%d want %d", p, g.ghostY, nodeGhost[p])
		}
	}
}

// Ghost must be computed in the SAME coordinate space the frontend renders in
// (node shapes applied to Go's emitted x/y). With identical shapes this is now
// guaranteed: ghost cell == where the piece would actually land.
func TestGhostLandsOnActualFloor(t *testing.T) {
	// Stack rows y=18..19 so a piece whose rotation-0 spans rows 0..? must rest
	// exactly one above the stack (ghostY = top of stack relative to origin).
	for _, p := range []int{1, 2, 3, 4, 5, 6, 7} {
		g := &Game{bag: newBag()}
		for y := ArenaH - 1; y >= ArenaH-1; y-- { // fill bottom row only
			for x := 0; x < ArenaW; x++ {
				g.grid[y][x] = 1
			}
		}
		x := spawnColumn(p)
		g.active = &ActivePiece{Piece: p, Rot: 0, Pos: Position{X: x, Y: 0}}
		g.recalcGhost()
		// The ghost bottom row (gy+maxRowOffset) must be the empty row just above.
		maxR := -1 << 30
		for _, off := range shapes[p][0] {
			if off[0] > maxR {
				maxR = off[0]
			}
		}
		floorEmptyRow := ArenaH - 2
		want := floorEmptyRow - maxR
		if g.ghostY != want {
			t.Fatalf("piece %d over filled bottom row: ghostY=%d want %d (maxR=%d)", p, g.ghostY, want, maxR)
		}
	}
}

// Issue #1 guard: a brand-new empty game is PLAYABLE (not frozen at gameOver),
// so the connect-time state a fresh client receives must not show an instant loss.
func TestFreshGameIsPlayable(t *testing.T) {
	g := NewGame()
	if g.gameOver || g.active == nil {
		t.Fatalf("fresh NewGame should be playable, got gameOver=%v activeNil=%v", g.gameOver, g.active == nil)
	}
	st := g.GetState()
	if st.GameOver || st.Active == nil {
		t.Fatalf("fresh GetState must not be game-over: gameOver=%v activeNil=%v", st.GameOver, st.Active == nil)
	}
}
