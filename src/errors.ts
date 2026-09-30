export type ErrorDetails = Record<string, unknown>;

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: ErrorDetails,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export class CourierError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
    public readonly requestPayload?: unknown,
    public readonly responsePayload?: unknown,
    public readonly providerStatus?: number,
  ) {
    super(message);
    this.name = 'CourierError';
  }
}