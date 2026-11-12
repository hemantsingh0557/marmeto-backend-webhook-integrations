import { config } from './config.js';
import { getDb, closeDb } from './db/database.js';
import { createApp } from './app.js';
import { BackgroundWorker } from './worker/worker.js';

// 1. Initialize SQLite Database (runs DDL schema & pragmas)
const db = getDb();

// 2. Instantiate Express application
const app = createApp({ db });

// 3. Start background queue worker
const worker = new BackgroundWorker(db);
worker.start();

// 4. Start HTTP Server
const server = app.listen(config.port, () => {
  console.log(`=======================================================`);
  console.log(`[Server] Marmeto Integration Service running on port ${config.port}`);
  console.log(`[Server] Environment: ${config.nodeEnv}`);
  console.log(`[Server] Webhook Endpoint: POST http://localhost:${config.port}/webhooks/orders-create`);
  console.log(`[Server] Downstream Courier URL: ${config.courierBaseUrl}`);
  console.log(`=======================================================`);
});

// Graceful shutdown handling
function gracefulShutdown(signal) {
  console.log(`\n[Server] Received ${signal}. Shutting down gracefully...`);
  worker.stop();
  server.close(() => {
    closeDb();
    console.log('[Server] Connections closed. Exiting process.');
    process.exit(0);
  });
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
