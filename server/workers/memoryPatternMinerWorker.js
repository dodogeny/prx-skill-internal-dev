'use strict';

// Memory Pattern Miner — runs as a worker_threads thread.
//
// Periodically scans all agent persona memory files under
// <KB>/personas/memory/{agent}/*.md, groups learnings by category, and
// identifies patterns that appear across 3+ distinct tickets.
//
// Proposals land in ~/.prevoyant/knowledge-buildup/pattern-proposals.md
// (PENDING APPROVAL). They never enter the KB directly — a human or the
// Step 13j review process must promote them to shared/patterns.md.
//
// Config env vars (read at runtime, not via workerData):
//   PRX_PATTERN_MINER_ENABLED        — Y to enable (default N)
//   PRX_PATTERN_MINER_INTERVAL_DAYS  — run every N days (default 7)
//   PRX_PATTERN_MINER_MIN_TICKETS    — min distinct tickets for a pattern (default 3)
//   PRX_PATTERN_MINER_MAX_PROPOSALS  — max proposals per run (default 20)

const { workerData, parentPort } = require('worker_threads');
const fs   = require('fs');
const os   = require('os');
const path = require('path');

const AGENTS = ['morgan', 'alex', 'sam', 'jordan', 'henk', 'riley', 'bryan'];

const BUILDUP_DIR    = path.join(os.homedir(), '.prevoyant', 'knowledge-buildup');
const PROPOSALS_FILE = path.join(BUILDUP_DIR, 'pattern-proposals.md');
const STATE_DIR      = path.join(os.homedir(), '.prevoyant', 'server');
const STATE_FILE     = path.join(STATE_DIR, 'pattern-miner-state.json');

// ── Config ─────────────────────────────────────────────────────────────────────

function isEnabled()    { return (process.env.PRX_PATTERN_MINER_ENABLED || '').toUpperCase() === 'Y'; }
function intervalMs()   { return Math.max(1, parseFloat(process.env.PRX_PATTERN_MINER_INTERVAL_DAYS || '7')) * 86_400_000; }
function minTickets()   { return Math.max(2, parseInt(process.env.PRX_PATTERN_MINER_MIN_TICKETS || '3', 10)); }
function maxProposals() { return Math.max(1, parseInt(process.env.PRX_PATTERN_MINER_MAX_PROPOSALS || '20', 10)); }

function kbBaseDir() {
  const mode = process.env.PRX_KB_MODE || 'local';
  return mode === 'distributed'
    ? (process.env.PRX_KB_LOCAL_CLONE   || path.join(os.homedir(), '.prevoyant', 'kb'))
    : (process.env.PRX_KNOWLEDGE_DIR    || path.join(os.homedir(), '.prevoyant', 'knowledge-base'));
}

// ── State ──────────────────────────────────────────────────────────────────────

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch (_) { return { lastRun: 0, proposed: {} }; }
}

function saveState(state) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (_) {}
}

// ── Memory file parsing ────────────────────────────────────────────────────────
// Mirrors the parser in redisMemory.js / jsonMemory.js — kept inline to avoid
// importing those modules (which carry Redis client side-effects).

function extractSection(lines, re) {
  let inside = false;
  const out  = [];
  for (const line of lines) {
    if (!inside) { if (re.test(line)) inside = true; }
    else         { if (/^##\s+/.test(line)) break; out.push(line); }
  }
  return out;
}

function parseLearnings(lines) {
  const rows = [];
  for (const line of extractSection(lines, /##\s+What I Learned/i)) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map(c => c.trim()).filter(Boolean);
    if (cells.length < 4 || cells[0] === '#' || /^-+$/.test(cells[0]) || cells[1] === 'Observation') continue;
    const [, obs, cat, conf] = cells;
    if (!obs || obs.startsWith('{')) continue;
    rows.push({ content: obs.trim(), category: (cat || '').trim(), confidence: (conf || '').trim() });
  }
  return rows;
}

function parseSurprises(lines) {
  return extractSection(lines, /##\s+Things That Surprised Me/i)
    .filter(l => l.trim().startsWith('- ') && !l.includes('{Surprise'))
    .map(l => l.trim().slice(2).trim()).filter(Boolean);
}

// ── Ticket key extraction from filename ───────────────────────────────────────
// Memory files are named {YYYYMMDD}-{ticketKey}.md or {ticketKey}.md.

function ticketKeyFromFile(file) {
  const stem = file.slice(0, -3);
  return stem.replace(/^\d{8}-?/, '') || stem;
}

// ── Core mining logic ──────────────────────────────────────────────────────────

function collectAllLearnings() {
  const base = path.join(kbBaseDir(), 'personas', 'memory');
  // category → Map<ticketKey, [{content, confidence, agent}]>
  const byCategory = new Map();

  for (const agent of AGENTS) {
    const agentDir = path.join(base, agent);
    let files;
    try { files = fs.readdirSync(agentDir); }
    catch (_) { continue; }

    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const ticketKey = ticketKeyFromFile(file);
      let lines;
      try {
        lines = fs.readFileSync(path.join(agentDir, file), 'utf8').split('\n');
      } catch (_) { continue; }

      for (const r of parseLearnings(lines)) {
        const cat = (r.category || '').toUpperCase();
        if (!cat || cat === 'CATEGORY') continue;
        if (!byCategory.has(cat)) byCategory.set(cat, new Map());
        const ticketMap = byCategory.get(cat);
        if (!ticketMap.has(ticketKey)) ticketMap.set(ticketKey, []);
        ticketMap.get(ticketKey).push({ content: r.content, confidence: r.confidence, agent });
      }

      // Surprises count as high-signal learnings — group under synthetic category
      for (const s of parseSurprises(lines)) {
        const cat = 'SURPRISE';
        if (!byCategory.has(cat)) byCategory.set(cat, new Map());
        const ticketMap = byCategory.get(cat);
        if (!ticketMap.has(ticketKey)) ticketMap.set(ticketKey, []);
        ticketMap.get(ticketKey).push({ content: s, confidence: 'High', agent });
      }
    }
  }

  return byCategory;
}

function pickRepresentative(entries, n = 3) {
  // Prefer High confidence, then deduplicate by leading 60 chars
  const seen = new Set();
  return entries
    .sort((a, b) => {
      const score = { high: 3, medium: 2, med: 2, low: 1 };
      return (score[b.confidence.toLowerCase()] || 1) - (score[a.confidence.toLowerCase()] || 1);
    })
    .filter(e => {
      const key = e.content.slice(0, 60).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, n);
}

function proposeKey(cat, tickets) {
  return `${cat}::${[...tickets].sort().join(',')}`;
}

function runMine(state) {
  if (!isEnabled()) return;

  const byCategory = collectAllLearnings();
  const min        = minTickets();
  const max        = maxProposals();
  const proposals  = [];

  for (const [cat, ticketMap] of byCategory) {
    if (ticketMap.size < min) continue;
    const tickets = [...ticketMap.keys()];
    const key     = proposeKey(cat, tickets);

    // Skip already-proposed identical ticket sets
    if (state.proposed[key]) continue;

    const allEntries = tickets.flatMap(t => ticketMap.get(t).map(e => ({ ...e, ticketKey: t })));
    const reps       = pickRepresentative(allEntries);

    proposals.push({ cat, tickets, reps, key });
    if (proposals.length >= max) break;
  }

  if (!proposals.length) {
    log('info', 'No new pattern clusters found.');
    return;
  }

  const date = new Date().toISOString().slice(0, 10);
  try {
    fs.mkdirSync(BUILDUP_DIR, { recursive: true });

    const preamble = !fs.existsSync(PROPOSALS_FILE)
      ? '# Memory Pattern Proposals\n\n' +
        'Auto-generated by the Memory Pattern Miner. ' +
        'Review each entry and promote worthy patterns to shared/patterns.md.\n\n'
      : '';

    const blocks = proposals.map(p => {
      const ticketList = p.tickets.join(', ');
      const repLines   = p.reps.map(r => `  - [${r.agent}/${r.ticketKey}] ${r.content.slice(0, 120)}`).join('\n');
      return [
        `## PATTERN-CANDIDATE: ${p.cat} (${p.tickets.length} tickets)`,
        `Status: PENDING APPROVAL`,
        `Date: ${date}`,
        `Source: memory-pattern-miner`,
        `Tickets: ${ticketList}`,
        ``,
        `### Representative learnings`,
        repLines,
        ``,
        `### Proposed shared/patterns.md entry`,
        `> **Pattern: ${p.cat}** — Appears in ${p.tickets.length} tickets (${ticketList}).`,
        `> [Auto-proposal — review, refine, and promote to shared/patterns.md]`,
        ``,
      ].join('\n');
    }).join('\n');

    fs.appendFileSync(PROPOSALS_FILE, preamble + blocks, 'utf8');
    log('info', `Wrote ${proposals.length} proposal(s) to ${PROPOSALS_FILE}`);

    // Mark as proposed so we don't re-propose the same ticket set next run
    for (const p of proposals) state.proposed[p.key] = date;
    state.lastRun = Date.now();
    saveState(state);

    if (parentPort) parentPort.postMessage({ type: 'patterns-proposed', count: proposals.length });
  } catch (err) {
    log('error', `Write failed: ${err.message}`);
  }
}

// ── Logging ────────────────────────────────────────────────────────────────────

function log(level, msg) {
  const ts = new Date().toISOString();
  if (parentPort) parentPort.postMessage({ type: 'log', level, msg, ts });
  console.log(`[${ts}] [pattern-miner/${level}] ${msg}`);
}

// ── Deterministic scheduling helpers ──────────────────────────────────────────

function runAtTime() {
  const v = (process.env.PRX_PATTERN_MINER_RUN_AT || '').trim();
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
    if (msg?.type === 'run-now') { const s = loadState(); runMine(s); }
  });
}

(async () => {
  const runAt = runAtTime();
  log('info', `Started — interval=${process.env.PRX_PATTERN_MINER_INTERVAL_DAYS || 7}d minTickets=${minTickets()}` + (runAt ? ` run-at=${runAt}` : ''));

  if (isRunDue()) runMine(loadState());

  while (!halted) {
    await new Promise(r => setTimeout(r, Math.min(msUntilNextRun(), 3_600_000)));
    if (!halted && isRunDue()) runMine(loadState());
  }

  log('info', 'Stopped');
})();
