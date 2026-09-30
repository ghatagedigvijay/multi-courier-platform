import { app } from './app.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { BulkWorker } from './services/bulk-worker.js';
import { db } from './db.js';

const worker = new BulkWorker();
const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, 'Courier API listening');
  worker.start();
});

function shutdown(signal: string): void {
  logger.info({ signal }, 'Shutting down courier API');
  worker.stop();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));