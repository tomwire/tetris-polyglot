import { useState, useRef, useCallback } from 'react';
import type { EngineConfig } from '../lib/types';
import { ENGINES } from '../lib/types';

interface UseEngineSwitcherResult {
  activeEngine: EngineConfig | null;
  isSwitching: boolean;
  switchEngine: (engine: EngineConfig) => Promise<void>;
}

export function useEngineSwitcher(): UseEngineSwitcherResult {
  const [activeEngine, setActiveEngine] = useState<EngineConfig>(ENGINES[0]); // Go first by default
  const [isSwitching, setIsSwitching] = useState(false);
  
  // @ts-ignore — kept for future export functionality
  const pendingExportRef = useRef<Promise<string> | null>(null);
  const importOnConnectRef = useRef<string | null>(null);

  /**
   * Orchestrates the engine hot-swap flow:
   * 1. Export current game state from active engine
   * 2. Close WebSocket connection
   * 3. Update activeEngine to target (triggers reconnect)
   * 4. On new connection open, import state
   */
  const switchEngine = useCallback(async (target: EngineConfig) => {
    if (target.id === activeEngine?.id || isSwitching) return;

    setIsSwitching(true);

    try {
      // Step 1: Export state from current engine
      const exportedState = await exportFromCurrentEngine();
      
      // Step 2: Close current WebSocket
      closeCurrentWebSocket();

      // Step 3: Update active engine to target (triggers reconnect in useWebSocket)
      setActiveEngine(target);
      
      // Store the state for import on next connection open
      importOnConnectRef.current = exportedState;

      // Step 4: Wait for new connection, then import
      await waitForConnectionAndImport(target);
    } catch (err) {
      console.error('[switch] engine switch failed:', err);
      // Revert to previous engine on failure
      setActiveEngine(activeEngine);
    } finally {
      setIsSwitching(false);
      importOnConnectRef.current = null;
    }
  }, [activeEngine, isSwitching]);

  /**
   * Exports the current game state from the active WebSocket.
   * Sends EXPORT_STATE message and waits for the serialized response.
   */
  const exportFromCurrentEngine = (): Promise<string> => {
    return new Promise((resolve, reject) => {
      // Get the current WebSocket from the global scope (or a shared ref)
      // In a real implementation, this would be passed via context or prop
      const ws = (window as any).__currentWs;
      
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error('No active WebSocket connection'));
        return;
      }

      const timeout = setTimeout(() => {
        ws.removeEventListener('message', handler);
        reject(new Error('Export timeout (5s)'));
      }, 5000);

      const handler = (ev: MessageEvent) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'STATE_UPDATE' && typeof msg.data === 'object' && msg.data.state_export) {
            clearTimeout(timeout);
            ws.removeEventListener('message', handler);
            resolve(msg.data.state_export);
          }
        } catch {}
      };

      ws.addEventListener('message', handler);
      ws.send(JSON.stringify({ type: 'EXPORT_STATE' }));
    });
  };

  /**
   * Closes the current WebSocket connection.
   */
  const closeCurrentWebSocket = () => {
    const ws = (window as any).__currentWs;
    if (ws) {
      ws.onclose = null; // Prevent auto-reconnect during switch
      ws.close();
    }
  };

  /**
   * Waits for the new WebSocket connection to open, then imports the state.
   */
  const waitForConnectionAndImport = (_engine: EngineConfig): Promise<void> => {
    return new Promise((resolve) => {
      // Poll for connection open (or use event listener if available)
      const check = () => {
        const ws = (window as any).__currentWs;
        
        if (ws && ws.readyState === WebSocket.OPEN) {
          // Connection open — import state
          const stateToImport = importOnConnectRef.current;
          if (stateToImport) {
            try {
              ws.send(JSON.stringify({
                type: 'IMPORT_STATE',
                payload: { state: stateToImport },
              }));
              resolve();
            } catch (err) {
              console.error('[switch] import failed:', err);
              resolve(); // Don't block on import failure
            }
          } else {
            resolve(); // No state to import (fresh start)
          }
        } else if (ws && ws.readyState === WebSocket.CLOSED) {
          // Connection failed — give up
          resolve();
        } else {
          // Still connecting — check again in 100ms
          setTimeout(check, 100);
        }
      };

      check();
    });
  };

  return {
    activeEngine,
    isSwitching,
    switchEngine,
  };
}
