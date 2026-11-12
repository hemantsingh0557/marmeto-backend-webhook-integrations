import crypto from 'node:crypto';
import { config } from '../src/config.js';

const TARGET_URL = `http://localhost:${config.port}/webhooks/orders-create`;
const SECRET = config.webhookSecret;

function generateSignature(rawBody, secret) {
  return crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
}

async function sendRequest({ webhookId, payload, signature, label }) {
  console.log(`\n--- [Test Scenario] ${label} ---`);
  const rawBody = JSON.stringify(payload);
  const sig = signature !== undefined ? signature : generateSignature(rawBody, SECRET);

  console.log(`Endpoint: ${TARGET_URL}`);
  console.log(`Webhook-ID: ${webhookId}`);
  console.log(`HMAC Header: ${sig}`);

  try {
    const res = await fetch(TARGET_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shop-Hmac-Sha256': sig,
        'X-Shop-Webhook-Id': webhookId
      },
      body: rawBody
    });

    const bodyText = await res.text();
    let bodyJson;
    try {
      bodyJson = JSON.parse(bodyText);
    } catch {
      bodyJson = bodyText;
    }

    console.log(`Response Status: ${res.status} ${res.statusText}`);
    console.log('Response Body:', JSON.stringify(bodyJson, null, 2));
    return { status: res.status, body: bodyJson };
  } catch (err) {
    console.error('Request failed:', err.message);
    return { error: err.message };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const sampleOrderId = `ORD-${Date.now()}`;
  const samplePayload = {
    id: sampleOrderId,
    reference: sampleOrderId,
    email: 'buyer@example.com',
    shipping_address: {
      address1: '456 Industrial Area',
      city: 'Bengaluru',
      zip: '560001',
      country: 'India'
    },
    line_items: [
      { id: 'ITEM-1', title: 'Ergonomic Desk', quantity: 1, price: '8999.00' }
    ]
  };

  const deliveryId = `DLV-${crypto.randomUUID()}`;

  // 1. Valid Webhook
  console.log('====================================================');
  console.log('Marmeto Integration Test Emitter');
  console.log('====================================================');

  await sendRequest({
    webhookId: deliveryId,
    payload: samplePayload,
    label: '1. Valid Signed Webhook (Expects 202 Accepted)'
  });

  // 2. Duplicate Delivery (Exact same X-Shop-Webhook-Id)
  await sendRequest({
    webhookId: deliveryId,
    payload: samplePayload,
    label: '2. Duplicate Delivery ID (Expects 200 OK duplicate_ignored)'
  });

  // 3. Duplicate Order (New Webhook ID, same Order ID)
  const newDeliveryId = `DLV-${crypto.randomUUID()}`;
  await sendRequest({
    webhookId: newDeliveryId,
    payload: samplePayload,
    label: '3. Duplicate Order ID (Expects 200 OK order_already_exists)'
  });

  // 4. Invalid Signature (Tampered payload)
  await sendRequest({
    webhookId: `DLV-${crypto.randomUUID()}`,
    payload: { id: `ORD-TAMPER-${Date.now()}` },
    signature: 'bad_signature_that_fails_verification_12345678',
    label: '4. Invalid HMAC Signature (Expects 401 Unauthorized)'
  });
}

main().catch(console.error);
