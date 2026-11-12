/**
 * DDL Schema for SQLite Database
 * Configured for WAL mode, high-concurrency read/write separation, and transactional outbox.
 */
export const schemaDDL = `
-- Tier 1 Idempotency: Webhook delivery log (catches store-level retries)
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  webhook_id   TEXT PRIMARY KEY,
  order_id     TEXT NOT NULL,
  received_at  INTEGER NOT NULL
);

-- Tier 2 Idempotency: Order business entity state (catches duplicate order topics)
CREATE TABLE IF NOT EXISTS orders (
  order_id         TEXT PRIMARY KEY,
  reference        TEXT UNIQUE NOT NULL,
  shipping_address TEXT NOT NULL,
  line_items       TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending', -- pending | confirmed | failed
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

-- Confirmed Courier Shipments
CREATE TABLE IF NOT EXISTS shipments (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id             TEXT UNIQUE NOT NULL,
  courier_shipment_id  TEXT NOT NULL,
  reference            TEXT NOT NULL,
  confirmed_at         INTEGER NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(order_id)
);

-- Persistent Transactional Job Queue
CREATE TABLE IF NOT EXISTS jobs (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id              TEXT UNIQUE NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending', -- pending | processing | retry_wait | unknown | completed | dead_letter
  attempts              INTEGER NOT NULL DEFAULT 0,
  max_attempts          INTEGER NOT NULL DEFAULT 5,
  next_run_at           INTEGER NOT NULL,
  lease_token           TEXT,
  lease_until           INTEGER,
  post_outcome_unknown  INTEGER NOT NULL DEFAULT 0,      -- 1 = Lookup-only mode; NEVER re-POST!
  last_error            TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(order_id)
);

-- Performance Indexes
CREATE INDEX IF NOT EXISTS idx_jobs_poll ON jobs (status, next_run_at, attempts);
CREATE INDEX IF NOT EXISTS idx_jobs_reap ON jobs (status, lease_until, attempts);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status);
`;
