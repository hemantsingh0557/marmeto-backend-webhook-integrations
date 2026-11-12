import dotenv from 'dotenv';
import path from 'node:path';

// Load environment variables from .env
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  // Webhook security
  webhookSecret: process.env.WEBHOOK_SECRET || 'marmeto_shared_secret_key_2026',

  // Downstream Courier Partner
  courierBaseUrl: process.env.COURIER_BASE_URL || 'http://localhost:3001',
  courierTimeoutMs: parseInt(process.env.COURIER_TIMEOUT_MS || '3500', 10),
  maxAttempts: parseInt(process.env.MAX_ATTEMPTS || '5', 10),

  // Database path
  dbPath: process.env.DB_PATH || path.resolve('./data/marmeto.db'),

  // Background Worker Settings
  workerPollMs: parseInt(process.env.WORKER_POLL_MS || '500', 10),
  leaseDurationMs: parseInt(process.env.LEASE_DURATION_MS || '45000', 10)
};
