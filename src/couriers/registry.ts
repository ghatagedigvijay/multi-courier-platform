import { ApiError } from '../errors.js';
import type { CourierAdapter } from './adapter.js';
import { MockCourierAdapter } from './mock-courier.js';
import { UrbaneBoltAdapter } from './urbanebolt.js';

export class CourierRegistry {
  private readonly adapters = new Map<string, CourierAdapter>();

  constructor(adapters: CourierAdapter[]) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: CourierAdapter): void {
    const code = adapter.code.trim().toLowerCase();
    if (!code || this.adapters.has(code)) throw new Error(`Courier adapter is invalid or already registered: ${code}`);
    this.adapters.set(code, adapter);
  }

  get(code: string): CourierAdapter {
    const adapter = this.adapters.get(code.trim().toLowerCase());
    if (!adapter) {
      throw new ApiError(400, 'UNSUPPORTED_COURIER', 'Unsupported courier_partner', {
        supported_couriers: this.supportedCouriers(),
      });
    }
    return adapter;
  }

  supportedCouriers(): string[] {
    return [...this.adapters.keys()].sort();
  }
}

export const courierRegistry = new CourierRegistry([
  new UrbaneBoltAdapter(),
  new MockCourierAdapter(),
]);