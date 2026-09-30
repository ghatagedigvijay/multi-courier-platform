import { randomUUID } from 'node:crypto';
import { db, json, type OrderRow } from '../db.js';
import { ApiError, CourierError } from '../errors.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { createOrderSchema, normalizeStatus, type CreateOrderInput, type ShipmentStatus } from '../domain.js';
import { courierRegistry } from '../couriers/registry.js';
import type { CourierAdapter, CourierOrderReference } from '../couriers/adapter.js';

export interface PublicOrder {
  id: string;
  order_id: string;
  courier_partner: string;
  courier_shipment_id: string | null;
  awb: string | null;
  status: ShipmentStatus;
  error: { code: string; message: string } | null;
  created_at: string;
  updated_at: string;
}

function now(): string {
  return new Date().toISOString();
}

function toPublicOrder(row: OrderRow): PublicOrder {
  return {
    id: row.id,
    order_id: row.order_id,
    courier_partner: row.courier_partner,
    courier_shipment_id: row.courier_shipment_id,
    awb: row.awb,
    status: normalizeStatus(row.status),
    error: row.error_code ? { code: row.error_code, message: row.error_message ?? 'Shipment processing failed' } : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function findOrderById(orderId: string): OrderRow | undefined {
  return db.prepare('SELECT * FROM orders WHERE order_id = ?').get(orderId) as OrderRow | undefined;
}

function findOrderByPk(id: string): OrderRow | undefined {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(id) as OrderRow | undefined;
}

function referenceFrom(row: OrderRow): CourierOrderReference {
  return { orderId: row.order_id, courierShipmentId: row.courier_shipment_id, awb: row.awb };
}

function ensureSameRequest(existing: OrderRow, input: CreateOrderInput): void {
  if (existing.courier_partner !== input.courier_partner || existing.request_payload !== json(input)) {
    throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'order_id already exists with a different request');
  }
}

function statusIsTerminal(status: string): boolean {
  return ['CREATED', 'PICKED_UP', 'IN_TRANSIT', 'DELIVERED', 'CANCELLED', 'FAILED', 'UNKNOWN'].includes(status);
}

export class OrderService {
  constructor(private readonly registry = courierRegistry) {}

  async create(input: CreateOrderInput, requestId: string): Promise<{ order: PublicOrder; idempotent: boolean }> {
    const adapter = this.registry.get(input.courier_partner);
    const existing = findOrderById(input.order_id);
    if (existing) {
      ensureSameRequest(existing, input);
      return { order: toPublicOrder(existing), idempotent: true };
    }

    const id = randomUUID();
    const timestamp = now();
    const leaseUntil = new Date(Date.now() + Math.max(config.COURIER_TIMEOUT_MS * (config.COURIER_RETRY_COUNT + 1) * 2, 60_000)).toISOString();
    const insert = db.prepare(`
      INSERT OR IGNORE INTO orders
        (id, order_id, courier_partner, request_id, status, request_payload, lease_until, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'PROCESSING', ?, ?, ?, ?)
    `).run(id, input.order_id, input.courier_partner, requestId, json(input), leaseUntil, timestamp, timestamp);
    if (insert.changes === 0) {
      const raced = findOrderById(input.order_id);
      if (!raced) throw new ApiError(500, 'PERSISTENCE_ERROR', 'Could not create order record');
      ensureSameRequest(raced, input);
      return { order: toPublicOrder(raced), idempotent: true };
    }

    try {
      await this.dispatchCreate(id, input, adapter);
    } catch (error) {
      const row = findOrderByPk(id);
      if (row) {
        const normalized = this.normalizeCourierError(error);
        throw new ApiError(502, normalized.code, normalized.message, { order_id: input.order_id });
      }
      throw error;
    }
    const saved = findOrderByPk(id);
    if (!saved) throw new ApiError(500, 'PERSISTENCE_ERROR', 'Could not retrieve created order');
    return { order: toPublicOrder(saved), idempotent: false };
  }

  enqueueBatch(inputs: CreateOrderInput[], requestId: string): string {
    const batchId = randomUUID();
    const timestamp = now();
    const transaction = db.transaction(() => {
      db.prepare('INSERT INTO batches (id, created_at) VALUES (?, ?)').run(batchId, timestamp);
      inputs.forEach((input, index) => {
        let row = findOrderById(input.order_id);
        if (row) {
          if (row.courier_partner !== input.courier_partner || row.request_payload !== json(input)) {
            db.prepare(`
              INSERT INTO batch_items (id, batch_id, item_index, order_pk, error_code, error_message, created_at)
              VALUES (?, ?, ?, ?, 'IDEMPOTENCY_CONFLICT', 'order_id already exists with a different request', ?)
            `).run(randomUUID(), batchId, index, row.id, timestamp);
            logger.warn({ order_id: input.order_id, courier_partner: input.courier_partner, request_id: requestId, error_type: 'IdempotencyConflict' }, 'Bulk item conflicts with an existing order');
            return;
          }
        } else {
          const orderPk = randomUUID();
          let unsupportedCourier = false;
          try {
            this.registry.get(input.courier_partner);
          } catch (error) {
            if (!(error instanceof ApiError) || error.code !== 'UNSUPPORTED_COURIER') throw error;
            unsupportedCourier = true;
          }
          db.prepare(`
            INSERT OR IGNORE INTO orders
              (id, order_id, courier_partner, request_id, status, request_payload, error_code, error_message, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            orderPk,
            input.order_id,
            input.courier_partner,
            requestId,
            unsupportedCourier ? 'FAILED' : 'QUEUED',
            json(input),
            unsupportedCourier ? 'UNSUPPORTED_COURIER' : null,
            unsupportedCourier ? 'Unsupported courier_partner' : null,
            timestamp,
            timestamp,
          );
          row = findOrderById(input.order_id);
          if (!row) throw new ApiError(500, 'PERSISTENCE_ERROR', 'Could not queue order');
          if (unsupportedCourier) {
            db.prepare(`
              INSERT INTO tracking_events (id, order_pk, status, occurred_at, raw_payload)
              VALUES (?, ?, 'FAILED', ?, ?)
            `).run(randomUUID(), row.id, timestamp, json({ code: 'UNSUPPORTED_COURIER' }));
            logger.warn({ order_id: input.order_id, courier_partner: input.courier_partner, request_id: requestId, error_type: 'UnknownCourier' }, 'Bulk item uses an unsupported courier');
          }
        }
        db.prepare(`
          INSERT INTO batch_items (id, batch_id, item_index, order_pk, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(randomUUID(), batchId, index, row.id, timestamp);
      });
    });
    transaction();
    return batchId;
  }

  get(orderId: string): PublicOrder {
    const row = findOrderById(orderId);
    if (!row) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order was not found');
    return toPublicOrder(row);
  }

  async getTracking(orderId: string, requestId: string, courierPartner?: string): Promise<{ order: PublicOrder; history: unknown[] }> {
    const row = findOrderById(orderId);
    if (!row) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order was not found');
    if (courierPartner !== undefined) this.assertCourierMatches(row, courierPartner);
    if (!row.courier_shipment_id && !row.awb && row.status !== 'FAILED') {
      throw new ApiError(409, 'SHIPMENT_NOT_READY', 'Shipment has no courier reference yet');
    }
    const adapter = this.registry.get(row.courier_partner);
    try {
      const result = await this.withRetry(async () => {
        await adapter.authenticate();
        return adapter.getStatus(referenceFrom(row));
      });
      this.recordStatus(row, 'tracking', result.status, result.requestPayload, result.responsePayload);
    } catch (error) {
      this.logFailure(row, requestId, error, 'tracking');
      this.persistOperationFailure(row, error, 'tracking');
      throw this.asApiError(error, 'TRACKING_FAILED');
    }
    const updated = findOrderByPk(row.id);
    const events = db.prepare(`
      SELECT status, occurred_at, raw_payload FROM tracking_events
      WHERE order_pk = ? ORDER BY occurred_at ASC, rowid ASC
    `).all(row.id) as Array<{ status: string; occurred_at: string; raw_payload: string }>;
    return {
      order: updated ? toPublicOrder(updated) : toPublicOrder(row),
      history: events.map((event) => ({ ...event, raw_payload: JSON.parse(event.raw_payload) as unknown })),
    };
  }

  async cancel(orderId: string, requestId: string, courierPartner: string): Promise<PublicOrder> {
    const row = findOrderById(orderId);
    if (!row) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order was not found');
    this.assertCourierMatches(row, courierPartner);
    const adapter = this.registry.get(row.courier_partner);
    try {
      const result = await this.withRetry(async () => {
        await adapter.authenticate();
        return adapter.cancelShipment(referenceFrom(row));
      });
      this.recordStatus(row, 'cancel', result.status, result.requestPayload, result.responsePayload);
    } catch (error) {
      this.logFailure(row, requestId, error, 'cancel');
      this.persistOperationFailure(row, error, 'cancel');
      throw this.asApiError(error, 'CANCELLATION_FAILED');
    }
    const updated = findOrderByPk(row.id);
    if (!updated) throw new ApiError(500, 'PERSISTENCE_ERROR', 'Could not retrieve cancelled order');
    return toPublicOrder(updated);
  }

  getBatch(batchId: string): Record<string, unknown> {
    const batch = db.prepare('SELECT id, created_at FROM batches WHERE id = ?').get(batchId) as { id: string; created_at: string } | undefined;
    if (!batch) throw new ApiError(404, 'BATCH_NOT_FOUND', 'Batch was not found');
    const rows = db.prepare(`
      SELECT bi.item_index, bi.error_code AS batch_error_code,
        bi.error_message AS batch_error_message, o.* FROM batch_items bi
      JOIN orders o ON o.id = bi.order_pk
      WHERE bi.batch_id = ? ORDER BY bi.item_index ASC
    `).all(batchId) as Array<OrderRow & {
      item_index: number;
      batch_error_code: string | null;
      batch_error_message: string | null;
    }>;
    const complete = rows.length > 0 && rows.every((row) => row.batch_error_code !== null || statusIsTerminal(row.status));
    const counts = rows.reduce<Record<string, number>>((result, row) => {
      const status = row.batch_error_code ? 'FAILED' : row.status;
      result[status] = (result[status] ?? 0) + 1;
      return result;
    }, {});
    return {
      batch_id: batch.id,
      status: complete ? 'COMPLETED' : 'PROCESSING',
      created_at: batch.created_at,
      total: rows.length,
      counts,
      results: rows.map((row) => row.batch_error_code
        ? {
          item_index: row.item_index,
          order_id: row.order_id,
          status: 'FAILED',
          error: { code: row.batch_error_code, message: row.batch_error_message },
        }
        : { item_index: row.item_index, order: toPublicOrder(row) }),
    };
  }

  claimQueued(limit: number): string[] {
    const timestamp = now();
    const leaseUntil = new Date(Date.now() + Math.max(config.COURIER_TIMEOUT_MS * 3, 60_000)).toISOString();
    const transaction = db.transaction(() => {
      const candidates = db.prepare(`
        SELECT id FROM orders
        WHERE status = 'QUEUED' OR (status = 'PROCESSING' AND lease_until < ?)
        ORDER BY created_at ASC LIMIT ?
      `).all(timestamp, limit) as Array<{ id: string }>;
      const claimed: string[] = [];
      const update = db.prepare(`
        UPDATE orders SET status = 'PROCESSING', lease_until = ?, updated_at = ?
        WHERE id = ? AND (status = 'QUEUED' OR (status = 'PROCESSING' AND lease_until < ?))
      `);
      for (const row of candidates) {
        const result = update.run(leaseUntil, timestamp, row.id, timestamp);
        if (result.changes > 0) claimed.push(row.id);
      }
      return claimed;
    });
    return transaction();
  }

  async processQueued(id: string): Promise<void> {
    const row = findOrderByPk(id);
    if (!row) return;
    try {
      const input = createOrderSchema.parse(JSON.parse(row.request_payload) as unknown);
      const adapter = this.registry.get(row.courier_partner);
      await this.dispatchCreate(id, input, adapter);
    } catch (error) {
      if (!(error instanceof CourierError)) {
        this.logFailure(row, row.request_id, error, 'bulk-create');
        this.persistOperationFailure(row, error, 'create');
      }
    }
  }

  private async dispatchCreate(id: string, input: CreateOrderInput, adapter: CourierAdapter): Promise<void> {
    let latestError: unknown;
    for (let attempt = 0; attempt <= config.COURIER_RETRY_COUNT; attempt += 1) {
      try {
        await adapter.authenticate();
        const result = await adapter.createShipment(input);
        const timestamp = now();
        const transaction = db.transaction(() => {
          db.prepare(`
            UPDATE orders SET courier_shipment_id = ?, awb = ?, status = ?,
              courier_request = ?, courier_response = ?, error_code = NULL,
              error_message = NULL, retry_count = ?, lease_until = NULL, updated_at = ?
            WHERE id = ?
          `).run(
            result.courierShipmentId,
            result.awb,
            result.status,
            json(result.requestPayload),
            json(result.responsePayload),
            attempt,
            timestamp,
            id,
          );
          db.prepare(`
            INSERT INTO courier_operations (id, order_pk, operation, request_payload, response_payload, occurred_at)
            VALUES (?, ?, 'create', ?, ?, ?)
          `).run(randomUUID(), id, json(result.requestPayload), json(result.responsePayload), timestamp);
          db.prepare(`
            INSERT INTO tracking_events (id, order_pk, status, occurred_at, raw_payload)
            VALUES (?, ?, ?, ?, ?)
          `).run(randomUUID(), id, result.status, timestamp, json(result.responsePayload));
        });
        transaction();
        return;
      } catch (error) {
        latestError = error;
        const courierError = error instanceof CourierError
          ? error
          : new CourierError('COURIER_ERROR', 'Courier request failed', false);
        const failedAt = now();
        db.transaction(() => {
          db.prepare(`
            UPDATE orders SET courier_request = ?, courier_response = ?, retry_count = ?, updated_at = ?
            WHERE id = ?
          `).run(
            json(courierError.requestPayload),
            json(courierError.responsePayload),
            attempt,
            failedAt,
            id,
          );
          db.prepare(`
            INSERT INTO courier_operations (id, order_pk, operation, request_payload, response_payload, error_code, occurred_at)
            VALUES (?, ?, 'create', ?, ?, ?, ?)
          `).run(randomUUID(), id, json(courierError.requestPayload), json(courierError.responsePayload), courierError.code, failedAt);
        })();
        if (!courierError.retryable || attempt >= config.COURIER_RETRY_COUNT) break;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, config.COURIER_RETRY_BASE_DELAY_MS * (2 ** attempt)));
      }
    }

    const row = findOrderByPk(id);
    const failure = this.normalizeCourierError(latestError);
    const timestamp = now();
    db.transaction(() => {
      db.prepare(`
        UPDATE orders SET status = 'FAILED', error_code = ?, error_message = ?, lease_until = NULL, updated_at = ?
        WHERE id = ?
      `).run(failure.code, failure.message, timestamp, id);
      db.prepare(`
        INSERT INTO tracking_events (id, order_pk, status, occurred_at, raw_payload)
        VALUES (?, ?, 'FAILED', ?, ?)
      `).run(randomUUID(), id, timestamp, json({ code: failure.code }));
    })();
    if (row) this.logFailure(row, row.request_id, latestError, 'create');
    throw latestError;
  }

  private recordStatus(row: OrderRow, operation: 'tracking' | 'cancel', status: ShipmentStatus, requestPayload: unknown, responsePayload: unknown): void {
    const timestamp = now();
    db.transaction(() => {
      db.prepare(`
        UPDATE orders SET status = ?, courier_request = ?, courier_response = ?, error_code = NULL,
          error_message = NULL, updated_at = ? WHERE id = ?
      `).run(status, json(requestPayload), json(responsePayload), timestamp, row.id);
      db.prepare(`
        INSERT INTO tracking_events (id, order_pk, status, occurred_at, raw_payload)
        VALUES (?, ?, ?, ?, ?)
      `).run(randomUUID(), row.id, status, timestamp, json(responsePayload));
      db.prepare(`
        INSERT INTO courier_operations (id, order_pk, operation, request_payload, response_payload, occurred_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), row.id, operation, json(requestPayload), json(responsePayload), timestamp);
    })();
  }

  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        const retryable = error instanceof CourierError && error.retryable;
        if (!retryable || attempt >= config.COURIER_RETRY_COUNT) throw error;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, config.COURIER_RETRY_BASE_DELAY_MS * (2 ** attempt)));
      }
    }
  }

  private normalizeCourierError(error: unknown): { code: string; message: string } {
    if (error instanceof CourierError) {
      if (error.providerStatus === 429) return { code: 'COURIER_RATE_LIMITED', message: 'Courier rate limit exceeded' };
      if (error.providerStatus && error.providerStatus >= 400 && error.providerStatus < 500) {
        return { code: 'COURIER_REJECTED_REQUEST', message: 'Courier rejected the shipment request' };
      }
      if (error.code === 'COURIER_TIMEOUT') return { code: 'COURIER_TIMEOUT', message: 'Courier request timed out' };
      if (error.code === 'COURIER_NOT_CONFIGURED') return { code: error.code, message: 'Courier integration is not configured' };
      if (error.retryable || (error.providerStatus !== undefined && error.providerStatus >= 500)) {
        return { code: 'COURIER_UNAVAILABLE', message: 'Courier service is temporarily unavailable' };
      }
      return { code: error.code, message: error.message };
    }
    return { code: 'COURIER_ERROR', message: 'Courier request failed' };
  }

  private asApiError(error: unknown, fallback: string): ApiError {
    const normalized = this.normalizeCourierError(error);
    return new ApiError(502, normalized.code || fallback, normalized.message);
  }

  private logFailure(row: OrderRow, requestId: string, error: unknown, operation: string): void {
    const normalized = this.normalizeCourierError(error);
    logger.error({
      order_id: row.order_id,
      courier_partner: row.courier_partner,
      request_id: requestId,
      error_type: error instanceof Error ? error.name : typeof error,
      error_code: normalized.code,
      operation,
      stack: error instanceof Error ? error.stack : undefined,
    }, 'Courier operation failed');
  }

  private persistOperationFailure(row: OrderRow, error: unknown, operation: 'create' | 'tracking' | 'cancel'): void {
    const normalized = this.normalizeCourierError(error);
    const response = error instanceof CourierError ? error.responsePayload : null;
    const request = error instanceof CourierError ? error.requestPayload : null;
    const timestamp = now();
    db.transaction(() => {
      db.prepare(`
        UPDATE orders SET error_code = ?, error_message = ?, courier_request = ?, courier_response = ?, updated_at = ? WHERE id = ?
      `).run(normalized.code, normalized.message, json(request), json(response), timestamp, row.id);
      db.prepare(`
        INSERT INTO courier_operations (id, order_pk, operation, request_payload, response_payload, error_code, occurred_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(randomUUID(), row.id, operation, json(request), json(response), normalized.code, timestamp);
    })();
  }

  private assertCourierMatches(row: OrderRow, courierPartner: string): void {
    this.registry.get(courierPartner);
    if (row.courier_partner !== courierPartner) {
      throw new ApiError(400, 'COURIER_PARTNER_MISMATCH', 'courier_partner does not match the saved order');
    }
  }
}

export const orderService = new OrderService();