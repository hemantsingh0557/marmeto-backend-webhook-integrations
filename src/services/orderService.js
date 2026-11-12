import { getDb } from '../db/database.js';
import { config } from '../config.js';

export class OrderService {
  constructor(db = null) {
    this.db = db || getDb();
  }

  /**
   * Atomic 3-in-1 Ingestion Transaction
   * Executes webhook delivery check, order entity insertion, and background job creation
   * within a single SQLite transaction.
   *
   * Guarantees:
   * 1. No lost orders on process crash (everything commits or rolls back together).
   * 2. Zero duplicate jobs for the same webhook delivery or order ID.
   */
  ingestWebhook(webhookId, orderData) {
    const orderId = String(orderData.id || orderData.order_id);
    const reference = String(orderData.reference || orderId);
    const shippingAddress = JSON.stringify(orderData.shipping_address || {});
    const lineItems = JSON.stringify(orderData.line_items || []);
    const now = Date.now();

    const transaction = this.db.transaction(() => {
      // 1. Tier 1 Deduplication: Check & record webhook delivery
      const deliveryStmt = this.db.prepare(`
        INSERT OR IGNORE INTO webhook_deliveries (webhook_id, order_id, received_at)
        VALUES (?, ?, ?)
      `);
      const deliveryRes = deliveryStmt.run(webhookId, orderId, now);

      if (deliveryRes.changes === 0) {
        // Exact duplicate delivery (same X-Shop-Webhook-Id)
        return { outcome: 'duplicate_delivery', orderId, reference };
      }

      // 2. Tier 2 Deduplication: Check & record domain order entity
      const orderStmt = this.db.prepare(`
        INSERT OR IGNORE INTO orders (order_id, reference, shipping_address, line_items, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'pending', ?, ?)
      `);
      const orderRes = orderStmt.run(orderId, reference, shippingAddress, lineItems, now, now);

      if (orderRes.changes === 0) {
        // Order entity already exists (same order ID sent with new webhook ID)
        return { outcome: 'order_already_exists', orderId, reference };
      }

      // 3. Enqueue transactional background job in the same atomic commit
      const jobStmt = this.db.prepare(`
        INSERT INTO jobs (order_id, status, attempts, max_attempts, next_run_at, post_outcome_unknown, created_at, updated_at)
        VALUES (?, 'pending', 0, ?, ?, 0, ?, ?)
      `);
      jobStmt.run(orderId, config.maxAttempts, now, now, now);

      return { outcome: 'enqueued', orderId, reference };
    }).immediate;

    return transaction();
  }

  getOrderById(orderId) {
    return this.db.prepare('SELECT * FROM orders WHERE order_id = ?').get(String(orderId));
  }

  getOrderByReference(reference) {
    return this.db.prepare('SELECT * FROM orders WHERE reference = ?').get(String(reference));
  }

  getShipmentByOrderId(orderId) {
    return this.db.prepare('SELECT * FROM shipments WHERE order_id = ?').get(String(orderId));
  }

  getJobByOrderId(orderId) {
    return this.db.prepare('SELECT * FROM jobs WHERE order_id = ?').get(String(orderId));
  }
}
