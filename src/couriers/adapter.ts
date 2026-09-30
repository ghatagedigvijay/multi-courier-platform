import type { CreateOrderInput, ShipmentStatus } from '../domain.js';

export interface CourierOrderReference {
  orderId: string;
  courierShipmentId: string | null;
  awb: string | null;
}

export interface CourierCreateResult {
  courierShipmentId: string | null;
  awb: string | null;
  status: ShipmentStatus;
  requestPayload: unknown;
  responsePayload: unknown;
}

export interface CourierStatusResult {
  status: ShipmentStatus;
  requestPayload: unknown;
  responsePayload: unknown;
}

export interface CourierAdapter {
  readonly code: string;
  authenticate(): Promise<void>;
  createShipment(input: CreateOrderInput): Promise<CourierCreateResult>;
  getStatus(reference: CourierOrderReference): Promise<CourierStatusResult>;
  cancelShipment(reference: CourierOrderReference): Promise<CourierStatusResult>;
}