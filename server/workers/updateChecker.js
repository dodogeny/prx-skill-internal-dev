'use strict';

// Update checker — runs as a worker_threads thread inside prevoyant-server.
// Polls GitHub at random intervals (6–24 h) for a new plugin version.
// Writes ~/.prevoyant/server/update-status.json so the dashboard can show a banner.
// Sends a one-time email alert when a new version is first detected.

const { workerData, parentPort } = require('worker_threads');
const fs    = require('fs');
const os    = require('os');
const path  = require('path');
const https = require('https');
const net   = require('net');
const tls   = require('tls');

const {
  currentVersion = '0.0.0',
  smtpHost = '',
  smtpPort = '587',
  smtpUser = '',
  smtpPass = '',
  emailTo  = '',
} = workerData || {};

const PREVOYANT_DIR = path.join(os.homedir(), '.prevoyant');
const SERVER_DIR    = path.join(PREVOYANT_DIR, 'server');
const STATUS_FILE   = path.join(SERVER_DIR, 'update-status.json');

const REMOTE_URL      = 'https://raw.githubusercontent.com/dodogeny/prevoyant-claude-plugin/main/plugin/.claude-plugin/plugin.json';
const MIN_INTERVAL_MS = 6  * 60 * 60 * 1000;   // 6 hours
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;   // 24 hours

let halted = false;

// ── Logging ───────────────────────────────────────────────────────────────────

function log(level, msg) {
  const ts = new Date().toISOString();
  if (parentPort) parentPort.postMessage({ type: 'log', level, msg, ts });
  console.log(`[${ts}] [update-checker/${level}] ${msg}`);
}

// ── Semver comparison ─────────────────────────────────────────────────────────

function isNewer(remote, current) {
  const parse = v => v.replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const [rMaj, rMin, rPat] = parse(remote);
  const [cMaj, cMin, cPat] = parse(current);
  if (rMaj !== cMaj) return rMaj > cMaj;
  if (rMin !== cMin) return rMin > cMin;
  return rPat > cPat;
}

// ── Status persistence ────────────────────────────────────────────────────────

function readStatus() {
  try { return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')); }
  catch (_) { return {}; }
}

function writeStatus(data) {
  try {
    fs.mkdirSync(SERVER_DIR, { recursive: true });
    fs.writeFileSync(STATUS_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    log('warn', `Could not write update status: ${e.message}`);
  }
}

// ── Remote version fetch ──────────────────────────────────────────────────────

function fetchRemoteVersion() {
  return new Promise((resolve, reject) => {
    const req = https.get(REMOTE_URL, { timeout: 15000 }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const meta = JSON.parse(data);
          resolve(meta.version || null);
        } catch (e) {
          reject(new Error(`Bad JSON: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

// ── SMTP client (same pattern as diskMonitor / healthMonitor) ─────────────────

function sendEmail(subject, body) {
  if (!smtpHost || !smtpUser || !smtpPass || !emailTo) {
    log('warn', 'Email alert skipped — SMTP not fully configured');
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const USE_SSL = parseInt(smtpPort, 10) === 465;
    let sock      = null;
    let active    = null;
    let buf       = '';
    let phase     = 'greeting';
    let settled   = false;

    function done(err) {
      if (settled) return;
      settled = true;
      try { (active || sock) && (active || sock).destroy(); } catch (_) {}
      if (err) reject(err);
      else resolve();
    }

    function write(s) { active.write(s + '\r\n'); }

    function handle(code) {
      switch (phase) {
        case 'greeting':
          if (code !== 220) return done(new Error(`Unexpected greeting ${code}`));
          phase = 'ehlo1';
          write('EHLO prevoyant-update-checker');
          break;
        case 'ehlo1':
          if (code === 250) {
            if (USE_SSL) { phase = 'auth';     write('AUTH LOGIN'); }
            else         { phase = 'starttls'; write('STARTTLS');   }
          }
          break;
        case 'starttls':
          if (code !== 220) return done(new Error(`STARTTLS rejected: ${code}`));
          phase = 'ehlo2';
          {
            const upgraded = tls.connect({ socket: sock, host: smtpHost, rejectUnauthorized: false });
            upgraded.on('secureConnect', () => { active = upgraded; write('EHLO prevoyant-update-checker'); });
            upgraded.on('data', onData);
            upgraded.on('error', done);
          }
          break;
        case 'ehlo2':
          if (code === 250) { phase = 'auth'; write('AUTH LOGIN'); }
          break;
        case 'auth':
          if (code !== 334) return done(new Error(`AUTH rejected: ${code}`));
          phase = 'user';
          write(Buffer.from(smtpUser).toString('base64'));
          break;
        case 'user':
          if (code !== 334) return done(new Error(`AUTH username rejected: ${code}`));
          phase = 'pass';
          write(Buffer.from(smtpPass).toString('base64'));
          break;
        case 'pass':
          if (code !== 235) return done(new Error(`AUTH failed: ${code}`));
          phase = 'mail';
          write(`MAIL FROM:<${smtpUser}>`);
          break;
        case 'mail':
          if (code !== 250) return done(new Error(`MAIL FROM rejected: ${code}`));
          phase = 'rcpt';
          write(`RCPT TO:<${emailTo}>`);
          break;
        case 'rcpt':
          if (code !== 250) return done(new Error(`RCPT TO rejected: ${code}`));
          phase = 'data';
          write('DATA');
          break;
        case 'data':
          if (code !== 354) return done(new Error(`DATA rejected: ${code}`));
          phase = 'body';
          write(`From: Prevoyant Update Checker <${smtpUser}>`);
          write(`To: ${emailTo}`);
          write(`Subject: ${subject}`);
          write(`Date: ${new Date().toUTCString()}`);
          write('MIME-Version: 1.0');
          write('Content-Type: text/plain; charset=utf-8');
          write('');
          for (const line of body.split('\n')) {
            write(line.startsWith('.') ? '.' + line : line);
          }
          write('.');
          break;
        case 'body':
          if (code !== 250) return done(new Error(`Message rejected: ${code}`));
          phase = 'quit';
          write('QUIT');
          break;
        case 'quit':
          done(null);
          break;
        default:
          break;
      }
    }

    function onData(chunk) {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (!line) continue;
        const code = parseInt(line.slice(0, 3), 10);
        const cont = line[3] === '-';
        if (!cont && !isNaN(code)) handle(code);
      }
    }

    const connectOpts = { host: smtpHost, port: parseInt(smtpPort, 10), rejectUnauthorized: false };
    sock   = USE_SSL ? tls.connect(connectOpts) : net.connect(connectOpts);
    active = sock;
    sock.on('data', onData);
    sock.on('error', done);
    sock.setTimeout(20000, () => done(new Error('SMTP connect timeout')));
  });
}

// ── Check ─────────────────────────────────────────────────────────────────────

async function check() {
  if (halted) return;
  log('info', `Checking for updates (current v${currentVersion})…`);

  let remoteVersion;
  try {
    remoteVersion = await fetchRemoteVersion();
  } catch (e) {
    log('warn', `Update check failed: ${e.message}`);
    return;
  }

  if (!remoteVersion) {
    log('warn', 'Remote version could not be parsed');
    return;
  }

  const available = isNewer(remoteVersion, currentVersion);
  const prev      = readStatus();

  const status = {
    available,
    latestVersion:   remoteVersion,
    currentVersion,
    checkedAt:       new Date().toISOString(),
    notifiedVersion: prev.notifiedVersion || null,
  };
  writeStatus(status);

  if (available) {
    log('info', `Update available: v${remoteVersion} (current v${currentVersion})`);
    if (parentPort) parentPort.postMessage({ type: 'update-available', latestVersion: remoteVersion, currentVersion });

    if (prev.notifiedVersion !== remoteVersion) {
      const subject = `Prevoyant Update Available — v${remoteVersion}`;
      const body = [
        `A new version of Prevoyant Claude Plugin is available.`,
        ``,
        `  Current version : v${currentVersion}`,
        `  Latest version  : v${remoteVersion}`,
        ``,
        `Open your Prevoyant dashboard and click "Upgrade" to update automatically.`,
        ``,
        `GitHub: https://github.com/dodogeny/prevoyant-claude-plugin`,
      ].join('\n');

      try {
        await sendEmail(subject, body);
        log('info', `Update notification sent for v${remoteVersion}`);
      } catch (e) {
        log('warn', `Email send failed: ${e.message}`);
      }

      writeStatus({ ...status, notifiedVersion: remoteVersion });
    }
  } else {
    log('info', `Already up to date (v${currentVersion})`);
  }
}

// ── Poll loop ─────────────────────────────────────────────────────────────────

async function loop() {
  await check();
  if (halted) return;
  const delayMs = MIN_INTERVAL_MS + Math.random() * (MAX_INTERVAL_MS - MIN_INTERVAL_MS);
  const delayH  = Math.round(delayMs / 360000) / 10;
  log('info', `Next check in ${delayH}h`);
  setTimeout(loop, delayMs);
}

// ── Message handling ──────────────────────────────────────────────────────────

if (parentPort) {
  parentPort.on('message', msg => {
    if (msg && msg.type === 'graceful-stop') {
      halted = true;
      log('info', 'Stopping');
      process.exit(0);
    }
    if (msg && msg.type === 'check-now') {
      check().catch(e => log('warn', `Manual check failed: ${e.message}`));
    }
  });
}

loop();
