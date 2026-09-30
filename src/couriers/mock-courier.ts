import type { CreateOrderInput } from '../domain.js';
import { normalizeStatus } from '../domain.js';
import type { CourierAdapter, CourierCreateResult, CourierOrderReference, CourierStatusResult } from './adapter.js';

export class MockCourierAdapter implements CourierAdapter {
  readonly code = 'mock';

  async authenticate(): Promise<void> {}

  async createShipment(input: CreateOrderInput): Promise<CourierCreateResult> {
    const requestPayload = {
      reference: input.order_id,
      destination: input.shipment.delivery,
      package: input.shipment.package,
    };
    return {
      courierShipmentId: `mock-${input.order_id}`,
      awb: `MOCK${input.order_id.replace(/[^a-z0-9]/gi, '').toUpperCase()}`,
      status: 'CREATED',
      requestPayload,
      responsePayload: {
        shipment_id: `mock-${input.order_id}`,
        awb: `MOCK${input.order_id.replace(/[^a-z0-9]/gi, '').toUpperCase()}`,
        status: 'BOOKED',
      },
    };
  }

  async getStatus(reference: CourierOrderReference): Promise<CourierStatusResult> {
    const responsePayload = { status: 'IN_TRANSIT', awb: reference.awb };
    return { status: normalizeStatus(responsePayload.status), requestPayload: reference, responsePayload };
  }

  async cancelShipment(reference: CourierOrderReference): Promise<CourierStatusResult> {
    const responsePayload = { status: 'CANCELLED', shipment_id: reference.courierShipmentId };
    return { status: 'CANCELLED', requestPayload: reference, responsePayload };
  }
}