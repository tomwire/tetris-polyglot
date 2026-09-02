// Protocol types matching the unified WebSocket contract.
// These types define the JSON schema for state transfer between engines.

export interface Position {
  x: number;
  y: number;
}

export interface ActivePiece {
  type: number;      // 1-7 (I, O, T, S, Z, J, L)
  rotation: number;  // 0-3
  position: Position;
}

export interface HeldState {
  type: number | null;
  used: boolean;
}

export interface Stats {
  score: number;
  level: number;
  linesCleared: number;
}

export interface Timing {
  tickCount: number;
  lastTickTime: number;
  lockDelayRemaining: number;
}

export interface GameState {
  grid: number[][];           // 20×10 array (row-major, top-to-bottom)
  current_piece: ActivePiece;
  ghost_position: Position;   // landing position of active piece
  next_queue: number[];        // upcoming pieces
  hold_piece: HeldState;
  stats: Stats;
  timing: Timing;
}

export interface RuntimeMetrics {
  cpu_usage_percent: number;
  rss_memory_mb: number;
  tick_duration_ms?: number;
  gc_pause_ms?: number;
}

// ──────────────────────────────────────────────
// WebSocket message types
// ──────────────────────────────────────────────

export type InputAction =
  | 'MOVE_LEFT'
  | 'MOVE_RIGHT'
  | 'ROTATE_CW'
  | 'ROTATE_CCW'
  | 'SOFT_DROP'
  | 'HARD_DROP'
  | 'HOLD'
  | 'PAUSE';

export interface InputMessage {
  type: 'INPUT';
  payload: { action: InputAction };
}

export interface ExportStateMessage {
  type: 'EXPORT_STATE';
}

export interface ImportStateMessage {
  type: 'IMPORT_STATE';
  payload: { state: string }; // JSON-encoded GameState
}

export type ClientMessage = InputMessage | ExportStateMessage | ImportStateMessage;

export interface StateUpdateMessage {
  type: 'STATE_UPDATE';
  data: GameState | { state_export: string; paused: boolean };
}

export interface MetricsMessage {
  type: 'ENGINE_METRICS';
  data: RuntimeMetrics;
}

export interface ErrorMessage {
  type: 'ERROR';
  message: string;
}

export type ServerMessage = StateUpdateMessage | MetricsMessage | ErrorMessage;

// ──────────────────────────────────────────────
// Engine configurations
// ──────────────────────────────────────────────

export interface EngineConfig {
  id: string;
  name: string;
  language: string;
  wsUrl: string; // WebSocket URL (e.g., wss://tetris.thomaswire.com/ws/go-engine)
}

export const ENGINES: EngineConfig[] = [
  {
    id: 'go',
    name: 'Go',
    language: 'Gorilla WebSocket + net/http',
    wsUrl: process.env.REACT_APP_GO_WS || 'ws://localhost:9001/ws',
  },
  {
    id: 'rust',
    name: 'Rust',
    language: 'Axum + tokio-tungstenite',
    wsUrl: process.env.REACT_APP_RUST_WS || 'ws://localhost:9002/ws',
  },
  {
    id: 'node',
    name: 'Node.js',
    language: 'Fastify + @fastify/websocket',
    wsUrl: process.env.REACT_APP_NODE_WS || 'ws://localhost:9003/ws',
  },
  {
    id: 'python',
    name: 'Python',
    language: 'FastAPI + websockets',
    wsUrl: process.env.REACT_APP_PYTHON_WS || 'ws://localhost:9004/ws',
  },
];
