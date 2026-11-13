'use strict';

const { createServer } = require('node:http');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const METHODS = new Set(['GCASH', 'MAYA', 'CARD']);
const OUTCOMES = new Set(['CONFIRMED', 'PENDING', 'FAILED', 'UNAVAILABLE']);
const MAX_BODY_BYTES = 16 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function respond(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
}

async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
            const error = new Error('Request body is too large.');
            error.statusCode = 413;
            throw error;
        }
        chunks.push(chunk);
    }

    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        const error = new Error('Request body must be valid JSON.');
        error.statusCode = 400;
        throw error;
    }
}

function validatePayment(payload, correlationHeader) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        return 'A payment request object is required.';
    }
    if (typeof payload.external_order_id !== 'string'
        || !/^MROYAL-[1-9]\d{0,9}$/.test(payload.external_order_id)) {
        return 'A valid Mroyal external_order_id is required.';
    }
    if (payload.order_id !== payload.external_order_id) {
        return 'order_id must match external_order_id.';
    }
    if (!Number.isFinite(payload.amount) || payload.amount <= 0
        || Math.abs(payload.amount * 100 - Math.round(payload.amount * 100)) > 1e-8) {
        return 'amount must be a positive value with at most two decimal places.';
    }
    if (payload.currency !== 'PHP') return 'currency must be PHP.';
    if (!METHODS.has(payload.channel)) return 'channel must be GCASH, MAYA, or CARD.';
    if (payload.order_status !== 'PENDING') return 'order_status must be PENDING.';
    if (typeof payload.correlation_id !== 'string'
        || !UUID_PATTERN.test(payload.correlation_id)
        || payload.correlation_id !== correlationHeader) {
        return 'A matching UUID correlation_id and X-Correlation-Id header are required.';
    }
    return null;
}

function loadTransactions(storeFile) {
    if (!storeFile || !fs.existsSync(storeFile)) return new Map();
    const stored = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    if (!Array.isArray(stored) || stored.some(entry =>
        !Array.isArray(entry) || entry.length !== 2
        || typeof entry[0] !== 'string'
        || typeof entry[1]?.fingerprint !== 'string'
        || !OUTCOMES.has(entry[1]?.result?.status)
    )) {
        throw new Error('The sandbox idempotency store has an invalid format.');
    }
    return new Map(stored);
}

function persistTransactions(storeFile, transactions) {
    if (!storeFile) return;
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    const temporaryFile = `${storeFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify([...transactions]), { mode: 0o600 });
    fs.renameSync(temporaryFile, storeFile);
}

function createPaymentServer({ outcome = 'CONFIRMED', log = console.log, storeFile = null } = {}) {
    const normalizedOutcome = String(outcome).toUpperCase();
    if (!OUTCOMES.has(normalizedOutcome)) {
        throw new Error(`Unsupported SIMULATED_PAYMENT_OUTCOME "${outcome}".`);
    }
    const transactions = loadTransactions(storeFile);

    return createServer(async (req, res) => {
        const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
        if (req.method === 'GET' && pathname === '/health') {
            const available = normalizedOutcome !== 'UNAVAILABLE';
            return respond(res, available ? 200 : 503, {
                status: available ? 'ok' : 'unavailable',
                environment: 'sandbox',
            });
        }
        if (req.method !== 'POST' || pathname !== '/api/payments/initiate') {
            return respond(res, 404, { error: 'Route not found.' });
        }

        let payload;
        try {
            payload = await readJson(req);
        } catch (error) {
            return respond(res, error.statusCode || 400, { error: error.message });
        }

        const correlationId = req.headers['x-correlation-id'];
        const validationError = validatePayment(payload, correlationId);
        if (validationError) return respond(res, 400, { error: validationError });

        const fingerprint = JSON.stringify({
            external_order_id: payload.external_order_id,
            amount: payload.amount,
            currency: payload.currency,
            channel: payload.channel,
            order_status: payload.order_status,
        });
        const previous = transactions.get(correlationId);
        if (previous) {
            if (previous.fingerprint !== fingerprint) {
                return respond(res, 409, {
                    status: 'FAILED',
                    message: 'This correlation_id was already used for a different payment request.',
                });
            }
            return respond(res, 200, previous.result);
        }

        if (normalizedOutcome === 'UNAVAILABLE') {
            return respond(res, 503, {
                status: 'UNAVAILABLE',
                message: 'Hiraya Café Payment Gateway sandbox is unavailable.',
            });
        }
        const result = {
            payment_ref_id: `HIRAYA-${randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`,
            status: normalizedOutcome,
            message: {
                CONFIRMED: 'Sandbox payment confirmed.',
                PENDING: 'Sandbox payment is pending confirmation.',
                FAILED: 'Sandbox payment was declined.',
            }[normalizedOutcome],
        };
        const nextTransactions = new Map(transactions);
        nextTransactions.set(correlationId, { fingerprint, result });
        try {
            persistTransactions(storeFile, nextTransactions);
        } catch (error) {
            log(JSON.stringify({ event: 'payment.store_failed', message: error.message }));
            return respond(res, 503, {
                status: 'UNAVAILABLE',
                message: 'Sandbox could not save the payment idempotency record.',
            });
        }
        transactions.set(correlationId, { fingerprint, result });
        log(JSON.stringify({
            event: 'payment.processed',
            external_order_id: payload.external_order_id,
            correlation_id: correlationId,
            channel: payload.channel,
            status: result.status,
        }));
        return respond(res, 200, result);
    });
}

if (require.main === module) {
    const port = Number(process.env.PORT || 3102);
    const outcome = process.env.SIMULATED_PAYMENT_OUTCOME || 'CONFIRMED';
    const storeFile = process.env.PAYMENT_STORE_FILE
        ? path.resolve(process.env.PAYMENT_STORE_FILE)
        : path.join(__dirname, 'data', 'transactions.json');
    const server = createPaymentServer({ outcome, storeFile });
    server.listen(port, '127.0.0.1', () => {
        console.log(`Hiraya Café payment sandbox listening on http://127.0.0.1:${port} (${outcome})`);
    });
}

module.exports = { createPaymentServer };
