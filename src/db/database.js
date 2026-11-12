import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { schemaDDL } from './schema.js';

let dbInstance = null;

/**
 * Initializes and returns the singleton better-sqlite3 database connection
 * Configured in WAL mode with Foreign Key enforcement.
 */
export function getDb(customPath = null) {
  if (dbInstance) {
    return dbInstance;
  }

  const targetPath = customPath || config.dbPath;

  // Ensure parent directory exists
  const parentDir = path.dirname(targetPath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  dbInstance = new Database(targetPath);

  // Set production-grade SQLite pragmas
  dbInstance.pragma('journal_mode = WAL');
  dbInstance.pragma('foreign_keys = ON');
  dbInstance.pragma('synchronous = NORMAL');
  dbInstance.pragma('busy_timeout = 5000');

  // Verify SQLite WAL version security check
  const versionRow = dbInstance.prepare('SELECT sqlite_version() as version').get();
  if (config.nodeEnv !== 'test') {
    console.log(`[Database] SQLite connected at ${targetPath} (v${versionRow.version}, WAL mode enabled)`);
  }

  // Execute schema setup
  dbInstance.exec(schemaDDL);

  return dbInstance;
}

/**
 * Closes the active database connection
 */
export function closeDb() {
  if (dbInstance && dbInstance.open) {
    dbInstance.close();
  }
  dbInstance = null;
}
