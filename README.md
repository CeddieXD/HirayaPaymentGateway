# Hiraya Café Payment Gateway Sandbox

This is a small, local simulated partner service for the Mroyal integration
case file. It demonstrates payment request validation, method/status mapping,
references, correlation IDs, idempotent retries, and unavailable-service
handling. It is not a real payment gateway and does not connect to GCash, Maya,
or card networks.

## Run

Copy the example settings and start the service:

```powershell
Copy-Item .\.env.example .\.env
npm start
```

The server binds to `127.0.0.1:3102`. Set `SIMULATED_PAYMENT_OUTCOME` to
`CONFIRMED`, `PENDING`, `FAILED`, or `UNAVAILABLE` in `.env` to exercise each
documented outcome. Restart the server after changing the value. Open
`http://127.0.0.1:3102/` to view the responsive payment activity dashboard.
It refreshes automatically and shows each payment initiation attempt, including
validation rejections and unavailable responses. The latest 1,000 attempts are
stored in `data/requests.json`; set `PAYMENT_REQUEST_LOG_FILE` to change that
file location.
Use **Exercise a failure scenario** on the dashboard to send a missing-channel
request (HTTP 400) or reuse an idempotency key with a changed amount (HTTP 409).
The details drawer identifies the method, route, HTTP response, cause, and
recommended recovery. These scenarios create sandbox log entries only.

The read-only `GET /api/requests` endpoint returns the activity log newest
first. Each entry includes the payment request fields, HTTP and mapped gateway
result, response message/reference, timestamp, and processing time. Sensitive
credentials are not collected or logged.

Run the sandbox tests with `npm test`.

## Integration contract

Mroyal sends `POST /api/payments/initiate` with a JSON body containing:

| Field | Rule |
| --- | --- |
| `order_id` / `external_order_id` | Mroyal reference such as `MROYAL-1042` |
| `amount` | Positive amount with up to two decimal places |
| `currency` | `PHP` |
| `channel` | `GCASH`, `MAYA`, or `CARD` |
| `order_status` | `PENDING` |
| `correlation_id` | UUID, also sent as `X-Correlation-Id` |

A successful HTTP response contains `payment_ref_id`, `status`, and `message`.
Retries with the same correlation ID and request return the original result,
including across sandbox restarts; reusing that ID for a different request
returns HTTP 409. `UNAVAILABLE` simulates an HTTP 503 and is not cached, so a
connection retry can be tested. For the 503 scenario, set
`SIMULATED_PAYMENT_OUTCOME=UNAVAILABLE` in `.env`, restart the gateway, and
submit a payment from Mroyal or the sandbox integration test.
`GET /health` reports whether the configured sandbox outcome is available.
Once both servers are running, check the end-to-end connection from Mroyal's
backend with:

```powershell
Invoke-RestMethod http://localhost:3000/api/payments/health
```

An available sandbox returns `status: ok`, `environment: sandbox`, and a
latency measurement. An HTTP 503 indicates the gateway is stopped, reports an
unavailable outcome, or is incorrectly configured. This check is read-only and
does not create a payment or database transaction. You can also check the
sandbox alone at `http://127.0.0.1:3102/health`.
The backend defaults to `http://127.0.0.1:3102`; set `PAYMENT_GATEWAY_URL` in
the backend `.env` only if you host the sandbox at another address.

Mroyal stores the payment result and integration request/response logs. The
cashier POS shows the method and payment status and prevents verification until
the gateway reports `CONFIRMED`. A confirmed digital payment is not edited or
discounted during POS verification because its amount has already been
confirmed. Sandbox credentials are not collected or stored.

## Finals Integration Activity — Evidence Checklist

This checklist follows the 10 requirements in the Finals TP Lab Exam.
Screenshots are saved in [`screenshots/final-project`](./screenshots/final-project/).
The demonstrated transaction used the local sandbox; no live payment provider
or real payment was used.

- [x] **1. Existing SE system:** Mroyal kiosk order review — [screenshot](./screenshots/final-project/01-existing-se-system.png).
- [x] **2. Integration partner:** Checkout payment selection and the Hiraya request dashboard — [payment method](./screenshots/final-project/02-payment-method.png), [gateway dashboard](./screenshots/final-project/02-payment-gateway-dashboard.png).
- [x] **3. Executed data flow:** Mroyal order submitted to the gateway and the response returned to the kiosk — [screenshot](./screenshots/final-project/03-executed-data-flow.png).
- [x] **4. Mapping and validation:** Order, amount, currency, channel, and correlation ID are mapped and checked; a missing channel receives HTTP 400 — [validation result](./screenshots/final-project/04-field-validation-400.png), [code walkthrough](./screenshots/final-project/09-code-walkthrough.png).
- [x] **5. Source of truth and synchronization:** POS displays the gateway-confirmed payment reference and payment status separately from the order's cashier-verification status — [screenshot](./screenshots/final-project/05-payment-status-source-of-truth.png).
- [x] **6. Failure and recovery:** Missing required data returns HTTP 400; reusing a correlation ID with changed payment data returns HTTP 409. The dashboard identifies the request and provides diagnosis/recovery guidance — [HTTP 400](./screenshots/final-project/04-field-validation-400.png), [HTTP 409](./screenshots/final-project/06-failure-conflict-409.png).
- [x] **7. Testing:** Automated gateway tests cover successful and idempotent requests, mismatched data, duplicate conflicts, unavailable/pending/failed outcomes, and audit history — [test results](./screenshots/final-project/07-test-results.png).
- [x] **8. Evidence:** Gateway request history is available from the dashboard and `GET /api/requests` — [dashboard](./screenshots/final-project/02-payment-gateway-dashboard.png), [API audit log](./screenshots/final-project/08-api-audit-log.png).
- [x] **9. Code walkthrough:** The evidence traces request mapping, validation, partner response handling, persistence, and idempotency — [screenshot](./screenshots/final-project/09-code-walkthrough.png).
- [x] **10. Maintenance:** The payment health endpoint reports the configured sandbox state; gateway activity can be diagnosed from request details and server logs — [health status](./screenshots/final-project/10-health-monitoring.png).

### Test and recovery notes

The captured gateway test run passed **7/7 tests**. For an unavailable
destination test, set `SIMULATED_PAYMENT_OUTCOME=UNAVAILABLE` in `.env` and
restart the sandbox. It responds with HTTP 503 and `UNAVAILABLE`. Restore the
normal sandbox outcome and retry with the original correlation ID. Correct
missing fields before retrying. Do not retry a 409 request with changed payment
data under the same correlation ID; investigate the existing request and use a
new ID only for a genuinely new payment attempt.

The demonstrated POS order remains `PENDING` for the cashier's normal
verification step even though its sandbox payment is `CONFIRMED`. These
screenshots support the system demonstration and do not replace any separate
presentation or video requirement from the course.
