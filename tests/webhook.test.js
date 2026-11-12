import request from 'supertest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { getDb, closeDb } from '../src/db/database.js';
import { config } from '../src/config.js';

describe('Webhook Ingestion & Two-Tier Idempotency', () => {
  let app;
  let db;
  const testDbPath = path.resolve('./data/test_webhook.db');

  beforeAll(() => {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    db = getDb(testDbPath);
    app = createApp({ db });
  });

  afterAll(() => {
    closeDb();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  });

  function sign(body) {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    return crypto.createHmac('sha256', config.webhookSecret).update(raw).digest('base64');
  }

  test('should ingest order and respond fast (under 1 second)', async () => {
    const orderId = 'FAST-ORDER-100';
    const payload = {
      id: orderId,
      shipping_address: { city: 'Bengaluru' },
      line_items: [{ title: 'Ergonomic Chair' }]
    };
    const raw = JSON.stringify(payload);
    const signature = sign(raw);

    const startTime = Date.now();
    const res = await request(app)
      .post('/webhooks/orders-create')
      .set('Content-Type', 'application/json')
      .set('X-Shop-Webhook-Id', 'FAST-DLV-100')
      .set('X-Shop-Hmac-Sha256', signature)
      .send(raw);
    const latency = Date.now() - startTime;

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('accepted');
    expect(res.body.orderId).toBe(orderId);
    expect(latency).toBeLessThan(1000); // Sub-second response requirement
  });

  test('should handle exact duplicate webhook delivery idempotently (Tier 1)', async () => {
    const orderId = 'DUP-ORDER-200';
    const deliveryId = 'DUP-DLV-200';
    const payload = { id: orderId, reference: orderId, line_items: [] };
    const raw = JSON.stringify(payload);
    const signature = sign(raw);

    // Delivery 1
    const res1 = await request(app)
      .post('/webhooks/orders-create')
      .set('Content-Type', 'application/json')
      .set('X-Shop-Webhook-Id', deliveryId)
      .set('X-Shop-Hmac-Sha256', signature)
      .send(raw);
    expect(res1.status).toBe(202);

    // Delivery 2 (Identical webhook ID re-delivered by store)
    const res2 = await request(app)
      .post('/webhooks/orders-create')
      .set('Content-Type', 'application/json')
      .set('X-Shop-Webhook-Id', deliveryId)
      .set('X-Shop-Hmac-Sha256', signature)
      .send(raw);

    expect(res2.status).toBe(200);
    expect(res2.body.status).toBe('duplicate_ignored');

    // Confirm only 1 job was created in DB
    const jobsCount = db.prepare('SELECT count(*) as count FROM jobs WHERE order_id = ?').get(orderId).count;
    expect(jobsCount).toBe(1);
  });

  test('should handle domain-level duplicate order with new webhook ID idempotently (Tier 2)', async () => {
    const orderId = 'DOMAIN-DUP-300';
    const payload = { id: orderId, reference: orderId };
    const raw = JSON.stringify(payload);
    const signature = sign(raw);

    // First delivery
    const res1 = await request(app)
      .post('/webhooks/orders-create')
      .set('Content-Type', 'application/json')
      .set('X-Shop-Webhook-Id', 'DLV-INITIAL-300')
      .set('X-Shop-Hmac-Sha256', signature)
      .send(raw);
    expect(res1.status).toBe(202);

    // Second delivery: Different delivery ID, but same Order ID
    const res2 = await request(app)
      .post('/webhooks/orders-create')
      .set('Content-Type', 'application/json')
      .set('X-Shop-Webhook-Id', 'DLV-SECOND-300')
      .set('X-Shop-Hmac-Sha256', signature)
      .send(raw);

    expect(res2.status).toBe(200);
    expect(res2.body.status).toBe('order_already_exists');

    // Confirm only 1 job and 1 order row exist
    const ordersCount = db.prepare('SELECT count(*) as count FROM orders WHERE order_id = ?').get(orderId).count;
    const jobsCount = db.prepare('SELECT count(*) as count FROM jobs WHERE order_id = ?').get(orderId).count;
    expect(ordersCount).toBe(1);
    expect(jobsCount).toBe(1);
  });
});
