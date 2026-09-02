// Persistent high-score board for the node engine.
//
// Scores are stored in a small JSON file on the host (bind-mounted at /app/data,
// path overridable via SCORES_FILE) so they survive container recreates — the
// production image is rebuilt every deploy, so an in-container file would vanish.
//
// Data shape:  { "entries": [ { name, score, ts }, ... ] }  sorted by score desc,
// capped at MAX_ENTRIES. Kept intentionally tiny and synchronous: this runs in a
// single-threaded event loop for one game and correctness > throughput here.

import fs from 'node:fs';
import path from 'node:path';

export const MAX_ENTRIES = 5;
const NAME_MAX_LEN = 12;
// Allow letters, digits, spaces, dash, underscore, apostrophe — nothing that
// could carry control chars or look like markup when rendered client-side.
const NAME_RE = /^[A-Za-z0-9 _'-]+$/;

export interface ScoreEntry {
  name: string;
  score: number;
  ts: number; // unix ms, for stable ordering on ties / display
}

interface ScoresFile { entries: ScoreEntry[] }

const DEFAULT_PATH = path.resolve(process.cwd(), 'data', 'scores.json');

function scoresFilePath(): string {
  const env = process.env.SCORES_FILE;
  return env && env.trim() ? env : DEFAULT_PATH;
}

function loadDefault(): ScoresFile {
  return { entries: [] };
}

/** Read the board from disk. Missing/corrupt file yields an empty board (no crash). */
export function loadScores(): ScoreEntry[] {
  const p = scoresFilePath();
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed: ScoresFile = JSON.parse(raw);
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    // Hardening: keep only well-formed entries with numeric score + string name.
    return entries
      .filter((e: any) => e && typeof e === 'object'
        && typeof e.name === 'string'
        && Number.isFinite(e.score))
      .map((e: any) => ({ name: String(e.name), score: Number(e.score), ts: Number(e.ts) || Date.now() }))
      .sort(compareEntries);
  } catch {
    return []; // no file yet → empty board
  }
}

/** Persist the board atomically (write temp + rename). Best-effort; never throws. */
function persist(entries: ScoreEntry[]): void {
  const p = scoresFilePath();
  let dir: string;
  try {
    dir = path.dirname(p);
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return; // can't persist — board stays in memory for this run only
  }
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ entries }, null, 2), 'utf8');
    fs.renameSync(tmp, p);
  } catch (e) {
    console.error('[scores] persist failed:', (e as Error).message);
  }
}

/** Sort by score desc; ties broken by newer first. */
export function compareEntries(a: ScoreEntry, b: ScoreEntry): number {
  return b.score - a.score || b.ts - a.ts;
}

function sanitizeName(name: string | undefined): string {
  if (typeof name !== 'string') return '';
  const trimmed = name.trim().slice(0, NAME_MAX_LEN);
  // Drop anything outside the allowlist; if nothing valid remains, use placeholder.
  const clean = trimmed.replace(/[^A-Za-z0-9 _'-]/g, '');
  return clean || 'Player';
}

export interface SubmitResult {
  submitted: boolean;   // whether this score actually made the board
  inserted: boolean;    // whether it placed a new entry (vs already present)
  entries: ScoreEntry[];
}

/** Insert + validate a final score, keep top MAX_ENTRIES, persist. */
export function submitScore(name: string | undefined, score: number): SubmitResult {
  const scoreNum = Number(score);
  if (!Number.isFinite(scoreNum) || scoreNum < 0) return { submitted: false, inserted: false, entries: loadScores() };

  let entries = loadScores();
  const qualified = entries.length < MAX_ENTRIES || scoreNum > (entries[entries.length - 1]?.score ?? -1);

  if (!qualified) {
    return { submitted: false, inserted: false, entries };
  }

  // Insert and re-cap.
  entries.push({ name: sanitizeName(name), score: scoreNum, ts: Date.now() });
  entries = compareEntriesSort(entries).slice(0, MAX_ENTRIES);
  persist(entries);
  return { submitted: true, inserted: true, entries };
}

/** Return the current top-N board (defaults to MAX_ENTRIES) without mutating. */
export function topScores(n = MAX_ENTRIES): ScoreEntry[] {
  const all = loadScores();
  return n > 0 ? all.slice(0, n) : all;
}

function compareEntriesSort(entries: ScoreEntry[]): ScoreEntry[] {
  return entries.sort(compareEntries);
}
