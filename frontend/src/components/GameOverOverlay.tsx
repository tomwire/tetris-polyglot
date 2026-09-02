import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Scoreboard } from './Scoreboard';
import type { ScoreEntry } from './Scoreboard';

export interface OverlaysProps {
  score: number;
  lines: number;
  level: number;
  board: ScoreEntry[];          // current top 5
  qualified: boolean;          // does this score make the board?
  submitted: boolean;          // name already saved this round
  onSubmit: (name: string) => void;
}

// A set of upbeat phrases. One is picked at random each game-over.
const PHRASES = [
  'Great Job!',
  'Amazing!',
  'Unstoppable!',
  'You Rocked It!',
  'Incredible Run!',
  'Legendarily Played!',
  'Nicely Done!',
  'Brick by Brick — Perfect!',
  'Epic Performance!',
  'A Masterclass in Tetris!',
];

// Curtain geometry: enough bricks to cover a 10-col × 20-row board at CELL=32.
const CURTAIN_COLS = 10;
const CURTAIN_ROWS = 20;

/**
 * Brick-curtain game-over scene.
 * A field of falling bricks settles over the board, then reveals a positive
 * phrase, the run's stats, and — only when the score qualified for the board —
 * an input to save it. After saving, it reverts to "press any key/gamepad"
 * start commands like the splash screen.
 */
export const GameOverOverlay: React.FC<OverlaysProps> = ({
  score, lines, level, board, qualified, submitted, onSubmit,
}) => {
  const [phrase] = useState(() => PHRASES[Math.floor(Math.random() * PHRASES.length)]);
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus the name field so a single keystroke types into it.
  useLayoutEffect(() => {
    if (!submitted && qualified) inputRef.current?.focus();
  }, [submitted, qualified]);

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onSubmit(name.trim());
    }
  };

  return (
    <div style={{ minHeight: '100vh', background: '#0f172a', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', position: 'relative', overflow: 'hidden' }}>
      {/* ── CSS for the falling brick curtain (self-contained) ─────────── */}
      <style>{`
        @keyframes curtainFall {
          0%   { transform: translateY(-110%); }
          100% { transform: translateY(0); }
        }
        .tetris-curtain-brick {
          display: inline-block;
          width: 30px; height: 30px;
          margin: 2px;
          borderRadius: 4px;
          background: linear-gradient(180deg, #475569 0%, #334155 100%);
          box-shadow: inset 1px 1px 0 rgba(255,255,255,0.12), inset -1px -1px 0 rgba(0,0,0,0.4);
          will-change: transform;
          animation: curtainFall 0.9s cubic-bezier(0.22, 1, 0.36, 1) both;
        }
      `}</style>

      {/* ── Curtain of bricks falling down over the whole board ────────── */}
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start', pointerEvents: 'none' }}>
        {Array.from({ length: CURTAIN_ROWS }).map((_, row) => (
          <div key={row} style={{ display: 'flex' }}>
            {Array.from({ length: CURTAIN_COLS }).map((__, col) => (
              <span
                key={col}
                className="tetris-curtain-brick"
                // Stagger per row so the curtain cascades top→bottom.
                style={{ animationDelay: `${row * 55}ms` }}
              />
            ))}
          </div>
        ))}
      </div>

      {/* ── Content layered over the settled curtain ───────────────────── */}
      <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20, padding: 32 }}>
        <h1 style={{ color: '#00ff88', fontSize: 44, margin: 0, textShadow: '0 0 24px #00ff8860' }}>GAME OVER</h1>

        {/* Positive phrase inside the curtain */}
        <div style={{
          fontSize: 34, fontWeight: 800, color: '#f8fafc',
          textShadow: '0 2px 12px rgba(0,0,0,0.6)',
          animation: 'curtainFall 0.9s cubic-bezier(0.22,1,0.36,1) both',
          animationDelay: `${CURTAIN_ROWS * 55 + 200}ms`,
        }}>
          {phrase}
        </div>

        {/* Run stats */}
        <div style={{ display: 'flex', gap: 28 }}>
          <Stat label="Lines" value={lines} />
          <Stat label="Level" value={level} />
          <Stat label="Score" value={score} primary />
        </div>

        {/* ── Scoreboard snapshot (top 5) ─────────────────────────────── */}
        <div style={{ width: 340 }}>
          <Scoreboard entries={board} />
        </div>

        {/* ── Name prompt (only when a slot was earned) ───────────────── */}
        {qualified && !submitted ? (
          <div style={{ animation: `curtainFall 0.9s cubic-bezier(0.22,1,0.36,1) both`, animationDelay: `${CURTAIN_ROWS * 55 + 400}ms` }}>
            <div style={{ color: '#94a3b8', fontSize: 13, marginBottom: 8, textAlign: 'center' }}>You made the Top 5! Enter your name:</div>
            <input
              ref={inputRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={onKey}
              maxLength={12}
              placeholder="Your name"
              style={{
                fontSize: 16, padding: '10px 14px', borderRadius: 8, width: 260,
                background: '#0b1220', border: '2px solid #00ff88', color: '#e2e8f0',
                outline: 'none', textAlign: 'center',
              }}
            />
            <div style={{ color: '#64748b', fontSize: 12, marginTop: 8, textAlign: 'center' }}>Press Enter to save</div>
          </div>
        ) : null}

        {/* ── Saved confirmation ──────────────────────────────────────── */}
        {submitted ? (
          <div style={{ color: '#00ff88', fontSize: 18, fontWeight: 700, animation: 'curtainFall 0.9s cubic-bezier(0.22,1,0.36,1) both', animationDelay: '0.7s' }}>
            ✔ Saved to the scoreboard!
          </div>
        ) : null}

        {/* ── Start-new-game commands (after save, or when not qualified) ─ */}
        <div style={{
          background: '#0f172a', padding: 16, borderRadius: 12, marginTop: 4,
          color: '#e2e8f0', fontSize: 16, textAlign: 'center', lineHeight: 1.6,
          animation: `curtainFall 0.9s cubic-bezier(0.22,1,0.36,1) both`,
          animationDelay: submitted ? '0.9s' : (qualified ? '1.1s' : '0.4s'),
        }}>
          {submitted || !qualified ? (
            <>
              Press any key or gamepad button to play again<br />
              <span style={{ color: '#94a3b8', fontSize: 14 }}>← → move · A D rotate · ↑↓ fall · Space hard drop</span>
            </>
          ) : (
            <>
              <span style={{ color: '#fca5a5' }}>Not in the Top 5 this time.</span><br />
              Press any key or gamepad button to play again
            </>
          )}
        </div>
      </div>
    </div>
  );
};

function Stat({ label, value, primary }: { label: string; value: number; primary?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <div style={{ color: '#94a3b8', fontSize: 12, textTransform: 'uppercase' }}>{label}</div>
      <div style={{ color: primary ? '#00ff88' : '#e2e8f0', fontSize: 26, fontWeight: 700 }}>{value.toLocaleString()}</div>
    </div>
  );
}
