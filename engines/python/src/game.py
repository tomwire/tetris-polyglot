"""Core Tetris game engine — Python implementation of the unified protocol contract."""

import json
import math
import random
from dataclasses import asdict, dataclass, field
from typing import Optional


ARENA_W = 10
ARENA_H = 20
LOCK_DELAY_MS = 500

# Level-scaled gravity (classic Tetris feel), independent of tick granularity.
# Per-cell descent interval = max(80, 500 - (level-1)*50) ms; level 0 counts as 1.
GRAVITY_BASE_MS = 500   # slowest descent step (level 1)
GRAVITY_STEP_MS = 50    # extra speed per level
GRAVITY_MIN_MS = 80     # fastest descent step (floor)

# Piece IDs (1-7) matching protocol contract
PIECE_I, PIECE_O, PIECE_T, PIECE_S, PIECE_Z, PIECE_J, PIECE_L = 1, 2, 3, 4, 5, 6, 7


@dataclass
class Position:
    x: int
    y: int


@dataclass
class ActivePiece:
    piece: int
    rotation: int
    position: Position


@dataclass
class HoldState:
    piece: Optional[int] = None
    used: bool = False


@dataclass
class Stats:
    score: int = 0
    level: int = 0
    lines_cleared: int = 0


@dataclass
class GameState:
    grid: list[list[int]] = field(default_factory=list)
    current_piece: Optional[ActivePiece] = None
    ghost_y: int = -1
    next_queue: list[int] = field(default_factory=list)
    held: HoldState = field(default_factory=HoldState)
    stats: Stats = field(default_factory=Stats)
    tick_count: int = 0
    lock_delay_remaining: float = -1.0
    game_over: bool = False


# Base tetrominoes: one representative orientation each. Every rotation state is
# derived by applying a pure 90 deg clockwise transform (r, c) -> (c, -r), so each
# state is exactly a quarter-turn of the previous — hand-transcribed tables were the
# root cause of rotations morphing into invalid shapes.
_BASE: dict[int, list[tuple[int, int]]] = {
    PIECE_I: [(-1, -2), (0, -2), (1, -2), (2, -2)],
    PIECE_O: [(0, 0), (-1, 0), (0, -1), (-1, -1)],
    PIECE_T: [(-1, 0), (0, 0), (1, 0), (0, 1)],
    PIECE_S: [(-1, 1), (0, 1), (0, 0), (1, 0)],
    PIECE_Z: [(-1, -1), (0, -1), (0, 0), (1, 0)],
    PIECE_J: [(-1, -1), (0, -1), (1, -1), (1, 0)],
    PIECE_L: [(-1, 1), (0, 1), (1, 1), (1, 0)],
}


def _rot_cw(cells: list[tuple[int, int]]) -> list[tuple[int, int]]:
    return [(c, -r) for (r, c) in cells]


_SHAPES: dict[int, list[list[tuple[int, int]]]] = {}
for _p, _base in _BASE.items():
    _rotations: list[list[tuple[int, int]]] = []
    _cur = _base
    for _k in range(4):
        _rotations.append(list(_cur))
        _cur = _rot_cw(_cur)
    _SHAPES[_p] = _rotations


def _wall_kicks(piece: int, from_rot: int, to_rot: int) -> list[tuple[int, int]]:
    """SRS wall kick offsets."""
    diff = ((to_rot - from_rot) % 4 + 4) % 4
    if piece in (PIECE_J, PIECE_L):
        return [(0, 0), (-1, 0), (-1, -1), (0, 2), (-1, 2)] if diff in (1, 3) else [(0, 0), (1, 0), (1, -1), (0, 2), (1, 2)]
    if piece in (PIECE_T, PIECE_S, PIECE_Z):
        return [(0, 0), (-1, 0), (-1, 1), (0, -2), (-1, -2)] if diff in (1, 3) else [(0, 0), (1, 0), (1, -1), (0, 2), (1, 2)]
    if piece == PIECE_I:
        return [(0, 0), (-2, 0), (1, 0), (-2, 1), (1, -2)] if diff == 1 else [(0, 0), (2, 0), (-1, 0), (2, -1), (-1, 2)]
    return [(0, 0)]


class BagRandomizer:
    """Standard 7-bag randomizer with node-parity lookahead.

    `seq` is a materialized stream of pieces (bag by bag). `pos` is the index of
    the next piece to draw and advances one per `next()`. `getLookahead(n)` reads
    pos..pos+n-1 WITHOUT advancing pos, so the display's "next" queue can never
    disagree with what actually spawns. Active-piece draws (spawn/hold) consume via
    next(); only lookahead peeks at the already-materialized stream.
    """

    _PIECES = [PIECE_I, PIECE_O, PIECE_T, PIECE_S, PIECE_Z, PIECE_J, PIECE_L]

    def __init__(self):
        self.seq: list[int] = []
        self.pos = 0
        self._extend(self.pos + 1)

    def _resuffle(self) -> list[int]:
        b = list(BagRandomizer._PIECES)
        for i in range(len(b) - 1, 0, -1):  # Fisher-Yates
            j = random.randint(0, i)
            b[i], b[j] = b[j], b[i]
        return b

    def _extend(self, idx: int) -> None:
        """Ensure seq has at least idx+1 materialized pieces (fresh bag boundaries)."""
        while len(self.seq) <= idx:
            # When the materialized stream reaches a new-bag boundary, append the
            # next fully-shuffled 7-bag so the stream never runs short mid-bag.
            if not self.seq or len(self.seq) % len(BagRandomizer._PIECES) == 0:
                self.seq.extend(self._resuffle())
            else:
                # Fill the remainder of the current bag in 7-slot chunks.
                filled = len(self.seq)
                used = filled % len(BagRandomizer._PIECES)
                self.seq.extend(BagRandomizer._PIECES[used:])

    def next(self) -> int:
        p = self.seq[self.pos]
        self.pos += 1
        self._extend(self.pos + 1)
        return p

    def getLookahead(self, n: int = 5) -> list[int]:
        out: list[int] = []
        for k in range(n):
            idx = self.pos + k
            self._extend(idx)
            out.append(self.seq[idx])
        return out


class Game:
    """Core Tetris game engine."""

    def __init__(self):
        self.grid: list[list[int]] = [[0] * ARENA_W for _ in range(ARENA_H)]
        self.bag = BagRandomizer()
        self.active: Optional[ActivePiece] = None
        self.ghost_y = -1
        self.held = HoldState()
        self.stats = Stats()
        self.tick_count = 0
        self.lock_rem = -1.0
        self.locked = False
        self.last_tick_ms = 0
        self.gravityAccum = 0.0
        self.paused = False
        self.game_over = False
        self.next_buffer: list[int] = []
        self.spawn_next()

    def reset(self) -> None:
        self.grid = [[0] * ARENA_W for _ in range(ARENA_H)]
        self.stats = Stats()
        self.held = HoldState()
        self.tick_count = 0
        self.lock_rem = -1.0
        self.gravityAccum = 0.0
        self.spawn_next()

    def _spawn_column(self, piece: int) -> int:
        # Mirror node's spawnColumn(): center each tetromino by its rotation-0
        # column span, so the I-piece (and every other) drops dead-center like
        # standard Tetris instead of a single fixed x for all pieces.
        dxs = [c for (_r, c) in _SHAPES[piece][0]]
        span = max(dxs) - min(dxs)
        return math.floor((ARENA_W - 1 - span) / 2 + 0.5) - min(dxs)

    def spawn_next(self) -> None:
        p = self.bag.next()
        self.active = ActivePiece(
            piece=p, rotation=0,
            position=Position(x=self._spawn_column(p), y=0),
        )
        if not self._ok_at(self.active):
            # No room to spawn a fresh piece at the top of the board → game over.
            # Freeze: null out the active piece so gravity/movement no-op while the
            # settled stack stays visible. Resetting here (silent restart) used to
            # make it impossible to ever signal a loss, mirroring node's behavior.
            self.game_over = True
            self.next_buffer = []
            self.active = None
            return
        self.next_buffer = self.bag.getLookahead(5)
        # Fresh piece starts with no pending lock/gravity state.
        self.locked = False
        self.lock_rem = -1.0
        self.gravityAccum = 0.0
        self.recalc_ghost()

    def _ok_at(self, ap: ActivePiece) -> bool:
        shape = _SHAPES[ap.piece][ap.rotation]
        for dy, dx in shape:
            y, x = ap.position.y + dy, ap.position.x + dx
            if x < 0 or x >= ARENA_W or y >= ARENA_H:
                return False
            if y >= 0 and self.grid[y][x] != 0:
                return False
        return True

    def _ok_pos(self, piece: int, rot: int, px: int, py: int) -> bool:
        shape = _SHAPES[piece][rot]
        for dy, dx in shape:
            y, x = py + dy, px + dx
            if x < 0 or x >= ARENA_W or y >= ARENA_H:
                return False
            if y >= 0 and self.grid[y][x] != 0:
                return False
        return True

    def _move_to(self, ap: ActivePiece, nx: int, ny: int) -> bool:
        candidate = ActivePiece(piece=ap.piece, rotation=ap.rotation, position=Position(nx, ny))
        if self._ok_at(candidate):
            ap.position = Position(nx, ny)
            self.lock_rem = LOCK_DELAY_MS
            self.locked = False
            self.recalc_ghost()
            return True
        return False

    def recalc_ghost(self) -> None:
        if not self.active:
            self.ghost_y = -1
            return
        gy = self.active.position.y
        while gy + 1 < ARENA_H and self._ok_pos(self.active.piece, self.active.rotation, self.active.position.x, gy + 1):
            gy += 1
        self.ghost_y = gy

    def _frozen(self) -> bool:
        return self.game_over or self.active is None

    def move_left(self) -> bool:
        if self._frozen(): return False
        return self._move_to(self.active, self.active.position.x - 1, self.active.position.y)

    def move_right(self) -> bool:
        if self._frozen(): return False
        return self._move_to(self.active, self.active.position.x + 1, self.active.position.y)

    def rotate_cw(self) -> bool:
        if self._frozen() or self.active.piece == PIECE_O: return False
        nr = (self.active.rotation + 1) % 4
        for kx, ky in _wall_kicks(self.active.piece, self.active.rotation, nr):
            nx, ny = self.active.position.x + kx, self.active.position.y + ky
            if self._ok_at(ActivePiece(self.active.piece, nr, Position(nx, ny))):
                self.active.rotation = nr
                self.active.position = Position(nx, ny)
                self.lock_rem = LOCK_DELAY_MS
                self.locked = False
                self.recalc_ghost()
                return True
        return False

    def rotate_ccw(self) -> bool:
        if self._frozen() or self.active.piece == PIECE_O: return False
        nr = 3 if self.active.rotation == 0 else self.active.rotation - 1
        for kx, ky in _wall_kicks(self.active.piece, self.active.rotation, nr):
            nx, ny = self.active.position.x + kx, self.active.position.y + ky
            if self._ok_at(ActivePiece(self.active.piece, nr, Position(nx, ny))):
                self.active.rotation = nr
                self.active.position = Position(nx, ny)
                self.lock_rem = LOCK_DELAY_MS
                self.locked = False
                self.recalc_ghost()
                return True
        return False

    def soft_drop(self) -> int:
        # Single-cell step per call (node parity). A held Down key fires many
        # SOFT_DROP messages via OS auto-repeat, so the piece falls gradually.
        # Walking to the bottom here would make soft drop read like a hard drop.
        n = 0
        if self._frozen(): return 0
        if self._move_to(self.active, self.active.position.x, self.active.position.y + 1):
            n += 1
        self.stats.score += n
        return n

    def hard_drop(self) -> int:
        n = 0
        if self._frozen(): return 0
        ap = ActivePiece(self.active.piece, self.active.rotation, self.active.position)
        while self._ok_pos(ap.piece, ap.rotation, ap.position.x, ap.position.y + 1):
            ap.position.y += 1
            n += 1
        # Write piece at final position
        shape = _SHAPES[ap.piece][ap.rotation]
        for dy, dx in shape:
            y, x = ap.position.y + dy, ap.position.x + dx
            if 0 <= y < ARENA_H and 0 <= x < ARENA_W:
                self.grid[y][x] = ap.piece
        self.stats.score += n * 2
        self._lock_after_drop()
        return n

    def _lock_after_drop(self) -> None:
        cleared = self._clear_lines()
        if cleared > 0:
            bonus = {1: 100, 2: 300, 3: 500, 4: 800}.get(cleared, 0)
            self.stats.lines_cleared += cleared
            self.stats.score += bonus * self.stats.level
            self.stats.level = self.stats.lines_cleared // 10 + 1
        self.spawn_next()

    def hold(self) -> bool:
        if not self.active: return False
        cur = self.active.piece
        if self.held.piece is not None and self.held.used:
            # SWAP (second+ press): release the held piece to the top and stash
            # the active one. No bag draw — both pieces are already scheduled,
            # so this lets you hold → swap back → choose what to hold again.
            promoted = self.held.piece
            self.held.piece = cur
            self.active = ActivePiece(
                piece=promoted, rotation=0, position=Position(self._spawn_column(promoted), 0),
            )
        else:
            # FIRST hold: park the current piece and pull a fresh one from the bag.
            self.held.piece = cur
            self.held.used = True
            new_p = self.bag.next()
            self.active = ActivePiece(
                piece=new_p, rotation=0, position=Position(self._spawn_column(new_p), 0),
            )
        if not self._ok_at(self.active):
            self.game_over = True
            self.next_buffer = []
            self.active = None
            return True
        # Fresh active starts with no pending lock/gravity state.
        self.locked = False
        self.lock_rem = -1.0
        self.gravityAccum = 0.0
        self.recalc_ghost()
        return True

    def gravity_interval(self) -> float:
        """Per-cell descent interval (ms) for the current level."""
        level = max(1, self.stats.level)
        return max(GRAVITY_MIN_MS, GRAVITY_BASE_MS - (level - 1) * GRAVITY_STEP_MS)

    def can_step_down(self) -> bool:
        """True if the active piece can step down one cell without collision."""
        if not self.active:
            return False
        cand = ActivePiece(
            piece=self.active.piece,
            rotation=self.active.rotation,
            position=Position(self.active.position.x, self.active.position.y + 1),
        )
        return self._ok_at(cand)

    def tick(self) -> bool:
        if self.paused: return False
        now = __import__("time").monotonic_ns() / 1e6
        dt = now - self.last_tick_ms if self.last_tick_ms else 0
        self.last_tick_ms = now

        # --- Gravity: time-accumulated descent, level-scaled. Independent of the
        # caller's dt granularity so speed stays correct regardless of tick rate.
        if self.active and not self.locked:
            self.gravityAccum += dt
            interval = self.gravity_interval()
            while (self.gravityAccum >= interval and
                   self._move_to(self.active, self.active.position.x,
                                 self.active.position.y + 1)):
                self.gravityAccum -= interval

            # Settled on the bottom: begin the lock delay. Guarded by not locked so a
            # stuck-at-bottom piece re-arms only once (the old code reset it to full
            # on every blocked tick, so lockRem oscillated 500->450 and never elapsed).
            if not self.can_step_down() and not self.locked:
                self.lock_rem = LOCK_DELAY_MS
                self.locked = True

        if self.locked and self.lock_rem > 0:
            self.lock_rem -= dt
            if self.lock_rem <= 0:
                # Lock current piece
                if self.active:
                    shape = _SHAPES[self.active.piece][self.active.rotation]
                    for dy, dx in shape:
                        y, x = self.active.position.y + dy, self.active.position.x + dx
                        if 0 <= y < ARENA_H and 0 <= x < ARENA_W:
                            self.grid[y][x] = self.active.piece
                cleared = self._clear_lines()
                if cleared > 0:
                    bonus = {1: 100, 2: 300, 3: 500, 4: 800}.get(cleared, 0)
                    self.stats.lines_cleared += cleared
                    self.stats.score += bonus * self.stats.level
                    self.stats.level = self.stats.lines_cleared // 10 + 1
                self.spawn_next()
                return True
        return False

    def _clear_lines(self) -> int:
        cleared = 0
        y = ARENA_H - 1
        while y >= 0:
            if all(c != 0 for c in self.grid[y]):
                cleared += 1
                for r in range(y, 0, -1):
                    self.grid[r] = list(self.grid[r - 1])
                self.grid[0] = [0] * ARENA_W
            else:
                y -= 1
        return cleared

    def get_state(self) -> GameState:
        grid_copy = [list(row) for row in self.grid]
        ap = None
        if self.active:
            ap = ActivePiece(self.active.piece, self.active.rotation, self.active.position)
        return GameState(
            grid=grid_copy, current_piece=ap, ghost_y=self.ghost_y,
            next_queue=list(self.next_buffer), held=HoldState(self.held.piece, self.held.used),
            stats=Stats(self.stats.score, self.stats.level, self.stats.lines_cleared),
            tick_count=self.tick_count, lock_delay_remaining=self.lock_rem,
            game_over=self.game_over,
        )

    def export_state(self) -> str:
        return json.dumps(asdict(self.get_state()))

    def import_state(self, data: str) -> bool:
        try:
            raw = json.loads(data)
        except json.JSONDecodeError as e:
            raise ValueError(f"invalid JSON: {e}") from None

        # Restore grid
        for y in range(min(len(raw.get("grid", [])), ARENA_H)):
            for x in range(min(len(raw["grid"][y]), ARENA_W)):
                self.grid[y][x] = raw["grid"][y][x]

        # Restore active piece
        if "current_piece" in raw and raw["current_piece"]:
            cp = raw["current_piece"]
            self.active = ActivePiece(
                piece=cp["piece"], rotation=cp["rotation"],
                position=Position(cp["position"]["x"], cp["position"]["y"]),
            )
            if not self._ok_at(self.active):
                return False
        else:
            self.spawn_next()

        self.ghost_y = raw.get("ghost_y", -1)
        h = raw.get("held", {})
        self.held = HoldState(h.get("piece"), h.get("used", False))
        s = raw.get("stats", {})
        self.stats = Stats(s.get("score", 0), s.get("level", 0), s.get("lines_cleared", 0))
        self.tick_count = raw.get("tick_count", 0)
        self.lock_rem = raw.get("lock_delay_remaining", -1.0)
        self.paused = False
        return True

    def pause(self) -> None: self.paused = True
    def resume(self) -> None: self.paused = False
    def is_paused(self) -> bool: return self.paused

    def new_game(self) -> None:
        """Start a fresh round from the top: unfreeze any lost state, then reset.

        Required because each engine is a single shared instance for all clients;
        without this a game-over permanently freezes gameOver=True + active=None,
        so every subsequent NEW_GAME would land on an instant loss screen.
        """
        self.game_over = False
        # A new game must start playable. Clear any stale pause left behind by a
        # prior EXPORT_STATE (the frontend's engine-switcher pauses the shared
        # engine on exit) — otherwise gravity stays frozen forever: new_game()
        # was previously only resetting game_over, so active.y stayed at 0 and
        # pieces never descended by gravity until the process restarted.
        self.paused = False
        self.reset()
        if self._frozen():
            # Board was somehow unspawnable at start; keep frozen (genuine game over).
            self.game_over = True
