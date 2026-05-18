'use strict';

// KB Staleness Scanner — runs as a worker_threads thread.
//
// Periodically walks all .md files in the KB directory, extracts
// file:line references, and checks whether those files still exist at
// the configured source repo path at the expected line depth.
//
// Writes two artefacts:
//   ~/.prevoyant/server/kb-staleness-report.json   — machine-readable summary
//   ~/.prevoyant/knowledge-buildup/stale-refs.md   — human-readable, pending review
//
// Config env vars:
//   PRX_STALENESS_ENABLED          — Y to enable (default N)
//   PRX_STALENESS_INTERVAL_DAYS    — run every N days (default 7)
//   PRX_REPO_DIR                   — local path to the source repository
//                                    (falls back to PRX_SOURCE_REPO_DIR)

const { workerData, parentPort } = require('worker_threads');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const BUILDUP_DIR   = path.join(os.homedir(), '.prevoyant', 'knowledge-buildup');
const STATE_DIR     = path.join(os.homedir(), '.prevoyant', 'server');
const STATE_FILE    = path.join(STATE_DIR,    'staleness-state.json');
const REPORT_FILE   = path.join(STATE_DIR,    'kb-staleness-report.json');
const STALE_MD_FILE = path.join(BUILDUP_DIR,  'stale-refs.md');

// Matches ref patterns used in KB entries:
//   ref: path/to/File.java:123
//   Source: path/to/File.java:123
//   — path/to/File.java:123   (inline at end of [KB+] markers)
// Only captures paths that look like source files (have a file extension).
const REF_RE = /(?:(?:ref|[Ss]ource)\s*:\s*|—\s+)([\w./-]+\.\w{1,10}:\d+)/g;

// ── Config ─────────────────────────────────────────────────────────────────────

function isEnabled()  { return (process.env.PRX_STALENESS_ENABLED || '').toUpperCase() === 'Y'; }
function intervalMs() { return Math.max(1, parseFloat(process.env.PRX_STALENESS_INTERVAL_DAYS || '7')) * 86_400_000; }

function repoDir() {
  return process.env.PRX_REPO_DIR
    || process.env.PRX_SOURCE_REPO_DIR
    || '';
}

function kbDir() {
  const mode = process.env.PRX_KB_MODE || 'local';
  return mode === 'distributed'
    ? (process.env.PRX_KB_LOCAL_CLONE  || path.join(os.homedir(), '.prevoyant', 'kb'))
    : (process.env.PRX_KNOWLEDGE_DIR   || path.join(os.homedir(), '.prevoyant', 'knowledge-base'));
}

// ── State ──────────────────────────────────────────────────────────────────────

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch (_) { return { lastRun: 0 }; }
}

function saveState(state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (_) {}
}

// ── KB walker ─────────────────────────────────────────────────────────────────

function walkKb(dir, base = '') {
  const files = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (_) { return files; }
  for (const e of entries) {
    const rel  = base ? `${base}/${e.name}` : e.name;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) files.push(...walkKb(full, rel));
    else if (e.isFile() && e.name.endsWith('.md')) files.push({ rel, full });
  }
  return files;
}

// ── Ref extraction ─────────────────────────────────────────────────────────────

function extractRefs(kbFile) {
  let text;
  try { text = fs.readFileSync(kbFile, 'utf8'); }
  catch (_) { return []; }

  const refs = [];
  let m;
  REF_RE.lastIndex = 0;
  while ((m = REF_RE.exec(text)) !== null) {
    const raw   = m[1];
    const colon = raw.lastIndexOf(':');
    if (colon < 0) continue;
    const filePart = raw.slice(0, colon);
    const lineNum  = parseInt(raw.slice(colon + 1), 10);
    if (!filePart || isNaN(lineNum) || lineNum < 1) continue;
    refs.push({ raw, filePart, lineNum });
  }
  return refs;
}

// ── Staleness check ────────────────────────────────────────────────────────────

function checkRef(ref, repo) {
  if (!repo) return { status: 'no-repo' };

  const candidates = [
    path.join(repo, ref.filePart),
    // Also try without leading path components in case KB stored partial paths
  ];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    // File exists — check line count
    try {
      const content    = fs.readFileSync(candidate, 'utf8');
      const lineCount  = content.split('\n').length;
      if (ref.lineNum > lineCount + 5) {
        return { status: 'line-stale', fileExists: true, lineCount, lineNum: ref.lineNum };
      }
      return { status: 'ok', fileExists: true };
    } catch (_) {
      return { status: 'ok', fileExists: true }; // can't read but it exists
    }
  }

  return { status: 'file-missing', fileExists: false };
}

// ── Main scan ──────────────────────────────────────────────────────────────────

function runScan(state) {
  if (!isEnabled()) return;

  const repo    = repoDir();
  const kb      = kbDir();
  const files   = walkKb(kb);
  const results = { ok: 0, missing: 0, lineStale: 0, noRepo: 0, details: [] };

  for (const { rel, full } of files) {
    const refs = extractRefs(full);
    for (const ref of refs) {
      const check = checkRef(ref, repo);
      if (check.status === 'ok') {
        results.ok++;
      } else if (check.status === 'file-missing') {
        results.missing++;
        results.details.push({ kbFile: rel, ref: ref.raw, issue: 'file-missing' });
      } else if (check.status === 'line-stale') {
        results.lineStale++;
        results.details.push({ kbFile: rel, ref: ref.raw, issue: 'line-stale', lineCount: check.lineCount });
      } else if (check.status === 'no-repo') {
        results.noRepo++;
      }
    }
  }

  const scannedAt = new Date().toISOString();
  results.scannedAt   = scannedAt;
  results.kbFiles     = files.length;
  results.refsChecked = results.ok + results.missing + results.lineStale;
  results.repoDir     = repo || '(not configured)';

  // Write machine-readable report
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(REPORT_FILE, JSON.stringify(results, null, 2), 'utf8');
  } catch (_) {}

  // Write human-readable stale-refs.md
  if (results.details.length) {
    try {
      fs.mkdirSync(BUILDUP_DIR, { recursive: true });
      const date = scannedAt.slice(0, 10);
      const header = [
        `# KB Stale References — scan ${date}`,
        ``,
        `**KB files scanned:** ${results.kbFiles}  **Refs checked:** ${results.refsChecked}`,
        `**Missing files:** ${results.missing}  **Line-stale refs:** ${results.lineStale}`,
        `**Repo:** \`${repo || 'not configured'}\``,
        ``,
        `Review each entry. For stale refs: update the line number, mark \`[STALE]\`,`,
        `or delete the entry if the symbol no longer exists.`,
        ``,
      ].join('\n');

      const rows = results.details.map(d => {
        const issue = d.issue === 'file-missing' ? '`file missing`' : `\`line stale (file has ${d.lineCount} lines)\``;
        return `| \`${d.ref}\` | ${d.kbFile} | ${issue} |`;
      });

      const table = [
        `| Ref | KB File | Issue |`,
        `|-----|---------|-------|`,
        ...rows,
        ``,
      ].join('\n');

      fs.writeFileSync(STALE_MD_FILE, header + table, 'utf8');
    } catch (_) {}
  }

  log('info',
    `Scan complete — ${results.kbFiles} KB files, ` +
    `${results.refsChecked} refs checked, ` +
    `${results.missing} missing, ${results.lineStale} line-stale` +
    (repo ? '' : ' (PRX_REPO_DIR not set — file-existence checks skipped)')
  );

  state.lastRun = Date.now();
  saveState(state);

  if (parentPort) parentPort.postMessage({
    type: 'staleness-scanned',
    kbFiles: results.kbFiles,
    refsChecked: results.refsChecked,
    stale: results.missing + results.lineStale,
  });
}

// ── Logging ────────────────────────────────────────────────────────────────────

function log(level, msg) {
  const ts = new Date().toISOString();
  if (parentPort) parentPort.postMessage({ type: 'log', level, msg, ts });
  console.log(`[${ts}] [kb-staleness/${level}] ${msg}`);
}

// ── Deterministic scheduling helpers ─────────────────────────────────────────
//
// PRX_STALENESS_RUN_AT (optional) — "HH:MM" 24-hour clock.
// When set, the worker runs at that time every day regardless of when the
// server started.  When unset, falls back to the interval-elapsed approach.

function runAtTime() {
  const v = (process.env.PRX_STALENESS_RUN_AT || '').trim();
  return /^\d{1,2}:\d{2}$/.test(v) ? v : null;
}

function msUntilNextRun() {
  const runAt = runAtTime();
  if (runAt) {
    const [h, m] = runAt.split(':').map(Number);
    const next   = new Date();
    next.setHours(h, m, 0, 0);
    if (next <= new Date()) next.setDate(next.getDate() + 1);
    return next.getTime() - Date.now();
  }
  const s         = loadState();
  const remaining = intervalMs() - (Date.now() - (s.lastRun || 0));
  return Math.max(60_000, remaining);
}

function isRunDue() {
  const runAt = runAtTime();
  if (runAt) {
    const [h, m] = runAt.split(':').map(Number);
    const now    = new Date();
    const todayTarget = new Date(now);
    todayTarget.setHours(h, m, 0, 0);
    if (now < todayTarget) return false;
    const s = loadState();
    return !s.lastRun || s.lastRun < todayTarget.getTime();
  }
  const s = loadState();
  return !s.lastRun || (Date.now() - s.lastRun) >= intervalMs();
}

// ── Main loop ──────────────────────────────────────────────────────────────────

let halted = false;
if (parentPort) {
  parentPort.on('message', msg => {
    if (msg?.type === 'graceful-stop') halted = true;
    if (msg?.type === 'run-now')       { const s = loadState(); runScan(s); }
  });
}

(async () => {
  const runAt = runAtTime();
  log('info', `Started — interval=${process.env.PRX_STALENESS_INTERVAL_DAYS || 7}d repo=${repoDir() || 'not set'}` + (runAt ? ` run-at=${runAt}` : ''));

  if (isRunDue()) runScan(loadState());

  while (!halted) {
    await new Promise(r => setTimeout(r, Math.min(msUntilNextRun(), 3_600_000)));
    if (!halted && isRunDue()) runScan(loadState());
  }

  log('info', 'Stopped');
})();
