// Persistent high-score board for the Rust engine — node-parity contract.
//
// Data shape on disk: `{ "entries": [ { name, score, ts }, ... ] }`, sorted by
// score desc and capped at MAX_ENTRIES. Intentionally tiny and synchronous:
// one game runs on one lock, so correctness > throughput here. Path comes from
// the SCORES_FILE env var (or cwd/scores.json) so it survives container
// recreates instead of living inside a rebuild-every-time image layer.

use std::fs;
use std::path::PathBuf;

pub const MAX_ENTRIES: usize = 5;
const NAME_MAX_LEN: usize = 12;
// Letters, digits, spaces, dash, underscore, apostrophe — nothing that could
// carry control chars or look like markup when rendered client-side.
const NAME_RE: &str = r"^[A-Za-z0-9 _'-]+$";

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ScoreEntry {
    pub name: String,
    pub score: i64,
    pub ts: u64, // unix ms, for stable ordering on ties / display
}

/// Wire/display payload — node's scorePayload() sends only name + score.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ScoreBoardEntry {
    pub name: String,
    pub score: i64,
}

fn scores_path() -> PathBuf {
    match std::env::var("SCORES_FILE") {
        Ok(p) if !p.trim().is_empty() => PathBuf::from(p.trim()),
        _ => PathBuf::from(std::env::current_dir().unwrap_or_default()).join("scores.json"),
    }
}

/// Read the board from disk. A missing/corrupt file yields an empty board
/// (never a crash) — mirrors node's loadScores().
pub fn load_scores() -> Vec<ScoreEntry> {
    let p = scores_path();
    let raw = match fs::read_to_string(p.as_path()) {
        Ok(s) => s,
        Err(_) => return vec![],
    };
    match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(v) => v.get("entries")
            .and_then(|e| e.as_array())
            .map(|arr| {
                let mut v: Vec<ScoreEntry> = arr.iter().filter_map(|e| {
                    // Keep only well-formed entries with a string name + numeric
                    // score. Name charset is enforced at submit-time (sanitize),
                    // not at load — mirrors node's loadScores().
                    let name = e.get("name").and_then(|n| n.as_str())?;
                    let score = e.get("score")?.as_i64()?;
                    let ts = e.get("ts").and_then(|t| t.as_u64()).unwrap_or_default();
                    Some(ScoreEntry { name: name.to_string(), score, ts })
                }).collect();
                v.sort_by(compare);
                v
            })
            .unwrap_or_default(),
        Err(_) => vec![],
    }
}

/// Persist the board atomically (write temp + rename). Best-effort; never throws.
fn persist(entries: &[ScoreEntry]) {
    let p = scores_path();
    if let Some(dir) = p.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let body = match serde_json::to_string_pretty(&serde_json::json!({ "entries": entries })) {
        Ok(b) => b,
        Err(_) => return,
    };
    let tmp = format!("{}.tmp-{}-{:?}", p.display(), std::process::id(), std::time::SystemTime::now());
    if fs::write(tmp.as_str(), body).is_ok() {
        let _ = fs::rename(tmp.as_str(), p.as_path());
    }
}

/// Sort by score desc; ties broken by newer ts first (mirrors node).
fn compare(a: &ScoreEntry, b: &ScoreEntry) -> std::cmp::Ordering {
    b.score.cmp(&a.score).then(b.ts.cmp(&a.ts))
}

fn sanitize_name(name: &str) -> String {
    let trimmed = name.trim();
    let slice = if trimmed.chars().count() > NAME_MAX_LEN {
        // Trim by chars, not bytes.
        trimmed.chars().take(NAME_MAX_LEN).collect::<String>()
    } else {
        trimmed.to_string()
    };
    let clean: String = slice.chars().filter(|c| matches!(c,
        'A'..='Z' | 'a'..='z' | '0'..='9' | ' ' | '_' | '\'' | '-')).collect();
    if clean.is_empty() { "Player".to_string() } else { clean }
}

/// Whether a score qualifies for the top-N board.
fn qualifies(entries: &[ScoreEntry], score: i64) -> bool {
    entries.len() < MAX_ENTRIES || score > (entries.last().map(|e| e.score).unwrap_or(i64::MAX))
}

pub struct SubmitResult {
    pub submitted: bool,
    pub inserted: bool,
    pub entries: Vec<ScoreEntry>,
}

/// Insert + validate a final score, keep top MAX_ENTRIES, persist. Returns the
/// board (wire payload is name+score only). `name` defaults to "Player" when
/// empty/unusable; non-numeric or negative scores are rejected outright.
pub fn submit_score(name: Option<String>, score: i64) -> SubmitResult {
    // Scores are integers; reject negatives. (is_finite is for floats.)
    if score < 0 {
        return SubmitResult { submitted: false, inserted: false, entries: load_scores() };
    }
    let mut entries = load_scores();
    if !qualifies(&entries, score) {
        return SubmitResult { submitted: false, inserted: false, entries };
    }
    entries.push(ScoreEntry { name: sanitize_name(name.as_deref().unwrap_or("Player")), score, ts: now_ms() });
    entries.sort_by(compare);
    entries.truncate(MAX_ENTRIES);
    persist(&entries);
    SubmitResult { submitted: true, inserted: true, entries }
}

/// Return the current top-N board (defaults to MAX_ENTRIES) without mutating.
pub fn top_scores(n: usize) -> Vec<ScoreEntry> {
    let all = load_scores();
    if n == 0 { all } else { all.into_iter().take(n).collect() }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
