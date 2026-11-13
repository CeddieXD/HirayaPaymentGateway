'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPaymentServer } = require('../server');

const correlationId = 'c03fe1d7-88bf-4c0b-a8c7-6b81d8ee5a41';
const paymentRequest = {
    order_id: 'MROYAL-1042',
    external_order_id: 'MROYAL-1042',
    amount: 125.5,
    currency: 'PHP',
    channel: 'GCASH',
    order_status: 'PENDING',
    correlation_id: correlationId,
};

async function listen(server) {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${server.address().port}`;
}

async function postPayment(baseUrl, body = paymentRequest, id = correlationId) {
    return fetch(`${baseUrl}/api/payments/initiate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Correlation-Id': id },
        body: JSON.stringify(body),
    });
}

test('confirms a valid payment and returns the same result for an idempotent retry', async t => {
    const server = createPaymentServer({ outcome: 'CONFIRMED', log: () => {} });
    const baseUrl = await listen(server);
    t.after(() => new Promise(resolve => server.close(resolve)));

    const firstResponse = await postPayment(baseUrl);
    const first = await firstResponse.json();
    const retryResponse = await postPayment(baseUrl);
    const retry = await retryResponse.json();

    assert.equal(firstResponse.status, 200);
    assert.equal(first.status, 'CONFIRMED');
    assert.match(first.payment_ref_id, /^HIRAYA-[A-F0-9]{16}$/);
    assert.deepEqual(retry, first);
});

test('rejects a request whose body and correlation header do not match', async t => {
    const server = createPaymentServer({ log: () => {} });
    const baseUrl = await listen(server);
    t.after(() => new Promise(resolve => server.close(resolve)));

    const response = await postPayment(baseUrl, paymentRequest, 'c03fe1d7-88bf-4c0b-a8c7-6b81d8ee5a42');
    const result = await response.json();

    assert.equal(response.status, 400);
    assert.match(result.error, /matching UUID correlation_id/);
});

test('rejects a correlation ID reused with different payment data', async t => {
    const server = createPaymentServer({ log: () => {} });
    const baseUrl = await listen(server);
    t.after(() => new Promise(resolve => server.close(resolve)));

    await postPayment(baseUrl);
    const changedRequest = { ...paymentRequest, amount: 125.75 };
    const response = await postPayment(baseUrl, changedRequest);
    const result = await response.json();

    assert.equal(response.status, 409);
    assert.equal(result.status, 'FAILED');
});

test('reports the configured unavailable sandbox as HTTP 503', async t => {
    const server = createPaymentServer({ outcome: 'UNAVAILABLE', log: () => {} });
    const baseUrl = await listen(server);
    t.after(() => new Promise(resolve => server.close(resolve)));

    const response = await postPayment(baseUrl);
    const result = await response.json();

    assert.equal(response.status, 503);
    assert.equal(result.status, 'UNAVAILABLE');
});

test('returns the configured pending and failed outcomes', async t => {
    for (const outcome of ['PENDING', 'FAILED']) {
        const server = createPaymentServer({ outcome, log: () => {} });
        const baseUrl = await listen(server);
        const response = await postPayment(baseUrl);
        const result = await response.json();
        await new Promise(resolve => server.close(resolve));

        assert.equal(response.status, 200);
        assert.equal(result.status, outcome);
        assert.match(result.payment_ref_id, /^HIRAYA-[A-F0-9]{16}$/);
    }
});

test('preserves the idempotent result when the sandbox restarts', async t => {
    const storeFile = path.join(os.tmpdir(), `hiraya-payments-${process.pid}-${Date.now()}.json`);
    const firstServer = createPaymentServer({ outcome: 'CONFIRMED', log: () => {}, storeFile });
    const firstBaseUrl = await listen(firstServer);
    t.after(() => {
        if (fs.existsSync(storeFile)) fs.unlinkSync(storeFile);
    });

    const firstResponse = await postPayment(firstBaseUrl);
    const first = await firstResponse.json();
    const secondCorrelationId = 'c03fe1d7-88bf-4c0b-a8c7-6b81d8ee5a42';
    const secondRequest = {
        ...paymentRequest,
        order_id: 'MROYAL-1043',
        external_order_id: 'MROYAL-1043',
        correlation_id: secondCorrelationId,
    };
    const secondResponse = await postPayment(firstBaseUrl, secondRequest, secondCorrelationId);
    await new Promise(resolve => firstServer.close(resolve));

    const restartedServer = createPaymentServer({ outcome: 'FAILED', log: () => {}, storeFile });
    const restartedBaseUrl = await listen(restartedServer);
    t.after(() => new Promise(resolve => restartedServer.close(resolve)));
    const retryResponse = await postPayment(restartedBaseUrl);
    const retry = await retryResponse.json();

    assert.equal(retryResponse.status, 200);
    assert.deepEqual(retry, first);
    assert.equal(secondResponse.status, 200);
});

test('serves troubleshooting scenarios and records successful, conflicting, and rejected requests', async t => {
    const requestLogFile = path.join(os.tmpdir(), `hiraya-request-log-${process.pid}-${Date.now()}.json`);
    const server = createPaymentServer({ log: () => {}, requestLogFile });
    const baseUrl = await listen(server);
    t.after(() => {
        if (fs.existsSync(requestLogFile)) fs.unlinkSync(requestLogFile);
        return new Promise(resolve => server.close(resolve));
    });

    const pageResponse = await fetch(baseUrl);
    assert.equal(pageResponse.status, 200);
    assert.match(pageResponse.headers.get('content-type'), /text\/html/);
    const page = await pageResponse.text();
    assert.match(page, /Payment activity/);
    assert.match(page, /Exercise a failure scenario/);

    const successResponse = await postPayment(baseUrl);
    assert.equal(successResponse.status, 200);
    const changedRequest = { ...paymentRequest, amount: 126 };
    const conflictResponse = await postPayment(baseUrl, changedRequest);
    assert.equal(conflictResponse.status, 409);
    const invalidRequest = { ...paymentRequest, amount: -1 };
    const rejectedResponse = await postPayment(baseUrl, invalidRequest);
    assert.equal(rejectedResponse.status, 400);

    const historyResponse = await fetch(`${baseUrl}/api/requests`);
    const history = await historyResponse.json();
    assert.equal(history.total, 3);
    assert.equal(history.requests[0].response.http_status, 400);
    assert.equal(history.requests[0].response.status, null);
    assert.equal(history.requests[0].request.amount, -1);
    assert.equal(history.requests[0].method, 'POST');
    assert.equal(history.requests[0].path, '/api/payments/initiate');
    assert.equal(history.requests[1].response.http_status, 409);
    assert.match(history.requests[1].response.message, /already used/);
    assert.equal(history.requests[2].response.status, 'CONFIRMED');
    assert.equal(history.requests[2].request.external_order_id, 'MROYAL-1042');
    assert.equal(typeof history.requests[2].duration_ms, 'number');

    const persistedHistory = JSON.parse(fs.readFileSync(requestLogFile, 'utf8'));
    assert.equal(persistedHistory.length, 3);
});
