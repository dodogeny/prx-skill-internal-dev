'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let _cache    = null;
let _cachedAt = 0;

function kbDir() {
  const mode = process.env.PRX_KB_MODE || 'local';
  if (mode === 'distributed') {
    return process.env.PRX_KB_LOCAL_CLONE
      || path.join(os.homedir(), '.prevoyant', 'kb');
  }
  return process.env.PRX_KNOWLEDGE_DIR
    || path.join(os.homedir(), '.prevoyant', 'knowledge-base');
}

// Encrypted distributed KB: files are .md.enc — server can't read them without a
// per-session temp dir that doesn't exist at cache-load time. Skip pre-loading.
function isEncrypted() {
  return (process.env.PRX_KB_MODE || 'local') === 'distributed'
    && !!process.env.PRX_KB_KEY;
}

function _readDir(dir, base = '') {
  const map = {};
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (_) { return map; }

  for (const entry of entries) {
    const rel  = base ? `${base}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      Object.assign(map, _readDir(full, rel));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      try { map[rel] = fs.readFileSync(full, 'utf8'); }
      catch (_) { /* skip unreadable files */ }
    }
  }
  return map;
}

function refresh() {
  if (isEncrypted()) {
    _cache    = {};
    _cachedAt = Date.now();
    return;
  }
  const dir = kbDir();
  _cache    = _readDir(dir);
  _cachedAt = Date.now();
  const count = Object.keys(_cache).length;
  if (count > 0) console.log(`[kb-cache] Loaded ${count} KB files from ${dir}`);
}

function get() {
  if (!_cache || (Date.now() - _cachedAt) > CACHE_TTL_MS) refresh();
  return _cache;
}

function getFile(relPath) {
  return get()[relPath] ?? null;
}

// Called after each ticket completes (Step 13 may have written new KB data).
function invalidate() {
  _cache    = null;
  _cachedAt = 0;
}

module.exports = { get, getFile, invalidate, kbDir, isEncrypted };
