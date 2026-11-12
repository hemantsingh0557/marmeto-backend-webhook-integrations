import express from 'express';
import { createWebhookRouter } from './routes/webhook.routes.js';
import { getDb } from './db/database.js';

/**
 * Express application factory.
 * Exported without calling listen() to support clean testing via Supertest.
 */
export function createApp(options = {}) {
  const app = express();

  // CRITICAL: Capture raw body Buffer before JSON parsing for HMAC-SHA256 verification
  app.use(express.json({
    limit: '1mb',
    verify: (req, res, buf) => {
      req.rawBody = buf;
    }
  }));

  // Mount Webhook Router
  app.use('/webhooks', createWebhookRouter(options.orderService));

  // Health and Diagnostic Endpoint
  app.get('/health', (req, res) => {
    try {
      const db = options.db || getDb();
      const row = db.prepare('SELECT sqlite_version() as version').get();
      res.status(200).json({
        status: 'ok',
        service: 'marmeto-integration-backend',
        sqlite_version: row.version,
        uptime_seconds: Math.floor(process.uptime())
      });
    } catch (err) {
      res.status(500).json({
        status: 'error',
        error: err.message
      });
    }
  });

  // Global fallback error handler
  app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
      return res.status(400).json({ error: 'Malformed JSON payload' });
    }
    return res.status(500).json({ error: 'Internal Server Error' });
  });

  return app;
}
