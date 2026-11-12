import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { app as mockCourierApp, shipmentStore } from '../mock-courier.js';
import { getDb, closeDb } from '../src/db/database.js';
import { CourierClient } from '../src/services/courierClient.js';
import { BackgroundWorker } from '../src/worker/worker.js';
import { OrderService } from '../src/services/orderService.js';
import { reconcileUnconfirmedOrders } from '../scripts/reconcile.js';

describe('Courier Integration & Chaos Resilience Suite', () => {
  let courierServer;
  let courierPort;
  let db;
  let courierClient;
  let orderService;
  let worker;
  const testDbPath = path.resolve('./data/test_shipment.db');

  beforeAll((done) => {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    db = getDb(testDbPath);

    // Spin up mock courier on random free test port
    courierServer = http.createServer(mockCourierApp);
    courierServer.listen(0, () => {
      courierPort = courierServer.address().port;
      const baseUrl = `http://localhost:${courierPort}`;

      // Use a fast client timeout (1000ms) for quick test execution
      courierClient = new CourierClient(baseUrl, 1000);
      orderService = new OrderService(db);
      worker = new BackgroundWorker(db, courierClient);
      done();
    });
  });

  beforeEach(() => {
    shipmentStore.clear();
  });

  afterAll((done) => {
    closeDb();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    courierServer.close(done);
  });

  test('should successfully create shipment on courier when partner is healthy', async () => {
    const orderId = 'SHIP-TEST-1';
    orderService.ingestWebhook('DLV-1', {
      id: orderId,
      shipping_address: { city: 'Bengaluru' },
      line_items: [{ title: 'Desk' }]
    });

    // Run worker tick with deterministic success mock scenario
    const originalCreate = courierClient.createShipment.bind(courierClient);
    courierClient.createShipment = (payload) =>
      originalCreate(payload, { headers: { 'X-Mock-Scenario': 'success' } });

    await worker.tick();

    courierClient.createShipment = originalCreate;

    const order = db.prepare('SELECT * FROM orders WHERE order_id = ?').get(orderId);
    const shipment = db.prepare('SELECT * FROM shipments WHERE order_id = ?').get(orderId);

    expect(order.status).toBe('confirmed');
    expect(shipment).toBeDefined();
    expect(shipment.courier_shipment_id).toMatch(/^SHIP-/);
  });

  test('should respect 429 rate limit and apply Retry-After header delay', async () => {
    const orderId = 'SHIP-TEST-429';
    orderService.ingestWebhook('DLV-429', { id: orderId, reference: orderId });

    // Mock scenario: rate-limit
    const originalCreate = courierClient.createShipment.bind(courierClient);
    courierClient.createShipment = (payload) =>
      originalCreate(payload, { headers: { 'X-Mock-Scenario': 'rate-limit' } });

    const beforeTick = Date.now();
    await worker.tick();

    courierClient.createShipment = originalCreate;

    const job = db.prepare('SELECT * FROM jobs WHERE order_id = ?').get(orderId);
    expect(job.status).toBe('retry_wait');
    expect(job.attempts).toBe(1);
    // Verified: next_run_at must be delayed by at least 2000ms per Retry-After header
    expect(job.next_run_at).toBeGreaterThanOrEqual(beforeTick + 1900);
  });

  test('should neutralize 10-second timeout hang trap without creating duplicate shipment', async () => {
    const orderId = 'TIMEOUT-HERO-ORDER';
    orderService.ingestWebhook('DLV-TIMEOUT', { id: orderId, reference: orderId });

    // Mock scenario: timeout-after-create
    // Courier saves shipment, then hangs for 10s.
    // Client aborts at 1000ms timeout, catches error, runs recovery GET, finds shipment, and marks confirmed!
    const originalCreate = courierClient.createShipment.bind(courierClient);
    courierClient.createShipment = (payload) =>
      originalCreate(payload, { headers: { 'X-Mock-Scenario': 'timeout-after-create' } });

    await worker.tick();

    courierClient.createShipment = originalCreate;

    const order = db.prepare('SELECT * FROM orders WHERE order_id = ?').get(orderId);
    const shipment = db.prepare('SELECT * FROM shipments WHERE order_id = ?').get(orderId);

    expect(order.status).toBe('confirmed');
    expect(shipment).toBeDefined();

    // CRITICAL: Check mock courier internal store!
    // Non-idempotent courier must have EXACTLY 1 shipment recorded for this reference, NOT 2!
    const courierStoredList = shipmentStore.get(orderId) || [];
    expect(courierStoredList.length).toBe(1);
  });

  test('should recover stuck unconfirmed orders via reconciliation script without duplicates', async () => {
    const orderId = 'RECONCILE-ORDER-99';
    orderService.ingestWebhook('DLV-REC-99', { id: orderId, reference: orderId });

    // Pre-create shipment on mock courier as if created during earlier hang
    shipmentStore.set(orderId, [{
      shipmentId: 'SHIP-PRE-CREATED-BY-COURIER',
      reference: orderId,
      createdAt: Date.now()
    }]);

    // Run reconciliation routine
    const report = await reconcileUnconfirmedOrders(db, courierClient);

    expect(report.reconciledCount).toBeGreaterThanOrEqual(1);

    const order = db.prepare('SELECT * FROM orders WHERE order_id = ?').get(orderId);
    const shipment = db.prepare('SELECT * FROM shipments WHERE order_id = ?').get(orderId);

    expect(order.status).toBe('confirmed');
    expect(shipment.courier_shipment_id).toBe('SHIP-PRE-CREATED-BY-COURIER');
  });
});
