import express from 'express';
import crypto from 'node:crypto';

const app = express();
app.use(express.json());

// In-memory shipment store: reference -> Array of shipments
// Non-idempotent: posting the same reference twice adds a second record
const shipmentStore = new Map();

/**
 * Helper to record a new shipment in the in-memory store
 */
function recordShipment(reference, payload) {
  const shipment = {
    shipmentId: `SHIP-${crypto.randomUUID()}`,
    reference,
    address: payload.address,
    items: payload.items,
    createdAt: Date.now()
  };

  const existing = shipmentStore.get(reference) || [];
  existing.push(shipment);
  shipmentStore.set(reference, existing);

  return shipment;
}

/**
 * Determine the chaos scenario for a request
 */
function getScenario(req) {
  // Deterministic header override (crucial for automated testing)
  const headerScenario = req.headers['x-mock-scenario'];
  if (headerScenario) {
    return headerScenario.toLowerCase();
  }

  // Probabilistic scenario distribution matching Marmeto specifications:
  // - 20% return 500
  // - 10% return 429 with Retry-After: 2
  // - 10% create shipment THEN hang for 10s
  // - 60% standard 201 Created
  const rand = Math.random() * 100;
  if (rand < 20) return 'server-error';
  if (rand < 30) return 'rate-limit';
  if (rand < 40) return 'timeout-after-create';
  return 'success';
}

/**
 * POST /shipments
 * Body: { reference, address, items }
 */
app.post('/shipments', (req, res) => {
  const { reference, address, items } = req.body || {};

  if (!reference) {
    return res.status(400).json({ error: 'Missing required field: reference' });
  }

  const scenario = getScenario(req);

  switch (scenario) {
    case 'server-error':
      return res.status(500).json({
        error: 'Courier internal error (simulated 500 failure)'
      });

    case 'rate-limit':
      res.setHeader('Retry-After', '2');
      return res.status(429).json({
        error: 'Too Many Requests: Courier API rate limit reached'
      });

    case 'timeout-after-create': {
      // CRITICAL: The courier creates the shipment record in its database FIRST,
      // and THEN hangs for 10 seconds before returning a response.
      const shipment = recordShipment(reference, { address, items });

      // Intentionally hang for 10 seconds before responding
      const timer = setTimeout(() => {
        if (!res.headersSent) {
          res.status(201).json({
            shipmentId: shipment.shipmentId,
            reference: shipment.reference
          });
        }
      }, 10000);
      if (timer.unref) timer.unref();
      return;
    }

    case 'success':
    default: {
      const shipment = recordShipment(reference, { address, items });
      return res.status(201).json({
        shipmentId: shipment.shipmentId,
        reference: shipment.reference
      });
    }
  }
});

/**
 * GET /shipments?reference=<orderId>
 * Returns list of shipments for that reference
 */
app.get('/shipments', (req, res) => {
  const reference = req.query.reference;
  if (!reference) {
    return res.status(400).json({ error: 'Query parameter reference is required' });
  }

  const list = shipmentStore.get(reference) || [];
  return res.status(200).json(list);
});

/**
 * Helper endpoint to reset in-memory state during tests
 */
app.post('/_reset', (req, res) => {
  shipmentStore.clear();
  return res.status(200).json({ status: 'reset_ok' });
});

/**
 * Health check
 */
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'mock-courier' });
});

export { app, shipmentStore };

// If executed directly from CLI: node mock-courier.js
const isDirectExecution = process.argv[1] && process.argv[1].endsWith('mock-courier.js');
if (isDirectExecution) {
  const PORT = process.env.COURIER_PORT || 3001;
  app.listen(PORT, () => {
    console.log(`[Mock Courier] Server running on port ${PORT}`);
  });
}
