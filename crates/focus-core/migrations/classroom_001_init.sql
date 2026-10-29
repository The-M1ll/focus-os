-- Hosted classes (this device is the local authority)
CREATE TABLE classes(
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  created_at         INTEGER NOT NULL,
  signing_pub        TEXT NOT NULL,
  key_id             TEXT NOT NULL,
  signing_key_sealed TEXT NOT NULL,          -- Argon2id + ChaCha20-Poly1305 blob (JSON)
  status             TEXT NOT NULL CHECK(status IN ('active','transferred')),
  unlock_failures    INTEGER NOT NULL DEFAULT 0,
  locked_until       INTEGER NOT NULL DEFAULT 0,
  current_revision   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE members(
  id           TEXT PRIMARY KEY,
  class_id     TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL CHECK(length(display_name) BETWEEN 1 AND 64),
  role         TEXT NOT NULL CHECK(role IN ('admin','member')),
  status       TEXT NOT NULL CHECK(status IN ('active','removed')),
  joined_at    INTEGER NOT NULL
);
-- Exactly one active primary administrator per class, enforced by the database.
CREATE UNIQUE INDEX one_active_admin ON members(class_id) WHERE role='admin' AND status='active';

CREATE TABLE devices(
  id             TEXT PRIMARY KEY,                -- key id of public_key
  member_id      TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  public_key     TEXT NOT NULL UNIQUE,
  status         TEXT NOT NULL CHECK(status IN ('active','revoked')),
  created_at     INTEGER NOT NULL,
  last_seen_at   INTEGER,
  acked_revision INTEGER NOT NULL DEFAULT 0,
  acked_at       INTEGER
);

CREATE TABLE pairing_sessions(
  id         TEXT PRIMARY KEY,
  class_id   TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  max_uses   INTEGER NOT NULL CHECK(max_uses BETWEEN 1 AND 500),
  uses       INTEGER NOT NULL DEFAULT 0,
  failures   INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL CHECK(status IN ('open','revoked'))
);

CREATE TABLE policy_revisions(
  class_id   TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  revision   INTEGER NOT NULL CHECK(revision >= 1),
  envelope   TEXT NOT NULL,
  signature  TEXT NOT NULL,
  key_id     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(class_id, revision)
);

-- Tamper-evident (hash-chained) administrative audit log.
CREATE TABLE audit_events(
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id  TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  ts        INTEGER NOT NULL,
  actor     TEXT NOT NULL,
  action    TEXT NOT NULL,
  detail    TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash      TEXT NOT NULL
);

-- Replay protection: request nonces are remembered until their timestamp window closes.
CREATE TABLE seen_nonces(
  nonce      TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX seen_nonces_exp ON seen_nonces(expires_at);

-- Classes this device has joined as a member (client side).
CREATE TABLE memberships(
  class_id       TEXT PRIMARY KEY,
  class_name     TEXT NOT NULL,
  class_pub      TEXT NOT NULL,                  -- pinned at pairing time
  key_id         TEXT NOT NULL,
  host_addrs     TEXT NOT NULL,                  -- JSON array of "ip:port"
  device_secret  TEXT NOT NULL,                  -- per-class device key (never shared)
  device_id      TEXT NOT NULL,
  member_id      TEXT NOT NULL,
  role           TEXT NOT NULL,
  joined_at      INTEGER NOT NULL,
  last_sync_at   INTEGER,
  last_revision  INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL CHECK(status IN ('active','removed'))
);

CREATE TABLE client_policies(
  class_id    TEXT NOT NULL REFERENCES memberships(class_id) ON DELETE CASCADE,
  revision    INTEGER NOT NULL,
  envelope    TEXT NOT NULL,
  signature   TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  PRIMARY KEY(class_id, revision)
);
