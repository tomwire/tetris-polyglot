import { useState, useEffect, useRef, useCallback } from 'react';
import type { EngineConfig, GameState, RuntimeMetrics, ServerMessage, ClientMessage, InputAction } from '../lib/types';

interface UseWebSocketResult {
  gameState: GameState | null;
  metricsHistory: RuntimeMetrics[];
  connected: boolean;
  tickCount: number;
  sendInput: (action: InputAction) => void;
}

export function useWebSocket(engine: EngineConfig | null, enabled: boolean = true): UseWebSocketResult {
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [metricsHistory, setMetricsHistory] = useState<RuntimeMetrics[]>([]);
  const [connected, setConnected] = useState(false);
  const [tickCount, setTickCount] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const metricsBufRef = useRef<RuntimeMetrics[]>([]);
  const gameStateRef = useRef<GameState | null>(null);
  useEffect(() => { gameStateRef.current = gameState; }, [gameState]);

  // ──────────────────────────────────────────────
  // Connect / disconnect
  // ──────────────────────────────────────────────
  useEffect(() => {
    if (!engine || !enabled) return;

    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (ws?.readyState === WebSocket.OPEN) return;
      
      try {
        ws = new WebSocket(engine.wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          setConnected(true);
          metricsBufRef.current = [];
          setMetricsHistory([]);
        };

        ws.onmessage = (ev) => {
          try {
            const msg: ServerMessage = JSON.parse(ev.data);
            handleServerMessage(msg);
          } catch (e) {
            console.error('[ws] parse error:', e);
          }
        };

        ws.onclose = () => {
          setConnected(false);
          reconnectTimer = setTimeout(connect, 1000);
        };

        ws.onerror = (e) => {
          console.error('[ws] error:', e);
        };
      } catch (e) {
        console.error('[ws] connect failed:', e);
        reconnectTimer = setTimeout(connect, 2000);
      }
    };

    const disconnect = () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) {
        ws.onclose = null;
        ws.close();
        ws = null;
      }
      wsRef.current = null;
    };

    connect();
    return () => disconnect();
  }, [engine?.id, enabled]); // Reconnect when engine changes or enabled flips

  // ──────────────────────────────────────────────
  // Message handling
  // ──────────────────────────────────────────────
  const handleServerMessage = useCallback((msg: ServerMessage) => {
    switch (msg.type) {
      case 'STATE_UPDATE': {
        const data = msg.data as any;
        
        if (typeof data === 'object' && data.state_export && !data.grid) {
          return;
        }

        setGameState(data);
        setTickCount((prev: number) => prev + 1);
        break;
      }

      case 'ENGINE_METRICS': {
        const m = msg.data as RuntimeMetrics;
        const entry = { ...m, t: Date.now() };
        metricsBufRef.current.push(entry);
        
        if (metricsBufRef.current.length > 120) {
          metricsBufRef.current = metricsBufRef.current.slice(-120);
        }
        
        setMetricsHistory([...metricsBufRef.current]);
        break;
      }

      case 'ERROR':
        console.error('[ws] server error:', (msg as any).message);
        break;
    }
  }, []);

  // ──────────────────────────────────────────────
  // Input handling — dispatch to engine
  // ──────────────────────────────────────────────
  const sendInput = useCallback((actionOrMsg: InputAction | { type: 'INPUT'; payload: { action: InputAction } }) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    
    let msg: ClientMessage;
    if (typeof actionOrMsg === 'string') {
      msg = { type: 'INPUT', payload: { action: actionOrMsg } };
    } else {
      msg = actionOrMsg;
    }
    wsRef.current.send(JSON.stringify(msg));
  }, []);

  return {
    gameState,
    metricsHistory,
    connected,
    tickCount,
    sendInput,
  };
}
