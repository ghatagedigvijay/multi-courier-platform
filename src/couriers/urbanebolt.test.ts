import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createOrderSchema } from '../domain.js';
import { CourierError } from '../errors.js';
import { UrbaneBoltAdapter } from './urbanebolt.js';

const testInput = createOrderSchema.parse({
  order_id: 'test-order-1',
  courier_partner: 'urbanebolt',
  shipment: {
    pickup: {
      name: 'Warehouse', phone: '9876543210', address_line1: '1 Warehouse Road',
      city: 'Gurugram', state: 'Haryana', postal_code: '122001', country: 'IN',
    },
    delivery: {
      name: 'Customer', phone: '9876543211', address_line1: '2 Market Road',
      city: 'Delhi', state: 'Delhi', postal_code: '110001', country: 'IN',
    },
    package: { weight_kg: 1, length_cm: 20, width_cm: 15, height_cm: 10, declared_value: 100 },
    payment_mode: 'PREPAID',
    items: [{ name: 'Test item', quantity: 1, unit_price: 100 }],
  },
});

describe('UrbaneBolt adapter', () => {
  it('fails closed for undocumented operations without making network requests', async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error('Unexpected network request');
    };
    const adapter = new UrbaneBoltAdapter();
    try {
      await assert.rejects(() => adapter.createShipment(testInput), (error: unknown) => error instanceof CourierError && error.code === 'COURIER_NOT_CONFIGURED');
      await assert.rejects(() => adapter.getStatus({ orderId: 'order-1', courierShipmentId: null, awb: null }), (error: unknown) => error instanceof CourierError && error.code === 'COURIER_NOT_CONFIGURED');
      await assert.rejects(() => adapter.cancelShipment({ orderId: 'order-1', courierShipmentId: null, awb: null }), (error: unknown) => error instanceof CourierError && error.code === 'COURIER_NOT_CONFIGURED');
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});
