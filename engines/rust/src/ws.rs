// Rust WebSocket handler — dispatches protocol messages to the shared game
// engine and broadcasts STATE_UPDATE / ENGINE_METRICS / SCOREBOARD to every
// connected client. Mirrors node/src/ws.ts + node/main.ts tick/metrics loops.

use axum::{
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    extract::State,
    http::StatusCode,
    response::Response,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::mpsc;
use futures_util::{SinkExt, StreamExt};
use std::sync::atomic::Ordering;
use tracing::info;

use super::scores;
use crate::AppState;

/// Broadcast a message to every registered client (drop dead senders).
fn broadcast(state: &AppState, msg: Value) {
    let mut clients = state.clients.lock().unwrap();
    // UnboundedSender exposes no try_send; send() only errors on a dropped
    // receiver (never for backpressure), so .is_ok() is safe here.
    clients.retain(|(_, s)| s.send(msg.clone()).is_ok());
}

// ──────────────────── WS upgrade + per-connection session ────────────────────

pub async fn handle_ws(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> Response {
    ws.max_frame_size(64 * 1024).on_upgrade(move |socket| run_session(socket, state))
}

async fn run_session(socket: WebSocket, state: Arc<AppState>) {
    let (mut tx, mut rx) = socket.split();

    // Per-client outbound queue → sender task that writes to the socket.
    let (client_tx, mut client_rx) = mpsc::unbounded_channel::<Value>();
    let sender_task = tokio::spawn(async move {
        while let Some(msg) = client_rx.recv().await {
            if tx.send(Message::Text(serde_json::to_string(&msg).unwrap())).await.is_err() {
                break;
            }
        }
    });

    // Register this connection with a unique id; push SCOREBOARD immediately so
    // the board loads before play starts (node's registerClient → sendScoreboardOnInit).
    let id = state.next_client_id.fetch_add(1, Ordering::Relaxed);
    state.clients.lock().unwrap().push((id, client_tx.clone()));
    let board = scores::top_scores(scores::MAX_ENTRIES);
    broadcast(&state, json!({
        "type": "SCOREBOARD",
        "data": { "entries": wire_board(&board), "submitted": false }
    }));

    info!("rust engine: new WS connection (clients={})", state.clients.lock().unwrap().len());

    tokio::spawn(async move {
        while let Some(Ok(msg)) = rx.next().await {
            if let Message::Text(text) = msg {
                handle_message(&text, &state).await;
            }
        }
        // Unregister: remove this id from the shared registry.
        let mut clients = state.clients.lock().unwrap();
        let dead_id = id;
        clients.retain(|(cid, _)| *cid != dead_id);
        drop(clients);
        info!("rust engine: WS connection closed (clients={})", state.clients.lock().unwrap().len());
        sender_task.abort();
    });
}

// ────────────────────────── message dispatch ────────────────────────────────

async fn handle_message(raw: &str, state: &AppState) {
    let msg: Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(e) => {
            broadcast(&state, json!({ "type": "ERROR", "message": format!("invalid JSON: {}", e) }));
            return;
        }
    };
    let msg_type = msg.get("type").and_then(|v| v.as_str()).unwrap_or("").to_uppercase();

    // Dispatch. INPUT/SUBMIT_SCORE return the value to send back to the submitter;
    // other types self-contained (return early) and never reach the broadcast line.
    match msg_type.as_str() {
        "INPUT" => {
            let st = handle_input(raw, state);
            // Pass an ERROR through verbatim; otherwise broadcast STATE_UPDATE.
            broadcast(&state, if st.get("type").and_then(|v| v.as_str()) == Some("ERROR") {
                st
            } else {
                json!({ "type": "STATE_UPDATE", "data": st })
            });
        }
        "SUBMIT_SCORE" => {
            let msg: Value = serde_json::from_str(raw).unwrap_or_default();
            let name = msg.get("payload").and_then(|p| p.get("name")).and_then(|n| n.as_str()).map(|s| s.to_string());
            let score = msg.get("payload").and_then(|p| p.get("score")).and_then(|s| s.as_i64()).unwrap_or(-1);

            let res = scores::submit_score(name, score);

            // Node's two-send pattern: broadcast the updated board to ALL clients,
            // then send back an authoritative confirm (submitted flag) to the submitter.
            broadcast(&state, json!({
                "type": "SCOREBOARD",
                "data": { "entries": wire_board(&res.entries), "submitted": false }
            }));
            let board = scores::top_scores(scores::MAX_ENTRIES);
            broadcast(&state, json!({
                "type": "SCOREBOARD",
                "data": { "entries": wire_board(&board), "submitted": res.submitted }
            }));
        }
        "REQUEST_SCOREBOARD" => {
            broadcast(&state, json!({
                "type": "SCOREBOARD",
                "data": { "entries": wire_board(&scores::top_scores(scores::MAX_ENTRIES)), "submitted": false }
            }));
            return;
        }
        "NEW_GAME" => {
            let mut g = state.game.lock().unwrap();
            g.new_game(); // clears game_over + resets board, spawns fresh piece
            broadcast(&state, json!({ "type": "STATE_UPDATE", "data": g.get_state() }));
            return;
        }
        "EXPORT_STATE" => {
            let mut g = state.game.lock().unwrap();
            let state_str = g.export_state();
            g.pause();
            broadcast(&state, json!({
                "type": "STATE_UPDATE",
                "data": { "state_export": state_str, "paused": true }
            }));
            return;
        }
        "IMPORT_STATE" => {
            let st_json = raw; // whole message string, parsed below
            handle_import(st_json, state);
            return;
        }
        _ => {
            broadcast(&state, json!({ "type": "ERROR", "message": format!("unknown type: {}", msg_type) }));
            return;
        }
    }
}

fn handle_input(raw: &str, state: &AppState) -> Value {
    let msg: Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(e) => return json!({ "type": "ERROR", "message": format!("invalid JSON: {}", e) }),
    };
    let action = msg.get("payload").and_then(|p| p.get("action"))
        .and_then(|a| a.as_str()).unwrap_or("").to_uppercase();

    let st = {
        let mut g = state.game.lock().unwrap();
        match action.as_str() {
            "MOVE_LEFT" => { if !g.move_left() {} }
            "MOVE_RIGHT" => { if !g.move_right() {} }
            "ROTATE_CW" => { if !g.rotate_cw() {} }
            "ROTATE_CCW" => { if !g.rotate_ccw() {} }
            "SOFT_DROP" => { let _ = g.soft_drop(); }
            "HARD_DROP" => { let _ = g.hard_drop(); }
            "HOLD" => { let _ = g.hold(); }
            _ => {
                return json!({ "type": "ERROR", "message": format!("unknown action: {}", action) });
            }
        }
        g.get_state()
    };
    json!({ "type": "STATE_UPDATE", "data": st })
}


fn handle_import(raw: &str, state: &AppState) -> Value {
    let msg: Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => return json!({ "type": "ERROR", "message": "invalid JSON" }),
    };
    let st_json = msg.get("payload").and_then(|p| p.get("state"))
        .and_then(|v| v.as_str()).unwrap_or_default();

    if st_json.is_empty() {
        return json!({ "type": "ERROR", "message": "IMPORT_STATE requires a 'state' field" });
    }

    let st = {
        let mut g = state.game.lock().unwrap();
        match g.import_state(st_json) {
            Ok(()) => {
                g.resume();
                g.get_state()
            }
            Err(e) => return json!({ "type": "ERROR", "message": format!("import failed: {}", e) }),
        }
    };
    json!({ "type": "STATE_UPDATE", "data": st })
}

/// Map persisted ScoreEntry → wire payload (name + score only), matching node's
/// scorePayload() and the frontend's { name, score } expectation.
fn wire_board(entries: &[scores::ScoreEntry]) -> Vec<Value> {
    entries.iter().map(|e| json!({ "name": e.name, "score": e.score })).collect()
}

// ────────────────────────── HTTP /metrics render ─────────────────────────────

/// Prometheus-text metrics for the node parity /metrics endpoint (HTTP).
pub async fn render_metrics(state: &AppState) -> Response {
    let g = state.game.lock().unwrap();
    let st = g.get_state();
    let active = state.clients.lock().unwrap().len() as u64;
    // read_rss_mb returns MB; *1024 -> KB (reported honestly under its unit).
    let rss_kb = (read_rss_mb() * 1024.0) as u64;
    let lines_cleared = st.stats.lines_cleared;
    drop(g);

    Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "text/plain; version=0.0.4; charset=utf-8")
        .body(axum::body::Body::from(format!(
            "# HELP tetris_active_sessions Number of active sessions\n\
             # TYPE tetris_active_sessions gauge\n\
             tetris_active_sessions{{engine=\"rust-engine\"}} {active}\n\n\
             # HELP tetris_lines_cleared_total Total lines cleared\n\
             # TYPE tetris_lines_cleared_total counter\n\
             tetris_lines_cleared_total{{engine=\"rust-engine\"}} {lines_cleared}\n\n\
             # HELP process_rss_kb RSS memory in kilobytes\n\
             # TYPE process_rss_kb gauge\n\
             process_rss_kb{{engine=\"rust-engine\"}} {rss_kb}\n"
        )))
        .expect("valid metrics response")
}

/// Read VmRSS (kB) from /proc/self/status → MB. Local copy so render_metrics is
// self-contained (the /proc reader lives in main.rs but that fn is module-private).
fn read_rss_mb() -> f64 {
    let raw = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    // `raw` is bound (not moved into the closure param) so its borrow lives for
    // the whole chain instead of dangling at closure-exit.
    raw.lines()
        .find_map(|l| l.strip_prefix("VmRSS:"))
        .and_then(|rest| rest.split_whitespace().next())
        .and_then(|num| num.parse::<f64>().ok())
        .map(|kb| (kb / 1024.0).round() / 10.0)
        .unwrap_or(0.0)
}
