-- Polycarp Connect. Stores only what provisioning needs: tunnel id, hostname, a hash of the
-- device key, created and last-seen. No tunnel token, no IP address, no passcode.
CREATE TABLE devices (
	device_hash TEXT PRIMARY KEY,
	status TEXT NOT NULL CHECK (status IN ('pending', 'active')),
	hostname TEXT UNIQUE,
	tunnel_id TEXT,
	reserved_at INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	last_seen INTEGER NOT NULL,
	invite_id INTEGER
);
CREATE INDEX devices_status_seen ON devices (status, last_seen);
CREATE INDEX devices_reserved ON devices (reserved_at);

-- Single-use codes. Only the SHA-256 of a code is stored; the code is shown once at creation.
CREATE TABLE invites (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	code_hash TEXT NOT NULL UNIQUE,
	prefix TEXT NOT NULL,
	tier TEXT NOT NULL DEFAULT 'standard' CHECK (tier IN ('standard', 'reserve')),
	note TEXT,
	created_at INTEGER NOT NULL,
	used_at INTEGER,
	revoked_at INTEGER
);

-- Email is stored only when the person gives it. They can delete it with the token they were given.
CREATE TABLE waitlist (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	email TEXT NOT NULL UNIQUE,
	created_at INTEGER NOT NULL
);

CREATE TABLE nonces (
	nonce TEXT PRIMARY KEY,
	seen_at INTEGER NOT NULL
);

CREATE TABLE rate (
	key TEXT NOT NULL,
	win INTEGER NOT NULL,
	n INTEGER NOT NULL,
	exp INTEGER NOT NULL,
	PRIMARY KEY (key, win)
);

-- live: the tunnel count read from the Cloudflare API (value) and when (at). limit_hit: last API limit error.
CREATE TABLE meta (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL,
	at INTEGER NOT NULL
);
