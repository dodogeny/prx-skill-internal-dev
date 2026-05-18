'use strict';

const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { getStats, getTicket, reRunTicket, recordScheduled, deleteTicket, hasActive } = require('./tracker');
const { killJob, enqueue, scheduleJob, prioritizeJob, pauseQueue, resumeQueue, isPaused, getQueueDepth } = require('../queue/jobQueue');
const activityLog = require('./activityLog');
const { getPollStatus } = require('../runner/pollScheduler');
const serverEvents  = require('../serverEvents');
const watchStore    = require('../watchers/watchStore');
const watchManager  = require('../watchers/watchManager');
const cpuMonitor    = require('../runner/cpuMonitor');

const VALID_MODES    = new Set(['dev', 'review', 'estimate']);
const WATCH_LOG_DIR  = path.join(os.homedir(), '.prevoyant', 'watch', 'logs');

const config = require('../config/env');

function isInSeenCache(ticketKey) {
  try {
    return fs.readFileSync(config.seenCacheFile, 'utf8')
      .split('\n')
      .some(l => l.trim() === ticketKey);
  } catch (_) {
    return false;
  }
}

function removeFromSeenCache(ticketKey) {
  try {
    const lines = fs.readFileSync(config.seenCacheFile, 'utf8').split('\n');
    fs.writeFileSync(
      config.seenCacheFile,
      lines.filter(l => l.trim() !== ticketKey).join('\n')
    );
  } catch (_) { /* file missing — nothing to remove */ }
}

const router = express.Router();

// Plugin metadata — read once at startup
let pluginVersion = '—';
let pluginDescription = 'Claude Code plugin for structured Jira-driven developer workflow.';
let pluginAuthor = 'dodogeny';
const GITHUB_URL = 'https://github.com/dodogeny/prevoyant-claude-plugin';
try {
  const meta = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../../plugin/.claude-plugin/plugin.json'), 'utf8')
  );
  pluginVersion    = meta.version     || '—';
  pluginDescription = meta.description || pluginDescription;
  pluginAuthor     = (meta.author && meta.author.name) || pluginAuthor;
} catch (_) { /* non-fatal */ }

// ── Update status helper ──────────────────────────────────────────────────────

const UPDATE_STATUS_FILE = path.join(os.homedir(), '.prevoyant', 'server', 'update-status.json');

function readUpdateStatus() {
  try { return JSON.parse(fs.readFileSync(UPDATE_STATUS_FILE, 'utf8')); }
  catch (_) { return { available: false, latestVersion: null, currentVersion: null, checkedAt: null }; }
}

// ── Disk status helper ────────────────────────────────────────────────────────

const DISK_STATUS_FILE = path.join(os.homedir(), '.prevoyant', 'server', 'disk-status.json');
const DISK_LOG_FILE    = path.join(os.homedir(), '.prevoyant', 'server', 'disk-log.json');

function readDiskStatus() {
  try {
    return JSON.parse(fs.readFileSync(DISK_STATUS_FILE, 'utf8'));
  } catch (_) {
    return { pendingCleanup: false, prevoyantMB: 0, diskUsedPct: 0, updatedAt: null, lastCleanupAt: null };
  }
}

function readDiskLog() {
  try {
    const raw = JSON.parse(fs.readFileSync(DISK_LOG_FILE, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch (_) {
    return [];
  }
}

function fmtBytes(bytes) {
  if (bytes == null) return '—';
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + ' GB';
  if (bytes >= 1048576)    return (bytes / 1048576).toFixed(1) + ' MB';
  if (bytes >= 1024)       return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}

// ── Watch log stats ───────────────────────────────────────────────────────────

function getWatchLogStats() {
  let totalBytes = 0, fileCount = 0, ticketCount = 0, oldestMs = Infinity;
  try {
    const ticketDirs = fs.readdirSync(WATCH_LOG_DIR, { withFileTypes: true }).filter(e => e.isDirectory());
    ticketCount = ticketDirs.length;
    for (const td of ticketDirs) {
      const dir = path.join(WATCH_LOG_DIR, td.name);
      try {
        for (const f of fs.readdirSync(dir)) {
          if (!f.endsWith('.log')) continue;
          try {
            const s = fs.statSync(path.join(dir, f));
            totalBytes += s.size;
            fileCount++;
            if (s.mtimeMs < oldestMs) oldestMs = s.mtimeMs;
          } catch (_) {}
        }
      } catch (_) {}
    }
  } catch (_) {}
  return {
    totalBytes,
    fileCount,
    ticketCount,
    oldestDate: oldestMs < Infinity ? new Date(oldestMs) : null,
    keepDays:   parseInt(process.env.PRX_WATCH_LOG_KEEP_DAYS        || '30', 10),
    keepPer:    parseInt(process.env.PRX_WATCH_LOG_KEEP_PER_TICKET  || '10', 10),
  };
}

// ── Claude budget helper ──────────────────────────────────────────────────────
// Cost is calculated from local token counts via codeburn (labelled "codeburn calc'd").

let _budgetCache    = null;
let _budgetCachedAt = 0;
const BUDGET_CACHE_MS = 120 * 1000;

// Fetch monthly spend from local codeburn (no network, reads JSONL files).
function fetchCodeburnMonthly() {
  const { execFile } = require('child_process');
  const now        = new Date();
  const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const today      = now.toISOString().slice(0, 10);

  return new Promise(resolve => {
    execFile(
      'npx', ['--yes', 'codeburn@latest', 'report', '--from', monthStart, '--to', today, '--format', 'json'],
      { timeout: 30000, env: process.env },
      (err, stdout) => {
        if (err || !stdout || !stdout.trim()) return resolve(null);
        try {
          resolve(JSON.parse(stdout));
        } catch (_) { resolve(null); }
      }
    );
  });
}

function getBudgetStatus() {
  if (_budgetCache && (Date.now() - _budgetCachedAt) < BUDGET_CACHE_MS) {
    return Promise.resolve(_budgetCache);
  }

  const budget    = parseFloat(process.env.PRX_MONTHLY_BUDGET || '0') || null;
  const thisMonth = new Date().toISOString().slice(0, 7);

  return fetchCodeburnMonthly().then(cbData => {
    const available = cbData != null;
    if (!available) {
      const fallback = { available: false, spent: null, budget, remaining: null, pct: null, month: thisMonth, source: 'unavailable', tokens: null };
      _budgetCache    = fallback;
      _budgetCachedAt = Date.now();
      return fallback;
    }

    const spent     = parseFloat(cbData?.overview?.cost ?? 0);
    const source    = 'codeburn-calculated';
    const remaining = budget != null ? Math.max(0, budget - spent) : null;
    const pct       = budget ? Math.min(100, Math.round((spent / budget) * 100)) : null;
    const month     = thisMonth;

    // Token summary from codeburn (always local)
    const models = cbData?.models || [];
    const tokens = {
      input:         models.reduce((s, m) => s + (m.inputTokens  || 0), 0),
      output:        models.reduce((s, m) => s + (m.outputTokens || 0), 0),
      cacheCreation: models.reduce((s, m) => s + (m.cacheCreationTokens || 0), 0),
      cacheRead:     models.reduce((s, m) => s + (m.cacheReadTokens     || 0), 0),
      total:         models.reduce((s, m) => s + (m.totalTokens  || 0), 0),
      calculated:    spent,
      models:        models.map(m => ({
        name: m.model || m.modelName, cost: parseFloat(m.cost ?? 0),
        input: m.inputTokens || 0, output: m.outputTokens || 0,
        cacheRead: m.cacheReadTokens || 0, cacheCreate: m.cacheCreationTokens || 0,
      })),
    };

    const result = { available: true, spent, budget, remaining, pct, month, source, tokens };
    _budgetCache    = result;
    _budgetCachedAt = Date.now();
    return result;
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtTokensK(n) {
  if (!n) return '0';
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
  return String(n);
}

function formatUptime(s) {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600),
        m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function fmt(date) {
  if (!date) return '—';
  return date.toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'medium' });
}

function dur(start, end) {
  if (!start) return '—';
  const ms = (end || new Date()) - start;
  const mins = Math.floor(ms / 60000), secs = Math.floor((ms % 60000) / 1000);
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

function fmtRelative(date) {
  if (!date) return null;
  const diffMs = date - Date.now();
  const abs    = Math.abs(diffMs);
  const past   = diffMs < 0;
  const mins   = Math.floor(abs / 60000);
  const hours  = Math.floor(abs / 3600000);
  const days   = Math.floor(abs / 86400000);
  let label;
  if (abs < 60000)         label = `${Math.floor(abs / 1000)}s`;
  else if (hours < 1)      label = `${mins}m`;
  else if (days < 1)       label = `${hours}h ${Math.floor((abs % 3600000) / 60000)}m`;
  else                     label = `${days}d ${Math.floor((abs % 86400000) / 3600000)}h`;
  return past ? `${label} ago` : `in ${label}`;
}

// ── Shared CSS ────────────────────────────────────────────────────────────────

const BASE_CSS = `
  :root {
    --bg:           #f4f6fb;
    --surface:      #ffffff;
    --surface-2:    #f8fafc;
    --border:       #e4e9f0;
    --border-light: #f1f5f9;

    --text:   #0f172a;
    --text-2: #4a5568;
    --text-3: #94a3b8;

    --accent:       #6366f1;
    --accent-dim:   #eef2ff;
    --accent-hover: #4f46e5;

    --green:   #059669; --green-dim:  #d1fae5;
    --red:     #dc2626; --red-dim:    #fee2e2;
    --amber:   #d97706; --amber-dim:  #fef3c7;
    --blue:    #2563eb; --blue-dim:   #dbeafe;
    --purple:  #7c3aed; --purple-dim: #ede9fe;
    --orange:  #ea580c; --orange-dim: #fff7ed;

    --header-bg: #0f172a;
    --r-sm: 6px; --r-md: 10px; --r-lg: 14px;
    --shadow:    0 1px 3px rgba(15,23,42,.06), 0 1px 2px rgba(15,23,42,.04);
    --shadow-md: 0 4px 12px rgba(15,23,42,.07), 0 1px 3px rgba(15,23,42,.04);
    --shadow-lg: 0 20px 48px rgba(15,23,42,.12), 0 4px 12px rgba(15,23,42,.06);
  }

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Inter', 'Segoe UI', sans-serif;
    background: var(--bg);
    color: var(--text);
    font-size: 13.5px;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }

  /* ── Header ─────────────────────────────────────────────────── */
  header {
    background: var(--header-bg);
    color: #fff;
    padding: .85rem 1.75rem;
    display: flex;
    align-items: center;
    gap: .9rem;
    border-bottom: 1px solid rgba(255,255,255,.05);
    position: sticky;
    top: 0;
    z-index: 100;
  }
  header.autonomous-mode {
    background: #c2410c;
    border-bottom-color: rgba(255,255,255,.15);
  }
  /* Ensure all header children stay legible on orange */
  header.autonomous-mode .header-btn {
    color: rgba(255,255,255,.88);
    border-color: rgba(255,255,255,.2);
  }
  header.autonomous-mode .header-btn:hover {
    background: rgba(255,255,255,.14);
    color: #fff;
  }
  header.autonomous-mode .header-btn .alert-dot {
    box-shadow: 0 0 0 1.5px #c2410c;
  }
  header.autonomous-mode .version-badge {
    color: rgba(255,255,255,.7);
    background: rgba(255,255,255,.1);
    border-color: rgba(255,255,255,.2);
  }
  header.autonomous-mode .cortex-brain-badge {
    background: rgba(255,255,255,.12);
    border-color: rgba(255,255,255,.28);
    color: #fff;
  }
  header.autonomous-mode .cortex-brain-badge:hover {
    background: rgba(255,255,255,.2);
    box-shadow: none;
  }
  header.autonomous-mode .hermes-agent-badge {
    background: rgba(255,255,255,.12);
    border-color: rgba(255,255,255,.28);
    color: #fff;
  }
  header.autonomous-mode .hermes-agent-badge:hover {
    background: rgba(255,255,255,.2);
  }
  .autonomous-badge {
    display: flex;
    align-items: center;
    gap: .35rem;
    background: rgba(255,255,255,.15);
    border: 1px solid rgba(255,255,255,.3);
    border-radius: 20px;
    padding: 3px 10px 3px 7px;
    font-size: .72rem;
    font-weight: 700;
    color: #fff;
    letter-spacing: .05em;
    text-transform: uppercase;
    flex-shrink: 0;
  }
  .autonomous-icon {
    display: flex;
    align-items: center;
    animation: autonomous-pulse 2s ease-in-out infinite;
  }
  @keyframes autonomous-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: .65; transform: scale(1.2); }
  }

  header h1 {
    font-size: 1rem;
    font-weight: 700;
    letter-spacing: -.025em;
    display: flex;
    align-items: center;
    gap: .55rem;
    white-space: nowrap;
  }
  .sun-logo {
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
    color: rgba(255,255,255,.35);
    transition: color .5s ease, filter .5s ease;
  }
  .sun-logo.processing {
    color: #fbbf24;
    filter: drop-shadow(0 0 5px rgba(251,191,36,.55));
  }
  .sun-logo.processing svg {
    animation: sun-spin 6s linear infinite;
  }
  @keyframes sun-spin {
    from { transform: rotate(0deg); }
    to   { transform: rotate(360deg); }
  }

  .hermes-agent-badge {
    display: inline-flex; align-items: center; gap: .45rem;
    background: rgba(99,102,241,.1);
    border: 1px solid rgba(99,102,241,.28);
    border-radius: 20px;
    padding: .28rem .7rem .28rem .5rem;
    color: #a5b4fc;
    font-size: .72rem;
    font-weight: 600;
    text-decoration: none;
    white-space: nowrap;
    transition: background .2s, border-color .2s, color .2s;
  }
  .hermes-agent-badge:hover {
    background: rgba(99,102,241,.2);
    border-color: rgba(99,102,241,.5);
    color: #c7d2fe;
  }
  .hermes-pulse-dot {
    width: 7px; height: 7px;
    border-radius: 50%;
    background: #818cf8;
    flex-shrink: 0;
    position: relative;
  }
  .hermes-pulse-dot::after {
    content: '';
    position: absolute;
    inset: -3px;
    border-radius: 50%;
    border: 2px solid #818cf8;
    animation: hermes-ripple 1.8s ease-out infinite;
  }
  @keyframes hermes-ripple {
    0%   { opacity: .75; transform: scale(1); }
    100% { opacity: 0;   transform: scale(2.5); }
  }
  .hermes-agent-badge svg {
    animation: hermes-orbit 7s linear infinite;
    flex-shrink: 0;
  }
  @keyframes hermes-orbit {
    from { transform: rotate(0deg); }
    to   { transform: rotate(360deg); }
  }

  /* ── Cortex brain badge (always-on intelligence layer) ───────── */
  .cortex-brain-badge {
    display: inline-flex; align-items: center; gap: .45rem;
    background: linear-gradient(135deg, rgba(236,72,153,.10), rgba(168,85,247,.10));
    border: 1px solid rgba(236,72,153,.32);
    border-radius: 20px;
    padding: .28rem .75rem .28rem .55rem;
    color: #f0abfc;
    font-size: .72rem;
    font-weight: 600;
    text-decoration: none;
    white-space: nowrap;
    transition: background .2s, border-color .2s, color .2s, box-shadow .2s;
    position: relative;
  }
  .cortex-brain-badge:hover {
    background: linear-gradient(135deg, rgba(236,72,153,.18), rgba(168,85,247,.18));
    border-color: rgba(236,72,153,.55);
    color: #fbcfe8;
    box-shadow: 0 0 12px rgba(236,72,153,.25);
  }
  .cortex-brain-badge svg {
    animation: cortex-spin 5s linear infinite;
    flex-shrink: 0;
    filter: drop-shadow(0 0 4px rgba(236,72,153,.55));
  }
  @keyframes cortex-spin {
    from { transform: rotate(0deg); }
    to   { transform: rotate(360deg); }
  }
  .cortex-brain-badge .cortex-pulse-dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    background: #ec4899;
    box-shadow: 0 0 8px rgba(236,72,153,.85);
    flex-shrink: 0;
    animation: cortex-pulse 1.6s ease-in-out infinite;
  }
  @keyframes cortex-pulse {
    0%, 100% { opacity: .55; transform: scale(.85); }
    50%      { opacity: 1;   transform: scale(1.15); }
  }

  .version-badge {
    background: rgba(255,255,255,.07);
    border: 1px solid rgba(255,255,255,.12);
    color: #64748b;
    font-size: .66rem;
    padding: 2px 8px;
    border-radius: 20px;
    font-weight: 500;
    letter-spacing: .02em;
    white-space: nowrap;
  }

  .meta { font-size: .77rem; color: #475569; flex: 1; }
  .meta span { margin-right: 1rem; }

  .refresh-note {
    display: inline-flex; align-items: center; gap: .4rem;
    background: rgba(245,158,11,.07);
    border: 1px solid rgba(245,158,11,.18);
    border-radius: var(--r-sm);
    padding: .28rem .6rem;
    font-size: .71rem; color: #f59e0b; white-space: nowrap;
  }
  .refresh-select {
    background: transparent; border: none; color: #f59e0b;
    font-size: .71rem; font-family: inherit; cursor: pointer;
    padding: 0; outline: none; appearance: none; -webkit-appearance: none;
  }
  .refresh-select option { background: var(--header-bg); color: #fff; }

  /* ── Nav links ───────────────────────────────────────────────── */
  .settings-link {
    display: inline-flex; align-items: center; gap: .38rem;
    color: #64748b; text-decoration: none;
    font-size: .77rem; font-weight: 500;
    padding: .3rem .65rem;
    border-radius: var(--r-sm);
    border: 1px solid transparent;
    transition: background .15s, color .15s, border-color .15s;
    white-space: nowrap;
  }
  .settings-link:hover {
    background: rgba(255,255,255,.07); color: #cbd5e1;
    border-color: rgba(255,255,255,.1);
  }

  .header-btn {
    display: inline-flex; align-items: center; gap: .38rem;
    color: #64748b; background: none;
    font-size: .77rem; font-weight: 500;
    padding: .3rem .65rem;
    border-radius: var(--r-sm);
    border: 1px solid rgba(255,255,255,.1);
    cursor: pointer;
    transition: background .15s, color .15s;
    white-space: nowrap; font-family: inherit;
    text-decoration: none;
  }
  .header-btn:hover { background: rgba(255,255,255,.07); color: #cbd5e1; }
  .header-btn.icon-only { padding: .3rem .5rem; }
  .header-btn-active { background: rgba(245,158,11,.1); color: #fbbf24; border-color: rgba(245,158,11,.28); }
  .header-btn-active:hover { background: rgba(245,158,11,.16); color: #fcd34d; }
  .header-btn .alert-dot {
    position: absolute; top: 4px; right: 4px;
    width: 7px; height: 7px; border-radius: 50%; background: var(--orange);
    box-shadow: 0 0 0 1.5px var(--header-bg);
  }

  /* ── Dropdown menu ───────────────────────────────────────────── */
  .nav-menu { position: relative; display: inline-flex; }
  .nav-menu-trigger { position: relative; }
  .nav-menu-trigger .chev { transition: transform .15s; opacity: .75; }
  .nav-menu.open .nav-menu-trigger .chev { transform: rotate(180deg); }
  .nav-menu-panel {
    position: absolute; right: 0; top: calc(100% + 8px);
    min-width: 220px; background: #1e293b;
    border: 1px solid rgba(255,255,255,.12);
    border-radius: var(--r-md);
    box-shadow: 0 12px 40px rgba(0,0,0,.45), 0 4px 12px rgba(0,0,0,.25);
    padding: .35rem; display: none; z-index: 200;
  }
  .nav-menu.open .nav-menu-panel { display: block; }
  .nav-menu-item {
    display: flex; align-items: center; gap: .6rem;
    padding: .5rem .65rem; font-size: .78rem; font-weight: 500;
    color: #cbd5e1; text-decoration: none;
    border-radius: var(--r-sm); cursor: pointer;
    background: none; border: none; font-family: inherit;
    width: 100%; text-align: left;
    transition: background .12s, color .12s;
  }
  .nav-menu-item:hover { background: rgba(255,255,255,.07); color: #fff; }
  .nav-menu-item svg { color: #94a3b8; flex-shrink: 0; }
  .nav-menu-item:hover svg { color: #c7d2fe; }
  .nav-menu-item .nav-menu-flag {
    margin-left: auto; background: rgba(234,88,12,.18);
    color: #fb923c; border-radius: 10px;
    padding: 1px 8px; font-size: .65rem; font-weight: 700;
    text-transform: uppercase; letter-spacing: .04em;
  }
  .nav-menu-divider { height: 1px; background: rgba(255,255,255,.08); margin: .35rem .15rem; }

  /* ── Badges ──────────────────────────────────────────────────── */
  .badge {
    padding: 2px 10px; border-radius: 20px;
    font-size: .7rem; font-weight: 600; letter-spacing: .01em;
  }
  .badge-queued      { background: #f1f5f9;           color: #64748b; }
  .badge-running     { background: var(--blue-dim);   color: var(--blue); }
  .badge-success     { background: var(--green-dim);  color: var(--green); }
  .badge-failed      { background: var(--red-dim);    color: var(--red); }
  .badge-interrupted { background: var(--orange-dim); color: var(--orange); }
  .badge-scheduled   { background: var(--purple-dim); color: var(--purple); }
  .badge-retrying    { background: var(--amber-dim);  color: var(--amber); }

  .mode-badge { padding: 2px 8px; border-radius: 20px; font-size: .69rem; font-weight: 600; }
  .mode-dev      { background: var(--blue-dim);   color: var(--blue); }
  .mode-review   { background: var(--purple-dim); color: var(--purple); }
  .mode-estimate { background: var(--amber-dim);  color: var(--amber); }

  /* ── Interrupt banners ───────────────────────────────────────── */
  .interrupt-banner {
    display: flex; align-items: flex-start; gap: .9rem;
    padding: .95rem 1.2rem; border-radius: var(--r-md); border: 1px solid; margin-bottom: 1rem;
  }
  .interrupt-banner-budget_exceeded,
  .interrupt-banner-low_balance { background: #fef2f2; border-color: #fca5a5; color: #991b1b; }
  .interrupt-banner-manual      { background: var(--orange-dim); border-color: #fed7aa; color: #9a3412; }
  .interrupt-banner-server_restart { background: #f0f9ff; border-color: #bae6fd; color: #0c4a6e; }
  .interrupt-banner strong { display: block; font-weight: 600; margin-bottom: .2rem; font-size: .88rem; }
  .interrupt-banner p { margin: 0; font-size: .82rem; line-height: 1.55; }

  /* ── Utilities ───────────────────────────────────────────────── */
  @keyframes spin { to { transform: rotate(360deg); } }
  .spin { animation: spin .9s linear infinite; transform-origin: center; display: block; }

  .footer {
    text-align: center; padding: 1.5rem;
    font-size: .69rem; color: var(--text-3);
    border-top: 1px solid var(--border-light);
    margin-top: 2rem;
  }
`;

// ── Shared script (sun-logo processing indicator) ─────────────────────────────

const BASE_SCRIPT = `
  <script>
    (function () {
      const logo = document.getElementById('sun-logo');
      if (!logo) return;
      function checkBusy() {
        fetch('/dashboard/busy', { cache: 'no-store' })
          .then(r => r.json())
          .then(d => logo.classList.toggle('processing', !!d.busy))
          .catch(() => {});
      }
      checkBusy();
      setInterval(checkBusy, 4000);
    })();
  <\/script>
`;

// ── Icons ─────────────────────────────────────────────────────────────────────

const ICONS = {
  queued:  (n = 18) => `<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
  running: (n = 18) => `<svg class="spin" xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}" viewBox="0 0 24 24" fill="none" stroke="#0d6efd" stroke-width="2.5" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`,
  success: (n = 18) => `<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}" viewBox="0 0 24 24" fill="none" stroke="#198754" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
  failed:       (n = 18) => `<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}" viewBox="0 0 24 24" fill="none" stroke="#dc3545" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`,
  interrupted:  (n = 18) => `<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}" viewBox="0 0 24 24" fill="none" stroke="#ea580c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
  skipped:      (n = 18) => `<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>`,
  scheduled:    (n = 18) => `<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}" viewBox="0 0 24 24" fill="none" stroke="#7e22ce" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><circle cx="12" cy="16" r="2"/></svg>`,
  retrying:     (n = 18) => `<svg xmlns="http://www.w3.org/2000/svg" width="${n}" height="${n}" viewBox="0 0 24 24" fill="none" stroke="#c2410c" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 .49-4.49"/></svg>`,
};

function sessionIconBadge(status) {
  const labels = { queued: 'Queued', running: 'Running', success: 'Done', failed: 'Failed', interrupted: 'Interrupted', scheduled: 'Scheduled', retrying: 'Retrying' };
  return `<span title="${labels[status] || status}" style="display:inline-flex;align-items:center;gap:6px">
    ${(ICONS[status] || ICONS.queued)(18)}<span class="badge badge-${status}">${labels[status] || status}</span>
  </span>`;
}

// Lightweight server-side Markdown → HTML for the output log.
// Handles fenced code blocks, headers, bold/italic, inline code, tables,
// blockquotes, HR, and unordered/ordered lists. Keeps it dependency-free.
function renderMarkdown(raw) {
  let s = raw;

  // Fenced code blocks (``` ... ```) — must come before inline-code pass
  s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const escaped = code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return `<pre><code>${escaped}</code></pre>`;
  });

  // Escape remaining HTML (outside pre blocks) — replace per-segment
  const parts = s.split(/(<pre>[\s\S]*?<\/pre>)/g);
  s = parts.map((p, i) => i % 2 === 1 ? p :
    p.replace(/&(?!amp;|lt;|gt;|quot;)/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  ).join('');

  // Horizontal rule
  s = s.replace(/^[-*]{3,}\s*$/gm, '<hr>');

  // ATX headings
  s = s.replace(/^#{4,6}\s+(.+)$/gm, '<h5>$1</h5>');
  s = s.replace(/^#{3}\s+(.+)$/gm, '<h4>$1</h4>');
  s = s.replace(/^#{2}\s+(.+)$/gm, '<h3>$1</h3>');
  s = s.replace(/^#{1}\s+(.+)$/gm, '<h2>$1</h2>');

  // Tables (simple: | col | col |)
  s = s.replace(/((?:^\|.+\|\s*\n?)+)/gm, tableBlock => {
    const rows = tableBlock.trim().split('\n').filter(r => r.trim());
    const isSep = r => /^\|[-| :]+\|$/.test(r.trim());
    let html = '<table>';
    let headerDone = false;
    for (const row of rows) {
      if (isSep(row)) { headerDone = true; continue; }
      const cells = row.replace(/^\||\|$/g,'').split('|').map(c => c.trim());
      const tag = !headerDone ? 'th' : 'td';
      html += '<tr>' + cells.map(c => `<${tag}>${c}</${tag}>`).join('') + '</tr>';
      if (!headerDone) headerDone = true;
    }
    return html + '</table>';
  });

  // Blockquotes
  s = s.replace(/^&gt;\s?(.*)$/gm, '<blockquote>$1</blockquote>');

  // Unordered lists
  s = s.replace(/((?:^[-*+]\s+.+\n?)+)/gm, block => {
    const items = block.trim().split('\n').map(l => `<li>${l.replace(/^[-*+]\s+/,'')}</li>`).join('');
    return `<ul>${items}</ul>`;
  });

  // Ordered lists
  s = s.replace(/((?:^\d+\.\s+.+\n?)+)/gm, block => {
    const items = block.trim().split('\n').map(l => `<li>${l.replace(/^\d+\.\s+/,'')}</li>`).join('');
    return `<ol>${items}</ol>`;
  });

  // Inline: bold, italic, inline code
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__(.+?)__/g, '<strong>$1</strong>');
  s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
  s = s.replace(/_(.+?)_/g, '<em>$1</em>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Paragraphs — wrap consecutive non-block lines in <p>
  s = s.replace(/^(?!<[a-z]|$)(.+)$/gm, (_, line) => `<p>${line}</p>`);

  return s;
}

function modeBadge(mode) {
  if (mode === 'dev')      return '<span class="mode-badge mode-dev">Dev</span>';
  if (mode === 'review')   return '<span class="mode-badge mode-review">Review</span>';
  if (mode === 'estimate') return '<span class="mode-badge mode-estimate">Estimate</span>';
  return '<span style="color:#ccc;font-size:0.82rem">—</span>';
}

function interruptReasonMessage(reason) {
  switch (reason) {
    case 'budget_exceeded':
      return 'Monthly budget limit reached — the job was stopped automatically to prevent overspend. Increase <code>PRX_MONTHLY_BUDGET</code> in your <code>.env</code> or wait for the next billing cycle.';
    case 'low_balance':
      return 'Anthropic account balance too low — the API returned a billing error mid-run. Top up your account balance or check your subscription to continue.';
    case 'server_restart':
      return 'Server was restarted while this job was running. Re-run the ticket to resume.';
    case 'timeout': {
      const mins = process.env.PRX_JOB_TIMEOUT_MINS || '?';
      return `Job exceeded the ${mins}-minute timeout limit (PRX_JOB_TIMEOUT_MINS). Increase the limit in Settings or optimise the job.`;
    }
    case 'manual':
    default:
      return 'Stopped manually by the user.';
  }
}

function renderSparkline(data, width = 140, height = 36) {
  const nonZero = data.filter(v => v > 0);
  if (nonZero.length < 2) return '<span style="font-size:.72rem;color:#d1d5db">no data</span>';
  const max = Math.max(...data);
  const pts = data.map((v, i) => {
    const x = ((i / (data.length - 1)) * width).toFixed(1);
    const y = (height - (v / max) * (height - 4) - 2).toFixed(1);
    return `${x},${y}`;
  }).join(' ');
  const last = data[data.length - 1];
  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" style="display:block">
    <polyline points="${pts}" fill="none" stroke="#0d6efd" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
    <text x="${width}" y="${height}" text-anchor="end" font-size="9" fill="#9ca3af">$${last.toFixed(2)}</text>
  </svg>`;
}

function interruptBannerIcon(reason) {
  const urgent = reason === 'budget_exceeded' || reason === 'low_balance';
  const color = urgent ? '#dc2626' : reason === 'server_restart' ? '#0369a1' : '#ea580c';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;margin-top:1px">${urgent ? '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>' : '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>'}</svg>`;
}

// ── Token usage cell ──────────────────────────────────────────────────────────

function fmtTokens(n) {
  if (n == null) return '0';
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
}

function tokenCell(usage) {
  if (!usage) return '<span style="color:#ccc">—</span>';
  const { inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, costUsd, actualCostUsd } = usage;

  // Build cost line — prefer codeburn actual cost, fall back to stream-json estimate
  let costHtml = '';
  if (actualCostUsd != null) {
    costHtml = `<div style="display:flex;align-items:center;gap:5px">` +
      `<span style="font-size:.85rem;font-weight:700;color:#1a1a2e">$${actualCostUsd.toFixed(4)}</span>` +
      `<span style="font-size:.66rem;font-weight:600;padding:1px 5px;border-radius:4px;background:#dbeafe;color:#1d4ed8">codeburn</span>` +
      `</div>`;
    if (costUsd != null) {
      costHtml += `<div style="font-size:.72rem;color:#9ca3af">est. $${costUsd.toFixed(4)}</div>`;
    }
  } else if (costUsd != null) {
    costHtml = `<div style="font-size:.85rem;font-weight:700;color:#1a1a2e">$${costUsd.toFixed(4)}</div>`;
  }

  const cacheNote = cacheReadTokens > 0 ? ` · ${fmtTokens(cacheReadTokens)} cached` : '';
  const tooltipParts = [
    `Input: ${inputTokens.toLocaleString()}`,
    `Output: ${outputTokens.toLocaleString()}`,
    cacheReadTokens > 0 ? `Cache read: ${cacheReadTokens.toLocaleString()}` : '',
    actualCostUsd != null ? `codeburn cost: $${actualCostUsd.toFixed(6)}` : '',
    costUsd       != null ? `Stream est.: $${costUsd.toFixed(6)}`         : '',
  ].filter(Boolean).join(' · ');

  const tokensHtml = (inputTokens || outputTokens)
    ? `<div style="font-size:.74rem;color:#6b7280;white-space:nowrap">${fmtTokens(inputTokens)} in · ${fmtTokens(outputTokens)} out${cacheNote}</div>`
    : '';

  return `<div title="${tooltipParts}">${costHtml}${tokensHtml}</div>`;
}

// ── Report cell ───────────────────────────────────────────────────────────────

function reportCell(reportFiles) {
  if (!reportFiles || !reportFiles.length) return '<span style="color:#ccc">—</span>';
  return reportFiles.map(f => {
    const ext = path.extname(f).toUpperCase().replace('.', '');
    const base = path.basename(f);
    const enc = encodeURIComponent(f);
    return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;flex-wrap:wrap">
      <span style="font-family:monospace;font-size:0.78rem;color:#555;word-break:break-all">${base}</span>
      <a href="/dashboard/download?path=${enc}" class="dl-btn" title="Download ${base}">
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        ${ext}
      </a>
    </div>`;
  }).join('');
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

function renderDashboard(stats, budget) {
  const counts = stats.tickets.reduce((acc, t) => { acc[t.status] = (acc[t.status] || 0) + 1; return acc; }, {});
  const b = budget || {};
  const budgetPctColor = !b.available ? '#9ca3af'
    : b.pct == null     ? '#6b7280'
    : b.pct >= 90       ? '#dc2626'
    : b.pct >= 70       ? '#ea580c'
    : '#16a34a';
  const budgetBg = !b.available ? '#f3f4f6'
    : b.pct == null     ? '#f3f4f6'
    : b.pct >= 90       ? '#fee2e2'
    : b.pct >= 70       ? '#fff7ed'
    : '#dcfce7';
  const monthLabel = b.month
    ? new Date(b.month + '-01').toLocaleString('en-GB', { month: 'long', year: 'numeric' })
    : new Date().toLocaleString('en-GB', { month: 'long', year: 'numeric' });

  const rows = stats.tickets.map(t => {
    const isRunning   = t.status === 'running' || t.status === 'queued';
    const isScheduled = t.status === 'scheduled';
    const isRetrying  = t.status === 'retrying';
    const isBlocked   = isRunning || isScheduled || isRetrying;
    const isUrgent    = t.priority === 'urgent';
    const currentMode = t.mode || 'dev';

    const playBtn = `
      <form method="POST" action="/dashboard/ticket/${encodeURIComponent(t.ticketKey)}/run"
            style="display:inline-flex;align-items:center;gap:6px" onsubmit="return confirmRun(this)">
        <select name="mode" class="mode-select" title="Mode">
          <option value="dev"${currentMode === 'dev' ? ' selected' : ''}>Dev</option>
          <option value="review"${currentMode === 'review' ? ' selected' : ''}>Review</option>
          <option value="estimate"${currentMode === 'estimate' ? ' selected' : ''}>Estimate</option>
        </select>
        <button type="submit" class="play-btn" title="Run this ticket" ${isBlocked ? 'disabled' : ''}>
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24"
               fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </button>
      </form>`;

    let statusExtra = '';
    if (isScheduled && t.scheduledFor)
      statusExtra = `<div style="font-size:.72rem;color:#7e22ce;margin-top:3px" title="Fires ${fmtRelative(t.scheduledFor)}">${fmt(t.scheduledFor)}</div>`;
    if (isRetrying && t.nextRetryAt)
      statusExtra = `<div style="font-size:.72rem;color:#c2410c;margin-top:3px">Attempt ${t.retryAttempt}/${t.maxRetries} · ${fmtRelative(t.nextRetryAt)}</div>`;

    const stopConfirmMsg = isScheduled ? `Cancel the scheduled run for ${t.ticketKey}?`
      : isRetrying ? `Cancel the retry for ${t.ticketKey}?` : 'Stop this job?';

    const prioritiseBtnHtml = t.status === 'queued' ? `
        <form method="POST" action="/dashboard/ticket/${encodeURIComponent(t.ticketKey)}/prioritize"
              style="display:inline" title="Move to front of queue">
          <button type="submit" class="pri-btn" title="Prioritise — move to front of queue">
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24"
                 fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="17 11 12 6 7 11"/><polyline points="17 18 12 13 7 18"/>
            </svg>
          </button>
        </form>` : '';

    const priorityBadge = isUrgent
      ? `<span class="priority-badge">↑ Urgent</span>`
      : '';

    return `
    <tr class="${isRunning ? 'row-running' : isScheduled ? 'row-scheduled' : isRetrying ? 'row-retrying' : ''}">
      <td><a href="/dashboard/ticket/${encodeURIComponent(t.ticketKey)}" class="ticket-link">${t.ticketKey}</a>${priorityBadge}</td>
      <td>${modeBadge(t.mode)}</td>
      <td><span class="source-tag ${t.source === 'disk' ? 'source-disk' : ''}">${t.source}</span></td>
      <td>${sessionIconBadge(t.status)}${statusExtra}</td>
      <td style="font-size:0.82rem;color:#555">${fmt(t.queuedAt)}</td>
      <td style="font-size:0.82rem;color:#555">${fmt(t.completedAt)}</td>
      <td style="font-size:0.82rem;color:#555">${dur(t.startedAt, t.completedAt)}</td>
      <td>${tokenCell(t.tokenUsage)}</td>
      <td>${reportCell(t.reportFiles)}</td>
      <td style="display:flex;align-items:center;gap:6px">
        ${playBtn}
        ${prioritiseBtnHtml}
        ${isBlocked ? `
        <form method="POST" action="/dashboard/ticket/${encodeURIComponent(t.ticketKey)}/stop"
              style="display:inline" onsubmit="return confirm('${stopConfirmMsg}')">
          <button type="submit" class="stop-btn" title="${stopConfirmMsg}">
            <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24"
                 fill="currentColor"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
          </button>
        </form>` : ''}
        ${!isRunning ? `
        <form method="POST" action="/dashboard/ticket/${encodeURIComponent(t.ticketKey)}/delete"
              style="display:inline" onsubmit="return confirm('Delete ${t.ticketKey}?\\n\\nAll information about this ticket — session history, logs, and status — will be permanently lost. This cannot be undone.')">
          <button type="submit" class="del-btn" title="Delete this ticket">
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24"
                 fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
              <path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
            </svg>
          </button>
        </form>` : ''}
      </td>
    </tr>`;
  }).join('');

  const emptyRow = `<tr><td colspan="10" style="text-align:center;color:#bbb;padding:2.5rem;font-size:0.9rem">No tickets yet — waiting for Jira events.</td></tr>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Prevoyant Server — Dashboard</title>
  <style>
    ${BASE_CSS}
    /* ── Info strip ────────────────────────────────────────────── */
    .info-strip {
      display: flex; align-items: stretch;
      padding: 0 1.75rem;
      background: var(--surface);
      border-bottom: 1px solid var(--border);
      flex-wrap: wrap;
    }
    .info-item {
      display: flex; align-items: center; gap: .6rem;
      padding: .75rem 1.4rem;
      border-right: 1px solid var(--border-light);
      flex-shrink: 0;
    }
    .info-item:first-child { padding-left: 0; }
    .info-item:last-child  { border-right: none; }
    .info-icon { color: #cbd5e1; flex-shrink: 0; }
    .info-text { display: flex; flex-direction: column; gap: 1px; }
    .info-lbl { font-size: .62rem; color: var(--text-3); text-transform: uppercase; letter-spacing: .09em; font-weight: 700; }
    .info-val { font-size: .8rem; color: var(--text); font-weight: 600; white-space: nowrap; }
    .info-val.muted { color: var(--text-3); font-weight: 500; }
    .info-val.ok    { color: var(--green); }
    .info-val.warn  { color: var(--amber); }

    /* ── Stat cards ─────────────────────────────────────────────── */
    .cards { display: flex; gap: .75rem; padding: 1.25rem 1.75rem 0; flex-wrap: wrap; }
    .card {
      background: var(--surface); border-radius: var(--r-md);
      padding: .85rem 1.15rem; flex: 1; min-width: 96px;
      border: 1px solid var(--border-light);
      display: flex; flex-direction: column; gap: 4px;
      transition: border-color .15s, transform .15s;
    }
    .card:hover { border-color: var(--border); transform: translateY(-1px); }
    .card .num {
      font-size: 1.55rem; font-weight: 700; line-height: 1.05;
      letter-spacing: -.025em; color: var(--text);
      font-variant-numeric: tabular-nums;
    }
    .card .lbl {
      font-size: .66rem; color: var(--text-3);
      text-transform: uppercase; letter-spacing: .08em; font-weight: 600;
    }
    .card.success .num { color: var(--green); }
    .card.failed  .num { color: var(--red); }
    .card.running .num { color: var(--accent); }

    /* ── Section / table ─────────────────────────────────────────── */
    .section { margin: 1.4rem 1.75rem 2rem; }
    .section h2 {
      font-size: .68rem; color: var(--text-3);
      text-transform: uppercase; letter-spacing: .09em; font-weight: 700;
      margin-bottom: .7rem;
    }
    table {
      width: 100%; border-collapse: collapse;
      background: var(--surface); border-radius: var(--r-lg); overflow: hidden;
      box-shadow: var(--shadow); border: 1px solid var(--border-light);
    }
    th {
      background: var(--surface-2); text-align: left;
      padding: .55rem 1rem; font-size: .67rem;
      text-transform: uppercase; letter-spacing: .07em; color: var(--text-3); font-weight: 700;
      border-bottom: 1px solid var(--border);
    }
    td { padding: .7rem 1rem; border-top: 1px solid var(--border-light); vertical-align: middle; }
    tr:hover td { background: #fafbff; }
    tr.row-running   td { background: #f5f7ff; }
    tr.row-scheduled td { background: #faf7ff; }
    tr.row-retrying  td { background: #fffaf5; }

    /* ── Ticket link + tags ──────────────────────────────────────── */
    .ticket-link {
      font-weight: 700; font-size: .92rem; color: var(--text);
      text-decoration: none;
      border-bottom: 2px solid rgba(99,102,241,.25);
      transition: border-color .15s, color .15s;
    }
    .ticket-link:hover { border-bottom-color: var(--accent); color: var(--accent); }
    .source-tag  { font-size: .71rem; color: var(--text-3); background: var(--surface-2); padding: 2px 7px; border-radius: var(--r-sm); border: 1px solid var(--border-light); }
    .source-disk { background: var(--amber-dim); color: #854d0e; border-color: #fde68a; }

    /* ── Action buttons ──────────────────────────────────────────── */
    .dl-btn {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 3px 10px; background: var(--text); color: #fff;
      border-radius: var(--r-sm); font-size: .7rem;
      text-decoration: none; font-weight: 500; transition: background .15s;
    }
    .dl-btn:hover { background: #1e293b; }
    .mode-select {
      font-size: .71rem; padding: 3px 5px;
      border: 1px solid var(--border); border-radius: var(--r-sm);
      background: var(--surface); color: var(--text-2); cursor: pointer;
    }
    .play-btn {
      display: inline-flex; align-items: center; justify-content: center;
      width: 28px; height: 28px;
      background: var(--green); color: #fff; border: none;
      border-radius: var(--r-sm); cursor: pointer; transition: background .15s;
    }
    .play-btn:hover:not([disabled]) { background: #047857; }
    .play-btn[disabled] { background: var(--border); color: var(--text-3); cursor: not-allowed; }
    .stop-btn {
      display: inline-flex; align-items: center; justify-content: center;
      width: 28px; height: 28px;
      background: var(--red); color: #fff; border: none;
      border-radius: var(--r-sm); cursor: pointer; transition: background .15s;
    }
    .stop-btn:hover { background: #b91c1c; }
    .del-btn {
      display: inline-flex; align-items: center; justify-content: center;
      width: 28px; height: 28px;
      background: var(--surface-2); color: var(--text-3); border: none;
      border-radius: var(--r-sm); cursor: pointer; transition: background .15s, color .15s;
    }
    .del-btn:hover { background: var(--red-dim); color: var(--red); }
    .pri-btn {
      display: inline-flex; align-items: center; justify-content: center;
      width: 28px; height: 28px;
      background: var(--amber-dim); color: var(--amber); border: none;
      border-radius: var(--r-sm); cursor: pointer; transition: background .15s;
    }
    .pri-btn:hover { background: #fde68a; }
    .priority-badge {
      display: inline-flex; align-items: center; gap: 3px;
      font-size: .66rem; font-weight: 700;
      color: var(--amber); background: var(--amber-dim);
      border: 1px solid #fde68a; border-radius: 4px;
      padding: 1px 5px; margin-left: 4px; vertical-align: middle;
    }

    /* ── Toast ───────────────────────────────────────────────────── */
    .upd-toast {
      position: fixed; bottom: 1.5rem; right: 1.5rem;
      background: #1e293b; color: #fff;
      padding: .6rem 1.1rem; border-radius: var(--r-md); font-size: .8rem; font-weight: 500;
      box-shadow: var(--shadow-lg); z-index: 1100; display: none;
      align-items: center; gap: .5rem; max-width: 340px;
    }
    .upd-toast.show { display: flex; }
    .upd-toast.ok   { background: #065f46; }
    .upd-toast.fail { background: #7f1d1d; }
    .upd-toast.info { background: #1e40af; }

    /* ── Modals ───────────────────────────────────────────────────── */
    .modal-overlay {
      position: fixed; inset: 0; background: rgba(15,23,42,.5);
      display: none; align-items: center; justify-content: center;
      z-index: 900; padding: 1rem; backdrop-filter: blur(2px);
    }
    .modal-overlay.open { display: flex; }
    .modal {
      background: var(--surface); border-radius: var(--r-lg);
      padding: 1.6rem 1.8rem; width: 100%; max-width: 430px;
      box-shadow: var(--shadow-lg); animation: modalIn .18s ease;
      border: 1px solid var(--border);
    }
    @keyframes modalIn { from { opacity:0; transform:scale(.97) translateY(8px); } to { opacity:1; transform:none; } }
    .modal-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1.3rem; }
    .modal-title  { font-size: .97rem; font-weight: 700; color: var(--text); }
    .modal-close  {
      background: none; border: none; cursor: pointer; color: var(--text-3);
      padding: .25rem; border-radius: var(--r-sm);
      display: flex; align-items: center; transition: color .15s, background .15s;
    }
    .modal-close:hover { color: var(--text); background: var(--surface-2); }
    .modal-field  { display: flex; flex-direction: column; gap: .35rem; margin-bottom: 1rem; }
    .modal-label  { font-size: .78rem; font-weight: 600; color: var(--text-2); }
    .modal-input  {
      padding: .5rem .78rem; border: 1px solid var(--border);
      border-radius: var(--r-md); font-size: .88rem;
      color: var(--text); font-family: inherit; transition: border-color .15s, box-shadow .15s;
      background: var(--surface);
    }
    .modal-input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(99,102,241,.12); }
    .modal-select {
      padding: .5rem .78rem; border: 1px solid var(--border);
      border-radius: var(--r-md); font-size: .88rem;
      color: var(--text); font-family: inherit; background: var(--surface); cursor: pointer;
    }
    .modal-actions { display: flex; gap: .6rem; margin-top: 1.4rem; justify-content: flex-end; }
    .modal-btn-primary {
      padding: .5rem 1.25rem; background: var(--accent); color: #fff; border: none;
      border-radius: var(--r-md); font-size: .85rem; font-weight: 600;
      cursor: pointer; transition: background .15s; font-family: inherit;
    }
    .modal-btn-primary:hover { background: var(--accent-hover); }
    .modal-btn-cancel {
      padding: .5rem 1rem; background: none;
      border: 1px solid var(--border); color: var(--text-2);
      border-radius: var(--r-md); font-size: .85rem; cursor: pointer;
      transition: border-color .15s, color .15s; font-family: inherit;
    }
    .modal-btn-cancel:hover { border-color: #94a3b8; color: var(--text); }
    .info-desc { font-size: .86rem; color: var(--text-2); line-height: 1.65; margin-bottom: 1rem; }
    .info-row   { display:flex; align-items:center; gap:.6rem; font-size:.82rem; color:#374151;
                  padding:.45rem 0; border-top:1px solid #f3f4f6; }
    .info-row svg { flex-shrink:0; color:#9ca3af; }
    .info-row a  { color:#0d6efd; text-decoration:none; font-weight:500; }
    .info-row a:hover { text-decoration:underline; }
    .info-modes { display:flex; gap:.5rem; flex-wrap:wrap; margin:.8rem 0 .4rem; }
    .info-mode-pill { font-size:.76rem; font-weight:600; padding:3px 10px; border-radius:20px; }
  </style>
</head>
<body>
  <header${parseInt(process.env.PRX_CORTEX_AUTONOMY_LEVEL || '0', 10) === 3 ? ' class="autonomous-mode"' : ''}>
    <h1><span class="sun-logo" id="sun-logo"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg></span>Prevoyant Server</h1>
    <span class="version-badge">v${pluginVersion}</span>
    ${parseInt(process.env.PRX_CORTEX_AUTONOMY_LEVEL || '0', 10) === 3 ? `<span class="autonomous-badge" title="Agents can promote observations directly to the KB without human review. Change in Settings → Cortex.">
      <span class="autonomous-icon"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="10" x="3" y="11" rx="2"/><circle cx="12" cy="5" r="2"/><path d="M12 7v4"/><line x1="8" y1="16" x2="8" y2="16"/><line x1="16" y1="16" x2="16" y2="16"/></svg></span>
      Full Autonomy
    </span>` : ''}
    <div class="meta"></div>
    <button type="button" class="header-btn" onclick="openModal('add-ticket-modal')">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      Add Ticket
    </button>
    <button type="button" class="header-btn" onclick="openModal('bulk-add-modal')" title="Queue multiple tickets at once">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
      Bulk Add
    </button>
    <button type="button" id="pause-btn" class="header-btn${isPaused() ? ' header-btn-active' : ''}" onclick="toggleQueuePause()" title="${isPaused() ? 'Resume queue' : 'Pause queue — stop new jobs from starting'}">
      ${isPaused()
        ? `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg> Resume`
        : `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg> Pause Queue`}
    </button>
    ${process.env.PRX_CORTEX_ENABLED === 'Y' ? `<a href="/dashboard/cortex" class="cortex-brain-badge" title="Cortex — always-on intelligence layer (click to view)">
      <span class="cortex-pulse-dot"></span>
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2z"/></svg>
      <span>Cortex</span>
    </a>` : ''}
    ${process.env.PRX_HERMES_ENABLED === 'Y' ? `<a id="dash-hermes-badge" href="/dashboard/hermes-config" class="hermes-agent-badge" title="Hermes — click to manage">
      <span id="dash-hermes-dot" class="hermes-pulse-dot"></span>
      <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
      <span>Hermes</span>
      <span id="dash-hermes-state" style="opacity:.8;font-weight:500;font-size:.72rem;margin-left:.15rem">· starting…</span>
    </a>
    <a id="dash-insights-badge" href="/dashboard/hermes-insights" class="settings-link" title="Hermes KB insights — pending review" style="display:none;background:#fef3c7;border:1px solid #fde68a;color:#92400e;border-radius:8px;padding:3px 9px;font-size:.78rem;font-weight:600;text-decoration:none;align-items:center;gap:.3rem">
      <span style="font-size:.85rem">✎</span>
      <span>Review</span>
      <span id="dash-insights-count" style="background:#fff;border-radius:9px;padding:0 7px;font-size:.7rem">0</span>
    </a>` : ''}
    <div class="nav-menu" id="nav-menu">
      <button type="button" class="header-btn nav-menu-trigger" onclick="toggleNavMenu(event)" aria-haspopup="true" aria-expanded="false" title="Menu">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
        Menu
        <svg class="chev" xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        ${readDiskStatus().pendingCleanup ? `<span class="alert-dot" title="Disk cleanup pending"></span>` : ''}
      </button>
      <div class="nav-menu-panel" role="menu">
        <a href="/dashboard/activity" class="nav-menu-item" role="menuitem">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
          Activity Log
        </a>
        <a href="/dashboard/watch" class="nav-menu-item" role="menuitem">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          Ticket Watcher
        </a>
        <a href="/dashboard/knowledge-builder" class="nav-menu-item" role="menuitem">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/></svg>
          Knowledge Builder
        </a>
        <a href="/dashboard/cortex" class="nav-menu-item" role="menuitem">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2z"/></svg>
          Cortex
          ${process.env.PRX_CORTEX_ENABLED === 'Y' ? `<span class="nav-menu-flag" style="background:rgba(236,72,153,.2);color:#fbcfe8;border-color:rgba(236,72,153,.4)">active</span>` : ''}
        </a>
        <a href="/dashboard/disk" class="nav-menu-item" role="menuitem">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
          Disk Monitor
          ${readDiskStatus().pendingCleanup ? `<span class="nav-menu-flag">cleanup</span>` : ''}
        </a>
      </div>
    </div>
    <a href="/dashboard/settings" class="header-btn icon-only" title="Settings">
      <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
    </a>
    <button type="button" class="header-btn icon-only" id="check-update-btn" title="Check for updates" onclick="checkForUpdates()">
      <svg id="check-update-icon" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="8 17 12 21 16 17"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.88 18.09A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.29"/></svg>
    </button>
    <button type="button" class="header-btn icon-only" title="About Prevoyant" onclick="openModal('info-modal')">
      <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
    </button>
    <div class="refresh-note">
      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
      Refresh every
      <select class="refresh-select" id="refresh-select" onchange="setRefreshInterval(this.value)">
        <option value="5">5s</option>
        <option value="30" selected>30s</option>
        <option value="60">1 min</option>
        <option value="180">3 min</option>
        <option value="300">5 min</option>
        <option value="600">10 min</option>
      </select>
    </div>
  </header>

  ${process.env.PRX_HERMES_ENABLED === 'Y' ? `
  <div id="dash-hermes-strip" style="display:none;background:#f0fdf4;border-bottom:1px solid #bbf7d0;padding:.45rem 1.4rem;font-size:.78rem;color:#166534;align-items:center;gap:.6rem">
    <span id="dash-hermes-strip-dot" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#22c55e;position:relative;flex-shrink:0">
      <span style="position:absolute;inset:-4px;border-radius:50%;border:2px solid #22c55e;animation:hermes-ripple 1.8s ease-out infinite"></span>
    </span>
    <strong>Hermes gateway</strong>
    <span id="dash-hermes-strip-text">listening for events</span>
    <span id="dash-hermes-strip-meta" style="color:#15803d;opacity:.75;margin-left:.35rem"></span>
    <a href="/dashboard/hermes-config" style="margin-left:auto;font-size:.74rem;color:#166534;text-decoration:none;border:1px solid #86efac;padding:2px 9px;border-radius:6px;background:#dcfce7">Manage →</a>
  </div>
  <script>
    (function() {
      const STATE_COLORS = {
        listening: { strip:'#f0fdf4', border:'#bbf7d0', text:'#166534', dot:'#22c55e', mgrBg:'#dcfce7', pulse:true },
        idle:      { strip:'#fef2f2', border:'#fecaca', text:'#991b1b', dot:'#ef4444', mgrBg:'#fee2e2', pulse:false },
        installing:{ strip:'#eff6ff', border:'#bfdbfe', text:'#1e40af', dot:'#3b82f6', mgrBg:'#dbeafe', pulse:true },
        setup:     { strip:'#f9fafb', border:'#e5e7eb', text:'#374151', dot:'#9ca3af', mgrBg:'#f3f4f6', pulse:false },
      };
      const STATE_TEXT = {
        listening: 'listening for events',
        idle:      'stopped — click Manage to start',
        installing:'installing Hermes CLI in background…',
        setup:     'CLI not installed — visit Manage to install',
      };

      function applyStripState(state) {
        const c    = STATE_COLORS[state];
        const strip = document.getElementById('dash-hermes-strip');
        if (!strip || !c) return;
        strip.style.display     = 'flex';
        strip.style.background  = c.strip;
        strip.style.borderColor = c.border;
        strip.style.color       = c.text;
        const dot = document.getElementById('dash-hermes-strip-dot');
        dot.style.background = c.dot;
        dot.firstElementChild.style.borderColor = c.dot;
        dot.firstElementChild.style.display = c.pulse ? '' : 'none';
        document.getElementById('dash-hermes-strip-text').textContent = STATE_TEXT[state];
        const a = strip.querySelector('a');
        a.style.background = c.mgrBg;
        a.style.borderColor = c.border;
        a.style.color = c.text;
      }

      function applyBadgeState(state) {
        const labelMap = { listening:'· Listening', idle:'· Idle', installing:'· Installing', setup:'· Setup' };
        const colorMap = { listening:'#22c55e', idle:'#ef4444', installing:'#3b82f6', setup:'#9ca3af' };
        const titleMap = {
          listening: 'Hermes gateway listening for events',
          idle:      'Hermes gateway stopped — click to manage',
          installing:'Hermes CLI installing in background',
          setup:     'Hermes CLI not installed — click to set up',
        };
        const badge = document.getElementById('dash-hermes-badge');
        if (!badge) return;
        const dot   = document.getElementById('dash-hermes-dot');
        const text  = document.getElementById('dash-hermes-state');
        text.textContent = labelMap[state] || '';
        dot.style.background = colorMap[state] || '#9ca3af';
        // The ripple inherits the dot background via ::after border-color; restyle inline.
        badge.title = titleMap[state] || 'Hermes';
      }

      function refreshHermesStatus() {
        fetch('/dashboard/api/hermes-status').then(r => r.json()).then(s => {
          let state;
          if (s.installing)            state = 'installing';
          else if (!s.installed)       state = 'setup';
          else if (s.gatewayRunning)   state = 'listening';
          else                         state = 'idle';
          applyBadgeState(state);
          applyStripState(state);
        }).catch(() => {});
      }

      function refreshInsightsCount() {
        const badge = document.getElementById('dash-insights-badge');
        if (!badge) return;
        fetch('/dashboard/api/hermes-insights/counts').then(r => r.json()).then(d => {
          if (!d.ok) return;
          const n = (d.counts && d.counts.pending) || 0;
          if (n > 0) {
            badge.style.display = 'inline-flex';
            document.getElementById('dash-insights-count').textContent = n;
          } else {
            badge.style.display = 'none';
          }
        }).catch(() => {});
      }

      refreshHermesStatus();
      refreshInsightsCount();
      setInterval(refreshHermesStatus, 10000);
      setInterval(refreshInsightsCount, 30000);
    })();
  </script>` : ''}

  ${(() => {
    const upd = readUpdateStatus();
    if (!upd.available) return '';
    return `
  <div id="update-banner" style="background:#fffbeb;border-bottom:1px solid #fcd34d;padding:.6rem 1.4rem;display:flex;align-items:center;gap:.8rem;font-size:.875rem;">
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
    <span style="color:#92400e;flex:1">
      <strong>Update available</strong> &mdash; v${upd.latestVersion} is ready (you have v${upd.currentVersion}).
      <a href="https://github.com/dodogeny/prevoyant-claude-plugin/releases" target="_blank" rel="noopener" style="color:#b45309;margin-left:.4rem">View changes</a>
    </span>
    <button onclick="upgradePlugin()" id="upgrade-btn" style="background:#d97706;color:#fff;border:none;border-radius:6px;padding:.35rem .9rem;font-size:.82rem;font-weight:600;cursor:pointer;font-family:inherit">
      Upgrade now
    </button>
    <button onclick="document.getElementById('update-banner').remove()" style="background:none;border:none;color:#9ca3af;cursor:pointer;font-size:1rem;padding:0 .2rem" title="Dismiss">&#x2715;</button>
  </div>
  <script>
    function upgradePlugin() {
      const btn = document.getElementById('upgrade-btn');
      btn.disabled = true;
      btn.textContent = 'Upgrading…';
      fetch('/dashboard/upgrade', { method: 'POST' })
        .then(r => r.json())
        .then(d => {
          if (d.ok) {
            btn.textContent = 'Done — restarting…';
            setTimeout(() => location.reload(), 4000);
          } else {
            btn.textContent = 'Failed';
            btn.style.background = '#dc2626';
            alert('Upgrade failed:\\n' + (d.error || 'Unknown error'));
          }
        })
        .catch(e => {
          btn.textContent = 'Failed';
          btn.style.background = '#dc2626';
          alert('Upgrade error: ' + e.message);
        });
    }
  </script>`;
  })()}

  ${(() => {
    const ps = getPollStatus();
    let pollingVal, pollingClass, startupVal, startupClass;
    if (ps.enabled) {
      const next = ps.nextRunAt ? fmtRelative(ps.nextRunAt) : '—';
      const last = ps.lastRanAt ? fmtRelative(ps.lastRanAt) : 'never';
      pollingVal = `<span title="Last ran: ${last}">Every ${ps.intervalDays}d &middot; next ${next}</span>`;
      pollingClass = 'ok';
    } else {
      pollingVal = 'Disabled';
      pollingClass = 'muted';
    }
    if (ps.enabled && ps.nextRunAt) {
      startupVal = fmtRelative(ps.nextRunAt);
      startupClass = 'ok';
    } else if (!ps.enabled && ps.fallbackRanAt) {
      startupVal = 'No scheduled scan';
      startupClass = 'muted';
    } else {
      startupVal = '—';
      startupClass = 'muted';
    }
    return `
  <div class="info-strip">
    <div class="info-item">
      <svg class="info-icon" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
      <div class="info-text">
        <span class="info-lbl">Uptime</span>
        <span class="info-val">${formatUptime(stats.uptimeSeconds)}</span>
      </div>
    </div>
    <div class="info-item">
      <svg class="info-icon" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
      <div class="info-text">
        <span class="info-lbl">Started</span>
        <span class="info-val">${fmt(stats.serverStartedAt)}</span>
      </div>
    </div>
    <div class="info-item">
      <svg class="info-icon" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
      <div class="info-text">
        <span class="info-lbl">Reports</span>
        <span class="info-val" title="${stats.reportsDir}" style="max-width:260px;overflow:hidden;text-overflow:ellipsis">${stats.reportsDir}</span>
      </div>
    </div>
    <div class="info-item">
      <svg class="info-icon" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
      <div class="info-text">
        <span class="info-lbl">Polling</span>
        <span class="info-val ${pollingClass}">${pollingVal}</span>
      </div>
    </div>
    <div class="info-item">
      <svg class="info-icon" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <div class="info-text">
        <span class="info-lbl">Next Scan</span>
        <span class="info-val ${startupClass}">${startupVal}</span>
      </div>
    </div>
    <div class="info-item" title="${b.available ? `${monthLabel} · $${(b.spent||0).toFixed(4)} · source: ${b.source}` : 'Budget data unavailable'}">
      <svg class="info-icon" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
      <div class="info-text">
        <span class="info-lbl">Budget ${b.month ? '(' + b.month + ')' : ''}</span>
        ${b.available
          ? (b.budget
              ? `<span class="info-val" style="color:${budgetPctColor}">$${(b.remaining||0).toFixed(2)} left</span>
                 <span style="font-size:.7rem;color:#b0b7c3">$${(b.spent||0).toFixed(2)} / $${b.budget.toFixed(2)} &middot; ⚪ calc</span>`
              : `<span class="info-val">$${(b.spent||0).toFixed(2)} spent</span>
                 <span style="font-size:.7rem;color:#b0b7c3">⚪ codeburn calc'd</span>`)
          : `<span class="info-val muted">unavailable</span>`}
      </div>
    </div>
    <div class="info-item" id="cpu-info-item" title="Server process CPU and RAM — updates every 5s">
      <svg class="info-icon" xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>
      <div class="info-text">
        <span class="info-lbl">CPU / RAM</span>
        <span class="info-val" id="cpu-val" style="font-variant-numeric:tabular-nums">—</span>
        <span style="font-size:.7rem;color:#b0b7c3" id="cpu-sub">loading…</span>
      </div>
    </div>
  </div>`;
  })()}

  ${isPaused() ? `<div style="background:#fef3c7;border:1px solid #fcd34d;border-radius:8px;padding:.6rem 1rem;margin-bottom:.75rem;display:flex;align-items:center;gap:.6rem;font-size:.83rem;color:#92400e">
    <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
    <strong>Queue paused</strong> — no new jobs will start until you resume. Running jobs are unaffected.
    <button onclick="toggleQueuePause()" style="margin-left:auto;padding:.25rem .75rem;background:#d97706;color:#fff;border:none;border-radius:5px;font-size:.78rem;cursor:pointer;font-family:inherit">Resume Queue</button>
  </div>` : ''}
  ${(() => {
    const kbState = readKbflowState();
    const pending = kbState.pendingCount || 0;
    const oldestDays = kbState.oldestPendingDays || 0;
    if (!pending || process.env.PRX_KBFLOW_ENABLED !== 'Y') return '';
    const isOverdue = oldestDays >= parseInt(process.env.PRX_KBFLOW_REVIEW_NUDGE_DAYS || '7', 10);
    const bg    = isOverdue ? '#fef2f2' : '#fffbeb';
    const bdr   = isOverdue ? '#fecaca' : '#fde68a';
    const color = isOverdue ? '#991b1b' : '#92400e';
    const icon  = isOverdue
      ? `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`
      : `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;
    return `<div style="background:${bg};border:1px solid ${bdr};border-radius:8px;padding:.6rem 1rem;margin-bottom:.75rem;display:flex;align-items:center;gap:.6rem;font-size:.83rem;color:${color}">
      ${icon}
      <span>${isOverdue ? '<strong>KB review overdue</strong>' : '<strong>KB proposals pending</strong>'} — ${pending} Javed proposal${pending === 1 ? '' : 's'} await${pending === 1 ? 's' : ''} team vote at Step 13j${oldestDays ? ` (oldest: ${oldestDays}d)` : ''}.${isOverdue ? ' Run a dev session and review before starting new tickets.' : ''}</span>
      <a href="/dashboard/knowledge-builder" style="margin-left:auto;padding:.25rem .75rem;background:${color};color:#fff;border:none;border-radius:5px;font-size:.78rem;cursor:pointer;text-decoration:none;white-space:nowrap">Review →</a>
    </div>`;
  })()}
  <div class="cards">
    <div class="card"><div class="num">${stats.tickets.length}</div><div class="lbl">Total</div></div>
    <div class="card running"><div class="num">${counts.running || 0}</div><div class="lbl">Running</div></div>
    <div class="card success"><div class="num">${counts.success || 0}</div><div class="lbl">Succeeded</div></div>
    <div class="card failed"><div class="num">${counts.failed || 0}</div><div class="lbl">Failed</div></div>
    <div class="card"><div class="num">${counts.queued || 0}</div><div class="lbl">Queued</div></div>
    <div class="card" style="min-width:170px;flex:1.2" title="Daily cost from completed jobs — last 30 days">
      <div class="lbl" style="margin-bottom:.35rem">Cost trend — 30d</div>
      ${renderSparkline(activityLog.getChartData().tokenCost.data)}
    </div>
    ${b.available ? `
    <div class="card" style="min-width:240px;flex:2;background:${budgetBg};border:1px solid ${budgetPctColor}22">
      <!-- header row: label + source badge + pct -->
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:.45rem">
        <div>
          <div style="display:flex;align-items:center;gap:.4rem">
            <div class="lbl" style="color:${budgetPctColor};opacity:.8">Claude Budget &mdash; ${monthLabel}</div>
            <span style="font-size:.62rem;font-weight:700;padding:1px 5px;border-radius:4px;background:#f3f4f6;color:#6b7280;white-space:nowrap" title="Calculated from token counts × pricing — may differ from actual billing">codeburn calc'd</span>
          </div>
          <div style="font-size:1.55rem;font-weight:700;color:${budgetPctColor};line-height:1.1;margin-top:3px">
            ${b.budget
              ? `$${(b.remaining||0).toFixed(2)} <span style="font-size:.9rem;font-weight:500;color:${budgetPctColor};opacity:.7">remaining</span>`
              : `$${(b.spent||0).toFixed(2)} <span style="font-size:.9rem;font-weight:500;opacity:.7">spent</span>`}
          </div>
        </div>
        ${b.pct != null ? `<div style="font-size:1.6rem;font-weight:800;color:${budgetPctColor};opacity:.85">${b.pct}%</div>` : ''}
      </div>
      <!-- progress bar -->
      ${b.budget ? `
      <div style="height:6px;border-radius:3px;background:#00000015;overflow:hidden;margin-bottom:.3rem">
        <div style="height:100%;width:${b.pct}%;background:${budgetPctColor};border-radius:3px;transition:width .4s"></div>
      </div>
      <div style="font-size:.72rem;color:${budgetPctColor};opacity:.75;margin-bottom:.45rem">$${(b.spent||0).toFixed(2)} spent of $${b.budget.toFixed(2)} budget</div>` : `
      <div style="font-size:.72rem;color:${budgetPctColor};opacity:.75;margin-bottom:.45rem">Set PRX_MONTHLY_BUDGET in Settings to track remaining</div>`}
      <!-- token breakdown from codeburn -->
      ${b.tokens ? `
      <div style="border-top:1px solid ${budgetPctColor}18;padding-top:.4rem;display:flex;flex-wrap:wrap;gap:.3rem .7rem">
        <span style="font-size:.7rem;color:${budgetPctColor};opacity:.75" title="Input tokens">${fmtTokensK(b.tokens.input)} in</span>
        <span style="font-size:.7rem;color:${budgetPctColor};opacity:.75" title="Cache read tokens">${fmtTokensK(b.tokens.cacheRead)} cached</span>
        <span style="font-size:.7rem;color:${budgetPctColor};opacity:.75" title="Cache creation tokens">${fmtTokensK(b.tokens.cacheCreation)} cache-write</span>
        <span style="font-size:.7rem;color:${budgetPctColor};opacity:.75" title="Output tokens">${fmtTokensK(b.tokens.output)} out</span>
      </div>` : ''}
    </div>` : ''}
  </div>

  <div class="section">
    <h2>Processed Tickets <span style="font-weight:400;color:#aaa;font-size:0.72rem;text-transform:none;letter-spacing:0">(includes reports found in ${stats.reportsDir})</span></h2>
    <table>
      <thead>
        <tr>
          <th>Ticket</th><th>Type</th><th>Source</th><th>Session</th>
          <th>Queued at</th><th>Completed at</th><th>Duration</th><th>Tokens</th><th>Report</th><th>Run</th>
        </tr>
      </thead>
      <tbody>${stats.tickets.length ? rows : emptyRow}</tbody>
    </table>
  </div>

  <div class="footer">Prevoyant Server v${pluginVersion} &mdash; Dashboard &mdash; ${new Date().toLocaleString('en-GB')}</div>

  <!-- Add Ticket Modal -->
  <div class="modal-overlay" id="add-ticket-modal" onclick="overlayClick(event,'add-ticket-modal')">
    <div class="modal">
      <div class="modal-header">
        <span class="modal-title">Add Ticket to Queue</span>
        <button class="modal-close" onclick="closeModal('add-ticket-modal')" title="Close">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="modal-field">
        <label class="modal-label" for="modal-ticket-key">Jira Ticket Key <span style="font-size:.72rem;font-weight:400;color:#9ca3af">— optional, leave blank to analyse evidence directly</span></label>
        <input type="text" id="modal-ticket-key" class="modal-input" placeholder="e.g. IV-1234 (optional)"
               autocomplete="off" spellcheck="false" style="text-transform:uppercase"
               oninput="onTicketKeyInput()"
               onkeydown="if(event.key==='Enter')submitAddTicket()">
      </div>
      <div id="modal-jira-fields">
        <div class="modal-field">
          <label class="modal-label" for="modal-ticket-mode">Mode</label>
          <select id="modal-ticket-mode" class="modal-select">
            <option value="dev">Dev</option>
            <option value="review">Review</option>
            <option value="estimate">Estimate</option>
          </select>
        </div>
        <div class="modal-field" style="flex-direction:row;align-items:center;gap:.6rem">
          <input type="checkbox" id="modal-priority" style="width:15px;height:15px;accent-color:#c2410c;cursor:pointer">
          <label for="modal-priority" class="modal-label" style="cursor:pointer;margin:0">
            Urgent priority <span style="font-size:.72rem;font-weight:400;color:#9ca3af">— moves to front of queue</span>
          </label>
        </div>
        <div class="modal-field" style="flex-direction:row;align-items:flex-start;gap:.6rem">
          <input type="checkbox" id="modal-apply-changes" style="width:15px;height:15px;accent-color:#059669;cursor:pointer;margin-top:3px">
          <label for="modal-apply-changes" class="modal-label" style="cursor:pointer;margin:0;line-height:1.45">
            Apply code changes
            <span style="display:block;font-size:.72rem;font-weight:400;color:#9ca3af;margin-top:2px">
              Create the feature branch and commit the proposed fix. Off by default — runs analysis only (PDF report, no working-tree edits).
            </span>
          </label>
        </div>
        <div class="modal-field">
          <label class="modal-label" for="modal-scheduled-at">Schedule for <span style="font-size:.72rem;font-weight:400;color:#9ca3af">(optional — leave blank to run now)</span></label>
          <input type="datetime-local" id="modal-scheduled-at" class="modal-input" style="color-scheme:light">
          <span id="modal-sched-err" style="font-size:.76rem;color:#dc2626;display:none">Scheduled time must be in the future.</span>
        </div>
      </div>
      <div class="modal-field">
        <label class="modal-label" for="modal-extra-context" style="display:flex;align-items:center;justify-content:space-between">
          <span>Evidence <span id="modal-evidence-label-hint" style="font-size:.72rem;font-weight:400;color:#9ca3af">— optional</span></span>
          <button type="button" id="modal-evidence-toggle" onclick="toggleEvidenceSection()" style="background:none;border:none;cursor:pointer;font-size:.72rem;color:#6b7280;padding:0;text-decoration:underline">show</button>
        </label>
        <div id="modal-evidence-section" style="display:none;margin-top:.4rem">
          <textarea id="modal-extra-context" class="modal-input" rows="4" placeholder="Paste log excerpts, stack traces, or investigation notes here…" style="resize:vertical;font-family:monospace;font-size:.78rem"></textarea>
          <div style="margin-top:.5rem">
            <label class="modal-label" for="modal-evidence-files" style="font-size:.76rem;margin-bottom:.25rem">Attach files</label>
            <input type="file" id="modal-evidence-files" multiple
                   style="font-size:.76rem;color:#374151;cursor:pointer;width:100%"
                   onchange="updateFileList()">
            <div id="modal-file-list" style="margin-top:.3rem;font-size:.73rem;color:#6b7280"></div>
          </div>
          <div style="margin-top:.5rem">
            <label class="modal-label" for="modal-evidence-urls" style="font-size:.76rem;margin-bottom:.25rem">Document URLs <span style="font-weight:400;color:#9ca3af">— one per line, fetched at run time</span></label>
            <textarea id="modal-evidence-urls" class="modal-input" rows="2" placeholder="https://example.com/report.txt&#10;https://paste.site/abc123" style="font-family:monospace;font-size:.78rem;resize:vertical"></textarea>
          </div>
          <span id="modal-file-err" style="font-size:.76rem;color:#dc2626;display:none;margin-top:.25rem"></span>
        </div>
      </div>
      <div id="modal-evidence-only-hint" style="display:none;font-size:.76rem;color:#6b7280;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;padding:.5rem .75rem;margin-top:-.25rem">
        No ticket key — Claude will analyse the evidence directly and produce a free-form findings report.
      </div>
      <div class="modal-actions">
        <button type="button" class="modal-btn-cancel" onclick="closeModal('add-ticket-modal')">Cancel</button>
        <button type="button" class="modal-btn-primary" id="modal-submit-btn" onclick="submitAddTicket()">Add to Queue</button>
      </div>
    </div>
  </div>

  <!-- Bulk Add Modal -->
  <div class="modal-overlay" id="bulk-add-modal" onclick="overlayClick(event,'bulk-add-modal')">
    <div class="modal" style="max-width:480px">
      <div class="modal-header">
        <span class="modal-title">Bulk Add Tickets</span>
        <button class="modal-close" onclick="closeModal('bulk-add-modal')" title="Close">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="modal-field">
        <label class="modal-label" for="bulk-keys">Ticket Keys <span style="font-size:.72rem;font-weight:400;color:#9ca3af">— comma or newline separated, max 20</span></label>
        <textarea id="bulk-keys" class="modal-input" rows="5" placeholder="IV-1234, IV-1235&#10;IV-1236" style="resize:vertical;font-family:monospace"></textarea>
        <span id="bulk-key-err" style="font-size:.76rem;color:#dc2626;display:none"></span>
      </div>
      <div class="modal-field">
        <label class="modal-label" for="bulk-mode">Mode</label>
        <select id="bulk-mode" class="modal-select">
          <option value="dev">Dev</option>
          <option value="review">Review</option>
          <option value="estimate">Estimate</option>
        </select>
      </div>
      <div id="bulk-result" style="font-size:.82rem;color:#166534;background:#dcfce7;border-radius:6px;padding:.5rem .75rem;display:none"></div>
      <div class="modal-actions">
        <button type="button" class="modal-btn-cancel" onclick="closeModal('bulk-add-modal')">Cancel</button>
        <button type="button" class="modal-btn-primary" onclick="submitBulkAdd()">Queue All</button>
      </div>
    </div>
  </div>

  <!-- Info Modal -->
  <div class="modal-overlay" id="info-modal" onclick="overlayClick(event,'info-modal')">
    <div class="modal" style="max-width:460px">
      <div class="modal-header">
        <span class="modal-title">Prevoyant</span>
        <button class="modal-close" onclick="closeModal('info-modal')" title="Close">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <p class="info-desc">${pluginDescription}</p>
      <div class="info-modes">
        <span class="info-mode-pill mode-dev">Dev</span>
        <span class="info-mode-pill mode-review">Review</span>
        <span class="info-mode-pill mode-estimate">Estimate</span>
      </div>
      <div class="info-row">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
        Version <strong>v${pluginVersion}</strong>
      </div>
      <div class="info-row">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22"/></svg>
        <a href="${GITHUB_URL}" target="_blank" rel="noopener">${GITHUB_URL}</a>
      </div>
      <div class="info-row">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
        Author: <strong>${pluginAuthor}</strong>
      </div>
      <div class="modal-actions" style="margin-top:1rem">
        <button type="button" class="modal-btn-cancel" onclick="closeModal('info-modal')">Close</button>
      </div>
    </div>
  </div>

  <div class="modal-overlay" id="update-check-modal" onclick="overlayClick(event,'update-check-modal')">
    <div class="modal" style="max-width:400px">
      <div class="modal-header">
        <span class="modal-title">Update Available</span>
        <button class="modal-close" onclick="closeModal('update-check-modal')" title="Close">
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <p id="update-check-msg" style="font-size:.88rem;color:#4b5563;line-height:1.6;margin-bottom:1.2rem"></p>
      <div class="modal-actions">
        <button type="button" class="modal-btn-cancel" onclick="closeModal('update-check-modal')">Later</button>
        <button type="button" id="update-modal-upgrade-btn" onclick="upgradeFromModal()"
          style="background:#d97706;color:#fff;border:none;border-radius:6px;padding:.4rem 1rem;font-size:.85rem;font-weight:600;cursor:pointer;font-family:inherit">
          Upgrade Now
        </button>
      </div>
    </div>
  </div>

  <div id="upd-toast" class="upd-toast">
    <span id="upd-toast-msg"></span>
  </div>

  <script>
    function confirmRun(form) {
      const key  = form.action.split('/ticket/')[1].split('/run')[0];
      const mode = form.querySelector('select[name=mode]').value;
      return confirm('Run ' + decodeURIComponent(key) + ' in ' + mode + ' mode?');
    }

    // ── Auto-refresh ──────────────────────────────────────────────────────────
    const REFRESH_KEY = 'prv_dashboard_refresh';
    let refreshTimer = null;

    function setRefreshInterval(seconds) {
      const s = parseInt(seconds, 10);
      localStorage.setItem(REFRESH_KEY, s);
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => location.reload(), s * 1000);
    }

    (function initRefresh() {
      const saved = parseInt(localStorage.getItem(REFRESH_KEY) || '30', 10);
      const sel = document.getElementById('refresh-select');
      // Apply saved preference to the dropdown (find closest option)
      if (sel) {
        const opt = [...sel.options].find(o => parseInt(o.value) === saved);
        if (opt) sel.value = opt.value;
      }
      setRefreshInterval(saved);
    })();
    function openModal(id) {
      document.getElementById(id).classList.add('open');
      if (id === 'add-ticket-modal') {
        setTimeout(() => document.getElementById('modal-ticket-key').focus(), 50);
      }
    }
    function closeModal(id) {
      document.getElementById(id).classList.remove('open');
      if (id === 'add-ticket-modal') {
        document.getElementById('modal-ticket-key').value = '';
        document.getElementById('modal-scheduled-at').value = '';
        document.getElementById('modal-priority').checked = false;
        document.getElementById('modal-key-err').style.display = 'none';
        document.getElementById('modal-sched-err').style.display = 'none';
      }
    }
    function overlayClick(e, id) {
      if (e.target === document.getElementById(id)) closeModal(id);
    }
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        ['add-ticket-modal','info-modal','update-check-modal'].forEach(id => {
          if (document.getElementById(id).classList.contains('open')) closeModal(id);
        });
      }
    });
    function showUpdToast(msg, type, duration) {
      const t = document.getElementById('upd-toast');
      document.getElementById('upd-toast-msg').textContent = msg;
      t.className = 'upd-toast show' + (type ? ' ' + type : '');
      clearTimeout(t._tid);
      if (duration !== 0) t._tid = setTimeout(() => t.classList.remove('show'), duration || 3000);
    }
    function toggleNavMenu(e) {
      e && e.stopPropagation();
      const m = document.getElementById('nav-menu');
      if (!m) return;
      m.classList.toggle('open');
      const trigger = m.querySelector('.nav-menu-trigger');
      if (trigger) trigger.setAttribute('aria-expanded', m.classList.contains('open') ? 'true' : 'false');
    }
    document.addEventListener('click', (e) => {
      const m = document.getElementById('nav-menu');
      if (m && m.classList.contains('open') && !m.contains(e.target)) {
        m.classList.remove('open');
        const trigger = m.querySelector('.nav-menu-trigger');
        if (trigger) trigger.setAttribute('aria-expanded', 'false');
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        const m = document.getElementById('nav-menu');
        if (m && m.classList.contains('open')) {
          m.classList.remove('open');
          const trigger = m.querySelector('.nav-menu-trigger');
          if (trigger) trigger.setAttribute('aria-expanded', 'false');
        }
      }
    });
    function checkForUpdates() {
      const btn  = document.getElementById('check-update-btn');
      const icon = document.getElementById('check-update-icon');
      btn.disabled = true;
      icon.classList.add('spin');
      fetch('/dashboard/check-update', { method: 'POST' })
        .then(r => r.json())
        .then(d => {
          btn.disabled = false;
          icon.classList.remove('spin');
          if (!d.ok) { showUpdToast('Check failed: ' + (d.error || 'Unknown error'), 'fail'); return; }
          if (d.available) {
            document.getElementById('update-check-msg').textContent =
              'v' + d.latestVersion + ' is available (you have v' + d.currentVersion + '). Would you like to upgrade now?';
            openModal('update-check-modal');
          } else {
            showUpdToast('Already up to date — v' + d.currentVersion, 'ok');
          }
        })
        .catch(e => {
          btn.disabled = false;
          icon.classList.remove('spin');
          showUpdToast('Check failed: ' + e.message, 'fail');
        });
    }
    function upgradeFromModal() {
      const upgradeBtn = document.getElementById('update-modal-upgrade-btn');
      upgradeBtn.disabled = true;
      upgradeBtn.textContent = 'Upgrading…';
      closeModal('update-check-modal');
      showUpdToast('Upgrading — please wait…', 'info', 0);
      fetch('/dashboard/upgrade', { method: 'POST' })
        .then(r => r.json())
        .then(d => {
          if (d.ok) {
            showUpdToast('Upgraded — restarting in 4s…', 'ok', 0);
            setTimeout(() => location.reload(), 4000);
          } else {
            showUpdToast('Upgrade failed: ' + (d.error || 'Unknown error'), 'fail');
          }
        })
        .catch(e => showUpdToast('Upgrade error: ' + e.message, 'fail'));
    }
    function onTicketKeyInput() {
      const key = document.getElementById('modal-ticket-key').value.trim();
      const evidenceOnly = !key;
      document.getElementById('modal-jira-fields').style.display = evidenceOnly ? 'none' : '';
      document.getElementById('modal-evidence-only-hint').style.display = evidenceOnly ? '' : 'none';
      document.getElementById('modal-evidence-label-hint').textContent = evidenceOnly ? '— required for evidence-only run' : '— optional';
      if (evidenceOnly) openEvidenceSection();
    }

    function openEvidenceSection() {
      const section = document.getElementById('modal-evidence-section');
      const btn = document.getElementById('modal-evidence-toggle');
      section.style.display = '';
      btn.textContent = 'hide';
    }

    function toggleEvidenceSection() {
      const section = document.getElementById('modal-evidence-section');
      const btn = document.getElementById('modal-evidence-toggle');
      const hidden = section.style.display === 'none';
      section.style.display = hidden ? '' : 'none';
      btn.textContent = hidden ? 'hide' : 'show';
    }

    function updateFileList() {
      const input = document.getElementById('modal-evidence-files');
      const listEl = document.getElementById('modal-file-list');
      if (!input.files.length) { listEl.textContent = ''; return; }
      const items = [];
      for (const f of input.files) {
        const kb = (f.size / 1024).toFixed(0);
        const sz = f.size > 1048576 ? (f.size / 1048576).toFixed(1) + ' MB' : kb + ' KB';
        items.push(f.name + ' (' + sz + ')');
      }
      listEl.textContent = items.join(' · ');
    }

    async function readFileAsText(file) {
      return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = e => resolve(e.target.result);
        r.onerror = () => reject(new Error('Failed to read ' + file.name));
        r.readAsText(file);
      });
    }

    async function submitAddTicket() {
      const key = document.getElementById('modal-ticket-key').value.trim().toUpperCase();
      const evidenceOnly = !key;

      const fileErr = document.getElementById('modal-file-err');
      fileErr.style.display = 'none';

      // Evidence-only: must have at least some content
      if (evidenceOnly) {
        const hasText = (document.getElementById('modal-extra-context').value || '').trim();
        const hasFiles = document.getElementById('modal-evidence-files').files.length > 0;
        const hasUrls = (document.getElementById('modal-evidence-urls').value || '').trim();
        if (!hasText && !hasFiles && !hasUrls) {
          fileErr.textContent = 'Please provide at least one of: context text, attached files, or a URL.';
          fileErr.style.display = '';
          openEvidenceSection();
          return;
        }
      }

      const schedEl  = document.getElementById('modal-scheduled-at');
      const schedVal = evidenceOnly ? '' : (schedEl ? schedEl.value : '');
      if (!evidenceOnly && schedVal) {
        const schedErr = document.getElementById('modal-sched-err');
        const schedDate = new Date(schedVal);
        if (isNaN(schedDate) || schedDate <= new Date()) {
          schedErr.style.display = ''; schedEl.focus(); return;
        }
        schedErr.style.display = 'none';
      }

      const attachments = [];
      const fileInput = document.getElementById('modal-evidence-files');
      if (fileInput && fileInput.files.length) {
        for (const f of fileInput.files) {
          try {
            const content = await readFileAsText(f);
            attachments.push({ name: f.name, content });
          } catch (e) {
            fileErr.textContent = 'Could not read ' + f.name + ': ' + e.message;
            fileErr.style.display = '';
            return;
          }
        }
      }

      const urlsRaw = (document.getElementById('modal-evidence-urls').value || '').trim();
      const evidenceUrls = urlsRaw
        ? urlsRaw.split(/\\n|\\r|[\\r\\n]+/).map(u => u.trim()).filter(u => u.startsWith('http'))
        : [];

      const mode         = evidenceOnly ? 'dev' : document.getElementById('modal-ticket-mode').value;
      const priority     = evidenceOnly ? 'normal' : (document.getElementById('modal-priority').checked ? 'urgent' : 'normal');
      const applyChanges = evidenceOnly ? 'N' : (document.getElementById('modal-apply-changes').checked ? 'Y' : 'N');
      const extraContext = (document.getElementById('modal-extra-context').value || '').trim();

      const btn = document.getElementById('modal-submit-btn');
      btn.disabled = true;
      btn.textContent = 'Queuing…';

      const body = { ticketKey: key, mode, priority, applyChanges, extraContext, evidenceOnly };
      if (schedVal) body.scheduledAt = schedVal;
      if (attachments.length) body.attachments = attachments;
      if (evidenceUrls.length) body.evidenceUrls = evidenceUrls;

      try {
        const res = await fetch('/dashboard/queue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (res.ok || res.redirected) {
          location.href = '/dashboard';
        } else {
          btn.disabled = false;
          btn.textContent = 'Add to Queue';
          fileErr.textContent = 'Server error — please try again.';
          fileErr.style.display = '';
        }
      } catch (e) {
        btn.disabled = false;
        btn.textContent = 'Add to Queue';
        fileErr.textContent = 'Request failed: ' + e.message;
        fileErr.style.display = '';
      }
    }

    async function toggleQueuePause() {
      const btn = document.getElementById('pause-btn');
      const paused = btn && btn.classList.contains('header-btn-active');
      try {
        const res = await fetch('/dashboard/queue/' + (paused ? 'resume' : 'pause'), { method: 'POST' });
        if (res.ok) location.reload();
      } catch (_) {}
    }

    async function submitBulkAdd() {
      const raw  = document.getElementById('bulk-keys').value;
      const mode = document.getElementById('bulk-mode').value;
      const err  = document.getElementById('bulk-key-err');
      const result = document.getElementById('bulk-result');
      err.style.display = 'none';
      result.style.display = 'none';

      const keys = [...new Set(raw.split(/[\s,;]+/).map(k => k.trim().toUpperCase()).filter(k => /^[A-Z]+-\d+$/.test(k)))];
      if (keys.length === 0) { err.textContent = 'No valid ticket keys found (expected format: PROJ-123).'; err.style.display = ''; return; }
      if (keys.length > 20) { err.textContent = 'Maximum 20 tickets per bulk run.'; err.style.display = ''; return; }

      try {
        const res  = await fetch('/dashboard/tickets/bulk-run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'keys=' + encodeURIComponent(keys.join(',')) + '&mode=' + encodeURIComponent(mode),
        });
        const data = await res.json();
        result.textContent = data.queued + ' ticket(s) queued' + (data.skipped ? ', ' + data.skipped + ' skipped (already running/queued).' : '.');
        result.style.display = '';
        setTimeout(() => location.reload(), 1500);
      } catch (_) { err.textContent = 'Failed to queue tickets.'; err.style.display = ''; }
    }

    // ── CPU / RAM monitor ──────────────────────────────────────────────────────
    (function() {
      const item = document.getElementById('cpu-info-item');
      const val  = document.getElementById('cpu-val');
      const sub  = document.getElementById('cpu-sub');
      if (!item || !val || !sub) return;

      let alertBanner = null;

      function update() {
        fetch('/dashboard/cpu/stats').then(r => r.json()).then(d => {
          if (!d.ok) return;
          const pct = d.current.toFixed(1);
          val.textContent = pct + '% CPU · ' + d.memMb + ' MB RAM';
          sub.textContent = 'avg ' + d.avg1m + '% · peak ' + d.peak + '% CPU · heap ' + (d.heapUsedMb || '?') + '/' + (d.heapTotalMb || '?') + ' MB';

          const hot  = d.current > d.threshold || d.alert;
          const warm = d.current > d.threshold * 0.7;
          val.style.color = hot ? '#dc2626' : warm ? '#ea580c' : '#16a34a';
          item.style.background = hot ? '#fef2f2' : '';

          if (d.alert && !alertBanner) {
            alertBanner = document.createElement('div');
            alertBanner.id = 'cpu-alert-banner';
            alertBanner.style.cssText = 'background:#fef2f2;border:1px solid #fca5a5;border-radius:8px;padding:.55rem 1rem;margin-bottom:.75rem;display:flex;align-items:center;gap:.6rem;font-size:.83rem;color:#991b1b';
            const msgs = [];
            if (d.alert) msgs.push('CPU is at ' + pct + '% (threshold ' + d.threshold + '%)');
            alertBanner.innerHTML =
              '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#dc2626" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>' +
              '<span><strong>Resource alert</strong> — ' + msgs.join('; ') + '. Check the activity log for runaway jobs.</span>' +
              '<button onclick="this.parentElement.remove()" style="margin-left:auto;padding:.2rem .6rem;background:transparent;border:1px solid #fca5a5;border-radius:4px;font-size:.75rem;cursor:pointer;color:#991b1b">Dismiss</button>';
            const anchor = document.querySelector('.card') || document.querySelector('.info-strip');
            if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(alertBanner, anchor);
          } else if (!d.alert && alertBanner) {
            alertBanner.remove();
            alertBanner = null;
          }
        }).catch(() => {});
      }

      update();
      setInterval(update, 5000);
    })();
  </script>
  ${BASE_SCRIPT}
</body>
</html>`;
}

// ── Activity page ─────────────────────────────────────────────────────────────

const EVENT_DISPLAY = {
  server_started:     { label: 'Server Started',     bg: '#dbeafe', color: '#1d4ed8' },
  webhook_received:   { label: 'Webhook Received',   bg: '#e0f2fe', color: '#0369a1' },
  webhook_skipped:    { label: 'Webhook Skipped',    bg: '#f3f4f6', color: '#6b7280' },
  poll_triggered:     { label: 'Poll Triggered',     bg: '#f3e8ff', color: '#7e22ce' },
  ticket_queued:      { label: 'Queued',             bg: '#f3f4f6', color: '#6b7280' },
  ticket_rerun:       { label: 'Re-run',             bg: '#e0f2fe', color: '#0369a1' },
  ticket_scheduled:   { label: 'Scheduled',          bg: '#f3e8ff', color: '#7e22ce' },
  ticket_started:     { label: 'Started',            bg: '#dbeafe', color: '#1d4ed8' },
  ticket_completed:   { label: 'Completed',          bg: '#dcfce7', color: '#166534' },
  ticket_failed:      { label: 'Failed',             bg: '#fee2e2', color: '#991b1b' },
  ticket_interrupted: { label: 'Interrupted',        bg: '#fff7ed', color: '#9a3412' },
  ticket_retrying:    { label: 'Retrying',           bg: '#fff7ed', color: '#c2410c' },
  ticket_deleted:     { label: 'Deleted',            bg: '#fee2e2', color: '#991b1b' },
  ticket_prioritized: { label: 'Prioritized',        bg: '#e0f2fe', color: '#0369a1' },
  stage_active:       { label: 'Stage Active',       bg: '#eff6ff', color: '#1d4ed8' },
  settings_saved:     { label: 'Settings Saved',     bg: '#f3f4f6', color: '#374151' },
  kb_exported:        { label: 'KB Exported',        bg: '#dcfce7', color: '#166534' },
  kb_imported:        { label: 'KB Imported',        bg: '#dcfce7', color: '#166534' },
  disk_cleanup:       { label: 'Disk Cleanup',       bg: '#fef3c7', color: '#92400e' },
  kbflow_scan_started:   { label: 'KB Flow Scan Started',   bg: '#eff6ff', color: '#1d4ed8' },
  kbflow_scan_completed: { label: 'KB Flow Scan Done',      bg: '#dcfce7', color: '#166534' },
  kbflow_scan_failed:    { label: 'KB Flow Scan Failed',    bg: '#fee2e2', color: '#991b1b' },
  kbflow_review_nudge:   { label: 'KB Review Nudge Sent',   bg: '#fef3c7', color: '#92400e' },
  hermes_enqueue:        { label: 'Hermes Enqueued',        bg: '#ede9fe', color: '#5b21b6' },
  hermes_installing:     { label: 'Hermes Installing',      bg: '#eff6ff', color: '#1d4ed8' },
  hermes_installed:      { label: 'Hermes Installed',       bg: '#dcfce7', color: '#166534' },
  hermes_install_failed: { label: 'Hermes Install Failed',  bg: '#fee2e2', color: '#991b1b' },
  hermes_skill_deployed: { label: 'Hermes Skill Deployed',  bg: '#ede9fe', color: '#5b21b6' },
  hermes_gateway_started:{ label: 'Gateway Started',        bg: '#dcfce7', color: '#166534' },
  hermes_gateway_stopped:{ label: 'Gateway Stopped',        bg: '#f3f4f6', color: '#6b7280' },
  hermes_result_sent:    { label: 'Hermes Result Sent',     bg: '#ede9fe', color: '#5b21b6' },
  hermes_jira_comment:   { label: 'Hermes Jira Comment',    bg: '#fef3c7', color: '#92400e' },
  merge_conflict_warning:  { label: 'Merge Conflict Warning', bg: '#fee2e2', color: '#991b1b' },
  silent_conflict_warning: { label: 'Silent Conflict (co-change)', bg: '#fef3c7', color: '#92400e' },
  stale_branches_scanned:  { label: 'Stale Branches Scan',    bg: '#fef3c7', color: '#92400e' },
  decisions_reviewed:      { label: 'Decisions Reviewed',     bg: '#eff6ff', color: '#1d4ed8' },
  cortex_started:          { label: 'Cortex Started',         bg: '#fdf4ff', color: '#a21caf' },
  cortex_stopped:          { label: 'Cortex Stopped',         bg: '#f3f4f6', color: '#6b7280' },
  cortex_synthesized:      { label: 'Cortex Synthesised',     bg: '#fdf4ff', color: '#a21caf' },
  cortex_referenced:       { label: 'Cortex Referenced',      bg: '#fae8ff', color: '#86198f' },
  cortex_observed:         { label: 'Cortex Observed',        bg: '#f0fdf4', color: '#15803d' },
  cortex_skipped:          { label: 'Cortex Skipped (Reader)', bg: '#f3f4f6', color: '#6b7280' },
  cortex_builder_claimed:  { label: 'Cortex Builder Claimed', bg: '#fdf4ff', color: '#a21caf' },
  repowise_ran:            { label: 'Repowise Ran',           bg: '#fef3c7', color: '#92400e' },
  repowise_install_started:   { label: 'Repowise Install Started',   bg: '#fef3c7', color: '#92400e' },
  repowise_install_completed: { label: 'Repowise Install Done',      bg: '#dcfce7', color: '#166534' },
  repowise_install_failed:    { label: 'Repowise Install Failed',    bg: '#fee2e2', color: '#991b1b' },
  cpu_spike:                  { label: 'CPU Spike',                  bg: '#fee2e2', color: '#991b1b' },
  ram_spike:                  { label: 'RAM Spike',                  bg: '#fff7ed', color: '#9a3412' },
};

const ACTOR_STYLE = {
  system:  { bg: '#f3f4f6', color: '#6b7280' },
  user:    { bg: '#dbeafe', color: '#1d4ed8' },
  jira:    { bg: '#fef3c7', color: '#92400e' },
  webhook: { bg: '#fef3c7', color: '#92400e' },
  manual:  { bg: '#dcfce7', color: '#166534' },
  hermes:  { bg: '#ede9fe', color: '#5b21b6' },
  claude:  { bg: '#fae8ff', color: '#86198f' },
};

function renderActivity(results, chartData, allTypes, allActors, actStats, filters) {
  const { events: evts, total, page, pageSize, totalPages } = results;
  const f = filters || {};

  function eventBadge(type) {
    const m = EVENT_DISPLAY[type] || { label: type, bg: '#f3f4f6', color: '#6b7280' };
    return `<span style="padding:2px 8px;border-radius:8px;font-size:.73rem;font-weight:600;white-space:nowrap;background:${m.bg};color:${m.color}">${m.label}</span>`;
  }

  function actorBadge(actor) {
    const m = ACTOR_STYLE[actor] || { bg: '#f3f4f6', color: '#6b7280' };
    return `<span style="padding:2px 8px;border-radius:8px;font-size:.73rem;font-weight:600;background:${m.bg};color:${m.color}">${esc(actor)}</span>`;
  }

  function fmtDetails(details) {
    if (!details || Object.keys(details).length === 0) return '<span style="color:#d1d5db">—</span>';
    return Object.entries(details)
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => {
        const sv = String(v);
        const display = sv.length > 48 ? sv.slice(0, 48) + '…' : sv;
        return `<span style="font-size:.73rem;color:#9ca3af">${esc(k)}=</span><span style="font-size:.73rem;font-weight:600;color:#374151">${esc(display)}</span>`;
      }).join('  ');
  }

  const rows = evts.map(e => {
    const dt = new Date(e.ts);
    const dateStr = dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    const timeStr = dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const ticketCell = e.ticketKey
      ? `<a href="/dashboard/ticket/${encodeURIComponent(e.ticketKey)}" style="font-weight:700;font-size:.88rem;color:#1a1a2e;text-decoration:none;border-bottom:2px solid #0d6efd44;transition:border-color .15s" onmouseover="this.style.borderBottomColor='#0d6efd'" onmouseout="this.style.borderBottomColor='#0d6efd44'">${esc(e.ticketKey)}</a>`
      : '<span style="color:#d1d5db">—</span>';
    return `<tr>
      <td>
        <div style="font-size:.78rem;font-weight:600;color:#374151;white-space:nowrap">${timeStr}</div>
        <div style="font-size:.7rem;color:#9ca3af">${dateStr}</div>
      </td>
      <td>${eventBadge(e.type)}</td>
      <td>${ticketCell}</td>
      <td>${actorBadge(e.actor)}</td>
      <td style="max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${fmtDetails(e.details)}</td>
    </tr>`;
  }).join('');

  // Always show every defined event type even before it has been observed
  const allKnownTypes = [...new Set([...Object.keys(EVENT_DISPLAY), ...allTypes])].sort();
  const typeOptions = ['', ...allKnownTypes].map(t =>
    `<option value="${esc(t)}"${(f.type || '') === t ? ' selected' : ''}>${t ? ((EVENT_DISPLAY[t] || {}).label || t) : 'All types'}</option>`
  ).join('');

  const actorOptions = ['', ...allActors].map(a =>
    `<option value="${esc(a)}"${(f.actor || '') === a ? ' selected' : ''}>${a || 'All actors'}</option>`
  ).join('');

  function pageUrl(p) {
    const params = new URLSearchParams();
    if (f.type)      params.set('type', f.type);
    if (f.ticketKey) params.set('ticketKey', f.ticketKey);
    if (f.actor)     params.set('actor', f.actor);
    if (f.from)      params.set('from', f.from);
    if (f.to)        params.set('to', f.to);
    if (p > 1)       params.set('page', p);
    const qs = params.toString();
    return '/dashboard/activity' + (qs ? '?' + qs : '');
  }

  const prevPage = page > 1 ? page - 1 : null;
  const nextPage = page < totalPages ? page + 1 : null;
  const paginationHtml = totalPages > 1 ? `
    <div class="act-pager">
      ${prevPage ? `<a href="${pageUrl(prevPage)}" class="pg-btn">‹ Prev</a>` : `<span class="pg-btn pg-off">‹ Prev</span>`}
      <span class="pg-info">Page ${page} of ${totalPages}</span>
      ${nextPage ? `<a href="${pageUrl(nextPage)}" class="pg-btn">Next ›</a>` : `<span class="pg-btn pg-off">Next ›</span>`}
    </div>` : '';

  const hasFilters = f.type || f.ticketKey || f.actor || f.from || f.to;

  const topType = Object.entries(actStats.byType).sort((a, b) => b[1] - a[1])[0];
  const topTypeLabel = topType ? ((EVENT_DISPLAY[topType[0]] || {}).label || topType[0]) : '—';

  const showFrom = evts.length ? (page - 1) * pageSize + 1 : 0;
  const showTo   = (page - 1) * pageSize + evts.length;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Activity Log — Prevoyant Server</title>
  <style>
    ${BASE_CSS}
    .page { max-width: 1400px; margin: 0 auto; padding: 1.5rem 1.75rem 4rem; }
    .breadcrumb { font-size: .78rem; color: #64748b; }
    .breadcrumb a { color: #64748b; text-decoration: none; }
    .breadcrumb a:hover { color: #e2e8f0; }
    .act-stats { display: flex; gap: .85rem; flex-wrap: wrap; margin-bottom: 1.4rem; }
    .act-stat {
      background: var(--surface); border-radius: var(--r-lg);
      padding: .85rem 1.3rem; box-shadow: var(--shadow);
      border: 1px solid var(--border-light);
      display: flex; flex-direction: column; gap: 3px; min-width: 130px;
    }
    .act-stat-lbl { font-size: .62rem; font-weight: 700; text-transform: uppercase; letter-spacing: .09em; color: var(--text-3); }
    .act-stat-val { font-size: 1.5rem; font-weight: 700; color: var(--text); line-height: 1.1; letter-spacing: -.02em; }
    .act-stat-val.small { font-size: .92rem; padding-top: 3px; letter-spacing: 0; }
    .charts-grid { display: grid; grid-template-columns: 2fr 1fr 1fr; gap: .85rem; margin-bottom: 1.4rem; }
    @media(max-width:900px) { .charts-grid { grid-template-columns: 1fr 1fr; } }
    @media(max-width:560px) { .charts-grid { grid-template-columns: 1fr; } }
    .chart-card {
      background: var(--surface); border-radius: var(--r-lg);
      padding: 1.1rem 1.2rem; box-shadow: var(--shadow);
      border: 1px solid var(--border-light);
    }
    .chart-title {
      font-size: .67rem; font-weight: 700; text-transform: uppercase;
      letter-spacing: .08em; color: var(--text-3);
      margin-bottom: .9rem;
      display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: .4rem;
    }
    .period-btns { display: flex; gap: 3px; }
    .period-btn {
      font-size: .66rem; font-weight: 600; padding: 2px 8px;
      border: 1px solid var(--border); border-radius: 5px;
      cursor: pointer; background: var(--surface-2); color: var(--text-3);
      transition: all .12s; font-family: inherit;
    }
    .period-btn.active { background: var(--text); color: #fff; border-color: var(--text); }
    .filter-bar {
      background: var(--surface); border-radius: var(--r-lg);
      padding: .9rem 1.1rem; margin-bottom: .7rem;
      box-shadow: var(--shadow); border: 1px solid var(--border-light);
    }
    .filter-row { display: flex; flex-wrap: wrap; gap: .6rem; align-items: flex-end; }
    .filter-field { display: flex; flex-direction: column; gap: .28rem; }
    .filter-lbl { font-size: .68rem; font-weight: 600; color: var(--text-2); }
    .filter-sel, .filter-inp {
      padding: .36rem .6rem; border: 1px solid var(--border);
      border-radius: var(--r-sm); font-size: .82rem;
      color: var(--text); font-family: inherit; height: 30px;
      background: var(--surface); transition: border-color .15s;
    }
    .filter-sel:focus, .filter-inp:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(99,102,241,.1); }
    .filter-btn {
      padding: .36rem 1rem; background: var(--text); color: #fff; border: none;
      border-radius: var(--r-sm); font-size: .82rem; font-weight: 600;
      cursor: pointer; height: 30px; font-family: inherit; transition: background .15s;
    }
    .filter-btn:hover { background: #1e293b; }
    .filter-clear {
      font-size: .75rem; color: var(--accent); text-decoration: none; font-weight: 600;
      height: 30px; display: inline-flex; align-items: center;
    }
    .filter-clear:hover { color: var(--accent-hover); }
    .results-meta { font-size: .74rem; color: var(--text-3); margin-bottom: .4rem; }
    table {
      width: 100%; border-collapse: collapse;
      background: var(--surface); border-radius: var(--r-lg); overflow: hidden;
      box-shadow: var(--shadow); border: 1px solid var(--border-light);
    }
    th {
      background: var(--surface-2); text-align: left;
      padding: .52rem 1rem; font-size: .66rem;
      text-transform: uppercase; letter-spacing: .07em; color: var(--text-3); font-weight: 700;
      border-bottom: 1px solid var(--border);
    }
    td { padding: .65rem 1rem; border-top: 1px solid var(--border-light); vertical-align: middle; }
    tr:hover td { background: #fafbff; }
    .act-pager { display: flex; align-items: center; gap: .75rem; padding: .85rem 0; }
    .pg-btn {
      padding: .35rem .85rem; background: var(--surface);
      border: 1px solid var(--border); border-radius: var(--r-sm);
      font-size: .8rem; font-weight: 600; text-decoration: none;
      color: var(--text-2); transition: background .12s;
    }
    .pg-btn:hover:not(.pg-off) { background: var(--surface-2); }
    .pg-off { color: var(--border); pointer-events: none; }
    .pg-info { font-size: .76rem; color: var(--text-3); }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
</head>
<body>
  <header>
    <h1><span class="sun-logo" id="sun-logo"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg></span>Prevoyant Server</h1>
    <span class="version-badge">v${pluginVersion}</span>
    <div class="meta">
      <span class="breadcrumb"><a href="/dashboard">Dashboard</a> › Activity Log</span>
    </div>
  </header>

  <div class="page">

    <!-- Stats strip -->
    <div class="act-stats">
      <div class="act-stat">
        <span class="act-stat-lbl">Total Events</span>
        <span class="act-stat-val">${actStats.total.toLocaleString()}</span>
      </div>
      <div class="act-stat">
        <span class="act-stat-lbl">Last 24 h</span>
        <span class="act-stat-val">${actStats.last24h.toLocaleString()}</span>
      </div>
      ${topType ? `<div class="act-stat">
        <span class="act-stat-lbl">Most Common</span>
        <span class="act-stat-val small">${esc(topTypeLabel)}</span>
      </div>` : ''}
      <div class="act-stat">
        <span class="act-stat-lbl">Event Types</span>
        <span class="act-stat-val">${allTypes.length}</span>
      </div>
    </div>

    <!-- Charts -->
    <div class="charts-grid">
      <div class="chart-card">
        <div class="chart-title">
          Activity Over Time
          <div class="period-btns">
            <button class="period-btn active" onclick="setPeriod('hourly',this)">Hourly</button>
            <button class="period-btn"        onclick="setPeriod('daily',this)">Daily</button>
            <button class="period-btn"        onclick="setPeriod('monthly',this)">Monthly</button>
          </div>
        </div>
        <div style="position:relative;height:170px"><canvas id="chart-activity"></canvas></div>
      </div>
      <div class="chart-card">
        <div class="chart-title">
          Tickets Processed
          <span style="font-size:.62rem;color:#b0b7c3;font-weight:400;text-transform:none;letter-spacing:0">30 days</span>
        </div>
        <div style="position:relative;height:170px"><canvas id="chart-tickets"></canvas></div>
      </div>
      <div class="chart-card">
        <div class="chart-title">
          Token Cost (USD)
          <span style="font-size:.62rem;color:#b0b7c3;font-weight:400;text-transform:none;letter-spacing:0">30 days</span>
        </div>
        <div style="position:relative;height:170px"><canvas id="chart-cost"></canvas></div>
      </div>
    </div>

    <!-- Filters -->
    <div class="filter-bar">
      <form method="GET" action="/dashboard/activity">
        <div class="filter-row">
          <div class="filter-field">
            <label class="filter-lbl">Event Type</label>
            <select name="type" class="filter-sel">${typeOptions}</select>
          </div>
          <div class="filter-field">
            <label class="filter-lbl">Ticket Key</label>
            <input type="text" name="ticketKey" value="${esc(f.ticketKey || '')}" placeholder="e.g. IV-123" class="filter-inp" style="width:120px">
          </div>
          <div class="filter-field">
            <label class="filter-lbl">Actor</label>
            <select name="actor" class="filter-sel">${actorOptions}</select>
          </div>
          <div class="filter-field">
            <label class="filter-lbl">From</label>
            <input type="datetime-local" name="from" value="${esc(f.from || '')}" class="filter-inp" style="color-scheme:light">
          </div>
          <div class="filter-field">
            <label class="filter-lbl">To</label>
            <input type="datetime-local" name="to" value="${esc(f.to || '')}" class="filter-inp" style="color-scheme:light">
          </div>
          <button type="submit" class="filter-btn">Apply</button>
          ${hasFilters ? `<a href="/dashboard/activity" class="filter-clear">Clear</a>` : ''}
        </div>
      </form>
    </div>

    <div class="results-meta">Showing ${showFrom}–${showTo} of ${total.toLocaleString()} event${total !== 1 ? 's' : ''}</div>

    <table>
      <thead>
        <tr>
          <th>Timestamp</th>
          <th>Event</th>
          <th>Ticket</th>
          <th>Actor</th>
          <th>Details</th>
        </tr>
      </thead>
      <tbody>
        ${rows || `<tr><td colspan="5" style="text-align:center;color:#bbb;padding:2.5rem;font-size:.88rem">No events found${hasFilters ? ' — try clearing the filters' : ''}.</td></tr>`}
      </tbody>
    </table>

    ${paginationHtml}
  </div>

  <div class="footer">Prevoyant Server v${pluginVersion}</div>

  <script>
    const CD = ${JSON.stringify(chartData)};
    let actChart = null;

    const BAR_STYLE = { backgroundColor: 'rgba(99,102,241,0.72)', borderColor: '#6366f1', borderWidth: 1, borderRadius: 3 };
    const CHART_OPT = (yFmt) => ({
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { mode: 'index' } },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10 }, maxRotation: 40, autoSkip: true, maxTicksLimit: 12 } },
        y: { beginAtZero: true, ticks: { font: { size: 10 }, precision: 0, ...(yFmt ? { callback: yFmt } : {}) } },
      },
    });

    function mkBar(id, labels, data, style) {
      const ctx = document.getElementById(id);
      if (!ctx) return null;
      return new Chart(ctx, { type: 'bar', data: { labels, datasets: [{ label: 'Count', data, ...BAR_STYLE, ...(style||{}) }] }, options: CHART_OPT() });
    }

    function mkLine(id, labels, data, opts) {
      const ctx = document.getElementById(id);
      if (!ctx) return null;
      return new Chart(ctx, {
        type: 'line',
        data: { labels, datasets: [{ label: opts.label || '', data, borderColor: opts.color, backgroundColor: opts.fill,
                                     borderWidth: 2, pointRadius: 2, fill: true, tension: 0.35 }] },
        options: CHART_OPT(opts.yFmt),
      });
    }

    function setPeriod(p, btn) {
      document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      if (actChart) { actChart.data.labels = CD[p].labels; actChart.data.datasets[0].data = CD[p].data; actChart.update(); }
    }

    (function () {
      actChart = mkBar('chart-activity', CD.hourly.labels, CD.hourly.data);
      mkBar('chart-tickets', CD.processed.labels, CD.processed.data,
        { backgroundColor: 'rgba(22,163,74,0.68)', borderColor: '#16a34a' });
      mkLine('chart-cost', CD.tokenCost.labels, CD.tokenCost.data, {
        label: 'USD', color: '#6366f1', fill: 'rgba(99,102,241,0.09)',
        yFmt: v => '$' + v.toFixed(4),
      });
    })();
  </script>
  ${BASE_SCRIPT}
</body>
</html>`;
}

// ── .env helpers ─────────────────────────────────────────────────────────────

const ENV_PATH = path.resolve(__dirname, '../../.env');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function readEnvValues() {
  const v = {};
  try {
    for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m) v[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (_) {}
  return v;
}

function writeEnvValues(updates) {
  let content = '';
  try { content = fs.readFileSync(ENV_PATH, 'utf8'); } catch (_) {}
  const applied = new Set();
  const updated = content.split('\n').map(line => {
    const active = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (active && active[1] in updates) {
      applied.add(active[1]);
      return `${active[1]}=${updates[active[1]]}`;
    }
    const commented = line.match(/^#\s*([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (commented && commented[1] in updates && !applied.has(commented[1]) && updates[commented[1]] !== '') {
      applied.add(commented[1]);
      return `${commented[1]}=${updates[commented[1]]}`;
    }
    return line;
  });
  const extra = Object.entries(updates)
    .filter(([k, v]) => !applied.has(k) && v !== '')
    .map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(ENV_PATH, updated.join('\n') + (extra.length ? '\n' + extra.join('\n') : ''), 'utf8');

  // Keep process.env in sync so in-process reads see the new values immediately.
  for (const [k, v] of Object.entries(updates)) process.env[k] = v;
}

// ── KB helpers ────────────────────────────────────────────────────────────────

function kbDir() {
  return process.env.PRX_KNOWLEDGE_DIR || path.join(os.homedir(), '.prevoyant', 'knowledge-base');
}

function countFilesRecursive(dir) {
  let n = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      try { n += fs.statSync(full).isDirectory() ? countFilesRecursive(full) : 1; } catch (_) {}
    }
  } catch (_) {}
  return n;
}

function countFiles(dir) {
  try { return fs.readdirSync(dir).filter(f => !f.startsWith('.')).length; } catch (_) { return 0; }
}

function basicMemoryHome() {
  if (process.env.BASIC_MEMORY_HOME) return process.env.BASIC_MEMORY_HOME;
  // Default to a location OUTSIDE any KB clone so per-agent personal memory
  // never accidentally rides along with the shared KB git push.
  return path.join(os.homedir(), '.prevoyant', 'personal-memory');
}

function kbStats() {
  const kb        = kbDir();
  const sessions  = path.join(os.homedir(), '.prevoyant', 'sessions');
  const reports   = process.env.CLAUDE_REPORT_DIR || path.join(os.homedir(), '.prevoyant', 'reports');
  const serverDir = path.join(os.homedir(), '.prevoyant', 'server');
  const watchLogs = path.join(os.homedir(), '.prevoyant', 'watch', 'logs');
  const memoryDir = path.join(os.homedir(), '.prevoyant', 'memory');
  // Use the cortex resolver so backup picks the correct path whether the user
  // has PRX_CORTEX_DISTRIBUTED=N (per-machine ~/.prevoyant/cortex/) or
  // =Y (in-KB <KB>/cortex/, which already rides along in the KB tar — so we
  // intentionally skip the standalone cortex add in that case to avoid
  // double-tarring the same files).
  const cortexLayerMod = require('../runner/cortexLayer');
  const cortexDir = cortexLayerMod.cortexDir();
  const cortexInsideKb = cortexDir.startsWith(kb + path.sep) || cortexDir === kb;
  const basicMemDir   = basicMemoryHome();
  const basicMemInsideKb = basicMemDir.startsWith(kb + path.sep) || basicMemDir === kb;
  return {
    kbDir:      kb,
    kbExists:   fs.existsSync(kb),
    kbFiles:    countFilesRecursive(kb),
    sessions,
    sessionFiles: countFiles(sessions),
    reports,
    reportFiles:  countFiles(reports),
    serverDir,
    serverFiles:   countFiles(serverDir),
    watchLogs,
    watchLogFiles: countFilesRecursive(watchLogs),
    memoryDir,
    memoryFiles:   countFilesRecursive(memoryDir),
    cortexDir,
    cortexFiles:   countFilesRecursive(cortexDir),
    cortexInsideKb,
    basicMemDir,
    basicMemInsideKb,
    basicMemFiles: basicMemInsideKb ? 0 : countFilesRecursive(basicMemDir),
  };
}

// ── Disk Monitor page ─────────────────────────────────────────────────────────

function renderDisk(status, diskLog, flash) {
  const wlStats = getWatchLogStats();
  const pendingCleanup  = status.pendingCleanup || false;
  const prevoyantMB     = status.prevoyantMB  || 0;
  const diskUsedPct     = status.diskUsedPct  || 0;
  const diskFree        = status.diskFree     || 0;
  const diskTotal       = status.diskTotal    || 0;
  const lastCleanupAt   = status.lastCleanupAt  ? new Date(status.lastCleanupAt) : null;
  const updatedAt       = status.updatedAt      ? new Date(status.updatedAt)     : null;
  const maxSizeMB         = status.maxSizeMB           || 500;
  const alertPct          = status.alertPct             || 80;
  const alertThresholdMB  = status.alertThresholdMB     || (maxSizeMB * alertPct / 100);
  const cleanupInterval   = status.cleanupIntervalDays  || 7;
  const monitorEnabled  = process.env.PRX_DISK_MONITOR_ENABLED === 'Y';
  const kbProtected     = kbDir();

  // Build chart data from log (last 48 entries for hourly or last 30 for daily)
  const recent = diskLog.slice(-48);
  const chartLabels = recent.map(e => {
    const d = new Date(e.ts);
    return d.toLocaleString('en-GB', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  });
  const chartPrevoyant = recent.map(e => e.prevoyantMB || 0);
  const chartDiskPct   = recent.map(e => e.diskUsedPct || 0);

  const quotaUsedPct = maxSizeMB > 0 ? Math.min(Math.round((prevoyantMB / maxSizeMB) * 100), 100) : 0;
  const quotaColor   = prevoyantMB >= alertThresholdMB ? '#dc2626' : quotaUsedPct >= alertPct * 0.85 ? '#ea580c' : '#6366f1';
  const quotaBg      = prevoyantMB >= alertThresholdMB ? '#fee2e2' : quotaUsedPct >= alertPct * 0.85 ? '#fff7ed' : '#ede9fe';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Disk Monitor — Prevoyant Server</title>
  <style>
    ${BASE_CSS}
    .breadcrumb { font-size: .78rem; color: #64748b; }
    .breadcrumb a { color: #64748b; text-decoration: none; }
    .breadcrumb a:hover { color: #e2e8f0; }
    .page-body { max-width: 1000px; margin: 1.75rem auto; padding: 0 1.75rem; }
    .stat-grid { display: grid; grid-template-columns: repeat(auto-fit,minmax(160px,1fr)); gap: .85rem; margin-bottom: 1.4rem; }
    .stat-card {
      background: var(--surface); border-radius: var(--r-lg);
      padding: 1.1rem 1.3rem; box-shadow: var(--shadow);
      border: 1px solid var(--border-light);
    }
    .stat-lbl { font-size: .62rem; text-transform: uppercase; letter-spacing: .09em; color: var(--text-3); font-weight: 700; margin-bottom: .4rem; }
    .stat-val { font-size: 1.6rem; font-weight: 700; line-height: 1; color: var(--text); letter-spacing: -.025em; }
    .stat-sub { font-size: .73rem; color: var(--text-3); margin-top: .3rem; }
    .section  {
      background: var(--surface); border-radius: var(--r-lg);
      padding: 1.4rem 1.6rem; box-shadow: var(--shadow);
      border: 1px solid var(--border-light); margin-bottom: 1.4rem;
    }
    .section h2 { font-size: .97rem; font-weight: 700; color: var(--text); margin-bottom: 1rem; }
    .progress-bar { height: 10px; border-radius: 20px; background: var(--surface-2); overflow: hidden; margin: .4rem 0; border: 1px solid var(--border-light); }
    .progress-fill { height: 100%; border-radius: 20px; transition: width .4s; }
    .banner {
      display: flex; align-items: flex-start; gap: .7rem;
      padding: .9rem 1.1rem; border-radius: var(--r-md);
      margin-bottom: 1.2rem; font-size: .84rem;
    }
    .banner-warn { background: var(--amber-dim); border: 1px solid #fde68a; color: #92400e; }
    .banner-info { background: var(--blue-dim);  border: 1px solid #bfdbfe; color: #1e3a8a; }
    .banner-ok   { background: var(--green-dim); border: 1px solid #a7f3d0; color: #065f46; }
    .cleanup-form { margin-top: 1rem; }
    .btn-approve {
      background: var(--orange); color: #fff; border: none;
      border-radius: var(--r-sm); padding: .5rem 1.2rem;
      font-size: .83rem; font-weight: 600; cursor: pointer; font-family: inherit; transition: background .15s;
    }
    .btn-approve:hover { background: #c2410c; }
    .btn-dismiss {
      background: var(--surface-2); color: var(--text-2); border: 1px solid var(--border);
      border-radius: var(--r-sm); padding: .5rem 1rem;
      font-size: .83rem; font-weight: 500; cursor: pointer; margin-left: .6rem; font-family: inherit; transition: background .15s;
    }
    .btn-dismiss:hover { background: var(--border); }
    .detail-row {
      display: flex; justify-content: space-between; align-items: center;
      padding: .5rem 0; border-bottom: 1px solid var(--border-light); font-size: .83rem;
    }
    .detail-row:last-child { border-bottom: none; }
    .detail-key { color: var(--text-2); }
    .detail-val { font-weight: 600; color: var(--text); }
    canvas { max-height: 220px; }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
</head>
<body>
  <header>
    <h1><span class="sun-logo" id="sun-logo"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg></span>Prevoyant Server</h1>
    <span class="version-badge">v${pluginVersion}</span>
    <div class="meta">
      <span class="breadcrumb"><a href="/dashboard">Dashboard</a> › Disk Monitor</span>
    </div>
    <a href="/dashboard/settings#disk-monitor" class="settings-link" style="margin-left:auto">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      Settings
    </a>
  </header>

  <div class="page-body">
    ${!monitorEnabled ? `
    <div class="banner banner-info">
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;margin-top:1px"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
      <span>Disk Monitor is <strong>disabled</strong>. Enable it in <a href="/dashboard/settings" style="color:#1e40af">Settings → Disk Monitor</a> to start tracking disk usage automatically.</span>
    </div>` : ''}

    ${pendingCleanup ? `
    <div class="banner banner-warn">
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;margin-top:1px"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
      <div style="flex:1">
        <strong>Scheduled cleanup is due</strong> — house-cleaning will remove old session files and trim server logs under <code style="background:#fed7aa;padding:1px 4px;border-radius:3px">~/.prevoyant/</code>.
        Last cleanup: ${lastCleanupAt ? lastCleanupAt.toLocaleString('en-GB') : 'never'}.
        Cleanup interval: every ${cleanupInterval} day(s).
        <div class="cleanup-form">
          <form method="POST" action="/dashboard/disk/approve-cleanup" onsubmit="return confirm('Run house-cleaning now?\\n\\n• Old session files (>30 days) will be deleted\\n• Server logs will be trimmed\\n• Watch poll logs will be pruned\\n• KB Flow Analyst run logs (>30 days) will be deleted\\n\\nThis cannot be undone.')">
            <button type="submit" class="btn-approve">Approve Cleanup</button>
            <button type="button" class="btn-dismiss" onclick="dismissCleanup()">Dismiss for now</button>
          </form>
        </div>
      </div>
    </div>` : `
    <div class="banner banner-ok">
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;margin-top:1px"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
      <span>No cleanup pending. ${lastCleanupAt ? 'Last cleanup: ' + lastCleanupAt.toLocaleString('en-GB') + '.' : 'No cleanup has been run yet.'} ${cleanupInterval > 0 ? `Next check in ~${cleanupInterval} day(s).` : 'Auto-cleanup is disabled.'}</span>
    </div>`}

    <!-- Stat cards -->
    <div class="stat-grid">
      <div class="stat-card">
        <div class="stat-lbl">.prevoyant Size</div>
        <div class="stat-val" style="color:${quotaColor}">${prevoyantMB.toFixed(1)} <span style="font-size:1rem;font-weight:500;color:#9ca3af">MB</span></div>
        <div class="stat-sub">Quota: ${maxSizeMB} MB (${quotaUsedPct}% used)</div>
      </div>
      <div class="stat-card">
        <div class="stat-lbl">Alert Threshold</div>
        <div class="stat-val" style="color:${quotaColor};font-size:1.3rem">${alertThresholdMB.toFixed(0)} MB</div>
        <div class="stat-sub">${alertPct}% of ${maxSizeMB} MB quota</div>
      </div>
      <div class="stat-card">
        <div class="stat-lbl">Free Disk Space</div>
        <div class="stat-val" style="font-size:1.3rem">${fmtBytes(diskFree)}</div>
        <div class="stat-sub">Disk used: ${diskUsedPct}% of ${fmtBytes(diskTotal)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-lbl">Last Updated</div>
        <div class="stat-val" style="font-size:1rem;font-weight:600">${updatedAt ? updatedAt.toLocaleTimeString('en-GB') : '—'}</div>
        <div class="stat-sub">${updatedAt ? updatedAt.toLocaleDateString('en-GB') : 'No data yet'}</div>
      </div>
      <div class="stat-card">
        <div class="stat-lbl">Watch Logs</div>
        <div class="stat-val" style="font-size:1.3rem">${fmtBytes(wlStats.totalBytes)}</div>
        <div class="stat-sub">${wlStats.fileCount} file${wlStats.fileCount !== 1 ? 's' : ''} · ${wlStats.ticketCount} ticket${wlStats.ticketCount !== 1 ? 's' : ''}</div>
      </div>
    </div>

    <!-- Quota bar -->
    <div class="section">
      <h2>.prevoyant Quota</h2>
      <div style="display:flex;justify-content:space-between;font-size:.8rem;color:#6b7280;margin-bottom:.3rem">
        <span>${prevoyantMB.toFixed(1)} MB used of ${maxSizeMB} MB quota</span>
        <span style="font-weight:700;color:${quotaColor}">${quotaUsedPct}%</span>
      </div>
      <div class="progress-bar">
        <div class="progress-fill" style="width:${quotaUsedPct}%;background:${quotaColor}"></div>
      </div>
      <div style="font-size:.75rem;color:#9ca3af;margin-top:.3rem">Alert fires when <code style="background:#f3f4f6;padding:1px 4px;border-radius:3px">~/.prevoyant/</code> reaches ${alertThresholdMB.toFixed(0)} MB (${alertPct}% of ${maxSizeMB} MB quota)</div>
    </div>

    <!-- Chart -->
    ${diskLog.length > 1 ? `
    <div class="section">
      <h2>Usage Over Time</h2>
      <canvas id="diskChart"></canvas>
    </div>` : `
    <div class="section">
      <div style="text-align:center;color:#9ca3af;padding:2rem;font-size:.9rem">No history yet — data will appear after the first monitor tick.</div>
    </div>`}

    <!-- Detail table -->
    <div class="section">
      <h2>Details</h2>
      <div class="detail-row">
        <span class="detail-key">Monitor status</span>
        <span class="detail-val">${monitorEnabled ? '<span style="color:#16a34a">Enabled</span>' : '<span style="color:#9ca3af">Disabled</span>'}</span>
      </div>
      <div class="detail-row">
        <span class="detail-key">Check interval</span>
        <span class="detail-val">${process.env.PRX_DISK_MONITOR_INTERVAL_MINS || 60} minutes</span>
      </div>
      <div class="detail-row">
        <span class="detail-key">Size quota</span>
        <span class="detail-val">${maxSizeMB} MB</span>
      </div>
      <div class="detail-row">
        <span class="detail-key">Alert threshold</span>
        <span class="detail-val">${alertThresholdMB.toFixed(0)} MB (${alertPct}% of quota)</span>
      </div>
      <div class="detail-row">
        <span class="detail-key">Cleanup interval</span>
        <span class="detail-val">${cleanupInterval > 0 ? `Every ${cleanupInterval} days` : 'Disabled'}</span>
      </div>
      <div class="detail-row">
        <span class="detail-key">Last cleanup</span>
        <span class="detail-val">${lastCleanupAt ? lastCleanupAt.toLocaleString('en-GB') : 'Never'}</span>
      </div>
      <div class="detail-row">
        <span class="detail-key">History entries</span>
        <span class="detail-val">${diskLog.length}</span>
      </div>
      <div class="detail-row">
        <span class="detail-key">Watch log files</span>
        <span class="detail-val">${wlStats.fileCount} files · ${fmtBytes(wlStats.totalBytes)}</span>
      </div>
      <div class="detail-row">
        <span class="detail-key">Watch log retention</span>
        <span class="detail-val">Last ${wlStats.keepPer} per ticket · max ${wlStats.keepDays} days</span>
      </div>
      <div class="detail-row">
        <span class="detail-key">Oldest watch log</span>
        <span class="detail-val">${wlStats.oldestDate ? wlStats.oldestDate.toLocaleString('en-GB') : '—'}</span>
      </div>
    </div>

    <!-- Cleanup controls -->
    <div class="section">
      <h2>House-cleaning</h2>

      ${flash === 'cleaned' ? `
      <div class="banner banner-ok" style="margin-bottom:1rem">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;margin-top:1px"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
        <span>Cleanup completed successfully.</span>
      </div>` : ''}

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin-bottom:1.2rem">
        <!-- Will clean -->
        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:.9rem 1rem">
          <div style="font-size:.75rem;font-weight:700;color:#166534;text-transform:uppercase;letter-spacing:.07em;margin-bottom:.6rem">Will clean</div>
          <ul style="list-style:none;font-size:.83rem;color:#15803d;line-height:1.7">
            <li>✓ Session directories older than 30 days<br><span style="font-size:.75rem;color:#4ade80;opacity:.8">~/.prevoyant/sessions/</span></li>
            <li>✓ Trim disk history log to last 200 entries<br><span style="font-size:.75rem;color:#4ade80;opacity:.8">~/.prevoyant/server/disk-log.json</span></li>
            <li>✓ Trim activity log to last 2 000 entries<br><span style="font-size:.75rem;color:#4ade80;opacity:.8">~/.prevoyant/server/activity-log.json</span></li>
            <li>✓ Watch poll logs older than ${wlStats.keepDays} days &amp; beyond last ${wlStats.keepPer} per ticket<br><span style="font-size:.75rem;color:#4ade80;opacity:.8">~/.prevoyant/watch/logs/</span></li>
            <li>✓ KB Flow Analyst run logs older than 30 days<br><span style="font-size:.75rem;color:#4ade80;opacity:.8">~/.prevoyant/kbflow/logs/</span></li>
          </ul>
        </div>
        <!-- Protected -->
        <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:.9rem 1rem">
          <div style="font-size:.75rem;font-weight:700;color:#991b1b;text-transform:uppercase;letter-spacing:.07em;margin-bottom:.6rem">Never touched</div>
          <ul style="list-style:none;font-size:.83rem;color:#b91c1c;line-height:1.7">
            <li>✗ Knowledge base files<br><span style="font-size:.75rem;color:#f87171;opacity:.9;word-break:break-all">${kbProtected}</span></li>
            <li>✗ Reports</li>
            <li>✗ .env configuration</li>
            <li>✗ Sessions younger than 30 days</li>
          </ul>
        </div>
      </div>

      <form method="POST" action="/dashboard/disk/approve-cleanup"
            onsubmit="return confirm('Run immediate house-cleaning?\\n\\n✓ Deletes session directories older than 30 days\\n✓ Trims disk history and activity logs\\n✓ Trims watch poll logs (>${wlStats.keepDays}d or beyond last ${wlStats.keepPer} per ticket)\\n✓ Deletes KB Flow Analyst run logs older than 30 days\\n\\n✗ Will NOT touch knowledge base, reports, or .env\\n\\nThis cannot be undone.')">
        <button type="submit" class="btn-approve">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:5px"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
          Run Cleanup Now
        </button>
        <span style="font-size:.78rem;color:#9ca3af;margin-left:.8rem">Safe to run at any time — KB files are never affected.</span>
      </form>
    </div>
  </div>

  <div class="footer">Prevoyant Server &mdash; Disk Monitor</div>

  <script>
    ${diskLog.length > 1 ? `
    const ctx = document.getElementById('diskChart').getContext('2d');
    new Chart(ctx, {
      type: 'line',
      data: {
        labels: ${JSON.stringify(chartLabels)},
        datasets: [
          {
            label: '.prevoyant (MB)',
            data: ${JSON.stringify(chartPrevoyant)},
            borderColor: '#6366f1', backgroundColor: '#6366f133',
            tension: 0.3, fill: true, yAxisID: 'yMB',
          },
          {
            label: 'Disk Used (%)',
            data: ${JSON.stringify(chartDiskPct)},
            borderColor: '#f59e0b', backgroundColor: 'transparent',
            tension: 0.3, fill: false, yAxisID: 'yPct', borderDash: [4,3],
          },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: true,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { position: 'top' } },
        scales: {
          x:    { ticks: { maxTicksLimit: 8, font: { size: 11 } } },
          yMB:  { type: 'linear', position: 'left',  title: { display: true, text: 'MB' }, beginAtZero: true },
          yPct: { type: 'linear', position: 'right', title: { display: true, text: '%' }, beginAtZero: true, max: 100, grid: { drawOnChartArea: false } },
        },
      },
    });` : ''}

    function dismissCleanup() {
      fetch('/dashboard/disk/dismiss-cleanup', { method: 'POST' })
        .then(() => location.reload());
    }
  </script>
  ${BASE_SCRIPT}
</body>
</html>`;
}

// ── Cortex page ───────────────────────────────────────────────────────────────
// Always-on intelligence layer.  Renders the synthesized fact files + state
// so a developer (or anyone reviewing how the AI is "thinking") can see every
// piece of knowledge the system has accumulated, in one place.

// ── Cortex render helpers — shared between landing and detail pages ──────────

function _cortexFmtTs(ms) {
  if (!ms) return '—';
  return new Date(ms).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}
function _cortexFmtBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
function _cortexAgoStr(ms) {
  if (!ms) return 'never';
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.round(s/60)}m ago`;
  if (s < 86400) return `${Math.round(s/3600)}h ago`;
  return `${Math.round(s/86400)}d ago`;
}
function _slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60);
}
// Lightweight markdown renderer used by both pages.  Headings get anchor IDs
// so the detail-page TOC can scroll-link to them.  Auto-generated HTML
// comments from cortexWorker are stripped.
function _cortexMd(text) {
  return esc(text)
    .replace(/^# (.+)$/gm,   (_, h) => `<h2 class="cortex-h2" id="${_slugify(h)}">${h}</h2>`)
    .replace(/^## (.+)$/gm,  (_, h) => `<h3 class="cortex-h3" id="${_slugify(h)}">${h}</h3>`)
    .replace(/^### (.+)$/gm, (_, h) => `<h4 class="cortex-h4" id="${_slugify(h)}">${h}</h4>`)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/(<li>.*<\/li>\n?)+/g, m => '<ul>' + m + '</ul>')
    .replace(/&lt;!--[\s\S]*?--&gt;/g, '');
}
// Extract H2 headings from a fact body for preview/TOC.
function _cortexHeadings(body) {
  if (!body) return [];
  const out = [];
  const lines = body.split('\n');
  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2) { out.push({ level: 2, text: h2[1], slug: _slugify(h2[1]) }); continue; }
    const h3 = line.match(/^###\s+(.+?)\s*$/);
    if (h3) { out.push({ level: 3, text: h3[1], slug: _slugify(h3[1]) }); }
  }
  return out;
}

// CSS shared between cortex landing and detail pages — extracted so both stay
// visually consistent.
const _CORTEX_CSS = `
  .breadcrumb { font-size: .78rem; color: #64748b; margin-bottom: .85rem; }
  .breadcrumb a { color: #64748b; text-decoration: none; }
  .breadcrumb a:hover { color: #e2e8f0; }
  .breadcrumb-here { color: #e2e8f0; font-weight: 600; }

  .pill { display: inline-block; font-size: .68rem; font-weight: 700; padding: 2px 8px; border-radius: 12px; }
  .pill-on   { background: #dcfce7; color: #166534; }
  .pill-off  { background: #f3f4f6; color: #6b7280; }
  .pill-warn { background: #fef3c7; color: #92400e; }

  .btn-cortex {
    font-size: .82rem; font-weight: 600;
    padding: .5rem 1.05rem; border-radius: var(--r-sm);
    border: 1px solid rgba(236,72,153,.4);
    background: rgba(236,72,153,.08);
    color: #db2777; cursor: pointer;
    font-family: inherit; transition: background .15s;
  }
  .btn-cortex:hover { background: rgba(236,72,153,.16); }
  .btn-cortex:disabled { opacity:.5; cursor:not-allowed; }

  /* Markdown rendering shared by both pages */
  .cortex-h2 { font-size: 1.15rem; font-weight: 700; color: var(--text); margin-bottom: 1rem; letter-spacing: -.015em; scroll-margin-top: 80px; }
  .cortex-h3 { font-size: .95rem; font-weight: 700; color: var(--text); margin: 1.1rem 0 .55rem; padding-top: .8rem; border-top: 1px solid var(--border-light); scroll-margin-top: 80px; }
  .cortex-h3:first-of-type { border-top: none; padding-top: 0; }
  .cortex-h4 { font-size: .85rem; font-weight: 700; color: var(--text-2); margin: .9rem 0 .4rem; scroll-margin-top: 80px; }
  .md-body ul { margin: .5rem 0 .9rem; padding-left: 1.3rem; }
  .md-body li { font-size: .85rem; color: var(--text-2); margin: .2rem 0; line-height: 1.5; }
  .md-body code { background: var(--surface-2); padding: 1px 6px; border-radius: 4px; font-size: .8rem; color: #db2777; }
  .md-body strong { color: var(--text); }

  @keyframes cortex-spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }
`;

function renderCortex() {
  const cortex = require('../runner/cortexLayer');
  const enabled   = cortex.isEnabled();
  const stats     = cortex.cortexStats();
  const state     = cortex.loadState();
  const facts     = cortex.listFactFiles();
  const repowiseOn  = process.env.PRX_REPOWISE_ENABLED === 'Y';
  const distributed = cortex.isDistributed();

  // Build a *preview* per fact file — just enough metadata to render a card.
  // We do NOT read full bodies here; the landing page must stay light no
  // matter how big the KB grows.  Full content lives at /dashboard/cortex/facts/:id.
  const fs = require('fs');
  const factCards = facts.map(f => {
    let bytes = 0, mtimeMs = 0, headings = [];
    try {
      const st = fs.statSync(f.path);
      bytes = st.size;
      mtimeMs = st.mtimeMs;
      // Only read for heading extraction — bounded since fact files are small
      // (synthesiser caps them at a few KB).  If they ever grew large we'd
      // switch to a streamed parse, but headings live near the top so even
      // then we could read just the first 8KB.
      const body = fs.readFileSync(f.path, 'utf8');
      headings = _cortexHeadings(body);
    } catch (_) {}
    return { ...f, bytes, mtimeMs, headings, sectionCount: headings.filter(h => h.level === 2).length };
  });

  const fmtTs    = _cortexFmtTs;
  const fmtBytes = _cortexFmtBytes;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Cortex — Prevoyant Server</title>
  <style>
    ${BASE_CSS}
    ${_CORTEX_CSS}
    .page-body { max-width: 1100px; margin: 1.75rem auto; padding: 0 1.75rem; }

    /* Compact hero — no longer the focus of the page, just a header */
    .cortex-hero {
      background: linear-gradient(135deg, rgba(236,72,153,.08), rgba(168,85,247,.08));
      border: 1px solid rgba(236,72,153,.22);
      border-radius: var(--r-lg);
      padding: 1.1rem 1.4rem;
      margin-bottom: 1.2rem;
      display: flex; align-items: center; gap: 1rem;
    }
    .cortex-hero-brain {
      width: 40px; height: 40px;
      color: #ec4899;
      animation: cortex-spin 5s linear infinite;
      filter: drop-shadow(0 0 8px rgba(236,72,153,.55));
      flex-shrink: 0;
    }
    .cortex-hero h1 {
      font-size: 1.15rem; font-weight: 800;
      color: var(--text); margin: 0 0 .15rem;
      letter-spacing: -.02em;
    }
    .cortex-hero .sub {
      font-size: .82rem; color: var(--text-2);
      max-width: 760px; line-height: 1.4;
    }

    .stat-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit,minmax(170px,1fr));
      gap: .7rem; margin-bottom: 1.2rem;
    }
    .stat-card {
      background: var(--surface); border-radius: var(--r-lg);
      padding: .9rem 1.1rem; box-shadow: var(--shadow);
      border: 1px solid var(--border-light);
    }
    .stat-lbl { font-size: .6rem; text-transform: uppercase; letter-spacing: .09em; color: var(--text-3); font-weight: 700; margin-bottom: .35rem; }
    .stat-val { font-size: 1.25rem; font-weight: 700; color: var(--text); line-height: 1; letter-spacing: -.02em; }
    .stat-sub { font-size: .7rem; color: var(--text-3); margin-top: .3rem; }

    .actions { display: flex; gap: .5rem; margin: 0 0 1rem; flex-wrap: wrap; align-items: center; }
    .actions .search-wrap { flex: 1; min-width: 200px; margin-left: auto; position: relative; }
    .actions input.fact-search {
      width: 100%; padding: .5rem .85rem .5rem 2rem;
      font-size: .85rem; font-family: inherit;
      border: 1px solid var(--border); border-radius: var(--r-sm);
      background: var(--surface); color: var(--text);
    }
    .actions input.fact-search:focus { outline: none; border-color: rgba(236,72,153,.55); box-shadow: 0 0 0 3px rgba(236,72,153,.12); }
    .actions .search-wrap::before {
      content: '⌕'; position: absolute; left: .65rem; top: 50%;
      transform: translateY(-50%); color: var(--text-3); font-size: .9rem;
      pointer-events: none;
    }

    /* Card grid — the main content */
    .fact-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(290px, 1fr));
      gap: .9rem;
    }
    .fact-card {
      background: var(--surface);
      border: 1px solid var(--border-light);
      border-radius: var(--r-lg);
      padding: 1.05rem 1.2rem 1rem;
      box-shadow: var(--shadow);
      transition: border-color .15s, transform .15s, box-shadow .15s;
      display: flex; flex-direction: column;
      position: relative;
      min-height: 200px;
    }
    .fact-card.has-content:hover {
      border-color: rgba(236,72,153,.42);
      transform: translateY(-1px);
      box-shadow: 0 4px 14px rgba(0,0,0,0.06);
    }
    .fact-card.empty { opacity: .55; }
    .fact-card-header {
      display: flex; align-items: flex-start; gap: .55rem;
      margin-bottom: .5rem;
    }
    .fact-card-icon { font-size: 1.25rem; line-height: 1; flex-shrink: 0; }
    .fact-card-title {
      font-size: .98rem; font-weight: 700; color: var(--text);
      margin: 0; letter-spacing: -.01em; line-height: 1.2;
    }
    .fact-card-meta {
      display: flex; flex-wrap: wrap; gap: .4rem .8rem;
      font-size: .68rem; color: var(--text-3);
      margin-bottom: .65rem;
    }
    .fact-card-meta b { color: var(--text-2); font-weight: 600; }
    .fact-card-preview {
      flex: 1;
      font-size: .76rem; color: var(--text-2);
      line-height: 1.45;
      margin-bottom: .7rem;
    }
    .fact-card-preview ul { list-style: none; margin: 0; padding: 0; }
    .fact-card-preview li {
      padding: 3px 0 3px 14px;
      position: relative;
      border-bottom: 1px dashed var(--border-light);
    }
    .fact-card-preview li:last-child { border-bottom: none; }
    .fact-card-preview li::before {
      content: '›'; position: absolute; left: 0;
      color: rgba(236,72,153,.5); font-weight: 700;
    }
    .fact-card-preview li.more {
      color: var(--text-3); font-style: italic;
      padding-left: 14px;
    }
    .fact-card-preview li.more::before { content: '+'; }
    .fact-card-empty {
      flex: 1;
      font-size: .8rem; color: var(--text-3);
      font-style: italic;
      background: var(--surface-2);
      padding: .65rem .8rem;
      border-radius: var(--r-sm);
      margin-bottom: .65rem;
    }
    .fact-card-footer {
      display: flex; justify-content: space-between; align-items: center;
      padding-top: .55rem;
      border-top: 1px solid var(--border-light);
    }
    .fact-card-open {
      font-size: .76rem; font-weight: 700;
      color: #db2777; text-decoration: none;
      padding: 4px 10px; border-radius: 12px;
      background: rgba(236,72,153,.08);
      border: 1px solid rgba(236,72,153,.25);
      transition: background .15s, border-color .15s;
    }
    .fact-card-open:hover { background: rgba(236,72,153,.18); border-color: rgba(236,72,153,.5); }
    .fact-card-status {
      font-size: .65rem; font-weight: 700;
      text-transform: uppercase; letter-spacing: .06em;
    }
    .fact-card-status.fresh { color: #16a34a; }
    .fact-card-status.stale { color: #ea580c; }
    .fact-card-status.missing { color: var(--text-3); }

    .empty-message {
      grid-column: 1 / -1;
      text-align: center;
      padding: 2rem;
      color: var(--text-3);
      font-style: italic;
    }
  </style>
</head>
<body>
  <header>
    <h1><span class="sun-logo"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/></svg></span>Cortex</h1>
    <div class="meta"></div>
    <a href="/dashboard" class="header-btn">← Dashboard</a>
  </header>

  <div class="page-body">
    <div class="breadcrumb">
      <a href="/dashboard">Dashboard</a> &nbsp;›&nbsp;
      <span class="breadcrumb-here">Cortex</span>
    </div>

    <div class="cortex-hero">
      <svg class="cortex-hero-brain" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2z"/>
        <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2z"/>
      </svg>
      <div>
        <h1>Always-on Intelligence Layer</h1>
        <div class="sub">
          Curated facts synthesised from the KB${repowiseOn ? ' + repowise' : ''}.
          Agents read these in Step 0 of the dev skill —
          ${enabled ? '<strong style="color:#16a34a">active.</strong>' : '<strong style="color:#ea580c">inactive — enable in Settings.</strong>'}
        </div>
      </div>
    </div>

    <div class="stat-grid">
      <div class="stat-card">
        <div class="stat-lbl">Status</div>
        <div class="stat-val">${enabled ? '<span class="pill pill-on">ACTIVE</span>' : '<span class="pill pill-off">INACTIVE</span>'}</div>
        <div class="stat-sub">PRX_CORTEX_ENABLED</div>
      </div>
      <div class="stat-card">
        <div class="stat-lbl">Fact files</div>
        <div class="stat-val">${stats.factCount} / ${facts.length}</div>
        <div class="stat-sub">${stats.exists ? fmtBytes(stats.sizeBytes) + ' on disk' : 'not yet synthesized'}</div>
      </div>
      <div class="stat-card">
        <div class="stat-lbl">Last synthesis</div>
        <div class="stat-val" style="font-size:.95rem;font-weight:600">${fmtTs(state.lastSynthesis)}</div>
        <div class="stat-sub">${state.synthesisCount || 0} pass(es) total</div>
      </div>
      <div class="stat-card">
        <div class="stat-lbl">Repowise</div>
        <div class="stat-val">${repowiseOn ? (state.repowiseAvailable ? '<span class="pill pill-on">ON</span>' : '<span class="pill pill-warn">MISSING</span>') : '<span class="pill pill-off">OFF</span>'}</div>
        <div class="stat-sub">${state.lastRepowiseRun ? 'last run ' + fmtTs(state.lastRepowiseRun) : 'never run'}</div>
      </div>
      <div class="stat-card">
        <div class="stat-lbl">Distribution</div>
        <div class="stat-val">${distributed ? '<span class="pill pill-on">SHARED</span>' : '<span class="pill pill-off">LOCAL</span>'}</div>
        <div class="stat-sub" title="${esc(stats.dir)}">${distributed ? 'inside KB — syncs to team' : 'per-machine, never shared'}</div>
      </div>
      ${distributed ? (() => {
        const b = cortex.currentBuilder();
        const ageS = b.heartbeat ? Math.round((Date.now() - b.heartbeat) / 1000) : null;
        const ageStr = ageS == null ? 'never claimed' : (ageS < 60 ? `${ageS}s ago` : ageS < 3600 ? `${Math.round(ageS/60)}m ago` : `${Math.round(ageS/3600)}h ago`);
        const pill = !b.machine ? '<span class="pill pill-off">UNCLAIMED</span>'
                    : !b.fresh   ? '<span class="pill pill-warn">STALE</span>'
                    : b.isUs     ? '<span class="pill pill-on">THIS MACHINE</span>'
                                 : `<span class="pill" style="background:#fef3c7;color:#92400e">${esc(b.machine)}</span>`;
        return `
        <div class="stat-card">
          <div class="stat-lbl">Builder</div>
          <div class="stat-val">${pill}</div>
          <div class="stat-sub">heartbeat ${ageStr} · only one machine writes at a time</div>
        </div>`;
      })() : ''}
    </div>

    <!-- ── Memory / LMDB health panel ──────────────────────────────────── -->
    <div id="mem-health-panel" style="margin-bottom:1.2rem;border-radius:var(--r-lg);border:1px solid var(--border-light);background:var(--surface);box-shadow:var(--shadow);overflow:hidden">
      <div style="padding:.6rem 1.1rem;background:rgba(168,85,247,.06);border-bottom:1px solid var(--border-light);display:flex;align-items:center;gap:.6rem">
        <span style="font-size:.95rem">🧠</span>
        <span style="font-size:.78rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--text-2)">CortexMemory — storage engine</span>
        <span id="mem-health-badge" style="margin-left:auto;font-size:.7rem;padding:.15rem .55rem;border-radius:999px;background:#f3f4f6;color:#6b7280">loading…</span>
      </div>
      <div id="mem-health-body" style="padding:.85rem 1.1rem;display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:.7rem">
        <div class="stat-card" style="background:transparent;box-shadow:none;border:none;padding:0">
          <div class="stat-lbl">Backend</div>
          <div class="stat-val" id="mh-backend" style="font-size:1rem">—</div>
        </div>
        <div class="stat-card" style="background:transparent;box-shadow:none;border:none;padding:0">
          <div class="stat-lbl">LMDB</div>
          <div class="stat-val" id="mh-lmdb-status" style="font-size:1rem">—</div>
          <div class="stat-sub" id="mh-lmdb-version" style="font-size:.72rem;color:var(--text-3)"></div>
        </div>
        <div class="stat-card" style="background:transparent;box-shadow:none;border:none;padding:0">
          <div class="stat-lbl">Entries</div>
          <div class="stat-val" id="mh-keys" style="font-size:1rem">—</div>
          <div class="stat-sub" id="mh-size" style="font-size:.72rem;color:var(--text-3)"></div>
        </div>
        <div class="stat-card" style="background:transparent;box-shadow:none;border:none;padding:0">
          <div class="stat-lbl">LRU cache</div>
          <div class="stat-val" id="mh-lru" style="font-size:1rem">—</div>
        </div>
        <div class="stat-card" style="background:transparent;box-shadow:none;border:none;padding:0">
          <div class="stat-lbl">Signals</div>
          <div class="stat-val" id="mh-signals" style="font-size:1rem">—</div>
        </div>
      </div>
      <div id="mh-warning" style="display:none;padding:.6rem 1.1rem;background:#fef9ec;border-top:1px solid #fde68a;font-size:.78rem;color:#92400e">
        ⚠ LMDB is not installed — CortexMemory is using the JSONL fallback.
        <strong>lmdb will be installed automatically on the next server start.</strong>
        To install now: <code style="background:#fff3cd;padding:.1rem .3rem;border-radius:3px">cd server &amp;&amp; npm install lmdb</code>
      </div>
    </div>

    <script>
    (function() {
      async function pollMemHealth() {
        try {
          const h = await fetch('/dashboard/cortex/memory/health').then(r => r.json());
          const s = await fetch('/dashboard/cortex/memory/stats').then(r => r.json()).catch(() => ({}));

          const badge = document.getElementById('mem-health-badge');
          if (h.lmdbActive) {
            badge.textContent = 'LMDB ACTIVE'; badge.style.background = '#dcfce7'; badge.style.color = '#15803d';
          } else if (h.lmdbInstalled) {
            badge.textContent = 'LMDB INSTALLED'; badge.style.background = '#fef9ec'; badge.style.color = '#92400e';
          } else {
            badge.textContent = 'JSONL FALLBACK'; badge.style.background = '#fee2e2'; badge.style.color = '#991b1b';
          }

          document.getElementById('mh-backend').textContent = h.backend || '—';
          const lmdbEl = document.getElementById('mh-lmdb-status');
          if (h.lmdbInstalled && h.lmdbActive)      { lmdbEl.innerHTML = '<span style="color:#15803d;font-weight:700">✓ Active</span>'; }
          else if (h.lmdbInstalled && !h.lmdbActive) { lmdbEl.innerHTML = '<span style="color:#92400e;font-weight:700">Installed / not active</span>'; }
          else                                       { lmdbEl.innerHTML = '<span style="color:#991b1b;font-weight:700">Not installed</span>'; }

          document.getElementById('mh-lmdb-version').textContent = h.lmdbVersion ? 'v' + h.lmdbVersion : '';

          if (s.stats) {
            document.getElementById('mh-keys').textContent    = s.stats.keys ?? '—';
            document.getElementById('mh-size').textContent    = (s.stats.totalSizeKB || 0) + ' KB on disk';
            document.getElementById('mh-lru').textContent     = (s.stats.lruEntries || 0) + ' / ' + (s.stats.lruMax || '—');
            document.getElementById('mh-signals').textContent = (s.stats.signalLines || 0) + ' events';
          }

          const warn = document.getElementById('mh-warning');
          warn.style.display = h.lmdbInstalled ? 'none' : 'block';
        } catch (_) {}
      }
      pollMemHealth();
      setInterval(pollMemHealth, 15000);
    })();
    </script>

    <!-- ── Autonomy queue panel ───────────────────────────────────────────── -->
    ${(() => {
      const autonomy = require('../runner/autonomyScheduler');
      const level    = autonomy.autonomyLevel();
      const threshold = autonomy.promoteThreshold();
      const levelLabels = ['manual', 'cross-session memory', 'confidence-gated', 'full-trust'];
      const levelColors = ['#6b7280','#3b82f6','#f59e0b','#10b981'];
      return `
    <div id="autonomy-panel" style="margin-bottom:1.2rem;border-radius:var(--r-lg);border:1px solid var(--border-light);background:var(--surface);box-shadow:var(--shadow);overflow:hidden">
      <div style="padding:.6rem 1.1rem;background:rgba(16,185,129,.06);border-bottom:1px solid var(--border-light);display:flex;align-items:center;gap:.6rem">
        <span style="font-size:.95rem">🤖</span>
        <span style="font-size:.78rem;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--text-2)">Autonomy</span>
        <span style="margin-left:auto;font-size:.7rem;padding:.15rem .6rem;border-radius:999px;background:${levelColors[level]}20;color:${levelColors[level]};font-weight:700">LEVEL ${level} — ${(levelLabels[level] || '').toUpperCase()}</span>
      </div>
      <div style="padding:.85rem 1.1rem">
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:.7rem;margin-bottom:.8rem">
          <div class="stat-card" style="background:transparent;box-shadow:none;border:none;padding:0">
            <div class="stat-lbl">Autonomy Level</div>
            <div class="stat-val" style="font-size:1.1rem;color:${levelColors[level]}">${level} / 3</div>
            <div class="stat-sub">${levelLabels[level]}</div>
          </div>
          <div class="stat-card" style="background:transparent;box-shadow:none;border:none;padding:0">
            <div class="stat-lbl">Confirm Threshold</div>
            <div class="stat-val" style="font-size:1.1rem">${threshold}×</div>
            <div class="stat-sub">re-observations before queuing</div>
          </div>
          <div class="stat-card" style="background:transparent;box-shadow:none;border:none;padding:0">
            <div class="stat-lbl">Review Window</div>
            <div class="stat-val" style="font-size:1.1rem">${process.env.PRX_CORTEX_AUTO_PROMOTE_DELAY_HOURS || 24}h</div>
            <div class="stat-sub">${level >= 2 ? 'before auto-promotion' : 'not active at this level'}</div>
          </div>
          <div class="stat-card" style="background:transparent;box-shadow:none;border:none;padding:0">
            <div class="stat-lbl">Pending Queue</div>
            <div class="stat-val" id="aq-pending" style="font-size:1.1rem">—</div>
            <div class="stat-sub">observations awaiting promotion</div>
          </div>
        </div>
        <div id="aq-list" style="display:none"></div>
        <div style="font-size:.75rem;color:var(--text-3);margin-top:.4rem">
          ${level === 0 ? '⚙ Level 0: all promotions are manual via <code>POST /cortex/memory/promote</code>.' : ''}
          ${level === 1 ? '⚙ Level 1: confirmCount tracked across sessions. No auto-promotion — upgrade to Level 2 to enable.' : ''}
          ${level === 2 ? '⚙ Level 2: observations with ${threshold}+ confirms queue for promotion after ${process.env.PRX_CORTEX_AUTO_PROMOTE_DELAY_HOURS || 24}h review window.' : ''}
          ${level === 3 ? '⚙ Level 3: observations with ${threshold}+ confirms promote immediately to KB — no review window.' : ''}
          Change via <code>PRX_CORTEX_AUTONOMY_LEVEL</code> in <a href="/dashboard/settings#cortex" style="color:var(--accent)">Settings</a>.
        </div>
      </div>
    </div>
    <script>
    (function() {
      async function pollAutonomy() {
        try {
          const r = await fetch('/dashboard/cortex/memory/pending-promotions').then(x => x.json()).catch(() => null);
          if (!r) return;
          const el = document.getElementById('aq-pending');
          if (el) { el.textContent = r.count; el.style.color = r.count > 0 ? '#f59e0b' : 'inherit'; }
          const list = document.getElementById('aq-list');
          if (!list) return;
          if (!r.count) { list.style.display = 'none'; return; }
          list.style.display = 'block';
          list.innerHTML = r.entries.slice(0, 10).map(e => {
            const v = e.value || {};
            const qAt = v.queuedForPromotionAt ? new Date(v.queuedForPromotionAt).toLocaleString() : '—';
            return \`<div style="display:flex;align-items:center;gap:.6rem;padding:.35rem 0;border-bottom:1px solid var(--border-light);font-size:.78rem">
              <span style="flex:1;font-weight:600;color:var(--text-1)">\${e.key}</span>
              <span style="color:var(--text-3)">\${v.type || 'context'} · \${v.confirmCount || 1}× · queued \${qAt}</span>
              <button onclick="rejectPromotion('\${e.key}')" style="padding:.15rem .5rem;font-size:.72rem;background:#fee2e2;border:1px solid #fca5a5;border-radius:4px;cursor:pointer;color:#991b1b">Reject</button>
              <button onclick="approvePromotion('\${e.key}')" style="padding:.15rem .5rem;font-size:.72rem;background:#dcfce7;border:1px solid #86efac;border-radius:4px;cursor:pointer;color:#15803d">Promote now</button>
            </div>\`;
          }).join('');
        } catch (_) {}
      }
      window.rejectPromotion = async function(key) {
        await fetch('/dashboard/cortex/memory/reject-promotion', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ key }) });
        pollAutonomy();
      };
      window.approvePromotion = async function(key) {
        await fetch('/dashboard/cortex/memory/promote', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ key }) });
        pollAutonomy();
      };
      pollAutonomy();
      setInterval(pollAutonomy, 30000);
    })();
    </script>`;
    })()}

    <div class="actions">
      ${enabled ? `<button type="button" class="btn-cortex" data-act="resynth">▶ Re-synthesise now</button>
      ${repowiseOn ? `<button type="button" class="btn-cortex" data-act="repowise">↻ Run repowise now</button>` : ''}
      ${repowiseOn && !state.repowiseAvailable ? `<button type="button" class="btn-cortex" style="background:#fef3c7;border-color:#fde68a;color:#92400e" data-act="install-rw">⬇ Install repowise</button>` : ''}` : ''}
      <a href="/dashboard/settings#cortex" class="btn-cortex" style="text-decoration:none;display:inline-flex;align-items:center">⚙ Settings</a>
      <div class="search-wrap">
        <input type="text" class="fact-search" id="fact-search" placeholder="Filter facts by name or heading…" autocomplete="off">
      </div>
    </div>

    <div class="fact-grid" id="fact-grid">
      ${factCards.map(f => {
        const stale = f.exists && state.lastSynthesis && f.mtimeMs < (Date.now() - 7 * 86400000);
        const statusCls = !f.exists ? 'missing' : stale ? 'stale' : 'fresh';
        const statusLbl = !f.exists ? 'NOT YET BUILT' : stale ? 'STALE >7d' : 'FRESH';

        // Search index — concatenation of name + heading text for client-side filter.
        const searchData = (f.name + ' ' + f.headings.map(h => h.text).join(' ')).toLowerCase();

        const previewItems = f.headings.filter(h => h.level === 2).slice(0, 4);
        const previewExtra = f.sectionCount - previewItems.length;

        return `<div class="fact-card ${f.exists ? 'has-content' : 'empty'}" data-search="${esc(searchData)}">
          <div class="fact-card-header">
            <div class="fact-card-icon">${f.icon}</div>
            <h3 class="fact-card-title">${esc(f.name)}</h3>
          </div>
          <div class="fact-card-meta">
            ${f.exists ? `<span><b>${fmtBytes(f.bytes)}</b></span>
            <span><b>${f.sectionCount}</b> section${f.sectionCount === 1 ? '' : 's'}</span>
            <span>updated <b>${_cortexAgoStr(f.mtimeMs)}</b></span>` : `<span>—</span>`}
          </div>
          ${f.exists && previewItems.length > 0 ? `
            <div class="fact-card-preview">
              <ul>
                ${previewItems.map(h => `<li>${esc(h.text)}</li>`).join('')}
                ${previewExtra > 0 ? `<li class="more">…and ${previewExtra} more</li>` : ''}
              </ul>
            </div>
          ` : f.exists ? `
            <div class="fact-card-preview" style="font-style:italic;color:var(--text-3)">_(no headings yet — file may be empty)_</div>
          ` : `
            <div class="fact-card-empty">
              Not synthesised yet. ${enabled ? 'It will be created on the next pass.' : 'Enable Cortex in Settings.'}
            </div>
          `}
          <div class="fact-card-footer">
            <span class="fact-card-status ${statusCls}">${statusLbl}</span>
            ${f.exists
              ? `<a class="fact-card-open" href="/dashboard/cortex/facts/${f.id}">Open →</a>`
              : `<span style="font-size:.7rem;color:var(--text-3)">—</span>`}
          </div>
        </div>`;
      }).join('')}
      <div class="empty-message" id="empty-msg" style="display:none">No facts match your search.</div>
    </div>
  </div>

  <script>
    // Action buttons (delegated handler for cleanliness).
    document.addEventListener('click', async (ev) => {
      const btn = ev.target.closest('button[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      const orig = btn.textContent;
      btn.disabled = true;
      try {
        if (act === 'resynth') {
          btn.textContent = 'Queued…';
          const r = await fetch('/dashboard/cortex/run-now', { method: 'POST' }).then(r => r.json());
          btn.textContent = r.ok ? '✓ Queued — reload in a moment' : (r.error || 'Error');
        } else if (act === 'repowise') {
          btn.textContent = 'Running…';
          const r = await fetch('/dashboard/cortex/repowise-now', { method: 'POST' }).then(r => r.json());
          btn.textContent = r.ok ? '✓ Started' : (r.error || 'Error');
        } else if (act === 'install-rw') {
          btn.textContent = 'Installing… (up to ~3 min)';
          const r = await fetch('/dashboard/cortex/install-repowise', { method: 'POST' }).then(r => r.json());
          if (r.ok) {
            btn.textContent = '✓ Installed via ' + ((r.summary && r.summary.via) || 'pip');
            setTimeout(() => location.reload(), 1500);
          } else {
            btn.textContent = '✗ Failed — ' + ((r.summary && r.summary.message) || 'see server log');
            if (r.summary && r.summary.hint) alert('Next step: ' + r.summary.hint);
          }
        }
      } catch (_) { btn.textContent = 'Error'; }
      setTimeout(() => { btn.disabled = false; btn.textContent = orig; }, 4000);
    });

    // Client-side card filter — instant, no server round-trip.
    const searchInput = document.getElementById('fact-search');
    const emptyMsg = document.getElementById('empty-msg');
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        const q = searchInput.value.trim().toLowerCase();
        const cards = document.querySelectorAll('.fact-card');
        let visible = 0;
        cards.forEach(card => {
          const match = !q || card.dataset.search.includes(q);
          card.style.display = match ? '' : 'none';
          if (match) visible++;
        });
        emptyMsg.style.display = (q && visible === 0) ? '' : 'none';
      });
    }

    // Background-install poll (unchanged from previous version).
    (function pollInstallStatus() {
      let lastInstalling = null;
      const tick = async () => {
        try {
          const r = await fetch('/dashboard/cortex/install-status');
          const d = await r.json();
          if (d.installing && lastInstalling !== true) {
            let banner = document.getElementById('repowise-install-banner');
            if (!banner) {
              banner = document.createElement('div');
              banner.id = 'repowise-install-banner';
              banner.style.cssText = 'background:#fef3c7;border:1px solid #fde68a;color:#92400e;padding:.75rem 1.1rem;border-radius:8px;margin:1rem 0;font-size:.85rem;font-weight:600';
              banner.innerHTML = '⟳ Repowise install in progress (background) — page will refresh when done.';
              const pb = document.querySelector('.page-body');
              if (pb) pb.insertBefore(banner, pb.children[2] || null);
            }
          } else if (!d.installing && lastInstalling === true) {
            setTimeout(() => location.reload(), 600);
            return;
          }
          lastInstalling = d.installing;
        } catch (_) {}
        setTimeout(tick, 4000);
      };
      tick();
    })();
  </script>
  ${BASE_SCRIPT}
</body>
</html>`;
}

// ── Cortex fact detail page — one fact file, sticky TOC, in-page search ──────

function renderCortexFact(id) {
  const cortex = require('../runner/cortexLayer');
  const fs = require('fs');

  const fact = cortex.listFactFiles().find(f => f.id === id);
  if (!fact) return { status: 404, html: renderCortexNotFound(id) };

  if (!fact.exists) {
    return { status: 200, html: renderCortexEmpty(fact) };
  }

  let body = '';
  let bytes = 0;
  let mtimeMs = 0;
  try {
    body = fs.readFileSync(fact.path, 'utf8');
    const st = fs.statSync(fact.path);
    bytes = st.size;
    mtimeMs = st.mtimeMs;
  } catch (_) {
    return { status: 200, html: renderCortexEmpty(fact) };
  }

  const headings = _cortexHeadings(body);
  const rendered = _cortexMd(body);

  return { status: 200, html: `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(fact.name)} · Cortex — Prevoyant Server</title>
  <style>
    ${BASE_CSS}
    ${_CORTEX_CSS}
    .page-body { max-width: 1200px; margin: 1.5rem auto; padding: 0 1.5rem; }

    .fact-head {
      display: flex; align-items: center; gap: .8rem;
      margin: .25rem 0 1rem;
    }
    .fact-head-icon { font-size: 1.8rem; line-height: 1; flex-shrink: 0; }
    .fact-head h1 {
      font-size: 1.5rem; font-weight: 800; color: var(--text);
      margin: 0; letter-spacing: -.02em;
    }
    .fact-head-meta {
      display: flex; gap: 1rem; flex-wrap: wrap;
      font-size: .73rem; color: var(--text-3);
      margin: .25rem 0 0;
    }
    .fact-head-meta b { color: var(--text-2); font-weight: 600; }
    .fact-head-meta code {
      background: var(--surface-2); padding: 1px 6px; border-radius: 4px;
      font-size: .7rem; color: var(--text-2);
    }

    .fact-layout {
      display: grid;
      grid-template-columns: 240px 1fr;
      gap: 1.4rem;
      align-items: start;
    }
    @media (max-width: 900px) {
      .fact-layout { grid-template-columns: 1fr; }
      .fact-toc { position: static !important; max-height: none !important; }
    }

    .fact-toc {
      position: sticky; top: 16px;
      max-height: calc(100vh - 32px);
      overflow-y: auto;
      background: var(--surface);
      border: 1px solid var(--border-light);
      border-radius: var(--r-md);
      padding: .85rem 1rem;
      box-shadow: var(--shadow);
    }
    .fact-toc-title {
      font-size: .62rem; text-transform: uppercase; letter-spacing: .09em;
      color: var(--text-3); font-weight: 700; margin-bottom: .55rem;
    }
    .fact-toc ul { list-style: none; margin: 0; padding: 0; }
    .fact-toc li { margin: 1px 0; }
    .fact-toc a {
      display: block; padding: 4px 8px;
      font-size: .78rem; color: var(--text-2);
      text-decoration: none;
      border-radius: 4px;
      border-left: 2px solid transparent;
      transition: background .12s, color .12s, border-color .12s;
    }
    .fact-toc a.lvl-3 { padding-left: 18px; font-size: .73rem; color: var(--text-3); }
    .fact-toc a:hover { background: rgba(236,72,153,.08); color: #db2777; }
    .fact-toc a.active { border-left-color: #ec4899; background: rgba(236,72,153,.1); color: #db2777; font-weight: 600; }

    .fact-search-wrap { position: relative; margin-bottom: .85rem; }
    .fact-search-wrap input {
      width: 100%; padding: .55rem .9rem .55rem 2rem;
      font-size: .85rem; font-family: inherit;
      border: 1px solid var(--border); border-radius: var(--r-sm);
      background: var(--surface); color: var(--text);
    }
    .fact-search-wrap input:focus { outline: none; border-color: rgba(236,72,153,.55); box-shadow: 0 0 0 3px rgba(236,72,153,.12); }
    .fact-search-wrap::before {
      content: '⌕'; position: absolute; left: .7rem; top: 50%;
      transform: translateY(-50%); color: var(--text-3); font-size: .9rem;
      pointer-events: none;
    }

    .fact-body {
      background: var(--surface); border-radius: var(--r-lg);
      padding: 1.5rem 1.8rem; box-shadow: var(--shadow);
      border: 1px solid var(--border-light);
    }
    .md-body .section { transition: opacity .12s; }
    .md-body .section.hidden { display: none; }
  </style>
</head>
<body>
  <header>
    <h1><span class="sun-logo"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/></svg></span>Cortex</h1>
    <div class="meta"></div>
    <a href="/dashboard/cortex" class="header-btn">← All facts</a>
  </header>

  <div class="page-body">
    <div class="breadcrumb">
      <a href="/dashboard">Dashboard</a> &nbsp;›&nbsp;
      <a href="/dashboard/cortex">Cortex</a> &nbsp;›&nbsp;
      <span class="breadcrumb-here">${esc(fact.name)}</span>
    </div>

    <div class="fact-head">
      <div class="fact-head-icon">${fact.icon}</div>
      <div>
        <h1>${esc(fact.name)}</h1>
        <div class="fact-head-meta">
          <span><b>${_cortexFmtBytes(bytes)}</b></span>
          <span><b>${headings.filter(h => h.level === 2).length}</b> sections</span>
          <span>updated <b>${_cortexAgoStr(mtimeMs)}</b></span>
          <span>source <code>${esc(fact.file)}</code></span>
        </div>
      </div>
    </div>

    <div class="fact-layout">
      <aside class="fact-toc">
        <div class="fact-toc-title">Contents</div>
        <ul>
          ${headings.length === 0
            ? '<li style="font-size:.75rem;color:var(--text-3);font-style:italic;padding:4px 8px">No sections yet</li>'
            : headings.map(h => `<li><a href="#${h.slug}" class="lvl-${h.level}" data-slug="${h.slug}">${esc(h.text)}</a></li>`).join('')}
        </ul>
      </aside>

      <div>
        <div class="fact-search-wrap">
          <input type="text" id="section-search" placeholder="Filter sections within this fact…" autocomplete="off">
        </div>
        <div class="fact-body md-body" id="fact-body">${rendered}</div>
      </div>
    </div>
  </div>

  <script>
    // Wrap each H2 in a "section" div so the in-page filter can hide whole
    // sections rather than just heading lines.  Done client-side once.
    (function wrapSections() {
      const body = document.getElementById('fact-body');
      if (!body) return;
      const children = Array.from(body.children);
      const sections = [];
      let current = null;
      children.forEach(el => {
        if (el.tagName === 'H2') {
          if (current) sections.push(current);
          current = { heading: el, els: [el], text: el.textContent.toLowerCase(), slug: el.id };
        } else if (current) {
          current.els.push(el);
          current.text += ' ' + (el.textContent || '').toLowerCase();
        }
      });
      if (current) sections.push(current);

      // Replace flat children with section wrappers.
      sections.forEach(s => {
        const wrap = document.createElement('div');
        wrap.className = 'section';
        wrap.dataset.slug = s.slug;
        wrap.dataset.search = s.text;
        s.els.forEach(el => wrap.appendChild(el));
        body.appendChild(wrap);
      });
    })();

    // In-page section filter.
    const sInput = document.getElementById('section-search');
    if (sInput) {
      sInput.addEventListener('input', () => {
        const q = sInput.value.trim().toLowerCase();
        document.querySelectorAll('#fact-body .section').forEach(s => {
          const match = !q || s.dataset.search.includes(q);
          s.classList.toggle('hidden', !match);
        });
      });
    }

    // Scroll-spy — highlight the TOC entry for the section currently in view.
    const tocLinks = document.querySelectorAll('.fact-toc a[data-slug]');
    const slugToLink = new Map();
    tocLinks.forEach(a => slugToLink.set(a.dataset.slug, a));
    if ('IntersectionObserver' in window && slugToLink.size) {
      const io = new IntersectionObserver((entries) => {
        entries.forEach(e => {
          if (e.isIntersecting) {
            tocLinks.forEach(a => a.classList.remove('active'));
            const id = e.target.id;
            // For H3 sub-headings, highlight the nearest H2 instead.
            const link = slugToLink.get(id);
            if (link) link.classList.add('active');
          }
        });
      }, { rootMargin: '-80px 0px -65% 0px', threshold: 0 });
      document.querySelectorAll('.md-body h2.cortex-h2, .md-body h3.cortex-h3').forEach(h => io.observe(h));
    }
  </script>
  ${BASE_SCRIPT}
</body>
</html>` };
}

function renderCortexNotFound(id) {
  return `<!DOCTYPE html><html><head><title>Not found · Cortex</title><style>${BASE_CSS}${_CORTEX_CSS}.page-body{max-width:700px;margin:4rem auto;padding:0 1.5rem;text-align:center}</style></head><body><header><h1>Cortex</h1><div class="meta"></div><a href="/dashboard/cortex" class="header-btn">← All facts</a></header><div class="page-body"><h2>Unknown fact: <code>${esc(id || '')}</code></h2><p style="color:var(--text-3)">Valid IDs: architecture, business-rules, patterns, decisions, hotspots, glossary.</p><p style="margin-top:2rem"><a href="/dashboard/cortex" class="btn-cortex" style="text-decoration:none">← Back to Cortex</a></p></div>${BASE_SCRIPT}</body></html>`;
}

function renderCortexEmpty(fact) {
  return `<!DOCTYPE html><html><head><title>${esc(fact.name)} · Cortex</title><style>${BASE_CSS}${_CORTEX_CSS}.page-body{max-width:760px;margin:3rem auto;padding:0 1.5rem}.empty-hero{background:var(--surface);border:1px solid var(--border-light);border-radius:var(--r-lg);padding:2rem;text-align:center;box-shadow:var(--shadow)}.empty-hero .icon{font-size:3rem;margin-bottom:.5rem}</style></head><body><header><h1><span class="sun-logo"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/></svg></span>Cortex</h1><div class="meta"></div><a href="/dashboard/cortex" class="header-btn">← All facts</a></header><div class="page-body"><div class="breadcrumb"><a href="/dashboard">Dashboard</a> &nbsp;›&nbsp; <a href="/dashboard/cortex">Cortex</a> &nbsp;›&nbsp; <span class="breadcrumb-here">${esc(fact.name)}</span></div><div class="empty-hero"><div class="icon">${fact.icon}</div><h2>${esc(fact.name)}</h2><p style="color:var(--text-3);margin:1rem 0">This fact file has not been synthesised yet. It will be created on the next cortex pass — either when the KB changes or on the heartbeat interval.</p><p style="margin-top:1.5rem"><a href="/dashboard/cortex" class="btn-cortex" style="text-decoration:none">← Back to Cortex</a></p></div></div>${BASE_SCRIPT}</body></html>`;
}

// ── Watch page ────────────────────────────────────────────────────────────────

function relativeTime(isoStr) {
  if (!isoStr) return '—';
  const diff = Date.now() - new Date(isoStr).getTime();
  if (diff < 0) {
    const abs = Math.abs(diff);
    if (abs < 3600000) return `in ${Math.round(abs / 60000)}m`;
    if (abs < 86400000) return `in ${Math.round(abs / 3600000)}h`;
    return `in ${Math.round(abs / 86400000)}d`;
  }
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
  return `${Math.round(diff / 86400000)}d ago`;
}

// ── Watch log list & viewer pages ─────────────────────────────────────────────

function watchLogCss() {
  return `
    .wl-wrap { max-width:960px; margin:2rem auto; padding:0 1.5rem 4rem; }
    .wl-header { display:flex; align-items:baseline; gap:1rem; margin-bottom:1.5rem; flex-wrap:wrap; }
    .wl-title { font-size:1.15rem; font-weight:700; color:#1a1a2e; }
    .breadcrumb { font-size:.82rem; color:#94a3b8; }
    .breadcrumb a { color:#64748b; text-decoration:none; }
    .breadcrumb a:hover { color:#374151; }
    .wl-card { background:#fff; border:1px solid #e2e8f0; border-radius:10px;
               box-shadow:0 1px 3px #0001; overflow:hidden; }
    .wl-card-head { display:flex; align-items:center; justify-content:space-between;
                    padding:.85rem 1.25rem; border-bottom:1px solid #f1f5f9; }
    .wl-card-label { font-weight:600; font-size:.88rem; color:#374151; }
    .wl-empty { text-align:center; color:#9ca3af; padding:2.5rem 1rem; font-size:.875rem; }
    table.wl-table { width:100%; border-collapse:collapse; font-size:.84rem; }
    table.wl-table th { background:#f8fafc; color:#64748b; font-weight:600; font-size:.75rem;
                        text-transform:uppercase; letter-spacing:.04em; padding:.6rem 1rem;
                        text-align:left; border-bottom:1px solid #e2e8f0; }
    table.wl-table td { padding:.65rem 1rem; border-bottom:1px solid #f1f5f9; vertical-align:middle; }
    table.wl-table tr:last-child td { border-bottom:none; }
    table.wl-table tr:hover td { background:#f8fafc; }
    .wl-badge-live { display:inline-block; padding:1px 7px; border-radius:8px;
                     background:#fef3c7; color:#92400e; font-size:.7rem; font-weight:700;
                     text-transform:uppercase; letter-spacing:.05em; margin-left:.4rem; }
    .wl-badge-ok   { display:inline-block; padding:1px 7px; border-radius:8px;
                     background:#dcfce7; color:#166534; font-size:.7rem; font-weight:600; }
    .wl-badge-err  { display:inline-block; padding:1px 7px; border-radius:8px;
                     background:#fee2e2; color:#991b1b; font-size:.7rem; font-weight:600; }
    .wl-btn { border:none; border-radius:5px; padding:.3rem .65rem; font-size:.78rem;
              font-weight:500; cursor:pointer; background:#eff6ff; color:#1d4ed8; }
    .wl-btn:hover { background:#dbeafe; }
    .wl-btn-a { text-decoration:none; display:inline-block;
                border:none; border-radius:5px; padding:.3rem .65rem; font-size:.78rem;
                font-weight:500; background:#eff6ff; color:#1d4ed8; }
    .wl-btn-a:hover { background:#dbeafe; }
    .wl-btn-danger { border:none; border-radius:5px; padding:.35rem .8rem; font-size:.78rem;
                     font-weight:500; cursor:pointer; background:#fef2f2; color:#dc2626; }
    .wl-btn-danger:hover { background:#fee2e2; }
    .wl-size { color:#9ca3af; font-size:.78rem; }
    /* log viewer */
    .wl-log-wrap { background:#0f172a; border-radius:0 0 10px 10px;
                   padding:1.25rem 1.5rem; overflow:auto; max-height:72vh; }
    .wl-log-pre { color:#e2e8f0; font-family:'Menlo','Monaco','Consolas',monospace;
                  font-size:.78rem; line-height:1.6; white-space:pre-wrap; word-break:break-word;
                  margin:0; }
    .wl-live-bar { background:#fefce8; border:1px solid #fcd34d; border-radius:6px;
                   padding:.5rem 1rem; margin-bottom:.75rem; font-size:.82rem; color:#92400e;
                   display:flex; align-items:center; gap:.5rem; }
    @keyframes wl-pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
    .wl-live-dot { width:8px; height:8px; border-radius:50%; background:#f59e0b;
                   animation:wl-pulse 1.2s ease-in-out infinite; }`;
}

function parseLogFilename(filename) {
  // 2026-05-03_14-30-00_poll-3.log → { date, pollNum }
  const m = filename.match(/^(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})_poll-(\d+)\.log$/);
  if (!m) return { date: filename, pollNum: null };
  const iso = `${m[1]}T${m[2].replace(/-/g, ':')}Z`;
  return { date: new Date(iso).toLocaleString(), pollNum: parseInt(m[3], 10) };
}

function logFileStatus(filename, lastLogFile, pollingNow) {
  if (filename === lastLogFile && pollingNow) return 'live';
  // peek at last line of file to detect error footer
  const fPath = null; // resolved by caller
  return 'ok';
}

function renderWatchLogs(key, files, ticket, flash) {
  const isLive    = ticket?.pollingNow;
  const lastLog   = ticket?.lastLogFile || '';
  const flashHtml = flash === 'cleared'
    ? `<div style="background:#dcfce7;color:#166534;border:1px solid #bbf7d0;border-radius:6px;padding:.6rem 1rem;margin-bottom:1rem;font-size:.85rem">All logs for ${esc(key)} deleted.</div>`
    : '';

  const rows = files.length === 0
    ? `<tr><td colspan="4" class="wl-empty">No log files yet for ${esc(key)}.</td></tr>`
    : files.map(f => {
        const { date, pollNum } = parseLogFilename(f);
        const isFileLive = (f === lastLog && isLive);
        const liveBadge  = isFileLive ? `<span class="wl-badge-live">Live</span>` : '';
        let size = '';
        try {
          const bytes = fs.statSync(path.join(WATCH_LOG_DIR, key, f)).size;
          size = bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes/1024).toFixed(1)} KB` : `${(bytes/1048576).toFixed(1)} MB`;
        } catch (_) {}
        return `<tr>
          <td>${esc(date)}${liveBadge}</td>
          <td class="wl-size">${pollNum != null ? `Poll #${pollNum}` : '—'}</td>
          <td class="wl-size">${esc(size)}</td>
          <td><a class="wl-btn-a" href="/dashboard/watch/${esc(key)}/logs/${esc(f)}">View</a></td>
        </tr>`;
      }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Logs: ${esc(key)} — Prevoyant Server</title>
  <style>${BASE_CSS}${watchLogCss()}</style>
</head>
<body>
  <header>
    <h1><span class="sun-logo" id="sun-logo"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg></span>Prevoyant Server</h1>
    <span class="version-badge">v${esc(pluginVersion)}</span>
    <span class="meta"></span>
    <a href="/dashboard/watch" class="settings-link" style="color:#fff">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
      Watch
    </a>
    <a href="/dashboard/settings" class="settings-link">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      Settings
    </a>
  </header>
  <div class="wl-wrap">
    <div class="wl-header">
      <span class="breadcrumb"><a href="/dashboard">Dashboard</a> › <a href="/dashboard/watch">Watch</a> › ${esc(key)}</span>
    </div>
    <div class="wl-header">
      <span class="wl-title">Poll Logs — ${esc(key)}</span>
      <span style="font-size:.82rem;color:#64748b">${files.length} run${files.length !== 1 ? 's' : ''}</span>
    </div>
    ${flashHtml}
    <div class="wl-card">
      <div class="wl-card-head">
        <span class="wl-card-label">Run History</span>
        <div style="display:flex;align-items:center;gap:.75rem">
          ${isLive ? `<span style="font-size:.8rem;color:#92400e;font-weight:600">● Poll in progress</span>` : ''}
          ${files.length > 0 && !isLive ? `
          <form method="POST" action="/dashboard/watch/${esc(key)}/logs/clear" style="margin:0"
                onsubmit="return confirm('Delete all ${files.length} log file${files.length !== 1 ? 's' : ''} for ${esc(key)}?\\n\\nThis cannot be undone.')">
            <button type="submit" class="wl-btn-danger">
              <svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:3px"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
              Clear all logs
            </button>
          </form>` : ''}
        </div>
      </div>
      <table class="wl-table">
        <thead><tr><th>Date / Time</th><th>Poll #</th><th>Size</th><th>Log</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>
  <footer class="footer">Prevoyant Server v${esc(pluginVersion)}</footer>
  ${BASE_SCRIPT}
</body>
</html>`;
}

function renderWatchLogView(key, filename, content, ticket) {
  const { date, pollNum } = parseLogFilename(filename);
  const isLive = ticket?.pollingNow && ticket?.lastLogFile === filename;
  const liveBar = isLive
    ? `<div class="wl-live-bar"><span class="wl-live-dot"></span>This poll is still running — page auto-refreshes every 3 s</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Log: ${esc(key)} #${pollNum ?? '?'} — Prevoyant Server</title>
  <style>${BASE_CSS}${watchLogCss()}</style>
</head>
<body>
  <header>
    <h1><span class="sun-logo" id="sun-logo"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg></span>Prevoyant Server</h1>
    <span class="version-badge">v${esc(pluginVersion)}</span>
    <span class="meta"></span>
    <a href="/dashboard/watch" class="settings-link" style="color:#fff">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
      Watch
    </a>
    <a href="/dashboard/settings" class="settings-link">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      Settings
    </a>
  </header>
  <div class="wl-wrap">
    <div class="wl-header">
      <span class="breadcrumb">
        <a href="/dashboard">Dashboard</a> ›
        <a href="/dashboard/watch">Watch</a> ›
        <a href="/dashboard/watch/${esc(key)}/logs">${esc(key)}</a> ›
        ${pollNum != null ? `Poll #${pollNum}` : esc(filename)}
      </span>
    </div>
    <div class="wl-header">
      <span class="wl-title">${esc(key)} — Poll #${pollNum ?? '?'}</span>
      <span style="font-size:.82rem;color:#64748b">${esc(date)}</span>
    </div>
    ${liveBar}
    <div class="wl-card">
      <div class="wl-card-head">
        <span class="wl-card-label">${esc(filename)}</span>
        <a class="wl-btn-a" href="/dashboard/watch/${esc(key)}/logs">← All runs</a>
      </div>
      <div class="wl-log-wrap" id="log-container">
        <pre class="wl-log-pre" id="log-content">${esc(content)}</pre>
      </div>
    </div>
  </div>
  <footer class="footer">Prevoyant Server v${esc(pluginVersion)}</footer>
  ${isLive ? `<script>
  (function() {
    var key = ${JSON.stringify(key)}, file = ${JSON.stringify(filename)};
    var pre = document.getElementById('log-content');
    var container = document.getElementById('log-container');
    var atBottom = true;
    container.addEventListener('scroll', function() {
      atBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 40;
    });
    function refresh() {
      fetch('/dashboard/watch/' + key + '/log/tail?file=' + encodeURIComponent(file))
        .then(function(r){ return r.json(); })
        .then(function(d) {
          pre.textContent = d.content || '';
          if (atBottom) container.scrollTop = container.scrollHeight;
          if (d.done) { clearInterval(iv); document.querySelector('.wl-live-bar').style.display='none'; }
        }).catch(function(){});
    }
    var iv = setInterval(refresh, 3000);
    // Scroll to bottom initially
    container.scrollTop = container.scrollHeight;
  })();
  </script>` : ''}
  ${BASE_SCRIPT}
</body>
</html>`;
}

function renderWatch(flash) {
  const tickets   = watchStore.list();
  const watching  = tickets.filter(t => t.status === 'watching').length;
  const enabled   = process.env.PRX_WATCH_ENABLED === 'Y';
  const jiraBase  = (process.env.JIRA_URL || '').replace(/\/$/, '');

  const flashHtml = flash === 'added'    ? `<div class="w-flash w-flash-ok">Ticket added — first poll running now.</div>`
                  : flash === 'stopped'  ? `<div class="w-flash w-flash-ok">Ticket watch stopped.</div>`
                  : flash === 'resumed'  ? `<div class="w-flash w-flash-ok">Ticket resumed — polling now.</div>`
                  : flash === 'polled'   ? `<div class="w-flash w-flash-ok">Poll triggered — digest will be emailed shortly.</div>`
                  : flash === 'removed'  ? `<div class="w-flash w-flash-ok">Ticket removed from watch list.</div>`
                  : flash === 'exists'   ? `<div class="w-flash w-flash-err">That ticket is already being watched.</div>`
                  : flash === 'nokey'    ? `<div class="w-flash w-flash-err">Please enter a ticket key.</div>`
                  : '';

  const INTERVAL_LABELS = { '1h': 'Every hour', '1d': 'Every day', '2d': 'Every 2 days', '5d': 'Every 5 days' };
  const STATUS_BADGE = {
    watching:  `<span class="w-badge w-watching">Watching</span>`,
    stopped:   `<span class="w-badge w-stopped">Stopped</span>`,
    completed: `<span class="w-badge w-completed">Completed</span>`,
  };

  const EYE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;

  const rows = tickets.length === 0
    ? `<tr><td colspan="8" class="w-empty">No tickets being watched yet. Add one above.</td></tr>`
    : tickets.map(t => {
        const ticketLabel = jiraBase
          ? `<a href="${esc(jiraBase)}/browse/${esc(t.key)}" target="_blank" rel="noopener" class="w-ticket-link">${esc(t.key)}</a>`
          : `<code>${esc(t.key)}</code>`;
        const watchingEye = t.status === 'watching'
          ? `<span class="w-eye-anim" title="Actively watching">${EYE_SVG}</span>`
          : '';
        const digestPreview = t.lastDigest
          ? `<span class="w-digest-preview" title="${esc(t.lastDigest)}">${esc(t.lastDigest.slice(0, 80))}${t.lastDigest.length > 80 ? '…' : ''}</span>`
          : `<span class="w-muted">—</span>`;
        const errorHtml = t.lastError
          ? `<div class="w-error-row" title="${esc(t.lastError)}">⚠ ${esc(t.lastError.slice(0, 80))}</div>`
          : '';
        const logsBtn = `<a href="/dashboard/watch/${esc(t.key)}/logs" class="w-btn w-btn-logs" style="margin-left:.3rem;text-decoration:none" title="View poll logs">Logs</a>`;
        let actions = '';
        if (t.status === 'watching') {
          actions = `<form method="POST" action="/dashboard/watch/${esc(t.key)}/poll" style="display:inline">
               <button class="w-btn w-btn-poll" title="Trigger an immediate poll and email digest now">Poll now</button>
             </form>
             <form method="POST" action="/dashboard/watch/${esc(t.key)}/stop" style="display:inline;margin-left:.3rem">
               <button class="w-btn w-btn-stop" title="Stop watching this ticket">Stop</button>
             </form>
             <form method="POST" action="/dashboard/watch/${esc(t.key)}/remove" style="display:inline;margin-left:.3rem">
               <button class="w-btn w-btn-remove" title="Remove from list" onclick="return confirm('Remove ${esc(t.key)} from the watch list?')">Remove</button>
             </form>${logsBtn}`;
        } else {
          actions = `<form method="POST" action="/dashboard/watch/${esc(t.key)}/resume" style="display:inline">
               <button class="w-btn w-btn-resume" title="Resume watching this ticket">Resume</button>
             </form>
             <form method="POST" action="/dashboard/watch/${esc(t.key)}/remove" style="display:inline;margin-left:.3rem">
               <button class="w-btn w-btn-remove" title="Remove from list" onclick="return confirm('Remove ${esc(t.key)} from the watch list?')">Remove</button>
             </form>${logsBtn}`;
        }
        return `<tr data-key="${esc(t.key)}">
          <td style="white-space:nowrap">${ticketLabel}${watchingEye}</td>
          <td>${STATUS_BADGE[t.status] || esc(t.status)}</td>
          <td>${esc(INTERVAL_LABELS[t.interval] || t.interval)}</td>
          <td class="w-num">${t.pollCount}${t.maxPolls > 0 ? ` / ${t.maxPolls}` : ''}</td>
          <td class="w-time">${relativeTime(t.lastPollAt)}</td>
          <td class="w-time">${t.status === 'watching' ? relativeTime(t.nextPollAt) : '—'}</td>
          <td>${digestPreview}${errorHtml}</td>
          <td class="w-actions">${actions}</td>
        </tr>`;
      }).join('');

  const defaultInterval = process.env.PRX_WATCH_POLL_INTERVAL || '1d';
  const defaultMaxPolls = process.env.PRX_WATCH_MAX_POLLS     || '0';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Ticket Watcher — Prevoyant Server</title>
  <style>
    ${BASE_CSS}
    .w-wrap { max-width:1100px; margin:2rem auto; padding:0 1.5rem 4rem; }
    .w-header { display:flex; align-items:baseline; gap:1rem; margin-bottom:1.5rem; flex-wrap:wrap; }
    .w-title { font-size:1.25rem; font-weight:700; color:#1a1a2e; }
    .w-subtitle { font-size:.82rem; color:#64748b; }
    .w-flash { padding:.7rem 1rem; border-radius:6px; margin-bottom:1.2rem; font-size:.875rem; }
    .w-flash-ok  { background:#dcfce7; color:#166534; border:1px solid #bbf7d0; }
    .w-flash-err { background:#fee2e2; color:#991b1b; border:1px solid #fecaca; }
    .w-warn { background:#fffbeb; border:1px solid #fcd34d; border-radius:8px; padding:.75rem 1rem;
              color:#92400e; font-size:.84rem; margin-bottom:1.2rem; }
    .w-add-card { background:#fff; border:1px solid #e2e8f0; border-radius:10px; padding:1.25rem 1.5rem;
                  margin-bottom:2rem; box-shadow:0 1px 3px #0001; }
    .w-add-title { font-weight:600; font-size:.9rem; color:#1a1a2e; margin-bottom:1rem; }
    .w-form-row { display:flex; gap:.75rem; align-items:flex-end; flex-wrap:wrap; }
    .w-field { display:flex; flex-direction:column; gap:.3rem; }
    .w-label { font-size:.78rem; font-weight:500; color:#374151; }
    .w-input, .w-select { border:1px solid #d1d5db; border-radius:6px; padding:.45rem .7rem;
                          font-size:.875rem; background:#fff; color:#1a1a2e; }
    .w-input:focus, .w-select:focus { outline:2px solid #0d6efd44; border-color:#0d6efd; }
    .w-input { width:160px; }
    .w-submit { background:#0d6efd; color:#fff; border:none; border-radius:6px; padding:.5rem 1.1rem;
                font-size:.875rem; font-weight:500; cursor:pointer; white-space:nowrap; }
    .w-submit:hover { background:#0b5ed7; }
    .w-hint { font-size:.72rem; color:#94a3b8; }
    .w-table-wrap {
      background: var(--surface); border: 1px solid var(--border-light);
      border-radius: var(--r-lg); box-shadow: var(--shadow); overflow: hidden;
    }
    .w-table-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: .85rem 1.25rem; border-bottom: 1px solid var(--border-light);
      gap: 1rem; flex-wrap: wrap;
    }
    .w-table-label { font-weight: 700; font-size: .86rem; color: var(--text); }
    .w-count { font-size: .76rem; color: var(--text-3); }
    table.w-table { width: 100%; border-collapse: collapse; font-size: .83rem; }
    table.w-table th {
      background: var(--surface-2); color: var(--text-3); font-weight: 700; font-size: .68rem;
      text-transform: uppercase; letter-spacing: .07em; padding: .55rem 1rem;
      text-align: left; border-bottom: 1px solid var(--border); white-space: nowrap;
    }
    table.w-table td { padding: .72rem 1rem; border-bottom: 1px solid var(--border-light); vertical-align: top; }
    table.w-table tr:last-child td { border-bottom: none; }
    table.w-table tr:hover td { background: #fafbff; }
    .w-badge { display: inline-block; padding: 2px 10px; border-radius: 20px; font-size: .7rem; font-weight: 600; }
    .w-watching  { background: var(--blue-dim);   color: var(--blue); }
    .w-stopped   { background: var(--surface-2);  color: var(--text-3); border: 1px solid var(--border-light); }
    .w-completed { background: var(--green-dim);  color: var(--green); }
    .w-num  { text-align: center; color: var(--text-2); font-variant-numeric: tabular-nums; }
    .w-time { color: var(--text-3); white-space: nowrap; font-size: .78rem; }
    .w-actions { white-space: nowrap; }
    .w-btn {
      border: none; border-radius: var(--r-sm); padding: .28rem .65rem;
      font-size: .76rem; font-weight: 600; cursor: pointer; font-family: inherit; transition: background .12s;
    }
    .w-btn-poll   { background: var(--blue-dim);   color: var(--blue); }
    .w-btn-poll:hover   { background: #bfdbfe; }
    .w-btn-stop   { background: var(--red-dim);    color: var(--red); }
    .w-btn-stop:hover   { background: #fecaca; }
    .w-btn-resume { background: var(--green-dim);  color: var(--green); }
    .w-btn-resume:hover { background: #a7f3d0; }
    .w-btn-remove { background: var(--surface-2);  color: var(--text-3); border: 1px solid var(--border-light); }
    .w-btn-remove:hover { background: var(--border); }
    .w-btn-logs   { background: var(--purple-dim); color: var(--purple); }
    .w-btn-logs:hover   { background: #ddd6fe; }
    @keyframes w-blink { 0%, 80%, 100% { transform: scaleY(1); } 90% { transform: scaleY(0.08); } }
    .w-eye-anim {
      display: inline-flex; align-items: center; margin-left: .4rem;
      color: var(--accent); vertical-align: middle;
    }
    .w-eye-anim svg { animation: w-blink 3.5s ease-in-out infinite; transform-origin: center; }
    .w-empty { text-align: center; color: var(--text-3); padding: 2.5rem 1rem; font-size: .86rem; }
    .w-muted { color: var(--text-3); }
    .w-ticket-link { color: var(--accent); font-weight: 600; text-decoration: none; }
    .w-ticket-link:hover { color: var(--accent-hover); text-decoration: underline; }
    .w-digest-preview { color: var(--text-2); font-size: .79rem; line-height: 1.45; }
    .w-error-row { color: var(--red); font-size: .73rem; margin-top: .3rem; }
    .breadcrumb { font-size: .78rem; color: #64748b; }
    .breadcrumb a { color: #64748b; text-decoration: none; }
    .breadcrumb a:hover { color: #e2e8f0; }
    /* Live progress panel */
    .w-progress {
      background: #0b1120; border: 1px solid #1e3a5f; border-radius: var(--r-lg);
      padding: 1rem 1.25rem; margin-bottom: 2rem;
    }
    .w-progress-head {
      font-weight: 600; font-size: .86rem; color: #7dd3fc; margin-bottom: .75rem;
      display: flex; align-items: center; gap: .5rem; flex-wrap: wrap;
    }
    .w-progress-head a { color: #38bdf8; font-size: .77rem; font-weight: 400; margin-left: auto; text-decoration: none; }
    .w-progress-head a:hover { text-decoration: underline; }
    @keyframes w-spin { to { transform: rotate(360deg); } }
    .w-spinner {
      width: 12px; height: 12px; border: 2px solid #1e3a5f; border-top-color: #38bdf8;
      border-radius: 50%; animation: w-spin .7s linear infinite; flex-shrink: 0;
    }
    .w-log-pre {
      color: #e2e8f0; font-family: ui-monospace, 'Menlo', 'Monaco', monospace;
      font-size: .74rem; line-height: 1.58; white-space: pre-wrap; word-break: break-word;
      margin: 0; max-height: 260px; overflow-y: auto; padding: .5rem .75rem;
      background: #020617; border-radius: var(--r-sm);
    }
    .w-progress-none { color: #475569; font-size: .79rem; font-style: italic; }
  </style>
</head>
<body>
  <header>
    <h1><span class="sun-logo" id="sun-logo"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg></span>Prevoyant Server</h1>
    <span class="version-badge">v${esc(pluginVersion)}</span>
    <span class="meta"></span>
    <a href="/dashboard/activity" class="settings-link">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
      Activity
    </a>
    <a href="/dashboard/watch" class="settings-link" style="color:#fff">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
      Watch
    </a>
    <a href="/dashboard/settings" class="settings-link">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
      Settings
    </a>
  </header>

  <div class="w-wrap">
    <div class="w-header">
      <span class="breadcrumb"><a href="/dashboard">Dashboard</a> › Ticket Watcher</span>
    </div>
    <div class="w-header">
      <span class="w-title">Ticket Watcher</span>
      <span class="w-subtitle">${watching} ticket${watching !== 1 ? 's' : ''} currently being watched</span>
    </div>

    ${flashHtml}

    ${!enabled ? `<div class="w-warn">
      <strong>Ticket Watcher is disabled.</strong>
      Enable it under <a href="/dashboard/settings#ticket-watcher" style="color:#92400e;font-weight:600">Settings → Ticket Watcher</a>
      and set <code>PRX_WATCH_ENABLED=Y</code>.
    </div>` : ''}

    <!-- Live progress panel (shown only when a ticket is actively polling) -->
    <div id="w-progress-panel" style="display:none" class="w-progress">
      <div class="w-progress-head">
        <span class="w-spinner"></span>
        <span id="w-progress-key" style="color:#f0f9ff">Polling…</span>
        <span style="color:#7dd3fc;font-size:.78rem;font-weight:400" id="w-progress-subtitle"></span>
        <a id="w-progress-loglink" href="#" target="_blank">Open full log ↗</a>
      </div>
      <pre class="w-log-pre" id="w-log-pre"><span class="w-progress-none">Waiting for output…</span></pre>
    </div>

    <!-- Add ticket form -->
    <div class="w-add-card">
      <div class="w-add-title">Watch a Jira Ticket</div>
      <form method="POST" action="/dashboard/watch/add">
        <div class="w-form-row">
          <div class="w-field">
            <label class="w-label" for="wf-key">Ticket Key</label>
            <input id="wf-key" name="key" class="w-input" placeholder="e.g. IV-1234" required
                   pattern="[A-Z][A-Z0-9]+-[0-9]+" title="e.g. PROJ-123" autocomplete="off"
                   style="text-transform:uppercase" oninput="this.value=this.value.toUpperCase()">
          </div>
          <div class="w-field">
            <label class="w-label" for="wf-interval">Poll Interval</label>
            <select id="wf-interval" name="interval" class="w-select">
              <option value="1h"${defaultInterval === '1h' ? ' selected' : ''}>Every hour</option>
              <option value="1d"${defaultInterval === '1d' || !defaultInterval ? ' selected' : ''}>Every day</option>
              <option value="2d"${defaultInterval === '2d' ? ' selected' : ''}>Every 2 days</option>
              <option value="5d"${defaultInterval === '5d' ? ' selected' : ''}>Every 5 days</option>
            </select>
          </div>
          <div class="w-field">
            <label class="w-label" for="wf-max">Max Polls</label>
            <input id="wf-max" name="maxPolls" type="number" min="0" class="w-input"
                   value="${esc(defaultMaxPolls)}" placeholder="0" style="width:90px">
            <span class="w-hint">0 = unlimited</span>
          </div>
          <button type="submit" class="w-submit">Start Watching</button>
        </div>
      </form>
    </div>

    <!-- Watched tickets table -->
    <div class="w-table-wrap">
      <div class="w-table-head">
        <span class="w-table-label">Watched Tickets</span>
        <span class="w-count">${tickets.length} total</span>
      </div>
      <table class="w-table">
        <thead>
          <tr>
            <th>Ticket</th>
            <th>Status</th>
            <th>Interval</th>
            <th style="text-align:center">Polls</th>
            <th>Last Polled</th>
            <th>Next Poll</th>
            <th>Last Digest</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  </div>

  <footer class="footer">
    Prevoyant Server v${esc(pluginVersion)} &mdash; Ticket Watcher
  </footer>

  <script>
  (function() {
    var POLL_MS    = 3000;
    var panel      = document.getElementById('w-progress-panel');
    var keyEl      = document.getElementById('w-progress-key');
    var subtitleEl = document.getElementById('w-progress-subtitle');
    var logPre     = document.getElementById('w-log-pre');
    var logLink    = document.getElementById('w-progress-loglink');
    var tbody      = document.querySelector('table.w-table tbody');
    var activeKey  = null;
    var atBottom   = true;

    logPre.addEventListener('scroll', function() {
      atBottom = logPre.scrollTop + logPre.clientHeight >= logPre.scrollHeight - 40;
    });

    function fmtTime(iso) {
      if (!iso) return '—';
      try {
        var d = new Date(iso), now = new Date();
        var diff = Math.floor((now - d) / 1000);
        if (diff < 5)  return 'just now';
        if (diff < 60) return diff + 's ago';
        if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      } catch(e) { return ''; }
    }

    function escHtml(s) {
      return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    function fetchLogTail(key, logFile) {
      if (!logFile) return;
      fetch('/dashboard/watch/' + key + '/log/tail?file=' + encodeURIComponent(logFile))
        .then(function(r){ return r.json(); })
        .then(function(d) {
          logPre.textContent = d.content || '(empty)';
          if (atBottom) { logPre.scrollTop = logPre.scrollHeight; }
        }).catch(function(){});
    }

    function refresh() {
      fetch('/dashboard/watch/json').then(function(r){ return r.json(); }).then(function(tickets) {
        var inflight = tickets.filter(function(t){ return t.pollingNow; });

        if (inflight.length > 0) {
          var t = inflight[0];
          panel.style.display = '';
          keyEl.textContent   = t.key + ' — Polling in progress';
          subtitleEl.textContent = inflight.length > 1 ? '(+' + (inflight.length - 1) + ' more in queue)' : '';
          if (t.lastLogFile) {
            logLink.href = '/dashboard/watch/' + t.key + '/logs/' + encodeURIComponent(t.lastLogFile);
            logLink.style.display = '';
          } else {
            logLink.style.display = 'none';
          }
          activeKey = t.key;
          fetchLogTail(t.key, t.lastLogFile);
        } else {
          panel.style.display = 'none';
          activeKey = null;
        }

        var STATUS_HTML = {
          watching:  '<span class="w-badge w-watching">Watching</span>',
          stopped:   '<span class="w-badge w-stopped">Stopped</span>',
          completed: '<span class="w-badge w-completed">Completed</span>',
        };
        var EYE = '<span class="w-eye-anim" title="Actively watching"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg></span>';

        tickets.forEach(function(t) {
          var row = tbody.querySelector('tr[data-key="' + t.key + '"]');
          if (!row) return;
          row.cells[1].innerHTML = STATUS_HTML[t.status] || escHtml(t.status);
          row.cells[3].textContent = t.pollCount + (t.maxPolls > 0 ? ' / ' + t.maxPolls : '');
          row.cells[4].textContent = t.lastPollAt ? fmtTime(t.lastPollAt) : '—';
          row.cells[5].textContent = t.status === 'watching' && t.nextPollAt ? fmtTime(t.nextPollAt) : '—';
          var eyeSpan = row.cells[0].querySelector('.w-eye-anim');
          if (t.status === 'watching' && !eyeSpan) row.cells[0].insertAdjacentHTML('beforeend', EYE);
          if (t.status !== 'watching' && eyeSpan) eyeSpan.remove();
        });
      }).catch(function(){});
    }

    setInterval(refresh, POLL_MS);
  })();
  </script>
  ${BASE_SCRIPT}
</body>
</html>`;
}

// ── Settings page ─────────────────────────────────────────────────────────────

function fld(key, label, type, val, placeholder, hint, opts) {
  const id = `f_${key}`;
  let input;
  if (type === 'select') {
    const options = opts.map(o =>
      `<option value="${esc(o.v)}"${val === o.v ? ' selected' : ''}>${esc(o.l)}</option>`
    ).join('');
    input = `<select id="${id}" name="${key}" class="s-input">${options}</select>`;
  } else if (type === 'password') {
    input = `<div class="pw-wrap">
      <input type="password" id="${id}" name="${key}" value="${esc(val)}" placeholder="${esc(placeholder || '')}" class="s-input" autocomplete="off">
      <button type="button" class="pw-eye" onclick="togglePw('${id}')" tabindex="-1">
        <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
      </button>
    </div>`;
  } else {
    input = `<input type="${type}" id="${id}" name="${key}" value="${esc(val)}" placeholder="${esc(placeholder || '')}" class="s-input">`;
  }
  return `<div class="s-field">
    <label for="${id}" class="s-label">${esc(label)} <code class="s-key">${key}</code></label>
    ${input}
    ${hint ? `<div class="s-hint">${esc(hint)}</div>` : ''}
  </div>`;
}

function sectionHasValues(keys, vals) {
  return keys.some(k => vals[k] && vals[k] !== '');
}

const NOTIFY_EVENTS = [
  // Jira
  { key: 'jira_assigned',         label: 'Ticket assigned to me',                  group: 'Jira' },
  { key: 'jira_created',          label: 'Relevant ticket created',                group: 'Jira' },
  { key: 'jira_status_changed',   label: 'Ticket status changed to relevant state', group: 'Jira' },
  // Job lifecycle
  { key: 'ticket_scheduled',      label: 'Ticket scheduled for future run',         group: 'Job Lifecycle' },
  { key: 'ticket_queued',         label: 'Ticket added to queue',                   group: 'Job Lifecycle' },
  { key: 'ticket_started',        label: 'Processing started',                      group: 'Job Lifecycle' },
  { key: 'ticket_completed',      label: 'Completed successfully',                  group: 'Job Lifecycle' },
  { key: 'ticket_failed',         label: 'Processing failed',                       group: 'Job Lifecycle' },
  { key: 'ticket_interrupted',    label: 'Job stopped / interrupted',               group: 'Job Lifecycle' },
  { key: 'poll_ran',              label: 'Jira poll scan ran',                      group: 'Job Lifecycle' },
  // Dev pipeline
  { key: 'stage_dev_root_cause',  label: 'Root cause analysis (Step 7)',            group: 'Pipeline — Dev' },
  { key: 'stage_dev_fix',         label: 'Fix proposed (Step 8)',                   group: 'Pipeline — Dev' },
  { key: 'stage_dev_impact',      label: 'Impact analysis (Step 9)',                group: 'Pipeline — Dev' },
  { key: 'stage_dev_report',      label: 'Report generated (Step 12)',              group: 'Pipeline — Dev' },
  // Review pipeline
  { key: 'stage_review_panel',    label: 'Engineering panel complete (R5)',         group: 'Pipeline — Review' },
  { key: 'stage_review_report',   label: 'Review report generated (R8)',            group: 'Pipeline — Review' },
  // Estimate pipeline
  { key: 'stage_est_final',       label: 'Final estimate ready (E5)',               group: 'Pipeline — Estimate' },
  { key: 'stage_est_report',      label: 'Estimate report generated (E5b)',         group: 'Pipeline — Estimate' },
];

function renderSettings(vals, flash) {
  const v = k => vals[k] || '';

  const kbKeys     = ['PRX_KB_MODE','PRX_SOURCE_REPO_URL','PRX_KNOWLEDGE_DIR','PRX_KB_REPO','PRX_KB_LOCAL_CLONE','PRX_KB_KEY','PRX_REALTIME_KB_SYNC','PRX_UPSTASH_REDIS_URL','PRX_UPSTASH_REDIS_TOKEN','PRX_KB_SYNC_MACHINE','PRX_KB_SYNC_POLL_SECS','PRX_KB_SYNC_TRIGGER','PRX_KB_SYNC_DEBOUNCE_SECS'];
  const memKeys    = ['PRX_MEMORY_INDEX_ENABLED','PRX_MEMORY_LIMIT','PRX_REDIS_ENABLED','PRX_REDIS_URL','PRX_REDIS_PASSWORD','PRX_REDIS_PREFIX','PRX_REDIS_TTL_DAYS','PRX_BASIC_MEMORY_ENABLED','BASIC_MEMORY_HOME'];
  const emailKeys  = ['PRX_EMAIL_TO','PRX_SMTP_HOST','PRX_SMTP_PORT','PRX_SMTP_USER','PRX_SMTP_PASS'];
  const bryanKeys  = ['PRX_INCLUDE_SM_IN_SESSIONS_ENABLED','PRX_SKILL_UPGRADE_MIN_SESSIONS','PRX_SKILL_COMPACTION_INTERVAL','PRX_MONTHLY_BUDGET'];
  const autoKeys   = ['AUTO_MODE','FORCE_FULL_RUN','PRX_REPORT_VERBOSITY','PRX_JIRA_PROJECT','PRX_ATTACHMENT_MAX_MB'];
  const reportKeys = ['CLAUDE_REPORT_DIR'];
  const notifyKeys  = ['PRX_NOTIFY_ENABLED','PRX_NOTIFY_LEVEL','PRX_NOTIFY_MUTE_DAYS','PRX_NOTIFY_MUTE_UNTIL','PRX_NOTIFY_EVENTS'];
  const waKeys      = ['PRX_WASENDER_ENABLED','PRX_WASENDER_API_KEY','PRX_WASENDER_TO','PRX_WASENDER_PUBLIC_URL','PRX_WASENDER_EVENTS','PRX_WASENDER_PDF_PASSWORD'];
  const kb = kbStats();

  // Notification-specific values
  const nEnabled   = v('PRX_NOTIFY_ENABLED');
  const nLevel     = v('PRX_NOTIFY_LEVEL') || 'full';
  const nMuteDays  = v('PRX_NOTIFY_MUTE_DAYS') || '0';
  const nMuteUntil = v('PRX_NOTIFY_MUTE_UNTIL');
  const nEvents    = v('PRX_NOTIFY_EVENTS') || NOTIFY_EVENTS.map(e => e.key).join(',');
  const emailTo    = v('PRX_EMAIL_TO');
  const nOpen      = nEnabled === 'Y' || sectionHasValues(notifyKeys, vals);

  // WhatsApp / WaSender values
  const waEnabled  = v('PRX_WASENDER_ENABLED');
  const waEvents   = v('PRX_WASENDER_EVENTS') || NOTIFY_EVENTS.map(e => e.key).join(',');
  const waOpen     = waEnabled === 'Y' || sectionHasValues(waKeys, vals);
  const waChecked  = new Set(waEvents.split(',').map(s => s.trim()).filter(Boolean));

  const checkedEvents = new Set(nEvents.split(',').map(s => s.trim()).filter(Boolean));

  // Group events for rendering
  const eventGroups = {};
  for (const e of NOTIFY_EVENTS) {
    if (!eventGroups[e.group]) eventGroups[e.group] = [];
    eventGroups[e.group].push(e);
  }
  const eventCheckboxes = Object.entries(eventGroups).map(([groupName, events]) => {
    const boxes = events.map(e =>
      `<label class="n-evt-lbl" id="n-evt-lbl-${e.key}">
        <input type="checkbox" class="n-evt-cb" value="${e.key}" ${checkedEvents.has(e.key) ? 'checked' : ''} onchange="syncNotifyEvents()">
        ${esc(e.label)}
      </label>`
    ).join('');
    const groupHint = groupName === 'Jira'
      ? `<span style="font-size:.68rem;color:#b0b7c3;font-weight:400;text-transform:none;letter-spacing:0"> — uses JIRA_USERNAME to match assignee</span>`
      : '';
    return `<div class="n-group">
      <div class="n-group-lbl">${esc(groupName)}${groupHint}</div>
      <div class="n-events-grid">${boxes}</div>
    </div>`;
  }).join('');

  const waEventCheckboxes = Object.entries(eventGroups).map(([groupName, evts]) => {
    const boxes = evts.map(e =>
      `<label class="n-evt-lbl">
        <input type="checkbox" class="wa-evt-cb" value="${e.key}" ${waChecked.has(e.key) ? 'checked' : ''} onchange="syncWaEvents()">
        ${esc(e.label)}
      </label>`
    ).join('');
    return `<div class="n-group">
      <div class="n-group-lbl">${esc(groupName)}</div>
      <div class="n-events-grid">${boxes}</div>
    </div>`;
  }).join('');

  let muteUntilHtml = '';
  if (nMuteUntil) {
    const d = new Date(nMuteUntil);
    if (!isNaN(d)) {
      const isPast = d <= new Date();
      muteUntilHtml = `<div class="n-mute-info ${isPast ? 'n-mute-expired' : 'n-mute-active'}">
        ${isPast ? 'Previous mute expired' : 'Muted until'}: <strong>${d.toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}</strong>
      </div>`;
    }
  }

  const levelDescriptions = {
    full:    '<strong>Full</strong> — one email per event as it happens.',
    compact: '<strong>Compact</strong> — all events batched into a single daily digest email.',
    urgent:  '<strong>Urgent</strong> — failures, errors, and decision prompts only. Event selection is ignored.',
    mute:    '<strong>Mute</strong> — all notifications are suppressed.',
  };

  const flashHtml = flash === 'saved'
    ? `<div class="s-flash s-flash-ok">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        Settings saved successfully.
      </div>`
    : flash === 'error'
    ? `<div class="s-flash s-flash-err">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        Failed to save settings — check server logs.
      </div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Settings — Prevoyant Server</title>
  <style>
    ${BASE_CSS}
    .breadcrumb { font-size:0.8rem; color:#a0a8c0; }
    .breadcrumb a { color:#a0a8c0; text-decoration:none; }
    .breadcrumb a:hover { color:#fff; }
    .settings-wrap { max-width: 800px; margin: 1.75rem auto; padding: 0 1.75rem 4rem; }
    .s-flash {
      display: flex; align-items: center; gap: .6rem;
      padding: .72rem 1rem; border-radius: var(--r-md);
      font-size: .83rem; font-weight: 500; margin-bottom: 1.4rem;
    }
    .s-flash-ok  { background: var(--green-dim); color: #065f46; border: 1px solid #a7f3d0; }
    .s-flash-err { background: var(--red-dim);   color: #7f1d1d; border: 1px solid #fca5a5; }
    .s-section {
      background: var(--surface); border-radius: var(--r-lg);
      box-shadow: var(--shadow); border: 1px solid var(--border-light);
      margin-bottom: 1rem; overflow: hidden;
    }
    .s-section summary {
      list-style: none; display: flex; align-items: center; gap: .6rem;
      padding: .85rem 1.25rem; font-size: .78rem; font-weight: 700;
      text-transform: uppercase; letter-spacing: .07em; color: var(--text-2);
      cursor: pointer; user-select: none;
      border-bottom: 1px solid transparent; transition: background .12s;
    }
    .s-section summary:hover { background: var(--surface-2); }
    details[open] > summary { border-bottom-color: var(--border-light); }
    .s-section summary::-webkit-details-marker { display: none; }
    .s-section summary .s-chevron { margin-left: auto; color: var(--border); transition: transform .2s; }
    details[open] summary .s-chevron { transform: rotate(90deg); color: var(--text-3); }
    .s-section summary .s-req {
      font-size: .65rem; background: var(--red-dim); color: #7f1d1d;
      padding: 1px 6px; border-radius: 4px; font-weight: 600; text-transform: none; letter-spacing: 0;
    }
    .s-section summary .s-opt {
      font-size: .65rem; background: var(--surface-2); color: var(--text-3);
      padding: 1px 6px; border-radius: 4px; font-weight: 600; text-transform: none; letter-spacing: 0;
      border: 1px solid var(--border-light);
    }
    .s-body { padding: 1.25rem; display: grid; grid-template-columns: 1fr 1fr; gap: .9rem 1.2rem; }
    .s-body.full-width { grid-template-columns: 1fr; }
    .s-field { display: flex; flex-direction: column; gap: .3rem; }
    .s-field.span2 { grid-column: span 2; }
    .s-label { font-size: .77rem; font-weight: 600; color: var(--text-2); display: flex; flex-wrap: wrap; align-items: center; gap: .4rem; }
    .s-key {
      font-family: ui-monospace, 'SF Mono', monospace; font-size: .7rem;
      background: var(--surface-2); color: var(--text-3);
      padding: 1px 5px; border-radius: 4px; font-weight: 400;
      border: 1px solid var(--border-light);
    }
    .s-input {
      width: 100%; padding: .45rem .68rem;
      border: 1px solid var(--border); border-radius: var(--r-sm);
      font-size: .84rem; color: var(--text); background: var(--surface);
      transition: border-color .15s, box-shadow .15s; font-family: inherit;
    }
    .s-input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(99,102,241,.1); }
    .s-hint { font-size: .72rem; color: var(--text-3); line-height: 1.55; }
    .pw-wrap { position: relative; }
    .pw-wrap .s-input { padding-right: 2.4rem; }
    .pw-eye {
      position: absolute; right: .5rem; top: 50%; transform: translateY(-50%);
      background: none; border: none; cursor: pointer; color: var(--text-3);
      padding: .2rem; display: flex; align-items: center; transition: color .15s;
    }
    .pw-eye:hover { color: var(--text-2); }
    .s-actions { display: flex; gap: .75rem; align-items: center; margin-top: 1.8rem; flex-wrap: wrap; }
    .btn-save {
      padding: .52rem 1.4rem; background: var(--accent); color: #fff; border: none;
      border-radius: var(--r-md); font-size: .86rem; font-weight: 600;
      cursor: pointer; transition: background .15s; font-family: inherit;
    }
    .btn-save:hover { background: var(--accent-hover); }
    .btn-restart {
      padding: .52rem 1.4rem; background: var(--blue); color: #fff; border: none;
      border-radius: var(--r-md); font-size: .86rem; font-weight: 600;
      cursor: pointer; transition: background .15s; font-family: inherit;
    }
    .btn-restart:hover { background: #1d4ed8; }
    .btn-cancel { font-size: .83rem; color: var(--text-3); text-decoration: none; padding: .52rem .8rem; transition: color .15s; }
    .btn-cancel:hover { color: var(--text-2); }
    @media(max-width:560px){ .s-body { grid-template-columns:1fr; } .s-field.span2 { grid-column:span 1; } }
    .n-warn {
      display: flex; align-items: flex-start; gap: .55rem;
      background: var(--amber-dim); border: 1px solid #fde68a;
      border-radius: var(--r-md); padding: .65rem .9rem;
      font-size: .81rem; color: #92400e; margin-bottom: .4rem;
    }
    .n-warn svg { flex-shrink: 0; margin-top: 1px; color: var(--amber); }
    .n-events-groups { display: flex; flex-direction: column; gap: 1rem; padding: .5rem 0 .2rem; }
    .n-group-lbl {
      font-size: .65rem; font-weight: 700; text-transform: uppercase; letter-spacing: .1em;
      color: var(--text-3); margin-bottom: .45rem;
      display: flex; align-items: center; gap: .5rem;
    }
    .n-group-lbl::after { content: ''; flex: 1; height: 1px; background: var(--border-light); }
    .n-events-grid { display: grid; grid-template-columns: 1fr 1fr; gap: .4rem .9rem; }
    .n-evt-lbl {
      display: flex; align-items: center; gap: .5rem;
      font-size: .81rem; color: var(--text-2); cursor: pointer; user-select: none;
    }
    .n-evt-lbl input[type=checkbox] { width: 14px; height: 14px; cursor: pointer; accent-color: var(--accent); flex-shrink: 0; }
    .n-evt-lbl.disabled { color: var(--text-3); cursor: not-allowed; }
    .n-evt-lbl.disabled input { cursor: not-allowed; }
    .n-sel-all-row { display: flex; align-items: center; gap: .75rem; margin-bottom: .2rem; }
    .n-sel-btn {
      background: none; border: none; color: var(--accent); font-size: .74rem; font-weight: 600;
      cursor: pointer; padding: 0; font-family: inherit; text-decoration: underline;
    }
    .n-sel-btn:hover { color: var(--accent-hover); }
    .n-level-desc {
      font-size: .77rem; color: var(--text-2); background: var(--surface-2);
      border: 1px solid var(--border-light); border-radius: var(--r-sm);
      padding: .55rem .8rem; line-height: 1.58;
    }
    .n-level-desc strong { color: var(--text); }
    .n-mute-info { font-size: .77rem; padding: .45rem .75rem; border-radius: var(--r-sm); margin-top: .35rem; }
    .n-mute-active  { background: var(--purple-dim); color: #5b21b6; border: 1px solid #ddd6fe; }
    .n-mute-expired { background: var(--surface-2);  color: var(--text-3); border: 1px solid var(--border-light); }
    @media(max-width:560px){ .n-events-grid { grid-template-columns:1fr; } }
    .bk-stat-row { display:flex; flex-wrap:wrap; gap:.6rem 1.4rem; margin-bottom:1rem; }
    .bk-stat { display:flex; flex-direction:column; gap:2px; }
    .bk-stat-lbl { font-size:.68rem; font-weight:700; text-transform:uppercase; letter-spacing:.08em; color:#9ca3af; }
    .bk-stat-val { font-size:.88rem; font-weight:600; color:#1a1a2e; }
    .bk-stat-val.muted { color:#b0b7c3; font-weight:400; }
    .bk-path { font-family:monospace; font-size:.76rem; color:#6b7280; background:#f9fafb;
               border:1px solid #e5e7eb; border-radius:6px; padding:.3rem .6rem;
               word-break:break-all; margin-bottom:.85rem; }
    .bk-include-row { display:flex; flex-wrap:wrap; gap:.5rem 1.2rem; margin-bottom:1rem; }
    .bk-inc-lbl { display:flex; align-items:center; gap:.45rem; font-size:.83rem; color:#374151; cursor:pointer; }
    .bk-inc-lbl input { width:15px; height:15px; accent-color:#6366f1; cursor:pointer; }
    .btn-export { display:inline-flex; align-items:center; gap:.5rem; padding:.55rem 1.3rem;
                  background:#6366f1; color:#fff; border:none; border-radius:8px; font-size:.88rem;
                  font-weight:600; cursor:pointer; transition:background .15s; font-family:inherit; }
    .btn-export:hover { background:#4f46e5; }
    .btn-export:disabled { background:#a5b4fc; cursor:not-allowed; }
    .bk-divider { border:none; border-top:1px solid #f0f1f5; margin:1.2rem 0; }
    .bk-import-row { display:flex; align-items:center; gap:.75rem; flex-wrap:wrap; }
    .bk-file-input { font-size:.83rem; color:#374151; }
    .btn-import { display:inline-flex; align-items:center; gap:.5rem; padding:.5rem 1.1rem;
                  background:#1a1a2e; color:#fff; border:none; border-radius:8px; font-size:.85rem;
                  font-weight:600; cursor:pointer; transition:background .15s; font-family:inherit; white-space:nowrap; }
    .btn-import:hover { background:#2d3a5e; }
    .btn-import:disabled { background:#9ca3af; cursor:not-allowed; }
    .bk-import-status { display:none; margin-top:.65rem; padding:.5rem .8rem; border-radius:7px;
                        font-size:.82rem; font-weight:500; border:1px solid transparent; }
    .s-tabs { display:flex; gap:2px; margin-bottom:1.25rem; border-bottom:2px solid var(--border-light); }
    .s-tab { background:none; border:none; border-bottom:2px solid transparent; margin-bottom:-2px;
             padding:.6rem 1.4rem; font-size:.83rem; font-weight:700; letter-spacing:.04em; text-transform:uppercase;
             color:var(--text-3); cursor:pointer; font-family:inherit; transition:color .15s,border-color .15s; }
    .s-tab.active { color:var(--accent); border-bottom-color:var(--accent); }
    .s-tab:hover:not(.active) { color:var(--text-2); }
    .s-tab-pane { display:none; }
    .s-tab-pane.active { display:block; }
  </style>
</head>
<body>
  <header>
    <h1><span class="sun-logo" id="sun-logo"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg></span>Prevoyant Server</h1>
    <span class="version-badge">v${pluginVersion}</span>
    <div class="meta">
      <span class="breadcrumb"><a href="/dashboard">Dashboard</a> › Settings</span>
    </div>
  </header>

  <div class="settings-wrap">
    ${flashHtml}

    <form method="POST" action="/dashboard/settings">
      <input type="hidden" name="_restart" id="_restart" value="0">

      <div class="s-tabs">
        <button type="button" class="s-tab active" onclick="switchSettingsTab('mandatory',this)">Mandatory</button>
        <button type="button" class="s-tab" onclick="switchSettingsTab('optional',this)">Optional</button>
      </div>

      <div id="s-tab-mandatory" class="s-tab-pane active">
      <!-- Repository -->
      <details class="s-section" open>
        <summary>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          Repository
          <span class="s-req">Required</span>
          <span class="s-chevron">›</span>
        </summary>
        <div class="s-body full-width">
          ${fld('PRX_REPO_DIR','Repo Directory','text',v('PRX_REPO_DIR'),'/absolute/path/to/your/repo','Absolute path to local codebase clone. Skill creates branches and searches files here.')}
        </div>
      </details>

      <!-- Jira -->
      <details class="s-section" open>
        <summary>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
          Jira
          <span class="s-req">Required</span>
          <span class="s-chevron">›</span>
        </summary>
        <div class="s-body">
          ${fld('JIRA_URL','Jira URL','text',v('JIRA_URL'),'https://yourcompany.atlassian.net','')}
          ${fld('JIRA_USERNAME','Username','text',v('JIRA_USERNAME'),'firstname.lastname@yourcompany.com','')}
          <div class="s-field span2">
            ${fld('JIRA_API_TOKEN','API Token','password',v('JIRA_API_TOKEN'),'your-jira-api-token','Generate at id.atlassian.com/manage-profile/security/api-tokens')}
          </div>
        </div>
      </details>
      </div><!-- /s-tab-mandatory -->

      <div id="s-tab-optional" class="s-tab-pane">
      <!-- Webhook & Polling -->
      <details class="s-section">
        <summary>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
          Webhook &amp; Polling
          <span class="s-opt">Optional</span>
          <span class="s-chevron">›</span>
        </summary>
        <div class="s-body">
          ${fld('WEBHOOK_PORT','Port','number',v('WEBHOOK_PORT'),'3000','HTTP port this server listens on for incoming Jira webhook events. Default: 3000.')}
          ${fld('WEBHOOK_POLL_INTERVAL_DAYS','Poll Interval (days)','number',v('WEBHOOK_POLL_INTERVAL_DAYS'),'0','How often to run poll-jira.sh as a fallback when no Jira webhook is configured. 0 = disabled (use webhook instead). Fractional values accepted: 0.5 = every 12 h, 0.042 ≈ every hour.')}
          <div class="s-field span2">
            ${fld('WEBHOOK_SECRET','Webhook Secret','password',v('WEBHOOK_SECRET'),'your-strong-secret','Secret token appended to the Jira webhook URL (?token=…). Leave empty to skip validation.')}
          </div>
        </div>
      </details>

      <!-- Knowledge Base -->
      <details class="s-section">
        <summary>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
          Knowledge Base
          <span class="s-opt">Optional</span>
          <span class="s-chevron">›</span>
        </summary>
        <div class="s-body">
          ${fld('PRX_KB_MODE','Mode','select',v('PRX_KB_MODE') || 'local','','',
            [{v:'local',l:'local (default)'},{v:'distributed',l:'distributed (shared git repo)'}])}
          ${fld('PRX_SOURCE_REPO_URL','Source Repo URL','text',v('PRX_SOURCE_REPO_URL'),'https://github.com/myorg/myrepo','Used to cross-check KB file:line refs against the live branch. Omit to skip.')}
          ${fld('PRX_KNOWLEDGE_DIR','KB Directory (local mode)','text',v('PRX_KNOWLEDGE_DIR'),'$HOME/.prevoyant/knowledge-base','Override default KB path. Local mode only.')}
          ${fld('PRX_KB_REPO','KB Repo URL (distributed)','text',v('PRX_KB_REPO'),'git@github.com:yourorg/team-kb.git','Private git repo for shared KB. Required in distributed mode.')}
          ${fld('PRX_KB_LOCAL_CLONE','KB Local Clone (distributed)','text',v('PRX_KB_LOCAL_CLONE'),'$HOME/.prevoyant/kb','Local clone path. Distributed mode only. Keep this path separate from PRX_KNOWLEDGE_DIR — defaults differ on purpose (kb vs knowledge-base) so files do not collide when you switch modes.')}
          <div class="s-field span2">
            ${fld('PRX_KB_KEY','Encryption Key (distributed)','password',v('PRX_KB_KEY'),'your-strong-passphrase','AES-256-CBC passphrase for encrypting KB files. Optional. Never commit this value.')}
          </div>
          <div class="s-field span2" style="border-top:1px solid #e5e7eb;padding-top:1rem;margin-top:.5rem">
            <span class="s-label" style="font-weight:600">Real-time KB Sync <span style="font-size:10px;font-weight:400;color:#6b7280;margin-left:.4rem">Redis doorbell · Git mail carrier · <a href="https://upstash.com/" target="_blank" rel="noopener" style="color:#6b7280">upstash.com</a></span></span>
            <span class="s-hint">Push/pull KB changes across machines the moment a session finishes. Redis carries only a ~100-byte notification (machine, ticket, commit). Git carries the actual KB files. Requires distributed mode.</span>
          </div>
          ${fld('PRX_REALTIME_KB_SYNC','Enable Real-time Sync','select',v('PRX_REALTIME_KB_SYNC') || 'N','','Requires PRX_KB_MODE=distributed and Upstash credentials below.',
            [{v:'N',l:'N — disabled (default)'},{v:'Y',l:'Y — enabled'}])}
          ${(v('PRX_REALTIME_KB_SYNC') === 'Y' && (v('PRX_KB_MODE') || 'local') !== 'distributed') ? `
          <div class="s-field span2" style="margin-top:-.5rem">
            <div style="background:#fef3c7;border:1px solid #f59e0b;border-radius:6px;padding:.5rem .75rem;font-size:.78rem;color:#92400e">
              <strong>Inactive setting:</strong> <code>PRX_REALTIME_KB_SYNC=Y</code> has no effect while <code>PRX_KB_MODE=local</code>.
              Real-time sync only activates in distributed mode. Set <code>PRX_KB_MODE=distributed</code> to enable it, or set <code>PRX_REALTIME_KB_SYNC=N</code> to clear this warning.
            </div>
          </div>` : ''}
          ${fld('PRX_UPSTASH_REDIS_URL','Upstash REST URL','text',v('PRX_UPSTASH_REDIS_URL'),'https://your-endpoint.upstash.io','REST endpoint from console.upstash.com → Database → REST API. Free tier is sufficient.')}
          <div class="s-field">
            ${fld('PRX_UPSTASH_REDIS_TOKEN','Upstash REST Token','password',v('PRX_UPSTASH_REDIS_TOKEN'),'your-token-here','REST token from console.upstash.com. Never commit this value.')}
          </div>
          ${fld('PRX_KB_SYNC_MACHINE','Machine Name','text',v('PRX_KB_SYNC_MACHINE'),require('os').hostname(),'Override hostname used in sync notifications. Useful in Docker or cloud VMs where hostname is unstable.')}
          ${fld('PRX_KB_SYNC_POLL_SECS','Poll Interval (seconds)','text',v('PRX_KB_SYNC_POLL_SECS'),'10','How often each machine checks Redis for new KB updates. Default: 10.')}
          ${fld('PRX_KB_SYNC_TRIGGER','Outbound trigger','select',v('PRX_KB_SYNC_TRIGGER') || 'session','','What triggers an outbound KB notification on this machine.',
            [{v:'session',l:'session — SKILL.md signals after git push (recommended)'},{v:'filesystem',l:'filesystem — watch KB dir for manual edits'},{v:'both',l:'both — session + filesystem'}])}
          ${fld('PRX_KB_SYNC_DEBOUNCE_SECS','Filesystem debounce (seconds)','text',v('PRX_KB_SYNC_DEBOUNCE_SECS'),'3','Seconds to wait after the last file change before committing. filesystem / both triggers only.')}
        </div>
      </details>

      <!-- Backup & Export -->
      <details class="s-section">
        <summary>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Backup &amp; Export
          <span class="s-opt">Optional</span>
          <span class="s-chevron">›</span>
        </summary>
        <div class="s-body full-width">

          <div class="s-field">
            <span class="s-label">Knowledge Base</span>
            <div class="bk-path">${esc(kb.kbDir)}</div>
            <div class="bk-stat-row">
              <div class="bk-stat">
                <span class="bk-stat-lbl">KB files</span>
                <span class="bk-stat-val ${kb.kbFiles === 0 ? 'muted' : ''}">${kb.kbFiles === 0 ? 'none' : kb.kbFiles}</span>
              </div>
              <div class="bk-stat">
                <span class="bk-stat-lbl">Sessions</span>
                <span class="bk-stat-val ${kb.sessionFiles === 0 ? 'muted' : ''}">${kb.sessionFiles === 0 ? 'none' : kb.sessionFiles}</span>
              </div>
              <div class="bk-stat">
                <span class="bk-stat-lbl">Reports</span>
                <span class="bk-stat-val ${kb.reportFiles === 0 ? 'muted' : ''}">${kb.reportFiles === 0 ? 'none' : kb.reportFiles}</span>
              </div>
              <div class="bk-stat">
                <span class="bk-stat-lbl">Server state</span>
                <span class="bk-stat-val ${kb.serverFiles === 0 ? 'muted' : ''}">${kb.serverFiles === 0 ? 'none' : kb.serverFiles}</span>
              </div>
              <div class="bk-stat">
                <span class="bk-stat-lbl">Watch logs</span>
                <span class="bk-stat-val ${kb.watchLogFiles === 0 ? 'muted' : ''}">${kb.watchLogFiles === 0 ? 'none' : kb.watchLogFiles}</span>
              </div>
              <div class="bk-stat">
                <span class="bk-stat-lbl">Memory</span>
                <span class="bk-stat-val ${kb.memoryFiles === 0 ? 'muted' : ''}">${kb.memoryFiles === 0 ? 'none' : kb.memoryFiles}</span>
              </div>
              ${kb.basicMemInsideKb ? '' : `
              <div class="bk-stat">
                <span class="bk-stat-lbl">Agent memory</span>
                <span class="bk-stat-val ${kb.basicMemFiles === 0 ? 'muted' : ''}">${kb.basicMemFiles === 0 ? 'none' : kb.basicMemFiles}</span>
              </div>`}
            </div>
            <div class="s-hint" style="margin-bottom:.7rem">
              Download a <code>.tar.gz</code> archive of all selected items. Extract with
              <code>tar -xzf prevoyant-backup-*.tar.gz</code>.
            </div>

            <div class="bk-include-row">
              <label class="bk-inc-lbl">
                <input type="checkbox" id="bk-inc-kb" checked ${!kb.kbExists ? 'disabled' : ''}>
                Knowledge Base &amp; Agent Memory ${!kb.kbExists ? '<span style="color:#9ca3af">(not found)</span>' : ''}
              </label>
              <label class="bk-inc-lbl">
                <input type="checkbox" id="bk-inc-sessions" ${kb.sessionFiles === 0 ? '' : 'checked'}>
                Session files (${kb.sessionFiles})
              </label>
              <label class="bk-inc-lbl">
                <input type="checkbox" id="bk-inc-reports" ${kb.reportFiles === 0 ? '' : 'checked'}>
                Reports (${kb.reportFiles})
              </label>
              <label class="bk-inc-lbl">
                <input type="checkbox" id="bk-inc-server" ${kb.serverFiles === 0 ? '' : 'checked'}>
                Server state — activity log &amp; watched tickets (${kb.serverFiles})
              </label>
              <label class="bk-inc-lbl">
                <input type="checkbox" id="bk-inc-watchlogs" ${kb.watchLogFiles === 0 ? '' : 'checked'}>
                Watch logs (${kb.watchLogFiles})
              </label>
              <label class="bk-inc-lbl">
                <input type="checkbox" id="bk-inc-memory" ${kb.memoryFiles === 0 ? '' : 'checked'}>
                Agent memory index (${kb.memoryFiles})
              </label>
              ${kb.basicMemInsideKb ? '' : `
              <label class="bk-inc-lbl">
                <input type="checkbox" id="bk-inc-agentmem" ${kb.basicMemFiles === 0 ? '' : 'checked'}>
                Agent memory store — basic-memory MCP (${kb.basicMemFiles})
              </label>`}
              ${kb.cortexInsideKb ? `
              <label class="bk-inc-lbl" style="opacity:.7;cursor:default" title="Cortex is in-KB (distributed mode) — already included with the KB itself.">
                <input type="checkbox" id="bk-inc-cortex" disabled checked>
                Cortex (${kb.cortexFiles}) — bundled with KB (distributed mode)
              </label>` : `
              <label class="bk-inc-lbl">
                <input type="checkbox" id="bk-inc-cortex" ${kb.cortexFiles === 0 ? '' : 'checked'}>
                Cortex — intelligence layer (${kb.cortexFiles})
              </label>`}
            </div>

            <button type="button" class="btn-export" onclick="downloadKbBackup()" ${!kb.kbExists && kb.sessionFiles === 0 && kb.reportFiles === 0 && kb.serverFiles === 0 ? 'disabled' : ''}>
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              Download Backup (.tar.gz)
            </button>
          </div>

          <hr class="bk-divider">

          <div class="s-field">
            <span class="s-label">Import Backup</span>
            <div class="s-hint" style="margin-bottom:.6rem">
              Restore from a <code>.tar.gz</code> backup. Existing files are <strong>never overwritten</strong> —
              only new files not already present on disk are added.
            </div>
            <div class="bk-import-row">
              <input type="file" id="bk-import-file" class="bk-file-input" accept=".tar.gz,.gz"
                     onchange="document.getElementById('btn-import').disabled = !this.files.length">
              <button type="button" id="btn-import" class="btn-import" disabled onclick="importKbBackup()">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="3" x2="12" y2="15"/><polyline points="17 8 12 3 7 8"/></svg>
                Import
              </button>
            </div>
            <div id="bk-import-status" class="bk-import-status"></div>
          </div>

        </div>
      </details>

      <!-- Report Output -->
      <details class="s-section">
        <summary>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          Report Output
          <span class="s-opt">Optional</span>
          <span class="s-chevron">›</span>
        </summary>
        <div class="s-body full-width">
          ${fld('CLAUDE_REPORT_DIR','Reports Directory','text',v('CLAUDE_REPORT_DIR'),'$HOME/.prevoyant/reports','Folder where PDF/HTML reports are saved. Created automatically if missing.')}
        </div>
      </details>

      <!-- Agent Memory -->
      <details class="s-section" id="agent-memory">
        <summary>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
          Agent Memory
          <span class="s-opt">Optional</span>
          <span id="mem-status-badge" style="margin-left:.4rem;font-size:.7rem;padding:.1rem .45rem;border-radius:999px;background:#e5e7eb;color:#374151"></span>
          <span class="s-chevron">›</span>
        </summary>
        <div class="s-body">
          <div class="s-field span2">
            <div class="s-hint" style="margin-top:0">
              Indexes agent learnings, surprises, and running context notes from each session's
              memory file. On each new ticket only the most relevant entries are injected
              (scored by Jira component + label match) — replacing ~700 lines of raw session
              excerpts with a compact ~20-line table (<strong>~96% token reduction</strong>
              on the agent memory section). Supports two backends:
              <br><br>
              <strong>JSON</strong> (local) — single-machine, zero setup, zero dependencies.<br>
              <strong>Redis</strong> (team-shared) — all developers share one memory store
              across machines and parallel sessions. Requires a Redis instance.
            </div>
          </div>

          <div class="s-field span2"><hr style="border:none;border-top:1px solid #e5e7eb;margin:.2rem 0 .8rem"></div>

          <div class="s-field span2" style="font-weight:600;font-size:.8rem;color:#6366f1;margin-bottom:-.3rem">JSON backend (local fallback)</div>
          ${fld('PRX_MEMORY_INDEX_ENABLED','Enable JSON memory','select',v('PRX_MEMORY_INDEX_ENABLED')||'Y','','Local JSON index at ~/.prevoyant/memory/index.json. Used when Redis is disabled or unreachable.',
            [{v:'Y',l:'Y — enabled (default)'},{v:'N',l:'N — disabled'}])}
          ${fld('PRX_MEMORY_LIMIT','Max learnings per prompt','number',v('PRX_MEMORY_LIMIT'),'15','Max indexed entries injected per session prompt. Lower = fewer tokens. Default: 15.')}

          <div class="s-field span2"><hr style="border:none;border-top:1px solid #e5e7eb;margin:.5rem 0 .8rem"></div>

          <div class="s-field span2" style="font-weight:600;font-size:.8rem;color:#6366f1;margin-bottom:-.3rem">Redis backend (team-shared, primary)</div>
          <div class="s-field span2">
            <div class="s-hint" style="margin-top:0">
              Team-shared store — all developers see the same indexed learnings across machines and parallel sessions.
              Takes priority over JSON when connected; JSON stays warm as a hot-standby.
              <br><br>
              <strong>Using the same Upstash instance as KB sync?</strong><br>
              The REST token in <code>PRX_UPSTASH_REDIS_TOKEN</code> is <em>not</em> the Redis password.
              To get the native Redis connection string:
              <ol style="margin:.4rem 0 0 1.1rem;padding:0;line-height:1.8">
                <li>Open your <strong>Upstash Console</strong> → select your database</li>
                <li>Click <strong>Connect</strong> → select the <strong>ioredis</strong> tab</li>
                <li>Copy the <code>rediss://</code> URL — it contains the correct password</li>
                <li>Paste it into <strong>Redis URL</strong> below and leave <strong>Redis password</strong> blank</li>
              </ol>
              <br>Key spaces don't clash — memory uses prefix <code>prx:mem:</code>, KB sync uses its own stream key.
            </div>
          </div>
          ${fld('PRX_REDIS_ENABLED','Enable Redis memory','select',v('PRX_REDIS_ENABLED')||'N','','Team-shared memory via Redis. Takes priority over JSON when connected.',
            [{v:'N',l:'N — disabled (default)'},{v:'Y',l:'Y — enabled'}])}
          ${fld('PRX_REDIS_URL','Redis URL','text',v('PRX_REDIS_URL'),'rediss://default:<password>@<host>:6379','Connection URL. Use rediss:// for TLS (required for Upstash). Embed credentials directly in the URL.')}
          ${fld('PRX_REDIS_PASSWORD','Redis password','password',v('PRX_REDIS_PASSWORD'),'','Leave blank when credentials are already embedded in the URL above (recommended for Upstash).')}
          ${fld('PRX_REDIS_PREFIX','Key prefix','text',v('PRX_REDIS_PREFIX'),'prx:mem:','Namespace prefix for all Redis keys. Change if sharing a Redis instance with other apps.')}
          ${fld('PRX_REDIS_TTL_DAYS','Memory TTL (days)','number',v('PRX_REDIS_TTL_DAYS'),'0','Days before indexed entries expire. 0 = never expire (recommended).')}

          <div class="s-field span2">
            <button type="button" onclick="testRedisConnection()"
              style="padding:.4rem 1rem;background:#1a1a2e;color:#fff;border:none;border-radius:6px;font-size:.78rem;cursor:pointer;font-family:inherit">
              Test Redis connection
            </button>
            <span id="redis-test-result" style="margin-left:.75rem;font-size:.78rem;color:#6b7280"></span>
          </div>

          <div class="s-field span2"><hr style="border:none;border-top:1px solid #e5e7eb;margin:.5rem 0 .8rem"></div>

          <div class="s-field span2" style="font-weight:600;font-size:.8rem;color:#6366f1;margin-bottom:-.3rem">Basic-memory MCP (per-agent personal memory)</div>
          <div class="s-field span2">
            <div class="s-hint" style="margin-top:0">
              Gives each of the 7 agents (Morgan, Alex, Sam, Jordan, Henk, Riley, Bryan) a persistent
              <code>basic-memory</code> MCP project for individual calibration data, corrected assumptions,
              and recurring surprises that belong to the agent rather than the shared KB.
              Storage path resolves automatically from the KB location — override below if needed.
              Requires <code>uvx</code> (already installed in setup step 1/9).
            </div>
          </div>
          ${fld('PRX_BASIC_MEMORY_ENABLED','Enable basic-memory MCP','select',v('PRX_BASIC_MEMORY_ENABLED')||'N','','When enabled, 7 per-agent MCP servers are spawned alongside Jira MCP for every Claude run.',
            [{v:'N',l:'N — disabled (default)'},{v:'Y',l:'Y — enabled'}])}
          ${fld('BASIC_MEMORY_HOME','Storage path (override)','text',v('BASIC_MEMORY_HOME'),'','Optional. Defaults to ~/.prevoyant/personal-memory — kept outside any KB clone so personal memory stays local and never ships with shared KB pushes. Override only if you have a specific reason to relocate it.')}
        </div>
      </details>

      <script>
        async function testRedisConnection() {
          const el = document.getElementById('redis-test-result');
          el.textContent = 'Testing…';
          try {
            const r = await fetch('/dashboard/api/memory-status');
            const d = await r.json();
            if (d.backend === 'redis' && d.connected) {
              el.textContent = '✓ Redis connected — ' + d.total + ' learnings indexed';
              el.style.color = '#16a34a';
            } else if (d.backend === 'redis' && !d.connected) {
              el.textContent = '✗ Redis unreachable — check URL and server';
              el.style.color = '#dc2626';
            } else {
              el.textContent = 'Redis disabled — using ' + (d.backend || 'none');
              el.style.color = '#9ca3af';
            }
          } catch (_) {
            el.textContent = 'Request failed';
            el.style.color = '#dc2626';
          }
        }
        // Auto-load status badge on page open
        (async () => {
          try {
            const r = await fetch('/dashboard/api/memory-status');
            const d = await r.json();
            const badge = document.getElementById('mem-status-badge');
            if (!badge) return;
            if (d.backend === 'redis' && d.connected) {
              badge.textContent = 'Redis ✓';
              badge.style.background = '#dcfce7'; badge.style.color = '#16a34a';
            } else if (d.backend === 'json' && d.connected) {
              badge.textContent = 'JSON ✓';
              badge.style.background = '#eff6ff'; badge.style.color = '#2563eb';
            } else {
              badge.textContent = 'disabled';
            }
          } catch (_) {}
        })();
      </script>

      <!-- Automation -->
      <details class="s-section">
        <summary>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
          Automation
          <span class="s-opt">Optional</span>
          <span class="s-chevron">›</span>
        </summary>
        <div class="s-body">
          ${fld('AUTO_MODE','Auto Mode','select',v('AUTO_MODE') || 'N','','Bypass all interactive gates. Fix is applied automatically to the feature branch.',
            [{v:'N',l:'N — interactive (default)'},{v:'Y',l:'Y — headless / automated'}])}
          ${fld('FORCE_FULL_RUN','Force Full Run','select',v('FORCE_FULL_RUN') || 'N','','Force every step to run in full even on repeat tickets.',
            [{v:'N',l:'N — default'},{v:'Y',l:'Y — force fresh analysis'}])}
          ${fld('PRX_REPORT_VERBOSITY','Report Verbosity','select',v('PRX_REPORT_VERBOSITY') || 'full','','Controls panel dialogue in terminal. PDF always contains full content.',
            [{v:'full',l:'full (default)'},{v:'compact',l:'compact'},{v:'minimal',l:'minimal'}])}
          ${fld('PRX_JIRA_PROJECT','Jira Project','text',v('PRX_JIRA_PROJECT'),'IV','Scope polling to a single project key. Omit to poll all assigned projects.')}
          ${fld('PRX_ATTACHMENT_MAX_MB','Attachment Max MB','number',v('PRX_ATTACHMENT_MAX_MB'),'0','Max size for non-image attachments. 0 = no limit.')}
          ${fld('PRX_RETRY_MAX','Auto-retry on failure','number',v('PRX_RETRY_MAX'),'0','Number of automatic retries after a job fails. 0 = disabled.')}
          ${fld('PRX_RETRY_BACKOFF','Retry backoff (seconds)','number',v('PRX_RETRY_BACKOFF'),'30','Initial wait before first retry. Doubles on each subsequent attempt (exponential backoff).')}
        </div>
      </details>

      <!-- Email Delivery -->
      <details class="s-section">
        <summary>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
          Email Delivery
          <span class="s-opt">Optional</span>
          <span class="s-chevron">›</span>
        </summary>
        <div class="s-body">
          ${fld('PRX_EMAIL_TO','Recipient','text',v('PRX_EMAIL_TO'),'recipient@example.com','Set this to enable email delivery after each report.')}
          ${fld('PRX_SMTP_HOST','SMTP Host','text',v('PRX_SMTP_HOST'),'smtp.gmail.com','smtp.gmail.com or smtp.office365.com')}
          ${fld('PRX_SMTP_PORT','SMTP Port','number',v('PRX_SMTP_PORT'),'587','587 (STARTTLS) or 465 (SSL).')}
          ${fld('PRX_SMTP_USER','SMTP Username','text',v('PRX_SMTP_USER'),'you@gmail.com','')}
          <div class="s-field span2">
            ${fld('PRX_SMTP_PASS','SMTP Password','password',v('PRX_SMTP_PASS'),'app-password','Gmail: generate an App Password when 2-Step Verification is enabled.')}
          </div>
        </div>
      </details>

      <!-- Notifications -->
      <details class="s-section">
        <summary>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
          Notifications
          <span class="s-opt">Optional</span>
          <span class="s-chevron">›</span>
        </summary>
        <div class="s-body full-width">

          <span id="n-email-set-indicator" data-set="${emailTo ? '1' : '0'}" style="display:none"></span>

          <div class="s-field">
            <label for="f_PRX_NOTIFY_ENABLED" class="s-label">Enable email notifications <code class="s-key">PRX_NOTIFY_ENABLED</code></label>
            <select id="f_PRX_NOTIFY_ENABLED" name="PRX_NOTIFY_ENABLED" class="s-input" style="max-width:280px" onchange="onNotifyToggle(this.value)">
              <option value="N"${nEnabled !== 'Y' ? ' selected' : ''}>N — disabled</option>
              <option value="Y"${nEnabled === 'Y' ? ' selected' : ''}>Y — enabled</option>
            </select>
            <div class="s-hint">Requires PRX_EMAIL_TO and SMTP credentials to be configured in Email Delivery above.</div>
          </div>

          <div id="n-email-warn" class="n-warn" style="display:${nEnabled === 'Y' && !emailTo ? '' : 'none'}">
            <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            <span><strong>PRX_EMAIL_TO is not set.</strong> Set a recipient email in the Email Delivery section above before enabling notifications.</span>
          </div>

          <div id="n-config" style="display:${nEnabled === 'Y' ? '' : 'none'}">

            <div class="s-field" style="margin-top:.6rem">
              <label for="f_PRX_NOTIFY_LEVEL" class="s-label">Notification level <code class="s-key">PRX_NOTIFY_LEVEL</code></label>
              <select id="f_PRX_NOTIFY_LEVEL" name="PRX_NOTIFY_LEVEL" class="s-input" style="max-width:340px" onchange="onNotifyLevelChange(this.value)">
                <option value="full"${nLevel === 'full' ? ' selected' : ''}>Full — one email per event</option>
                <option value="compact"${nLevel === 'compact' ? ' selected' : ''}>Compact — daily digest, all events in one mail</option>
                <option value="urgent"${nLevel === 'urgent' ? ' selected' : ''}>Urgent — failures, errors and decision prompts only</option>
                <option value="mute"${nLevel === 'mute' ? ' selected' : ''}>Mute — suppress all notifications</option>
              </select>
              <div id="n-level-desc" class="n-level-desc" style="margin-top:.45rem;max-width:500px">
                ${levelDescriptions[nLevel] || ''}
              </div>
            </div>

            <div id="n-mute-wrap" style="display:${nLevel === 'mute' ? '' : 'none'};margin-top:.6rem">
              <div class="s-field" style="max-width:260px">
                <label for="f_PRX_NOTIFY_MUTE_DAYS" class="s-label">Mute for (days) <code class="s-key">PRX_NOTIFY_MUTE_DAYS</code></label>
                <input type="number" id="f_PRX_NOTIFY_MUTE_DAYS" name="PRX_NOTIFY_MUTE_DAYS" value="${esc(nMuteDays)}" min="0" max="365" placeholder="0" class="s-input">
                <div class="s-hint">0 = mute permanently. 1–365 = mute for N days from time of save.</div>
              </div>
              ${muteUntilHtml}
            </div>

            <div id="n-events-wrap" style="display:${nLevel !== 'mute' && nLevel !== 'urgent' ? '' : 'none'};margin-top:.6rem">
              <input type="hidden" id="n-events-hidden" name="PRX_NOTIFY_EVENTS" value="${esc(nEvents)}">
              <div class="s-field">
                <div class="n-sel-all-row">
                  <span class="s-label" style="margin:0">Events to notify <code class="s-key">PRX_NOTIFY_EVENTS</code></span>
                  <button type="button" class="n-sel-btn" onclick="selectAllEvents(true)">Select all</button>
                  <button type="button" class="n-sel-btn" onclick="selectAllEvents(false)">Deselect all</button>
                </div>
                <div class="s-hint" style="margin-bottom:.5rem">Tick each event that should trigger an email. Jira assignment events match against your JIRA_USERNAME.</div>
                <div class="n-events-groups">${eventCheckboxes}</div>
              </div>
            </div>

          </div>
        </div>
      </details>

      <!-- WhatsApp / WaSender -->
      <details class="s-section">
        <summary>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          WhatsApp Notifications
          <span class="s-opt">Optional — via WaSenderAPI</span>
          <span class="s-chevron">›</span>
        </summary>
        <div class="s-body full-width">

          <div class="s-field">
            <label for="f_PRX_WASENDER_ENABLED" class="s-label">Enable WhatsApp notifications <code class="s-key">PRX_WASENDER_ENABLED</code></label>
            <select id="f_PRX_WASENDER_ENABLED" name="PRX_WASENDER_ENABLED" class="s-input" style="max-width:280px" onchange="document.getElementById('wa-config').style.display=this.value==='Y'?'':'none'">
              <option value="N"${waEnabled !== 'Y' ? ' selected' : ''}>N — disabled</option>
              <option value="Y"${waEnabled === 'Y' ? ' selected' : ''}>Y — enabled</option>
            </select>
            <div class="s-hint">Sends concise WhatsApp alerts for selected events. PDF reports are also delivered as documents when a public URL is configured. Requires a <a href="https://wasenderapi.com" target="_blank" rel="noopener">WaSenderAPI</a> account (free 3-day trial).</div>
          </div>

          <div id="wa-config" style="display:${waEnabled === 'Y' ? '' : 'none'}">

            <div class="s-grid s-grid-2" style="margin-top:.6rem">
              ${fld('PRX_WASENDER_API_KEY','Session API Key','password',v('PRX_WASENDER_API_KEY'),'','Session-specific key from your WaSenderAPI dashboard (Settings → Sessions → API Key).')}
              ${fld('PRX_WASENDER_TO','Recipient phone number','text',v('PRX_WASENDER_TO'),'+1234567890','Include country code, e.g. +23052xxxxxxx. This is the WhatsApp number that receives all notifications.')}
            </div>

            <div class="s-grid s-grid-2" style="margin-top:.6rem">
              <div class="s-field">
                <label for="f_PRX_WASENDER_PUBLIC_URL" class="s-label">Public server URL <code class="s-key">PRX_WASENDER_PUBLIC_URL</code></label>
                <input type="text" id="f_PRX_WASENDER_PUBLIC_URL" name="PRX_WASENDER_PUBLIC_URL" value="${esc(v('PRX_WASENDER_PUBLIC_URL'))}" placeholder="https://yourserver.com" class="s-input">
                <div class="s-hint">Optional. WaSenderAPI fetches the PDF from this URL. Leave blank — reports are auto-uploaded to <strong>tmpfiles.org</strong> (free, 14-day links, no account needed). When a PDF password is set, tmpfiles.org is always used regardless of this field.</div>
              </div>
              ${fld('PRX_WASENDER_PDF_PASSWORD','PDF report password','password',v('PRX_WASENDER_PDF_PASSWORD'),'','Optional. Encrypts PDF reports with this password before sending. Requires <code>qpdf</code> — install with <code>brew install qpdf</code> (Mac) or <code>apt install qpdf</code> (Linux). Leave blank to send unencrypted.')}
            </div>

            <div style="margin-top:.8rem">
              <input type="hidden" id="wa-events-hidden" name="PRX_WASENDER_EVENTS" value="${esc(waEvents)}">
              <div class="s-field">
                <div class="n-sel-all-row">
                  <span class="s-label" style="margin:0">Events to notify <code class="s-key">PRX_WASENDER_EVENTS</code></span>
                  <button type="button" class="n-sel-btn" onclick="selectAllWaEvents(true)">Select all</button>
                  <button type="button" class="n-sel-btn" onclick="selectAllWaEvents(false)">Deselect all</button>
                </div>
                <div class="s-hint" style="margin-bottom:.5rem">Messages are brief one-liners with emoji. Report events also send the PDF as a WhatsApp document (requires Public server URL above).</div>
                <div class="n-events-groups">${waEventCheckboxes}</div>
              </div>
            </div>

          </div>
        </div>
      </details>

      <!-- Bryan -->
      <details class="s-section">
        <summary>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          Bryan — Scrum Master
          <span class="s-opt">Optional</span>
          <span class="s-chevron">›</span>
        </summary>
        <div class="s-body">
          ${fld('PRX_INCLUDE_SM_IN_SESSIONS_ENABLED','Enable Bryan','select',v('PRX_INCLUDE_SM_IN_SESSIONS_ENABLED') || 'N','','Bryan observes sessions and proposes SKILL.md improvements.',
            [{v:'N',l:'N — disabled (default)'},{v:'Y',l:'Y — enabled'}])}
          ${fld('PRX_MONTHLY_BUDGET','Monthly Budget (USD)','number',v('PRX_MONTHLY_BUDGET'),'20.00','Claude subscription budget. Bryan flags at >80% and ≥100%.')}
          ${fld('PRX_SKILL_UPGRADE_MIN_SESSIONS','Min Sessions Before Push','number',v('PRX_SKILL_UPGRADE_MIN_SESSIONS'),'3','Sessions with an approved change before Bryan pushes to main.')}
          ${fld('PRX_SKILL_COMPACTION_INTERVAL','Compaction Interval','number',v('PRX_SKILL_COMPACTION_INTERVAL'),'10','Sessions between full SKILL.md compaction passes.')}
        </div>
      </details>

      <!-- Health Monitor (Watchdog) -->
      <details class="s-section">
        <summary>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
          Health Monitor
          <span class="s-opt">Optional</span>
          <span class="s-chevron">›</span>
        </summary>
        <div class="s-body full-width">
          <div class="s-field">
            <div style="display:flex;align-items:flex-start;gap:.55rem;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:.65rem .9rem;font-size:.82rem;color:#1e40af;margin-bottom:.6rem">
              <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;margin-top:1px"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              <span>Runs as an in-process thread — detects HTTP unresponsiveness, event-loop hangs, and controlled shutdowns.
              Planned stops via <code style="background:#dbeafe;padding:1px 4px;border-radius:3px">stop.sh</code> or
              dashboard restart send a graceful-stop signal so no false alert is fired.
              A hard OS kill (<code style="background:#dbeafe;padding:1px 4px;border-radius:3px">SIGKILL</code> / OOM) cannot be caught by any in-process solution.
              Requires SMTP credentials in the <strong>Email Delivery</strong> section above and <strong>PRX_EMAIL_TO</strong> to be set.
              Changes take effect after <em>Save &amp; Restart</em>.</span>
            </div>
          </div>
          <div class="s-body" style="padding:0;box-shadow:none;background:transparent">
            ${fld('PRX_WATCHDOG_ENABLED','Enable health monitor','select',v('PRX_WATCHDOG_ENABLED') || 'N','','Starts a background thread that polls /health and emails you if the server stops responding.',
              [{v:'N',l:'N — disabled (default)'},{v:'Y',l:'Y — enabled'}])}
            ${fld('PRX_WATCHDOG_INTERVAL_SECS','Check interval (seconds)','number',v('PRX_WATCHDOG_INTERVAL_SECS'),'60','How often to ping /health. Default: 60. Lower values catch outages faster but add noise.')}
            ${fld('PRX_WATCHDOG_FAIL_THRESHOLD','Failure threshold','number',v('PRX_WATCHDOG_FAIL_THRESHOLD'),'3','Consecutive failed checks before sending the DOWN alert. Default: 3. Avoids single-blip false alarms.')}
          </div>
        </div>
      </details>

      <!-- Disk Monitor -->
      <details id="disk-monitor" class="s-section">
        <summary>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>
          Disk Monitor
          <span class="s-opt">Optional</span>
          <span class="s-chevron">›</span>
        </summary>
        <div class="s-body full-width">
          <div class="s-field">
            <div style="display:flex;align-items:flex-start;gap:.55rem;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:.65rem .9rem;font-size:.82rem;color:#1e40af;margin-bottom:.6rem">
              <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;margin-top:1px"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
              <span>Runs as an in-process background thread. Tracks the total size of <code style="background:#dbeafe;padding:1px 4px;border-radius:3px">~/.prevoyant/</code> against a configurable size quota.
              Sends an email alert when the folder size exceeds that quota.
              When the cleanup interval elapses, a notification appears on the <a href="/dashboard/disk" style="color:#1e40af">Disk Monitor page</a> — you must click <em>Approve Cleanup</em> before any files are deleted.
              Cleanup removes session files older than 30 days and trims server logs.
              Changes take effect after <em>Save &amp; Restart</em>.</span>
            </div>
          </div>
          <div class="s-body" style="padding:0;box-shadow:none;background:transparent">
            ${fld('PRX_DISK_MONITOR_ENABLED','Enable disk monitor','select',v('PRX_DISK_MONITOR_ENABLED') || 'N','','Starts a background thread that tracks disk usage and alerts when capacity is low.',
              [{v:'N',l:'N — disabled (default)'},{v:'Y',l:'Y — enabled'}])}
            ${fld('PRX_DISK_MONITOR_INTERVAL_MINS','Check interval (minutes)','number',v('PRX_DISK_MONITOR_INTERVAL_MINS'),'60','How often to measure disk usage. Default: 60 (hourly).')}
            ${fld('PRX_PREVOYANT_MAX_SIZE_MB','Size quota for ~/.prevoyant/ (MB)','number',v('PRX_PREVOYANT_MAX_SIZE_MB'),'500','Maximum allowed size of the ~/.prevoyant/ folder. The alert threshold is a percentage of this value. Default: 500 MB.')}
            ${fld('PRX_DISK_CAPACITY_ALERT_PCT','Alert threshold (% of quota)','number',v('PRX_DISK_CAPACITY_ALERT_PCT'),'80','Send an email alert when ~/.prevoyant/ reaches this percentage of the size quota. E.g. 80% of 500 MB = alert at 400 MB. Default: 80.')}
            ${fld('PRX_DISK_CLEANUP_INTERVAL_DAYS','Cleanup interval (days)','number',v('PRX_DISK_CLEANUP_INTERVAL_DAYS'),'7','How many days between scheduled house-cleaning prompts. Set 0 to disable auto-cleanup prompts. Default: 7.')}
            ${fld('PRX_CPU_ALERT_PCT','CPU spike threshold (%)','number',v('PRX_CPU_ALERT_PCT'),'80','Log a cpu_spike to the activity log when per-process CPU stays above this % for ~6s (3 consecutive samples). Also shows a dashboard alert banner. Default: 80.')}
            ${fld('PRX_RAM_ALERT_PCT','RAM spike threshold (%)','number',v('PRX_RAM_ALERT_PCT'),'85','Log a ram_spike to the activity log when system RAM usage stays above this % for ~6s (3 consecutive samples). Default: 85.')}
          </div>
        </div>
      </details>

      <!-- Ticket Watcher -->
      <details class="s-section" id="ticket-watcher">
        <summary>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          Ticket Watcher
          <span class="s-opt">Optional</span>
          <span class="s-chevron">›</span>
        </summary>
        <div class="s-body" style="padding:0;box-shadow:none;background:transparent">
          <div class="s-field span2">
            <div class="s-hint" style="margin-top:0">
              Watches specified Jira tickets on a recurring schedule. On each poll it reads all comments and attachments,
              calls Claude to produce a progress digest, and emails it to you.
              Watched tickets survive server restarts. Manage them at
              <a href="/dashboard/watch" style="color:#1e40af">Dashboard › Watch</a>.
            </div>
          </div>
          ${fld('PRX_WATCH_ENABLED','Enable ticket watcher','select',v('PRX_WATCH_ENABLED') || 'N','','Starts the background watcher worker.',
            [{v:'N',l:'N — disabled (default)'},{v:'Y',l:'Y — enabled'}])}
          ${fld('PRX_WATCH_POLL_INTERVAL','Default poll interval','select',v('PRX_WATCH_POLL_INTERVAL') || '1d','','Default interval pre-selected when adding a ticket on the Watch page.',
            [{v:'1h',l:'Every hour'},{v:'1d',l:'Every day (default)'},{v:'2d',l:'Every 2 days'},{v:'5d',l:'Every 5 days'}])}
          ${fld('PRX_WATCH_MAX_POLLS','Default max polls','number',v('PRX_WATCH_MAX_POLLS'),'0','Default maximum number of polls per ticket. 0 = unlimited. Pre-filled on the Watch page.')}
          ${fld('PRX_WATCH_LOG_KEEP_DAYS','Log retention (days)','number',v('PRX_WATCH_LOG_KEEP_DAYS') || '30','30','Delete poll log files older than this many days during house-cleaning. Default: 30.')}
          ${fld('PRX_WATCH_LOG_KEEP_PER_TICKET','Max logs per ticket','number',v('PRX_WATCH_LOG_KEEP_PER_TICKET') || '10','10','Keep at most this many log files per ticket (oldest removed first). Default: 10.')}
        </div>
      </details>

      <!-- KB Flow Analyst -->
      <details class="s-section" id="kb-flow-analyst">
        <summary>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/></svg>
          KB Flow Analyst
          <span class="s-opt">Optional</span>
          <span class="s-chevron">›</span>
        </summary>
        <div class="s-body">
          <div class="s-field span2">
            <div class="s-hint" style="margin-top:0">
              Background worker that periodically queries Jira for recent incidents, auto-discovers the
              most-impacted business flows, traces them in the codebase, and proposes Core Mental Map
              updates to <code>~/.prevoyant/knowledge-buildup/kbflow-pending.md</code> for the team to vote on at Step 13j.
              No manual flow configuration is required. Review activity at
              <a href="/dashboard/knowledge-builder" style="color:#1e40af">Dashboard › Knowledge</a>.
            </div>
          </div>
          ${fld('PRX_KBFLOW_ENABLED','Enable KB Flow Analyst','select',v('PRX_KBFLOW_ENABLED') || 'N','','Starts the autonomous KB Flow Analyst worker.',
            [{v:'N',l:'N — disabled (default)'},{v:'Y',l:'Y — enabled'}])}
          ${fld('PRX_KBFLOW_INTERVAL_DAYS','Run interval (days)','text',v('PRX_KBFLOW_INTERVAL_DAYS'),'7','Days between autonomous scan runs. Fractional values supported (0.5 = every 12 h). Minimum: 1. Default: 7.')}
          ${fld('PRX_KBFLOW_LOOKBACK_DAYS','Jira lookback (days)','number',v('PRX_KBFLOW_LOOKBACK_DAYS'),'30','Days of Jira ticket history scanned to identify high-frequency flows. Default: 30.')}
          ${fld('PRX_KBFLOW_MAX_FLOWS','Max flows per run','number',v('PRX_KBFLOW_MAX_FLOWS'),'3','Maximum number of business flows analysed per run. Keeps each run focused. Default: 3.')}
        </div>
      </details>

      <!-- Cortex — Intelligence Layer -->
      <details class="s-section" id="cortex" open>
        <summary>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2z"/><path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2z"/></svg>
          Cortex — Intelligence Layer
          <span class="s-opt">Optional</span>
          <span class="s-chevron">›</span>
        </summary>
        <div class="s-body">
          <div class="s-field span2">
            <div class="s-hint" style="margin-top:0">
              Always-on, self-updating intelligence layer that sits on top of the KB.
              When enabled, the cortex worker watches the KB for changes (debounced) and
              synthesises a curated set of fact files at <code>~/.prevoyant/cortex/facts/*.md</code>
              that AI agents reference in Step 0 of the dev skill — instead of re-reading
              the full KB every session. Optionally augmented by
              <a href="https://github.com/repowise-dev/repowise" target="_blank" rel="noopener">repowise</a>
              for a codebase dependency graph + auto-generated wiki.
              <strong>View accumulated knowledge:</strong> <a href="/dashboard/cortex">→ Cortex page</a>.
            </div>
          </div>
          ${fld('PRX_CORTEX_ENABLED','Enable Cortex','select',v('PRX_CORTEX_ENABLED') || 'N','','Starts the always-on cortex worker.',
            [{v:'N',l:'N — disabled (default)'},{v:'Y',l:'Y — enabled'}])}
          ${fld('PRX_CORTEX_DISTRIBUTED','Distributed (share via KB)','select',v('PRX_CORTEX_DISTRIBUTED') || 'N','','Y → cortex files live inside the KB (`&lt;KB&gt;/cortex/`) and ride along with KB sync (git push or Upstash). Other devs auto-pickup. N → per-machine (~/.prevoyant/cortex/, default).',
            [{v:'N',l:'N — per-machine (default)'},{v:'Y',l:'Y — shared via KB'}])}
          ${fld('PRX_CORTEX_FORCE_BUILDER','Force builder role','select',v('PRX_CORTEX_FORCE_BUILDER') || 'N','','Only meaningful when distributed=Y. Y forces this machine to take over the builder lock even if another machine is actively claiming it — use when the previous builder is offline and you want immediate takeover. Default: N (auto-elect; takeover happens automatically after 10min of silence).',
            [{v:'N',l:'N — auto-elect (default)'},{v:'Y',l:'Y — force this machine as builder'}])}
          ${fld('PRX_CORTEX_DEBOUNCE_SECS','KB-change debounce (secs)','number',v('PRX_CORTEX_DEBOUNCE_SECS'),'30','How long to wait after the last KB change before re-synthesising. Default: 30.')}
          ${fld('PRX_CORTEX_RESYNC_HOURS','Heartbeat resync (hours)','text',v('PRX_CORTEX_RESYNC_HOURS'),'6','Periodic resync interval as a safety net if fs.watch misses a change. Default: 6.')}

          <div class="s-field span2" style="margin-top:.6rem">
            <div class="s-hint" style="margin-top:0;border-top:1px dashed #d1d5db;padding-top:.7rem">
              <strong>Autonomy</strong> — controls how agents can promote observations into the permanent KB without human intervention.
            </div>
          </div>
          ${fld('PRX_CORTEX_AUTONOMY_LEVEL','Autonomy level','select',v('PRX_CORTEX_AUTONOMY_LEVEL') || '0','','0 = manual (all promotions require POST /cortex/memory/promote). 1 = cross-session memory only. 2 = confidence-gated with a review window before promotion. 3 = full-trust, promotes immediately on N confirms.',
            [{v:'0',l:'0 — manual (default)'},{v:'1',l:'1 — cross-session memory'},{v:'2',l:'2 — confidence-gated (review window)'},{v:'3',l:'3 — full-trust (immediate)'}])}
          ${fld('PRX_CORTEX_AUTO_PROMOTE_THRESHOLD','Confirm threshold','number',v('PRX_CORTEX_AUTO_PROMOTE_THRESHOLD'),'3','Number of re-observations (confirmations) of the same key before it becomes eligible for auto-promotion. Default: 3.')}
          ${fld('PRX_CORTEX_AUTO_PROMOTE_DELAY_HOURS','Review window (hours)','number',v('PRX_CORTEX_AUTO_PROMOTE_DELAY_HOURS'),'24','Level 2 only: hours humans have to reject a queued promotion before it is applied. Default: 24.')}
          ${fld('PRX_CORTEX_AUTO_PROMOTE_MIN_AGE_DAYS','Min age before promotion (days)','number',v('PRX_CORTEX_AUTO_PROMOTE_MIN_AGE_DAYS'),'2','Minimum age (days) of an observation before it can be auto-promoted. Prevents recent or noisy observations from entering the KB too fast. Default: 2.')}

          <div class="s-field span2" style="margin-top:.6rem">
            <div class="s-hint" style="margin-top:0;border-top:1px dashed #d1d5db;padding-top:.7rem">
              <strong>Repowise integration</strong> — runs <code>repowise update</code> on a schedule to refresh
              the dependency graph + wiki. Requires Python 3.11+; you can install it from the Cortex page.
            </div>
          </div>
          ${fld('PRX_REPOWISE_ENABLED','Enable repowise','select',v('PRX_REPOWISE_ENABLED') || 'N','','Run repowise updates as part of cortex synthesis.',
            [{v:'N',l:'N — disabled (default)'},{v:'Y',l:'Y — enabled'}])}
          ${fld('PRX_REPOWISE_INTERVAL_DAYS','Repowise run interval (days)','text',v('PRX_REPOWISE_INTERVAL_DAYS'),'1','How often to run repowise. Fractional values supported. Default: 1.')}
          ${fld('PRX_REPOWISE_PATH','Repowise binary path','text',v('PRX_REPOWISE_PATH'),'repowise','Override the command/path used to invoke repowise. Default: `repowise` on PATH.')}
          ${fld('PRX_REPOWISE_AUTO_INSTALL','Auto-install on session start','select',v('PRX_REPOWISE_AUTO_INSTALL') || 'N','','If Y, the plugin SessionStart hook will run the cross-platform installer if repowise is missing.',
            [{v:'N',l:'N — manual install (default)'},{v:'Y',l:'Y — auto-install'}])}
        </div>
      </details>

      <!-- Advanced / disabled-by-default workers -->
      <details class="s-section" id="advanced-workers">
        <summary>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07M8.46 8.46a5 5 0 0 0 0 7.07"/></svg>
          Advanced Workers
          <span class="s-opt">Disabled by default</span>
          <span class="s-chevron">›</span>
        </summary>
        <div class="s-body">

          <!-- Decision-Outcome Linker -->
          <div class="s-field span2" style="border-bottom:1px solid var(--border);padding-bottom:1rem;margin-bottom:.5rem">
            <span class="s-label" style="font-weight:600">Decision-Outcome Linker</span>
            <span class="s-hint">Joins KB decision entries against agent retros and grades each decision <code>CONFIRMED</code>, <code>CONTRADICTED</code>, or <code>PENDING</code>. Proposals go to <code>~/.prevoyant/knowledge-buildup/decision-outcomes.md</code> — nothing is written to the KB directly.</span>
          </div>
          ${fld('PRX_DECISION_OUTCOME_ENABLED','Enable Decision-Outcome Linker','select',v('PRX_DECISION_OUTCOME_ENABLED') || 'N','','Starts the Decision-Outcome Linker background worker.',
            [{v:'N',l:'N — disabled (default)'},{v:'Y',l:'Y — enabled'}])}
          ${fld('PRX_DECISION_OUTCOME_RUN_AT','Run at time (HH:MM)','text',v('PRX_DECISION_OUTCOME_RUN_AT'),'','24-hour clock time to run each day, e.g. 02:00. Deterministic — ignores server start time. Leave blank to use interval-based scheduling.')}
          ${fld('PRX_DECISION_OUTCOME_INTERVAL_DAYS','Run interval (days)','text',v('PRX_DECISION_OUTCOME_INTERVAL_DAYS'),'7','Used when Run at time is blank. Days between runs. Default: 7.')}
          ${fld('PRX_DECISION_OUTCOME_LOOKBACK_DAYS','Retro lookback (days)','number',v('PRX_DECISION_OUTCOME_LOOKBACK_DAYS'),'90','Only consider retros modified within this many days. Default: 90.')}
          ${fld('PRX_DECISION_OUTCOME_MIN_EVIDENCE','Min confirmations for CONFIRMED','number',v('PRX_DECISION_OUTCOME_MIN_EVIDENCE'),'2','Confirmations required to grade a decision CONFIRMED (zero contradictions). Default: 2.')}
          <div class="s-field span2" style="margin-top:4px">
            <button type="button" onclick="decisionOutcomeRunNow()"
              style="font-size:11px;padding:3px 12px;border:1px solid #6366f1;border-radius:6px;background:#eef2ff;color:#4338ca;cursor:pointer">
              ▶ Run now
            </button>
          </div>

          <!-- Stale Branch Detector -->
          <div class="s-field span2" style="border-top:1px solid var(--border);border-bottom:1px solid var(--border);padding:.75rem 0 1rem;margin:.75rem 0 .5rem">
            <span class="s-label" style="font-weight:600">Stale Branch Detector</span>
            <span class="s-hint">Lists feature/fix branches in <code>PRX_REPO_DIR</code>, cross-references against KB sessions and Jira PRs, and flags branches with a completed KB session but no PR. Requires <code>PRX_REPO_DIR</code> and Jira credentials.</span>
          </div>
          ${fld('PRX_STALE_BRANCH_ENABLED','Enable Stale Branch Detector','select',v('PRX_STALE_BRANCH_ENABLED') || 'N','','Starts the Stale Branch Detector background worker.',
            [{v:'N',l:'N — disabled (default)'},{v:'Y',l:'Y — enabled'}])}
          ${fld('PRX_STALE_BRANCH_RUN_AT','Run at time (HH:MM)','text',v('PRX_STALE_BRANCH_RUN_AT'),'','24-hour clock time to run each day, e.g. 03:00. Deterministic — ignores server start time. Leave blank to use interval-based scheduling.')}
          ${fld('PRX_STALE_BRANCH_DAYS','Stale after (days quiet)','number',v('PRX_STALE_BRANCH_DAYS'),'14','Branches with no commit activity for this many days are flagged. Default: 14.')}
          ${fld('PRX_STALE_BRANCH_INTERVAL_DAYS','Run interval (days)','text',v('PRX_STALE_BRANCH_INTERVAL_DAYS'),'1','Used when Run at time is blank. Days between runs. Default: 1.')}
          <div class="s-field span2" style="margin-top:4px">
            <button type="button" onclick="staleBranchRunNow()"
              style="font-size:11px;padding:3px 12px;border:1px solid #6366f1;border-radius:6px;background:#eef2ff;color:#4338ca;cursor:pointer">
              ▶ Run now
            </button>
          </div>

          <!-- Memory Pattern Miner -->
          <div class="s-field span2" style="border-top:1px solid var(--border);border-bottom:1px solid var(--border);padding:.75rem 0 1rem;margin:.75rem 0 .5rem">
            <span class="s-label" style="font-weight:600">Memory Pattern Miner</span>
            <span class="s-hint">Scans agent persona memory files for learnings recurring across 3+ distinct tickets. Candidates go to <code>~/.prevoyant/knowledge-buildup/pattern-proposals.md</code> (PENDING APPROVAL) — nothing is written to the KB directly.</span>
          </div>
          ${fld('PRX_PATTERN_MINER_ENABLED','Enable Pattern Miner','select',v('PRX_PATTERN_MINER_ENABLED') || 'N','','Starts the Memory Pattern Miner background worker.',
            [{v:'N',l:'N — disabled (default)'},{v:'Y',l:'Y — enabled'}])}
          ${fld('PRX_PATTERN_MINER_RUN_AT','Run at time (HH:MM)','text',v('PRX_PATTERN_MINER_RUN_AT'),'','24-hour clock time to run each day, e.g. 04:00. Deterministic — ignores server start time. Leave blank to use interval-based scheduling.')}
          ${fld('PRX_PATTERN_MINER_INTERVAL_DAYS','Run interval (days)','text',v('PRX_PATTERN_MINER_INTERVAL_DAYS'),'7','Used when Run at time is blank. Days between scan runs. Default: 7.')}
          ${fld('PRX_PATTERN_MINER_MIN_TICKETS','Min tickets for pattern','number',v('PRX_PATTERN_MINER_MIN_TICKETS'),'3','Minimum distinct tickets a learning must appear in. Min enforced: 2. Default: 3.')}
          ${fld('PRX_PATTERN_MINER_MAX_PROPOSALS','Max proposals per run','number',v('PRX_PATTERN_MINER_MAX_PROPOSALS'),'20','Maximum proposals written per run. Default: 20.')}
          <div class="s-field span2" style="margin-top:4px">
            <button type="button" onclick="patternMinerRunNow()"
              style="font-size:11px;padding:3px 12px;border:1px solid #6366f1;border-radius:6px;background:#eef2ff;color:#4338ca;cursor:pointer">
              ▶ Run now
            </button>
          </div>

          <!-- KB Staleness Scanner -->
          <div class="s-field span2" style="border-top:1px solid var(--border);border-bottom:1px solid var(--border);padding:.75rem 0 1rem;margin:.75rem 0 .5rem">
            <span class="s-label" style="font-weight:600">KB Staleness Scanner</span>
            <span class="s-hint">Walks all <code>.md</code> files in the KB, extracts <code>ref: file:line</code> references, and checks whether those source files still exist at <code>PRX_REPO_DIR</code>. Stale refs go to <code>~/.prevoyant/knowledge-buildup/stale-refs.md</code>. Requires <code>PRX_REPO_DIR</code>.</span>
          </div>
          ${fld('PRX_STALENESS_ENABLED','Enable Staleness Scanner','select',v('PRX_STALENESS_ENABLED') || 'N','','Starts the KB Staleness Scanner background worker.',
            [{v:'N',l:'N — disabled (default)'},{v:'Y',l:'Y — enabled'}])}
          ${fld('PRX_STALENESS_RUN_AT','Run at time (HH:MM)','text',v('PRX_STALENESS_RUN_AT'),'','24-hour clock time to run each day, e.g. 05:00. Deterministic — ignores server start time. Leave blank to use interval-based scheduling.')}
          ${fld('PRX_STALENESS_INTERVAL_DAYS','Run interval (days)','text',v('PRX_STALENESS_INTERVAL_DAYS'),'7','Used when Run at time is blank. Days between scan runs. Default: 7.')}
          <div class="s-field span2" style="margin-top:4px">
            <button type="button" onclick="stalenessRunNow()"
              style="font-size:11px;padding:3px 12px;border:1px solid #6366f1;border-radius:6px;background:#eef2ff;color:#4338ca;cursor:pointer">
              ▶ Run now
            </button>
          </div>

        </div>
      </details>

      <!-- Hermes Integration -->
      <details class="s-section" id="hermes" onToggle="if(this.open) hermesCheckStatus()">
        <summary>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
          Hermes Integration
          <span class="s-opt">Optional</span>
          <span id="hermes-summary-badge" style="margin-left:6px;font-size:10px;padding:1px 7px;border-radius:10px;display:none"></span>
          <span class="s-chevron">›</span>
        </summary>
        <div class="s-body">
          <!-- Live status row -->
          <div class="s-field span2" id="hermes-status-row" style="display:none">
            <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px">
              <span id="hs-installed"  style="font-size:10px;padding:2px 9px;border-radius:10px;border:1px solid #d1d5db;background:#f3f4f6;color:#374151">Checking…</span>
              <span id="hs-gateway"    style="font-size:10px;padding:2px 9px;border-radius:10px;border:1px solid #d1d5db;background:#f3f4f6;color:#374151">Gateway…</span>
              <span id="hs-skill"      style="font-size:10px;padding:2px 9px;border-radius:10px;border:1px solid #d1d5db;background:#f3f4f6;color:#374151">Skill…</span>
              <button type="button" id="hs-gw-start" onclick="hermesGatewayStart()" style="display:none;font-size:10px;padding:2px 10px;border:1px solid #86efac;border-radius:6px;background:#dcfce7;color:#166534;cursor:pointer">▶ Start Gateway</button>
              <button type="button" id="hs-gw-stop"  onclick="hermesGatewayStop()"  style="display:none;font-size:10px;padding:2px 10px;border:1px solid #fca5a5;border-radius:6px;background:#fee2e2;color:#991b1b;cursor:pointer">■ Stop Gateway</button>
              <button type="button" onclick="hermesCheckStatus()" style="font-size:10px;padding:2px 10px;border:1px solid #d1d5db;border-radius:6px;background:#fff;cursor:pointer;margin-left:auto">Recheck</button>
            </div>
          </div>

          <!-- Installing banner — shown while auto-install is running -->
          <div class="s-field span2" id="hermes-installing-guide" style="display:none">
            <div style="background:#eff6ff;border:1px solid #93c5fd;border-radius:6px;padding:10px 12px;font-size:11px;line-height:1.7;color:#1e3a8a">
              <strong>Installing Hermes CLI…</strong> This runs in the background and takes about 30–60 seconds.<br>
              Check the server console for progress. Click <em>Recheck</em> until the badge turns green.
            </div>
          </div>

          <!-- Install guide — shown only when not installed and not installing -->
          <div class="s-field span2" id="hermes-install-guide" style="display:none">
            <div id="hermes-install-unix" style="background:#fffbeb;border:1px solid #fbbf24;border-radius:6px;padding:10px 12px;font-size:11px;line-height:1.7;color:#78350f">
              <strong>Hermes CLI not found.</strong> Enable Hermes and save — Prevoyant will install it automatically.<br>
              Or install manually:<br>
              <code style="display:block;margin:6px 0;padding:5px 8px;background:#fef3c7;border-radius:4px;font-size:11px;word-break:break-all">curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash</code>
              After manual install, run <code>source ~/.bashrc</code> (or <code>~/.zshrc</code>), then click <em>Recheck</em>.
              Full docs: <a href="https://github.com/nousresearch/hermes-agent" target="_blank" style="color:#92400e">github.com/nousresearch/hermes-agent</a>
            </div>
            <div id="hermes-install-windows" style="display:none;background:#eff6ff;border:1px solid #93c5fd;border-radius:6px;padding:10px 12px;font-size:11px;line-height:1.7;color:#1e3a8a">
              <strong>Hermes CLI not found — Windows manual install required.</strong><br>
              The upstream Hermes installer is a bash script, so auto-install is disabled on Windows.<br>
              Three supported paths:<br>
              &nbsp;&nbsp;1. <strong>WSL2</strong> (recommended) — open Ubuntu/Debian and run:
              <code style="display:block;margin:4px 0;padding:5px 8px;background:#dbeafe;border-radius:4px;font-size:11px;word-break:break-all">curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash</code>
              &nbsp;&nbsp;2. <strong>Git Bash</strong> — same command, but pip/python must already be on the Windows PATH.<br>
              &nbsp;&nbsp;3. <strong>Native build</strong> — clone the repo and follow Windows-specific instructions.<br>
              Then drop the resulting <code>hermes.exe</code> into one of: <code>%LOCALAPPDATA%\\Programs\\hermes\\bin</code>, <code>%USERPROFILE%\\.hermes\\bin</code>, or anywhere on <code>PATH</code>, and click <em>Recheck</em>.<br>
              Full docs: <a href="https://github.com/nousresearch/hermes-agent" target="_blank" style="color:#1d4ed8">github.com/nousresearch/hermes-agent</a>
            </div>
          </div>

          <div class="s-field span2">
            <div class="s-hint" style="margin-top:0">
              Connects Prevoyant to a local <a href="https://github.com/nousresearch/hermes-agent" target="_blank" style="color:#1e40af">Hermes</a> gateway (Nous Research).
              When enabled: Hermes becomes the front door for Jira + GitHub events, calling <code>POST /internal/enqueue</code> here.
              Prevoyant pushes completed job results to <code>GET /internal/jobs/recent-results</code> for Hermes to poll and deliver via Telegram, Slack, Discord.
              Cron scheduling is handed to Hermes; a one-time startup sweep still runs to recover tickets missed while offline.
              The Hermes CLI is installed automatically if not present. The Prevoyant skill is copied to <code>~/.hermes/skills/prevoyant/</code> and the gateway is started — all on save.
              <strong>Route changes require Save &amp; Restart.</strong>
            </div>
          </div>
          ${fld('PRX_HERMES_ENABLED','Enable Hermes','select',v('PRX_HERMES_ENABLED') || 'N','','Switches between standalone mode (cron + direct Jira webhook) and Hermes mode. If the Hermes CLI is not installed, enabling this will auto-install it in the background. Route change requires restart.',
            [{v:'N',l:'N — standalone (default)'},{v:'Y',l:'Y — Hermes as front door'}])}
          ${fld('PRX_HERMES_GATEWAY_URL','Gateway URL','text',v('PRX_HERMES_GATEWAY_URL'),'http://localhost:8080','Base URL of the Hermes gateway. Prevoyant polls /internal/jobs/recent-results via Hermes skill. Default: http://localhost:8080.')}
          ${fld('PRX_HERMES_SECRET','Shared secret','password',v('PRX_HERMES_SECRET'),'','Token Hermes must send in X-Hermes-Secret header when calling /internal/enqueue. Leave blank to skip (trusted network only).')}
          ${fld('PRX_HERMES_JIRA_WRITEBACK','Jira write-back','select',v('PRX_HERMES_JIRA_WRITEBACK') || 'N','','When Y, Prevoyant automatically posts a comment on each Jira ticket when its analysis completes, fails, or is interrupted. Uses the JIRA_URL / JIRA_USERNAME / JIRA_API_TOKEN credentials already configured above.',
            [{v:'N',l:'N — disabled (default)'},{v:'Y',l:'Y — post comment on completion'}])}
        </div>
      </details>

      </div><!-- /s-tab-optional -->

      <div class="s-actions">
        <button type="submit" class="btn-save">Save</button>
        <button type="button" class="btn-restart" onclick="saveAndRestart()">Save &amp; Restart Server</button>
        <a href="/dashboard" class="btn-cancel">Cancel</a>
      </div>
    </form>
  </div>

  <script>
    function togglePw(id) {
      const el = document.getElementById(id);
      el.type = el.type === 'password' ? 'text' : 'password';
    }
    function saveAndRestart() {
      document.getElementById('_restart').value = '1';
      document.querySelector('form').submit();
    }
    function switchSettingsTab(name, btn) {
      document.querySelectorAll('.s-tab-pane').forEach(p => p.classList.remove('active'));
      document.querySelectorAll('.s-tab').forEach(b => b.classList.remove('active'));
      document.getElementById('s-tab-' + name).classList.add('active');
      btn.classList.add('active');
    }

    // ── Hermes status ─────────────────────────────────────────────────────────
    let _hermesPoller = null;
    function hermesCheckStatus() {
      document.getElementById('hermes-status-row').style.display = '';
      fetch('/dashboard/api/hermes-status')
        .then(r => r.json())
        .then(s => {
          const badge = (id, ok, yesLabel, noLabel, pendingLabel) => {
            const el = document.getElementById(id);
            const pending = pendingLabel && s.installing && !ok;
            el.textContent       = pending ? pendingLabel : ok ? yesLabel : noLabel;
            el.style.background  = pending ? '#eff6ff' : ok ? '#dcfce7' : '#fee2e2';
            el.style.borderColor = pending ? '#93c5fd' : ok ? '#86efac' : '#fca5a5';
            el.style.color       = pending ? '#1e40af' : ok ? '#166534' : '#991b1b';
          };
          badge('hs-installed', s.installed, 'Hermes installed', 'Not installed', 'Installing…');
          badge('hs-gateway',   s.gatewayRunning, 'Gateway running',   'Gateway stopped', 'Pending…');
          badge('hs-skill',     s.skillInstalled, 'Skill deployed',    'Skill not deployed', 'Pending…');

          // Show Start/Stop gateway buttons based on state
          const startBtn = document.getElementById('hs-gw-start');
          const stopBtn  = document.getElementById('hs-gw-stop');
          if (s.installed && !s.installing) {
            startBtn.style.display = s.gatewayRunning ? 'none' : '';
            stopBtn.style.display  = s.gatewayRunning ? '' : 'none';
          } else {
            startBtn.style.display = 'none';
            stopBtn.style.display  = 'none';
          }

          // Show correct banner
          document.getElementById('hermes-installing-guide').style.display = s.installing ? '' : 'none';
          document.getElementById('hermes-install-guide').style.display    = (!s.installed && !s.installing) ? '' : 'none';
          // Pick Unix vs Windows variant based on the platform reported by the manager.
          const onWin = s.platform === 'win32';
          document.getElementById('hermes-install-unix').style.display    = onWin ? 'none' : '';
          document.getElementById('hermes-install-windows').style.display = onWin ? '' : 'none';

          // Summary badge in <summary>
          const sb = document.getElementById('hermes-summary-badge');
          sb.style.display     = 'inline';
          sb.style.border      = '1px solid';
          if (s.installing) {
            sb.textContent = 'Installing…'; sb.style.background = '#eff6ff'; sb.style.borderColor = '#93c5fd'; sb.style.color = '#1e40af';
          } else if (s.installed && s.gatewayRunning) {
            sb.textContent = 'Active';        sb.style.background = '#dcfce7'; sb.style.borderColor = '#86efac'; sb.style.color = '#166534';
          } else if (s.installed) {
            sb.textContent = 'Installed';     sb.style.background = '#fef9c3'; sb.style.borderColor = '#fde047'; sb.style.color = '#854d0e';
          } else {
            sb.textContent = 'Not installed'; sb.style.background = '#fee2e2'; sb.style.borderColor = '#fca5a5'; sb.style.color = '#991b1b';
          }

          // Auto-poll every 5 s while install is running; stop once installed.
          if (s.installing && !_hermesPoller) {
            _hermesPoller = setInterval(() => {
              fetch('/dashboard/api/hermes-status').then(r => r.json()).then(s2 => {
                if (!s2.installing) { clearInterval(_hermesPoller); _hermesPoller = null; hermesCheckStatus(); }
              }).catch(() => {});
            }, 5000);
          } else if (!s.installing && _hermesPoller) {
            clearInterval(_hermesPoller); _hermesPoller = null;
          }
        })
        .catch(() => {
          document.getElementById('hs-installed').textContent = 'Status unavailable';
        });
    }
    // Auto-check if section is already open on page load
    if (document.getElementById('hermes') && document.getElementById('hermes').open) {
      hermesCheckStatus();
    }

    function hermesGatewayStart() {
      const btn = document.getElementById('hs-gw-start');
      btn.disabled = true; btn.textContent = 'Starting…';
      fetch('/dashboard/api/hermes-gateway/start', { method: 'POST' })
        .then(r => r.json())
        .then(() => hermesCheckStatus())
        .catch(() => hermesCheckStatus())
        .finally(() => { btn.disabled = false; });
    }

    function hermesGatewayStop() {
      const btn = document.getElementById('hs-gw-stop');
      btn.disabled = true; btn.textContent = 'Stopping…';
      fetch('/dashboard/api/hermes-gateway/stop', { method: 'POST' })
        .then(r => r.json())
        .then(() => hermesCheckStatus())
        .catch(() => hermesCheckStatus())
        .finally(() => { btn.disabled = false; });
    }

    // ── Pattern Miner / Staleness run-now ────────────────────────────────────
    async function patternMinerRunNow() {
      const btn = event.target;
      btn.disabled = true; btn.textContent = 'Queued…';
      try {
        const r = await fetch('/dashboard/settings/pattern-miner/run-now', { method: 'POST' });
        const d = await r.json();
        btn.textContent = d.ok ? '✓ Queued' : (d.error || 'Error');
        btn.style.background = d.ok ? '#dcfce7' : '#fee2e2';
        btn.style.borderColor = d.ok ? '#86efac' : '#fca5a5';
        btn.style.color       = d.ok ? '#166534' : '#991b1b';
      } catch (_) {
        btn.textContent = 'Error';
      }
      setTimeout(() => {
        btn.disabled = false; btn.textContent = '▶ Run now';
        btn.style.background = ''; btn.style.borderColor = ''; btn.style.color = '';
      }, 4000);
    }

    async function stalenessRunNow() {
      const btn = event.target;
      btn.disabled = true; btn.textContent = 'Queued…';
      try {
        const r = await fetch('/dashboard/settings/staleness/run-now', { method: 'POST' });
        const d = await r.json();
        btn.textContent = d.ok ? '✓ Queued' : (d.error || 'Error');
        btn.style.background = d.ok ? '#dcfce7' : '#fee2e2';
        btn.style.borderColor = d.ok ? '#86efac' : '#fca5a5';
        btn.style.color       = d.ok ? '#166534' : '#991b1b';
      } catch (_) {
        btn.textContent = 'Error';
      }
      setTimeout(() => {
        btn.disabled = false; btn.textContent = '▶ Run now';
        btn.style.background = ''; btn.style.borderColor = ''; btn.style.color = '';
      }, 4000);
    }

    async function decisionOutcomeRunNow() {
      const btn = event.target;
      btn.disabled = true; btn.textContent = 'Queued…';
      try {
        const r = await fetch('/dashboard/settings/decision-outcome/run-now', { method: 'POST' });
        const d = await r.json();
        btn.textContent = d.ok ? '✓ Queued' : (d.error || 'Error');
        btn.style.background = d.ok ? '#dcfce7' : '#fee2e2';
        btn.style.borderColor = d.ok ? '#86efac' : '#fca5a5';
        btn.style.color       = d.ok ? '#166534' : '#991b1b';
      } catch (_) {
        btn.textContent = 'Error';
      }
      setTimeout(() => {
        btn.disabled = false; btn.textContent = '▶ Run now';
        btn.style.background = ''; btn.style.borderColor = ''; btn.style.color = '';
      }, 4000);
    }

    async function staleBranchRunNow() {
      const btn = event.target;
      btn.disabled = true; btn.textContent = 'Queued…';
      try {
        const r = await fetch('/dashboard/settings/stale-branch/run-now', { method: 'POST' });
        const d = await r.json();
        btn.textContent = d.ok ? '✓ Queued' : (d.error || 'Error');
        btn.style.background = d.ok ? '#dcfce7' : '#fee2e2';
        btn.style.borderColor = d.ok ? '#86efac' : '#fca5a5';
        btn.style.color       = d.ok ? '#166534' : '#991b1b';
      } catch (_) {
        btn.textContent = 'Error';
      }
      setTimeout(() => {
        btn.disabled = false; btn.textContent = '▶ Run now';
        btn.style.background = ''; btn.style.borderColor = ''; btn.style.color = '';
      }, 4000);
    }

    // ── Notifications ─────────────────────────────────────────────────────────
    const N_LEVEL_DESC = {
      full:    '<strong>Full</strong> — one email per event as it happens.',
      compact: '<strong>Compact</strong> — all events batched into a single daily digest email.',
      urgent:  '<strong>Urgent</strong> — failures, errors, and decision prompts only. Event selection is ignored.',
      mute:    '<strong>Mute</strong> — all notifications are suppressed.',
    };

    function onNotifyToggle(val) {
      const emailSet = document.getElementById('n-email-set-indicator').dataset.set === '1';
      document.getElementById('n-config').style.display      = val === 'Y' ? '' : 'none';
      document.getElementById('n-email-warn').style.display  = (val === 'Y' && !emailSet) ? '' : 'none';
    }

    function onNotifyLevelChange(val) {
      document.getElementById('n-mute-wrap').style.display    = val === 'mute'                       ? '' : 'none';
      document.getElementById('n-events-wrap').style.display  = (val !== 'mute' && val !== 'urgent') ? '' : 'none';
      const descEl = document.getElementById('n-level-desc');
      if (descEl) descEl.innerHTML = N_LEVEL_DESC[val] || '';
    }

    function syncNotifyEvents() {
      const vals = [...document.querySelectorAll('.n-evt-cb')]
        .filter(cb => cb.checked).map(cb => cb.value);
      document.getElementById('n-events-hidden').value = vals.join(',');
    }
    function downloadKbBackup() {
      const sessions  = document.getElementById('bk-inc-sessions').checked  ? '1' : '0';
      const reports   = document.getElementById('bk-inc-reports').checked   ? '1' : '0';
      const server    = document.getElementById('bk-inc-server').checked    ? '1' : '0';
      const watchlogs = document.getElementById('bk-inc-watchlogs').checked ? '1' : '0';
      const memory    = document.getElementById('bk-inc-memory').checked    ? '1' : '0';
      const agentmemEl = document.getElementById('bk-inc-agentmem');
      const agentmem  = agentmemEl && agentmemEl.checked ? '1' : '0';
      const cortexEl  = document.getElementById('bk-inc-cortex');
      const cortex    = cortexEl && cortexEl.checked ? '1' : '0';
      window.location.href = '/dashboard/kb/export?sessions=' + sessions +
        '&reports=' + reports + '&server=' + server +
        '&watchlogs=' + watchlogs + '&memory=' + memory + '&agentmem=' + agentmem +
        '&cortex=' + cortex;
    }

    function importKbBackup() {
      const fileInput = document.getElementById('bk-import-file');
      const file = fileInput.files && fileInput.files[0];
      if (!file) { showImportStatus('error', 'Please select a .tar.gz file.'); return; }

      const btn = document.getElementById('btn-import');
      btn.disabled = true;
      showImportStatus('loading', 'Uploading and importing…');

      fetch('/dashboard/kb/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      })
        .then(r => r.json())
        .then(data => {
          btn.disabled = false;
          if (data.error) { showImportStatus('error', data.error); return; }
          let msg;
          if (data.added > 0 && data.skipped)
            msg = data.added + ' new file(s) imported. Some existing files were kept unchanged.';
          else if (data.added > 0)
            msg = data.added + ' new file(s) imported successfully.';
          else if (data.skipped)
            msg = 'No new files imported — all files already exist on disk.';
          else
            msg = 'Import complete.';
          showImportStatus('ok', msg);
          fileInput.value = '';
        })
        .catch(err => {
          btn.disabled = false;
          showImportStatus('error', 'Import failed: ' + err.message);
        });
    }

    function showImportStatus(type, msg) {
      const el = document.getElementById('bk-import-status');
      const styles = {
        ok:      { bg: '#dcfce7', border: '#bbf7d0', color: '#166534' },
        error:   { bg: '#fee2e2', border: '#fecaca', color: '#991b1b' },
        loading: { bg: '#f9fafb', border: '#e5e7eb', color: '#374151' },
      };
      const s = styles[type] || styles.loading;
      Object.assign(el.style, { display: '', background: s.bg, borderColor: s.border, color: s.color });
      el.textContent = msg;
    }

    function selectAllEvents(select) {
      document.querySelectorAll('.n-evt-cb').forEach(cb => cb.checked = select);
      syncNotifyEvents();
    }
    function syncWaEvents() {
      const vals = [...document.querySelectorAll('.wa-evt-cb:checked')].map(cb => cb.value);
      document.getElementById('wa-events-hidden').value = vals.join(',');
    }
    function selectAllWaEvents(select) {
      document.querySelectorAll('.wa-evt-cb').forEach(cb => cb.checked = select);
      syncWaEvents();
    }
  </script>
  ${BASE_SCRIPT}
</body>
</html>`;
}

// ── Restart page ──────────────────────────────────────────────────────────────

function renderRestartPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Restarting — Prevoyant Server</title>
  <style>
    ${BASE_CSS}
    @keyframes spin { to { transform: rotate(360deg); } }
    body { display:flex; flex-direction:column; min-height:100vh; }
    .restart-box { flex:1; display:flex; flex-direction:column; align-items:center;
                   justify-content:center; gap:1.4rem; padding:2rem; text-align:center; }
    .spinner { width:46px; height:46px; border:4px solid #e2e8f0;
               border-top-color:#0d6efd; border-radius:50%; animation:spin .8s linear infinite; }
    .restart-title { font-size:1.3rem; font-weight:700; color:#1a1a2e; }
    .restart-sub   { font-size:.9rem; color:#64748b; }
    .restart-status { font-size:.8rem; color:#94a3b8; font-family:monospace; }
    #timeout-msg { display:none; }
    #timeout-msg a { color:#0d6efd; }
  </style>
</head>
<body>
  <header>
    <h1><span class="sun-logo" id="sun-logo"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg></span>Prevoyant Server</h1>
    <span class="version-badge">v${pluginVersion}</span>
  </header>
  <div class="restart-box">
    <div class="spinner" id="spinner"></div>
    <div class="restart-title">Server is restarting…</div>
    <div class="restart-sub">Settings saved. Waiting for the server to come back online.</div>
    <div class="restart-status" id="status-msg">Waiting…</div>
    <div id="timeout-msg" style="font-size:.85rem;color:#dc2626">
      Restart is taking longer than expected. <a href="/dashboard">Try refreshing</a> or check the server log.
    </div>
  </div>
  <script>
    const MAX_WAIT = 30000, POLL_MS = 2000;
    const start = Date.now();
    let attempts = 0;
    function poll() {
      attempts++;
      const elapsed = Math.round((Date.now() - start) / 1000);
      document.getElementById('status-msg').textContent = 'Attempt ' + attempts + ' — ' + elapsed + 's elapsed…';
      if (Date.now() - start > MAX_WAIT) {
        document.getElementById('spinner').style.display = 'none';
        document.getElementById('timeout-msg').style.display = '';
        return;
      }
      fetch('/health', { cache: 'no-store' })
        .then(r => { if (r.ok) window.location.replace('/dashboard'); else setTimeout(poll, POLL_MS); })
        .catch(() => setTimeout(poll, POLL_MS));
    }
    setTimeout(poll, 2500);
  </script>
  ${BASE_SCRIPT}
</body>
</html>`;
}

// ── Ticket detail page ────────────────────────────────────────────────────────

function stagePipelineHtml(stages) {
  if (!stages || !stages.length) {
    return `<p style="color:#aaa;font-size:0.9rem;padding:.5rem 0">No stage data yet — stages appear as Claude processes the ticket.</p>`;
  }

  const cards = stages.map((s, i) => {
    const isLast = i === stages.length - 1;
    let icon, cls;
    switch (s.status) {
      case 'active':  icon = ICONS.running(20);  cls = 'stage-active';  break;
      case 'done':    icon = ICONS.success(20);  cls = 'stage-done';    break;
      case 'failed':  icon = ICONS.failed(20);   cls = 'stage-failed';  break;
      case 'skipped': icon = ICONS.skipped(20);  cls = 'stage-skipped'; break;
      default:        icon = ICONS.queued(20);   cls = 'stage-pending'; break;
    }
    const d = s.startedAt ? dur(s.startedAt, s.completedAt || (s.status === 'active' ? null : undefined)) : '';
    return `<div class="pipeline-item">
      <div class="stage-card ${cls}">
        <div class="stage-icon">${icon}</div>
        <div class="stage-name">Step ${s.id}</div>
        <div class="stage-label">${s.label}</div>
        ${s.status === 'skipped' ? '<div class="stage-skipped-badge">Skipped</div>' : ''}
        ${d ? `<div class="stage-dur">${d}</div>` : ''}
      </div>
      ${!isLast ? '<div class="pipeline-arrow">›</div>' : ''}
    </div>`;
  }).join('');

  return `<div class="pipeline-scroll"><div class="pipeline-row">${cards}</div></div>`;
}

function renderDetail(ticket, warn, warnMode) {
  const stages = ticket.stages || [];
  const outputLines = ticket.outputLog || [];
  const reportFiles = ticket.reportFiles || [];
  const currentStage = stages.find(s => s.status === 'active');
  const doneCount = stages.filter(s => s.status === 'done' || s.status === 'failed').length;
  const pdfFiles = reportFiles.filter(f => f.toLowerCase().endsWith('.pdf'));

  // Output section: session log if available, else embedded PDF, else empty state
  let outputSection;
  if (outputLines.length > 0) {
    const logHtml = outputLines.map(l => {
      const ts = new Date(l.ts).toLocaleTimeString('en-GB');
      const isStderr = l.text.startsWith('[stderr]');
      const isResult = l.text.startsWith('[Result]');
      let bodyHtml;
      if (isStderr) {
        const t = l.text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        bodyHtml = `<span class="log-stderr">${t}</span>`;
      } else if (isResult) {
        const t = l.text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        bodyHtml = `<span class="log-result">${t}</span>`;
      } else {
        bodyHtml = renderMarkdown(l.text);
      }
      return `<div class="log-entry"><div class="log-ts">${ts}</div><div class="log-body">${bodyHtml}</div></div>`;
    }).join('');
    outputSection = `
      <button class="output-toggle" onclick="toggleOutput()">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
        <span id="toggle-label">View Output</span> (<span id="output-count">${outputLines.length}</span> entries)
      </button>
      <div id="output-box" class="output-box">${logHtml}</div>`;
  } else if (pdfFiles.length > 0) {
    const enc = encodeURIComponent(pdfFiles[0]);
    outputSection = `
      <p style="font-size:0.82rem;color:#888;margin-bottom:.75rem">No live session captured. Showing saved report:</p>
      <iframe src="/dashboard/view?path=${enc}" style="width:100%;height:620px;border:none;border-radius:10px;box-shadow:0 1px 4px rgba(0,0,0,.12)"></iframe>`;
  } else {
    outputSection = `<p style="color:#bbb;font-size:0.85rem">No session output and no report found for this ticket.</p>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Prevoyant — ${ticket.ticketKey}</title>
  <style>
    ${BASE_CSS}
    .page { max-width:1400px; margin:0 auto; padding:1.5rem 2rem 3rem; }
    .topbar { display:flex; align-items:flex-start; gap:1rem; margin-bottom:1.5rem; flex-wrap:wrap; }
    .back-btn { display:inline-flex; align-items:center; gap:6px; padding:6px 14px; background:#fff;
                border:1px solid #dde; border-radius:8px; font-size:0.82rem; color:#444; text-decoration:none;
                font-weight:500; box-shadow:0 1px 2px rgba(0,0,0,.06); transition:background .15s; white-space:nowrap; }
    .back-btn:hover { background:#f0f1f5; }
    .ticket-title { font-size:1.5rem; font-weight:700; letter-spacing:-0.02em; display:flex; align-items:center; gap:.5rem; flex-wrap:wrap; }
    .ticket-meta  { font-size:0.82rem; color:#888; display:flex; gap:1.5rem; flex-wrap:wrap; margin-top:.4rem; }
    .panel { background:#fff; border-radius:12px; box-shadow:0 1px 3px rgba(0,0,0,.08); margin-bottom:1.25rem; }
    .panel-header { padding:.85rem 1.25rem; border-bottom:1px solid #f0f1f5; display:flex; align-items:center; gap:.75rem; }
    .panel-header h2 { font-size:0.82rem; font-weight:600; text-transform:uppercase; letter-spacing:.07em; color:#666; flex:1; }
    .panel-body { padding:1.25rem; }
    .pipeline-scroll { overflow-x:auto; padding-bottom:.5rem; }
    .pipeline-row { display:flex; align-items:center; min-width:max-content; }
    .pipeline-item { display:flex; align-items:center; }
    .stage-card { width:108px; padding:.7rem .5rem; border-radius:10px; border:2px solid transparent;
                  display:flex; flex-direction:column; align-items:center; gap:4px; }
    .stage-icon { display:flex; align-items:center; justify-content:center; }
    .stage-name  { font-size:0.7rem; font-weight:700; color:#666; }
    .stage-label { font-size:0.72rem; color:#888; text-align:center; line-height:1.3; }
    .stage-dur   { font-size:0.68rem; color:#aaa; margin-top:2px; }
    .stage-pending { background:#f9fafb; border-color:#e5e7eb; }
    .stage-active  { background:#eff6ff; border-color:#93c5fd; box-shadow:0 0 0 3px #dbeafe; }
    .stage-done    { background:#f0fdf4; border-color:#86efac; }
    .stage-failed  { background:#fef2f2; border-color:#fca5a5; }
    .stage-skipped { background:#f9fafb; border-color:#e5e7eb; opacity:0.55; }
    .stage-skipped-badge { font-size:0.6rem; font-weight:600; text-transform:uppercase; letter-spacing:.05em;
                           color:#9ca3af; background:#e5e7eb; border-radius:4px; padding:1px 5px; margin-top:2px; }
    .pipeline-arrow { font-size:1.2rem; color:#d1d5db; padding:0 4px; }
    .progress-wrap { background:#f0f1f5; border-radius:99px; height:6px; overflow:hidden; margin-top:1rem; }
    .progress-bar  { height:100%; border-radius:99px; background:linear-gradient(90deg,#0d6efd,#198754); transition:width .4s; }
    .output-toggle { display:inline-flex; align-items:center; gap:6px; padding:7px 16px; background:#1a1a2e;
                     color:#fff; border:none; border-radius:8px; font-size:0.82rem; font-weight:500; cursor:pointer; }
    .output-toggle:hover { background:#2d3a5e; }
    .output-box { display:none; margin-top:1rem; background:#0f1117; border-radius:10px; padding:1.2rem 1.4rem;
                  max-height:620px; overflow-y:auto; }
    .output-box.open { display:block; }
    .log-entry  { padding:6px 0; border-bottom:1px solid #1e2130; }
    .log-entry:last-child { border-bottom:none; }
    .log-ts     { font-family:monospace; font-size:0.7rem; color:#4b5563; margin-bottom:3px; }
    .log-body   { color:#d1d5db; font-size:0.82rem; line-height:1.65; }
    .log-body h1,.log-body h2,.log-body h3 { color:#93c5fd; margin:10px 0 4px; font-size:0.9rem; border-bottom:1px solid #1e3a5f; padding-bottom:3px; }
    .log-body h4,.log-body h5 { color:#7dd3fc; margin:8px 0 2px; font-size:0.83rem; }
    .log-body pre  { background:#1a1f2e; border:1px solid #2d3a5e; border-radius:6px; padding:10px 12px;
                     overflow-x:auto; margin:8px 0; }
    .log-body code { background:#1a1f2e; padding:1px 5px; border-radius:3px; font-family:monospace;
                     font-size:0.78rem; color:#a5f3fc; }
    .log-body pre code { background:none; padding:0; color:#e2e8f0; font-size:0.77rem; white-space:pre; }
    .log-body strong { color:#fbbf24; }
    .log-body em     { color:#c4b5fd; }
    .log-body table  { border-collapse:collapse; margin:8px 0; font-size:0.78rem; width:100%; }
    .log-body th     { background:#1e2d40; color:#93c5fd; padding:5px 10px; border:1px solid #2d3a5e; }
    .log-body td     { padding:4px 10px; border:1px solid #1e2130; }
    .log-body hr     { border:none; border-top:1px solid #2d3a5e; margin:10px 0; }
    .log-body blockquote { border-left:3px solid #3b82f6; padding-left:10px; color:#94a3b8; margin:6px 0; }
    .log-body ul,.log-body ol { padding-left:1.4rem; margin:4px 0; }
    .log-body li    { margin:2px 0; }
    .log-stderr { color:#f87171; font-family:monospace; font-size:0.77rem; }
    .log-result { color:#4ade80; font-family:monospace; font-size:0.77rem; font-weight:600; }
    .dl-btn { display:inline-flex; align-items:center; gap:4px; padding:5px 12px; background:#1a1a2e;
              color:#fff; border-radius:8px; font-size:0.8rem; text-decoration:none; font-weight:500; transition:background .15s; }
    .dl-btn:hover { background:#2d3a5e; }
    .warn-banner { background:#fffbeb; border:1.5px solid #f59e0b; border-radius:10px;
                   padding:1rem 1.25rem; margin-bottom:1.25rem; }
    .warn-banner h3 { font-size:0.88rem; font-weight:700; color:#92400e; margin-bottom:.5rem;
                      display:flex; align-items:center; gap:.4rem; }
    .warn-banner p  { font-size:0.82rem; color:#78350f; margin-bottom:.5rem; line-height:1.5; }
    .warn-banner code { background:#fef3c7; padding:2px 6px; border-radius:4px; font-family:monospace;
                        font-size:0.8rem; color:#92400e; word-break:break-all; }
    .warn-banner ol { font-size:0.82rem; color:#78350f; padding-left:1.3rem; line-height:1.8; }
    .warn-banner .warn-actions { display:flex; align-items:center; gap:.75rem; margin-top:.9rem; flex-wrap:wrap; }
    .force-btn { display:inline-flex; align-items:center; gap:6px; padding:7px 18px; background:#d97706;
                 color:#fff; border:none; border-radius:8px; font-size:0.82rem; font-weight:600;
                 cursor:pointer; transition:background .15s; }
    .force-btn:hover { background:#b45309; }
    .run-panel { display:flex; align-items:center; gap:1rem; flex-wrap:wrap; }
    .run-panel label { font-size:0.82rem; color:#555; font-weight:500; }
    .mode-btn-group { display:flex; gap:.4rem; }
    .mode-btn { padding:6px 18px; border:2px solid #d1d5db; border-radius:8px; background:#fff;
                font-size:0.82rem; font-weight:600; cursor:pointer; transition:all .15s; color:#555; }
    .mode-btn.selected { border-color:#0d6efd; background:#eff6ff; color:#1d4ed8; }
    .mode-btn:hover:not(.selected) { border-color:#9ca3af; background:#f9fafb; }
    .run-submit { display:inline-flex; align-items:center; gap:6px; padding:8px 20px; background:#16a34a;
                  color:#fff; border:none; border-radius:8px; font-size:0.85rem; font-weight:600;
                  cursor:pointer; transition:background .15s; }
    .run-submit:hover { background:#15803d; }
    .run-submit:disabled { background:#d1d5db; color:#9ca3af; cursor:not-allowed; }
    .stop-submit { display:inline-flex; align-items:center; gap:6px; padding:8px 20px; background:#dc2626;
                   color:#fff; border:none; border-radius:8px; font-size:0.82rem; font-weight:500; cursor:pointer; transition:background .15s; }
    .stop-submit:hover { background:#b91c1c; }
  </style>
</head>
<body>
  <header>
    <h1><span class="sun-logo" id="sun-logo"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg></span>Prevoyant Server</h1>
    <span class="version-badge">v${pluginVersion}</span>
    <div class="meta" style="flex:1"></div>
  </header>

  <div class="page">
    <div class="topbar">
      <a href="/dashboard" class="back-btn">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        Dashboard
      </a>
      <div>
        <div class="ticket-title">
          <span id="status-icon">${(ICONS[ticket.status] || ICONS.queued)(22)}</span>
          ${ticket.ticketKey}
          <span id="status-badge" class="badge badge-${ticket.status}" style="font-size:0.85rem">${ticket.status}</span>
          ${modeBadge(ticket.mode)}
        </div>
        <div class="ticket-meta">
          <span>Source: <strong>${ticket.source}</strong></span>
          <span>Queued: <strong>${fmt(ticket.queuedAt)}</strong></span>
          ${ticket.startedAt    ? `<span>Started: <strong>${fmt(ticket.startedAt)}</strong></span>`    : ''}
          ${ticket.completedAt  ? `<span>Finished: <strong>${fmt(ticket.completedAt)}</strong></span>` : ''}
          <span>Duration: <strong id="duration-val">${dur(ticket.startedAt, ticket.completedAt)}</strong></span>
        </div>
      </div>
    </div>

    <div id="interrupt-banner"
         class="interrupt-banner interrupt-banner-${ticket.interruptReason || 'manual'}"
         ${ticket.status !== 'interrupted' ? 'style="display:none"' : ''}>
      ${interruptBannerIcon(ticket.interruptReason)}
      <div>
        <strong>Job Interrupted</strong>
        <p class="interrupt-reason-text">${interruptReasonMessage(ticket.interruptReason)}</p>
      </div>
    </div>

    ${warn === 'seen' ? (() => {
      const safeKey = ticket.ticketKey.replace(/[^A-Za-z0-9_-]/g, '');
      const chosenMode = warnMode || ticket.mode || 'dev';
      const seenFile   = config.seenCacheFile;
      return `
    <div class="warn-banner">
      <h3>
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none"
             stroke="#d97706" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
          <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
        Ticket is in the seen-tickets cache
      </h3>
      <p><strong>${safeKey}</strong> is recorded in <code>${seenFile}</code>.
        The polling script skips tickets already in this file, so re-running from the dashboard
        will still work — but if you also want <code>poll-jira.sh</code> to pick it up again automatically,
        you need to remove it from the cache first.</p>
      <ol>
        <li>Remove just this ticket:<br>
            <code>sed -i '' '/^${safeKey}$/d' "${seenFile}"</code></li>
        <li>Or clear the entire cache (all tickets will be re-evaluated on next poll):<br>
            <code>truncate -s 0 "${seenFile}"</code></li>
      </ol>
      <div class="warn-actions">
        <form method="POST" action="/dashboard/ticket/${encodeURIComponent(ticket.ticketKey)}/run">
          <input type="hidden" name="mode"  value="${chosenMode}">
          <input type="hidden" name="force" value="1">
          <button type="submit" class="force-btn">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24"
                 fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            Force Run &amp; remove from cache
          </button>
        </form>
        <span style="font-size:0.78rem;color:#92400e">
          This removes <strong>${safeKey}</strong> from the seen-tickets file and starts the job now.
        </span>
      </div>
    </div>`;
    })() : ''}

    <!-- Pipeline -->
    <div class="panel">
      <div class="panel-header">
        <h2>Pipeline</h2>
        <span id="pipeline-meta" style="font-size:0.78rem;color:#888;display:flex;align-items:center;gap:.75rem">
          ${stages.length ? `<span id="stage-count">${doneCount} / ${stages.length} stages</span>` : ''}
          ${currentStage ? `<span id="current-stage" style="color:#0d6efd">Currently: Step ${currentStage.id} — ${currentStage.label}</span>` : ''}
        </span>
      </div>
      <div class="panel-body">
        <div id="pipeline-content">${stagePipelineHtml(stages)}</div>
        ${stages.length ? `<div class="progress-wrap"><div id="progress-bar" class="progress-bar" style="width:${Math.round(doneCount / stages.length * 100)}%"></div></div>` : ''}
      </div>
    </div>

    <!-- Reports -->
    ${reportFiles.length ? `
    <div class="panel">
      <div class="panel-header"><h2>Reports</h2></div>
      <div class="panel-body" style="display:flex;gap:1rem;flex-wrap:wrap">
        ${reportFiles.map(f => {
          const ext = path.extname(f).toUpperCase().replace('.', '');
          const base = path.basename(f);
          const enc = encodeURIComponent(f);
          return `<a href="/dashboard/download?path=${enc}" class="dl-btn">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Download ${ext} — ${base}
          </a>`;
        }).join('')}
      </div>
    </div>` : ''}

    <!-- Re-run -->
    <div class="panel">
      <div class="panel-header"><h2>Run</h2></div>
      <div class="panel-body">
        <form method="POST" action="/dashboard/ticket/${encodeURIComponent(ticket.ticketKey)}/run"
              class="run-panel" onsubmit="return confirmDetailRun(this)">
          <label>Mode:</label>
          <div class="mode-btn-group" id="mode-group">
            ${['dev','review','estimate'].map(m => `
              <button type="button" class="mode-btn${(ticket.mode || 'dev') === m ? ' selected' : ''}"
                      onclick="selectMode('${m}')">${m.charAt(0).toUpperCase() + m.slice(1)}</button>`).join('')}
          </div>
          <input type="hidden" name="mode" id="mode-input" value="${ticket.mode || 'dev'}">
          <button type="submit" class="run-submit" ${ticket.status === 'running' || ticket.status === 'queued' ? 'disabled' : ''}>
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24"
                 fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            ${ticket.status === 'running' ? 'Running…' : ticket.status === 'queued' ? 'Queued…' : 'Run'}
          </button>
          ${ticket.status === 'running' || ticket.status === 'queued' ? `
          <form method="POST" action="/dashboard/ticket/${encodeURIComponent(ticket.ticketKey)}/stop"
                style="display:inline" onsubmit="return confirm('Stop this job?')">
            <button type="submit" class="stop-submit">
              <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24"
                   fill="currentColor"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
              Stop Job
            </button>
          </form>` : ''}
        </form>
      </div>
    </div>

    <!-- Claude session output / PDF fallback -->
    <div class="panel">
      <div class="panel-header">
        <h2>View Output</h2>
        <a href="/dashboard/ticket/${encodeURIComponent(ticket.ticketKey)}/log.txt"
           download="${ticket.ticketKey}-output.txt"
           style="display:inline-flex;align-items:center;gap:.35rem;font-size:.76rem;color:#6b7280;text-decoration:none;padding:.2rem .6rem;border:1px solid #e5e7eb;border-radius:5px;white-space:nowrap"
           title="Download full output log as .txt">
          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Download log
        </a>
      </div>
      <div class="panel-body">
        <div style="display:flex;align-items:center;gap:.6rem;margin-bottom:.6rem">
          <input type="text" id="output-search" placeholder="Search output…" oninput="filterOutput(this.value)"
                 style="flex:1;padding:.35rem .75rem;border:1px solid #e5e7eb;border-radius:6px;font-size:.82rem;font-family:inherit;outline:none">
          <span id="output-match-count" style="font-size:.75rem;color:#9ca3af;white-space:nowrap;min-width:6rem;text-align:right"></span>
        </div>
        ${outputSection}
      </div>
    </div>
  </div>

  <div class="footer">Prevoyant Server v${pluginVersion}</div>

  <script>
    function toggleOutput() {
      const box = document.getElementById('output-box');
      const lbl = document.getElementById('toggle-label');
      const open = box.classList.toggle('open');
      lbl.textContent = open ? 'Hide Output' : 'View Output';
      if (open) box.scrollTop = box.scrollHeight;
    }
    function filterOutput(q) {
      const entries = document.querySelectorAll('#output-box .log-entry');
      const term = q.trim().toLowerCase();
      let matches = 0;
      entries.forEach(el => {
        const show = !term || el.textContent.toLowerCase().includes(term);
        el.style.display = show ? '' : 'none';
        if (show && term) matches++;
      });
      const cnt = document.getElementById('output-match-count');
      if (cnt) cnt.textContent = term ? matches + ' match' + (matches === 1 ? '' : 'es') : '';
    }
    function selectMode(mode) {
      document.getElementById('mode-input').value = mode;
      document.querySelectorAll('#mode-group .mode-btn').forEach(b => {
        b.classList.toggle('selected', b.textContent.trim().toLowerCase() === mode);
      });
    }
    function confirmDetailRun(form) {
      const mode = document.getElementById('mode-input').value;
      return confirm('Run ${ticket.ticketKey} in ' + mode + ' mode?');
    }

    // Live polling — updates dynamic parts without a full page reload
    (function () {
      const ACTIVE = ['running', 'queued'];
      const ticketKey = ${JSON.stringify(ticket.ticketKey)};
      let knownOutputCount = ${outputLines.length};

      if (!ACTIVE.includes(${JSON.stringify(ticket.status)})) return;

      const timer = setInterval(async () => {
        let data;
        try {
          const res = await fetch('/dashboard/ticket/' + encodeURIComponent(ticketKey) + '/partial?since=' + knownOutputCount);
          if (!res.ok) return;
          data = await res.json();
        } catch (_) { return; }

        // Pipeline
        const pc = document.getElementById('pipeline-content');
        if (pc) pc.innerHTML = data.pipelineHtml;

        const pb = document.getElementById('progress-bar');
        if (pb) pb.style.width = data.progressPct + '%';

        const sc = document.getElementById('stage-count');
        if (sc) sc.textContent = data.doneCount + ' / ' + data.totalStages + ' stages';

        const cs = document.getElementById('current-stage');
        if (data.currentStageLabel) {
          if (cs) { cs.textContent = 'Currently: ' + data.currentStageLabel; cs.style.display = ''; }
        } else if (cs) { cs.style.display = 'none'; }

        // Duration
        const dv = document.getElementById('duration-val');
        if (dv && data.duration) dv.textContent = data.duration;

        // Output — append only new entries to preserve scroll and open state
        if (data.newLogEntries && data.newLogEntries.length) {
          const box = document.getElementById('output-box');
          if (box) {
            const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
            box.insertAdjacentHTML('beforeend', data.newLogEntries.join(''));
            if (atBottom) box.scrollTop = box.scrollHeight;
          }
          knownOutputCount += data.newLogEntries.length;
          const oc = document.getElementById('output-count');
          if (oc) oc.textContent = knownOutputCount;
        }

        // Status badge + icon
        if (data.status) {
          const badge = document.getElementById('status-badge');
          if (badge) {
            badge.className = 'badge badge-' + data.status;
            const labels = { queued: 'queued', running: 'running', success: 'success', failed: 'failed', interrupted: 'interrupted' };
            badge.textContent = labels[data.status] || data.status;
          }
          const icon = document.getElementById('status-icon');
          if (icon && data.statusIconHtml) icon.innerHTML = data.statusIconHtml;
        }

        // Interrupt banner — show with reason when job is stopped mid-run
        if (data.status === 'interrupted') {
          const REASON_MSGS = {
            budget_exceeded: 'Monthly budget limit reached — the job was stopped automatically to prevent overspend. Increase PRX_MONTHLY_BUDGET in your .env or wait for the next billing cycle.',
            low_balance: 'Anthropic account balance too low — the API returned a billing error mid-run. Top up your account balance or check your subscription to continue.',
            server_restart: 'Server was restarted while this job was running. Re-run the ticket to resume.',
            manual: 'Stopped manually by the user.',
          };
          const banner = document.getElementById('interrupt-banner');
          if (banner) {
            const reason = data.interruptReason || 'manual';
            banner.className = 'interrupt-banner interrupt-banner-' + reason;
            const txt = banner.querySelector('.interrupt-reason-text');
            if (txt) txt.textContent = REASON_MSGS[reason] || reason;
            banner.style.display = '';
          }
        }

        // Stop polling once job is no longer active
        if (!ACTIVE.includes(data.status)) clearInterval(timer);
      }, 5000);
    })();
  </script>
  ${BASE_SCRIPT}
</body>
</html>`;
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.get('/', async (_req, res) => {
  const budget = await getBudgetStatus();
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderDashboard(getStats(), budget));
});

router.get('/json', (_req, res) => res.json(getStats()));

// Lightweight processing indicator — polled every 4 s by the sun-logo script.
// O(1) Map scan; does not touch disk, rebuild merged sets, or sort.
router.get('/busy', (_req, res) => res.json({ busy: hasActive() }));

// Activity log
router.get('/activity', (req, res) => {
  const { type, ticketKey, actor, from, to } = req.query;
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const results = activityLog.getFiltered({ type, ticketKey, actor, from, to, page, pageSize: 100 });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderActivity(
    results,
    activityLog.getChartData(),
    activityLog.getAllTypes(),
    activityLog.getAllActors(),
    activityLog.getStats(),
    { type, ticketKey, actor, from, to },
  ));
});

router.get('/activity/json', (_req, res) => {
  res.json({ stats: activityLog.getStats(), chartData: activityLog.getChartData() });
});

// Disk monitor
router.get('/disk', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderDisk(readDiskStatus(), readDiskLog(), req.query.cleaned === '1' ? 'cleaned' : null));
});

// ── Cortex — the always-on intelligence layer ────────────────────────────────
router.get('/cortex', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderCortex());
});

// Detail page for a single fact file — sticky TOC, in-page search, full content.
// This is where the rendering actually happens; the landing page only shows
// previews so it stays lean as the KB grows.
router.get('/cortex/facts/:id', (req, res) => {
  const id = (req.params.id || '').toString().toLowerCase();
  const result = renderCortexFact(id);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(result.status).send(result.html);
});

router.post('/cortex/run-now', express.json(), (_req, res) => {
  if (process.env.PRX_CORTEX_ENABLED !== 'Y') {
    return res.status(400).json({ ok: false, error: 'Cortex is not enabled' });
  }
  serverEvents.emit('cortex-run-now');
  res.json({ ok: true });
});

router.post('/cortex/repowise-now', express.json(), (_req, res) => {
  if (process.env.PRX_CORTEX_ENABLED !== 'Y') {
    return res.status(400).json({ ok: false, error: 'Cortex is not enabled' });
  }
  if (process.env.PRX_REPOWISE_ENABLED !== 'Y') {
    return res.status(400).json({ ok: false, error: 'Repowise integration is not enabled' });
  }
  serverEvents.emit('cortex-repowise-now');
  res.json({ ok: true });
});

// Reference tracking — fire-and-forget ping from SKILL.md Step 0a when an
// agent consumes the cortex during a session. Recorded as a `cortex_referenced`
// activity event with actor=claude so the dashboard answers "when and who
// referenced cortex" without the dev skill needing to know any internals.
//
// Body shape (all optional except ticketKey):
//   { ticketKey: "IV-1234", hits: ["architecture.md","patterns.md"],
//     missCount: 2, machine: "javed-mac", estSavingsPct: 62,
//     step: "0a" | "5" | "7b-0" | "7" | … }
// The `step` field lets the activity log distinguish broad-orientation reads
// (Step 0a) from targeted mid-session lookups (Step 5 hotspots, Step 7b-0
// patterns).  Defaults to "0a" so older pings without the field still record
// meaningful data.
router.post('/cortex/referenced', express.json(), (req, res) => {
  const b   = req.body || {};
  const key = (b.ticketKey || '').toString().toUpperCase().slice(0, 32) || null;
  const hits = Array.isArray(b.hits) ? b.hits.filter(h => typeof h === 'string').slice(0, 20) : [];
  const miss = typeof b.missCount === 'number' ? b.missCount : 0;
  const machine = (b.machine || '').toString().slice(0, 64) || null;
  const est = typeof b.estSavingsPct === 'number' ? Math.max(0, Math.min(100, b.estSavingsPct)) : null;
  // Permit known step values only — anything unexpected → 'unknown' so the
  // dashboard filter stays scannable.
  const stepRaw = (b.step || '0a').toString().slice(0, 8);
  const step    = /^[\w\-]{1,8}$/.test(stepRaw) ? stepRaw : 'unknown';

  activityLog.record('cortex_referenced', key, 'claude', {
    machine,
    step,
    hitCount:  hits.length,
    missCount: miss,
    hits,
    estSavingsPct: est,
  });
  res.json({ ok: true });
});

// Cross-platform repowise installer (pipx → uv → pip user — auto-detected).
// Shares the same wrapper used by the proactive auto-install path
// (server/runner/repowiseInstaller.js).  Concurrent-call protection: if a
// background install is already running, this route returns the in-flight
// promise instead of spawning a second process.  Activity events are
// recorded by the wrapper regardless of who triggered the install.
router.post('/cortex/install-repowise', express.json(), async (_req, res) => {
  try {
    const repowiseInstaller = require('../runner/repowiseInstaller');
    const result = await repowiseInstaller.ensureInstalled({ trigger: 'manual-button', force: true });
    return res.json({
      ok:      result.ok,
      summary: result.summary,
      stdout:  (result.stdout || '').slice(-4000),
      stderr:  (result.stderr || '').slice(-4000),
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Polled by the Cortex page so the UI can show install state without
// holding open a long-running HTTP request.
router.get('/cortex/install-status', (_req, res) => {
  const repowiseInstaller = require('../runner/repowiseInstaller');
  res.json({
    installed:    repowiseInstaller.isInstalled(),
    installing:   repowiseInstaller.isInstalling(),
    autoEnabled:  repowiseInstaller.autoInstallEnabled(),
    lastResult:   repowiseInstaller.getLastResult(),
  });
});

// ── Cortex Memory API — agent read/write endpoints ───────────────────────────
//
// These HTTP endpoints let agents (Claude AI running bash) interact with the
// CortexMemory engine without reading .md files from disk.
//
// Read (Step 0b Layer 0 — agent consumes fresh facts):
//   GET  /cortex/memory/facts              → all live synthesised facts
//   GET  /cortex/memory/get?key=<key>      → single value by key
//   GET  /cortex/memory/tag?tag=<tag>      → all live keys carrying a tag
//   GET  /cortex/memory/recent?n=10&tag=X&since=<ms> → n most-recent entries (optional since filter)
//   GET  /cortex/memory/signals?n=50       → recent transit events
//   GET  /cortex/memory/stats              → storage stats (dashboard / debug)
//   GET  /cortex/memory/context?ticket=X   → Step-0 bundle: facts + recent observations
//   GET  /cortex/memory/pending-promotions → observations queued for auto-promotion
//
// Write (Step 13 / mid-session — agent feeds discoveries back):
//   POST /cortex/memory/observe            {key,summary,type,persona,ticketKey,tags,ttl,value}
//   POST /cortex/memory/signal             {event,data}
//   POST /cortex/memory/promote            {key} → graduate observation to KB (manual)
//   POST /cortex/memory/reject-promotion   {key} → block pending auto-promotion

function _memGuard(res) {
  if (process.env.PRX_CORTEX_ENABLED !== 'Y') {
    res.status(400).json({ ok: false, error: 'Cortex is not enabled (PRX_CORTEX_ENABLED=N)' });
    return false;
  }
  return true;
}

router.get('/cortex/memory/facts', (_req, res) => {
  if (!_memGuard(res)) return;
  const cortex  = require('../runner/cortexLayer');
  const mem     = cortex.memory();
  const keys    = mem.byTag('fact');
  const facts   = {};
  for (const k of keys) facts[k] = mem.get(k);
  res.json({ ok: true, facts, count: keys.length });
});

router.get('/cortex/memory/get', (req, res) => {
  if (!_memGuard(res)) return;
  const key = (req.query.key || '').toString().slice(0, 256);
  if (!key) return res.status(400).json({ ok: false, error: 'key required' });
  const value = require('../runner/cortexLayer').memory().get(key);
  res.json({ ok: true, key, value, found: value !== null });
});

router.get('/cortex/memory/tag', (req, res) => {
  if (!_memGuard(res)) return;
  const tag = (req.query.tag || '').toString().slice(0, 64);
  if (!tag) return res.status(400).json({ ok: false, error: 'tag required' });
  const keys = require('../runner/cortexLayer').memory().byTag(tag);
  res.json({ ok: true, tag, keys, count: keys.length });
});

router.get('/cortex/memory/recent', (req, res) => {
  if (!_memGuard(res)) return;
  const n     = Math.min(100, Math.max(1, parseInt(req.query.n   || '10', 10)));
  const tag   = (req.query.tag   || '').toString().slice(0, 64) || undefined;
  const since = req.query.since ? parseInt(req.query.since, 10) : null;
  let entries = require('../runner/cortexLayer').memory().recent(n, tag ? { tag } : {});
  if (since && !isNaN(since)) {
    entries = entries.filter(e => e.value && typeof e.value === 'object'
      ? (e.value.ts || 0) >= since
      : true
    );
  }
  res.json({ ok: true, entries, count: entries.length });
});

router.get('/cortex/memory/signals', (req, res) => {
  if (!_memGuard(res)) return;
  const n = Math.min(200, Math.max(1, parseInt(req.query.n || '50', 10)));
  res.json({ ok: true, signals: require('../runner/cortexLayer').memory().signals(n) });
});

// Single Step-0 context call — returns synthesised facts + recent agent observations.
// Agents call this once instead of assembling from /facts + /recent separately.
//   GET /cortex/memory/context?ticket=PRX-123&n=20
router.get('/cortex/memory/context', (req, res) => {
  if (!_memGuard(res)) return;
  const ticket = (req.query.ticket || '').toString().toUpperCase().slice(0, 32) || null;
  const n      = Math.min(50, Math.max(1, parseInt(req.query.n || '20', 10)));

  const cortex = require('../runner/cortexLayer');
  const mem    = cortex.memory();

  const facts = {};
  for (const k of mem.byTag('fact')) {
    const v = mem.get(k);
    if (v !== null) facts[k] = v;
  }

  const allObs = mem.recent(n, { tag: 'agent-observed' });
  const ticketObs = ticket
    ? allObs.filter(e => e.value && typeof e.value === 'object' && e.value.ticket === ticket)
    : [];

  res.json({ ok: true, facts, factCount: Object.keys(facts).length, recentObservations: allObs, ticketObservations: ticketObs, ticket });
});

router.get('/cortex/memory/stats', (_req, res) => {
  if (!_memGuard(res)) return;
  res.json({ ok: true, stats: require('../runner/cortexLayer').memory().stats() });
});

// Health endpoint — polled by the Cortex dashboard panel and by the
// PRX_CORTEX_ENABLED=Y startup check.  Returns backend name, LMDB version,
// and install status regardless of whether Cortex is enabled so the dashboard
// can always show install guidance.
router.get('/cortex/memory/health', (_req, res) => {
  const cortexMem = require('../runner/cortexMemory');
  const cortex    = require('../runner/cortexLayer');
  let health;
  if (cortex.isEnabled()) {
    health = cortex.memory().health();
  } else {
    // Cortex not running — report install status without a live instance.
    const installed = cortexMem.lmdbAvailable();
    let version = null;
    if (installed) {
      try { version = require(path.join(__dirname, '..', 'node_modules', 'lmdb', 'package.json')).version; } catch (_) {}
    }
    health = {
      ok:              true,
      backend:         installed ? 'lmdb (not running)' : 'jsonl (not running)',
      lmdbInstalled:   installed,
      lmdbActive:      false,
      lmdbVersion:     version,
      lmdbInstallError: cortexMem.lmdbAvailable ? null : 'lmdb module not found',
      fallbackReason:  installed ? null : 'lmdb not installed — run: cd server && npm install lmdb',
    };
  }
  res.json(health);
});

// Agent discovery write — the primary feedback path from agents into the memory
// layer between synthesis cycles.  Validates inputs, records an activity event,
// and fires a debounced re-synthesis via serverEvents so discoveries don't sit
// idle until the next 6-hour heartbeat.
//
// Body fields:
//   key        (required) — unique identifier, e.g. "pattern:cache-invalidation"
//   summary    (required) — human-readable description of the discovery (max 4000 chars)
//   type       (optional) — one of: pattern | decision | business-rule | anomaly | hotspot | context | session-summary (default: context)
//   persona    (optional) — agent identity writing this observation, e.g. "alex"
//   ticketKey  (optional) — Jira ticket this observation belongs to, e.g. "PRX-123"
//   tags       (optional) — additional tag strings
//   ttl        (optional) — milliseconds before this observation expires (0 = permanent)
//   value      (optional) — raw machine-readable payload stored alongside summary
router.post('/cortex/memory/observe', express.json(), (req, res) => {
  if (!_memGuard(res)) return;
  const b   = req.body || {};
  const key = (b.key || '').toString().trim().slice(0, 256);
  const tags      = Array.isArray(b.tags) ? b.tags.filter(t => typeof t === 'string').slice(0, 20) : [];
  const ttl       = (typeof b.ttl === 'number' && b.ttl > 0) ? b.ttl : 0;
  const ticketKey = (b.ticketKey || '').toString().toUpperCase().slice(0, 32) || null;
  const persona   = (b.persona   || '').toString().slice(0, 64) || null;

  const VALID_TYPES = new Set(['pattern', 'decision', 'business-rule', 'anomaly', 'hotspot', 'context', 'session-summary']);
  const type    = VALID_TYPES.has(b.type) ? b.type : 'context';
  // Accept summary directly, or fall back to a stringified value for backward compat.
  const summary = (
    b.summary ||
    (typeof b.value === 'string' ? b.value : '') ||
    (b.value != null ? JSON.stringify(b.value) : '')
  ).toString().slice(0, 4000);

  if (!key)     return res.status(400).json({ ok: false, error: 'key required' });
  if (!summary) return res.status(400).json({ ok: false, error: 'summary (or value) required' });

  if (!tags.includes('agent-observed')) tags.push('agent-observed');
  if (!tags.includes(type))             tags.push(type);
  if (type === 'session-summary' && !tags.includes('session-memory')) tags.push('session-memory');

  const cortex = require('../runner/cortexLayer');
  const autonomy = require('../runner/autonomyScheduler');
  const mem    = cortex.memory();
  const now    = Date.now();

  // Merge with existing observation to preserve and increment confirmCount.
  const existing     = mem.get(key);
  const prev         = (existing && typeof existing === 'object') ? existing : {};
  const confirmCount = (prev.confirmCount || 0) + 1;

  const value = {
    type, summary, ticket: ticketKey, ts: now, raw: b.value ?? null,
    confirmCount, persona: persona || prev.persona || null,
    queuedForPromotionAt: prev.queuedForPromotionAt || null,
    promoted: prev.promoted || false,
    rejected: prev.rejected || false,
  };

  const level     = autonomy.autonomyLevel();
  const threshold = autonomy.promoteThreshold();

  // Level 2: queue for auto-promotion when threshold is reached for the first time.
  if (level >= 2 && !value.promoted && !value.rejected &&
      confirmCount >= threshold && !value.queuedForPromotionAt) {
    value.queuedForPromotionAt = now;
    if (!tags.includes('pending-promotion')) tags.push('pending-promotion');
  } else if (value.queuedForPromotionAt && !tags.includes('pending-promotion')) {
    tags.push('pending-promotion');
  }

  const seq = mem.put(key, value, { tags, ttl });

  // Level 3: promote immediately — no review window.
  if (level >= 3 && confirmCount >= threshold && !value.promoted && !value.rejected) {
    const result = autonomy.promoteObservation(key, value, mem, cortex.kbDir());
    if (result.ok) {
      activityLog.record('cortex_observed', ticketKey, 'claude', { key, type, tags, seq, autoPromoted: true, kbFile: result.kbFile });
      serverEvents.emit('cortex-observation-written', { key, tags, autoPromoted: true });
      return res.json({ ok: true, seq, autoPromoted: true, kbFile: result.kbFile });
    }
  }

  activityLog.record('cortex_observed', ticketKey, 'claude', { key, type, tags, seq, confirmCount });
  serverEvents.emit('cortex-observation-written', { key, tags });
  res.json({ ok: true, seq, confirmCount });
});

router.post('/cortex/memory/signal', express.json(), (req, res) => {
  if (!_memGuard(res)) return;
  const b     = req.body || {};
  const event = (b.event || '').toString().slice(0, 128);
  const data  = (b.data && typeof b.data === 'object') ? b.data : {};
  if (!event) return res.status(400).json({ ok: false, error: 'event required' });
  require('../runner/cortexLayer').memory().signal(event, data);
  res.json({ ok: true });
});

// Graduate an LMDB observation into the permanent KB so it survives beyond the
// cortex layer and influences future synthesis from the source KB files.
//
//   POST /cortex/memory/promote   { key }
//
// The observation is appended to the appropriate shared/*.md file based on its
// type, then re-tagged as 'promoted' in LMDB so observations.md shows status.
// Type → KB file mapping lives in autonomyScheduler.PROMOTE_TARGETS.

router.post('/cortex/memory/promote', express.json(), (req, res) => {
  if (!_memGuard(res)) return;
  const b   = req.body || {};
  const key = (b.key || '').toString().trim().slice(0, 256);
  if (!key) return res.status(400).json({ ok: false, error: 'key required' });

  const cortex   = require('../runner/cortexLayer');
  const autonomy = require('../runner/autonomyScheduler');
  const mem      = cortex.memory();
  const raw      = mem.get(key);
  if (raw === null) return res.status(404).json({ ok: false, error: `observation '${key}' not found` });

  const v = (raw && typeof raw === 'object') ? raw : { type: 'context', summary: String(raw) };
  const result = autonomy.promoteObservation(key, v, mem, cortex.kbDir());
  if (!result.ok) return res.status(result.error.includes('not found') ? 404 : 400).json({ ok: false, error: result.error });

  activityLog.record('cortex_observed', v.ticket || null, 'claude', { key, type: v.type || 'context', promoted: true, kbFile: result.kbFile });
  serverEvents.emit('cortex-observation-written', { key, tags: ['agent-observed', v.type || 'context', 'promoted'] });
  res.json({ ok: true, key, type: v.type || 'context', kbFile: result.kbFile, target: result.target });
});

// Reject a queued auto-promotion — removes from the pending-promotion queue
// so the scheduler won't promote it.  The observation stays in LMDB.
//   POST /cortex/memory/reject-promotion   { key }
router.post('/cortex/memory/reject-promotion', express.json(), (req, res) => {
  if (!_memGuard(res)) return;
  const b   = req.body || {};
  const key = (b.key || '').toString().trim().slice(0, 256);
  if (!key) return res.status(400).json({ ok: false, error: 'key required' });

  const cortex = require('../runner/cortexLayer');
  const mem    = cortex.memory();
  const raw    = mem.get(key);
  if (raw === null) return res.status(404).json({ ok: false, error: `observation '${key}' not found` });

  const v = (raw && typeof raw === 'object') ? raw : { type: 'context', summary: String(raw) };
  if (v.promoted) return res.status(400).json({ ok: false, error: 'already promoted — cannot reject' });

  mem.put(key, { ...v, rejected: true, rejectedAt: Date.now(), queuedForPromotionAt: null }, {
    tags: ['agent-observed', v.type || 'context', 'rejected'],
    ttl: 0,
  });

  serverEvents.emit('cortex-observation-written', { key, tags: ['agent-observed', v.type || 'context', 'rejected'] });
  res.json({ ok: true, key, rejected: true });
});

// List observations currently queued for auto-promotion (pending-promotion tag).
//   GET /cortex/memory/pending-promotions
router.get('/cortex/memory/pending-promotions', (req, res) => {
  if (!_memGuard(res)) return;
  const cortex  = require('../runner/cortexLayer');
  const mem     = cortex.memory();
  const keys    = mem.byTag('pending-promotion');
  const entries = keys
    .map(k => ({ key: k, value: mem.get(k) }))
    .filter(e => e.value !== null && typeof e.value === 'object' && !e.value.rejected && !e.value.promoted);
  res.json({ ok: true, entries, count: entries.length });
});

router.get('/disk/json', (_req, res) => {
  res.json({ status: readDiskStatus(), log: readDiskLog().slice(-100) });
});

// CPU / memory stats — polled by the dashboard info-strip every 5s.
// Returns current CPU %, 1-min average, peak, RSS MB, and a 2-min sample ring.
router.get('/cpu/stats', (_req, res) => {
  res.json({ ok: true, ...cpuMonitor.getStats() });
});

router.post('/disk/approve-cleanup', (_req, res) => {
  const PREVOYANT_DIR = path.join(os.homedir(), '.prevoyant');
  const sessionsDir   = path.join(PREVOYANT_DIR, 'sessions');
  const serverDir     = path.join(PREVOYANT_DIR, 'server');
  // Knowledge base is never included in cleanup targets — resolve its path
  // so we can double-check that no candidate path ever falls inside it.
  const protectedKbDir = path.resolve(kbDir());
  const KEEP_DAYS      = 30;
  const cutoff         = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  let deletedSessions  = 0;
  let trimmedLogs      = 0;

  function isSafeToDelete(fullPath) {
    const resolved = path.resolve(fullPath);
    // Never delete anything inside the knowledge base directory
    return !resolved.startsWith(protectedKbDir + path.sep) && resolved !== protectedKbDir;
  }

  // Remove session directories older than KEEP_DAYS days
  try {
    const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const full = path.join(sessionsDir, e.name);
      if (!isSafeToDelete(full)) continue;
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs < cutoff) {
          fs.rmSync(full, { recursive: true, force: true });
          deletedSessions++;
        }
      } catch (_) {}
    }
  } catch (_) {}

  // Trim disk-log.json to last 200 entries
  try {
    const logPath = path.join(serverDir, 'disk-log.json');
    let log = JSON.parse(fs.readFileSync(logPath, 'utf8'));
    if (Array.isArray(log) && log.length > 200) {
      fs.writeFileSync(logPath, JSON.stringify(log.slice(-200)));
      trimmedLogs++;
    }
  } catch (_) {}

  // Trim activity-log.json to last 2000 entries
  try {
    const actPath = path.join(serverDir, 'activity-log.json');
    let log = JSON.parse(fs.readFileSync(actPath, 'utf8'));
    if (Array.isArray(log) && log.length > 2000) {
      fs.writeFileSync(actPath, JSON.stringify(log.slice(-2000)));
      trimmedLogs++;
    }
  } catch (_) {}

  // Trim watch poll logs — delete by age AND enforce per-ticket cap
  const WATCH_KEEP_DAYS = parseInt(process.env.PRX_WATCH_LOG_KEEP_DAYS       || '30', 10);
  const WATCH_KEEP_PER  = parseInt(process.env.PRX_WATCH_LOG_KEEP_PER_TICKET || '10', 10);
  const watchCutoff     = Date.now() - WATCH_KEEP_DAYS * 24 * 60 * 60 * 1000;
  let deletedWatchLogs  = 0;
  try {
    const ticketDirs = fs.readdirSync(WATCH_LOG_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory());
    for (const td of ticketDirs) {
      const dir = path.join(WATCH_LOG_DIR, td.name);
      // Delete files older than cutoff
      let files;
      try { files = fs.readdirSync(dir).filter(f => f.endsWith('.log')).sort(); }
      catch (_) { continue; }
      for (const f of files) {
        const fp = path.join(dir, f);
        try {
          if (fs.statSync(fp).mtimeMs < watchCutoff) {
            fs.unlinkSync(fp);
            deletedWatchLogs++;
          }
        } catch (_) {}
      }
      // Enforce per-ticket cap on what remains
      try {
        const remaining = fs.readdirSync(dir).filter(f => f.endsWith('.log')).sort();
        if (remaining.length > WATCH_KEEP_PER) {
          for (const f of remaining.slice(0, remaining.length - WATCH_KEEP_PER)) {
            try { fs.unlinkSync(path.join(dir, f)); deletedWatchLogs++; } catch (_) {}
          }
        }
      } catch (_) {}
    }
  } catch (_) {}

  // Delete KB Flow Analyst run logs older than KEEP_DAYS days
  const KBFLOW_LOG_DIR = path.join(os.homedir(), '.prevoyant', 'kbflow', 'logs');
  let deletedKbflowLogs = 0;
  try {
    const files = fs.readdirSync(KBFLOW_LOG_DIR).filter(f => f.endsWith('.log'));
    for (const f of files) {
      const fp = path.join(KBFLOW_LOG_DIR, f);
      try {
        if (fs.statSync(fp).mtimeMs < cutoff) {
          fs.unlinkSync(fp);
          deletedKbflowLogs++;
        }
      } catch (_) {}
    }
  } catch (_) {}

  // Update status file
  try {
    const existing = readDiskStatus();
    fs.writeFileSync(
      DISK_STATUS_FILE,
      JSON.stringify({ ...existing, pendingCleanup: false, lastCleanupAt: new Date().toISOString() }, null, 2)
    );
  } catch (_) {}

  activityLog.record('disk_cleanup', null, 'user', { deletedSessions, trimmedLogs, deletedWatchLogs, deletedKbflowLogs });
  res.redirect(303, '/dashboard/disk?cleaned=1');
});

router.post('/disk/dismiss-cleanup', (_req, res) => {
  try {
    const existing = readDiskStatus();
    fs.writeFileSync(
      DISK_STATUS_FILE,
      JSON.stringify({ ...existing, pendingCleanup: false }, null, 2)
    );
  } catch (_) {}
  res.json({ ok: true });
});

router.get('/ticket/:key', (req, res) => {
  const ticket = getTicket(req.params.key);
  if (!ticket) return res.status(404).send('Ticket not found.');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderDetail(ticket, req.query.warn, req.query.mode));
});

// Partial update endpoint — returns only what the live-poll JS needs
router.get('/ticket/:key/partial', (req, res) => {
  const ticket = getTicket(req.params.key);
  if (!ticket) return res.status(404).json({ error: 'not found' });

  const stages = ticket.stages || [];
  const outputLines = ticket.outputLog || [];
  const doneCount = stages.filter(s => s.status === 'done' || s.status === 'failed').length;
  const currentStage = stages.find(s => s.status === 'active');
  const since = parseInt(req.query.since || '0', 10);

  const newLogEntries = outputLines.slice(since).map(l => {
    const ts = new Date(l.ts).toLocaleTimeString('en-GB');
    const isStderr = l.text.startsWith('[stderr]');
    const isResult = l.text.startsWith('[Result]');
    let bodyHtml;
    if (isStderr) {
      const t = l.text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      bodyHtml = `<span class="log-stderr">${t}</span>`;
    } else if (isResult) {
      const t = l.text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      bodyHtml = `<span class="log-result">${t}</span>`;
    } else {
      bodyHtml = renderMarkdown(l.text);
    }
    return `<div class="log-entry"><div class="log-ts">${ts}</div><div class="log-body">${bodyHtml}</div></div>`;
  });

  res.json({
    status: ticket.status,
    interruptReason: ticket.interruptReason || null,
    statusIconHtml: (ICONS[ticket.status] || ICONS.queued)(22),
    pipelineHtml: stagePipelineHtml(stages),
    progressPct: stages.length ? Math.round(doneCount / stages.length * 100) : 0,
    doneCount,
    totalStages: stages.length,
    currentStageLabel: currentStage ? `Step ${currentStage.id} — ${currentStage.label}` : null,
    duration: dur(ticket.startedAt, ticket.completedAt),
    newLogEntries,
    totalOutputCount: outputLines.length,
  });
});

// Secure inline view (for PDF iframe embedding)
router.get('/view', (req, res) => {
  const rawPath = req.query.path;
  if (!rawPath) return res.status(400).send('Missing path.');
  const { reportsDir } = getStats();
  const resolved = path.resolve(rawPath);
  const base = path.resolve(reportsDir);
  if (!resolved.startsWith(base + path.sep) && resolved !== base) return res.status(403).send('Access denied.');
  if (!fs.existsSync(resolved)) return res.status(404).send('File not found.');
  const ct = resolved.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'text/html';
  res.setHeader('Content-Type', ct);
  fs.createReadStream(resolved).pipe(res);
});

// Run / re-run a ticket
router.post('/ticket/:key/run', express.urlencoded({ extended: false }), (req, res) => {
  const ticketKey = req.params.key.toUpperCase();
  const mode  = (req.body.mode  || 'dev').toLowerCase();
  const force = req.body.force === '1';

  if (!VALID_MODES.has(mode)) return res.status(400).send('Invalid mode.');

  const existing = getTicket(ticketKey);
  if (existing && (existing.status === 'running' || existing.status === 'queued')) {
    return res.status(409).send('Job already in progress.');
  }

  if (!force && isInSeenCache(ticketKey)) {
    const enc = encodeURIComponent(ticketKey);
    return res.redirect(303, `/dashboard/ticket/${enc}?warn=seen&mode=${encodeURIComponent(mode)}`);
  }

  if (force) removeFromSeenCache(ticketKey);

  reRunTicket(ticketKey, mode, 'manual');
  enqueue(ticketKey, mode);
  res.redirect(303, `/dashboard/ticket/${encodeURIComponent(ticketKey)}`);
});

// Stop a running or queued job
router.post('/ticket/:key/stop', (req, res) => {
  const ticketKey = req.params.key.toUpperCase();
  killJob(ticketKey);
  res.redirect(303, `/dashboard/ticket/${encodeURIComponent(ticketKey)}`);
});

router.post('/ticket/:key/prioritize', (req, res) => {
  const ticketKey = req.params.key.toUpperCase();
  prioritizeJob(ticketKey);
  activityLog.record('ticket_prioritized', ticketKey, 'user', {});
  res.redirect(303, '/dashboard');
});

router.post('/ticket/:key/delete', (req, res) => {
  const ticketKey = req.params.key.toUpperCase();
  const ticket = getTicket(ticketKey);
  if (ticket && (ticket.status === 'running' || ticket.status === 'queued')) {
    return res.status(400).send('Cannot delete a running or queued ticket. Stop it first.');
  }
  if (ticket && ticket.status === 'scheduled') {
    killJob(ticketKey); // cancels the timer; records interrupted — deleteTicket below overwrites that
  }
  deleteTicket(ticketKey);
  res.redirect(303, '/dashboard');
});

// KB backup export
router.get('/kb/export', (req, res) => {
  const includeSessions  = req.query.sessions  === '1';
  const includeReports   = req.query.reports   === '1';
  const includeServer    = req.query.server    === '1';
  const includeWatchLogs = req.query.watchlogs === '1';
  const includeMemory    = req.query.memory    === '1';
  const includeAgentMem  = req.query.agentmem  === '1';
  const includeCortex    = req.query.cortex    === '1';

  const kb = kbStats();
  const dirs = [];
  if (kb.kbExists)                                                              dirs.push(kb.kbDir);
  if (!kb.basicMemInsideKb && includeAgentMem && kb.basicMemFiles > 0)          dirs.push(kb.basicMemDir);
  if (includeSessions  && kb.sessionFiles  > 0)                                 dirs.push(kb.sessions);
  if (includeReports   && kb.reportFiles   > 0)                                 dirs.push(kb.reports);
  if (includeServer    && kb.serverFiles   > 0)                                 dirs.push(kb.serverDir);
  if (includeWatchLogs && kb.watchLogFiles > 0)                                 dirs.push(kb.watchLogs);
  if (includeMemory    && kb.memoryFiles   > 0)                                 dirs.push(kb.memoryDir);
  if (!kb.cortexInsideKb && includeCortex && kb.cortexFiles > 0)                dirs.push(kb.cortexDir);

  const validDirs = dirs.filter(d => fs.existsSync(d));
  if (validDirs.length === 0) return res.status(404).send('No files found to export.');

  const stamp   = new Date().toISOString().slice(0, 10);
  const tmpFile = path.join(os.tmpdir(), `prevoyant-backup-${Date.now()}.tar.gz`);

  execFile('tar', ['-czf', tmpFile, ...validDirs], (err) => {
    if (err) {
      console.error('[kb/export] tar failed:', err.message);
      return res.status(500).send('Failed to create backup archive: ' + err.message);
    }
    activityLog.record('kb_exported', null, 'user', {
      includeSessions, includeReports, includeServer, includeWatchLogs, includeMemory, includeAgentMem,
    });
    res.download(tmpFile, `prevoyant-backup-${stamp}.tar.gz`, () => {
      try { fs.unlinkSync(tmpFile); } catch (_) {}
    });
  });
});

// KB backup import — restore from .tar.gz without overwriting existing files
router.post('/kb/import', express.raw({ type: 'application/octet-stream', limit: '50mb' }), (req, res) => {
  if (!req.body || !req.body.length) {
    return res.status(400).json({ error: 'No file data received.' });
  }

  const tmpFile = path.join(os.tmpdir(), `prevoyant-import-${Date.now()}.tar.gz`);

  try {
    fs.writeFileSync(tmpFile, req.body);
  } catch (e) {
    return res.status(500).json({ error: 'Failed to write temp file: ' + e.message });
  }

  const prevoyantDir = path.join(os.homedir(), '.prevoyant');
  const before = countFilesRecursive(prevoyantDir);

  // -k / --keep-old-files: skip any file that already exists on disk
  // tar exits with code 1 when files are skipped — that is expected and not a failure
  execFile('tar', ['-xzf', tmpFile, '-k'], (err) => {
    try { fs.unlinkSync(tmpFile); } catch (_) {}

    if (err && err.code !== 1) {
      console.error('[kb/import] tar failed (code %d): %s', err.code, err.message);
      return res.status(500).json({ error: 'Extraction failed: ' + err.message });
    }

    const after   = countFilesRecursive(prevoyantDir);
    const added   = Math.max(0, after - before);
    const skipped = !!(err && err.code === 1);

    console.log(`[kb/import] done — added=${added} skipped=${skipped}`);
    activityLog.record('kb_imported', null, 'user', { added, skipped });
    res.json({ ok: true, added, skipped });
  });
});

// Secure download
router.get('/download', (req, res) => {
  const rawPath = req.query.path;
  if (!rawPath) return res.status(400).send('Missing path.');
  const { reportsDir } = getStats();
  const resolved = path.resolve(rawPath);
  const base = path.resolve(reportsDir);
  if (!resolved.startsWith(base + path.sep) && resolved !== base) return res.status(403).send('Access denied.');
  if (!fs.existsSync(resolved)) return res.status(404).send('File not found.');
  res.download(resolved);
});

// Queue pause / resume
router.post('/queue/pause',  (_req, res) => { pauseQueue();  res.json({ paused: true  }); });
router.post('/queue/resume', (_req, res) => { resumeQueue(); res.json({ paused: false }); });
router.get('/queue/status',  (_req, res) => res.json({ paused: isPaused(), depth: getQueueDepth() }));

// Bulk queue tickets
router.post('/tickets/bulk-run', express.urlencoded({ extended: false }), (req, res) => {
  const raw  = (req.body.keys || '').trim();
  const mode = (req.body.mode  || 'dev').toLowerCase();
  if (!VALID_MODES.has(mode)) return res.status(400).json({ error: 'Invalid mode.' });

  const keys = [...new Set(
    raw.split(/[\s,;]+/).map(k => k.trim().toUpperCase()).filter(k => /^[A-Z]+-\d+$/.test(k))
  )];
  if (keys.length === 0) return res.status(400).json({ error: 'No valid ticket keys.' });
  if (keys.length > 20)  return res.status(400).json({ error: 'Maximum 20 tickets per bulk run.' });

  let queued = 0;
  for (const key of keys) {
    const existing = getTicket(key);
    if (existing && (existing.status === 'running' || existing.status === 'queued')) continue;
    reRunTicket(key, mode, 'manual');
    enqueue(key, mode);
    queued++;
  }
  res.json({ queued, skipped: keys.length - queued, keys });
});

// Output log download
router.get('/ticket/:key/log.txt', (req, res) => {
  const ticket = getTicket(req.params.key);
  if (!ticket) return res.status(404).send('Not found.');
  const lines = (ticket.outputLog || []).map(l =>
    `[${new Date(l.ts).toISOString()}] ${l.text}`
  );
  const safe = req.params.key.replace(/[^A-Za-z0-9_-]/g, '');
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${safe}-output.txt"`);
  res.send(lines.join('\n'));
});

// Manually queue a ticket (from the Add Ticket modal on the dashboard).
// Accepts JSON (fetch from modal) or urlencoded (legacy form posts).
// When ticketKey is absent the request is treated as evidence-only: a synthetic
// key EV-YYYYMMDD-HHMMSS is generated and the runner skips the Jira skill.
router.post('/queue',
  (req, res, next) => {
    const ct = req.headers['content-type'] || '';
    if (ct.includes('application/json')) {
      express.json({ limit: '200mb' })(req, res, next);
    } else {
      express.urlencoded({ extended: false, limit: '200mb' })(req, res, next);
    }
  },
  (req, res) => {
    const evidenceOnly = req.body.evidenceOnly === true || req.body.evidenceOnly === 'true';

    let ticketKey = (req.body.ticketKey || '').toUpperCase().trim();
    if (!ticketKey) {
      // Generate a stable synthetic key for this evidence-only run
      const now = new Date();
      const stamp = [
        now.getFullYear(),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getDate()).padStart(2, '0'),
        '-',
        String(now.getHours()).padStart(2, '0'),
        String(now.getMinutes()).padStart(2, '0'),
        String(now.getSeconds()).padStart(2, '0'),
      ].join('');
      ticketKey = 'EV-' + stamp;
    }

    const mode = (req.body.mode || 'dev').toLowerCase();
    if (!VALID_MODES.has(mode)) return res.redirect(303, '/dashboard');

    const priority = (req.body.priority || 'normal') === 'urgent' ? 'urgent' : 'normal';
    // Apply-changes opt-in: when 'Y', the skill creates the feature branch and
    // commits the proposed fix. Default 'N' = analysis-only (PDF report only).
    // The skill honours PRX_APPLY_CHANGES=Y at Step 4c (branch) and 8d (apply fix).
    const applyChanges = (req.body.applyChanges || 'N').toUpperCase() === 'Y';
    const meta = { applyChanges };

    if (evidenceOnly) meta.evidenceOnly = true;

    const extraContext = (req.body.extraContext || '').trim();
    if (extraContext) meta.extraContext = extraContext;

    const rawAttachments = req.body.attachments;
    if (Array.isArray(rawAttachments) && rawAttachments.length) {
      meta.attachments = rawAttachments
        .filter(a => a && typeof a.name === 'string' && typeof a.content === 'string')
        .map(a => ({ name: a.name.replace(/[^A-Za-z0-9._-]/g, '_'), content: a.content }));
    }

    const rawUrls = req.body.evidenceUrls;
    if (Array.isArray(rawUrls) && rawUrls.length) {
      meta.evidenceUrls = rawUrls
        .filter(u => typeof u === 'string' && /^https?:\/\//.test(u.trim()))
        .map(u => u.trim())
        .slice(0, 10);
    }

    const existing = getTicket(ticketKey);
    if (existing && (existing.status === 'running' || existing.status === 'queued' || existing.status === 'scheduled')) {
      return res.status(200).json({ ok: true, skipped: true });
    }

    if (!evidenceOnly) {
      const rawScheduled = (req.body.scheduledAt || '').trim();
      if (rawScheduled) {
        const scheduledFor = new Date(rawScheduled);
        if (!isNaN(scheduledFor) && scheduledFor > new Date()) {
          recordScheduled(ticketKey, mode, scheduledFor, 'manual');
          scheduleJob(ticketKey, mode, scheduledFor, meta);
          return res.status(200).json({ ok: true, scheduled: true });
        }
      }
    }

    reRunTicket(ticketKey, mode, 'manual', priority);
    enqueue(ticketKey, mode, priority, meta);
    res.status(200).json({ ok: true, ticketKey });
  }
);

// ── Settings ──────────────────────────────────────────────────────────────────

router.get('/settings', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderSettings(readEnvValues(), _req.query.saved === '1' ? 'saved' : null));
});

// ── Hermes KB-insight review (Option A pipeline) ─────────────────────────────

router.get('/api/hermes-insights/pending', (_req, res) => {
  try {
    const r = require('../integrations/hermes/insightsReview');
    res.json({ ok: true, pending: r.listPending(), counts: r.counts() });
  } catch (err) { res.json({ ok: false, reason: err.message }); }
});

router.get('/api/hermes-insights/counts', (_req, res) => {
  try {
    const r = require('../integrations/hermes/insightsReview');
    res.json({ ok: true, counts: r.counts() });
  } catch (err) { res.json({ ok: false, reason: err.message }); }
});

router.post('/api/hermes-insights/approve', express.json({ limit: '64kb' }), (req, res) => {
  try {
    const r = require('../integrations/hermes/insightsReview');
    const { file, edits } = req.body || {};
    if (!file) return res.status(400).json({ ok: false, reason: 'file required' });
    const result = r.approve(file, { reviewer: 'dashboard', edits });
    if (!result.ok) return res.status(404).json({ ok: false, reason: result.error });
    activityLog.record('hermes_kb_insight_approved', null, 'user', { file, edited: !!result.edited, title: result.title });

    // Re-index so the approved file is queryable on the next agent run.
    setImmediate(() => {
      try { require('../memory/memoryAdapter').indexAllNew(); } catch {}
    });

    res.json({ ok: true, file: result.file, edited: result.edited });
  } catch (err) { res.status(500).json({ ok: false, reason: err.message }); }
});

router.post('/api/hermes-insights/reject', express.json({ limit: '16kb' }), (req, res) => {
  try {
    const r = require('../integrations/hermes/insightsReview');
    const { file, reason } = req.body || {};
    if (!file) return res.status(400).json({ ok: false, reason: 'file required' });
    const result = r.reject(file, { reviewer: 'dashboard', reason });
    if (!result.ok) return res.status(404).json({ ok: false, reason: result.error });
    activityLog.record('hermes_kb_insight_rejected', null, 'user', { file, reason: result.reason });
    res.json({ ok: true, file: result.file });
  } catch (err) { res.status(500).json({ ok: false, reason: err.message }); }
});

router.get('/hermes-insights', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderHermesInsightsReview());
});

// Hermes status API — polled by the settings page to show live install/gateway badges.
router.get('/api/hermes-status', (_req, res) => {
  try {
    const manager = require('../integrations/hermes/manager');
    res.json(manager.status());
  } catch (err) {
    res.json({ installed: false, gatewayRunning: false, skillInstalled: false, error: err.message });
  }
});

router.post('/api/hermes-gateway/start', (_req, res) => {
  try {
    const manager = require('../integrations/hermes/manager');
    if (!manager.isInstalled()) return res.json({ ok: false, reason: 'not_installed' });
    if (manager.isGatewayRunning()) return res.json({ ok: true, reason: 'already_running' });
    manager.startGateway();
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, reason: err.message });
  }
});

router.post('/api/hermes-gateway/stop', (_req, res) => {
  try {
    const manager = require('../integrations/hermes/manager');
    manager.stopGateway();
    res.json({ ok: true });
  } catch (err) {
    res.json({ ok: false, reason: err.message });
  }
});

// Rolling gateway log — tailed by the Hermes Config page every 5s.
router.get('/api/hermes-gateway/log', (_req, res) => {
  try {
    const manager = require('../integrations/hermes/manager');
    const snap = manager.readGatewayLog();
    res.json({
      ok: true,
      exists: snap.exists,
      text:   snap.text,
      size:   snap.size,
      mtime:  snap.mtime,
      path:   manager.GATEWAY_LOG,
      running: manager.isGatewayRunning(),
    });
  } catch (err) {
    res.json({ ok: false, reason: err.message });
  }
});

// Telegram test message API
router.post('/api/hermes-telegram-test', (_req, res) => {
  const tg = require('../notifications/telegram');
  if (!tg.isEnabled()) return res.json({ ok: false, reason: 'Telegram not enabled or missing token/chat ID' });
  tg.sendText('🔔 <b>Prevoyant test message</b>\nTelegram notifications are working correctly.')
    .then(() => res.json({ ok: true }))
    .catch(err => res.json({ ok: false, reason: err.message }));
});

// Inbound Telegram listener status — polled by the Hermes Config page.
router.get('/api/telegram-inbound/status', (_req, res) => {
  try {
    const listener = require('../notifications/telegramListener');
    res.json({ ok: true, ...listener.status() });
  } catch (err) {
    res.json({ ok: false, reason: err.message });
  }
});

// Hermes Config page
router.get('/hermes-config', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const saved = _req.query.saved === '1' ? 'saved' : null;
  res.send(renderHermesConfig(readEnvValues(), saved));
});

router.post('/hermes-config', express.urlencoded({ extended: false }), (req, res) => {
  const FIELDS = [
    'PRX_HERMES_ENABLED', 'PRX_HERMES_GATEWAY_URL', 'PRX_HERMES_SECRET', 'PRX_HERMES_JIRA_WRITEBACK',
    'PRX_HERMES_KB_WRITEBACK_ENABLED',
    'PRX_TELEGRAM_ENABLED', 'PRX_TELEGRAM_BOT_TOKEN', 'PRX_TELEGRAM_CHAT_ID', 'PRX_TELEGRAM_EVENTS',
    'PRX_TELEGRAM_INBOUND_ENABLED',
  ];
  try {
    const updates = {};
    for (const key of FIELDS) {
      if (key in req.body) updates[key] = String(req.body[key] || '').trim();
    }
    writeEnvValues(updates);
    activityLog.record('settings_saved', null, 'user', { fields: Object.keys(updates).filter(k => updates[k] !== '').join(',') });
    serverEvents.emit('settings-saved', updates);

    if (updates.PRX_HERMES_ENABLED === 'Y') {
      setImmediate(() => {
        try { require('../integrations/hermes/manager').startup(); } catch (err) {
          console.warn('[hermes] startup after hermes-config save failed:', err.message);
        }
      });
    }
  } catch (_err) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(renderHermesConfig(readEnvValues(), 'error'));
  }
  res.redirect(303, '/dashboard/hermes-config?saved=1');
});

// Memory status API — polled by the settings page JS to show live badge + connection test
router.get('/api/memory-status', async (_req, res) => {
  try {
    const mem    = require('../memory/memoryAdapter');
    const result = await mem.stats();
    res.json(result);
  } catch (err) {
    res.json({ enabled: false, backend: 'none', connected: false, total: 0, error: err.message });
  }
});

router.post('/settings', express.urlencoded({ extended: false }), (req, res) => {
  const FIELDS = [
    'PRX_REPO_DIR',
    'JIRA_URL', 'JIRA_USERNAME', 'JIRA_API_TOKEN',
    'WEBHOOK_PORT', 'WEBHOOK_SECRET', 'WEBHOOK_POLL_INTERVAL_DAYS',
    'PRX_KB_MODE', 'PRX_SOURCE_REPO_URL', 'PRX_KNOWLEDGE_DIR',
    'PRX_KB_REPO', 'PRX_KB_LOCAL_CLONE', 'PRX_KB_KEY',
    'PRX_REALTIME_KB_SYNC', 'PRX_UPSTASH_REDIS_URL', 'PRX_UPSTASH_REDIS_TOKEN',
    'PRX_KB_SYNC_MACHINE', 'PRX_KB_SYNC_POLL_SECS', 'PRX_KB_SYNC_TRIGGER', 'PRX_KB_SYNC_DEBOUNCE_SECS',
    'CLAUDE_REPORT_DIR',
    'AUTO_MODE', 'FORCE_FULL_RUN', 'PRX_REPORT_VERBOSITY',
    'PRX_JIRA_PROJECT', 'PRX_ATTACHMENT_MAX_MB',
    'PRX_RETRY_MAX', 'PRX_RETRY_BACKOFF',
    'PRX_EMAIL_TO', 'PRX_SMTP_HOST', 'PRX_SMTP_PORT', 'PRX_SMTP_USER', 'PRX_SMTP_PASS',
    'PRX_NOTIFY_ENABLED', 'PRX_NOTIFY_LEVEL', 'PRX_NOTIFY_MUTE_DAYS', 'PRX_NOTIFY_EVENTS',
    'PRX_INCLUDE_SM_IN_SESSIONS_ENABLED', 'PRX_SKILL_UPGRADE_MIN_SESSIONS',
    'PRX_SKILL_COMPACTION_INTERVAL', 'PRX_MONTHLY_BUDGET',
    'PRX_MEMORY_INDEX_ENABLED', 'PRX_MEMORY_LIMIT',
    'PRX_REDIS_ENABLED', 'PRX_REDIS_URL', 'PRX_REDIS_PASSWORD', 'PRX_REDIS_PREFIX', 'PRX_REDIS_TTL_DAYS',
    'PRX_BASIC_MEMORY_ENABLED', 'BASIC_MEMORY_HOME',
    'PRX_WATCHDOG_ENABLED', 'PRX_WATCHDOG_INTERVAL_SECS', 'PRX_WATCHDOG_FAIL_THRESHOLD',
    'PRX_DISK_MONITOR_ENABLED', 'PRX_DISK_MONITOR_INTERVAL_MINS', 'PRX_PREVOYANT_MAX_SIZE_MB', 'PRX_DISK_CAPACITY_ALERT_PCT', 'PRX_DISK_CLEANUP_INTERVAL_DAYS',
    'PRX_CPU_ALERT_PCT', 'PRX_RAM_ALERT_PCT',
    'PRX_WATCH_ENABLED', 'PRX_WATCH_POLL_INTERVAL', 'PRX_WATCH_MAX_POLLS',
    'PRX_WATCH_LOG_KEEP_DAYS', 'PRX_WATCH_LOG_KEEP_PER_TICKET',
    'PRX_KBFLOW_ENABLED', 'PRX_KBFLOW_INTERVAL_DAYS', 'PRX_KBFLOW_LOOKBACK_DAYS', 'PRX_KBFLOW_MAX_FLOWS',
    'PRX_PATTERN_MINER_ENABLED', 'PRX_PATTERN_MINER_INTERVAL_DAYS', 'PRX_PATTERN_MINER_MIN_TICKETS', 'PRX_PATTERN_MINER_MAX_PROPOSALS', 'PRX_PATTERN_MINER_RUN_AT',
    'PRX_STALENESS_ENABLED', 'PRX_STALENESS_INTERVAL_DAYS', 'PRX_STALENESS_RUN_AT',
    'PRX_STALE_BRANCH_ENABLED', 'PRX_STALE_BRANCH_DAYS', 'PRX_STALE_BRANCH_INTERVAL_DAYS', 'PRX_STALE_BRANCH_RUN_AT',
    'PRX_DECISION_OUTCOME_ENABLED', 'PRX_DECISION_OUTCOME_INTERVAL_DAYS', 'PRX_DECISION_OUTCOME_LOOKBACK_DAYS', 'PRX_DECISION_OUTCOME_MIN_EVIDENCE', 'PRX_DECISION_OUTCOME_RUN_AT',
    'PRX_COCHANGE_WINDOW_DAYS', 'PRX_COCHANGE_CACHE_TTL_DAYS',
    'PRX_CORTEX_ENABLED', 'PRX_CORTEX_DEBOUNCE_SECS', 'PRX_CORTEX_RESYNC_HOURS', 'PRX_CORTEX_DISTRIBUTED', 'PRX_CORTEX_FORCE_BUILDER',
    'PRX_CORTEX_AUTONOMY_LEVEL', 'PRX_CORTEX_AUTO_PROMOTE_THRESHOLD', 'PRX_CORTEX_AUTO_PROMOTE_DELAY_HOURS', 'PRX_CORTEX_AUTO_PROMOTE_MIN_AGE_DAYS',
    'PRX_REPOWISE_ENABLED', 'PRX_REPOWISE_INTERVAL_DAYS', 'PRX_REPOWISE_PATH', 'PRX_REPOWISE_AUTO_INSTALL',
    'PRX_WASENDER_ENABLED', 'PRX_WASENDER_API_KEY', 'PRX_WASENDER_TO',
    'PRX_WASENDER_PUBLIC_URL', 'PRX_WASENDER_EVENTS', 'PRX_WASENDER_PDF_PASSWORD',
    'PRX_HERMES_ENABLED', 'PRX_HERMES_GATEWAY_URL', 'PRX_HERMES_SECRET', 'PRX_HERMES_JIRA_WRITEBACK',
  ];

  try {
    const updates = {};
    for (const key of FIELDS) {
      if (key in req.body) updates[key] = String(req.body[key] || '').trim();
    }

    // Compute PRX_NOTIFY_MUTE_UNTIL from PRX_NOTIFY_MUTE_DAYS when saving with mute level
    const notifyLevel = updates['PRX_NOTIFY_LEVEL'] || '';
    const muteDays    = parseInt(updates['PRX_NOTIFY_MUTE_DAYS'] || '0', 10);
    if (notifyLevel === 'mute' && muteDays > 0) {
      const until = new Date(Date.now() + muteDays * 86400 * 1000);
      updates['PRX_NOTIFY_MUTE_UNTIL'] = until.toISOString();
    } else if (notifyLevel !== 'mute') {
      updates['PRX_NOTIFY_MUTE_UNTIL'] = '';
    }

    writeEnvValues(updates);
    // Bust budget cache so new admin key / budget takes effect immediately
    _budgetCache    = null;
    _budgetCachedAt = 0;

    // Reset Redis client whenever Redis config changes so any stale connection
    // (e.g. wrong password) is dropped and the new settings take effect immediately.
    if (['PRX_REDIS_ENABLED','PRX_REDIS_URL','PRX_REDIS_PASSWORD','PRX_REDIS_PREFIX'].some(k => k in updates)) {
      try { require('../memory/memoryAdapter').resetRedisClient(); } catch (_) {}
    }

    activityLog.record('settings_saved', null, 'user', {
      fields: Object.keys(updates).filter(k => updates[k] !== '').join(','),
    });
    // Notify index.js to reactively start/stop workers (disk monitor, watchdog)
    // without requiring a full server restart.
    serverEvents.emit('settings-saved', updates);

    // Hermes: when toggled to Y, try to install skill + start gateway immediately.
    // Route change (/jira-events ↔ /internal/enqueue) still requires restart.
    if (updates.PRX_HERMES_ENABLED === 'Y') {
      setImmediate(() => {
        try {
          const manager = require('../integrations/hermes/manager');
          manager.startup();
        } catch (err) {
          console.warn('[hermes] startup after settings save failed:', err.message);
        }
      });
    }
  } catch (err) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(renderSettings(readEnvValues(), 'error'));
  }

  if (req.body._restart === '1') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderRestartPage());
    // Detached script: stop current server then start fresh (picks up new .env)
    setImmediate(() => {
      const scripts = path.join(__dirname, '../scripts');
      const child = spawn('bash', ['-c',
        `sleep 1 && bash "${scripts}/stop.sh" && sleep 2 && bash "${scripts}/start.sh"`
      ], { detached: true, stdio: 'ignore' });
      child.unref();
    });
  } else {
    res.redirect(303, '/dashboard/settings?saved=1');
  }
});

// Standalone restart (no save) — useful for manual recovery
router.post('/restart', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderRestartPage());
  setImmediate(() => {
    const scripts = path.join(__dirname, '../scripts');
    const child = spawn('bash', ['-c',
      `sleep 1 && bash "${scripts}/stop.sh" && sleep 2 && bash "${scripts}/start.sh"`
    ], { detached: true, stdio: 'ignore' });
    child.unref();
  });
});

// Manual update check — fetches latest version from GitHub and updates status file
router.post('/check-update', (_req, res) => {
  const https = require('https');
  const pluginJsonPath = path.resolve(__dirname, '../../plugin/.claude-plugin/plugin.json');
  let currentVersion = '0.0.0';
  try { currentVersion = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf8')).version || '0.0.0'; } catch (_) {}

  const REMOTE_URL = 'https://raw.githubusercontent.com/dodogeny/prevoyant-claude-plugin/main/plugin/.claude-plugin/plugin.json';

  function semverNewer(remote, current) {
    const parse = v => v.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
    const [rMaj, rMin, rPat] = parse(remote);
    const [cMaj, cMin, cPat] = parse(current);
    if (rMaj !== cMaj) return rMaj > cMaj;
    if (rMin !== cMin) return rMin > cMin;
    return rPat > cPat;
  }

  const req2 = https.get(REMOTE_URL, { timeout: 15000 }, r => {
    if (r.statusCode !== 200) {
      r.resume();
      return res.json({ ok: false, error: `HTTP ${r.statusCode}` });
    }
    let data = '';
    r.on('data', chunk => { data += chunk; });
    r.on('end', () => {
      try {
        const latestVersion = JSON.parse(data).version || null;
        const available = latestVersion ? semverNewer(latestVersion, currentVersion) : false;
        const statusFile = UPDATE_STATUS_FILE;
        let existing = {};
        try { existing = JSON.parse(fs.readFileSync(statusFile, 'utf8')); } catch (_) {}
        const updated = { ...existing, available, latestVersion, currentVersion, checkedAt: new Date().toISOString() };
        try {
          fs.mkdirSync(path.dirname(statusFile), { recursive: true });
          fs.writeFileSync(statusFile, JSON.stringify(updated, null, 2));
        } catch (_) {}
        res.json({ ok: true, available, latestVersion, currentVersion });
      } catch (e) {
        res.json({ ok: false, error: `Bad JSON: ${e.message}` });
      }
    });
  });
  req2.on('error', e => res.json({ ok: false, error: e.message }));
  req2.on('timeout', () => { req2.destroy(); res.json({ ok: false, error: 'Request timed out' }); });
});

// Upgrade — pulls latest from git then restarts the server
router.post('/upgrade', (_req, res) => {
  const repoRoot = path.resolve(__dirname, '../..');
  const { execFile: ef } = require('child_process');

  ef('git', ['-C', repoRoot, 'pull', '--ff-only'], { timeout: 60000 }, (err, stdout, stderr) => {
    if (err) {
      const msg = (stderr || err.message || '').trim();
      activityLog.record('upgrade_failed', null, 'system', { error: msg });
      return res.json({ ok: false, error: msg });
    }

    activityLog.record('upgrade_completed', null, 'system', { output: stdout.trim() });
    res.json({ ok: true, output: stdout.trim() });

    // Restart server after a brief delay so the JSON response reaches the client
    setImmediate(() => {
      const scripts = path.join(__dirname, '../scripts');
      let child;
      if (process.platform === 'win32') {
        child = spawn('powershell', [
          '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
          `Start-Sleep 2; & "${scripts}\\stop.ps1"; Start-Sleep 2; & "${scripts}\\start.ps1"`
        ], { detached: true, stdio: 'ignore' });
      } else {
        child = spawn('bash', ['-c',
          `sleep 2 && bash "${scripts}/stop.sh" && sleep 2 && bash "${scripts}/start.sh"`
        ], { detached: true, stdio: 'ignore' });
      }
      child.unref();
    });
  });
});

// ── Ticket Watcher ────────────────────────────────────────────────────────────

router.get('/watch', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderWatch(req.query.flash || null));
});

router.get('/watch/json', (_req, res) => {
  res.json(watchStore.list());
});

router.post('/watch/add', express.urlencoded({ extended: false }), (req, res) => {
  const key      = ((req.body.key || '').toUpperCase().trim()).replace(/[^A-Z0-9_-]/g, '');
  const interval = ['1h','1d','2d','5d'].includes(req.body.interval) ? req.body.interval : '1d';
  const maxPolls = parseInt(req.body.maxPolls) || 0;

  if (!key) return res.redirect(303, '/dashboard/watch?flash=nokey');

  const existing = watchStore.get(key);
  if (existing && existing.status === 'watching') {
    return res.redirect(303, '/dashboard/watch?flash=exists');
  }

  watchStore.addTicket(key, interval, maxPolls);
  watchManager.addTicket(key, interval, maxPolls);
  activityLog.record('watch_added', key, 'user', { interval, maxPolls });
  res.redirect(303, '/dashboard/watch?flash=added');
});

router.post('/watch/:key/stop', (req, res) => {
  const key = (req.params.key || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  watchStore.stopTicket(key);
  watchManager.stopTicket(key);
  activityLog.record('watch_stopped', key, 'user', {});
  res.redirect(303, '/dashboard/watch?flash=stopped');
});

router.post('/watch/:key/resume', (req, res) => {
  const key = (req.params.key || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  watchStore.resumeTicket(key);
  watchManager.resumeTicket(key);
  activityLog.record('watch_resumed', key, 'user', {});
  res.redirect(303, '/dashboard/watch?flash=resumed');
});

router.post('/watch/:key/poll', (req, res) => {
  const key = (req.params.key || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  watchManager.pollNow(key);
  res.redirect(303, '/dashboard/watch?flash=polled');
});

router.post('/watch/:key/remove', (req, res) => {
  const key = (req.params.key || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  watchStore.stopTicket(key);
  watchManager.stopTicket(key);
  watchStore.removeTicket(key);
  activityLog.record('watch_removed', key, 'user', {});
  res.redirect(303, '/dashboard/watch?flash=removed');
});

// ── Watch log routes ──────────────────────────────────────────────────────────

// Tail the current (or specified) log file — JSON, used by the live panel
router.get('/watch/:key/log/tail', (req, res) => {
  const key    = (req.params.key || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  const ticket = watchStore.get(key);
  const file   = path.basename((req.query.file || ticket?.lastLogFile || '').toString());
  if (!file || !file.endsWith('.log')) return res.json({ content: '', done: true });
  const logPath = path.join(WATCH_LOG_DIR, key, file);
  try {
    const content = fs.readFileSync(logPath, 'utf8');
    res.json({ content, done: !(ticket?.pollingNow && ticket?.lastLogFile === file) });
  } catch (_) {
    res.json({ content: '', done: true });
  }
});

// List all log files for a ticket
router.get('/watch/:key/logs', (req, res) => {
  const key    = (req.params.key || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  const logDir = path.join(WATCH_LOG_DIR, key);
  let files = [];
  try {
    files = fs.readdirSync(logDir)
      .filter(f => f.endsWith('.log'))
      .sort()
      .reverse();
  } catch (_) {}
  res.send(renderWatchLogs(key, files, watchStore.get(key), req.query.flash || null));
});

// Delete all log files for a ticket (removes the entire ticket log directory)
router.post('/watch/:key/logs/clear', (req, res) => {
  const key    = (req.params.key || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  const ticket = watchStore.get(key);
  if (ticket?.pollingNow) return res.redirect(303, `/dashboard/watch/${key}/logs`);
  const logDir = path.join(WATCH_LOG_DIR, key);
  try { fs.rmSync(logDir, { recursive: true, force: true }); } catch (_) {}
  res.redirect(303, `/dashboard/watch/${key}/logs?flash=cleared`);
});

// View a specific log file
router.get('/watch/:key/logs/:file', (req, res) => {
  const key    = (req.params.key || '').toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  const file   = path.basename(req.params.file || '');
  if (!file.endsWith('.log')) return res.status(400).send('Invalid log file');
  const logPath = path.join(WATCH_LOG_DIR, key, file);
  try {
    const content = fs.readFileSync(logPath, 'utf8');
    res.send(renderWatchLogView(key, file, content, watchStore.get(key)));
  } catch (_) {
    res.status(404).send('Log file not found');
  }
});

// ── Report file serving (for WhatsApp document delivery) ─────────────────────
// WaSenderAPI fetches the document from a URL — this endpoint serves PDFs from
// CLAUDE_REPORT_DIR so WaSenderAPI can retrieve them. Requires PRX_WASENDER_PUBLIC_URL
// to be set to a publicly reachable base URL (e.g. https://yourserver.com).

router.get('/reports/serve/:filename', (req, res) => {
  const filename = path.basename(req.params.filename || '');
  if (!filename.match(/^[A-Za-z0-9_\-]+\.pdf$/i)) return res.status(400).send('Invalid filename');
  const dir      = process.env.CLAUDE_REPORT_DIR || path.join(os.homedir(), '.prevoyant', 'reports');
  const filePath = path.join(dir, filename);
  if (!filePath.startsWith(dir + path.sep)) return res.status(403).send('Forbidden');
  if (!fs.existsSync(filePath)) return res.status(404).send('Report not found');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  fs.createReadStream(filePath).pipe(res);
});

// ── Knowledge Builder ─────────────────────────────────────────────────────────
// Tracks the autonomous KB Flow Analyst worker: status, contributions queued for
// approval, and the run history. Both files live in ~/.prevoyant/knowledge-buildup/
// (outside the KB tree so they cannot accidentally be synced or committed).

const KBFLOW_STATE_FILE = path.join(os.homedir(), '.prevoyant', 'server', 'kbflow-analyst-state.json');

function readKbflowState() {
  try { return JSON.parse(fs.readFileSync(KBFLOW_STATE_FILE, 'utf8')); }
  catch (_) { return {}; }
}

// Parse the kbflow-pending.md buildup file into structured proposals.
// Format (one block per proposal, separated by ---):
//   ## JP-NNN — Title
//   Status: PENDING APPROVAL | APPROVED | ... | REJECTED
//   Flow: ...
//   Incidents: ...
//   Proposed: YYYY-MM-DD
//   Type: CMM-ARCH | CMM-BIZ | CMM-DATA | CMM-GOTCHA
//   Action: NEW | CORRECT | CONFIRM
//   {body}
//   ref: file:line
function parseKbflowPending(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch (_) { return []; }

  const blocks = raw.split(/^---\s*$/m).map(b => b.trim()).filter(Boolean);
  const items  = [];

  for (const block of blocks) {
    const titleMatch = block.match(/^##\s+(JP-\d+)\s*[—–-]\s*(.+?)\s*$/m);
    if (!titleMatch) continue;

    const meta = {
      id:        titleMatch[1],
      title:     titleMatch[2],
      status:    (block.match(/^Status:\s*(.+?)\s*$/m)        || [, ''])[1],
      flow:      (block.match(/^Flow:\s*(.+?)\s*$/m)          || [, ''])[1],
      incidents: (block.match(/^Incidents:\s*(.+?)\s*$/m)     || [, ''])[1],
      proposed:  (block.match(/^Proposed:\s*(.+?)\s*$/m)      || [, ''])[1],
      type:      (block.match(/^Type:\s*(.+?)\s*$/m)          || [, ''])[1],
      action:    (block.match(/^Action:\s*(.+?)\s*$/m)        || [, ''])[1],
      ref:       (block.match(/^ref:\s*(.+?)\s*$/m)           || [, ''])[1],
    };

    // The body sits between the metadata block and the `ref:` line.
    const lines = block.split('\n');
    const bodyLines = [];
    let inBody = false;
    for (const line of lines) {
      if (/^(##|Status:|Flow:|Incidents:|Proposed:|Type:|Action:|ref:)/.test(line)) {
        if (!line.startsWith('##') && !inBody) continue;
      }
      if (line.startsWith('##')) { inBody = true; continue; }
      if (line.startsWith('ref:')) { inBody = false; continue; }
      if (inBody && /^(Status|Flow|Incidents|Proposed|Type|Action):/.test(line)) continue;
      if (inBody) bodyLines.push(line);
    }
    meta.body = bodyLines.join('\n').trim();

    items.push(meta);
  }
  return items;
}

// Parse the kbflow-sessions.md buildup file — a markdown table.
// New format (6 cols): | Date | Flows Analysed | CMM Proposals | Patterns | Lessons | Status |
// Old format (5 cols): | Date | Flows Analysed | Proposals | Confirmations | Status |
function parseKbflowSessions(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch (_) { return []; }

  const lines = raw.split('\n');
  const rows  = [];
  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    if (cells.length < 5) continue;
    if (/^[-:\s]+$/.test(cells[0])) continue;
    if (cells[0].toLowerCase() === 'date') continue;
    if (cells.length >= 6) {
      // New 6-column format
      rows.push({ date: cells[0], flows: cells[1], proposals: cells[2],
                  patterns: cells[3], lessons: cells[4], status: cells[5] });
    } else {
      // Old 5-column format (confirmations instead of patterns/lessons)
      rows.push({ date: cells[0], flows: cells[1], proposals: cells[2],
                  patterns: '—', lessons: '—', status: cells[4] });
    }
  }
  return rows.reverse(); // newest first
}

function linkIncidents(incidents, jiraBase) {
  if (!incidents || incidents === '—') return esc(incidents || '—');
  if (!jiraBase) return esc(incidents);
  return incidents.split(/,\s*/).map(key => {
    const k = key.trim();
    if (!k) return '';
    return `<a href="${esc(jiraBase)}/browse/${esc(k)}" target="_blank" rel="noopener" style="color:#1e40af;text-decoration:none;font-family:ui-monospace,monospace;font-size:.75rem;white-space:nowrap">${esc(k)}</a>`;
  }).filter(Boolean).join('<span style="color:#d1d5db"> · </span>');
}

function statusBadge(status) {
  const s = String(status || '').trim().toUpperCase();
  if (s.startsWith('PENDING'))  return `<span style="padding:2px 8px;border-radius:8px;font-size:.72rem;font-weight:600;background:#fef3c7;color:#92400e">PENDING</span>`;
  if (s.startsWith('APPROVED')) return `<span style="padding:2px 8px;border-radius:8px;font-size:.72rem;font-weight:600;background:#dcfce7;color:#166534">APPROVED</span>`;
  if (s.startsWith('REJECTED')) return `<span style="padding:2px 8px;border-radius:8px;font-size:.72rem;font-weight:600;background:#fee2e2;color:#991b1b">REJECTED</span>`;
  if (s.startsWith('PARTIAL'))  return `<span style="padding:2px 8px;border-radius:8px;font-size:.72rem;font-weight:600;background:#fef3c7;color:#b45309">PARTIAL</span>`;
  if (s === 'INFO')             return `<span style="padding:2px 8px;border-radius:8px;font-size:.72rem;font-weight:600;background:#e0f2fe;color:#0369a1">INFO</span>`;
  return `<span style="padding:2px 8px;border-radius:8px;font-size:.72rem;font-weight:600;background:#f3f4f6;color:#374151">${esc(status || '—')}</span>`;
}

function typeBadge(type) {
  const t = (type || '').trim().toUpperCase();
  const map = {
    'CMM-ARCH':   ['#ede9fe','#5b21b6'],
    'CMM-BIZ':    ['#dcfce7','#166534'],
    'CMM-DATA':   ['#f3e8ff','#7e22ce'],
    'CMM-GOTCHA': ['#ffedd5','#c2410c'],
    'PATTERN':    ['#cffafe','#0e7490'],
    'LESSON':     ['#fce7f3','#9d174d'],
  };
  const [bg, fg] = map[t] || ['#f3f4f6','#374151'];
  return `<span style="padding:2px 7px;border-radius:6px;font-size:.68rem;font-weight:600;background:${bg};color:${fg};white-space:nowrap">${esc(type || '—')}</span>`;
}

function actionBadge(action) {
  const a = (action || '').trim().toUpperCase();
  const map = { 'NEW': ['#dbeafe','#1e40af'], 'CORRECT': ['#fef3c7','#92400e'], 'CONFIRM': ['#dcfce7','#166534'] };
  const [bg, fg] = map[a] || ['#f3f4f6','#374151'];
  return `<span style="padding:2px 7px;border-radius:6px;font-size:.68rem;font-weight:600;background:${bg};color:${fg};white-space:nowrap">${esc(action || '—')}</span>`;
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  if (s < 60)   return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60)   return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// ── Hermes Config page ────────────────────────────────────────────────────────

function renderHermesInsightsReview() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hermes Insights — Review</title>
<style>
  ${BASE_CSS}
  .breadcrumb { font-size:0.8rem; color:#a0a8c0; }
  .breadcrumb a { color:#a0a8c0; text-decoration:none; }
  .breadcrumb a:hover { color:#fff; }
  .ir-wrap { max-width:1000px; margin:1.5rem auto 4rem; padding:0 1.2rem; }
  .ir-summary { display:flex; gap:.75rem; flex-wrap:wrap; margin-bottom:1rem; font-size:.82rem; }
  .ir-chip { background:#fff; border:1px solid #e5e7eb; border-radius:8px; padding:.45rem .85rem; }
  .ir-chip .lbl { color:#6b7280; font-size:.7rem; text-transform:uppercase; letter-spacing:.05em; }
  .ir-chip .val { font-weight:700; font-size:1.05rem; color:#1e293b; }
  .ir-chip.pending  .val { color:#92400e; }
  .ir-chip.approved .val { color:#166534; }
  .ir-chip.rejected .val { color:#991b1b; }
  .ir-empty { background:#fff; border:1px dashed #cbd5e1; border-radius:10px; padding:2.5rem 1rem; text-align:center; color:#94a3b8; font-size:.9rem; }
  .ir-card { background:#fff; border:1px solid #e5e7eb; border-radius:10px; margin-bottom:.9rem; overflow:hidden; }
  .ir-card-head { display:flex; align-items:center; gap:.6rem; padding:.7rem 1rem; border-bottom:1px solid #f1f5f9; flex-wrap:wrap; }
  .ir-card-title { font-size:.95rem; font-weight:600; color:#1e293b; flex:1; min-width:200px; }
  .ir-tag { font-size:.7rem; padding:1px 8px; border-radius:9px; font-weight:600; }
  .ir-tag-cat   { background:#ede9fe; color:#5b21b6; border:1px solid #ddd6fe; }
  .ir-tag-conf  { background:#fef3c7; color:#92400e; border:1px solid #fde68a; }
  .ir-tag-conf-high   { background:#dcfce7; color:#166534; border-color:#86efac; }
  .ir-tag-conf-low    { background:#f3f4f6; color:#6b7280; border-color:#d1d5db; }
  .ir-meta { padding:.45rem 1rem; font-size:.74rem; color:#6b7280; display:flex; flex-wrap:wrap; gap:.4rem .9rem; background:#f8fafc; border-bottom:1px solid #f1f5f9; }
  .ir-meta code { font-family:ui-monospace,monospace; background:#fff; border:1px solid #e5e7eb; border-radius:4px; padding:1px 5px; font-size:.72rem; color:#475569; }
  .ir-body { padding:.85rem 1rem; font-size:.84rem; color:#1f2937; line-height:1.55; max-height:340px; overflow:auto; white-space:pre-wrap; word-wrap:break-word; }
  .ir-body.editing { display:none; }
  .ir-edit { padding:.85rem 1rem; display:none; }
  .ir-edit.show { display:block; }
  .ir-edit input, .ir-edit textarea { width:100%; box-sizing:border-box; padding:.4rem .6rem; border:1px solid #e2e8f0; border-radius:6px; font-size:.83rem; color:#1e293b; font-family:inherit; }
  .ir-edit textarea { min-height:160px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.78rem; line-height:1.5; }
  .ir-edit label { display:block; font-size:.72rem; font-weight:600; color:#475569; margin:.4rem 0 .2rem; text-transform:uppercase; letter-spacing:.04em; }
  .ir-actions { display:flex; gap:.5rem; padding:.65rem 1rem; border-top:1px solid #f1f5f9; flex-wrap:wrap; }
  .ir-btn { font-size:.8rem; padding:.4rem .95rem; border-radius:7px; border:1px solid; cursor:pointer; font-weight:600; font-family:inherit; }
  .ir-btn-approve { background:#dcfce7; color:#166534; border-color:#86efac; }
  .ir-btn-approve:hover { background:#bbf7d0; }
  .ir-btn-edit    { background:#fff;    color:#1e40af; border-color:#93c5fd; }
  .ir-btn-edit:hover { background:#eff6ff; }
  .ir-btn-reject  { background:#fee2e2; color:#991b1b; border-color:#fca5a5; }
  .ir-btn-reject:hover { background:#fecaca; }
  .ir-btn-cancel  { background:#fff;    color:#6b7280; border-color:#d1d5db; }
  .ir-toast { position:fixed; right:1.5rem; bottom:1.5rem; padding:.65rem 1rem; border-radius:8px; font-size:.82rem; font-weight:600; box-shadow:0 8px 24px rgba(0,0,0,.15); z-index:1000; }
  .ir-toast-ok  { background:#dcfce7; color:#166534; border:1px solid #86efac; }
  .ir-toast-err { background:#fee2e2; color:#991b1b; border:1px solid #fca5a5; }
</style>
</head>
<body>
  <header>
    <h1><span class="sun-logo"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg></span>Prevoyant Server</h1>
    <span class="version-badge">v${pluginVersion}</span>
    <div class="meta">
      <span class="breadcrumb"><a href="/dashboard">Dashboard</a> › <a href="/dashboard/hermes-config">Hermes Config</a> › Insights Review</span>
    </div>
  </header>

  <div class="ir-wrap">
    <div class="ir-summary" id="ir-summary">
      <div class="ir-chip pending"><div class="lbl">Pending</div><div class="val" id="cnt-pending">—</div></div>
      <div class="ir-chip approved"><div class="lbl">Approved</div><div class="val" id="cnt-approved">—</div></div>
      <div class="ir-chip rejected"><div class="lbl">Rejected (last 30 d)</div><div class="val" id="cnt-rejected">—</div></div>
      <div style="margin-left:auto;display:flex;align-items:center"><button class="ir-btn ir-btn-cancel" onclick="loadPending()">↻ Refresh</button></div>
    </div>

    <div id="ir-list"></div>
    <div id="ir-empty" class="ir-empty" style="display:none">
      <strong>No pending insights.</strong><br>
      Hermes-contributed insights land here when <code>PRX_HERMES_KB_WRITEBACK_ENABLED=Y</code> and Hermes calls <code>POST /internal/kb/insights</code>.
    </div>
  </div>

  <script>
    function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    function asArr(v) { return Array.isArray(v) ? v : (v ? [v] : []); }
    function fmtDate(s) { try { return new Date(s).toLocaleString('en-GB', { dateStyle:'short', timeStyle:'short' }); } catch { return s; } }
    function toast(msg, kind) {
      const t = document.createElement('div');
      t.className = 'ir-toast ir-toast-' + (kind === 'err' ? 'err' : 'ok');
      t.textContent = msg;
      document.body.appendChild(t);
      setTimeout(() => { t.style.transition = 'opacity .35s'; t.style.opacity = '0'; }, 2800);
      setTimeout(() => t.remove(), 3200);
    }

    function renderCard(item) {
      const m = item.meta || {};
      const cat = (m.category || 'insight').toString();
      const conf = (m.confidence || '').toString().toLowerCase();
      const confClass = conf === 'high' ? 'ir-tag-conf-high' : conf === 'low' ? 'ir-tag-conf-low' : '';
      const tickets = asArr(m.tickets);
      const tags    = asArr(m.tags);

      return \`
        <div class="ir-card" data-file="\${esc(item.file)}">
          <div class="ir-card-head">
            <div class="ir-card-title">\${esc(m.title || '(no title)')}</div>
            <span class="ir-tag ir-tag-cat">\${esc(cat)}</span>
            \${conf ? '<span class="ir-tag ir-tag-conf ' + confClass + '">' + esc(conf) + ' confidence</span>' : ''}
          </div>
          <div class="ir-meta">
            <span>📁 <code>\${esc(item.file)}</code></span>
            \${m.recorded_at ? '<span>🕐 ' + esc(fmtDate(m.recorded_at)) + '</span>' : ''}
            \${tickets.length ? '<span>🎫 ' + tickets.map(t => '<code>' + esc(t) + '</code>').join(' ') + '</span>' : ''}
            \${tags.length    ? '<span>🏷 ' + tags.map(t => '<code>' + esc(t) + '</code>').join(' ') + '</span>'    : ''}
          </div>
          <div class="ir-body">\${esc(item.body)}</div>
          <div class="ir-edit">
            <label>Title</label>
            <input type="text" class="ed-title" value="\${esc(m.title || '')}" maxlength="200">
            <label>Body (markdown, ≤ 16 KB)</label>
            <textarea class="ed-body">\${esc(item.body)}</textarea>
            <label>Category</label>
            <input type="text" class="ed-cat" value="\${esc(cat)}" placeholder="bug-pattern | lesson | playbook | warning | insight">
          </div>
          <div class="ir-actions">
            <button class="ir-btn ir-btn-approve" onclick="doApprove('\${esc(item.file)}', false)">✓ Approve as-is</button>
            <button class="ir-btn ir-btn-edit"    onclick="toggleEdit('\${esc(item.file)}')">✎ Edit & approve</button>
            <button class="ir-btn ir-btn-reject"  onclick="doReject('\${esc(item.file)}')">✗ Reject</button>
          </div>
        </div>\`;
    }

    function loadPending() {
      fetch('/dashboard/api/hermes-insights/pending').then(r => r.json()).then(d => {
        if (!d.ok) { toast('Load failed: ' + (d.reason || 'unknown'), 'err'); return; }
        document.getElementById('cnt-pending').textContent  = d.counts.pending;
        document.getElementById('cnt-approved').textContent = d.counts.approved;
        document.getElementById('cnt-rejected').textContent = d.counts.rejected;
        const list = document.getElementById('ir-list');
        const empty = document.getElementById('ir-empty');
        if (d.pending.length === 0) { list.innerHTML = ''; empty.style.display = ''; }
        else { empty.style.display = 'none'; list.innerHTML = d.pending.map(renderCard).join(''); }
      }).catch(err => toast('Network error: ' + err.message, 'err'));
    }

    function findCard(file) { return document.querySelector('.ir-card[data-file="' + CSS.escape(file) + '"]'); }

    function toggleEdit(file) {
      const card = findCard(file); if (!card) return;
      const body = card.querySelector('.ir-body');
      const edit = card.querySelector('.ir-edit');
      const approve = card.querySelector('.ir-btn-approve');
      const editBtn = card.querySelector('.ir-btn-edit');
      const editing = edit.classList.toggle('show');
      body.style.display = editing ? 'none' : '';
      approve.textContent = editing ? '✓ Save & approve' : '✓ Approve as-is';
      approve.onclick = () => doApprove(file, editing);
      editBtn.textContent = editing ? 'Cancel edit' : '✎ Edit & approve';
    }

    function doApprove(file, withEdits) {
      const card = findCard(file);
      const payload = { file };
      if (withEdits && card) {
        payload.edits = {
          title:    card.querySelector('.ed-title').value.trim(),
          body:     card.querySelector('.ed-body').value,
          category: card.querySelector('.ed-cat').value.trim(),
        };
      }
      fetch('/dashboard/api/hermes-insights/approve', {
        method: 'POST', headers: { 'Content-Type':'application/json' },
        body: JSON.stringify(payload),
      }).then(r => r.json()).then(d => {
        if (!d.ok) return toast('Approve failed: ' + (d.reason || 'unknown'), 'err');
        toast(\`✓ \${file} approved\${d.edited ? ' (edited)' : ''}\`, 'ok');
        if (card) card.remove();
        loadPending();
      }).catch(err => toast('Network error: ' + err.message, 'err'));
    }

    function doReject(file) {
      const reason = prompt('Reason for rejecting this insight? (optional, ≤ 500 chars)');
      if (reason === null) return; // cancelled
      fetch('/dashboard/api/hermes-insights/reject', {
        method: 'POST', headers: { 'Content-Type':'application/json' },
        body: JSON.stringify({ file, reason }),
      }).then(r => r.json()).then(d => {
        if (!d.ok) return toast('Reject failed: ' + (d.reason || 'unknown'), 'err');
        toast(\`✗ \${file} rejected\`, 'ok');
        const card = findCard(file); if (card) card.remove();
        loadPending();
      }).catch(err => toast('Network error: ' + err.message, 'err'));
    }

    loadPending();
    setInterval(loadPending, 30000);
  </script>
</body></html>`;
}

function renderHermesConfig(vals, flash) {
  const v = k => vals[k] || '';

  const flashHtml = flash === 'saved'
    ? `<div class="s-flash s-flash-ok">Settings saved.</div>`
    : flash === 'error'
    ? `<div class="s-flash s-flash-err">Save failed — check server logs.</div>`
    : '';

  const tgEvents  = v('PRX_TELEGRAM_EVENTS') || NOTIFY_EVENTS.map(e => e.key).join(',');
  const tgChecked = new Set(tgEvents.split(',').map(s => s.trim()).filter(Boolean));

  const eventGroups = {};
  for (const e of NOTIFY_EVENTS) {
    if (!eventGroups[e.group]) eventGroups[e.group] = [];
    eventGroups[e.group].push(e);
  }

  const tgEventCheckboxes = Object.entries(eventGroups).map(([groupName, evts]) => {
    const boxes = evts.map(e =>
      `<label class="n-evt-lbl">
        <input type="checkbox" class="tg-evt-cb" value="${esc(e.key)}" ${tgChecked.has(e.key) ? 'checked' : ''} onchange="syncTgEvents()">
        ${esc(e.label)}
      </label>`
    ).join('');
    return `<div class="n-group"><div class="n-group-lbl">${esc(groupName)}</div><div class="n-events-grid">${boxes}</div></div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hermes Config — Prevoyant</title>
<style>
  ${BASE_CSS}
  .breadcrumb { font-size:0.8rem; color:#a0a8c0; }
  .breadcrumb a { color:#a0a8c0; text-decoration:none; }
  .breadcrumb a:hover { color:#fff; }
  .s-section { background:#fff; border:1px solid #e5e7eb; border-radius:10px; margin-bottom:1rem; overflow:hidden; }
  .s-section summary { padding:.85rem 1.1rem; cursor:pointer; user-select:none; display:flex; align-items:center; gap:.6rem; font-weight:600; font-size:.9rem; color:#1e293b; list-style:none; }
  .s-section summary:hover { background:#f8fafc; }
  .s-section summary::-webkit-details-marker { display:none; }
  .s-section summary .s-chevron { margin-left:auto; color:#94a3b8; transition:transform .2s; }
  .s-section[open] summary .s-chevron { transform:rotate(90deg); }
  .s-section summary .s-opt { font-size:.68rem; font-weight:500; color:#6b7280; background:#f3f4f6; padding:1px 7px; border-radius:8px; }
  .s-body { display:grid; grid-template-columns:1fr 1fr; gap:.85rem 1.2rem; padding:1rem 1.1rem 1.2rem; border-top:1px solid #f1f5f9; }
  .s-body.full-width > * { grid-column:span 2; }
  .s-field { display:flex; flex-direction:column; gap:.3rem; }
  .s-field.span2 { grid-column:span 2; }
  .s-label { font-size:.77rem; font-weight:600; color:#475569; display:flex; flex-wrap:wrap; align-items:center; gap:.4rem; }
  .s-key { font-size:.7rem; font-weight:400; color:#94a3b8; background:#f8fafc; padding:1px 5px; border-radius:4px; font-family:ui-monospace,monospace; }
  .s-input { padding:.42rem .65rem; border:1px solid #e2e8f0; border-radius:6px; font-size:.83rem; color:#1e293b; width:100%; box-sizing:border-box; background:#fff; }
  .s-input:focus { outline:none; border-color:#6366f1; box-shadow:0 0 0 3px rgba(99,102,241,.1); }
  .s-hint { font-size:.72rem; color:#94a3b8; line-height:1.55; }
  .s-flash { padding:.55rem 1rem; border-radius:7px; font-size:.83rem; font-weight:600; margin-bottom:1rem; }
  .s-flash-ok  { background:#dcfce7; color:#166534; border:1px solid #86efac; }
  .s-flash-err { background:#fee2e2; color:#991b1b; border:1px solid #fca5a5; }
  .status-row { display:flex; gap:.5rem; align-items:center; flex-wrap:wrap; padding:.75rem 1.1rem; background:#f8fafc; border-bottom:1px solid #e5e7eb; }
  .n-events-grid { display:flex; flex-wrap:wrap; gap:.4rem .8rem; }
  .n-evt-lbl { font-size:.78rem; display:flex; align-items:center; gap:.3rem; cursor:pointer; }
  .n-group { margin-bottom:.6rem; }
  .n-group-lbl { font-size:.7rem; font-weight:700; color:#6b7280; text-transform:uppercase; letter-spacing:.05em; margin-bottom:.35rem; }
  .btn-save { background:var(--accent); color:#fff; border:none; border-radius:7px; padding:.55rem 1.4rem; font-size:.87rem; font-weight:600; cursor:pointer; }
  .btn-save:hover { background:#4f46e5; }
  .pw-wrap { position:relative; }
  .pw-wrap .s-input { padding-right:2.4rem; }
  .pw-eye { position:absolute; right:.55rem; top:50%; transform:translateY(-50%); background:none; border:none; cursor:pointer; color:#94a3b8; padding:0; }
  .hermes-badge-pill {
    display:inline-flex; align-items:center; gap:.4rem;
    padding:4px 11px; border-radius:14px; font-size:.76rem; font-weight:600;
    transition: background .25s, border-color .25s, color .25s, box-shadow .25s;
  }
  .badge-green { background:#dcfce7; color:#166534; border:1px solid #86efac; box-shadow:0 0 0 0 rgba(34,197,94,0); }
  .badge-green.alive { box-shadow:0 0 0 4px rgba(34,197,94,.12); }
  .badge-red   { background:#fee2e2; color:#991b1b; border:1px solid #fca5a5; }
  .badge-red.crash { box-shadow:0 0 0 4px rgba(239,68,68,.18); animation: hc-shake .6s ease-out 1; }
  .badge-blue  { background:#eff6ff; color:#1d4ed8; border:1px solid #93c5fd; }
  .badge-grey  { background:#f3f4f6; color:#6b7280; border:1px solid #d1d5db; }
  @keyframes hc-shake {
    0%,100% { transform: translateX(0); }
    25% { transform: translateX(-2px); }
    75% { transform: translateX(2px); }
  }

  /* status dots — coloured pulse inside each badge */
  .hc-dot {
    width:7px; height:7px; border-radius:50%;
    flex-shrink:0; position:relative; display:inline-block;
  }
  .hc-dot-green  { background:#16a34a; }
  .hc-dot-red    { background:#dc2626; }
  .hc-dot-blue   { background:#2563eb; }
  .hc-dot-grey   { background:#9ca3af; }
  .hc-dot.pulse::after {
    content:''; position:absolute; inset:-3px; border-radius:50%;
    border:2px solid currentColor; opacity:0;
    animation: hc-ripple 1.6s ease-out infinite;
  }
  .hc-dot-green.pulse::after { border-color:#22c55e; }
  .hc-dot-red.pulse::after   { border-color:#ef4444; }
  .hc-dot-blue.pulse::after  { border-color:#3b82f6; }
  @keyframes hc-ripple {
    0%   { opacity:.7; transform: scale(1); }
    100% { opacity:0;  transform: scale(2.4); }
  }

  /* toast for state transitions */
  .hc-toast {
    position:fixed; right:1.5rem; bottom:1.5rem; z-index:1000;
    padding:.7rem 1rem; border-radius:8px; font-size:.82rem; font-weight:600;
    box-shadow:0 8px 24px rgba(0,0,0,.15); display:flex; align-items:center; gap:.6rem;
    animation: hc-toast-in .25s ease-out;
    max-width:380px;
  }
  .hc-toast-ok   { background:#dcfce7; color:#166534; border:1px solid #86efac; }
  .hc-toast-err  { background:#fee2e2; color:#991b1b; border:1px solid #fca5a5; }
  .hc-toast-info { background:#eff6ff; color:#1e40af; border:1px solid #93c5fd; }
  @keyframes hc-toast-in {
    from { opacity:0; transform: translateY(8px); }
    to   { opacity:1; transform: translateY(0); }
  }

  /* the gateway-status row gets a thin top accent that reflects overall health */
  #hc-status-row { transition: border-top-color .3s, background .3s; border-top: 3px solid transparent; }
  #hc-status-row.healthy { border-top-color: #22c55e; }
  #hc-status-row.warn    { border-top-color: #f59e0b; }
  #hc-status-row.failed  { border-top-color: #ef4444; }
</style>
</head>
<body>
  <header>
    <h1><span class="sun-logo" id="sun-logo"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg></span>Prevoyant Server</h1>
    <span class="version-badge">v${pluginVersion}</span>
    <div class="meta">
      <span class="breadcrumb"><a href="/dashboard">Dashboard</a> › Hermes Config</span>
    </div>
  </header>

  <div style="max-width:860px;margin:1.5rem auto;padding:0 1.2rem">
    ${flashHtml}

    <!-- ── Live Status ───────────────────────────────────────────────────────── -->
    <div class="s-section" style="margin-bottom:1rem">
      <div style="padding:.75rem 1.1rem;font-weight:600;font-size:.88rem;color:#1e293b;border-bottom:1px solid #f1f5f9;display:flex;align-items:center;gap:.5rem">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
        Gateway Status
      </div>
      <div class="status-row" id="hc-status-row">
        <span id="hc-installed" class="hermes-badge-pill badge-grey"><span class="hc-dot hc-dot-grey"></span>Checking…</span>
        <span id="hc-gateway"   class="hermes-badge-pill badge-grey"><span class="hc-dot hc-dot-grey"></span>Gateway…</span>
        <span id="hc-skill"     class="hermes-badge-pill badge-grey"><span class="hc-dot hc-dot-grey"></span>Skill…</span>
        <button type="button" id="hc-gw-start" onclick="hcGatewayStart()" style="display:none;font-size:.78rem;padding:4px 12px;border:1px solid #86efac;border-radius:7px;background:#dcfce7;color:#166534;cursor:pointer;font-weight:600">▶ Start Gateway</button>
        <button type="button" id="hc-gw-stop"  onclick="hcGatewayStop()"  style="display:none;font-size:.78rem;padding:4px 12px;border:1px solid #fca5a5;border-radius:7px;background:#fee2e2;color:#991b1b;cursor:pointer;font-weight:600">■ Stop Gateway</button>
        <button type="button" onclick="hcCheckStatus()" style="font-size:.78rem;padding:4px 12px;border:1px solid #d1d5db;border-radius:7px;background:#fff;cursor:pointer;margin-left:auto">↻ Recheck</button>
      </div>
      <div id="hc-installing-banner" style="display:none;padding:.6rem 1.1rem;background:#eff6ff;border-top:1px solid #dbeafe;font-size:.8rem;color:#1e40af">
        ⏳ Installing Hermes CLI in the background… This may take a minute. Status will update automatically.
      </div>
    </div>

    <!-- ── Gateway Log (rolling, auto-refresh every 5s) ─────────────────────── -->
    <div class="s-section" style="margin-bottom:1rem">
      <div style="padding:.6rem 1.1rem;font-weight:600;font-size:.85rem;color:#1e293b;border-bottom:1px solid #f1f5f9;display:flex;align-items:center;gap:.5rem;flex-wrap:wrap">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>
        Gateway Log
        <span id="hc-log-meta" style="font-size:.7rem;color:#94a3b8;font-weight:400"></span>
        <label style="margin-left:auto;font-size:.72rem;color:#6b7280;display:flex;align-items:center;gap:.3rem;font-weight:500;cursor:pointer;user-select:none">
          <input type="checkbox" id="hc-log-auto" checked onchange="hcToggleLogAuto()" style="margin:0">
          Auto-refresh (5s)
        </label>
        <button type="button" onclick="hcLoadLog()" style="font-size:.72rem;padding:3px 9px;border:1px solid #d1d5db;border-radius:6px;background:#fff;cursor:pointer">↻ Refresh</button>
      </div>
      <pre id="hc-log" style="margin:0;padding:.75rem 1.1rem;background:#0f172a;color:#e2e8f0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.72rem;line-height:1.5;max-height:340px;overflow:auto;white-space:pre-wrap;word-break:break-word">Loading…</pre>
      <div id="hc-log-path" style="padding:.4rem 1.1rem;font-size:.68rem;color:#94a3b8;border-top:1px solid #f1f5f9;font-family:ui-monospace,monospace"></div>
    </div>

    <form method="POST" action="/dashboard/hermes-config">

      <!-- ── Hermes Connection ───────────────────────────────────────────────── -->
      <details class="s-section">
        <summary>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>
          Hermes Connection
          <span class="s-opt">Optional</span>
          <span class="s-chevron">›</span>
        </summary>
        <div class="s-body">
          <div class="s-field">
            <label class="s-label">Enable Hermes <code class="s-key">PRX_HERMES_ENABLED</code></label>
            <select name="PRX_HERMES_ENABLED" class="s-input">
              <option value="N"${v('PRX_HERMES_ENABLED') !== 'Y' ? ' selected' : ''}>N — standalone (default)</option>
              <option value="Y"${v('PRX_HERMES_ENABLED') === 'Y' ? ' selected' : ''}>Y — Hermes mode active</option>
            </select>
            <span class="s-hint">When enabled, Hermes becomes the front door for Jira events and delivers notifications to Telegram/Slack/Discord.</span>
          </div>
          <div class="s-field">
            <label class="s-label">Gateway URL <code class="s-key">PRX_HERMES_GATEWAY_URL</code></label>
            <input type="text" name="PRX_HERMES_GATEWAY_URL" value="${esc(v('PRX_HERMES_GATEWAY_URL') || 'http://localhost:8080')}" class="s-input" placeholder="http://localhost:8080">
            <span class="s-hint">Base URL of the Hermes gateway process.</span>
          </div>
          <div class="s-field span2 pw-wrap">
            <label class="s-label">Shared Secret <code class="s-key">PRX_HERMES_SECRET</code></label>
            <input type="password" id="hc-secret" name="PRX_HERMES_SECRET" value="${esc(v('PRX_HERMES_SECRET'))}" class="s-input" placeholder="leave blank to skip validation" autocomplete="off">
            <button type="button" class="pw-eye" onclick="togglePw('hc-secret',this)">
              <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>
            <span class="s-hint">Hermes must send this in <code>X-Hermes-Secret</code> when calling <code>/internal/enqueue</code>. Leave blank to skip validation.</span>
          </div>
        </div>
      </details>

      <!-- ── Behavior ───────────────────────────────────────────────────────── -->
      <details class="s-section">
        <summary>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
          Behavior
          <span class="s-opt">Optional</span>
          <span class="s-chevron">›</span>
        </summary>
        <div class="s-body">
          <div class="s-field span2">
            <label class="s-label">Jira Write-back <code class="s-key">PRX_HERMES_JIRA_WRITEBACK</code></label>
            <select name="PRX_HERMES_JIRA_WRITEBACK" class="s-input" style="max-width:320px">
              <option value="N"${v('PRX_HERMES_JIRA_WRITEBACK') !== 'Y' ? ' selected' : ''}>N — disabled</option>
              <option value="Y"${v('PRX_HERMES_JIRA_WRITEBACK') === 'Y' ? ' selected' : ''}>Y — post Jira comment when analysis completes</option>
            </select>
            <span class="s-hint">When enabled, Prevoyant posts a summary comment on the Jira ticket after each analysis.</span>
          </div>
          <div class="s-field span2">
            <label class="s-label">KB Write-back <code class="s-key">PRX_HERMES_KB_WRITEBACK_ENABLED</code></label>
            ${(() => {
              const cur = (v('PRX_HERMES_KB_WRITEBACK_ENABLED') || 'AUTO').toUpperCase();
              const sel = m => cur === m ? ' selected' : '';
              return `<select name="PRX_HERMES_KB_WRITEBACK_ENABLED" class="s-input" style="max-width:480px">
                <option value="N"${sel('N')}>N — disabled (endpoint returns 403)</option>
                <option value="AUTO"${cur !== 'N' && cur !== 'Y' ? ' selected' : ''}>AUTO — AI judge decides (default)</option>
                <option value="Y"${sel('Y')}>Y — every insight requires manual human approval</option>
              </select>`;
            })()}
            <span class="s-hint">
              Exposes <code>POST /internal/kb/insights</code> — <strong>only active when <code>PRX_HERMES_ENABLED=Y</code></strong>. Hermes calls it when it spots cross-ticket patterns (e.g. "5 tickets reference the same Redis bug").
              <br><br>
              <strong>AUTO mode (default):</strong> <strong>Hermes is the judge</strong> — it's already an LLM with cross-ticket context, so a separate Claude call to second-guess it would be redundant. The deployed <code>SKILL.md</code> tells Hermes to self-score every insight 0–10 on specificity / evidence / actionability / originality / clarity, and only POST when self-score ≥ 7. Prevoyant runs a cheap structural heuristic alongside as a sanity check. <strong>Both confident</strong> (self ≥ 7 AND heuristic ≥ 4) → auto-approved, re-indexed, visible to future agent runs. <strong>Hermes self-flagged junk</strong> (self ≤ 3) → auto-rejected. <strong>They disagree</strong> → kicked to <a href="/dashboard/hermes-insights" style="color:#1e40af">/dashboard/hermes-insights</a> for a human. Frontmatter records both scores for audit. No external API call, no <code>ANTHROPIC_API_KEY</code> required.
              <br><br>
              <strong>Y mode:</strong> bypasses Hermes's self-judgement — every insight requires a human approve / reject click. Use this when you're auditing what Hermes is sending in week 1.
              <br><br>
              <strong>N mode:</strong> endpoint is fully disabled (returns 403).
              <br><br>
              Auth uses the same <code>X-Hermes-Secret</code> as the enqueue endpoint.
            </span>
          </div>
        </div>
      </details>

      <!-- ── Telegram Notifications ─────────────────────────────────────────── -->
      <details class="s-section">
        <summary>
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
          Telegram Notifications
          <span class="s-opt">Optional</span>
          <span class="s-chevron">›</span>
        </summary>
        <div class="s-body">
          <div class="s-field span2" style="background:#eff6ff;border:1px solid #dbeafe;border-radius:7px;padding:.65rem .85rem;gap:.3rem">
            <span style="font-size:.78rem;color:#1e40af;font-weight:600">How to set up</span>
            <span style="font-size:.75rem;color:#1e40af">1. Create a bot via <a href="https://t.me/BotFather" target="_blank" style="color:#1d4ed8">@BotFather</a> and copy the token.<br>2. Send a message to your bot, then call <code>https://api.telegram.org/bot&lt;TOKEN&gt;/getUpdates</code> to find your Chat ID.<br>3. Paste both below and save.</span>
          </div>
          <div class="s-field">
            <label class="s-label">Enable Telegram <code class="s-key">PRX_TELEGRAM_ENABLED</code></label>
            <select name="PRX_TELEGRAM_ENABLED" class="s-input">
              <option value="N"${v('PRX_TELEGRAM_ENABLED') !== 'Y' ? ' selected' : ''}>N — disabled</option>
              <option value="Y"${v('PRX_TELEGRAM_ENABLED') === 'Y' ? ' selected' : ''}>Y — send Telegram messages</option>
            </select>
          </div>
          <div class="s-field">
            <label class="s-label">Chat ID <code class="s-key">PRX_TELEGRAM_CHAT_ID</code></label>
            <input type="text" name="PRX_TELEGRAM_CHAT_ID" value="${esc(v('PRX_TELEGRAM_CHAT_ID'))}" class="s-input" placeholder="-100123456789 or personal user ID">
            <span class="s-hint">Group/channel IDs start with <code>-100</code>. Personal IDs are plain numbers.</span>
          </div>
          <div class="s-field span2 pw-wrap">
            <label class="s-label">Bot Token <code class="s-key">PRX_TELEGRAM_BOT_TOKEN</code></label>
            <input type="password" id="hc-tg-token" name="PRX_TELEGRAM_BOT_TOKEN" value="${esc(v('PRX_TELEGRAM_BOT_TOKEN'))}" class="s-input" placeholder="123456:ABC-DEF..." autocomplete="off">
            <button type="button" class="pw-eye" onclick="togglePw('hc-tg-token',this)">
              <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>
          </div>
          <input type="hidden" name="PRX_TELEGRAM_EVENTS" id="tg-events-hidden" value="${esc(tgEvents)}">
          <div class="s-field span2">
            <label class="s-label" style="margin-bottom:.4rem">Notify on events</label>
            ${tgEventCheckboxes}
          </div>

          <!-- ── Bi-directional commands (inbound) ──────────────────────────── -->
          <div class="s-field span2" style="border-top:1px dashed #e5e7eb;padding-top:.85rem;margin-top:.5rem">
            <label class="s-label">Bi-directional commands <code class="s-key">PRX_TELEGRAM_INBOUND_ENABLED</code></label>
            <select name="PRX_TELEGRAM_INBOUND_ENABLED" class="s-input" style="max-width:360px">
              <option value="N"${v('PRX_TELEGRAM_INBOUND_ENABLED') !== 'Y' ? ' selected' : ''}>N — outbound only (default)</option>
              <option value="Y"${v('PRX_TELEGRAM_INBOUND_ENABLED') === 'Y' ? ' selected' : ''}>Y — accept commands from Telegram</option>
            </select>
            <span class="s-hint">When enabled, Prevoyant long-polls Telegram and accepts slash commands from the configured chat ID. <strong>Available commands:</strong> <code>/dev</code> <code>/review</code> <code>/estimate</code> <code>/status</code> <code>/queue</code> <code>/help</code>. Auto-disabled while <code>PRX_HERMES_ENABLED=Y</code> (Hermes owns the chat surface).</span>
            <div id="tg-inbound-status" style="margin-top:.45rem;font-size:.74rem;display:flex;align-items:center;gap:.4rem">
              <span class="hermes-badge-pill badge-grey"><span class="hc-dot hc-dot-grey"></span>Listener: checking…</span>
            </div>
          </div>

          <div class="s-field span2">
            <button type="button" onclick="testTelegramMsg()" style="width:fit-content;font-size:.8rem;padding:.35rem .9rem;border:1px solid #d1d5db;border-radius:6px;background:#fff;cursor:pointer">Send test message</button>
            <span id="tg-test-result" style="font-size:.78rem;color:#6b7280"></span>
          </div>
        </div>
      </details>

      <div style="display:flex;gap:.75rem;align-items:center;margin-top:1.2rem">
        <button type="submit" class="btn-save">Save</button>
        <a href="/dashboard/settings" style="font-size:.82rem;color:#6b7280;text-decoration:none">← Back to Settings</a>
      </div>
    </form>
  </div>

  <script>
    function togglePw(id, btn) {
      const inp = document.getElementById(id);
      inp.type = inp.type === 'password' ? 'text' : 'password';
    }

    // ── Gateway status ────────────────────────────────────────────────────────
    // Tracks state across polls so we can detect a "was running → now stopped" transition.
    let hcLastGatewayRunning = null;   // null = unknown, true/false thereafter
    let hcCrashFlagged       = false;  // sticky: once we've shown "exited unexpectedly"
    let hcVerifyTimer        = null;   // active post-Start verifier
    let hcLastUserAction     = null;   // 'start' | 'stop' | null — what user just did

    function hcSetBadge(id, dotClass, badgeClass, label, extraClass) {
      const el = document.getElementById(id);
      el.className = 'hermes-badge-pill ' + badgeClass + (extraClass ? (' ' + extraClass) : '');
      el.innerHTML = '<span class="hc-dot ' + dotClass + '"></span>' + label;
    }

    function hcRenderStatus(s) {
      // CLI install badge
      if (s.installing && !s.installed) {
        hcSetBadge('hc-installed', 'hc-dot-blue pulse', 'badge-blue', 'Installing CLI…');
      } else if (s.installed) {
        hcSetBadge('hc-installed', 'hc-dot-green', 'badge-green', 'CLI installed');
      } else {
        hcSetBadge('hc-installed', 'hc-dot-red', 'badge-red', 'CLI not installed');
      }

      // Gateway badge — has an extra "exited unexpectedly" state
      if (!s.installed) {
        hcSetBadge('hc-gateway', 'hc-dot-grey', 'badge-grey', 'Gateway —');
      } else if (s.gatewayRunning) {
        hcSetBadge('hc-gateway', 'hc-dot-green pulse', 'badge-green', 'Gateway running', 'alive');
        hcCrashFlagged = false;
      } else if (hcCrashFlagged) {
        hcSetBadge('hc-gateway', 'hc-dot-red pulse', 'badge-red', 'Gateway exited — check log', 'crash');
      } else {
        hcSetBadge('hc-gateway', 'hc-dot-red', 'badge-red', 'Gateway stopped');
      }

      // Skill badge
      if (s.skillInstalled) {
        hcSetBadge('hc-skill', 'hc-dot-green', 'badge-green', 'Skill deployed');
      } else if (s.installed) {
        hcSetBadge('hc-skill', 'hc-dot-red', 'badge-red', 'Skill not deployed');
      } else {
        hcSetBadge('hc-skill', 'hc-dot-grey', 'badge-grey', 'Skill —');
      }

      // Overall health accent on the row
      const row = document.getElementById('hc-status-row');
      row.classList.remove('healthy','warn','failed');
      if (hcCrashFlagged && !s.gatewayRunning) row.classList.add('failed');
      else if (s.installed && s.gatewayRunning && s.skillInstalled) row.classList.add('healthy');
      else if (s.installed) row.classList.add('warn');

      // Buttons
      const start = document.getElementById('hc-gw-start');
      const stop  = document.getElementById('hc-gw-stop');
      if (s.installed && !s.installing) {
        start.style.display = s.gatewayRunning ? 'none' : '';
        stop.style.display  = s.gatewayRunning ? '' : 'none';
      } else {
        start.style.display = stop.style.display = 'none';
      }

      document.getElementById('hc-installing-banner').style.display = s.installing ? '' : 'none';
    }

    function hcCheckStatus() {
      return fetch('/dashboard/api/hermes-status').then(r => r.json()).then(s => {
        // Crash detection: was running last poll, no longer running, and user didn't click Stop.
        if (hcLastGatewayRunning === true && !s.gatewayRunning && hcLastUserAction !== 'stop') {
          hcCrashFlagged = true;
          hcToast('Gateway exited unexpectedly — see the log below.', 'err');
          hcLoadLog();
        }
        if (s.gatewayRunning) hcCrashFlagged = false;
        hcLastGatewayRunning = s.gatewayRunning;

        hcRenderStatus(s);

        if (s.installing) setTimeout(hcCheckStatus, 4000);
        return s;
      }).catch(() => {});
    }

    // After Start: poll every 1.5s for ~12s. If gateway never comes up, or comes up
    // then dies, surface a clear failure state instead of leaving the user guessing.
    function hcVerifyStart() {
      if (hcVerifyTimer) clearInterval(hcVerifyTimer);
      let elapsed = 0;
      let everUp  = false;
      hcVerifyTimer = setInterval(() => {
        elapsed += 1500;
        fetch('/dashboard/api/hermes-status').then(r => r.json()).then(s => {
          if (s.gatewayRunning) everUp = true;
          else if (everUp) {
            // came up then died — crash
            hcCrashFlagged = true;
            hcToast('Gateway started then exited — check the log.', 'err');
            clearInterval(hcVerifyTimer); hcVerifyTimer = null;
            hcLoadLog();
          }
          hcLastGatewayRunning = s.gatewayRunning;
          hcRenderStatus(s);
          if (elapsed >= 12000) {
            clearInterval(hcVerifyTimer); hcVerifyTimer = null;
            if (!everUp && !s.gatewayRunning) {
              hcToast('Gateway did not come up within 12s — check the log.', 'err');
              hcCrashFlagged = true; hcRenderStatus(s);
            } else if (everUp && s.gatewayRunning) {
              hcToast('Gateway running ✓', 'ok');
            }
          }
          hcLoadLog();
        }).catch(() => {});
      }, 1500);
    }

    function hcGatewayStart() {
      const btn = document.getElementById('hc-gw-start');
      btn.disabled = true; btn.textContent = 'Starting…';
      hcLastUserAction = 'start';
      hcCrashFlagged = false;
      fetch('/dashboard/api/hermes-gateway/start', { method: 'POST' })
        .then(r => r.json())
        .then(d => {
          if (!d.ok) {
            hcToast('Start failed: ' + (d.reason || 'unknown'), 'err');
          } else if (d.reason === 'already_running') {
            hcToast('Gateway was already running.', 'info');
          }
          hcCheckStatus();
          hcLoadLog();
          hcVerifyStart();
        })
        .catch(() => hcCheckStatus())
        .finally(() => { btn.disabled = false; btn.textContent = '▶ Start Gateway'; });
    }

    function hcGatewayStop() {
      const btn = document.getElementById('hc-gw-stop');
      btn.disabled = true; btn.textContent = 'Stopping…';
      hcLastUserAction = 'stop';
      if (hcVerifyTimer) { clearInterval(hcVerifyTimer); hcVerifyTimer = null; }
      fetch('/dashboard/api/hermes-gateway/stop', { method: 'POST' })
        .then(() => { hcCheckStatus(); hcLoadLog(); setTimeout(() => { hcLoadLog(); hcCheckStatus(); }, 1500); })
        .catch(() => hcCheckStatus())
        .finally(() => { btn.disabled = false; btn.textContent = '■ Stop Gateway'; });
    }

    // Transient bottom-right toast
    function hcToast(msg, kind) {
      const t = document.createElement('div');
      t.className = 'hc-toast hc-toast-' + (kind === 'err' ? 'err' : kind === 'info' ? 'info' : 'ok');
      t.textContent = msg;
      document.body.appendChild(t);
      setTimeout(() => { t.style.transition = 'opacity .35s'; t.style.opacity = '0'; }, 3500);
      setTimeout(() => { t.remove(); }, 4000);
    }

    // Background heartbeat — every 10s, refresh status so crashes after navigation are caught.
    setInterval(() => { if (!hcVerifyTimer) hcCheckStatus(); }, 10000);

    // ── Gateway log (rolling, auto-refresh) ───────────────────────────────────
    let hcLogAuto       = true;
    let hcLogPollTimer  = null;
    let hcLogLastSize   = -1;
    let hcLogPathShown  = false;

    function hcLoadLog() {
      fetch('/dashboard/api/hermes-gateway/log').then(r => r.json()).then(d => {
        const el   = document.getElementById('hc-log');
        const meta = document.getElementById('hc-log-meta');
        const pathEl = document.getElementById('hc-log-path');
        if (!d.ok) {
          el.textContent = '(error loading log: ' + (d.reason || 'unknown') + ')';
          meta.textContent = '';
          return;
        }
        if (!hcLogPathShown && d.path) {
          pathEl.textContent = 'Log file: ' + d.path;
          hcLogPathShown = true;
        }
        if (!d.exists) {
          el.textContent = '(no log file yet — click Start Gateway to populate)';
          meta.textContent = '';
          hcLogLastSize = 0;
          return;
        }
        const wasAtBottom = (el.scrollHeight - el.scrollTop - el.clientHeight) < 30;
        el.textContent = d.text || '(empty)';
        const kb = Math.round((d.size || 0) / 1024 * 10) / 10;
        const grew = (d.size > hcLogLastSize && hcLogLastSize >= 0) ? ' · new output' : '';
        meta.textContent = '· ' + kb + ' KB' + grew;
        hcLogLastSize = d.size;
        if (wasAtBottom) el.scrollTop = el.scrollHeight;
      }).catch(() => {});
    }

    function hcStartLogPolling() {
      if (hcLogPollTimer) return;
      hcLogPollTimer = setInterval(() => { if (hcLogAuto) hcLoadLog(); }, 5000);
    }

    function hcToggleLogAuto() {
      hcLogAuto = document.getElementById('hc-log-auto').checked;
    }

    hcCheckStatus();
    hcLoadLog();
    hcStartLogPolling();

    // ── Telegram event checkboxes ─────────────────────────────────────────────
    function syncTgEvents() {
      const vals = [...document.querySelectorAll('.tg-evt-cb:checked')].map(c => c.value);
      document.getElementById('tg-events-hidden').value = vals.join(',');
    }

    // ── Inbound listener status ───────────────────────────────────────────────
    function hcLoadInboundStatus() {
      fetch('/dashboard/api/telegram-inbound/status').then(r => r.json()).then(d => {
        const el = document.getElementById('tg-inbound-status');
        if (!el) return;
        if (!d.ok) {
          el.innerHTML = '<span class="hermes-badge-pill badge-red"><span class="hc-dot hc-dot-red"></span>Listener: error</span>';
          return;
        }
        let badge;
        if (d.running) {
          badge = '<span class="hermes-badge-pill badge-green alive"><span class="hc-dot hc-dot-green pulse"></span>Listener: running</span>'
                + ' <span style="color:#6b7280">· offset ' + (d.lastUpdateId || 0) + '</span>';
        } else if (d.disabledReason === 'hermes_enabled') {
          badge = '<span class="hermes-badge-pill badge-blue"><span class="hc-dot hc-dot-blue"></span>Listener: off (Hermes mode)</span>';
        } else if (d.disabledReason) {
          const labelMap = {
            telegram_disabled: 'Telegram disabled',
            inbound_disabled:  'Inbound disabled',
            missing_token:     'Bot token missing',
            missing_chat_id:   'Chat ID missing',
          };
          badge = '<span class="hermes-badge-pill badge-grey"><span class="hc-dot hc-dot-grey"></span>Listener: off — ' + (labelMap[d.disabledReason] || d.disabledReason) + '</span>';
        } else {
          badge = '<span class="hermes-badge-pill badge-grey"><span class="hc-dot hc-dot-grey"></span>Listener: stopped</span>';
        }
        el.innerHTML = badge;
      }).catch(() => {});
    }
    hcLoadInboundStatus();
    setInterval(hcLoadInboundStatus, 8000);

    // ── Test message ──────────────────────────────────────────────────────────
    function testTelegramMsg() {
      const result = document.getElementById('tg-test-result');
      result.textContent = 'Sending…'; result.style.color = '#6b7280';
      fetch('/dashboard/api/hermes-telegram-test', { method: 'POST' })
        .then(r => r.json())
        .then(d => {
          result.textContent = d.ok ? '✓ Message sent' : '✗ ' + (d.reason || 'failed');
          result.style.color = d.ok ? '#166534' : '#991b1b';
        })
        .catch(() => { result.textContent = '✗ Request failed'; result.style.color = '#991b1b'; });
    }
  </script>
</body></html>`;
}

function renderKnowledgeBuilder(flash) {
  const enabled     = process.env.PRX_KBFLOW_ENABLED === 'Y';
  const interval    = process.env.PRX_KBFLOW_INTERVAL_DAYS  || '7';
  const lookback    = process.env.PRX_KBFLOW_LOOKBACK_DAYS  || '30';
  const maxFlowsCfg = process.env.PRX_KBFLOW_MAX_FLOWS      || '3';
  const jiraBase    = (process.env.JIRA_URL || '').replace(/\/$/, '');
  const jiraProject = process.env.PRX_JIRA_PROJECT || '';

  const state       = readKbflowState();
  const buildupDir  = path.join(os.homedir(), '.prevoyant', 'knowledge-buildup');
  const pendingFile = path.join(buildupDir, 'kbflow-pending.md');
  const sessionFile = path.join(buildupDir, 'kbflow-sessions.md');

  const items    = parseKbflowPending(pendingFile);
  const sessions = parseKbflowSessions(sessionFile);

  // Sort: PENDING first, then APPROVED, REJECTED, INFO, other
  const STATUS_ORDER = { 'PENDING': 0, 'APPROVED': 1, 'REJECTED': 2, 'INFO': 3 };
  items.sort((a, b) => {
    const ka = Object.keys(STATUS_ORDER).find(k => (a.status || '').toUpperCase().startsWith(k)) || 'Z';
    const kb = Object.keys(STATUS_ORDER).find(k => (b.status || '').toUpperCase().startsWith(k)) || 'Z';
    return (STATUS_ORDER[ka] ?? 4) - (STATUS_ORDER[kb] ?? 4);
  });

  const counts = items.reduce((acc, it) => {
    const s = (it.status || '').toUpperCase();
    if (s.startsWith('PENDING'))        acc.pending++;
    else if (s.startsWith('APPROVED'))  acc.approved++;
    else if (s.startsWith('REJECTED'))  acc.rejected++;
    else if (s === 'INFO')              acc.info++;
    else acc.other++;
    return acc;
  }, { pending: 0, approved: 0, rejected: 0, info: 0, other: 0 });

  const lastRunAt  = state.lastRunAt ? new Date(state.lastRunAt) : null;
  const nextRunAt  = state.nextRunAt ? new Date(state.nextRunAt) : null;
  const now        = Date.now();
  const lastStatus   = state.lastRunStatus || '—';
  const isRunning    = state.isRunning === true;
  const hasSummary   = state.lastNewProposals != null || state.lastCorrections != null;
  const pendingCount = state.pendingCount || counts.pending;
  const oldestPendingDays = state.oldestPendingDays || 0;
  const nudgeDays    = parseInt(process.env.PRX_KBFLOW_REVIEW_NUDGE_DAYS || '7', 10);

  // Acceptance rate (approved / all reviewed)
  const reviewed     = counts.approved + counts.rejected;
  const acceptPct    = reviewed > 0 ? Math.round((counts.approved / reviewed) * 100) : null;

  const flashMsg = flash === 'run-queued'   ? `<div style="background:#dcfce7;color:#166534;padding:.6rem 1rem;border-radius:8px;margin-bottom:1rem;font-size:.85rem">✓ Run queued — the KB Flow Analyst will start its scan momentarily.</div>` :
                   flash === 'run-disabled' ? `<div style="background:#fee2e2;color:#991b1b;padding:.6rem 1rem;border-radius:8px;margin-bottom:1rem;font-size:.85rem">✗ Cannot run — the KB Flow Analyst is disabled. Enable it in Settings first.</div>` :
                   '';

  const runningBanner = isRunning ? `
    <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:.75rem 1rem;margin-bottom:1rem;font-size:.84rem;color:#1e40af;display:flex;align-items:center;gap:.65rem">
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;animation:spin 1.4s linear infinite"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
      <span><strong>Scan in progress</strong>${state.currentRunNum ? ` — run #${state.currentRunNum}` : ''}${state.currentRunStartedAt ? ` · started ${new Date(state.currentRunStartedAt).toLocaleTimeString()}` : ''} · <span id="refresh-countdown">page refreshes in 30s</span></span>
    </div>` : '';

  const logFilePath = state.lastLogFile
    ? path.join(os.homedir(), '.prevoyant', 'kbflow', 'logs', state.lastLogFile)
    : null;

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Knowledge Builder · Prevoyant</title>
${isRunning ? '<meta http-equiv="refresh" content="30">' : ''}
<style>
  * { box-sizing: border-box; }
  body { margin:0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; background:#f8fafc; color:#111827; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .topbar { background:#1e293b; color:#fff; padding:.85rem 1.5rem; display:flex; align-items:center; gap:1rem; }
  .topbar h1 { font-size:1rem; margin:0; font-weight:600; }
  .topbar .nav { margin-left:auto; display:flex; gap:.75rem; }
  .topbar .nav a { color:#cbd5e1; text-decoration:none; font-size:.85rem; padding:.3rem .6rem; border-radius:6px; }
  .topbar .nav a:hover { background:#334155; color:#fff; }
  .wrap { max-width:1100px; margin:1.5rem auto; padding:0 1.5rem 4rem; }
  .panel { background:#fff; border:1px solid #e5e7eb; border-radius:10px; padding:1.25rem 1.5rem; margin-bottom:1.25rem; }
  .panel h2 { font-size:.95rem; margin:0 0 .9rem; color:#1f2937; font-weight:600; display:flex; align-items:center; gap:.5rem; flex-wrap:wrap; }
  .panel .hint { font-size:.8rem; color:#6b7280; margin-top:.6rem; line-height:1.6; }
  .stat-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(140px, 1fr)); gap:.9rem; }
  .stat { background:#f9fafb; border:1px solid #e5e7eb; border-radius:8px; padding:.7rem .9rem; }
  .stat .lbl { font-size:.7rem; text-transform:uppercase; letter-spacing:.04em; color:#6b7280; }
  .stat .val { font-size:1.15rem; font-weight:600; color:#111827; margin-top:.15rem; }
  .stat .sub { font-size:.72rem; color:#9ca3af; margin-top:.15rem; }
  .stat-running { border-color:#93c5fd; background:#eff6ff; }
  .stat-running .lbl { color:#1d4ed8; }
  .stat-running .val { color:#1e40af; font-size:.9rem; }
  table { width:100%; border-collapse:collapse; font-size:.84rem; }
  th { text-align:left; padding:.5rem .6rem; background:#f9fafb; color:#6b7280; font-weight:600; font-size:.72rem; text-transform:uppercase; letter-spacing:.04em; border-bottom:1px solid #e5e7eb; }
  td { padding:.55rem .6rem; border-bottom:1px solid #f1f5f9; vertical-align:top; }
  .main-row { cursor:pointer; }
  .main-row:hover td { background:#fafafa; }
  .detail-row td { background:#f8fafc; padding:0; border-bottom:1px solid #e5e7eb; }
  tr.row-hidden { display:none; }
  .empty { color:#9ca3af; font-size:.85rem; padding:1rem; text-align:center; font-style:italic; }
  .pill { display:inline-block; padding:1px 7px; border-radius:6px; font-size:.7rem; font-weight:600; background:#e5e7eb; color:#374151; }
  .btn { display:inline-flex; align-items:center; gap:.4rem; padding:.45rem .9rem; background:#1e40af; color:#fff; border:0; border-radius:7px; font-size:.82rem; font-weight:500; cursor:pointer; text-decoration:none; }
  .btn:hover { background:#1e3a8a; }
  .btn[disabled] { background:#9ca3af; cursor:not-allowed; }
  .btn-sm { padding:.25rem .65rem; font-size:.75rem; border-radius:5px; background:#f3f4f6; color:#374151; border:1px solid #d1d5db; cursor:pointer; }
  .btn-sm:hover { background:#e5e7eb; }
  .row-hdr { display:flex; align-items:center; justify-content:space-between; gap:1rem; margin-bottom:.9rem; }
  .row-hdr h2 { margin:0; }
  code { background:#f3f4f6; padding:1px 5px; border-radius:4px; font-size:.78rem; color:#374151; }
  .ref-link { font-size:.72rem; color:#6b7280; font-family:ui-monospace,monospace; margin-top:.15rem; display:block; }
  .status-on  { color:#166534; font-weight:600; }
  .status-off { color:#9ca3af; font-weight:600; }
  .filter-row { display:flex; gap:.75rem; align-items:center; margin-bottom:.85rem; flex-wrap:wrap; }
  .filter-tabs { display:flex; gap:.4rem; flex-wrap:wrap; }
  .ftab { padding:.28rem .7rem; border-radius:6px; font-size:.78rem; font-weight:600; cursor:pointer; border:1px solid #d1d5db; background:#fff; color:#374151; }
  .ftab.active { background:#1e40af; color:#fff; border-color:#1e40af; }
  .ftab:hover:not(.active) { background:#f3f4f6; }
  .search-box { margin-left:auto; }
  .search-box input { padding:.28rem .65rem; border:1px solid #d1d5db; border-radius:6px; font-size:.82rem; width:200px; outline:none; }
  .search-box input:focus { border-color:#1e40af; box-shadow:0 0 0 2px #dbeafe; }
  .error-box { font-size:.78rem; color:#991b1b; background:#fef2f2; border:1px solid #fecaca; border-radius:6px; padding:.5rem .8rem; margin-top:.65rem; word-break:break-all; }
  .expand-arrow { color:#9ca3af; font-size:.7rem; margin-right:.3rem; }
  .detail-content { padding:.85rem 1rem .85rem 2.5rem; display:flex; gap:1.5rem; flex-wrap:wrap; }
  .detail-body { font-size:.82rem; color:#374151; white-space:pre-wrap; line-height:1.6; flex:1; min-width:200px; max-width:700px; }
  .detail-meta { font-size:.78rem; color:#6b7280; min-width:160px; }
  .detail-meta p { margin:.15rem 0; }
  .accept-bar { height:6px; border-radius:3px; background:#e5e7eb; margin-top:.4rem; overflow:hidden; }
  .accept-fill { height:100%; border-radius:3px; background:#22c55e; }
  .no-results { display:none; color:#9ca3af; font-size:.85rem; padding:1rem; text-align:center; font-style:italic; }
</style>
</head><body>
  <div class="topbar">
    <h1>Knowledge Builder</h1>
    <div class="nav">
      <a href="/dashboard">Dashboard</a>
      <a href="/dashboard/activity">Activity</a>
      <a href="/dashboard/watch">Watch</a>
      <a href="/dashboard/settings#kb-flow-analyst">Settings</a>
    </div>
  </div>
  <div class="wrap">
    ${flashMsg}
    ${runningBanner}

    <!-- Status panel -->
    <div class="panel">
      <div class="row-hdr">
        <h2>KB Flow Analyst — Status</h2>
        <form method="POST" action="/dashboard/knowledge-builder/run-now" style="margin:0"
              onsubmit="return confirm('Start a KB Flow Analyst scan now? Scans typically take 30–120 minutes.')">
          <button type="submit" class="btn" ${enabled && !isRunning ? '' : 'disabled'}
                  title="${!enabled ? 'Enable the worker in Settings first' : isRunning ? 'Scan already in progress' : ''}">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            Run Scan Now
          </button>
        </form>
      </div>
      <div class="stat-grid">
        ${isRunning ? `
        <div class="stat stat-running">
          <div class="lbl">Currently</div>
          <div class="val">⟳ Running</div>
          <div class="sub">run #${state.currentRunNum || '?'}${state.currentRunStartedAt ? ' · ' + new Date(state.currentRunStartedAt).toLocaleTimeString() : ''}</div>
        </div>` : ''}
        <div class="stat">
          <div class="lbl">Worker</div>
          <div class="val ${enabled ? 'status-on' : 'status-off'}">${enabled ? '● Enabled' : '○ Disabled'}</div>
          <div class="sub">every ${esc(interval)}d · lookback ${esc(lookback)}d</div>
        </div>
        <div class="stat">
          <div class="lbl">Last run</div>
          <div class="val" style="font-size:.9rem">${lastRunAt ? lastRunAt.toLocaleString() : '—'}</div>
          <div class="sub">Status: ${esc(lastStatus)}</div>
        </div>
        <div class="stat">
          <div class="lbl">Next run</div>
          <div class="val" style="font-size:.9rem">${nextRunAt ? nextRunAt.toLocaleString() : '—'}</div>
          <div class="sub">${nextRunAt ? (nextRunAt.getTime() > now ? 'in ' + fmtDuration(nextRunAt - now) : 'overdue') : 'never run'}</div>
        </div>
        <div class="stat">
          <div class="lbl">Runs total</div>
          <div class="val">${state.runCount || 0}</div>
          <div class="sub">${sessions.length} session${sessions.length === 1 ? '' : 's'} logged</div>
        </div>
        ${hasSummary ? `
        <div class="stat">
          <div class="lbl">Last output</div>
          <div class="val" style="font-size:.82rem">${state.lastNewProposals ?? '—'} CMM · ${state.lastNewPatterns ?? '—'} pat · ${state.lastNewLessons ?? '—'} lesson</div>
          <div class="sub">${state.lastCorrections ?? '—'} fix · ${state.lastConfirmations ?? '—'} confirm · ${state.lastFlowsAnalysed ?? '—'} flows</div>
        </div>` : ''}
        ${acceptPct !== null ? `
        <div class="stat">
          <div class="lbl">Acceptance rate</div>
          <div class="val" style="font-size:.95rem">${acceptPct}%</div>
          <div class="accept-bar"><div class="accept-fill" style="width:${acceptPct}%"></div></div>
          <div class="sub">${counts.approved} approved · ${counts.rejected} rejected</div>
        </div>` : ''}
        <div class="stat">
          <div class="lbl">Jira scope</div>
          <div class="val" style="font-size:.82rem;word-break:break-all">${esc(jiraProject || 'all recent')}</div>
          <div class="sub">${jiraProject ? 'PRX_JIRA_PROJECT' : 'set PRX_JIRA_PROJECT to narrow'}</div>
        </div>
        ${pendingCount > 0 ? `
        <a href="#contributions" style="text-decoration:none">
        <div class="stat" style="${oldestPendingDays >= nudgeDays ? 'border-color:#fca5a5;background:#fef2f2' : 'border-color:#fde68a;background:#fffbeb'}">
          <div class="lbl" style="color:${oldestPendingDays >= nudgeDays ? '#991b1b' : '#92400e'}">${oldestPendingDays >= nudgeDays ? '⚠ Review overdue' : 'Awaiting review'}</div>
          <div class="val" style="font-size:.9rem;color:${oldestPendingDays >= nudgeDays ? '#b91c1c' : '#b45309'}">${pendingCount} pending</div>
          <div class="sub">oldest: ${oldestPendingDays}d · Step 13j ↓</div>
        </div>
        </a>` : ''}
      </div>
      <div class="hint">
        Pending:  <code>${esc(pendingFile)}</code><br>
        Sessions: <code>${esc(sessionFile)}</code>
        ${logFilePath ? `<br>Last log: <code>${esc(logFilePath)}</code>` : ''}
      </div>
      ${state.lastRunStatus === 'failed' && state.lastError ? `
      <div class="error-box">⚠ Last run failed: ${esc(state.lastError)}</div>` : ''}
    </div>

    <!-- Contributions panel -->
    <div class="panel" id="contributions">
      <h2>
        Contributions
        <span class="pill">${counts.pending} pending</span>
        <span class="pill" style="background:#dcfce7;color:#166534">${counts.approved} approved</span>
        <span class="pill" style="background:#fee2e2;color:#991b1b">${counts.rejected} rejected</span>
        ${counts.info ? `<span class="pill" style="background:#e0f2fe;color:#0369a1">${counts.info} info</span>` : ''}
      </h2>
      ${items.length === 0 ? `
        <div class="empty">No contributions yet. The KB Flow Analyst writes proposals to <code>~/.prevoyant/knowledge-buildup/kbflow-pending.md</code> after each run.</div>
      ` : `
        <div class="filter-row">
          <div class="filter-tabs">
            <button class="ftab active" data-filter="all" onclick="filterContribs('all',this)">All (${items.length})</button>
            ${counts.pending  ? `<button class="ftab" data-filter="pending"  onclick="filterContribs('pending',this)">Pending (${counts.pending})</button>`   : ''}
            ${counts.approved ? `<button class="ftab" data-filter="approved" onclick="filterContribs('approved',this)">Approved (${counts.approved})</button>` : ''}
            ${counts.rejected ? `<button class="ftab" data-filter="rejected" onclick="filterContribs('rejected',this)">Rejected (${counts.rejected})</button>` : ''}
            ${counts.info     ? `<button class="ftab" data-filter="info"     onclick="filterContribs('info',this)">Info (${counts.info})</button>`             : ''}
          </div>
          <div class="search-box">
            <input type="text" id="contrib-search" placeholder="Search…" oninput="applyFilters()" autocomplete="off">
          </div>
        </div>
        <table id="contrib-table">
          <thead>
            <tr>
              <th style="width:24px"></th>
              <th style="width:74px">ID</th>
              <th>Title</th>
              <th>Type</th>
              <th>Action</th>
              <th>Proposed</th>
              <th>Incidents</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${items.map(it => {
              const sk = (it.status || '').toUpperCase();
              const statusKey = sk.startsWith('PENDING') ? 'pending'
                : sk.startsWith('APPROVED') ? 'approved'
                : sk.startsWith('REJECTED') ? 'rejected'
                : sk === 'INFO' ? 'info' : 'other';
              const safeId = (it.id || '').replace(/[^a-z0-9]/gi, '-').toLowerCase();
              const copyText = [it.title, it.body, it.ref ? 'ref: ' + it.ref : ''].filter(Boolean).join('\n\n');
              return `
              <tr class="main-row" data-status="${statusKey}" data-id="${safeId}"
                  onclick="toggleDetail('${safeId}')"
                  title="Click to expand">
                <td style="color:#9ca3af;font-size:.7rem;padding-right:0"><span class="expand-arrow" id="arrow-${safeId}">▶</span></td>
                <td><strong style="font-family:ui-monospace,monospace">${esc(it.id)}</strong></td>
                <td style="font-weight:600;font-size:.85rem">${esc(it.title)}</td>
                <td>${typeBadge(it.type)}</td>
                <td>${actionBadge(it.action)}</td>
                <td style="font-size:.8rem;white-space:nowrap">${esc(it.proposed || '—')}</td>
                <td>${linkIncidents(it.incidents, jiraBase)}</td>
                <td>${statusBadge(it.status)}</td>
              </tr>
              <tr class="detail-row row-hidden" id="detail-${safeId}" data-status="${statusKey}">
                <td colspan="8">
                  <div class="detail-content">
                    <div class="detail-body">${it.body ? esc(it.body) : '<span style="color:#9ca3af;font-style:italic">No body text</span>'}</div>
                    <div class="detail-meta">
                      ${it.flow ? `<p><strong>Flow:</strong> ${esc(it.flow)}</p>` : ''}
                      ${it.ref  ? `<p><strong>Ref:</strong> <span class="ref-link" style="margin:0;display:inline">${esc(it.ref)}</span></p>` : ''}
                      ${it.incidents && it.incidents !== '—' ? `<p><strong>Incidents:</strong><br>${linkIncidents(it.incidents, jiraBase)}</p>` : ''}
                      <p style="margin-top:.6rem">
                        <button class="btn-sm" data-copy-id="${safeId}" onclick="copyContent('${safeId}',event)">Copy content</button>
                      </p>
                      <textarea id="copy-content-${safeId}" style="display:none" readonly>${copyText.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</textarea>
                    </div>
                  </div>
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
        <div class="no-results" id="no-results">No contributions match your search.</div>
      `}
    </div>

    <!-- Run history panel -->
    <div class="panel">
      <h2>Run history (most recent first)</h2>
      ${sessions.length === 0 ? `
        <div class="empty">No runs logged yet.</div>
      ` : `
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Flows analysed</th>
              <th>CMM proposals</th>
              <th>Patterns</th>
              <th>Lessons</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${sessions.map(s => `
              <tr>
                <td style="font-size:.8rem;white-space:nowrap">${esc(s.date)}</td>
                <td>${esc(s.flows)}</td>
                <td>${esc(s.proposals)}</td>
                <td>${esc(s.patterns || '—')}</td>
                <td>${esc(s.lessons  || '—')}</td>
                <td>${statusBadge(s.status)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      `}
    </div>
  </div>

  <script>
  var _activeFilter = 'all';

  function filterContribs(filter, btn) {
    _activeFilter = filter;
    document.querySelectorAll('.ftab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    applyFilters();
  }

  function applyFilters() {
    const q = (document.getElementById('contrib-search') || {}).value || '';
    const search = q.toLowerCase().trim();
    let visible = 0;
    document.querySelectorAll('#contrib-table .main-row').forEach(row => {
      const matchFilter = _activeFilter === 'all' || row.dataset.status === _activeFilter;
      const matchSearch = !search || row.textContent.toLowerCase().includes(search);
      const hide = !matchFilter || !matchSearch;
      row.classList.toggle('row-hidden', hide);
      const detail = document.getElementById('detail-' + row.dataset.id);
      if (detail && hide) {
        detail.classList.add('row-hidden');
        const arrow = document.getElementById('arrow-' + row.dataset.id);
        if (arrow) arrow.textContent = '▶';
      }
      if (!hide) visible++;
    });
    const noRes = document.getElementById('no-results');
    if (noRes) noRes.style.display = visible === 0 ? 'block' : 'none';
  }

  function toggleDetail(id) {
    const mainRow  = document.querySelector('.main-row[data-id="' + id + '"]');
    const detailRow = document.getElementById('detail-' + id);
    const arrow     = document.getElementById('arrow-' + id);
    if (!detailRow || !mainRow || mainRow.classList.contains('row-hidden')) return;
    const nowHidden = detailRow.classList.toggle('row-hidden');
    if (arrow) arrow.textContent = nowHidden ? '▶' : '▼';
  }

  function copyContent(id, evt) {
    evt.stopPropagation();
    const el  = document.getElementById('copy-content-' + id);
    const btn = document.querySelector('[data-copy-id="' + id + '"]');
    if (!el || !btn) return;
    const text = el.value;
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(() => {
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy content'; }, 1600);
      }).catch(() => fallbackCopy(text, btn));
    } else { fallbackCopy(text, btn); }
  }

  function fallbackCopy(text, btn) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy content'; }, 1600);
  }

  ${isRunning ? `
  (function() {
    var secs = 30;
    var el = document.getElementById('refresh-countdown');
    if (!el) return;
    setInterval(function() {
      secs--;
      el.textContent = secs > 0 ? 'page refreshes in ' + secs + 's' : 'refreshing…';
    }, 1000);
  })();` : ''}
  </script>
</body></html>`;
}

router.get('/knowledge-builder', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(renderKnowledgeBuilder(req.query.flash || null));
});

router.post('/knowledge-builder/run-now', (_req, res) => {
  if (process.env.PRX_KBFLOW_ENABLED !== 'Y') {
    return res.redirect(303, '/dashboard/knowledge-builder?flash=run-disabled');
  }
  serverEvents.emit('kbflow-run-now');
  activityLog.record('kbflow_scan_started', null, 'user', { trigger: 'manual' });
  res.redirect(303, '/dashboard/knowledge-builder?flash=run-queued');
});

router.post('/settings/pattern-miner/run-now', express.json(), (_req, res) => {
  if (process.env.PRX_PATTERN_MINER_ENABLED !== 'Y') {
    return res.status(400).json({ ok: false, error: 'Pattern Miner is not enabled' });
  }
  serverEvents.emit('pattern-miner-run-now');
  res.json({ ok: true });
});

router.post('/settings/staleness/run-now', express.json(), (_req, res) => {
  if (process.env.PRX_STALENESS_ENABLED !== 'Y') {
    return res.status(400).json({ ok: false, error: 'Staleness Scanner is not enabled' });
  }
  serverEvents.emit('staleness-run-now');
  res.json({ ok: true });
});

router.post('/settings/stale-branch/run-now', express.json(), (_req, res) => {
  if (process.env.PRX_STALE_BRANCH_ENABLED !== 'Y') {
    return res.status(400).json({ ok: false, error: 'Stale Branch Detector is not enabled' });
  }
  serverEvents.emit('stale-branch-run-now');
  res.json({ ok: true });
});

router.post('/settings/decision-outcome/run-now', express.json(), (_req, res) => {
  if (process.env.PRX_DECISION_OUTCOME_ENABLED !== 'Y') {
    return res.status(400).json({ ok: false, error: 'Decision-Outcome Linker is not enabled' });
  }
  serverEvents.emit('decision-outcome-run-now');
  res.json({ ok: true });
});

module.exports = router;
