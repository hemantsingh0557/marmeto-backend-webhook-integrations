import {
  CourierRateLimitError,
  CourierServerError,
  CourierTimeoutError
} from '../services/courierClient.js';

/**
 * Calculates exponential backoff with random jitter:
 * 1s, 2s, 4s, 8s, 16s... capped at 30s
 */
function calculateBackoffMs(attempts) {
  const base = Math.min(1000 * Math.pow(2, Math.max(0, attempts - 1)), 30000);
  const jitter = Math.floor(Math.random() * 500);
  return base + jitter;
}

/**
 * Core business processor for background shipment jobs.
 * Enforces pre-flight lookup, uncertain outcome protection, and transactional state transitions.
 */
export async function processJob(job, db, courierClient) {
  const now = Date.now();
  const orderId = job.order_id;
  const leaseToken = job.lease_token;

  // Retrieve order details
  const order = db.prepare('SELECT * FROM orders WHERE order_id = ?').get(orderId);
  if (!order) {
    // Orphan job; park immediately
    db.prepare(`
      UPDATE jobs SET status = 'dead_letter', lease_token = NULL, last_error = 'Order record not found'
      WHERE id = ? AND lease_token = ?
    `).run(job.id, leaseToken);
    return;
  }

  const reference = order.reference || order.order_id;
  const address = JSON.parse(order.shipping_address || '{}');
  const items = JSON.parse(order.line_items || '[]');

  // If order is already confirmed, mark job complete and exit
  if (order.status === 'confirmed') {
    db.prepare(`
      UPDATE jobs SET status = 'completed', post_outcome_unknown = 0, lease_token = NULL, updated_at = ?
      WHERE id = ? AND lease_token = ?
    `).run(now, job.id, leaseToken);
    return;
  }

  // --------------------------------------------------------------------------
  // CASE A: Lookup-Only Mode (Active when outcome was uncertain OR on retries)
  // --------------------------------------------------------------------------
  if (job.post_outcome_unknown === 1 || job.attempts >= 2) {
    try {
      const existingShipments = await courierClient.getShipmentsByReference(reference);

      if (existingShipments && existingShipments.length > 0) {
        const confirmedShipment = existingShipments[0];

        // Atomically confirm order and save shipment
        db.transaction(() => {
          db.prepare(`
            INSERT OR IGNORE INTO shipments (order_id, courier_shipment_id, reference, confirmed_at)
            VALUES (?, ?, ?, ?)
          `).run(orderId, confirmedShipment.shipmentId, reference, Date.now());

          db.prepare(`
            UPDATE orders SET status = 'confirmed', updated_at = ? WHERE order_id = ?
          `).run(Date.now(), orderId);

          db.prepare(`
            UPDATE jobs SET status = 'completed', post_outcome_unknown = 0, lease_token = NULL, updated_at = ?
            WHERE id = ? AND lease_token = ?
          `).run(Date.now(), job.id, leaseToken);
        })();

        return; // Successfully confirmed via lookup!
      }

      // If outcome was uncertain and GET returned empty, the courier may still be creating it.
      // NEVER POST again automatically when post_outcome_unknown === 1!
      if (job.post_outcome_unknown === 1) {
        if (job.attempts >= job.max_attempts) {
          // Terminal failure: Park in DLQ for manual inspection
          db.transaction(() => {
            db.prepare(`
              UPDATE jobs SET status = 'dead_letter', lease_token = NULL, last_error = 'Max attempts reached with uncertain POST outcome'
              WHERE id = ? AND lease_token = ?
            `).run(job.id, leaseToken);

            db.prepare(`UPDATE orders SET status = 'failed', updated_at = ? WHERE order_id = ?`).run(Date.now(), orderId);
          })();
          return;
        }

        // Schedule next lookup retry
        const delay = calculateBackoffMs(job.attempts);
        db.prepare(`
          UPDATE jobs
          SET status = 'unknown', next_run_at = ?, lease_token = NULL, updated_at = ?,
              last_error = 'POST timed out; waiting for shipment to appear on courier GET'
          WHERE id = ? AND lease_token = ?
        `).run(Date.now() + delay, Date.now(), job.id, leaseToken);
        return;
      }
    } catch (err) {
      // GET lookup failed (network or 5xx)
      const delay = err instanceof CourierRateLimitError ? err.retryAfterMs : calculateBackoffMs(job.attempts);

      if (job.attempts >= job.max_attempts) {
        db.transaction(() => {
          db.prepare(`
            UPDATE jobs SET status = 'dead_letter', lease_token = NULL, last_error = ?
            WHERE id = ? AND lease_token = ?
          `).run(`Pre-flight lookup failed: ${err.message}`, job.id, leaseToken);

          db.prepare(`UPDATE orders SET status = 'failed', updated_at = ? WHERE order_id = ?`).run(Date.now(), orderId);
        })();
        return;
      }

      db.prepare(`
        UPDATE jobs
        SET status = 'retry_wait', next_run_at = ?, lease_token = NULL, updated_at = ?,
            last_error = ?
        WHERE id = ? AND lease_token = ?
      `).run(Date.now() + delay, Date.now(), `Pre-flight lookup error: ${err.message}`, job.id, leaseToken);
      return;
    }
  }

  // --------------------------------------------------------------------------
  // CASE B: Dispatch Courier Creation (POST /shipments)
  // --------------------------------------------------------------------------
  // Set post_outcome_unknown = 1 BEFORE sending request to protect against phantom timeouts
  db.prepare(`
    UPDATE jobs SET post_outcome_unknown = 1, updated_at = ?
    WHERE id = ? AND lease_token = ?
  `).run(Date.now(), job.id, leaseToken);

  try {
    const result = await courierClient.createShipment({ reference, address, items });

    // Success (201 Created): Persist shipment and confirm
    db.transaction(() => {
      db.prepare(`
        INSERT OR IGNORE INTO shipments (order_id, courier_shipment_id, reference, confirmed_at)
        VALUES (?, ?, ?, ?)
      `).run(orderId, result.shipmentId, reference, Date.now());

      db.prepare(`
        UPDATE orders SET status = 'confirmed', updated_at = ? WHERE order_id = ?
      `).run(Date.now(), orderId);

      db.prepare(`
        UPDATE jobs SET status = 'completed', post_outcome_unknown = 0, lease_token = NULL, updated_at = ?
        WHERE id = ? AND lease_token = ?
      `).run(Date.now(), job.id, leaseToken);
    })();
  } catch (err) {
    const isRateLimit = err instanceof CourierRateLimitError;
    const isServerError = err instanceof CourierServerError;
    const isTimeout = err instanceof CourierTimeoutError;

    if (isTimeout) {
      // ----------------------------------------------------------------------
      // COURIER TIMEOUT TRAP MITIGATION:
      // The courier may have created the shipment before hanging for 10s!
      // Attempt immediate recovery GET before rescheduling.
      // ----------------------------------------------------------------------
      try {
        const recoveryShipments = await courierClient.getShipmentsByReference(reference);
        if (recoveryShipments && recoveryShipments.length > 0) {
          const recovered = recoveryShipments[0];
          db.transaction(() => {
            db.prepare(`
              INSERT OR IGNORE INTO shipments (order_id, courier_shipment_id, reference, confirmed_at)
              VALUES (?, ?, ?, ?)
            `).run(orderId, recovered.shipmentId, reference, Date.now());

            db.prepare(`UPDATE orders SET status = 'confirmed', updated_at = ? WHERE order_id = ?`).run(Date.now(), orderId);
            db.prepare(`
              UPDATE jobs SET status = 'completed', post_outcome_unknown = 0, lease_token = NULL, updated_at = ?
              WHERE id = ? AND lease_token = ?
            `).run(Date.now(), job.id, leaseToken);
          })();
          return; // Recovered immediately!
        }
      } catch (recoveryErr) {
        // Recovery GET failed; proceed with scheduled lookup retry
      }

      // Keep post_outcome_unknown = 1; release lease and schedule lookup retry
      const delay = calculateBackoffMs(job.attempts);
      if (job.attempts >= job.max_attempts) {
        db.transaction(() => {
          db.prepare(`
            UPDATE jobs SET status = 'dead_letter', lease_token = NULL, last_error = 'Courier POST timed out and max attempts reached'
            WHERE id = ? AND lease_token = ?
          `).run(job.id, leaseToken);
          db.prepare(`UPDATE orders SET status = 'failed', updated_at = ? WHERE order_id = ?`).run(Date.now(), orderId);
        })();
        return;
      }

      db.prepare(`
        UPDATE jobs
        SET status = 'unknown', next_run_at = ?, lease_token = NULL, updated_at = ?,
            last_error = 'Courier POST timed out; outcome uncertain'
        WHERE id = ? AND lease_token = ?
      `).run(Date.now() + delay, Date.now(), job.id, leaseToken);
      return;
    }

    // 429 Rate Limit or 5xx Server Error:
    // Safe to clear post_outcome_unknown = 0 because the courier explicitly rejected before creation
    const delay = isRateLimit ? err.retryAfterMs : calculateBackoffMs(job.attempts);

    if (job.attempts >= job.max_attempts) {
      db.transaction(() => {
        db.prepare(`
          UPDATE jobs SET status = 'dead_letter', post_outcome_unknown = 0, lease_token = NULL, last_error = ?
          WHERE id = ? AND lease_token = ?
        `).run(err.message, job.id, leaseToken);

        db.prepare(`UPDATE orders SET status = 'failed', updated_at = ? WHERE order_id = ?`).run(Date.now(), orderId);
      })();
      return;
    }

    db.prepare(`
      UPDATE jobs
      SET status = 'retry_wait', post_outcome_unknown = 0, next_run_at = ?, lease_token = NULL,
          updated_at = ?, last_error = ?
      WHERE id = ? AND lease_token = ?
    `).run(Date.now() + delay, Date.now(), err.message, job.id, leaseToken);
  }
}
