import React from 'react';

interface EngineOpt {
  id: string;
  name: string;
  language: string;
}

const DOT: Record<string, string> = {
  go: '#2dd4bf',    // teal-400
  rust: '#facc15',  // yellow-500
  node: '#4ade80',  // green-400
  python: '#60a5fa',// blue-400
};

interface Props {
  engines: EngineOpt[];
  activeId: string;
  reachable?: Record<string, boolean>;
  onSwitch: (engine: EngineOpt) => void;
}

// Inline-styled engine selector. Kept dependency-free (no Tailwind) so the
// production Vite build (`npm ci && vite build`) stays green on the homelab.
export const EngineSelector: React.FC<Props> = ({ engines, activeId, reachable, onSwitch }) => {
  const [open, setOpen] = React.useState(false);
  const active = engines.find(e => e.id === activeId) || engines[0];

  return (
    <div style={{ position: 'relative', userSelect: 'none' }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 8,
          padding: '6px 12px', background: '#1e293b',
          border: `1px solid ${activeId === 'go' || activeId === 'rust' ? '#334155' : '#00d9a540'}`,
          borderRadius: 8, color: '#e2e8f0', fontSize: 13, fontWeight: 600,
          cursor: 'pointer', minWidth: 150, justifyContent: 'space-between',
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              width: 9, height: 9, borderRadius: '50%',
              background: DOT[active.id] || '#94a3b8',
              boxShadow: `0 0 8px ${DOT[active.id] || '#94a3b8'}80`,
            }}
          />
          {active.name}
        </span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d={open ? 'M6 15l6-6 6 6' : 'M18 9l-6 6-6-6'} />
        </svg>
      </button>

      {open && (
        <>
          <div
            onClick={() => setOpen(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 40 }}
          />
          <div
            style={{
              position: 'absolute', right: 0, top: 'calc(100% + 8px)', width: 260,
              background: '#0f172a', border: '1px solid #334155', borderRadius: 10,
              boxShadow: '0 12px 32px rgba(0,0,0,0.5)', zIndex: 50, overflow: 'hidden',
            }}
          >
            {engines.map(engine => {
              const isAct = engine.id === activeId;
              const up = reachable ? reachable[engine.id] !== false : true;
              return (
                <button
                  key={engine.id}
                  type="button"
                  disabled={!up}
                  onClick={() => { onSwitch(engine); setOpen(false); }}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left', padding: '12px 14px',
                    background: isAct ? '#1e293b60' : 'transparent',
                    borderBottom: '1px solid #1e293b', cursor: up ? 'pointer' : 'not-allowed',
                    opacity: up ? 1 : 0.5, color: '#e2e8f0',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span
                      style={{
                        width: 9, height: 9, borderRadius: '50%',
                        background: DOT[engine.id] || '#94a3b8',
                      }}
                    />
                    <span style={{ fontWeight: 600, fontSize: 13 }}>{engine.name}</span>
                    {isAct && (
                      <span style={{ marginLeft: 'auto', fontSize: 10, color: '#00ff88', fontWeight: 700 }}>
                        ACTIVE
                      </span>
                    )}
                    {!up && (
                      <span style={{ marginLeft: 'auto', fontSize: 9, color: '#64748b' }}>OFFLINE</span>
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: '#64748b', marginLeft: 18, marginTop: 3 }}>
                    {engine.language}
                  </div>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
};
