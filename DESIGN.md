# Design

## Architecture

Express routes validate a courier-neutral DTO with Zod and call `OrderService`. The service performs idempotency checks, persistence, retries, normalized status updates, and audit logging. `CourierRegistry` selects an implementation of `CourierAdapter` by `courier_partner`; UrbaneBolt and Mock are separate adapters. Adding a provider means implementing and registering an adapter, without changing routes or DTOs.

The adapter pattern isolates provider authentication, field mapping, HTTP calls, and response normalization. The service depends on the interface, not on UrbaneBolt. `CourierError` distinguishes retryable upstream failures from provider rejections; Express middleware emits one error envelope and never forwards the raw provider response to consumers.

## Persistence

- `orders`: internal UUID, unique consumer `order_id`, courier, courier shipment ID, AWB, current status, normalized input, last outbound request/response, normalized error, retry count, lease, and timestamps.
- `tracking_events`: append-only status, timestamp, and raw provider response, keyed to an order.
- `batches`: batch ID and creation timestamp.
- `batch_items`: input index and order reference, preserving an outcome for each submitted item.

The reference implementation treats `order_id` as globally unique. Multi-tenant deployments should scope uniqueness by account, add authorization/tenant data to every query, and migrate to a unique `(account_id, order_id)` key.

## Bulk and Retries

Bulk create validates the whole envelope, records the batch/items/orders, and immediately returns `202` plus a batch ID. A polling worker atomically claims queued rows in SQLite and processes up to `BULK_CONCURRENCY` shipments concurrently. A lease allows abandoned jobs to be reclaimed after process failure. Consumers poll the batch endpoint to receive per-item status and failure details.

This avoids 100 sequential provider calls within one HTTP request and survives process restarts. SQLite is appropriate for a self-contained assignment/demo, but permits only one local writer and is not a multi-host job queue. A horizontally scaled deployment should use PostgreSQL with a transactional outbox/job queue and worker leases, plus migrations and operational monitoring. Retries use configurable exponential backoff. Remote exactly-once creation cannot be guaranteed after an ambiguous network timeout unless the provider supports idempotency or a reconciliation lookup.

Tracking reads call the provider and append a history event for each successful response. Scheduled polling and provider webhooks are intentionally not included because the assignment does not specify webhook support or polling cadence.

## Trade-offs and Assumptions

- `order_id` is the consumer's idempotency key and globally unique in this implementation.
- Batch completion means every referenced order reached a terminal status; per-order failure does not fail the batch as a whole.
- Provider error bodies are retained internally for audit/debugging but not returned in API errors.
- The UrbaneBolt public collection confirms the token endpoint and operation names, but the exposed reference did not provide complete payloads. Verify provider endpoint paths and mappings before live UAT; configuration and adapter boundaries localize that work.
- `API_KEY` is a small internal-service guard, not a substitute for user/tenant authentication, authorization, rotation, rate limits, or secret management.