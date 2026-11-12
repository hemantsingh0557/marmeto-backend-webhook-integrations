import { config } from '../config.js';

export class CourierRateLimitError extends Error {
  constructor(retryAfterSec = 2, message = 'Courier rate limit exceeded') {
    super(message);
    this.name = 'CourierRateLimitError';
    this.retryAfterSec = Number(retryAfterSec) || 2;
    this.retryAfterMs = this.retryAfterSec * 1000;
  }
}

export class CourierServerError extends Error {
  constructor(statusCode = 500, message = 'Courier 5xx server error') {
    super(message);
    this.name = 'CourierServerError';
    this.statusCode = statusCode;
  }
}

export class CourierTimeoutError extends Error {
  constructor(message = 'Courier request timed out') {
    super(message);
    this.name = 'CourierTimeoutError';
  }
}

export class CourierNetworkError extends Error {
  constructor(message = 'Courier network error') {
    super(message);
    this.name = 'CourierNetworkError';
  }
}

export class CourierClient {
  constructor(baseUrl = null, timeoutMs = null) {
    this.baseUrl = baseUrl || config.courierBaseUrl;
    this.timeoutMs = timeoutMs || config.courierTimeoutMs;
  }

  /**
   * Look up existing shipments by order reference
   * GET /shipments?reference=<reference>
   */
  async getShipmentsByReference(reference, options = {}) {
    const url = `${this.baseUrl}/shipments?reference=${encodeURIComponent(reference)}`;
    const timeout = options.timeoutMs || this.timeoutMs;
    const signal = AbortSignal.timeout(timeout);

    try {
      const headers = {
        'Accept': 'application/json',
        ...(options.headers || {})
      };

      const res = await fetch(url, { method: 'GET', headers, signal });

      if (res.status === 429) {
        const retryAfter = res.headers.get('Retry-After') || 2;
        throw new CourierRateLimitError(retryAfter);
      }

      if (res.status >= 500) {
        throw new CourierServerError(res.status, `Courier returned ${res.status} on GET lookup`);
      }

      if (!res.ok) {
        throw new CourierNetworkError(`Courier returned unexpected status ${res.status} on GET`);
      }

      const data = await res.json();
      return Array.isArray(data) ? data : [];
    } catch (err) {
      if (err instanceof CourierRateLimitError || err instanceof CourierServerError) {
        throw err;
      }
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new CourierTimeoutError(`Courier lookup timed out after ${timeout}ms`);
      }
      throw new CourierNetworkError(`Courier lookup failed: ${err.message}`);
    }
  }

  /**
   * Create a new shipment with courier partner
   * POST /shipments { reference, address, items }
   */
  async createShipment({ reference, address, items }, options = {}) {
    const url = `${this.baseUrl}/shipments`;
    const timeout = options.timeoutMs || this.timeoutMs;
    const signal = AbortSignal.timeout(timeout);

    try {
      const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...(options.headers || {})
      };

      const body = JSON.stringify({ reference, address, items });

      const res = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal
      });

      if (res.status === 429) {
        const retryAfter = res.headers.get('Retry-After') || 2;
        throw new CourierRateLimitError(retryAfter);
      }

      if (res.status >= 500) {
        throw new CourierServerError(res.status, `Courier returned 5xx (${res.status}) on shipment creation`);
      }

      if (!res.ok) {
        throw new CourierNetworkError(`Courier returned unexpected status ${res.status}`);
      }

      const data = await res.json();
      return data; // { shipmentId, reference }
    } catch (err) {
      if (err instanceof CourierRateLimitError || err instanceof CourierServerError) {
        throw err;
      }
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new CourierTimeoutError(`Courier shipment creation timed out after ${timeout}ms`);
      }
      throw new CourierNetworkError(`Courier request failed: ${err.message}`);
    }
  }
}
