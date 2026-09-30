import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type DB = Database.Database;

const MIGRATIONS: string[] = [
  // v1 — access control, accounts, chats, invites
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE ip_allowlist (
    id TEXT PRIMARY KEY,
    ip_key TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL,            -- password | invite | approval | admin | cli
    note TEXT,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER               -- optional hard expiry
  );
  CREATE TABLE ip_blocklist (
    ip_key TEXT PRIMARY KEY,
    fail_count INTEGER NOT NULL DEFAULT 0,
    total_fails INTEGER NOT NULL DEFAULT 0,
    window_start INTEGER,
    blocked_until INTEGER,
    permanent INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE gate_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT NOT NULL,
    method TEXT NOT NULL,
    success INTEGER NOT NULL,
    user_agent TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX gate_attempts_time ON gate_attempts(created_at);
  CREATE TABLE gate_requests (
    id TEXT PRIMARY KEY,
    ip_key TEXT NOT NULL,
    ip TEXT NOT NULL,
    message TEXT,
    user_agent TEXT,
    status TEXT NOT NULL,            -- pending | approved | rejected
    created_at INTEGER NOT NULL,
    decided_at INTEGER
  );

  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    bio TEXT NOT NULL DEFAULT '',
    auth_salt TEXT NOT NULL,
    auth_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    invited_by TEXT,
    created_at INTEGER NOT NULL,
    disabled_at INTEGER
  );
  CREATE TABLE user_keys (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    sign_pk TEXT NOT NULL,
    box_pk TEXT NOT NULL,
    backup_ct TEXT NOT NULL,
    backup_nonce TEXT NOT NULL,
    key_version INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_name TEXT,
    user_agent TEXT,
    ip TEXT,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE chats (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,              -- direct | group
    title_ct TEXT,                   -- encrypted title (opaque JSON), groups only
    direct_key TEXT UNIQUE,          -- "<uidA>|<uidB>" sorted, direct chats only
    created_by TEXT NOT NULL,
    current_epoch INTEGER NOT NULL DEFAULT 1,
    needs_rotation INTEGER NOT NULL DEFAULT 0,   -- membership changed; a member must distribute epoch+1
    disappearing_seconds INTEGER NOT NULL DEFAULT 0,
    last_seq INTEGER NOT NULL DEFAULT 0,
    last_msg_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE chat_members (
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member',   -- owner | admin | member
    joined_at INTEGER NOT NULL,
    joined_epoch INTEGER NOT NULL DEFAULT 1,
    cleared_before_seq INTEGER NOT NULL DEFAULT 0,
    last_read_seq INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (chat_id, user_id)
  );
  CREATE INDEX chat_members_user ON chat_members(user_id);
  CREATE TABLE chat_keys (
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    epoch INTEGER NOT NULL,
    recipient_id TEXT NOT NULL,
    sealed_key TEXT NOT NULL,
    distributor_id TEXT NOT NULL,
    signature TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (chat_id, epoch, recipient_id)
  );
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    sender_id TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    client_msg_id TEXT NOT NULL,
    nonce TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    signature TEXT NOT NULL,
    edited_at INTEGER,
    expires_at INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE (chat_id, seq)
  );
  CREATE UNIQUE INDEX messages_client_id ON messages(chat_id, sender_id, client_msg_id);
  CREATE INDEX messages_expiry ON messages(expires_at) WHERE expires_at IS NOT NULL;
  CREATE TABLE message_tombstones (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    deleted_at INTEGER NOT NULL
  );
  CREATE TABLE message_hidden (
    user_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    PRIMARY KEY (user_id, message_id)
  );

  CREATE TABLE invites (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    code_hash TEXT UNIQUE,
    kind TEXT NOT NULL,              -- register | group
    chat_id TEXT,
    created_by TEXT,
    max_uses INTEGER,                -- NULL = unlimited
    used_count INTEGER NOT NULL DEFAULT 0,
    gate_uses INTEGER NOT NULL DEFAULT 0,
    grants_admin INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    expires_at INTEGER,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE invite_uses (
    invite_id TEXT NOT NULL,
    user_id TEXT,
    ip TEXT,
    used_at INTEGER NOT NULL
  );
  `,
  // v2 — OPAQUE authentication, recovery words, signed membership changes
  `
  ALTER TABLE users DROP COLUMN auth_salt;
  ALTER TABLE users DROP COLUMN auth_hash;
  ALTER TABLE users ADD COLUMN opaque_record TEXT;            -- OPAQUE registration record (password)
  ALTER TABLE users ADD COLUMN recovery_record TEXT;          -- OPAQUE registration record (24 recovery words)
  ALTER TABLE user_keys ADD COLUMN recovery_backup_ct TEXT;   -- identity backup encrypted with the recovery export key
  ALTER TABLE user_keys ADD COLUMN recovery_backup_nonce TEXT;

  ALTER TABLE chats ADD COLUMN membership_version INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE chat_members ADD COLUMN join_order INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE chat_keys ADD COLUMN membership_version INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE invites ADD COLUMN needs_approval INTEGER NOT NULL DEFAULT 0;

  -- every membership change is signed by the member who made it; clients replay & verify the chain
  CREATE TABLE membership_log (
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    action TEXT NOT NULL,            -- create | add | remove | leave | role
    actor_id TEXT NOT NULL,
    targets TEXT NOT NULL,           -- JSON array of user ids
    role TEXT,                       -- for action=role
    signature TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (chat_id, version)
  );
  -- people who used a group invite and wait for an admin client to sign them in
  CREATE TABLE join_requests (
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invite_id TEXT,
    auto_approve INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (chat_id, user_id)
  );
  `,
  // v3 — encrypted attachments, encrypted reactions, pinned messages
  `
  CREATE TABLE blobs (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    size INTEGER NOT NULL,
    message_id TEXT,                 -- NULL until a message references it; unreferenced blobs are purged after 24h
    created_at INTEGER NOT NULL
  );
  CREATE INDEX blobs_message ON blobs(message_id);
  CREATE INDEX blobs_chat ON blobs(chat_id);
  CREATE INDEX blobs_owner_time ON blobs(owner_id, created_at);
  CREATE TABLE reactions (
    message_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    nonce TEXT NOT NULL,
    ciphertext TEXT NOT NULL,        -- the emoji, encrypted with the chat key
    signature TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id)
  );
  CREATE INDEX reactions_chat ON reactions(chat_id);
  CREATE TABLE pins (
    chat_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    pinned_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (chat_id, message_id)
  );
  `,
  // v4 — sync of removals for the local search cache, web push
  `
  ALTER TABLE message_hidden ADD COLUMN hidden_at INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX tombstones_time ON message_tombstones(deleted_at);
  CREATE TABLE push_subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX push_user ON push_subscriptions(user_id);
  `,
  // v5 — admin alerts, per-user upload quota
  `
  CREATE TABLE admin_alerts (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    dedupe_key TEXT,
    created_at INTEGER NOT NULL,
    read_at INTEGER
  );
  CREATE INDEX admin_alerts_time ON admin_alerts(created_at);
  CREATE INDEX admin_alerts_dedupe ON admin_alerts(dedupe_key, created_at);
  ALTER TABLE users ADD COLUMN upload_quota_mb INTEGER;
  `,
  // v6 — poll votes (encrypted with the chat key, like reactions)
  `
  CREATE TABLE poll_votes (
    message_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    nonce TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    signature TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id)
  );
  CREATE INDEX poll_votes_chat ON poll_votes(chat_id);
  `,
  // v7 — scheduled messages (already encrypted + signed by the sender) and encrypted per-user drafts
  `
  CREATE TABLE scheduled_messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    epoch INTEGER NOT NULL,
    client_msg_id TEXT NOT NULL,
    nonce TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    signature TEXT NOT NULL,
    send_at INTEGER NOT NULL,
    stale INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX scheduled_due ON scheduled_messages(send_at);
  CREATE INDEX scheduled_sender ON scheduled_messages(sender_id);
  CREATE TABLE drafts (
    user_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    nonce TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, chat_id)
  );
  `,
  // v8 — resumable chunked uploads of large (already encrypted) attachments
  `
  CREATE TABLE uploads (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    size INTEGER NOT NULL,
    received INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX uploads_owner ON uploads(owner_id);
  `,
  // v9 — append-only upload accounting (deleting a message must not refund the daily quota)
  `
  CREATE TABLE upload_usage (
    owner_id TEXT NOT NULL,
    bytes INTEGER NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX upload_usage_owner ON upload_usage(owner_id, at);
  INSERT INTO upload_usage(owner_id, bytes, at) SELECT owner_id, size, created_at FROM blobs WHERE created_at > (CAST(strftime('%s','now') AS INTEGER) * 1000 - 86400000);
  `,
  // v10 — block list, privacy settings, and a per-user encrypted vault (contact notes, saved messages, stickers)
  `
  CREATE TABLE blocks (
    user_id TEXT NOT NULL,
    blocked_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, blocked_id)
  );
  CREATE INDEX blocks_blocked ON blocks(blocked_id);
  ALTER TABLE users ADD COLUMN privacy TEXT;
  CREATE TABLE user_vault (
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    item_id TEXT NOT NULL,
    nonce TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, kind, item_id)
  );
  `,
  // v11 — two-step verification (TOTP) + one-time recovery codes
  `
  ALTER TABLE users ADD COLUMN totp_secret TEXT;
  ALTER TABLE users ADD COLUMN totp_pending TEXT;
  ALTER TABLE users ADD COLUMN totp_last_step INTEGER;
  CREATE TABLE totp_recovery (
    user_id TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    used_at INTEGER
  );
  CREATE INDEX totp_recovery_user ON totp_recovery(user_id);
  `,
  // v12 — group moderation: who may post, and per-member mute
  `
  ALTER TABLE chats ADD COLUMN post_policy TEXT NOT NULL DEFAULT 'all';
  ALTER TABLE chat_members ADD COLUMN muted_until INTEGER;
  `,
  // v13 — fast "messages in the current key epoch" count (periodic re-keying)
  `
  CREATE INDEX messages_chat_epoch ON messages(chat_id, epoch);
  `,
  // v14 — admin audit log and daily activity (who was active which day; no content, no IPs)
  `
  CREATE TABLE admin_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    admin_id TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    detail TEXT
  );
  CREATE INDEX admin_audit_at ON admin_audit(at);
  CREATE TABLE daily_activity (
    day TEXT NOT NULL,
    user_id TEXT NOT NULL,
    PRIMARY KEY (day, user_id)
  );
  CREATE INDEX messages_created ON messages(created_at);
  `,
  // v15 — per-member notification mute (push is skipped while it lasts); -1 = until turned back on
  `
  ALTER TABLE chat_members ADD COLUMN notify_off_until INTEGER;
  `,
  // v16 — passkeys (WebAuthn) as a second factor
  `
  CREATE TABLE webauthn_creds (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    public_key BLOB NOT NULL,
    counter INTEGER NOT NULL DEFAULT 0,
    transports TEXT,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );
  CREATE INDEX webauthn_user ON webauthn_creds(user_id);
  `,
  // v17 — self-service account deletion (the row stays as a tombstone so old messages still show a sender)
  `
  ALTER TABLE users ADD COLUMN deleted_at INTEGER;
  `,
  // v18 — end-to-end encrypted avatars: a user's avatar key travels per chat (encrypted with the chat key, signed);
  // a group's avatar key sits in the admin-signed group settings
  `
  ALTER TABLE users ADD COLUMN avatar_blob TEXT;
  ALTER TABLE users ADD COLUMN avatar_v INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE chats ADD COLUMN avatar_blob TEXT;
  CREATE TABLE avatar_keys (
    user_id TEXT NOT NULL,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    v INTEGER NOT NULL,
    epoch INTEGER NOT NULL,
    nonce TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    signature TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, chat_id)
  );
  CREATE INDEX avatar_keys_chat ON avatar_keys(chat_id);
  `,
  // v19 — when a session last proved the password (a device linked by QR never did)
  `
  ALTER TABLE sessions ADD COLUMN pw_at INTEGER;
  `,
  // v20 — anonymous front-end error reports for the admin page (no user id, no IP; grouped by signature)
  `
  CREATE TABLE client_errors (
    sig TEXT PRIMARY KEY,
    message TEXT NOT NULL,
    stack TEXT,
    path TEXT,
    version TEXT,
    browser TEXT,
    count INTEGER NOT NULL DEFAULT 1,
    first_at INTEGER NOT NULL,
    last_at INTEGER NOT NULL
  );
  CREATE INDEX client_errors_last ON client_errors(last_at);
  `,
  // v21 — secret chats: per-session devices with prekeys, and a store-and-forward queue (see secret.ts)
  `
  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE CASCADE,
    cert TEXT NOT NULL,
    spk_id INTEGER NOT NULL,
    spk_pk TEXT NOT NULL,
    spk_sig TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX devices_user ON devices(user_id);
  CREATE TABLE device_opks (
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    key_id INTEGER NOT NULL,
    pk TEXT NOT NULL,
    PRIMARY KEY (device_id, key_id)
  );
  CREATE TABLE secret_envelopes (
    id TEXT PRIMARY KEY,
    to_device TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    from_device TEXT NOT NULL,
    from_user TEXT NOT NULL,
    ct TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX secret_envelopes_to ON secret_envelopes(to_device, created_at);
  CREATE INDEX secret_envelopes_time ON secret_envelopes(created_at);
  `,
];

export function openDb(dataDir: string): DB {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new Database(path.join(dataDir, 'app.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db: DB) {
  const version = db.pragma('user_version', { simple: true }) as number;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  // per-install server secret (used for keyed hashes)
  if (!getSetting(db, 'server_secret')) setSetting(db, 'server_secret', crypto.randomBytes(32).toString('base64url'));
}

export function getSetting(db: DB, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(db: DB, key: string, value: string) {
  db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
