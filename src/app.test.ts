import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, it } from 'node:test';
import request from 'supertest';
import { app } from './app.js';
import { courierRegistry } from './couriers/registry.js';
import type { CourierAdapter, CourierCreateResult, CourierOrderReference, CourierStatusResult } from './couriers/adapter.js';
import { db } from './db.js';
import { CourierError } from './errors.js';
import { BulkWorker } from './services/bulk-worker.js';

function order(orderId: string, courier = 'mock') {
  return {
    order_id: orderId,
    courier_partner: courier,
    shipment: {
      pickup: {
        name: 'Warehouse', phone: '9876543210', address_line1: '1 Warehouse Road',
        city: 'Gurugram', state: 'Haryana', postal_code: '122001', country: 'IN',
      },
      delivery: {
        name: 'Customer', phone: '9876543211', address_line1: '2 Market Road',
        city: 'Delhi', state: 'Delhi', postal_code: '110001', country: 'IN',
      },
      package: { weight_kg: 1.2, length_cm: 20, width_cm: 15, height_cm: 10, declared_value: 1250 },
      payment_mode: 'PREPAID', currency: 'INR',
      items: [{ name: 'Sample item', quantity: 1, unit_price: 1250 }],
    },
  };
}

describe('courier API', () => {
  it('creates an order once and returns the saved result for an idempotent retry', async () => {
    const input = order(`create-${randomUUID()}`);
    const first = await request(app).post('/api/v1/orders').send(input);
    const second = await request(app).post('/api/v1/orders').send(input);

    assert.equal(first.status, 201);
    assert.equal(first.body.data.status, 'CREATED');
    assert.equal(first.body.data.awb.startsWith('MOCK'), true);
    assert.equal(second.status, 200);
    assert.equal(second.body.idempotent, true);
    assert.equal(second.body.data.id, first.body.data.id);
  });

  it('prevents concurrent duplicate requests from creating two shipments', async () => {
    let createCalls = 0;
    const code = `concurrent-${randomUUID()}`;
    courierRegistry.register({
      code,
      async authenticate(): Promise<void> {},
      async createShipment(input): Promise<CourierCreateResult> {
        createCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 15));
        return {
          courierShipmentId: `shipment-${input.order_id}`,
          awb: `AWB-${input.order_id}`,
          status: 'CREATED',
          requestPayload: input,
          responsePayload: { accepted: true },
        };
      },
      async getStatus(_reference: CourierOrderReference): Promise<CourierStatusResult> {
        return { status: 'IN_TRANSIT', requestPayload: {}, responsePayload: {} };
      },
      async cancelShipment(_reference: CourierOrderReference): Promise<CourierStatusResult> {
        return { status: 'CANCELLED', requestPayload: {}, responsePayload: {} };
      },
    });
    const input = order(`concurrent-order-${randomUUID()}`, code);
    const [first, second] = await Promise.all([
      request(app).post('/api/v1/orders').send(input),
      request(app).post('/api/v1/orders').send(input),
    ]);

    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(createCalls, 1);
    assert.equal(first.body.data.id, second.body.data.id);
  });

  it('rejects idempotency-key reuse with a different payload', async () => {
    const input = order(`conflict-${randomUUID()}`);
    await request(app).post('/api/v1/orders').send(input).expect(201);
    const changed = { ...input, courier_partner: 'urbanebolt' };
    const response = await request(app).post('/api/v1/orders').send(changed).expect(409);
    assert.equal(response.body.error.code, 'IDEMPOTENCY_CONFLICT');
  });

  it('returns field-level validation errors and supported couriers', async () => {
    const invalid = await request(app).post('/api/v1/orders').send({ order_id: 'bad' }).expect(400);
    assert.equal(invalid.body.error.code, 'VALIDATION_ERROR');
    assert.ok(invalid.body.error.details.fields.length > 0);

    const unknown = await request(app).post('/api/v1/orders').send(order(`unknown-${randomUUID()}`, 'missing')).expect(400);
    assert.ok(unknown.body.error.details.supported_couriers.includes('mock'));
    assert.ok(unknown.body.error.details.supported_couriers.includes('urbanebolt'));
    assert.equal(unknown.body.error.request_id, unknown.headers['x-request-id']);
  });

  it('processes mixed batch items asynchronously and reports per-order results', async () => {
    const inputs = [order(`bulk-a-${randomUUID()}`), order(`bulk-b-${randomUUID()}`)];
    const accepted = await request(app).post('/api/v1/orders/bulk').send({ orders: inputs }).expect(202);
    assert.equal(accepted.body.data.status, 'PROCESSING');

    const worker = new BulkWorker(1);
    await worker.tick();
    const result = await request(app).get(accepted.body.data.status_url).expect(200);
    assert.equal(result.body.data.status, 'COMPLETED');
    assert.equal(result.body.data.total, 2);
    assert.deepEqual(result.body.data.results.map((item: { order: { status: string } }) => item.order.status), ['CREATED', 'CREATED']);
  });

  it('rejects bulk requests containing more than 100 orders', async () => {
    const inputs = Array.from({ length: 101 }, (_, index) => order(`bulk-limit-${index}-${randomUUID()}`));
    const response = await request(app).post('/api/v1/orders/bulk').send({ orders: inputs }).expect(400);
    assert.equal(response.body.error.code, 'VALIDATION_ERROR');
  });

  it('keeps conflicting and unsupported bulk items isolated while processing supported couriers', async () => {
    const existing = order(`bulk-existing-${randomUUID()}`);
    await request(app).post('/api/v1/orders').send(existing).expect(201);
    const conflicting = structuredClone(existing);
    conflicting.shipment.package.weight_kg = 2;

    const otherCourier = `bulk-provider-${randomUUID()}`;
    courierRegistry.register({
      code: otherCourier,
      async authenticate(): Promise<void> {},
      async createShipment(input): Promise<CourierCreateResult> {
        return {
          courierShipmentId: `shipment-${input.order_id}`,
          awb: `AWB-${input.order_id}`,
          status: 'CREATED',
          requestPayload: input,
          responsePayload: { created: true },
        };
      },
      async getStatus(_reference: CourierOrderReference): Promise<CourierStatusResult> {
        return { status: 'IN_TRANSIT', requestPayload: {}, responsePayload: {} };
      },
      async cancelShipment(_reference: CourierOrderReference): Promise<CourierStatusResult> {
        return { status: 'CANCELLED', requestPayload: {}, responsePayload: {} };
      },
    });
    const accepted = await request(app).post('/api/v1/orders/bulk').send({
      orders: [
        conflicting,
        order(`bulk-unknown-${randomUUID()}`, 'unsupported-provider'),
        order(`bulk-valid-${randomUUID()}`),
        order(`bulk-other-${randomUUID()}`, otherCourier),
      ],
    }).expect(202);
    await new BulkWorker(1).tick();
    const result = await request(app).get(accepted.body.data.status_url).expect(200);
    const outcomes = result.body.data.results;

    assert.equal(result.body.data.status, 'COMPLETED');
    assert.equal(outcomes[0].error.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(outcomes[1].order.error.code, 'UNSUPPORTED_COURIER');
    assert.equal(outcomes[2].order.status, 'CREATED');
    assert.equal(outcomes[3].order.status, 'CREATED');
  });

  it('retries transient courier errors and persists successful creation', async () => {
    let calls = 0;
    const code = `retry-${randomUUID()}`;
    const adapter: CourierAdapter = {
      code,
      async authenticate(): Promise<void> {},
      async createShipment(input): Promise<CourierCreateResult> {
        calls += 1;
        if (calls === 1) throw new CourierError('COURIER_TIMEOUT', 'timeout', true, input, null);
        return {
          courierShipmentId: `shipment-${input.order_id}`,
          awb: `AWB-${input.order_id}`,
          status: 'CREATED',
          requestPayload: input,
          responsePayload: { shipment_id: `shipment-${input.order_id}`, awb: `AWB-${input.order_id}` },
        };
      },
      async getStatus(_reference: CourierOrderReference): Promise<CourierStatusResult> {
        return { status: 'IN_TRANSIT', requestPayload: {}, responsePayload: { status: 'IN_TRANSIT' } };
      },
      async cancelShipment(_reference: CourierOrderReference): Promise<CourierStatusResult> {
        return { status: 'CANCELLED', requestPayload: {}, responsePayload: { status: 'CANCELLED' } };
      },
    };
    courierRegistry.register(adapter);

    const response = await request(app).post('/api/v1/orders').send(order(`retry-${randomUUID()}`, code)).expect(201);
    assert.equal(calls, 2);
    assert.equal(response.body.data.status, 'CREATED');
  });

  it('reports partial bulk failure with normalized provider errors', async () => {
    const code = `failure-${randomUUID()}`;
    const adapter: CourierAdapter = {
      code,
      async authenticate(): Promise<void> {},
      async createShipment(input): Promise<CourierCreateResult> {
        throw new CourierError('COURIER_HTTP_422', 'provider private error', false, input, { detail: 'private' }, 422);
      },
      async getStatus(_reference: CourierOrderReference): Promise<CourierStatusResult> {
        return { status: 'UNKNOWN', requestPayload: {}, responsePayload: {} };
      },
      async cancelShipment(_reference: CourierOrderReference): Promise<CourierStatusResult> {
        return { status: 'CANCELLED', requestPayload: {}, responsePayload: {} };
      },
    };
    courierRegistry.register(adapter);

    const inputs = [order(`partial-ok-${randomUUID()}`), order(`partial-fail-${randomUUID()}`, code)];
    const accepted = await request(app).post('/api/v1/orders/bulk').send({ orders: inputs }).expect(202);
    await new BulkWorker(1).tick();
    const result = await request(app).get(accepted.body.data.status_url).expect(200);
    const statuses = result.body.data.results.map((item: { order: { status: string } }) => item.order.status);
    const failure = result.body.data.results[1].order.error;

    assert.deepEqual(statuses, ['CREATED', 'FAILED']);
    assert.equal(failure.code, 'COURIER_REJECTED_REQUEST');
    assert.equal(JSON.stringify(result.body).includes('provider private error'), false);
    assert.equal(JSON.stringify(result.body).includes('private'), false);
  });

  it('appends tracking and cancellation status events', async () => {
    const input = order(`tracking-${randomUUID()}`);
    await request(app).post('/api/v1/orders').send(input).expect(201);
    await request(app).get(`/api/v1/orders/${input.order_id}/tracking?courier_partner=urbanebolt`).expect(400);
    const tracking = await request(app).get(`/api/v1/orders/${input.order_id}/track`).expect(200);
    assert.equal(tracking.body.data.order.status, 'IN_TRANSIT');
    assert.equal(tracking.body.data.history.length, 2);

    const cancelled = await request(app).post(`/api/v1/orders/${input.order_id}/cancel`).send({ courier_partner: 'mock' }).expect(200);
    assert.equal(cancelled.body.data.status, 'CANCELLED');
    const operationCount = db.prepare(`
      SELECT COUNT(*) AS count FROM courier_operations WHERE order_pk = ?
    `).get(tracking.body.data.order.id) as { count: number };
    assert.equal(operationCount.count, 3);
  });
});

after(() => db.close());