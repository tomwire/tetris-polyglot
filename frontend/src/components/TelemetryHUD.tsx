import React from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import type { RuntimeMetrics } from '../lib/types';

interface Props {
  metrics: RuntimeMetrics[];
}

export const TelemetryHUD: React.FC<Props> = ({ metrics }) => {
  if (metrics.length === 0) {
    return (
      <div className="bg-gray-900/50 border border-gray-800 rounded-lg p-4 text-sm text-gray-500">
        Waiting for engine telemetry...
      </div>
    );
  }

  const latest = metrics[metrics.length - 1];

  return (
    <div className="bg-gray-900/50 border border-gray-800 rounded-lg p-4 backdrop-blur-sm">
      <h3 className="text-xs font-semibold text-gray-500 mb-3 uppercase tracking-wider">
        Runtime Telemetry
      </h3>

      {/* Summary line */}
      <div className="flex items-baseline gap-4 mb-4 text-xs font-mono">
        <span className="text-cyan-400">CPU: {latest.cpu_usage_percent.toFixed(1)}%</span>
        <span className="text-green-400">RSS: {latest.rss_memory_mb.toFixed(1)} MB</span>
        {latest.tick_duration_ms && (
          <span className="text-yellow-400">Tick: {latest.tick_duration_ms.toFixed(2)} ms</span>
        )}
      </div>

      {/* Combined chart — CPU + RSS on dual axes */}
      <ResponsiveContainer width="100%" height={120}>
        <LineChart data={metrics.slice(-60)}>
          <XAxis dataKey="t" hide />
          <YAxis yAxisId="left" orientation="left" domain={[0, 100]} tickFormatter={(v) => `${v}%`} className="text-[10px]" style={{ fontSize: 10 }} />
          <YAxis yAxisId="right" orientation="right" domain={[0, 'auto']} tickFormatter={(v) => `${v}M`} className="text-[10px]" style={{ fontSize: 10 }} />
          <Tooltip
            contentStyle={{ backgroundColor: '#111827', border: '1px solid #374151', borderRadius: 6, fontSize: 12 }}
            labelStyle={{ display: 'none' }}
          />
          <Line yAxisId="left" type="monotone" dataKey="cpu" stroke="#22d3ee" strokeWidth={1.5} dot={false} isAnimationActive={false} />
          <Line yAxisId="right" type="monotone" dataKey="mem" stroke="#4ade80" strokeWidth={1.5} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>

      {/* Tick latency sparkline */}
      <div className="mt-3">
        <span className="text-[10px] text-gray-600 mb-1 block">Tick Duration</span>
        <ResponsiveContainer width="100%" height={40}>
          <LineChart data={metrics.slice(-30)}>
            <XAxis dataKey="t" hide />
            <YAxis domain={[0, 'auto']} hide />
            <Tooltip contentStyle={{ backgroundColor: '#111827', border: '1px solid #374151', borderRadius: 6 }} labelStyle={{ display: 'none' }} />
            <Line type="stepAfter" dataKey="tick" stroke="#facc15" strokeWidth={1} dot={false} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};
