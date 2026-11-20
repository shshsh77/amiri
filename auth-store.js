import { createHash, randomBytes, randomInt } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createShopStore } from "./shop-store.js";

const challengeLifetime = 10 * 60 * 1000;
const sessionLifetime = 7 * 24 * 60 * 60 * 1000;
const hash = value => createHash("sha256").update(value).digest("hex");
const normalize = value => value.toLowerCase().replaceAll("ё", "е");
const clean = value => String(value ?? "").trim().slice(0, 128);

export function openAuthStore(path, now = Date.now) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      telegram_id TEXT PRIMARY KEY,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      username TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_login INTEGER,
      blocked INTEGER NOT NULL DEFAULT 0 CHECK (blocked IN (0, 1))
    ) STRICT;
    CREATE TABLE IF NOT EXISTS challenges (
      token_hash TEXT PRIMARY KEY,
      browser_hash TEXT NOT NULL,
      code TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      telegram_id TEXT,
      state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'approved', 'denied', 'used'))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS challenges_expiry ON challenges (expires_at);
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      telegram_id TEXT NOT NULL REFERENCES users (telegram_id),
      expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions (expires_at);
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions (telegram_id);
    CREATE TABLE IF NOT EXISTS editors (
      telegram_id TEXT PRIMARY KEY REFERENCES users (telegram_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS mini_launches (
      digest TEXT PRIMARY KEY,
      browser_hash TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS mini_launches_expiry ON mini_launches (expires_at);
  `);
  db.function("normalize_text", { deterministic: true }, normalize);
  const challenge = db.prepare("SELECT * FROM challenges WHERE token_hash = ? AND expires_at > ?");
  const getUser = db.prepare("SELECT * FROM users WHERE telegram_id = ?");
  const getSession = db.prepare(`
    SELECT users.*, sessions.expires_at FROM sessions JOIN users USING (telegram_id)
    WHERE sessions.token_hash = ? AND sessions.expires_at > ? AND users.blocked = 0
  `);
  const addUser = db.prepare(`
    INSERT INTO users (telegram_id, first_name, last_name, username, created_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (telegram_id) DO UPDATE SET
      first_name = excluded.first_name, last_name = excluded.last_name, username = excluded.username
  `);
  const userMatches = "instr(normalize_text(telegram_id || ' ' || first_name || ' ' || last_name || ' @' || username), ?) > 0";
  const countMatches = db.prepare(`SELECT count(*) AS count FROM users WHERE ${userMatches}`);
  const listMatches = db.prepare(`SELECT * FROM users WHERE ${userMatches} ORDER BY created_at DESC, telegram_id LIMIT ? OFFSET ?`);

  function transaction(action) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function register(from, timestamp = now()) {
    const id = String(from.id);
    addUser.run(id, clean(from.first_name), clean(from.last_name), clean(from.username), timestamp);
    return getUser.get(id);
  }

  return {
    shop: createShopStore(db, transaction, now),
    close: () => db.close(),
    register,
    createChallenge(browser) {
      const timestamp = now();
      db.prepare("DELETE FROM challenges WHERE expires_at <= ?").run(timestamp);
      db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(timestamp);
      const token = randomBytes(24).toString("base64url");
      const code = String(randomInt(100000, 1000000));
      const expiresAt = timestamp + challengeLifetime;
      db.prepare("INSERT INTO challenges (token_hash, browser_hash, code, expires_at) VALUES (?, ?, ?, ?)")
        .run(hash(token), hash(browser), code, expiresAt);
      return { token, code, expiresAt };
    },
    claim(token, telegramId) {
      return transaction(() => {
        const key = hash(token);
        const entry = challenge.get(key, now());
        if (!entry || entry.state !== "pending" || (entry.telegram_id && entry.telegram_id !== telegramId)) return null;
        db.prepare("UPDATE challenges SET telegram_id = ? WHERE token_hash = ?").run(telegramId, key);
        return entry.code;
      });
    },
    decide(token, from, approved) {
      return transaction(() => {
        const key = hash(token);
        const timestamp = now();
        const entry = challenge.get(key, timestamp);
        if (!entry || entry.state !== "pending" || entry.telegram_id !== String(from.id)) return "expired";
        const user = approved ? register(from, timestamp) : null;
        const state = user && !user.blocked ? "approved" : "denied";
        db.prepare("UPDATE challenges SET state = ? WHERE token_hash = ?").run(state, key);
        return user?.blocked ? "blocked" : state;
      });
    },
    exchange(token, browser) {
      return transaction(() => {
        const timestamp = now();
        const key = hash(token);
        const entry = challenge.get(key, timestamp);
        if (!entry || entry.browser_hash !== hash(browser)) return { status: "expired" };
        if (entry.state === "pending" || entry.state === "denied") return { status: entry.state };
        const session = hash(`session:${browser}:${token}`);
        if (entry.state === "approved") {
          if (getUser.get(entry.telegram_id)?.blocked) {
            db.prepare("UPDATE challenges SET state = 'denied' WHERE token_hash = ?").run(key);
            return { status: "denied" };
          }
          db.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run(hash(session), entry.telegram_id, timestamp + sessionLifetime);
          db.prepare("UPDATE users SET last_login = ? WHERE telegram_id = ?").run(timestamp, entry.telegram_id);
          db.prepare("UPDATE challenges SET state = 'used' WHERE token_hash = ?").run(key);
        }
        const user = getSession.get(hash(session), timestamp);
        return user ? { status: "authenticated", session, expiresAt: user.expires_at } : { status: "expired" };
      });
    },
    session(token) {
      return token ? getSession.get(hash(token), now()) : undefined;
    },
    miniSession(launch, browser) {
      return transaction(() => {
        const timestamp = now();
        if (launch.expiresAt <= timestamp) return { status: "expired" };
        db.prepare("DELETE FROM mini_launches WHERE expires_at <= ?").run(timestamp);
        db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(timestamp);
        const browserHash = hash(browser);
        const token = hash(`mini-session:${browser}:${launch.digest}`);
        const tokenHash = hash(token);
        const existing = db.prepare("SELECT * FROM mini_launches WHERE digest = ?").get(launch.digest);
        if (existing) {
          if (existing.browser_hash !== browserHash) return { status: "expired" };
          const session = getSession.get(tokenHash, timestamp);
          return session ? { status: "authenticated", session: token, expiresAt: session.expires_at } : { status: "expired" };
        }
        const user = register(launch.user, timestamp);
        if (user.blocked) return { status: "denied" };
        db.prepare("INSERT INTO mini_launches VALUES (?, ?, ?)").run(launch.digest, browserHash, launch.expiresAt);
        const expiresAt = timestamp + sessionLifetime;
        db.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run(tokenHash, user.telegram_id, expiresAt);
        db.prepare("UPDATE users SET last_login = ? WHERE telegram_id = ?").run(timestamp, user.telegram_id);
        return { status: "authenticated", session: token, expiresAt };
      });
    },
    logout(token) {
      if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hash(token));
    },
    isEditor(id) {
      return Boolean(db.prepare("SELECT 1 FROM editors WHERE telegram_id = ?").get(id));
    },
    isBlocked(id) {
      return Boolean(getUser.get(id)?.blocked);
    },
    setEditor(id, enabled) {
      if (!getUser.get(id)) return false;
      const sql = enabled ? "INSERT OR IGNORE INTO editors VALUES (?)" : "DELETE FROM editors WHERE telegram_id = ?";
      db.prepare(sql).run(id);
      return true;
    },
    users(query, page, size) {
      const find = normalize(query);
      const { count } = countMatches.get(find);
      const stats = db.prepare("SELECT count(*) AS total, count(*) FILTER (WHERE blocked = 1) AS blocked FROM users").get();
      const currentPage = Math.min(page, Math.max(1, Math.ceil(count / size)));
      return { count, stats, page: currentPage, users: listMatches.all(find, size, (currentPage - 1) * size) };
    },
    setBlocked(telegramId, blocked) {
      return transaction(() => {
        const result = db.prepare("UPDATE users SET blocked = ? WHERE telegram_id = ?").run(Number(blocked), telegramId);
        if (blocked) {
          db.prepare("DELETE FROM sessions WHERE telegram_id = ?").run(telegramId);
          db.prepare("UPDATE challenges SET state = 'denied' WHERE telegram_id = ? AND state = 'approved'").run(telegramId);
        }
        return result.changes > 0;
      });
    },
  };
}
