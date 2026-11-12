import express from 'express';
import { verifyHmac } from '../middleware/verifyHmac.js';
import { OrderService } from '../services/orderService.js';

export function createWebhookRouter(orderService = null) {
  const router = express.Router();
  const service = orderService || new OrderService();

  /**
   * POST /webhooks/orders-create
   * Ingests merchant orders/create webhooks securely and idempotently.
   */
  router.post('/orders-create', verifyHmac, (req, res) => {
    const webhookId = req.headers['x-shop-webhook-id'];

    if (!webhookId) {
      return res.status(400).json({
        error: 'Missing required header: X-Shop-Webhook-Id'
      });
    }

    const orderData = req.body;
    if (!orderData || (!orderData.id && !orderData.order_id)) {
      return res.status(400).json({
        error: 'Invalid order payload: missing id'
      });
    }

    try {
      // Atomic 3-in-1 Ingestion: Delivery check -> Order check -> Job enqueued
      const result = service.ingestWebhook(webhookId, orderData);

      if (result.outcome === 'duplicate_delivery') {
        return res.status(200).json({
          status: 'duplicate_ignored',
          message: 'Webhook delivery was already received and processed',
          orderId: result.orderId
        });
      }

      if (result.outcome === 'order_already_exists') {
        return res.status(200).json({
          status: 'order_already_exists',
          message: 'Order has already been recorded and enqueued',
          orderId: result.orderId
        });
      }

      // Valid new order, background job enqueued
      return res.status(202).json({
        status: 'accepted',
        message: 'Order webhook ingested and courier job enqueued',
        orderId: result.orderId,
        reference: result.reference
      });
    } catch (err) {
      return res.status(500).json({
        error: 'Internal server error processing webhook ingestion',
        details: err.message
      });
    }
  });

  return router;
}
