import React from 'react';

interface Sample {
  cpu: number;
  memory: number;
}

interface Props {
  engineName: string;
  history: Sample[];
}

const H = 56;          // sparkline height
const W = 180;         // sparkline width
const N = 40;          // samples shown in the sparkline

// Inline-styled telemetry HUD. Dependency-free (no recharts) so it builds in
// the same production Vite bundle as the rest of the app on the homelab.
export const MetricsHUD: React.FC<Props> = ({ engineName, history }) => {
  const latest = history.length ? history[history.length - 1] : null;

  // Build a compact sparkline path for CPU% (0-100) + RSS MB (auto-scaled).
  const cpuPts = history.slice(-N);
  let memPath = '';
  let cpuPath = '';
  if (cpuPts.length > 1) {
    const maxCpu = 100;
    const maxMem = Math.max(64, ...cpuPts.map(s => s.memory));
    const stepX = W / (N - 1);
    const x = (i: number) => Math.min(W - 1, Math.max(0, i * stepX));
    cpuPath = cpuPts
      .map((s, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${(H - (s.cpu / maxCpu) * (H - 4)).toFixed(1)}`)
      .join(' ');
    memPath = cpuPts
      .map((s, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${(H - (s.memory / maxMem) * (H - 4)).toFixed(1)}`)
      .join(' ');
  }

  return (
    <div style={{ background: '#1e293b', padding: 14, borderRadius: 12, border: '1px solid #334155' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <h3 style={{ color: '#00ff88', fontSize: 12, margin: 0, fontWeight: 700, letterSpacing: 1 }}>
          {engineName.toUpperCase()} METRICS
        </h3>
        {!latest && <span style={{ fontSize: 10, color: '#64748b' }}>waiting…</span>}
      </div>

      <div style={{ display: 'flex', gap: 16, marginBottom: 8 }}>
        <Metric label="CPU" value={latest ? `${latest.cpu.toFixed(0)}%` : 'N/A'} color="#22d3ee" />
        <Metric label="RSS" value={latest ? `${Math.round(latest.memory)} MB` : 'N/A'} color="#4ade80" />
      </div>

      {/* Inline SVG sparkline: CPU (cyan) + RSS (green). No chart dependency. */}
      {history.length > 1 && (
        <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ display: 'block', height: H }}>
          <polyline
            points={memPath} fill="none" stroke="#4ade80" strokeWidth={1.5}
            strokeLinejoin="round" strokeLinecap="round" opacity={0.9}
          />
          <polyline
            points={cpuPath} fill="none" stroke="#22d3ee" strokeWidth={1.5}
            strokeLinejoin="round" strokeLinecap="round" opacity={0.9}
          />
        </svg>
      )}

      <div style={{ display: 'flex', gap: 14, marginTop: 6, fontSize: 10, color: '#64748b' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span style={{ width: 8, height: 3, borderRadius: 2, background: '#22d3ee' }} /> CPU%
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span style={{ width: 8, height: 3, borderRadius: 2, background: '#4ade80' }} /> RSS MB
        </span>
      </div>
    </div>
  );
};

function Metric({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontSize: 10, color: '#94a3b8', textTransform: 'uppercase' }}>{label}</span>
      <span style={{ fontSize: 18, fontWeight: 700, color, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
        {value}
      </span>
    </div>
  );
}
