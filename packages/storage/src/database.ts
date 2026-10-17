import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Database = DatabaseSync;

/**
 * One step per schema version, applied in order and never edited once shipped:
 * a change is a new step. `PRAGMA user_version` records how far a file has come.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'operator', 'viewer', 'member')),
    status TEXT NOT NULL CHECK (status IN ('active', 'invited', 'disabled')),
    password_hash TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_login_at TEXT
  );

  CREATE TABLE groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    description TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE group_members (
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, user_id)
  );

  CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    user_agent TEXT
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE invitations (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL COLLATE NOCASE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin', 'operator', 'viewer', 'member')),
    group_ids TEXT NOT NULL,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  );

  CREATE TABLE model_policies (
    model_name TEXT PRIMARY KEY,
    enabled INTEGER NOT NULL,
    loaded INTEGER NOT NULL
  );

  CREATE TABLE model_grants (
    model_name TEXT NOT NULL REFERENCES model_policies(model_name) ON DELETE CASCADE,
    subject_type TEXT NOT NULL CHECK (subject_type IN ('user', 'group')),
    subject_id TEXT NOT NULL,
    can_use INTEGER NOT NULL,
    PRIMARY KEY (model_name, subject_type, subject_id)
  );

  CREATE TABLE audit_events (
    id TEXT PRIMARY KEY,
    timestamp TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    action TEXT NOT NULL,
    module TEXT NOT NULL,
    result TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    resource_type TEXT,
    resource_id TEXT,
    error_code TEXT
  );
  CREATE INDEX audit_events_time ON audit_events(timestamp DESC);
  `,
  `
  CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    model TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX conversations_user ON conversations(user_id, updated_at DESC);

  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    model TEXT,
    status TEXT NOT NULL CHECK (status IN ('complete', 'stopped', 'error')),
    created_at TEXT NOT NULL
  );
  CREATE INDEX messages_conversation ON messages(conversation_id, seq);
  `,
  `
  CREATE TABLE api_keys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    hint TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT
  );
  CREATE INDEX api_keys_user ON api_keys(user_id, created_at DESC);
  `
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * Opens (or creates) the ModelDock database. `":memory:"` gives a throwaway one for tests.
 * Everything lives in this single file on the user's computer.
 */
export function openDatabase(path: string): Database {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");

  if (path !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL;");
  }

  migrate(db);
  return db;
}

function migrate(db: Database): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  const current = row.user_version;

  if (current > MIGRATIONS.length) {
    throw new Error(
      `The ModelDock database is at schema version ${current}, newer than this ModelDock (${MIGRATIONS.length}). Update ModelDock before opening it.`
    );
  }

  for (let version = current; version < MIGRATIONS.length; version += 1) {
    transaction(db, () => {
      db.exec(MIGRATIONS[version]!);
      db.exec(`PRAGMA user_version = ${version + 1};`);
    });
  }
}

export function transaction<T>(db: Database, work: () => T): T {
  db.exec("BEGIN IMMEDIATE;");

  try {
    const result = work();
    db.exec("COMMIT;");
    return result;
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
}
