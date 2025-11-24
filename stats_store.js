const { existsSync, readFileSync, writeFileSync, mkdirSync } = require("node:fs");
const path = require("node:path");

const DEFAULT_FILE = process.env.STATS_FILE || path.join(__dirname, "stats.json");

function ensureDir(dir) {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch (e) {
    // ignore
  }
}

function loadRaw(fp) {
  if (!existsSync(fp)) return { updatedAt: Date.now(), accounts: {} };
  try {
    const txt = readFileSync(fp, "utf8");
    return JSON.parse(txt || "{}");
  } catch (e) {
    return { updatedAt: Date.now(), accounts: {} };
  }
}

function saveRaw(fp, obj) {
  try {
    writeFileSync(fp, JSON.stringify(obj, null, 2));
  } catch (e) {
    // best-effort
  }
}

class StatsStore {
  constructor(filePath) {
    this.filePath = filePath || DEFAULT_FILE;
    ensureDir(path.dirname(this.filePath));
    this._data = loadRaw(this.filePath);
    // normalize
    if (!this._data.accounts) this._data.accounts = {};
  }

  _persist() {
    this._data.updatedAt = Date.now();
    saveRaw(this.filePath, this._data);
  }

  _ensureAccount(name) {
    if (!this._data.accounts[name]) {
      this._data.accounts[name] = { imports: [], last_sync: null };
    }
    return this._data.accounts[name];
  }

  // record that a message was successfully imported for account
  recordImport(accountName, ts) {
    const t = ts || Date.now();
    const acc = this._ensureAccount(accountName);
    acc.imports.push(t);
    // prune imports older than 400 days to keep file small
    const cutoff = Date.now() - 400 * 24 * 60 * 60 * 1000;
    acc.imports = acc.imports.filter((x) => x >= cutoff);
    this._persist();
  }

  // record last sync status for account: { status: 'success'|'fail'|'started', message?, time }
  recordSyncStatus(accountName, status, message) {
    const acc = this._ensureAccount(accountName);
    acc.last_sync = { time: Date.now(), status: status, message: message || null };
    this._persist();
  }

  // compute counts for the time ranges
  _counts(imports) {
    const now = Date.now();
    const day = now - 24 * 60 * 60 * 1000;
    const week = now - 7 * 24 * 60 * 60 * 1000;
    const month = now - 30 * 24 * 60 * 60 * 1000;
    const year = now - 365 * 24 * 60 * 60 * 1000;
    return {
      day: imports.filter((t) => t >= day).length,
      week: imports.filter((t) => t >= week).length,
      month: imports.filter((t) => t >= month).length,
      year: imports.filter((t) => t >= year).length,
      total: imports.length,
    };
  }

  getAccountStats(accountName) {
    const acc = this._data.accounts[accountName] || { imports: [], last_sync: null };
    return {
      account: accountName,
      last_sync: acc.last_sync,
      counts: this._counts(acc.imports || []),
    };
  }

  getAllStats() {
    const out = {};
    for (const name of Object.keys(this._data.accounts)) {
      out[name] = this.getAccountStats(name);
    }
    return { updatedAt: this._data.updatedAt, accounts: out };
  }
}

module.exports = { StatsStore };
