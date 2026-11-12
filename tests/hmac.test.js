import request from 'supertest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../src/app.js';
import { getDb, closeDb } from '../src/db/database.js';
import { config } from '../src/config.js';

describe('HMAC-SHA256 Security & Signature Verification', () => {
  let app;
  let db;
  const testDbPath = path.resolve('./data/test_hmac.db');

  beforeAll(() => {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    db = getDb(testDbPath);
    app = createApp({ db });
  });

  afterAll(() => {
    closeDb();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  });

  function sign(body, secret = config.webhookSecret) {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    return crypto.createHmac('sha256', secret).update(raw).digest('base64');
  }

  test('should accept valid signature with 202 Accepted', async () => {
    const payload = {
      id: 'TEST-ORDER-1',
      shipping_address: { city: 'Bengaluru' },
      line_items: [{ title: 'Item 1' }]
    };
    const raw = JSON.stringify(payload);
    const signature = sign(raw);

    const res = await request(app)
      .post('/webhooks/orders-create')
      .set('Content-Type', 'application/json')
      .set('X-Shop-Webhook-Id', 'TEST-DLV-1')
      .set('X-Shop-Hmac-Sha256', signature)
      .send(raw);

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('accepted');
  });

  test('should reject request missing X-Shop-Hmac-Sha256 header with 401', async () => {
    const payload = { id: 'TEST-ORDER-2' };

    const res = await request(app)
      .post('/webhooks/orders-create')
      .set('Content-Type', 'application/json')
      .set('X-Shop-Webhook-Id', 'TEST-DLV-2')
      .send(payload);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Invalid or missing/i);
  });

  test('should reject tampered payload with 401 Unauthorized', async () => {
    const originalPayload = { id: 'TEST-ORDER-3', amount: 100 };
    const tamperedPayload = { id: 'TEST-ORDER-3', amount: 999 };

    // Sign original, send tampered
    const signature = sign(JSON.stringify(originalPayload));

    const res = await request(app)
      .post('/webhooks/orders-create')
      .set('Content-Type', 'application/json')
      .set('X-Shop-Webhook-Id', 'TEST-DLV-3')
      .set('X-Shop-Hmac-Sha256', signature)
      .send(JSON.stringify(tamperedPayload));

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Invalid HMAC/i);
  });

  test('should reject truncated / mismatched-length signature with 401 and NOT crash with RangeError', async () => {
    const payload = { id: 'TEST-ORDER-4' };
    const raw = JSON.stringify(payload);

    // Truncated signature (10 chars instead of 44 chars)
    const malformedSig = 'short_sig';

    const res = await request(app)
      .post('/webhooks/orders-create')
      .set('Content-Type', 'application/json')
      .set('X-Shop-Webhook-Id', 'TEST-DLV-4')
      .set('X-Shop-Hmac-Sha256', malformedSig)
      .send(raw);

    // Crucial check: Must return clean 401, not unhandled 500 error from crypto.timingSafeEqual
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/Invalid/i);
  });
});
