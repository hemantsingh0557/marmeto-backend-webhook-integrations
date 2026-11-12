import crypto from 'node:crypto';
import { config } from '../config.js';

/**
 * Express middleware to verify HMAC-SHA256 signature in X-Shop-Hmac-Sha256 header.
 * Computes base64 HMAC over the raw request body buffer using WEBHOOK_SECRET.
 * Employs constant-time timingSafeEqual comparison with a byte-length pre-check
 * to prevent RangeError crashes on malformed or truncated inputs.
 */
export function verifyHmac(req, res, next) {
  const headerSig = req.headers['x-shop-hmac-sha256'];

  if (!headerSig || !req.rawBody) {
    return res.status(401).json({
      error: 'Invalid or missing HMAC signature'
    });
  }

  try {
    const hmac = crypto.createHmac('sha256', config.webhookSecret);
    const calculatedSig = hmac.update(req.rawBody).digest('base64');

    const headerBuf = Buffer.from(headerSig, 'utf8');
    const calculatedBuf = Buffer.from(calculatedSig, 'utf8');

    // CRITICAL: crypto.timingSafeEqual throws an unhandled RangeError if buffer lengths differ!
    if (headerBuf.length !== calculatedBuf.length) {
      return res.status(401).json({
        error: 'Invalid HMAC signature'
      });
    }

    // Timing-safe constant-time comparison against side-channel attacks
    const isValid = crypto.timingSafeEqual(headerBuf, calculatedBuf);
    if (!isValid) {
      return res.status(401).json({
        error: 'Invalid HMAC signature'
      });
    }

    return next();
  } catch (err) {
    return res.status(401).json({
      error: 'Invalid HMAC signature'
    });
  }
}
