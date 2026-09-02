import React from 'react';

export interface ScoreEntry {
  name: string;
  score: number;
}

interface Props {
  entries: ScoreEntry[];
  /** Show the player's rank / whether a slot is open. */
  showRank?: boolean;
}

const RANK_LABELS = ['1st', '2nd', '3rd', '4th', '5th'];
const RANK_GLOW: Record<number, string> = {
  0: '#ffd54a', // gold
  1: '#c0c6cc', // silver
  2: '#cd7f32', // bronze
};

/** Compact "TOP 5" scoreboard panel. Used on the splash screen and inside the game-over overlay. */
export const Scoreboard: React.FC<Props> = ({ entries, showRank = true }) => {
  return (
    <div style={{ width: '100%' }}>
      <div style={{ color: '#94a3b8', fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>
        Top 5 Scores
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {entries.length === 0 ? (
          <div style={{ color: '#475569', fontSize: 14, fontStyle: 'italic' }}>No scores yet — be the first!</div>
        ) : (
          entries.map((e, i) => (
            <div
              key={`${e.name}-${i}-${e.score}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                background: '#0b1220',
                border: '1px solid #1e293b',
                borderRadius: 8,
                padding: '8px 12px',
              }}
            >
              {showRank && (
                <span
                  style={{
                    width: 30,
                    fontSize: 13,
                    fontWeight: 700,
                    color: RANK_GLOW[i] || '#64748b',
                    fontFamily: 'monospace',
                    textAlign: 'center' as const,
                  }}
                >
                  {RANK_LABELS[i]}
                </span>
              )}
              <span
                style={{
                  flex: 1,
                  fontSize: 15,
                  fontWeight: 600,
                  color: i === 0 ? '#e2e8f0' : '#cbd5e1',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {e.name}
              </span>
              <span
                style={{
                  fontFamily: 'monospace',
                  fontSize: 16,
                  fontWeight: 700,
                  color: '#00ff88',
                }}
              >
                {e.score.toLocaleString()}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
