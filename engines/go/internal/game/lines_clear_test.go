package game

import (
	"testing"
	"time"
)

// Guarded reproduction of the line-clear bug. clearLines() has an unbounded
// loop risk, so we run it on a goroutine with a hard timeout and report a
// failure if it neither returns nor produces the correct cleared board.
func (g *Game) clearLinesGuarded() (int, bool) {
	type res struct {
		n    int
		done bool
	}
	ch := make(chan res, 1)
	go func() {
		n := g.clearLines()
		ch <- res{n, true}
	}()
	select {
	case r := <-ch:
		return r.n, r.done
	case <-time.After(200 * time.Millisecond):
		return -1, false // timed out => the classic stuck-on-line-create hang
	}
}

func (g *Game) fillBottom(v int) {
	for x := range g.grid[0] {
		g.grid[ArenaH-1][x] = v
	}
}

// TestClearSingleBottomRow proves the fix: a full bottom row clears to zero
// and returns cleared==1. On the pre-fix code this times out (infinite loop).
func TestClearSingleBottomRow(t *testing.T) {
	g := &Game{}
	g.fillBottom(3)
	n, ok := g.clearLinesGuarded()
	if !ok {
		t.Fatalf("clearLines timed out / hung (infinite loop on a cleared row)")
	}
	if n != 1 {
		t.Fatalf("expected cleared==1, got %d", n)
	}
	for x := range g.grid[0] {
		if g.grid[ArenaH-1][x] != 0 {
			t.Fatalf("bottom row not emptied: grid[%d]=%d", ArenaH-1, g.grid[ArenaH-1][x])
		}
	}
}

// TestClearFourRows proves all four rows can clear in one pass and the board
// compacts cleanly to empty with cleared==4.
func TestClearFourRows(t *testing.T) {
	g := &Game{}
	for y := ArenaH - 1; y >= ArenaH-4; y-- {
		for x := range g.grid[0] {
			g.grid[y][x] = 5
		}
	}
	n, ok := g.clearLinesGuarded()
	if !ok || n != 4 {
		t.Fatalf("expected cleared==4, got %d (done=%v)", n, ok)
	}
	for y := range g.grid {
		for x := range g.grid[0] {
			if g.grid[y][x] != 0 {
				t.Fatalf("board not fully compacted: grid[%d][%d]=%d", y, x, g.grid[y][x])
			}
		}
	}
}

// TestClearTwoAdjacentRows proves two adjacent full rows clear in one pass,
// terminating cleanly and compacting everything above down by exactly two.
func TestClearTwoAdjacentRows(t *testing.T) {
	g := &Game{}
	g.fillBottom(4)
	g.grid[ArenaH-2][0] = 6 // top-left cell marker
	for x := range g.grid[0] {
		g.grid[ArenaH-2][x] = 6
	}
	n, ok := g.clearLinesGuarded()
	if !ok || n != 2 {
		t.Fatalf("expected cleared==2, got %d (done=%v)", n, ok)
	}
	for y := range g.grid {
		for x := range g.grid[0] {
			if g.grid[y][x] != 0 {
				t.Fatalf("expected fully-empty board after clearing two bottom rows, got grid[%d][%d]=%d", y, x, g.grid[y][x])
			}
		}
	}
}
