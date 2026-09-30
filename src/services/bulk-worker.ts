import { config } from '../config.js';
import { logger } from '../logger.js';
import { orderService } from './order-service.js';

export class BulkWorker {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly pollIntervalMs = 400) {}

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.pollIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const ids = orderService.claimQueued(config.BULK_CONCURRENCY);
      await Promise.all(ids.map((id) => orderService.processQueued(id)));
    } catch (error) {
      logger.error({ error }, 'Bulk worker iteration failed');
    } finally {
      this.running = false;
    }
  }
}