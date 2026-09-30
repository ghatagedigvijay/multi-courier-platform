import { randomUUID, timingSafeEqual } from 'node:crypto';
import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import helmet from 'helmet';
import { config } from './config.js';
import { createOrderSchema, bulkCreateSchema, courierPartnerSchema } from './domain.js';
import { ApiError } from './errors.js';
import { courierRegistry } from './couriers/registry.js';
import { logger } from './logger.js';
import { orderService } from './services/order-service.js';

const requestContext: RequestHandler = (request, response, next) => {
  const requestedId = request.header('x-request-id');
  const requestId = requestedId && requestedId.length <= 128 ? requestedId : randomUUID();
  response.locals.requestId = requestId;
  response.setHeader('x-request-id', requestId);
  next();
};

const apiKeyGuard: RequestHandler = (request, _response, next) => {
  if (!config.API_KEY) return next();
  const supplied = request.header('x-api-key') ?? '';
  const expectedBuffer = Buffer.from(config.API_KEY);
  const suppliedBuffer = Buffer.from(supplied);
  if (expectedBuffer.length !== suppliedBuffer.length || !timingSafeEqual(expectedBuffer, suppliedBuffer)) {
    return next(new ApiError(401, 'UNAUTHORIZED', 'A valid x-api-key is required'));
  }
  next();
};

function fieldErrors(issues: Array<{ path: PropertyKey[]; message: string }>): Array<{ field: string; message: string }> {
  return issues.map((issue) => ({ field: issue.path.map(String).join('.'), message: issue.message }));
}

export const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(requestContext);
app.use(express.json({ limit: '1mb' }));
app.get('/health', (_request, response) => response.json({ status: 'ok' }));
app.use('/api/v1', apiKeyGuard);

app.get('/api/v1/couriers', (_request, response) => {
  response.json({ data: { supported_couriers: courierRegistry.supportedCouriers() } });
});

app.post('/api/v1/orders', async (request, response, next) => {
  const parsed = createOrderSchema.safeParse(request.body);
  if (!parsed.success) return next(new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed', { fields: fieldErrors(parsed.error.issues) }));
  try {
    const result = await orderService.create(parsed.data, response.locals.requestId as string);
    response.status(result.idempotent ? 200 : 201).json({ data: result.order, idempotent: result.idempotent });
  } catch (error) {
    next(error);
  }
});

app.get('/api/v1/orders/:orderId', (request, response, next) => {
  try {
    response.json({ data: orderService.get(request.params.orderId) });
  } catch (error) {
    next(error);
  }
});

const trackingHandler: RequestHandler = async (request, response, next) => {
  let courierPartner: string | undefined;
  if (request.query.courier_partner !== undefined) {
    const parsed = courierPartnerSchema.safeParse({ courier_partner: request.query.courier_partner });
    if (!parsed.success) return next(new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed', { fields: fieldErrors(parsed.error.issues) }));
    courierPartner = parsed.data.courier_partner;
  }
  try {
    const result = await orderService.getTracking(String(request.params.orderId), response.locals.requestId as string, courierPartner);
    response.json({ data: result });
  } catch (error) {
    next(error);
  }
};
app.get('/api/v1/orders/:orderId/track', trackingHandler);
app.get('/api/v1/orders/:orderId/tracking', trackingHandler);

app.post('/api/v1/orders/:orderId/cancel', async (request, response, next) => {
  const parsed = courierPartnerSchema.safeParse(request.body);
  if (!parsed.success) return next(new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed', { fields: fieldErrors(parsed.error.issues) }));
  try {
    const order = await orderService.cancel(request.params.orderId, response.locals.requestId as string, parsed.data.courier_partner);
    response.json({ data: order });
  } catch (error) {
    next(error);
  }
});

app.post('/api/v1/orders/bulk', (request, response, next) => {
  const parsed = bulkCreateSchema.safeParse(request.body);
  if (!parsed.success) return next(new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed', { fields: fieldErrors(parsed.error.issues) }));
  try {
    const batchId = orderService.enqueueBatch(parsed.data.orders, response.locals.requestId as string);
    response.status(202).json({ data: { batch_id: batchId, status: 'PROCESSING', status_url: `/api/v1/batches/${batchId}` } });
  } catch (error) {
    next(error);
  }
});

app.get('/api/v1/batches/:batchId', (request, response, next) => {
  try {
    response.json({ data: orderService.getBatch(request.params.batchId) });
  } catch (error) {
    next(error);
  }
});

app.use((_request, _response, next) => next(new ApiError(404, 'NOT_FOUND', 'Endpoint was not found')));

const errorHandler: ErrorRequestHandler = (error: unknown, request, response, _next) => {
  const requestId = response.locals.requestId as string;
  if (error instanceof ApiError) {
    response.status(error.statusCode).json({
      error: {
        code: error.code,
        message: error.message,
        request_id: requestId,
        ...(error.details ? { details: error.details } : {}),
      },
    });
    return;
  }

  const parseError = error instanceof SyntaxError && 'body' in error;
  const statusCode = parseError ? 400 : 500;
  const code = parseError ? 'INVALID_JSON' : 'INTERNAL_ERROR';
  logger.error({ request_id: requestId, method: request.method, path: request.path, error }, 'Unhandled API error');
  response.status(statusCode).json({ error: { code, message: parseError ? 'Request body must be valid JSON' : 'An unexpected error occurred', request_id: requestId } });
};

app.use(errorHandler);