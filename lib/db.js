import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.resolve(__dirname, '..', 'domains.db');

export const db = new Database(DB_PATH);

// Enable WAL mode for high concurrency and resilience
db.pragma('journal_mode = WAL');

export function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS domains (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT UNIQUE NOT NULL COLLATE NOCASE,
      owner TEXT NOT NULL,
      registrar TEXT,
      registered_date TEXT,
      expired_date TEXT,
      days_left INTEGER,
      last_checked_at TEXT,
      last_alerted_at TEXT,
      last_alert_threshold INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_domains_domain ON domains(domain);
    CREATE INDEX IF NOT EXISTS idx_domains_expired_date ON domains(expired_date);
    CREATE INDEX IF NOT EXISTS idx_domains_days_left ON domains(days_left);
  `);
}

export function getAllDomains(sortBy = 'days_left ASC') {
  const allowedSorts = {
    'days_left ASC': 'CASE WHEN days_left IS NULL THEN 999999 ELSE days_left END ASC',
    'expired_date ASC': 'CASE WHEN expired_date IS NULL THEN "9999-12-31" ELSE expired_date END ASC',
    'domain ASC': 'domain ASC',
    'owner ASC': 'owner ASC'
  };
  const sortClause = allowedSorts[sortBy] || allowedSorts['days_left ASC'];
  return db.prepare(`SELECT * FROM domains ORDER BY ${sortClause}`).all();
}

export function getDomain(domain) {
  return db.prepare(`SELECT * FROM domains WHERE domain = ? COLLATE NOCASE`).get(domain.trim());
}

export function addOrUpdateDomain({
  domain,
  owner,
  registrar = null,
  registered_date = null,
  expired_date = null,
  days_left = null
}) {
  const cleanDomain = domain.toLowerCase().trim();
  const cleanOwner = owner.trim();
  const now = new Date().toISOString();

  const stmt = db.prepare(`
    INSERT INTO domains (domain, owner, registrar, registered_date, expired_date, days_left, last_checked_at, updated_at)
    VALUES (@domain, @owner, @registrar, @registered_date, @expired_date, @days_left, @now, @now)
    ON CONFLICT(domain) DO UPDATE SET
      owner = excluded.owner,
      registrar = COALESCE(excluded.registrar, domains.registrar),
      registered_date = COALESCE(excluded.registered_date, domains.registered_date),
      expired_date = COALESCE(excluded.expired_date, domains.expired_date),
      days_left = COALESCE(excluded.days_left, domains.days_left),
      last_checked_at = excluded.last_checked_at,
      updated_at = excluded.updated_at
  `);

  stmt.run({
    domain: cleanDomain,
    owner: cleanOwner,
    registrar,
    registered_date,
    expired_date,
    days_left,
    now
  });

  return getDomain(cleanDomain);
}

export function deleteDomain(domain) {
  const cleanDomain = domain.toLowerCase().trim();
  const res = db.prepare(`DELETE FROM domains WHERE domain = ? COLLATE NOCASE`).run(cleanDomain);
  return res.changes > 0;
}

export function getExpiringDomains(daysThreshold = 30) {
  return db.prepare(`
    SELECT * FROM domains
    WHERE days_left IS NOT NULL AND days_left <= ?
    ORDER BY days_left ASC
  `).all(daysThreshold);
}

export function updateDomainOwner(domain, newOwner) {
  const cleanDomain = domain.toLowerCase().trim();
  const cleanOwner = newOwner.trim();
  const now = new Date().toISOString();
  const res = db.prepare(`
    UPDATE domains
    SET owner = ?, updated_at = ?
    WHERE domain = ? COLLATE NOCASE
  `).run(cleanOwner, now, cleanDomain);
  return res.changes > 0 ? getDomain(cleanDomain) : null;
}

export function updateDomainWhois(domain, { registrar, registeredDate, expiredDate, daysLeft }) {
  const now = new Date().toISOString();
  // If domain is renewed (> 60 days left), reset last_alert_threshold so future alerts fire
  if (daysLeft !== null && daysLeft > 60) {
    db.prepare(`
      UPDATE domains
      SET registrar = COALESCE(?, registrar),
          registered_date = COALESCE(?, registered_date),
          expired_date = COALESCE(?, expired_date),
          days_left = ?,
          last_alert_threshold = NULL,
          last_checked_at = ?,
          updated_at = ?
      WHERE domain = ? COLLATE NOCASE
    `).run(registrar, registeredDate, expiredDate, daysLeft, now, now, domain.trim());
  } else {
    db.prepare(`
      UPDATE domains
      SET registrar = COALESCE(?, registrar),
          registered_date = COALESCE(?, registered_date),
          expired_date = COALESCE(?, expired_date),
          days_left = ?,
          last_checked_at = ?,
          updated_at = ?
      WHERE domain = ? COLLATE NOCASE
    `).run(registrar, registeredDate, expiredDate, daysLeft, now, now, domain.trim());
  }
}

export function updateAlertState(domain, threshold) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE domains
    SET last_alerted_at = ?,
        last_alert_threshold = ?
    WHERE domain = ? COLLATE NOCASE
  `).run(now, threshold, domain.trim());
}

export function getNextDomainToCheck() {
  return db.prepare(`
    SELECT * FROM domains
    ORDER BY
      CASE WHEN last_checked_at IS NULL THEN 0 ELSE 1 END,
      last_checked_at ASC
    LIMIT 1
  `).get();
}

export function touchDomainChecked(domain) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE domains
    SET last_checked_at = ?, updated_at = ?
    WHERE domain = ? COLLATE NOCASE
  `).run(now, now, domain.trim());
}

export function closeDb() {
  try {
    db.close();
    console.log('SQLite database connection closed.');
  } catch (err) {
    console.warn('Error closing database:', err.message);
  }
}

