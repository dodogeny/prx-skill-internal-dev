'use strict';

// Stale Branch Detector — runs as a worker_threads thread.
//
// Periodically lists feature branches in the source repository, cross-
// references each branch against KB session records and open Jira PRs, and
// flags tickets that were analysed (KB session exists, status=success) but
// never acted on (branch is old, no linked PR in Jira).
//
// Writes two artefacts:
//   ~/.prevoyant/server/stale-branches-report.json  — machine-readable summary
//   ~/.prevoyant/knowledge-buildup/stale-branches.md — human-readable, for dev review
//
// Config env vars:
//   PRX_STALE_BRANCH_ENABLED     — Y to enable (default N)
//   PRX_STALE_BRANCH_DAYS        — branches with no commit activity for this many
//                                   days are considered stale (default 14)
//   PRX_STALE_BRANCH_INTERVAL_DAYS — run every N days (default 1)
//   PRX_REPO_DIR                 — local path to the source repository
//   PRX_JIRA_URL / PRX_JIRA_USERNAME / PRX_JIRA_API_TOKEN
//                                — Jira credentials; used to check for linked PRs
//                                   (graceful degradation — omit to skip PR check)

const { workerData, parentPort } = require('worker_threads');
const { execSync }               = require('child_process');
const https                      = require('https');
const fs                         = require('fs');
const os                         = require('os');
const path                       = require('path');

const BUILDUP_DIR     = path.join(os.homedir(), '.prevoyant', 'knowledge-buildup');
const STATE_DIR       = path.join(os.homedir(), '.prevoyant', 'server');
const STATE_FILE      = path.join(STATE_DIR,    'stale-branch-state.json');
const REPORT_FILE     = path.join(STATE_DIR,    'stale-branches-report.json');
const STALE_MD_FILE   = path.join(BUILDUP_DIR,  'stale-branches.md');
const SESSIONS_DIR    = path.join(os.homedir(), '.prevoyant', 'sessions');

// Regex to extract a Jira-style ticket key from a branch name.
// Matches: feature/IV-1234-some-title, fix/IV-1234, IV-1234-desc, etc.
const TICKET_RE = /\b([A-Z]{2,10}-\d+)\b/;

// Branch name prefixes considered to be feature/fix work branches.
const WORK_BRANCH_PREFIXES = ['feature/', 'fix/', 'bugfix/', 'hotfix/', 'feat/'];

// ── Config ────────────────────────────────────────────────────────────────────

function isEnabled()      { return (process.env.PRX_STALE_BRANCH_ENABLED || '').toUpperCase() === 'Y'; }
function staleDays()      { return Math.max(1, parseInt(process.env.PRX_STALE_BRANCH_DAYS          || '14', 10)); }
function intervalMs()     { return Math.max(1, parseFloat(process.env.PRX_STALE_BRANCH_INTERVAL_DAYS || '1')) * 86_400_000; }
function repoDir()        { return process.env.PRX_REPO_DIR || process.env.PRX_SOURCE_REPO_DIR || ''; }
function jiraBaseUrl()    { return (process.env.PRX_JIRA_URL || '').replace(/\/$/, ''); }
function jiraUser()       { return process.env.PRX_JIRA_USERNAME || ''; }
function jiraToken()      { return process.env.PRX_JIRA_API_TOKEN || ''; }

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

// ── Git helpers ───────────────────────────────────────────────────────────────

function git(args, cwd) {
  return execSync(`git ${args}`, {
    cwd,
    encoding: 'utf8',
    timeout:  15_000,
    stdio:    ['ignore', 'pipe', 'ignore'],
  }).trim();
}

// Returns [{name, ticketKey, lastCommitDate, lastCommitSha, lastCommitMsg}]
function listWorkBranches(repo) {
  let raw;
  try {
    // List all local branches with their last commit date in Unix epoch.
    // Format: <epoch>\t<branch-name>
    raw = git('branch --format="%(committerdate:unix)\t%(refname:short)"', repo);
  } catch (_) {
    return [];
  }

  const cutoffMs = Date.now() - staleDays() * 86_400_000;
  const branches = [];

  for (const line of raw.split('\n')) {
    const stripped = line.replace(/^"|"$/g, '').trim();
    if (!stripped) continue;

    const [epochStr, ...nameParts] = stripped.split('\t');
    const name = nameParts.join('\t');
    if (!name) continue;

    // Only consider branches that look like work branches
    const isWork = WORK_BRANCH_PREFIXES.some(p => name.startsWith(p))
                || TICKET_RE.test(name);
    if (!isWork) continue;

    const ticketMatch = name.match(TICKET_RE);
    if (!ticketMatch) continue; // no ticket key → can't cross-reference KB

    const lastCommitMs = parseInt(epochStr, 10) * 1000;
    if (isNaN(lastCommitMs)) continue;

    // Only report branches that have been quiet for >= staleDays
    if (lastCommitMs > cutoffMs) continue;

    let lastCommitSha = '';
    let lastCommitMsg = '';
    try {
      const log = git(`log -1 --format="%H\t%s" ${name}`, repo);
      const [sha, ...msgParts] = log.split('\t');
      lastCommitSha = sha.trim().slice(0, 8);
      lastCommitMsg = msgParts.join('\t').trim().slice(0, 80);
    } catch (_) {}

    branches.push({
      name,
      ticketKey:      ticketMatch[1],
      lastCommitDate: new Date(lastCommitMs).toISOString().slice(0, 10),
      lastCommitMs,
      lastCommitSha,
      lastCommitMsg,
    });
  }

  return branches;
}

// ── KB session cross-reference ────────────────────────────────────────────────

// Returns the session status for a ticket, or null if no session file exists.
function getSessionStatus(ticketKey) {
  const file = path.join(SESSIONS_DIR, `${ticketKey}-session.json`);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { status: raw.status, completedAt: raw.completedAt || null, mode: raw.mode || null };
  } catch (_) {
    return null;
  }
}

// ── Jira PR check ─────────────────────────────────────────────────────────────
// Uses the Jira REST API to check for any development-panel links (PRs).
// Returns true if at least one linked PR or remote issue link is found.
// Gracefully returns false on any error so the scan continues.

function jiraGet(urlPath) {
  return new Promise((resolve) => {
    const base = jiraBaseUrl();
    const user = jiraUser();
    const tok  = jiraToken();
    if (!base || !user || !tok) return resolve(null);

    let urlObj;
    try { urlObj = new URL(base + urlPath); }
    catch (_) { return resolve(null); }

    const auth = Buffer.from(`${user}:${tok}`).toString('base64');
    const req  = https.request({
      hostname: urlObj.hostname,
      port:     urlObj.port || 443,
      path:     urlObj.pathname + urlObj.search,
      method:   'GET',
      headers:  { Authorization: `Basic ${auth}`, Accept: 'application/json' },
    }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(8000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

async function hasPrLinked(ticketKey) {
  // Jira's remote issue links endpoint lists any PR/Bitbucket links attached
  // to the ticket through the development panel.
  const links = await jiraGet(`/rest/api/2/issue/${ticketKey}/remotelink`);
  if (!Array.isArray(links)) return null; // API unavailable — unknown
  return links.length > 0;
}

// ── Main scan ─────────────────────────────────────────────────────────────────

async function runScan(state) {
  if (!isEnabled()) return;

  const repo = repoDir();
  if (!repo || !fs.existsSync(path.join(repo, '.git'))) {
    log('warn', 'PRX_REPO_DIR not set or not a git repo — skipping stale branch scan');
    state.lastRun = Date.now();
    saveState(state);
    return;
  }

  log('info', `Scanning for stale branches (>${staleDays()}d quiet) in ${repo}`);

  const workBranches = listWorkBranches(repo);
  log('info', `Found ${workBranches.length} candidate branch(es) with Jira ticket keys`);

  const staleEntries  = [];
  const activeEntries = [];

  for (const branch of workBranches) {
    const session = getSessionStatus(branch.ticketKey);

    // Not analysed yet — not our concern (no KB session means no dev work done here)
    if (!session || session.status !== 'success') continue;

    const prLinked = await hasPrLinked(branch.ticketKey);
    const daysSilent = Math.floor((Date.now() - branch.lastCommitMs) / 86_400_000);

    const entry = {
      branch:        branch.name,
      ticketKey:     branch.ticketKey,
      lastCommit:    branch.lastCommitDate,
      lastCommitSha: branch.lastCommitSha,
      lastCommitMsg: branch.lastCommitMsg,
      daysSilent,
      sessionMode:   session.mode,
      sessionCompletedAt: session.completedAt,
      prLinked,      // true | false | null (null = Jira unavailable)
    };

    if (prLinked === false) {
      staleEntries.push(entry);
    } else {
      // Has a PR or Jira check was unavailable — not considered stale
      activeEntries.push(entry);
    }
  }

  const scannedAt = new Date().toISOString();

  // Write machine-readable report
  const report = {
    scannedAt,
    repoDir:       repo,
    staleDays:     staleDays(),
    branchesChecked: workBranches.length,
    staleCount:    staleEntries.length,
    stale:         staleEntries,
    active:        activeEntries,
  };
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2), 'utf8');
  } catch (_) {}

  // Write human-readable Markdown for developer review
  if (staleEntries.length > 0) {
    try {
      fs.mkdirSync(BUILDUP_DIR, { recursive: true });
      const date = scannedAt.slice(0, 10);

      const lines = [
        `# Stale Branches — scan ${date}`,
        '',
        `**Branches checked:** ${workBranches.length}  ` +
        `**Stale (analysed, no PR, >${staleDays()}d quiet):** ${staleEntries.length}`,
        '',
        'Each entry below has a completed KB session but no linked PR in Jira.',
        'The developer should either raise a PR, close the branch, or re-queue the ticket.',
        '',
        '| Branch | Ticket | Last commit | Days silent | KB session | Action |',
        '|--------|--------|-------------|-------------|-----------|--------|',
        ...staleEntries.map(e =>
          `| \`${e.branch}\` | ${e.ticketKey} | ${e.lastCommit} (${e.lastCommitSha}) | ${e.daysSilent}d | ${e.sessionMode} — ${(e.sessionCompletedAt || '').slice(0, 10)} | ⚠️ No PR found |`
        ),
        '',
      ];

      fs.writeFileSync(STALE_MD_FILE, lines.join('\n'), 'utf8');
    } catch (_) {}
  }

  log('info',
    `Scan complete — ${workBranches.length} candidates, ` +
    `${staleEntries.length} stale (KB done, no PR), ` +
    `${activeEntries.length} active/unknown`
  );

  state.lastRun = Date.now();
  saveState(state);

  if (parentPort) parentPort.postMessage({
    type:           'stale-branches-scanned',
    branchesChecked: workBranches.length,
    staleCount:     staleEntries.length,
    stale:          staleEntries.map(e => ({ branch: e.branch, ticketKey: e.ticketKey, daysSilent: e.daysSilent })),
  });
}

// ── Logging ───────────────────────────────────────────────────────────────────

function log(level, msg) {
  const ts = new Date().toISOString();
  if (parentPort) parentPort.postMessage({ type: 'log', level, msg, ts });
  console.log(`[${ts}] [stale-branch/${level}] ${msg}`);
}

// ── Deterministic scheduling helpers ─────────────────────────────────────────
//
// PRX_STALE_BRANCH_RUN_AT (optional) — "HH:MM" 24-hour clock.
// When set, the worker runs at that time every day regardless of when the
// server started.  When unset, falls back to the interval-elapsed approach.

function runAtTime() {
  const v = (process.env.PRX_STALE_BRANCH_RUN_AT || '').trim();
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

// ── Main loop ─────────────────────────────────────────────────────────────────

let halted = false;
if (parentPort) {
  parentPort.on('message', msg => {
    if (msg?.type === 'graceful-stop') halted = true;
    if (msg?.type === 'run-now')       { const s = loadState(); runScan(s).catch(() => {}); }
  });
}

(async () => {
  const runAt = runAtTime();
  log('info',
    `Started — staleDays=${staleDays()} interval=${process.env.PRX_STALE_BRANCH_INTERVAL_DAYS || 1}d ` +
    `repo=${repoDir() || 'not set'}` + (runAt ? ` run-at=${runAt}` : '')
  );

  if (isRunDue()) await runScan(loadState());

  while (!halted) {
    await new Promise(r => setTimeout(r, Math.min(msUntilNextRun(), 3_600_000)));
    if (!halted && isRunDue()) await runScan(loadState());
  }

  log('info', 'Stopped');
})();
