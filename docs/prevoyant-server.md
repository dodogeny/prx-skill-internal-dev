# Prevoyant Server

Prevoyant Server is an optional Node.js service that runs alongside the Claude Code plugin as an always-on ambient agent. It receives Jira webhook events (or polls on a schedule), queues tickets for analysis, spawns Claude, and surfaces live progress on a web dashboard.

---

## Table of Contents

- [Quick Start](#quick-start)
- [Features](#features)
- [Start / Stop the Server](#start--stop-the-server)
- [Environment Variables](#environment-variables)
- [Dashboard](#dashboard)
- [Pipeline Tracking](#pipeline-tracking)
- [Job Queue & Stop/Kill](#job-queue--stopkill)
- [Stage Instructions](#stage-instructions)
- [Jira Webhook Setup](#jira-webhook-setup)
- [Scheduled Polling](#scheduled-polling)
- [API Reference](#api-reference)
- [Architecture](#architecture)
- [File Structure](#file-structure)

---

## Quick Start

### 1. Install dependencies

```bash
cd server
npm install
```

### 2. Configure `.env`

Copy the root `.env.example` to `.env` (if you haven't already) and set the server-specific values:

```bash
# Port the server listens on (default: 3000)
WEBHOOK_PORT=3000

# Jira credentials (required for webhook filtering and MCP auth)
JIRA_URL=https://yourcompany.atlassian.net
JIRA_USERNAME=your.name@yourcompany.com
JIRA_API_TOKEN=your-api-token

# Secret token for the webhook URL (optional — leave blank to skip validation)
WEBHOOK_SECRET=your-random-secret
```

### 3. Start the server

```bash
bash server/scripts/start.sh
```

Open the dashboard: [http://localhost:3000/dashboard](http://localhost:3000/dashboard)

### 4. Register the Jira webhook

In your Jira project: **Project Settings → Webhooks → Create webhook**

| Field | Value |
|-------|-------|
| URL | `http://your-server:3000/jira-events?token=your-random-secret` |
| Events | Issue Created, Issue Updated |

Tickets assigned to `JIRA_USERNAME` with status **To Do / Open / Parked / Blocked** are queued automatically from this point on.

### 5. Or run a ticket manually

Visit the dashboard, find any ticket, select a mode (Dev / Review / Estimate), and click the play button.

---

## Features

### Real-time Jira Webhooks

Registers as a Jira webhook receiver (`POST /jira-events`). When a ticket is created, assigned, or updated, Jira pushes the event immediately and the server queues it for analysis — no polling delay, no cron job required. Incoming events are filtered by assignee and ticket status so only relevant tickets are processed. A configurable secret token protects the endpoint from unauthorised calls.

### Scheduled Polling Fallback

When webhooks are unavailable (e.g. the server is behind a firewall or Jira's outbound delivery is unreliable), the server can run `poll-jira.sh` on a configurable day interval (`WEBHOOK_POLL_INTERVAL_DAYS`). Both mechanisms share the same deduplication cache so a ticket is never queued twice regardless of which path triggered it.

### Live Web Dashboard

A full-featured web UI at `http://localhost:3000/dashboard` auto-refreshes every 30 seconds and shows:
- Summary counters: Running, Queued, Done, Failed
- A sortable table of all processed tickets with source, status badge, mode, timestamps, and duration
- Download links for every PDF/HTML report associated with each ticket
- Play (re-run) and Stop buttons per row
- A JSON feed at `/dashboard/json` for programmatic access

### Per-ticket Detail Page

Clicking a ticket key opens a dedicated detail page with:
- A live pipeline visualisation updated every 5 seconds while the job runs
- A progress bar showing completed vs total stages
- A collapsible session output log with markdown rendering
- Inline PDF/HTML report viewer
- Run and Stop controls

### Pipeline Visualisation

Each ticket's progress is displayed as a horizontal row of stage cards. Every card shows the step number, label, elapsed time, and a colour-coded status:

| Status | Colour | Meaning |
|--------|--------|---------|
| Pending | Grey | Not yet reached |
| Active | Blue (pulsing) | Currently executing |
| Done | Green | Completed successfully |
| Skipped | Grey + *Skipped* badge | Jumped over or not applicable |
| Failed | Red | Errored or stopped mid-step |

Stage definitions are stored in `server/dashboard/stages.json` and can be edited without touching any code.

### Job Queue

All analysis jobs run through a single FIFO queue. Only one Claude session executes at a time (`MAX_CONCURRENT = 1`) to prevent resource exhaustion. Additional jobs wait in the queue and start automatically when the current one finishes. The queue state is visible on the dashboard.

### Stop / Kill Running Jobs

Any running or queued job can be cancelled instantly from the dashboard — either from the ticket list row or the detail page Run panel. Clicking **Stop Job** sends SIGTERM to the Claude process (graceful shutdown), followed by SIGKILL after 3 seconds if the process has not exited. Queued jobs that have not started yet are removed from the queue immediately. In both cases the ticket status is set to **Interrupted**, the active pipeline stage is marked failed, and remaining pending stages are skipped. The ticket can be re-run at any time.

### Session Persistence

The in-progress state of every job — stage transitions, output log entries, status — is written to disk in `~/.prevoyant/sessions/` throughout the run (every 10 output lines and on every step change). If the server is restarted mid-run, sessions are restored from disk on startup. Any session that was `running` or `queued` at restart time is automatically marked `interrupted` so the dashboard never shows stale running indicators.

### Automatic Report Discovery

The server scans `CLAUDE_REPORT_DIR` (default `~/.prevoyant/reports/`) on every dashboard request and associates PDF/HTML files with their ticket keys by filename pattern. Historical tickets that only exist as report files (no live session) appear in the dashboard as `disk` source entries with full download links.

### Manual Re-run

Any ticket — including historical disk-only entries — can be re-run from the dashboard in any mode (Dev / Review / Estimate) at any time. A seen-ticket cache prevents accidental duplicate runs; a **Force** option bypasses the cache when a deliberate rerun is intended.

### Extensible Stage Instructions

Drop a markdown file into `server/dashboard/stage-instructions/<stageId>.md` to define what Claude should do in a custom pipeline stage — no SKILL.md edits needed. On the next session start the server reads all instruction files for the current mode and injects them into Claude's runtime prompt alongside the stage sequence. This makes the pipeline fully data-driven: `stages.json` defines what stages exist and `stage-instructions/` defines what Claude does in each one.

### Three Analysis Modes

Every ticket can be run in any of three modes, selectable from the dashboard:

| Mode | Trigger | What Claude does |
|------|---------|-----------------|
| **Dev** | Default | Full 15-step dev workflow: KB sync → ticket ingestion → root cause analysis → proposed fix → PDF report → KB update |
| **Review** | `review` | 11-step PR review: fetches the feature branch diff → Engineering Panel code review → consolidated findings PDF |
| **Estimate** | `estimate` | 9-step Planning Poker: scope analysis → simultaneous voting → structured debate → consensus → PDF estimate |

### Health Endpoint

`GET /health` returns `{ status: "ok", server: "prevoyant-server", ts: "..." }` — useful for uptime monitors, load balancers, and deployment health checks.

---

## Start / Stop the Server

Use the provided shell scripts from the **project root** (not from inside `server/`):

### Start

```bash
bash server/scripts/start.sh
```

- Checks if already running (reads `server/.server.pid`)
- Runs `npm install` if `node_modules/` is missing
- Spawns `node index.js` in the background
- Writes PID to `server/.server.pid`
- Logs to `server/prevoyant-server.log`
- Prints the dashboard URL on success

### Stop

```bash
bash server/scripts/stop.sh
```

- Reads PID from `server/.server.pid`
- Sends SIGTERM (graceful); waits up to 5 seconds
- Sends SIGKILL if the process hasn't exited
- Removes the PID file

### Restart

```bash
bash server/scripts/stop.sh && bash server/scripts/start.sh
```

### Run in foreground (development)

```bash
cd server
npm start          # node index.js
npm run dev        # node --watch index.js  (auto-reloads on file changes)
```

### View logs

```bash
tail -f server/prevoyant-server.log
```

---

## Environment Variables

All variables are read from the root `.env` file. The server never reads a `server/.env`.

### Server

| Variable | Default | Description |
|----------|---------|-------------|
| `WEBHOOK_PORT` | `3000` | Port the Express server listens on |
| `WEBHOOK_SECRET` | — | Token appended to the webhook URL (`?token=...`). Leave blank to skip token validation. |
| `WEBHOOK_POLL_INTERVAL_DAYS` | `0` (disabled) | Run `poll-jira.sh` every N days. Fractional values allowed (`0.5` = every 12 h). Set to `0` to disable polling. |

### Jira

| Variable | Description |
|----------|-------------|
| `JIRA_URL` | Atlassian base URL, e.g. `https://yourcompany.atlassian.net` |
| `JIRA_USERNAME` | Your account email — also used to filter incoming webhooks to only your tickets |
| `JIRA_API_TOKEN` | Jira API token ([generate here](https://id.atlassian.com/manage-profile/security/api-tokens)) |

### Analysis

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_REPORT_DIR` | `~/.prevoyant/reports` | Directory where Claude saves PDF/HTML reports |
| `AUTO_MODE` | — | Set to `Y` to bypass all Claude confirmation gates (headless mode) |
| `FORCE_FULL_RUN_ON` | — | Set to `1` to force all steps to run in full even on reruns |

---

## Dashboard

Open [http://localhost:3000/dashboard](http://localhost:3000/dashboard) in any browser.

### Summary cards

Four counters at the top of the page: **Running**, **Queued**, **Done**, **Failed**.

### Tickets table

Each row shows:

| Column | Description |
|--------|-------------|
| Ticket | Jira key — click to open the detail page |
| Mode | Dev / Review / Estimate |
| Source | `webhook` / `manual` / `disk` |
| Status | Queued / Running / Done / Failed / Interrupted |
| Queued at | When the ticket entered the queue |
| Completed | When the session finished |
| Duration | Elapsed run time |
| Reports | Download links for generated PDF/HTML files |
| Actions | Play button (re-run) + **Stop button** (visible when running or queued) |

The page auto-refreshes every 30 seconds. The JSON feed is at `/dashboard/json`.

### Ticket detail page

Click any ticket key to open its detail page, which shows:

- **Status badge** and **current stage** — live-updated every 5 seconds while running
- **Pipeline** — horizontal scrollable row of stage cards. Each card shows the step number, label, duration, and a colour-coded status. Skipped stages display a grey **Skipped** badge.
- **Progress bar** — percentage of completed stages
- **Run panel** — mode selector, Run button, and (when active) a **Stop Job** button
- **View Output** — collapsible session log with markdown rendering; falls back to PDF embed when the session is complete
- **Reports** — list of all associated PDF/HTML files with download and inline view links

---

## Pipeline Tracking

### How it works

1. Claude announces each step in its output using the format:
   ```
   ### Step N — {label}
   ```
2. The server detects this pattern via regex and marks the corresponding stage as **Active**.
3. When the next step is announced, the previous stage is marked **Done** and any skipped stages are marked **Skipped**.
4. When the session ends, remaining stages become **Skipped** (success) or the active stage becomes **Failed** (error/stop).

### Editing stage definitions

Stage definitions live in `server/dashboard/stages.json` — one array per mode:

```json
{
  "dev":      [ { "id": "0",  "label": "KB Sync & Query" }, ... ],
  "review":   [ { "id": "R0", "label": "KB Sync & Query" }, ... ],
  "estimate": [ { "id": "E0", "label": "KB Sync & Query" }, ... ]
}
```

**To add a new stage:**
1. Add an entry to the appropriate array in `stages.json`.
2. Optionally create `server/dashboard/stage-instructions/<id>.md` with Claude's instructions for that step (see [Stage Instructions](#stage-instructions)).
3. Restart the server.

The stage ID must match what Claude announces in its output (`"Step 15 —"` for id `"15"`). For a new stage to go **active** during a run, Claude must also announce it — which happens automatically when a `stage-instructions/<id>.md` file exists and instructs Claude to do so.

---

## Job Queue & Stop/Kill

### Queue behaviour

- All jobs run through a single FIFO queue.
- Only **one Claude session runs at a time** (`MAX_CONCURRENT = 1`) to prevent resource exhaustion.
- Additional jobs wait in the queue and start automatically when the current one finishes.

### Stop a job

Click the **Stop** button (red square icon) on the dashboard list row or the ticket detail page. A confirmation prompt appears before the job is cancelled.

**What happens:**

| State | Action |
|-------|--------|
| Queued | Removed from queue immediately; status set to **Interrupted** |
| Running | SIGTERM sent to the Claude process; SIGKILL after 3 seconds if still alive |

After stopping:
- The active pipeline stage is marked **Failed**
- All remaining pending stages are marked **Skipped**
- The session is persisted to disk with status `interrupted`
- The ticket can be re-run at any time from the dashboard

---

## Stage Instructions

Stage instructions let you define what Claude should do in a custom pipeline stage — without editing SKILL.md.

### How to add instructions for a new stage

1. Add the stage to `server/dashboard/stages.json`:
   ```json
   { "id": "15", "label": "Security Scan" }
   ```

2. Create `server/dashboard/stage-instructions/15.md` with the instructions:
   ```markdown
   Scan the proposed fix for OWASP Top 10 vulnerabilities. For each finding report:
   - Vulnerability type and CWE reference
   - Affected file and line number
   - Recommended remediation
   
   If no issues are found, state "No vulnerabilities detected."
   ```

3. Restart the server.

On the next session, Claude receives the stage sequence and the custom instructions injected into its prompt. It announces `### Step 15 — Security Scan` when it reaches that step, and the pipeline tracks it live.

**Key rule:** The stage ID in `stages.json` must match what Claude announces (`"Step 15 —"`). The instructions file is what tells Claude to announce that step and what to do there.

---

## Jira Webhook Setup

### Prerequisites

- Your server must be reachable from Jira's servers (public IP or tunnel — e.g., `ngrok` for local development).
- `WEBHOOK_SECRET` must be set in `.env` (recommended for security).

### Configuration in Jira

1. Go to **Jira Settings → System → WebHooks** (or **Project Settings → Webhooks** for project-scoped).
2. Click **Create a WebHook**.
3. Set the URL:
   ```
   http://your-server:3000/jira-events?token=your-webhook-secret
   ```
4. Under **Issue**, check: **Created**, **Updated**.
5. Save.

### Filtering

The server automatically filters incoming events. A ticket is queued only if **all** of the following are true:

- The Jira issue status is one of: **To Do**, **Open**, **Parked**, **Blocked**
- The assignee matches `JIRA_USERNAME` (when set)
- The ticket has not already been processed (deduplication via `.jira-seen-tickets` cache file)

### Local development with ngrok

```bash
ngrok http 3000
# Copy the https://xxx.ngrok.io URL and use it as the webhook URL in Jira
```

---

## Scheduled Polling

As a fallback when webhooks are unavailable, the server can run `poll-jira.sh` on a schedule.

Enable by setting `WEBHOOK_POLL_INTERVAL_DAYS` in `.env`:

```bash
WEBHOOK_POLL_INTERVAL_DAYS=1      # run daily
WEBHOOK_POLL_INTERVAL_DAYS=0.5    # run every 12 hours
WEBHOOK_POLL_INTERVAL_DAYS=0      # disabled (default)
```

The poll script is run once at server startup (if enabled) and then every N days thereafter. It queries Jira for tickets matching the configured criteria and queues any that aren't already in the seen-tickets cache.

---

## API Reference

### Health

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Returns `{ status: "ok", server: "prevoyant-server", ts: "..." }` |

### Dashboard

| Method | Path | Description |
|--------|------|-------------|
| GET | `/dashboard` | Dashboard HTML page |
| GET | `/dashboard/json` | Dashboard data as JSON |
| GET | `/dashboard/ticket/:key` | Ticket detail page |
| GET | `/dashboard/ticket/:key/partial` | Live partial update (polling endpoint used by the detail page) |

### Job Control

| Method | Path | Body | Description |
|--------|------|------|-------------|
| POST | `/dashboard/ticket/:key/run` | `mode=dev\|review\|estimate`, `force=1` (optional) | Queue a ticket for analysis |
| POST | `/dashboard/ticket/:key/stop` | — | Stop a running or queued job |

### Reports

| Method | Path | Description |
|--------|------|-------------|
| GET | `/dashboard/view?path=...` | Inline view of a PDF/HTML report (path must be inside reports directory) |
| GET | `/dashboard/download?path=...` | Download a PDF/HTML report |

### Webhook

| Method | Path | Description |
|--------|------|-------------|
| POST | `/jira-events?token=...` | Jira webhook receiver |

---

## Architecture

```
Jira webhook ──▶ POST /jira-events
                        │
                        ▼
                   webhooks/jira.js
                   (token check, status/assignee filter, dedup)
                        │
                        ▼
                  queue/jobQueue.js  ◀──  dashboard manual run
                  (FIFO, MAX=1)
                        │
                        ▼
               runner/claudeRunner.js
               (spawn `claude --print`, parse stream-json)
                        │
                   step detected
                   (regex: "Step N —")
                        │
                        ▼
               dashboard/tracker.js
               (in-memory state + session files)
                        │
               ┌────────┴────────┐
               ▼                 ▼
    dashboard/routes.js     ~/.prevoyant/sessions/
    (HTTP + HTML rendering)  (disk persistence)
```

**Key design decisions:**

- **No database** — all state is held in a `Map` in memory and mirrored to JSON files in `~/.prevoyant/sessions/`. On restart the files are loaded back in.
- **No template engine** — HTML is generated by plain JavaScript string concatenation. This keeps the server dependency-free beyond Express.
- **Single concurrent job** — Claude is a resource-intensive process. Running one at a time prevents memory exhaustion and keeps the output logs readable.
- **Stream parsing** — Claude is invoked with `--output-format stream-json`. The server buffers stdout into lines and parses each JSON event to extract assistant text and detect step boundaries in real time.

---

## File Structure

```
server/
├── index.js                      Express app setup, route mounting, server start
├── package.json
│
├── config/
│   └── env.js                    Loads root .env, exports typed config object
│
├── dashboard/
│   ├── routes.js                 All /dashboard endpoints + HTML/CSS rendering
│   ├── tracker.js                In-memory ticket state, session persistence, stage lifecycle
│   ├── stages.json               Pipeline stage definitions for all three modes
│   └── stage-instructions/       Optional per-stage markdown instruction files
│       └── .gitkeep
│
├── queue/
│   └── jobQueue.js               FIFO queue, drain loop, killJob()
│
├── runner/
│   ├── claudeRunner.js           Spawns claude CLI, parses stream-json, kills process
│   └── pollScheduler.js          Schedules poll-jira.sh on a day interval
│
├── webhooks/
│   └── jira.js                   POST /jira-events receiver, filtering, dedup
│
├── notifications/
│   ├── email.js                  Email stub (planned)
│   └── sms.js                    SMS stub (planned)
│
└── scripts/
    ├── start.sh                  Start server in background, write PID
    └── stop.sh                   Stop server by PID, clean up
```
