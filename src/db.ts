import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from './config.js';

const databasePath = config.DATABASE_PATH === ':memory:' ? ':memory:' : resolve(config.DATABASE_PATH);
if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });

export const db = new Database(databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL UNIQUE,
    courier_partner TEXT NOT NULL,
    request_id TEXT NOT NULL,
    courier_shipment_id TEXT,
    awb TEXT,
    status TEXT NOT NULL,
    request_payload TEXT NOT NULL,
    courier_request TEXT,
    courier_response TEXT,
    error_code TEXT,
    error_message TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    lease_until TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status, lease_until);
  CREATE TABLE IF NOT EXISTS tracking_events (
    id TEXT PRIMARY KEY,
    order_pk TEXT NOT NULL REFERENCES orders(id),
    status TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    raw_payload TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS tracking_order_idx ON tracking_events(order_pk, occurred_at);
  CREATE TABLE IF NOT EXISTS courier_operations (
    id TEXT PRIMARY KEY,
    order_pk TEXT NOT NULL REFERENCES orders(id),
    operation TEXT NOT NULL,
    request_payload TEXT,
    response_payload TEXT,
    error_code TEXT,
    occurred_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS courier_operations_order_idx ON courier_operations(order_pk, occurred_at);
  CREATE TABLE IF NOT EXISTS batches (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS batch_items (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL REFERENCES batches(id),
    item_index INTEGER NOT NULL,
    order_pk TEXT NOT NULL REFERENCES orders(id),
    error_code TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(batch_id, item_index)
  );
  CREATE INDEX IF NOT EXISTS batch_items_batch_idx ON batch_items(batch_id, item_index);
`);

const batchItemColumns = db.prepare('PRAGMA table_info(batch_items)').all() as Array<{ name: string }>;
if (!batchItemColumns.some((column) => column.name === 'error_code')) {
  db.exec('ALTER TABLE batch_items ADD COLUMN error_code TEXT');
}
if (!batchItemColumns.some((column) => column.name === 'error_message')) {
  db.exec('ALTER TABLE batch_items ADD COLUMN error_message TEXT');
}

export interface OrderRow {
  id: string;
  order_id: string;
  courier_partner: string;
  request_id: string;
  courier_shipment_id: string | null;
  awb: string | null;
  status: string;
  request_payload: string;
  courier_request: string | null;
  courier_response: string | null;
  error_code: string | null;
  error_message: string | null;
  retry_count: number;
  lease_until: string | null;
  created_at: string;
  updated_at: string;
}

export function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}