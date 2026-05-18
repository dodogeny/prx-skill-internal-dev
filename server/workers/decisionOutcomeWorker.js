'use strict';

// Decision-Outcome Linkage Worker — runs as a worker_threads thread.
//
// Closes the loop on architectural decisions that today sit in the KB
// (`shared/decisions.md`, `shared/skill-changelog.md`, `lessons-learned/*.md`)
// without an automated "did this turn out to be right?" pass.
//
// On each run:
//   1. Walk the KB for decision entries (any `## D-XXX` / `## SC-XXX` /
//      `## LL-XXX` heading is treated as a decision candidate; the exact ID
//      shape is permissive on purpose).
//   2. For each decision, collect citing tickets (the decision's own ticket
//      ref + retro entries that mention the decision ID or quote it).
//   3. Search agent retros (`personas/memory/{agent}/*.md`) and per-developer
//      lessons-learned for keyword-based confirmation / contradiction signals.
//   4. Grade the decision: CONFIRMED (>= MIN_EVIDENCE confirms, zero refutes),
//      CONTRADICTED (>= 1 refute), PENDING otherwise.
//   5. Write a single proposal block per graded decision to
//      ~/.prevoyant/knowledge-buildup/decision-outcomes.md (status PENDING
//      APPROVAL — humans promote to the KB).
//
// Nothing is ever written directly into the KB.  Same approval workflow as
// the Pattern Miner.
//
// Config env vars:
//   PRX_DECISION_OUTCOME_ENABLED        — Y to enable
//   PRX_DECISION_OUTCOME_INTERVAL_DAYS  — run interval (default 7)
//   PRX_DECISION_OUTCOME_LOOKBACK_DAYS  — only consider retros younger than
//                                          this many days (default 90)
//   PRX_DECISION_OUTCOME_MIN_EVIDENCE   — min confirmations to grade CONFIRMED
//                                          (default 2)
//   PRX_KB_MODE / PRX_KNOWLEDGE_DIR / PRX_KB_LOCAL_CLONE — KB location.

const { workerData, parentPort } = require('worker_threads');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const BUILDUP_DIR = path.join(os.homedir(), '.prevoyant', 'knowledge-buildup');
const STATE_DIR   = path.join(os.homedir(), '.prevoyant', 'server');
const STATE_FILE  = path.join(STATE_DIR,    'decision-outcome-state.json');
const OUT_FILE    = path.join(BUILDUP_DIR,  'decision-outcomes.md');

// Decision-style headings.  Permissive — accepts any short ID prefix the team
// uses (D-, SC-, LL-, ADR-).  The grade still flows through human review, so
// false positives are cheap.
const DECISION_HEAD_RE = /^##\s+([A-Z]{1,5}-\d+)\s*[—\-:]\s*(.+?)\s*$/gm;

// Phrase banks for the evidence pass.
const CONFIRM_PHRASES = [
  'confirmed', 'validated', 'still valid', 'still holds', 'held up',
  'still applies', 'proved correct', 'turned out right', 'matched expectation',
];
const REFUTE_PHRASES = [
  'contradicted', 'refuted', 'did not hold', 'no longer holds', 'outdated',
  'wrong assumption', 'turned out wrong', 'did not match', 'no longer applies',
  'incorrect', 'invalidated',
];

// ── Config ────────────────────────────────────────────────────────────────────

function isEnabled()        { return (process.env.PRX_DECISION_OUTCOME_ENABLED || '').toUpperCase() === 'Y'; }
function intervalMs()       { return Math.max(0.1, parseFloat(process.env.PRX_DECISION_OUTCOME_INTERVAL_DAYS || '7')) * 86_400_000; }
function lookbackDays()     { return Math.max(1,   parseInt(process.env.PRX_DECISION_OUTCOME_LOOKBACK_DAYS   || '90',  10)); }
function minEvidence()      { return Math.max(1,   parseInt(process.env.PRX_DECISION_OUTCOME_MIN_EVIDENCE    || '2',   10)); }

function kbDir() {
  const mode = process.env.PRX_KB_MODE || 'local';
  return mode === 'distributed'
    ? (process.env.PRX_KB_LOCAL_CLONE || path.join(os.homedir(), '.prevoyant', 'kb'))
    : (process.env.PRX_KNOWLEDGE_DIR  || path.join(os.homedir(), '.prevoyant', 'knowledge-base'));
}

// ── State ─────────────────────────────────────────────────────────────────────

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

// ── KB walking ────────────────────────────────────────────────────────────────

function readSafe(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (_) { return ''; }
}

// Returns {id, title, file, body} entries.  Body is the text from this
// heading up to the next `##` heading.
function parseDecisions(file) {
  const text = readSafe(file);
  if (!text) return [];

  // Pre-split into heading-bounded sections so we don't double-scan.
  const out = [];
  const lines = text.split('\n');
  let current = null;
  for (const line of lines) {
    DECISION_HEAD_RE.lastIndex = 0;
    const m = line.match(/^##\s+([A-Z]{1,5}-\d+)\s*[—\-:]\s*(.+?)\s*$/);
    if (m) {
      if (current) out.push(current);
      current = { id: m[1], title: m[2].trim(), file, body: '' };
    } else if (current) {
      current.body += line + '\n';
    }
  }
  if (current) out.push(current);
  return out;
}

function collectDecisions() {
  const kb = kbDir();
  const decisionFiles = [
    path.join(kb, 'shared', 'decisions.md'),
    path.join(kb, 'shared', 'skill-changelog.md'),
  ];

  // Also scan all per-developer lessons-learned files.
  const llDir = path.join(kb, 'lessons-learned');
  try {
    for (const f of fs.readdirSync(llDir)) {
      if (f.endsWith('.md')) decisionFiles.push(path.join(llDir, f));
    }
  } catch (_) { /* dir missing — fine */ }

  const all = [];
  for (const f of decisionFiles) all.push(...parseDecisions(f));
  return all;
}

// Extract ticket keys (e.g. IV-1234) from a body of text.
function extractTicketKeys(body) {
  if (!body) return [];
  const out = new Set();
  const re  = /\b([A-Z]{2,10}-\d+)\b/g;
  let m;
  while ((m = re.exec(body)) !== null) out.add(m[1]);
  return [...out];
}

// Walk all agent retros (`personas/memory/{agent}/*.md`) and per-developer
// lessons-learned modified within the lookback window.  Returns an array of
// { file, mtime, text }.
function collectRetros() {
  const kb = kbDir();
  const cutoff = Date.now() - lookbackDays() * 86_400_000;
  const out = [];

  // Agent persona memory
  const personasDir = path.join(kb, 'personas', 'memory');
  try {
    for (const agent of fs.readdirSync(personasDir)) {
      const adir = path.join(personasDir, agent);
      let entries;
      try { entries = fs.readdirSync(adir); } catch (_) { continue; }
      for (const f of entries) {
        if (!f.endsWith('.md')) continue;
        const full = path.join(adir, f);
        let stat;
        try { stat = fs.statSync(full); } catch (_) { continue; }
        if (stat.mtimeMs < cutoff) continue;
        out.push({ file: full, mtime: stat.mtimeMs, text: readSafe(full) });
      }
    }
  } catch (_) {}

  // Per-developer lessons-learned (also a retro source)
  const llDir = path.join(kb, 'lessons-learned');
  try {
    for (const f of fs.readdirSync(llDir)) {
      if (!f.endsWith('.md')) continue;
      const full = path.join(llDir, f);
      let stat;
      try { stat = fs.statSync(full); } catch (_) { continue; }
      if (stat.mtimeMs < cutoff) continue;
      out.push({ file: full, mtime: stat.mtimeMs, text: readSafe(full) });
    }
  } catch (_) {}

  return out;
}

// ── Grading ───────────────────────────────────────────────────────────────────

// For one decision, walk all retros and tally evidence.
function gradeDecision(decision, retros) {
  const id = decision.id;
  const ownerTickets = new Set(extractTicketKeys(decision.body));
  const evidence = { confirms: [], refutes: [] };

  for (const r of retros) {
    if (!r.text) continue;

    // Cite if the retro mentions the decision ID or one of the decision's
    // owner tickets.  We keep a generous match — the human still reviews.
    const mentionsId     = r.text.includes(id);
    const mentionsTicket = [...ownerTickets].some(t => r.text.includes(t));
    if (!mentionsId && !mentionsTicket) continue;

    // Slice a ±2 line window around each match and check phrase banks.
    const lines = r.text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes(id) && !mentionsLine(line, ownerTickets)) continue;
      const windowText = lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 3)).join(' ').toLowerCase();
      const conf  = CONFIRM_PHRASES.find(p => windowText.includes(p));
      const ref   = REFUTE_PHRASES.find(p  => windowText.includes(p));
      const quote = line.trim().slice(0, 140);
      if (ref)   evidence.refutes.push({  file: r.file, quote, phrase: ref  });
      else if (conf) evidence.confirms.push({ file: r.file, quote, phrase: conf });
    }
  }

  const status = (evidence.refutes.length >= 1)
    ? 'CONTRADICTED'
    : (evidence.confirms.length >= minEvidence() ? 'CONFIRMED' : 'PENDING');

  return { status, evidence, citingTickets: [...ownerTickets] };
}

function mentionsLine(line, ticketSet) {
  for (const t of ticketSet) if (line.includes(t)) return true;
  return false;
}

// ── Output ────────────────────────────────────────────────────────────────────

function relToHome(p) {
  const h = os.homedir();
  return p.startsWith(h) ? '~' + p.slice(h.length) : p;
}

function relToKb(p) {
  const k = kbDir();
  return p.startsWith(k) ? path.relative(k, p) : p;
}

function renderProposal(decision, grade) {
  const conf = grade.evidence.confirms.slice(0, 5);
  const refs = grade.evidence.refutes.slice(0, 5);

  const lines = [];
  lines.push(`## DO-${decision.id} — ${decision.title}`);
  lines.push(`source: \`${relToKb(decision.file)}\` | status: **${grade.status}** | tickets: ${grade.citingTickets.join(', ') || '—'}`);
  lines.push(`evidence: ${grade.evidence.confirms.length} confirmation(s), ${grade.evidence.refutes.length} contradiction(s)`);
  if (conf.length) {
    lines.push('');
    lines.push('**Confirmations:**');
    for (const e of conf) lines.push(`- \`${relToKb(e.file)}\` (phrase: _${e.phrase}_) — ${e.quote}`);
  }
  if (refs.length) {
    lines.push('');
    lines.push('**Contradictions:**');
    for (const e of refs) lines.push(`- \`${relToKb(e.file)}\` (phrase: _${e.phrase}_) — ${e.quote}`);
  }
  lines.push('');
  lines.push(`next action: ${nextAction(grade.status)}`);
  lines.push('');
  lines.push('---');
  return lines.join('\n');
}

function nextAction(status) {
  if (status === 'CONFIRMED')    return 'PROMOTE — mark this decision `status: CONFIRMED` in its source file. Update the `confirmed:` counter.';
  if (status === 'CONTRADICTED') return 'REVIEW — investigate the contradictions before relying on this decision again. Consider deprecating in source file.';
  return 'WATCH — insufficient evidence yet; keep monitoring on the next run.';
}

function writeProposals(graded) {
  if (graded.length === 0) {
    log('info', 'No graded decisions this run');
    return;
  }
  try {
    fs.mkdirSync(BUILDUP_DIR, { recursive: true });
    const header = [
      `# Decision Outcomes — generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
      '',
      `Status: **PENDING APPROVAL**. Reviewer should evaluate each block and either`,
      `promote the grade to its source KB file or mark it dismissed below the entry.`,
      '',
      `Inputs: \`shared/decisions.md\`, \`shared/skill-changelog.md\`, \`lessons-learned/*.md\`.`,
      `Evidence window: retros from the last ${lookbackDays()} day(s).`,
      `Grading threshold: ≥${minEvidence()} confirmations and zero contradictions → CONFIRMED.`,
      '',
      '---',
      '',
    ].join('\n');
    fs.writeFileSync(OUT_FILE, header + graded.join('\n') + '\n', 'utf8');
    log('info', `Wrote ${graded.length} proposal(s) to ${relToHome(OUT_FILE)}`);
  } catch (err) {
    log('warn', `Failed to write proposals: ${err.message}`);
  }
}

// ── Main scan ────────────────────────────────────────────────────────────────

function runScan(state) {
  if (!isEnabled()) return;

  log('info', `Scanning decisions (lookback=${lookbackDays()}d, min-evidence=${minEvidence()})`);

  const decisions = collectDecisions();
  log('info', `Found ${decisions.length} decision(s) in KB`);

  const retros = collectRetros();
  log('info', `Reading ${retros.length} retro file(s)`);

  let confirmed = 0, contradicted = 0, pending = 0;
  const graded = [];

  for (const d of decisions) {
    const grade = gradeDecision(d, retros);
    if (grade.evidence.confirms.length === 0 && grade.evidence.refutes.length === 0) continue;

    if (grade.status === 'CONFIRMED')    confirmed++;
    else if (grade.status === 'CONTRADICTED') contradicted++;
    else                                     pending++;

    graded.push(renderProposal(d, grade));
  }

  writeProposals(graded);

  state.lastRun = Date.now();
  saveState(state);

  if (parentPort) parentPort.postMessage({
    type:         'decisions-reviewed',
    decisionsScanned: decisions.length,
    retrosScanned:    retros.length,
    confirmed,
    contradicted,
    pending,
  });
}

// ── Logging ──────────────────────────────────────────────────────────────────

function log(level, msg) {
  const ts = new Date().toISOString();
  if (parentPort) parentPort.postMessage({ type: 'log', level, msg, ts });
  console.log(`[${ts}] [decision-outcome/${level}] ${msg}`);
}

// ── Deterministic scheduling helpers ─────────────────────────────────────────
//
// PRX_DECISION_OUTCOME_RUN_AT (optional) — "HH:MM" 24-hour clock.
// When set, the worker runs at that time every day regardless of when the
// server started.  When unset, falls back to the interval-elapsed approach.

function runAtTime() {
  const v = (process.env.PRX_DECISION_OUTCOME_RUN_AT || '').trim();
  return /^\d{1,2}:\d{2}$/.test(v) ? v : null;
}

// ms until the next scheduled run (clock mode or interval mode).
function msUntilNextRun() {
  const runAt = runAtTime();
  if (runAt) {
    const [h, m] = runAt.split(':').map(Number);
    const next   = new Date();
    next.setHours(h, m, 0, 0);
    if (next <= new Date()) next.setDate(next.getDate() + 1);
    return next.getTime() - Date.now();
  }
  // Interval mode: remaining time until intervalMs elapses since lastRun.
  const s         = loadState();
  const remaining = intervalMs() - (Date.now() - (s.lastRun || 0));
  return Math.max(60_000, remaining);
}

// True when the run is actually due (avoids spurious fires when the 1h cap
// causes the loop to wake before the target time).
function isRunDue() {
  const runAt = runAtTime();
  if (runAt) {
    const [h, m] = runAt.split(':').map(Number);
    const now    = new Date();
    const todayTarget = new Date(now);
    todayTarget.setHours(h, m, 0, 0);
    if (now < todayTarget) return false;        // not yet reached today's slot
    const s = loadState();
    return !s.lastRun || s.lastRun < todayTarget.getTime(); // not already run today
  }
  const s = loadState();
  return !s.lastRun || (Date.now() - s.lastRun) >= intervalMs();
}

// ── Main loop ─────────────────────────────────────────────────────────────────

let halted = false;
if (parentPort) {
  parentPort.on('message', msg => {
    if (msg?.type === 'graceful-stop') halted = true;
    if (msg?.type === 'run-now')       { try { runScan(loadState()); } catch (e) { log('error', e.message); } }
  });
}

(function main() {
  const runAt = runAtTime();
  log('info',
    `Started — lookback=${lookbackDays()}d interval=${process.env.PRX_DECISION_OUTCOME_INTERVAL_DAYS || 7}d ` +
    `min-evidence=${minEvidence()}` + (runAt ? ` run-at=${runAt}` : '')
  );

  if (isRunDue()) {
    try { runScan(loadState()); } catch (e) { log('error', e.message); }
  }

  (async function loop() {
    while (!halted) {
      // Cap sleep at 1h so wake-from-sleep / time-change are caught promptly.
      await new Promise(r => setTimeout(r, Math.min(msUntilNextRun(), 3_600_000)));
      if (halted) break;
      if (isRunDue()) {
        try { runScan(loadState()); } catch (e) { log('error', e.message); }
      }
    }
    log('info', 'Stopped');
  })();
})();
