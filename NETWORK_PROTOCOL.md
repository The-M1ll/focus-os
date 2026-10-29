# FOCUS OS classroom protocol — version 1

This documents what is **actually implemented** in `crates/focus-core` (`protocol.rs`, `host.rs`, `server.rs`,
`sync.rs`). It is written so that an independent implementation can interoperate: `tests-e2e/native.e2e.mjs`
contains one, written in ~60 lines of Node from this document alone, and it joins a real host, verifies the
host's proofs and verifies Rust-made Ed25519 signatures.

No part of the protocol needs the internet, an account, a domain, a public IP or a cloud service.

## 1. Topology

```
 teacher's computer (host)                      student's computer (member)
 ┌──────────────────────────────┐   LAN        ┌──────────────────────────────┐
 │ HostService (authority)       │◀────────────│ ClassSync (client)           │
 │ HTTP + WebSocket on ONE       │  HTTP / WS   │ pinned class public key      │
 │ chosen private IPv4 address   │             │ per-class device key          │
 │ SQLite (classroom.db)         │             │ SQLite (classroom.db)         │
 └──────────────────────────────┘             └──────────────────────────────┘
```

* The host binds **one interface address** chosen by the administrator from the machine's own non-loopback,
  non-link-local IPv4 addresses (private ranges listed first). It never binds `0.0.0.0` and never loopback.
* Port: first free port in `47800–47899`, otherwise an OS-assigned port.
* IPv6 is **not** supported in v1.
* Transport is plain HTTP/1.1 and WebSocket over TCP. There is **no TLS** (see §9 and `SECURITY.md`).
  Authenticity and integrity come from Ed25519 signatures and HMAC proofs, not from the channel.

## 2. Identities and keys

| Name | What it is | Lives where |
|---|---|---|
| **class key** | Ed25519 key pair; the public half is the class's root of trust. Signs every policy. | Host: private half sealed in `classes.signing_key_sealed` (Argon2id + ChaCha20-Poly1305, passphrase). Members: public half pinned at join. |
| **device key** | Ed25519 key pair generated per device **per class**. Signs every request. | Device's `memberships.device_secret`. Public half registered on the host. |
| **pairing secret** | 128 random bits, one per invite. Proves possession of the invite. | In the join code and in the host's *memory* only (never in the database, never on the wire). |
| **administrator passphrase** | Unlocks the class key on the host after a restart. | Never stored. |
| **key id** | `hex(SHA-256(raw 32-byte public key))[..16 bytes]` → 32 hex chars. Device id = device key id. | derived |

All binary values are **base64url without padding**.

## 3. Roles and invariants

* Roles: `admin`, `member`. There is no teacher/guardian role in v1.
* **Exactly one active admin per class.** Enforced by a partial unique index in SQLite
  (`one_active_admin ON members(class_id) WHERE role='admin' AND status='active'`) *and* in the service layer.
* Removing a member sets `members.status='removed'` and revokes all of their devices. The admin cannot be
  removed; administration must be transferred (§8).

## 4. Pairing (joining a class)

### 4.1 Join code (QR / paste)

`focusos://join/` + base64url(JSON):

```json
{ "v": 1, "class_id": "…32 hex…", "class_name": "…", "class_pub": "<b64url Ed25519 public key>",
  "pairing_id": "…32 hex…", "token": "<b64url 16 bytes>", "addrs": ["192.168.1.20:47800"], "expires_at": 1767225600000 }
```

* The administrator creates an invite: lifetime **1 ms … 15 min** (UI offers 5/10/15), **1…500 uses**.
* The code is the only channel for the secret. Join codes are limited to 4096 characters when parsed.

### 4.2 `POST /v1/join` (unauthenticated, proof-bearing)

Request body (≤ 16 KiB):

```json
{ "pairing_id": "…", "device_pub": "<b64url>", "display_name": "Aziza", "ts": 1767225000000,
  "nonce": "<≤64 chars>", "proof": "<b64url>", "device_sig": "<b64url>" }
```

```
join_message = "focus-join-v1\n" + class_id + "\n" + pairing_id + "\n" + device_pub + "\n"
             + display_name + "\n" + ts + "\n" + nonce
proof        = base64url( HMAC-SHA256(key = token bytes, join_message) )
device_sig   = base64url( Ed25519.sign(device_secret, join_message) )     // proof of key possession
```

Host checks, in this order, all returning the same generic `403 pairing` for pairing problems:

1. Per-IP rate limit: 20 joins/min.
2. Display name: 1–64 printable characters.
3. `|now − ts| ≤ 5 min`.
4. Pairing exists in host **memory**, is `open`, unexpired, `uses < max_uses`, `failures < 5`.
5. `proof` equals the expected HMAC (constant-time). A wrong proof increments `failures`; **5 failures burn the invite**.
6. `device_sig` verifies under `device_pub`.
7. In one transaction: nonce not seen (`seen_nonces`), `uses` incremented only if still `< max_uses` (so concurrent
   joins cannot exceed the limit), member + device inserted, audit event written. A device key that is already
   enrolled is refused.

Response `200`:

```json
{ "class_id": "…", "class_name": "…", "class_pub": "…", "member_id": "…", "device_id": "…",
  "role": "member", "policy": { …SignedPolicy… } | null,
  "host_proof": "<b64url>" }
host_proof = base64url( HMAC-SHA256(token, "focus-host-v1\n" + class_id + "\n" + device_pub + "\n" + nonce + "\n" + member_id) )
```

The client **must** verify, before storing anything: `class_id` and `class_pub` equal the join code's;
`host_proof` is correct (the host knew the secret); and, if a policy is included, its signature (§6).
Only then are the membership, the device key and the policy persisted in one transaction.

Devices on the same Wi-Fi are therefore **not** trusted by default: without the invite secret a `join` cannot succeed,
and a class id alone authorises nothing.

## 5. Authenticated requests

Every non-join request carries five headers:

| Header | Value |
|---|---|
| `x-focus-device` | device id (key id) |
| `x-focus-class` | class id |
| `x-focus-ts` | Unix ms |
| `x-focus-nonce` | random, ≤ 64 chars, unique per request |
| `x-focus-sig` | `base64url(Ed25519.sign(device_secret, request_message))` |

```
request_message = "focus-req-v1\n" + class_id + "\n" + METHOD + "\n" + path_and_query + "\n"
                + ts + "\n" + nonce + "\n" + hex(SHA-256(body))
```

Host verification order: class matches → `|now − ts| ≤ 120 s` → nonce well-formed → per-device rate limit
(600/min) → device is `active` and its member is `active` → signature → **then** the nonce `(device:nonce)` is
recorded (so unauthenticated callers cannot fill the nonce table) and a repeated nonce is refused as a replay.
Nonces are kept for `2 × 120 s` in SQLite, so replay protection survives a host restart.
`last_seen_at` is updated on success.

## 6. Policy

A policy is a signed envelope. The signature is over the **exact bytes** of the `envelope` string, so there is no
canonicalisation ambiguity.

```json
SignedPolicy = { "envelope": "<JSON text>", "signature": "<b64url>", "key_id": "<class key id>" }

envelope = { "class_id": "…", "schema_version": 1, "revision": 3, "issued_at": 1767225000000,
             "publisher_key_id": "<class key id>", "min_client_version": 1,
             "payload": { "limits": [LimitRule…], "study_goals": [StudyGoal…],
                          "allow_personal_limits": true, "progress_sharing": "none" } }

LimitRule  = { "platform": "instagram", "blocked": false, "daily_minutes": 30 | null,
               "allowed_windows": [ { "days": [1,2,3,4,5], "start_min": 960, "end_min": 1200 } ] }
StudyGoal  = { "id": "…", "title": "Read 30 pages", "target_minutes_per_week": 180 }
```

Semantics (identical in every client): `blocked` = never available (cannot be combined with a budget or windows);
`allowed_windows` = when the platform is available at all (empty = always; `days` 0 = Sunday, empty = every day);
`daily_minutes` = budget inside the available time (`null` = none).

Validation (host before signing, client before applying): ≤ 64 rules, ≤ 32 goals, platform ids
`[a-z0-9.-]{1,64}` and unique, `daily_minutes ≤ 1440`, windows `start < end ≤ 1440`, goals ≤ 120 chars and ≤ one
week. Unknown fields are **rejected** (`deny_unknown_fields`). The envelope is ≤ 32 KiB.

**Desktop-app rules** use the same `LimitRule` with a platform id of the form `app.<slug>` (slug = the app's
process or display name, lower-cased, runs of non-alphanumerics replaced by `-`, e.g. `app.minecraft-launcher`).
This is a convention inside protocol v1, not a schema change: older clients accept the policy and simply have no
website named `app.<slug>`. Receiving clients decide locally what, if anything, matches; the protocol carries no
command, path or argument.

Client verification order (`policy::verify` then `client::apply_policy`): size → `key_id` equals the pinned
key's id → signature over the exact bytes → schema version supported (otherwise the distinct error
*unsupported schema*, nothing stored) → strict parse → `class_id` matches → `publisher_key_id` consistent →
payload valid → inside one transaction compare `revision` with the stored one:

* `revision == stored` → **duplicate**, no change;
* `revision < stored` → **stale**, rejected, nothing overwritten;
* `revision > stored` → stored atomically together with `last_revision` / `last_sync_at`.

Revisions are strictly increasing per class. Publishing an unchanged payload does **not** consume a revision.

Supported schema versions: `[1]`. A newer host's policy is reported as "update FOCUS OS" and the previous policy stays in force.

## 7. Endpoints

| Method & path | Auth | Purpose |
|---|---|---|
| `GET /v1/hello` | none | `{class_id, class_name, key_id, protocol, schemas}` |
| `POST /v1/join` | proof (§4) | enrol a device |
| `GET /v1/policy` | device | `{role, policy}` — the authoritative current policy (used after any gap) |
| `POST /v1/ack` | device | `{revision}` — "I applied this revision"; must not exceed the host's current revision |
| `GET /v1/live` | device (on the upgrade request) | WebSocket, below |
| `GET /v1/admin/members` | admin device | roster with online state, last seen, acknowledged revision |
| `POST /v1/admin/policy` | admin device | `{payload}` → publishes a new revision |
| `POST /v1/admin/remove/{member_id}` | admin device | removes a member |

Errors: `{ "error": "<message>", "code": "<code>" }` with HTTP `400 invalid`, `403 forbidden|pairing|integrity`,
`404 not_found`, `409 stale`, `422 unsupported_schema`, `429 rate_limited`, `503 locked`, `413` (body > 16 KiB,
from the framework). Internal errors are logged, never echoed. A request may only act with the authority of the
**device that signed it**; role claims in bodies are ignored (the role comes from the database).

### WebSocket `/v1/live`

* Authenticated on the upgrade request with the same five headers (`GET /v1/live`). Max **256** concurrent
  connections; max message **64 KiB**; binary frames and malformed JSON close the connection.
* Server → client (`{"type": …}`): `policy` (`{policy: SignedPolicy}`), `revoked`, `ping`.
* Client → server: `ack` (`{revision}`), `pong`.
* On connect the host sends the **current** policy immediately (it subscribes to publications *before* reading the
  current policy, so nothing falls in the gap). If a connection falls behind the broadcast buffer the host
  re-sends the latest policy. A client never assumes it saw every intermediate revision.
* Host pings every 20 s and drops a connection that has been silent for 70 s; the client drops a host silent for 60 s.
* Removing a member sends `revoked` to that device's connections and closes them.

### Client state machine (`sync.rs`)

`idle → connecting → live`; `offline{reason}` when the host cannot be reached (reconnect with exponential
backoff 0.5 s → 30 s); `removed`; `rejected{reason}` (invalid/unsupported policy; retries every 30 s). `live` is
reported **only while a WebSocket is open**. `last_sync_at` is the time a policy was last *applied or
re-confirmed*. After 3 consecutive failures (at most once a minute) the client runs an mDNS lookup for its class id
and, if the host's address changed, updates its stored address and retries at once.

## 8. Administrator credential, transfer and recovery

* **Unlock**: the class key is sealed with Argon2id (m = 64 MiB, t = 3, p = 1; decryption refuses parameters above
  256 MiB / t 10 / p 4) and ChaCha20-Poly1305 with the class id as associated data. After 3 failed unlocks the host
  enforces a persisted lockout of 5 s, 10 s, 20 s … capped at 15 min.
* **Rotate**: changing the passphrase re-seals the same key.
* **Recovery bundle** (`.fosrecovery`): JSON `{format:"focus-recovery-v1", class_id, sealed:{…}}` where `sealed`
  is the same Argon2id/ChaCha20-Poly1305 construction (AAD `focus-bundle-v1:<class_id>`) over: class key, members,
  device public keys, all policy revisions. Whoever has the file **and** its passphrase can administer the class.
* **Transfer** (`begin_transfer`): writes the bundle, then marks the class `transferred` on the old host, wipes the
  key from memory and refuses to host or publish again. The new administrator runs *restore (transfer)*: the old
  admin becomes an ordinary member; one transaction keeps the single-admin invariant.
* **Recovery** (lost host): *restore (recovery)* revokes the old admin's devices and installs a new admin.
* Members keep their identities and the same class key. They must learn the new host's address (automatic mDNS
  re-discovery, or *Change host address*). **If the host is lost and no bundle exists, the class cannot be recovered.**

## 9. Discovery

mDNS/DNS-SD service `_focusos._tcp.local.`, instance `focus-<first 12 chars of class id>`, TXT `cid=<class id>`,
`v=1`. Only the class id is advertised (not the class name or any member). Discovery supplies **addresses only**;
everything after it is authenticated as above. Many networks block multicast, so the join code always carries the
address and manual entry (`ip:port`) is always available.

## 10. Audit log

`audit_events(id, class_id, ts, actor, action, detail, prev_hash, hash)` where
`hash = SHA-256(prev_hash | ts | actor | action | detail)` and the first `prev_hash` is `genesis`. Edits to an
earlier row break the chain (`verify_audit_chain`). Logged: class created, unlock / failed unlock, passphrase
change, invite created/revoked, member joined/removed, policy published, bundle exported, handover/restore.

## 11. What the protocol deliberately does not carry

Notes, flashcards, tasks, focus sessions, measured or self-reported usage. The only member→host information is the
display name chosen at join, online state, `last_seen_at` and the acknowledged revision. `progress_sharing` exists in
the schema with the single value `none` so that any future sharing must be an explicit, versioned, consented change.

## 12. Known protocol limitations

* **No transport encryption.** An observer on the same network can read policies (non-secret) and request metadata
  and can see (but, thanks to nonces and signatures, not reuse) signed requests. A rogue advertiser of the same class
  id can receive one signed request that could be replayed to the real host within the 120 s window.
  A pinned-certificate TLS layer is the planned fix.
* IPv4 only. Dynamic-address changes are handled by mDNS re-discovery or manual entry.
* The host must be on and reachable for any change to propagate. There is no relay, no store-and-forward.
* Client clocks must agree with the host within 2 minutes (5 for joining); otherwise requests are refused with a clear message.
