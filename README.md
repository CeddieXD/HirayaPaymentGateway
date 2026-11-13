# Hiraya Payment Gateway Sandbox

A standalone local payment-partner simulator for integration and checkout
testing. It validates payment requests, returns simulated outcomes and
references, supports correlation-ID idempotency, and exposes a health check.

> This is a development sandbox, not a real payment processor. It does not
> connect to GCash, Maya, banks, or card networks, and does not collect payment
> credentials or move money.

## Requirements

- Node.js 20.6 or newer (`--env-file` is used by the start command)

## Run locally

```powershell
Copy-Item .\.env.example .\.env
npm start
```

By default, the service binds to `127.0.0.1:3102` and simulates confirmed
payments. Set `SIMULATED_PAYMENT_OUTCOME` in `.env` to `CONFIRMED`, `PENDING`,
`FAILED`, or `UNAVAILABLE` to test other outcomes; restart the server after
changing it. The unavailable outcome returns HTTP 503.

Run the API tests with:

```powershell
npm test
```

## API

### `GET /health`

Returns the sandbox availability and environment. It does not create a
transaction.

### `POST /api/payments/initiate`

Send a JSON request with a matching `X-Correlation-Id` header:

```json
{
  "order_id": "MROYAL-1042",
  "external_order_id": "MROYAL-1042",
  "amount": 125.5,
  "currency": "PHP",
  "channel": "GCASH",
  "order_status": "PENDING",
  "correlation_id": "3f225f40-4f4e-4e16-a4cc-7ff044b42ac3"
}
```

Supported channels are `GCASH`, `MAYA`, and `CARD`. A successful HTTP response
includes `payment_ref_id`, `status`, and `message`. Repeating an identical
request with the same correlation ID returns the original result, including
across service restarts. Reusing an ID for different payment data returns
HTTP 409. Unavailable outcomes are not cached, so a connection retry can be
tested.

Set `PORT` to change the listen port, or `PAYMENT_STORE_FILE` to change the
local idempotency-store file. Keep this sandbox on a trusted local development
network; it is not intended for public production use.
