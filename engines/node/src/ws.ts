// Node.js Tetris Engine — WebSocket handler with unified protocol dispatch.
// Handles INPUT, EXPORT_STATE, IMPORT_STATE, REQUEST_SCOREBOARD, SUBMIT_SCORE
// and broadcasts STATE_UPDATE + ENGINE_METRICS + SCOREBOARD.

import { WebSocket } from 'ws';
import { Game } from './game.js';
import { topScores, submitScore, ScoreEntry } from './scores.js';

export interface WsContext {
  game: Game;
}

// Registry of connected clients. Lives here (not in main.ts) so the scoreboard
// broadcast can reach every client on SUBMIT_SCORE without threading the set
// through every handler. main.ts uses registerClient/unregisterClient and
// iterates the exported set for STATE_UPDATE/METRICS broadcasts.
export const activeClients = new Set<WebSocket>();

// Input queue — prevents rapid actions from overlapping (e.g., hard drop + rotate)
let inputQueue: any[] = [];
let processingInput = false;

function processNextInput(ctx: WsContext, ws: WebSocket) {
  if (processingInput || inputQueue.length === 0) return;
  processingInput = true;
  const pending = inputQueue.shift();
  handleAction(pending, ctx, ws)
    .finally(() => {
      processingInput = false;
      processNextInput(ctx, ws);
    });
}

async function handleAction(msg: any, ctx: WsContext, ws: WebSocket) {
  const action = (msg.payload?.action || '').toUpperCase();
  switch (action) {
    case 'MOVE_LEFT':   ctx.game.moveLeft(); break;
    case 'MOVE_RIGHT':  ctx.game.moveRight(); break;
    case 'ROTATE_CW':   ctx.game.rotateCW(); break;
    case 'ROTATE_CCW':  ctx.game.rotateCCW(); break;
    case 'SOFT_DROP':   ctx.game.softDrop(); break;
    case 'HARD_DROP':   ctx.game.hardDrop(); break;
    case 'HOLD':        ctx.game.hold(); break;
    case 'GRAVITY':     // Server-side gravity handles this; ignore client GRAVITY
      return;
    default:
      sendError(ws, `unknown action: ${action}`);
      return;
  }

  // Broadcast updated state after the action completes
  const st = ctx.game.getState();
  ws.send(JSON.stringify({ type: 'STATE_UPDATE', data: st }));
}

/** Handles an incoming WebSocket message from the client. */
export async function handleWsMessage(
  ws: WebSocket,
  raw: string,
  ctx: WsContext
): Promise<void> {
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch (e) {
    sendError(ws, `invalid JSON: ${(e as Error).message}`);
    return;
  }

  const type = (msg.type || '').toUpperCase();
  switch (type) {
    case 'INPUT':
      // Queue inputs so rapid presses don't overlap state changes
      inputQueue.push(msg);
      processNextInput(ctx, ws);
      break;
    case 'EXPORT_STATE':
      await handleExport(ws, ctx);
      break;
    case 'IMPORT_STATE':
      await handleImport(raw, ws, ctx);
      break;
    case 'REQUEST_SCOREBOARD':
      sendScoreboard(ws, topScores());
      break;
    case 'SUBMIT_SCORE': {
      const { submitted, entries } = submitScore(msg.payload?.name, msg.payload?.score);
      // Broadcast the updated board to every connected client so a shared
      // scoreboard stays consistent across multiple open tabs/players.
      broadcastScoreboard(entries);
      sendScoreboard(ws, entries, submitted);
      break;
    }
    case 'NEW_GAME':
      // Start a fresh round. The engine is a single shared Game instance for all
      // clients; without this a loss froze gameOver=true + active=null permanently,
      // making every subsequent connection see an instant game-over screen.
      ctx.game.newGame();
      broadcastFreshState(JSON.stringify({ type: 'STATE_UPDATE', data: ctx.game.getState() }));
      break;
    default:
      sendError(ws, `unknown message type: ${type}`);
  }
}

/** Handle EXPORT_STATE — serialize and pause. */
async function handleExport(ws: WebSocket, ctx: WsContext): Promise<void> {
  const stateStr = ctx.game.exportState();
  ctx.game.pause();

  ws.send(JSON.stringify({
    type: 'STATE_UPDATE',
    data: { state_export: stateStr, paused: true },
  }));
}

/** Handle IMPORT_STATE — deserialize and resume. */
async function handleImport(raw: string, ws: WebSocket, ctx: WsContext): Promise<void> {
  let msg: any;
  try {
    msg = JSON.parse(raw);
  } catch (e) {
    sendError(ws, `invalid import JSON: ${(e as Error).message}`);
    return;
  }

  const stateStr = msg.payload?.state;
  if (!stateStr || typeof stateStr !== 'string') {
    sendError(ws, "IMPORT_STATE requires payload.state (serialized game state)");
    return;
  }

  if (ctx.game.importState(stateStr)) {
    ctx.game.resume();
    const st = ctx.game.getState();
    ws.send(JSON.stringify({ type: 'STATE_UPDATE', data: st }));
  } else {
    sendError(ws, 'import failed — invalid state payload');
  }
}

// ──────────────────────────────────────────────
// Client lifecycle (used by main.ts)
// ──────────────────────────────────────────────

/** Register a client and push the current board so the panel loads immediately. */
export function registerClient(ws: WebSocket): void {
  activeClients.add(ws);
  sendScoreboardOnInit(ws);
}

/** Remove a client from the registry. */
export function unregisterClient(ws: WebSocket): void {
  activeClients.delete(ws);
}

// ──────────────────────────────────────────────
// Scoreboard helpers
// ──────────────────────────────────────────────

function scorePayload(entries: ScoreEntry[]) {
  return entries.map((e) => ({ name: e.name, score: e.score }));
}

function sendScoreboard(ws: WebSocket, entries: ScoreEntry[], submitted = false) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'SCOREBOARD', data: { entries: scorePayload(entries), submitted } }));
}

function broadcastScoreboard(entries: ScoreEntry[]) {
  const msg = JSON.stringify({ type: 'SCOREBOARD', data: { entries: scorePayload(entries), submitted: true } });
  for (const ws of activeClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

/** Push a state payload to every connected client. Used after NEW_GAME so all
 *  players see the freshly-spawned piece/board instead of a frozen loss. */
function broadcastFreshState(payload: string) {
  for (const ws of activeClients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

/** Push the current board as soon as a client connects. */
function sendScoreboardOnInit(ws: WebSocket) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: 'SCOREBOARD', data: { entries: scorePayload(topScores()), submitted: false } }));
}

// ──────────────────────────────────────────────
// Message helpers
// ──────────────────────────────────────────────

function sendError(ws: WebSocket, message: string) {
  ws.send(JSON.stringify({ type: 'ERROR', message }));
}

function sendMetrics(ws: WebSocket, cpu: number, rssMB: number) {
  ws.send(JSON.stringify({
    type: 'ENGINE_METRICS',
    data: {
      cpu_usage_percent: +cpu.toFixed(2),
      rss_memory_mb: +rssMB.toFixed(2),
      timestamp: Date.now(),
    },
  }));
}
