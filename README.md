# Multi-Courier Integration Platform

Courier-agnostic REST API with UrbaneBolt and mock adapters. Consumers submit a normalized shipment model and identify the requested carrier with `courier_partner`.

## Requirements

- Node.js 22.5 or newer
- npm

## Run

```powershell
npm install
Copy-Item .env.example .env
npm run dev
```

The API listens on `http://localhost:3000`. It creates the SQLite database at `./data/couriers.sqlite`. Set `API_KEY` in `.env` to require `x-api-key` on `/api/v1` routes; it is mandatory when `NODE_ENV=production`.

```powershell
npm test
npm run typecheck
npm run build
npm start
```

## Environment

| Variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | HTTP port | `3000` |
| `DATABASE_PATH` | SQLite file path | `./data/couriers.sqlite` |
| `API_KEY` | Optional development API key; required in production | empty |
| `BULK_CONCURRENCY` | Maximum concurrent bulk shipments | `5` |
| `COURIER_TIMEOUT_MS` | Per-request courier timeout | `10000` |
| `COURIER_RETRY_COUNT` | Retries after transient courier failures | `2` |
| `COURIER_RETRY_BASE_DELAY_MS` | Exponential backoff base | `250` |
| `URBANEBOLT_BASE_URL` | UrbaneBolt UAT base URL | `https://uat.urbanebolt.in` |
| `URBANEBOLT_USERNAME` / `URBANEBOLT_PASSWORD` | Credentials supplied by UrbaneBolt | empty |
| `URBANEBOLT_AUTH_PATH` | Token endpoint | `/api/v1/auth/getToken/` |
| `URBANEBOLT_CREATE_PATH` | Verified manifest/create endpoint path | required to use UrbaneBolt |
| `URBANEBOLT_TRACK_PATH` | Verified tracking endpoint path | required to use UrbaneBolt |
| `URBANEBOLT_CANCEL_PATH` | Verified cancellation endpoint path | required to use UrbaneBolt |

Never commit `.env` or real partner credentials. Logs redact common credential fields. Configure a production secret manager and TLS termination before deployment.

## API

All endpoints use `/api/v1`. Errors use `{ "error": { "code", "message", "request_id", "details?" } }`. Success responses use a `data` envelope. Pass a unique consumer `order_id`; it is the global idempotency key in this reference implementation. Reusing the same ID and payload returns the original result; changing the payload returns `409 IDEMPOTENCY_CONFLICT`.

- `GET /health`: process health check.
- `GET /api/v1/couriers`: registered courier identifiers.
- `POST /api/v1/orders`: create one shipment; returns `201`, or `200` for an identical idempotent retry.
- `GET /api/v1/orders/{order_id}`: saved order state.
- `GET /api/v1/orders/{order_id}/tracking?courier_partner=mock`: refresh from the courier and return append-only history.
- `POST /api/v1/orders/{order_id}/cancel`: request cancellation with `{ "courier_partner": "mock" }`.
- `POST /api/v1/orders/bulk`: enqueue up to 100 orders and return `202` with a `batch_id`.
- `GET /api/v1/batches/{batch_id}`: batch progress and per-order outcomes.

Create-order payload:

```json
{
  "order_id": "OMS-10001",
  "courier_partner": "mock",
  "shipment": {
    "pickup": { "name": "Warehouse", "phone": "9876543210", "address_line1": "1 Warehouse Road", "city": "Gurugram", "state": "Haryana", "postal_code": "122001", "country": "IN" },
    "delivery": { "name": "Customer", "phone": "9876543211", "address_line1": "2 Market Road", "city": "Delhi", "state": "Delhi", "postal_code": "110001", "country": "IN" },
    "package": { "weight_kg": 1.2, "length_cm": 20, "width_cm": 15, "height_cm": 10, "declared_value": 1250 },
    "payment_mode": "PREPAID",
    "currency": "INR",
    "items": [{ "name": "Sample item", "quantity": 1, "unit_price": 1250 }]
  }
}
```

For COD shipments, provide `cod_amount`. A bulk body is `{ "orders": [<create-order>, ...] }`; each item can select a different courier. The worker claims durable queued orders and processes them with bounded concurrency. Poll the returned `status_url` for individual results. See `postman/collection.json` for all routes.

## UrbaneBolt Integration Note

The public Postman reference confirms token authentication at `/api/v1/auth/getToken/` and lists Manifest, Tracking, and Cancellation operations. Its readable documentation extract did not expose those operations' complete schemas. Their endpoint paths must be configured from the full UrbaneBolt UAT collection; the adapter refuses to send these operations while a path is unset. Also verify exact payload fields, token response shape/expiry, status values, and AWB fields before using real credentials. The documented sample credentials are intentionally not used.

Token responses may expose `access_token`, `token`, `access`, or `key`; the adapter refreshes once after an HTTP 401. Courier 5xx, 429, network, and timeout failures are retried with exponential backoff, persisted, and returned using normalized errors. Verify UrbaneBolt's idempotency behavior before production retries: an ambiguous timeout may have created a remote shipment even when no response arrived.

## Add a Courier

Implement `CourierAdapter` in `src/couriers`, mapping the normalized `CreateOrderInput` and provider responses. Register the instance in `src/couriers/registry.ts`. Routes, persistence, bulk processing, and public DTOs should not need changes. Add tests for request mapping, auth, status normalization, provider failures, and cancellation. `MockCourierAdapter` is an executable reference.

## Design Notes

See [`DESIGN.md`](DESIGN.md) for the adapter pattern, database schema, concurrency strategy, and trade-offs.