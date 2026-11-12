import { getDb, closeDb } from '../src/db/database.js';
import { CourierClient } from '../src/services/courierClient.js';

/**
 * Reconciliation Routine
 * Finds all orders without a confirmed shipment and queries courier GET /shipments?reference=<orderId>.
 * Safely resolves unconfirmed orders without creating duplicate shipments.
 */
export async function reconcileUnconfirmedOrders(dbInstance = null, clientInstance = null, options = {}) {
  const db = dbInstance || getDb();
  const courierClient = clientInstance || new CourierClient();
  const minAgeMs = options.minAgeMs !== undefined
    ? options.minAgeMs
    : (process.env.NODE_ENV === 'test' ? 0 : 120000);

  console.log('[Reconcile] Starting reconciliation scan for unconfirmed orders...');

  // Query orders that do not have a confirmed shipment and meet age threshold
  const candidateOrders = db.prepare(`
    SELECT o.order_id, o.reference, o.status, j.attempts, j.post_outcome_unknown
    FROM orders o
    LEFT JOIN shipments s ON o.order_id = s.order_id
    LEFT JOIN jobs j ON o.order_id = j.order_id
    WHERE s.courier_shipment_id IS NULL
      AND o.created_at <= (? - ?)
    ORDER BY o.created_at ASC
  `).all(Date.now(), minAgeMs);

  console.log(`[Reconcile] Found ${candidateOrders.length} unconfirmed order(s).`);

  let reconciledCount = 0;
  let requeuedCount = 0;

  for (const order of candidateOrders) {
    const reference = order.reference || order.order_id;
    try {
      // Query courier directly to verify actual downstream state
      const shipments = await courierClient.getShipmentsByReference(reference);

      if (shipments && shipments.length > 0) {
        // Shipment WAS created by courier (e.g. during a 10s timeout hang)
        const confirmed = shipments[0];

        db.transaction(() => {
          db.prepare(`
            INSERT OR IGNORE INTO shipments (order_id, courier_shipment_id, reference, confirmed_at)
            VALUES (?, ?, ?, ?)
          `).run(order.order_id, confirmed.shipmentId, reference, Date.now());

          db.prepare(`
            UPDATE orders SET status = 'confirmed', updated_at = ? WHERE order_id = ?
          `).run(Date.now(), order.order_id);

          db.prepare(`
            UPDATE jobs
            SET status = 'completed', post_outcome_unknown = 0, lease_token = NULL, updated_at = ?
            WHERE order_id = ?
          `).run(Date.now(), order.order_id);
        })();

        console.log(`[Reconcile] SUCCESS: Order ${order.order_id} reconciled! Found courier shipment ${confirmed.shipmentId}`);
        reconciledCount++;
      } else {
        // Shipment does not exist on courier
        if (order.status !== 'failed') {
          // Re-queue for standard worker pickup (only if lease expired or not leased)
          db.prepare(`
            UPDATE jobs
            SET status = 'pending', next_run_at = ?, lease_token = NULL, post_outcome_unknown = 0, updated_at = ?
            WHERE order_id = ? AND (lease_until < ? OR lease_token IS NULL)
          `).run(Date.now(), Date.now(), order.order_id, Date.now());

          console.log(`[Reconcile] RE-QUEUED: Order ${order.order_id} not found on courier; reset to pending.`);
          requeuedCount++;
        } else {
          console.log(`[Reconcile] SKIPPED: Order ${order.order_id} is in failed/DLQ state. Use replay-failed.js to reset.`);
        }
      }
    } catch (err) {
      console.error(`[Reconcile] Error checking order ${order.order_id}:`, err.message);
    }
  }

  console.log(`[Reconcile] Completed. ${reconciledCount} order(s) reconciled, ${requeuedCount} order(s) re-queued.`);
  return { reconciledCount, requeuedCount, totalChecked: candidateOrders.length };
}

// Direct CLI execution
const isDirectExecution = process.argv[1] && process.argv[1].endsWith('reconcile.js');
if (isDirectExecution) {
  reconcileUnconfirmedOrders()
    .then(() => {
      closeDb();
      process.exit(0);
    })
    .catch((err) => {
      console.error('[Reconcile] Fatal error:', err);
      closeDb();
      process.exit(1);
    });
}
