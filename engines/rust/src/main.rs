// Tetris Engine — Rust Entry Point (Axum + WebSocket).
// Implements the unified protocol contract for polyglot state handoff.
//
// Architecture mirrors node/main.ts exactly:
//   * one shared Game + shared client registry behind a Mutex,
//   * a 20 Hz tick loop that advances physics and broadcasts STATE_UPDATE to all
//     connected clients so every board stays in sync (fresh piece lands on the
//     top row, gravity descends, lines clear, game-over freezes),
//   * a ~1 s runtime-metrics loop that broadcasts ENGINE_METRICS (camelCase,
//     payload-encapsulated) with real CPU% (load avg across cores) and RSS.

mod game;
mod scores;
mod ws;

use axum::{
    extract::State,
    routing::get,
    Router,
};
use std::sync::{Arc, Mutex, atomic::AtomicU64};
use tokio::sync::mpsc;
use tokio::time::{interval, Duration, Instant};
use tracing_subscriber::{fmt, EnvFilter};

/// Per-connection outbound channel. Tied to a monotonically increasing id so a
/// disconnect can be matched back to its sender (node's Set<WebSocket> equiv).
type ClientSender = mpsc::UnboundedSender<serde_json::Value>;
struct AppState {
    game: Arc<Mutex<game::Game>>,
    clients: Arc<Mutex<Vec<(u64, ClientSender)>>>,
    next_client_id: AtomicU64,
}

#[tokio::main]
async fn main() {
    fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("info".parse().unwrap()))
        .init();

    tracing::info!("Starting Rust Tetris Engine");

    let game = Arc::new(Mutex::new(game::Game::new()));
    let clients: Arc<Mutex<Vec<(u64, ClientSender)>>> = Arc::new(Mutex::new(Vec::new()));
    let next_client_id = AtomicU64::new(0);
    let state = Arc::new(AppState {
        game: game.clone(),
        clients: clients.clone(),
        next_client_id,
    });

    // ──────────────── Tick loop (20 Hz) — broadcast STATE_UPDATE to all — ─────
    // Drives physics independent of connections so a single-player board still
    // animates, and every client sees the same piece land / game-over freeze.
    {
        let game = game.clone();
        let clients = clients.clone();
        tokio::spawn(async move {
            let mut ticker = interval(Duration::from_millis(50));
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            let mut last = Instant::now();
            loop {
                ticker.tick().await;
                let dt = last.elapsed().as_millis() as i64;
                last = Instant::now();

                // Advance physics under the lock, serialize OUTSIDE it so we do
                // not hold the mutex while doing JSON work.
                let st = {
                    let mut g = game.lock().unwrap();
                    g.tick();
                    g.get_state()
                };

                let msg = serde_json::json!({ "type": "STATE_UPDATE", "data": st });
                for (_, s) in clients.lock().unwrap().iter() {
                    // UnboundedSender has no try_send; send() only errors if the
                    // receiver was dropped, so .ok() is safe.
                    let _ = s.send(msg.clone()).ok();
                }
            }
        });
    }

    // ──────────────── Metrics broadcast (~1 s) — ENGINE_METRICS —───────────────
    // Real numbers from /proc (no external crates). cpu% = load-avg(1m)/cores*100,
    // rss MB from /proc/self/status VmRSS. payload is camelCase per protocol.
    {
        let clients = clients.clone();
        tokio::spawn(async move {
            let mut ticker = interval(Duration::from_millis(1000));
            ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            let mut last = Instant::now();
            loop {
                ticker.tick().await;
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                let dt = last.elapsed().as_secs_f64();
                last = Instant::now();

                let (cpu, rss) = read_host_metrics();
                let msg = serde_json::json!({
                    "type": "ENGINE_METRICS",
                    "payload": {
                        "cpuUsagePercent": cpu,
                        "rssMemoryMB": rss,
                        "timestamp": now,
                    }
                });
                for (_, s) in clients.lock().unwrap().iter() {
                    let _ = s.send(msg.clone()).ok();
                }
            }
        });
    }

    // ────────────────────── HTTP + WS server (single port) ───────────────────
    // Capture a dedicated clone into the /metrics closure so `state` itself is
    // still valid for `.with_state(state)` (move closures consume what they grab).
    let metrics_state = state.clone();
    let app = Router::new()
        .route("/ws", get(ws::handle_ws))
        .route("/health", get(|| async { "OK" }))
        .route("/metrics", get(move || {
            let state = metrics_state;
            async move { ws::render_metrics(&state).await }
        }))
        .with_state(state);

    eprintln!("RUST_MARKER: before bind");
    let addr = std::env::var("HTTP_PORT").unwrap_or_else(|_| "8000".to_string());
    tracing::info!("Listening on http://0.0.0.0:{}", addr);

    let listener = tokio::net::TcpListener::bind(format!("0.0.0.0:{}", addr)).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

/// Read whole-host CPU% (load-avg across cores) and own-process RSS in MB from
/// /proc. Pure std — mirrors node/os.loadavg() + process.memoryUsage().rss.
fn read_host_metrics() -> (f64, f64) {
    // CPU%: 1-minute load average / number of CPUs * 100, clamped to [0,100].
    let ncpu = count_cpus();
    let cpu = fs_loadavg_first().map(|l| {
        let pct = if ncpu > 0 { (l / ncpu as f64) * 100.0 } else { l };
        pct.clamp(0.0, 100.0).round() / 10.0 // one decimal place
    }).unwrap_or(0.0);

    // RSS: VmRSS (kB) from /proc/self/status -> MB.
    let rss = proc_self_rss_mb();
    (cpu, rss)
}

fn fs_loadavg_first() -> Option<f64> {
    let raw = std::fs::read_to_string("/proc/loadavg").ok()?;
    let first = raw.split_whitespace().next()?;
    first.replace(',', "").parse::<f64>().ok()
}

/// Count logical CPUs via /sys/devices/system/cpu/online (e.g. "0-7") or nproc.
fn count_cpus() -> usize {
    if let Ok(raw) = std::fs::read_to_string("/sys/devices/system/cpu/online") {
        // Forms: "0-7", "0,2,4-7", or "all".
        let digits: usize = raw.chars().filter(|c| c.is_ascii_digit()).count();
        if digits > 0 { return digits; }
    }
    // Fallbacks (least reliable).
    std::env::var("NPROCESSORS_ONLINE").ok().and_then(|s| s.parse().ok())
        .or_else(|| num_cpus_from_stat())
        .unwrap_or(1)
}

/// Fallback CPU count: number of "cpu" lines in /proc/stat.
fn num_cpus_from_stat() -> Option<usize> {
    let raw = std::fs::read_to_string("/proc/stat").ok()?;
    let n = raw.lines().filter(|l| l.starts_with("cpu ")).count();
    Some(n)
}

/// Read VmRSS (kB) from /proc/self/status, convert to MB.
fn proc_self_rss_mb() -> f64 {
    let raw = match std::fs::read_to_string("/proc/self/status") {
        Ok(v) => v,
        Err(_) => return 0.0,
    };
    for line in raw.lines() {
        if let Some(rest) = line.strip_prefix("VmRSS:") {
            // "<digits> kB"
            let num: f64 = match rest.split_whitespace().next() {
                Some(s) => s.parse().unwrap_or(0.0),
                None => return 0.0,
            };
            return (num / 1024.0).round(); // kB -> MB
        }
    }
    0.0
}
