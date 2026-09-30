import { CourierError } from '../errors.js';
import type { CourierAdapter, CourierCreateResult, CourierOrderReference, CourierStatusResult } from './adapter.js';

export class UrbaneBoltAdapter implements CourierAdapter {
  readonly code = 'urbanebolt';

  async authenticate(): Promise<void> {
    throw this.contractUnavailable('authentication');
  }

  async createShipment(_input: Parameters<CourierAdapter['createShipment']>[0]): Promise<CourierCreateResult> {
    throw this.contractUnavailable('create shipment');
  }

  async getStatus(_reference: CourierOrderReference): Promise<CourierStatusResult> {
    throw this.contractUnavailable('tracking');
  }

  async cancelShipment(_reference: CourierOrderReference): Promise<CourierStatusResult> {
    throw this.contractUnavailable('cancellation');
  }

  private contractUnavailable(operation: string): CourierError {
    return new CourierError(
      'COURIER_NOT_CONFIGURED',
      `UrbaneBolt ${operation} is unavailable until its verified API contract is configured`,
      false,
    );
  }
}