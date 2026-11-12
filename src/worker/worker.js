import crypto from 'node:crypto';
import { getDb } from '../db/database.js';
import { CourierClient } from '../services/courierClient.js';
import { processJob } from './processJob.js';
import { config } from '../config.js';

export class BackgroundWorker {
  constructor(db = null, courierClient = null) {
    this.db = db || getDb();
    this.courierClient = courierClient || new CourierClient();
    this.isRunning = false;
    this.timer = null;
    this.isTicking = false;
  }

  /**
   * Reaps orphaned jobs where worker crashed during final attempt
   */
  reapExpiredMaxAttemptJobs(now) {
    const deadLetterStmt = this.db.prepare(`
      UPDATE jobs
      SET status = 'dead_letter', lease_token = NULL, last_error = 'Worker crashed on max attempt (lease expired)', updated_at = ?
      WHERE status = 'processing' AND lease_until < ? AND attempts >= max_attempts
    `);
    const res = deadLetterStmt.run(now, now);

    if (res.changes > 0) {
      this.db.prepare(`
        UPDATE orders
        SET status = 'failed', updated_at = ?
        WHERE order_id IN (
          SELECT order_id FROM jobs WHERE status = 'dead_letter' AND last_error LIKE 'Worker crashed%'
        )
      `).run(now);
    }
  }

  /**
   * Single polling tick: reaps zombies, finds due jobs, acquires atomic leases, and dispatches
   */
  async tick() {
    if (this.isTicking) return;
    this.isTicking = true;

    try {
      const now = Date.now();

      // 1. Sweep stale leases on max attempt jobs
      this.reapExpiredMaxAttemptJobs(now);

      // 2. Query due jobs eligible for execution
      const eligibleJobs = this.db.prepare(`
        SELECT * FROM jobs
        WHERE (
          (status IN ('pending', 'retry_wait', 'unknown') AND next_run_at <= ?)
          OR (status = 'processing' AND lease_until < ?)
        )
        AND attempts < max_attempts
        ORDER BY next_run_at ASC
        LIMIT 10
      `).all(now, now);

      for (const job of eligibleJobs) {
        const leaseToken = crypto.randomUUID();
        const leaseUntil = now + config.leaseDurationMs;

        // 3. Atomic Lease Claim
        const claimStmt = this.db.prepare(`
          UPDATE jobs
          SET status = 'processing',
              lease_token = ?,
              lease_until = ?,
              attempts = attempts + 1,
              updated_at = ?
          WHERE id = ?
            AND attempts < max_attempts
            AND (
              (status = 'pending' AND next_run_at <= ?)
              OR (status = 'retry_wait' AND next_run_at <= ?)
              OR (status = 'unknown' AND next_run_at <= ?)
              OR (status = 'processing' AND lease_until < ?)
            )
        `);

        const claimRes = claimStmt.run(leaseToken, leaseUntil, now, job.id, now, now, now, now);

        if (claimRes.changes === 0) {
          // Another worker claimed it or state changed; skip
          continue;
        }

        // Job successfully locked by this worker instance
        const claimedJob = {
          ...job,
          lease_token: leaseToken,
          lease_until: leaseUntil,
          attempts: job.attempts + 1
        };

        // Execute async processing
        await processJob(claimedJob, this.db, this.courierClient);
      }
    } catch (err) {
      if (config.nodeEnv !== 'test') {
        console.error('[Worker] Error during polling tick:', err.message);
      }
    } finally {
      this.isTicking = false;
    }
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;

    const scheduleNext = () => {
      if (!this.isRunning) return;
      this.timer = setTimeout(async () => {
        await this.tick();
        scheduleNext();
      }, config.workerPollMs);
    };

    scheduleNext();
    if (config.nodeEnv !== 'test') {
      console.log(`[Worker] Started queue poller (interval: ${config.workerPollMs}ms, lease: ${config.leaseDurationMs}ms)`);
    }
  }

  stop() {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
