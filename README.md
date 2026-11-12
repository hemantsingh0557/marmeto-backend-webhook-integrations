# Marmeto – Backend Integrations Take-Home
### Resilient E-Commerce Webhook Ingestion & Courier Dispatch Service

This service bridges an e-commerce merchant store emitting `orders/create` webhooks with an unreliable, flaky third-party courier partner API.

---

## 1. Quick Start (Run in One Command)

This project has **zero external daemon dependencies** (no Redis or Docker required). Clone, install, and run:

```bash
# 1. Install dependencies
npm install

# 2. Start the mock courier partner (runs on port 3001)
npm run mock-courier &

# 3. Start the main webhook ingestion & background worker service (runs on port 3000)
npm start
```

### Running Automated Tests
```bash
npm test
```
The test suite automatically tests HMAC verification, two-tier idempotency, 429 rate limiting, 500 backoff, and the 10-second timeout hang recovery.

### Sending Sample Webhooks (Verification CLI)
We provide a standalone testing script that generates real cryptographic HMAC-SHA256 signatures and tests all ingestion scenarios:
```bash
npm run send-webhook
```
This script exercises:
1. Valid signed webhook $\rightarrow$ `202 Accepted`
2. Exact duplicate delivery ID $\rightarrow$ `200 OK (duplicate_ignored)`
3. Duplicate order ID with new delivery ID $\rightarrow$ `200 OK (order_already_exists)`
4. Tampered payload $\rightarrow$ `401 Unauthorized`

---

## 2. Architecture & Design Decisions

```
[Store Webhook] ──► POST /webhooks/orders-create
                          │
                          ├─► 1. Raw body capture & length-safe timingSafeEqual HMAC validation
                          ├─► 2. Atomic 3-in-1 Transaction (webhook_deliveries + orders + jobs)
                          ▼
                     HTTP 202 Accepted (< 25ms response latency)
                          │
                          ▼ (Asynchronous Outbox Queue in SQLite WAL Mode)
                     [Background Worker Poller] (500ms loop)
                          │
                          ├─► Step 1: Pre-flight lookup (GET /shipments?reference=<id>)
                          │           └─► Found? -> Mark confirmed immediately (avoids duplicate!)
                          │
                          ├─► Step 2: Flag post_outcome_unknown = 1 before dispatching POST
                          │
                          ├─► Step 3: POST /shipments with 3.5s timeout (aborts before 10s hang)
                          │           ├─► 201 Created -> Mark confirmed, clear flag
                          │           ├─► 429 Rate Limit -> Respect Retry-After header
                          │           ├─► 500 Error -> Exponential backoff with random jitter
                          │           └─► 3.5s Timeout Abort -> Immediate recovery GET lookup;
                          │               if not found, keep post_outcome_unknown=1 and retry GET only!
                          ▼
                     [Dead Letter Parking] (Jobs failing 5 times parked for inspection & replay)
```

### Core Design Decisions

1. **Raw Body Buffer Capture for HMAC Verification:**
   Standard body parsers (`express.json()`) parse JSON into JavaScript objects, discarding original whitespace, line breaks, and key ordering. Because HMAC-SHA256 is calculated over the raw byte sequence, we intercept the raw buffer in `express.json({ verify })` before JSON parsing.

2. **The `crypto.timingSafeEqual` RangeError Defense:**
   In Node.js, `crypto.timingSafeEqual(bufA, bufB)` throws an unhandled `RangeError` if the two buffers have different byte lengths. If a client sends an empty or truncated signature, a naive comparison crashes with an unhandled 500 error. We enforce a byte-length equality pre-check to guarantee clean `401 Unauthorized` responses.

3. **Two-Tier Idempotency Model:**
   - **Tier 1 (`webhook_deliveries`):** Deduplicates identical `X-Shop-Webhook-Id` network retries from the merchant platform.
   - **Tier 2 (`orders`):** Deduplicates domain entities by `order_id` in cases where multiple webhook topics or manual merchant resends deliver the same order under different delivery IDs.

4. **Atomic Ingestion Transaction (No Lost Orders on Crash):**
   Inserting into `webhook_deliveries`, `orders`, and `jobs` occurs inside a **single SQLite transaction** (`BEGIN IMMEDIATE`). If the process crashes mid-ingestion, everything rolls back atomically. An order cannot exist without its background job, and a delivery is never acknowledged without recording the order.

5. **Neutralizing the Courier 10-Second Timeout Trap:**
   The mock courier creates the shipment *before* hanging for 10 seconds.
   - We set client timeout to **3.5 seconds** via `AbortSignal.timeout(3500)`.
   - Before calling `POST`, the worker sets `post_outcome_unknown = 1` in the database.
   - If the request times out, the flag remains `1`, and the worker executes an immediate recovery `GET /shipments?reference=<orderId>`.
   - On all subsequent retries where `post_outcome_unknown === 1`, the worker enters **Lookup-Only Mode** and **NEVER calls `POST` again**. This guarantees zero duplicate shipments on non-idempotent courier endpoints.

6. **Stale Lease Reaper for Crash on Attempt 5:**
   If a worker process crashes on its 5th attempt after incrementing the attempt counter, the standard atomic claim query (`WHERE attempts < max_attempts`) would permanently ignore the expired lease. Our poller includes a reaper sweep that moves expired jobs with `attempts >= 5` directly to `dead_letter` and marks orders as `failed`.

---

## 3. Queue Trade-Off Analysis

The prompt permits choosing between an in-process queue, a DB-backed queue, or BullMQ/Redis:

| Criterion | SQLite DB-Backed Queue (Chosen) | BullMQ + Redis | In-Process Memory Queue |
|---|---|---|---|
| **Evaluator Setup Friction** | **Zero** (`npm install && npm start` runs immediately; no Docker or Redis daemon). | **High** (Evaluator must have Redis running locally or via Docker). | **Zero** (In-memory event loop). |
| **Dual-Write Vulnerability** | **None** (Order and Job are written in the **exact same SQLite ACID transaction**). | **Present** (Writing to DB and Redis are separate network calls; failure in between desynchronizes state). | **Severe** (Writing to DB and memory queue can desync). |
| **Crash Resilience** | **Full** (Pending jobs and leases are persisted to disk in WAL mode). | **Full** (Redis AOF/RDB persistence). | **Zero** (Process crash or restart wipes all pending in-flight jobs). |
| **Horizontal Scalability** | Suitable for single/paired instances via SQLite atomic leases. | **High** (Distributed worker clusters across multiple nodes). | **None** (Tied strictly to single process memory). |

**Take-Home Rationale:** For a take-home assignment, eliminating reviewer friction while guaranteeing single-transaction ACID consistency between the order and the queue makes SQLite with WAL mode the most pragmatic, resilient choice. In high-throughput multi-server production, we would graduate the worker layer to BullMQ + Redis using the Outbox pattern.

---

## 4. Maintenance & Operations

### Reconciliation Routine (`npm run reconcile`)
Scans orders in unconfirmed or unknown states and queries the courier API directly:
```bash
npm run reconcile
```
If the shipment was created upstream, it updates local state to `confirmed` without duplicate dispatch. If not found, it re-queues the order safely.

### Dead Letter Queue (DLQ) Replay CLI (`npm run replay`)
Inspects parked jobs that exceeded the maximum 5 retry attempts:
```bash
# View all failed / dead-lettered orders
node scripts/replay-failed.js

# Replay a specific failed order
node scripts/replay-failed.js <orderId>

# Replay all failed orders
node scripts/replay-failed.js --all
```
Before resetting, the script runs a pre-flight lookup against the courier. If already created, it confirms the order immediately; otherwise, it resets attempts to 0 and re-enqueues for processing.

---

## 5. What Was Deliberately Left Out

In accordance with senior engineering judgment and the prompt's instruction (*"Less code that's correct beats more code"*), the following were deliberately omitted:

1. **Frontend / Admin UI:** All operational inspection is handled directly via CLI scripts (`reconcile.js`, `replay-failed.js`) and database inspection.
2. **Multi-Tenant Shop Authorization:** Assumes a single merchant store connection (`WEBHOOK_SECRET`) rather than a multi-tenant OAuth token management database.
3. **Webhook Replay Window Timestamp Checks:** Shopify webhooks do not enforce a signed timestamp header by default. Replay protection is enforced via `X-Shop-Webhook-Id` and `order_id` uniqueness.
4. **Distributed Locks (Redlock):** Single-node SQLite atomic transactions (`PRAGMA busy_timeout = 5000` with `BEGIN IMMEDIATE`) provide guaranteed serializability without the complexity of distributed consensus protocols.
5. **Shopify API coverage beyond `orders/create`:** The service is strictly scoped to order ingestion and fulfillment dispatch.

---

## 6. What We Would Do Next with Another Day

If extending this into a multi-region production service with additional time:
1. **Prometheus / OpenTelemetry Instrumentation:** Export queue latency, retry counts, 429 backoff durations, and courier latency histograms.
2. **PostgreSQL Migration:** Use PostgreSQL with row-level locking (`SELECT ... FOR UPDATE SKIP LOCKED`) or migrate queue dispatching to BullMQ.
3. **Dead Letter Webhook Notification:** Post an alert to a Slack webhook or OpsGenie when an order exhausts retries and enters `dead_letter`.
4. **Mutual TLS (mTLS):** Configure client certificates for enterprise courier partners requiring dedicated tunnel security.
