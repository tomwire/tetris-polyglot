// Node.js Tetris Engine — HTTP + WebSocket on a single port.
// Serves /health, /metrics (HTTP) and /ws (WebSocket upgrade) all on HTTP_PORT.

import { createServer } from 'node:http';
import os from 'node:os';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer as WSServer, WebSocket } from 'ws';
import { Game } from './game.js';
import { handleWsMessage, registerClient, unregisterClient, activeClients } from './ws.js';

const port = parseInt(process.env.HTTP_PORT || '8000', 10);
const engineName = process.env.ENGINE_NAME || 'node-engine';

// ────────────────────── Game + clients ──────────────────────
const game = new Game();

// ────────────────────── Tick loop (20 Hz) ───────────────────
let lastTickTime = Date.now();
const TICK_MS = 50;

setInterval(() => {
  const dt = Date.now() - lastTickTime;
  lastTickTime = Date.now();
  game.tick(dt);

  const msg = JSON.stringify({ type: 'STATE_UPDATE', data: game.getState() });
  for (const client of activeClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}, TICK_MS);

// ──────────────────── Metrics broadcast (~1s) ─────────────────
// Runtime metrics the frontend renders as SYSTEM METRICS. Sends real host
// numbers (CPU% from load-avg across cores, RSS memory). The protocol contract
// requires an ENGINE_METRICS broadcast every ~N ticks; this satisfies it.
const METRICS_INTERVAL_MS = 1000;
let lastMetricsTime = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.max(1, now - lastMetricsTime);
  lastMetricsTime = now;

  const cpuCount = os.cpus().length || 1;
  // Load average (1min) / cores * 100 = whole-host utilization %.
  let cpuPercent = (os.loadavg()[0] / cpuCount) * 100;
  if (cpuPercent < 0) cpuPercent = 0;
  if (cpuPercent > 100) cpuPercent = 100;
  const rssMB = process.memoryUsage().rss / 1024 / 1024;

  const msg = JSON.stringify({
    type: 'ENGINE_METRICS',
    payload: {
      cpuUsagePercent: Number(cpuPercent.toFixed(1)),
      rssMemoryMB: Number(rssMB.toFixed(1)),
      tickDurationMs: dt,
      timestamp: now,
    },
  });
  for (const client of activeClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}, METRICS_INTERVAL_MS);

// ────────────────────── HTTP server ─────────────────────────
function handleHttpRequest(req: IncomingMessage, res: import('node:http').ServerResponse) {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    return;
  }

  if (url.pathname === '/metrics') {
    const state = game.getState();
    const rssMB = process.memoryUsage().rss / 1024 / 1024;
    const cpu = process.cpuUsage().user / 1e6;

    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
    res.end(
      `# HELP tetris_active_sessions Number of active sessions
# TYPE tetris_active_sessions gauge
tetris_active_sessions{engine="${engineName}"} ${activeClients.size}

# HELP tetris_lines_cleared_total Total lines cleared
# TYPE tetris_lines_cleared_total counter
tetris_lines_cleared_total{engine="${engineName}"} ${state.stats.linesCleared}

# HELP process_rss_bytes RSS memory in bytes
# TYPE process_rss_bytes gauge
process_rss_bytes{engine="${engineName}"} ${Math.round(rssMB * 1024 * 1024)}

# HELP process_cpu_seconds_total Total CPU seconds
# TYPE process_cpu_seconds_total counter
process_cpu_seconds_total{engine="${engineName}"} ${cpu}
`
    );
    return;
  }

  // Unknown HTTP path → 404 (not a WS upgrade, no special handling)
  if (!req.headers.upgrade) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }
}

// ────────────────────── WebSocket server (upgrade only) ─────
const wssServer = new WSServer({ noServer: true });

function onConnection(socket: WebSocket) {
  console.log(`[${engineName}] New WS connection`);
  registerClient(socket);
  socket.on('close', () => unregisterClient(socket));
  socket.on('message', (data: Buffer | string) => {
    const raw = data.toString();
    handleWsMessage(socket, raw, { game }).catch(err => {
      console.error(`[${engineName}] ws message error:`, err);
    });
  });
}

wssServer.on('connection', onConnection);

const httpServer = createServer((req, res) => handleHttpRequest(req, res));

httpServer.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  if (url.pathname === '/ws' && req.headers.upgrade?.toLowerCase() === 'websocket') {
    wssServer.handleUpgrade(req, socket, head, ws => onConnection(ws));
  } else {
    // Drop non-WS upgrades
    socket.destroy();
  }
});

httpServer.listen(port, () => {
  console.log(`[${engineName}] Listening on http://0.0.0.0:${port} (HTTP + WS)`);
});
