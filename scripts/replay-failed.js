import { getDb, closeDb } from '../src/db/database.js';
import { CourierClient } from '../src/services/courierClient.js';

/**
 * Replay Failed Job CLI
 * Allows operational inspection and replay of parked Dead Letter Queue (DLQ) orders.
 */
export async function replayFailedJob(orderId, dbInstance = null, clientInstance = null) {
  const db = dbInstance || getDb();
  const courierClient = clientInstance || new CourierClient();

  const order = db.prepare('SELECT * FROM orders WHERE order_id = ?').get(String(orderId));
  if (!order) {
    console.error(`[Replay] Error: Order ${orderId} not found in database.`);
    return { success: false, reason: 'order_not_found' };
  }

  const job = db.prepare('SELECT * FROM jobs WHERE order_id = ?').get(String(orderId));
  const reference = order.reference || order.order_id;

  console.log(`[Replay] Inspecting order ${orderId} (Status: ${order.status}, Job Status: ${job?.status}, Attempts: ${job?.attempts})...`);

  // Step 1: Pre-flight check with courier before blindly resetting
  try {
    const existing = await courierClient.getShipmentsByReference(reference);
    if (existing && existing.length > 0) {
      const confirmed = existing[0];
      db.transaction(() => {
        db.prepare(`
          INSERT OR IGNORE INTO shipments (order_id, courier_shipment_id, reference, confirmed_at)
          VALUES (?, ?, ?, ?)
        `).run(order.order_id, confirmed.shipmentId, reference, Date.now());

        db.prepare(`UPDATE orders SET status = 'confirmed', updated_at = ? WHERE order_id = ?`).run(Date.now(), order.order_id);
        db.prepare(`
          UPDATE jobs
          SET status = 'completed', post_outcome_unknown = 0, lease_token = NULL, last_error = 'Resolved during replay'
          WHERE order_id = ?
        `).run(order.order_id);
      })();

      console.log(`[Replay] SUCCESS: Order ${orderId} was ALREADY created on courier (${confirmed.shipmentId}). Marked as confirmed.`);
      return { success: true, outcome: 'already_confirmed', shipmentId: confirmed.shipmentId };
    }
  } catch (err) {
    console.warn(`[Replay] Pre-flight check warning for order ${orderId}: ${err.message}`);
  }

  // Step 2: Reset job attempts and schedule for immediate worker processing
  db.transaction(() => {
    db.prepare(`
      UPDATE orders
      SET status = 'pending', updated_at = ?
      WHERE order_id = ?
    `).run(Date.now(), orderId);

    db.prepare(`
      UPDATE jobs
      SET status = 'pending',
          attempts = 0,
          post_outcome_unknown = 0,
          lease_token = NULL,
          next_run_at = ?,
          last_error = 'Replayed by operator',
          updated_at = ?
      WHERE order_id = ?
    `).run(Date.now(), Date.now(), orderId);
  })();

  console.log(`[Replay] SUCCESS: Order ${orderId} reset to pending (attempts=0). Background worker will re-process.`);
  return { success: true, outcome: 'requeued' };
}

// Direct CLI execution
const isDirectExecution = process.argv[1] && process.argv[1].endsWith('replay-failed.js');
if (isDirectExecution) {
  const targetId = process.argv[2];

  if (!targetId) {
    console.log('Usage: node scripts/replay-failed.js <orderId>');
    console.log('Or:    node scripts/replay-failed.js --all');

    const db = getDb();
    const failedOrders = db.prepare(`
      SELECT o.order_id, o.status, j.attempts, j.last_error
      FROM orders o
      JOIN jobs j ON o.order_id = j.order_id
      WHERE o.status = 'failed' OR (j.status = 'dead_letter' AND o.status != 'confirmed')
    `).all();

    console.log(`\nCurrently failed / dead-lettered orders (${failedOrders.length}):`);
    console.table(failedOrders);
    closeDb();
    process.exit(0);
  }

  if (targetId === '--all') {
    const db = getDb();
    const failedOrders = db.prepare(`SELECT order_id FROM orders WHERE status = 'failed'`).all();
    console.log(`[Replay] Replaying all ${failedOrders.length} failed orders...`);

    (async () => {
      for (const row of failedOrders) {
        await replayFailedJob(row.order_id, db);
      }
      closeDb();
      process.exit(0);
    })();
  } else {
    replayFailedJob(targetId)
      .then(() => {
        closeDb();
        process.exit(0);
      })
      .catch((err) => {
        console.error('[Replay] Fatal error:', err);
        closeDb();
        process.exit(1);
      });
  }
}
