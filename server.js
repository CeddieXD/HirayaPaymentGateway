'use strict';

const { createServer } = require('node:http');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const METHODS = new Set(['GCASH', 'MAYA', 'CARD']);
const OUTCOMES = new Set(['CONFIRMED', 'PENDING', 'FAILED', 'UNAVAILABLE']);
const MAX_BODY_BYTES = 16 * 1024;
const MAX_REQUEST_LOGS = 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DASHBOARD_FILES = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
]);

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

function loadRequestLogs(logFile) {
    if (!logFile || !fs.existsSync(logFile)) return [];
    const stored = JSON.parse(fs.readFileSync(logFile, 'utf8'));
    if (!Array.isArray(stored) || stored.some(entry =>
        !entry || typeof entry.id !== 'string'
        || typeof entry.timestamp !== 'string'
        || !entry.request || typeof entry.request !== 'object'
        || !entry.response || typeof entry.response !== 'object'
    )) {
        throw new Error('The payment request log has an invalid format.');
    }
    return stored.slice(-MAX_REQUEST_LOGS);
}

function persistRequestLogs(logFile, requests) {
    if (!logFile) return;
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const temporaryFile = `${logFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryFile, JSON.stringify(requests), { mode: 0o600 });
    fs.renameSync(temporaryFile, logFile);
}

function paymentRequestDetails(payload) {
    const value = (key, maxLength = 100) => (
        typeof payload?.[key] === 'string' ? payload[key].slice(0, maxLength) : null
    );
    return {
        order_id: value('order_id'),
        external_order_id: value('external_order_id'),
        amount: Number.isFinite(payload?.amount) ? payload.amount : null,
        currency: value('currency', 3),
        channel: value('channel', 20),
        order_status: value('order_status', 20),
        correlation_id: value('correlation_id', 36),
    };
}

function createPaymentServer({
    outcome = 'CONFIRMED',
    log = console.log,
    storeFile = null,
    requestLogFile = null,
} = {}) {
    const normalizedOutcome = String(outcome).toUpperCase();
    if (!OUTCOMES.has(normalizedOutcome)) {
        throw new Error(`Unsupported SIMULATED_PAYMENT_OUTCOME "${outcome}".`);
    }
    const transactions = loadTransactions(storeFile);
    const requestLogs = loadRequestLogs(requestLogFile);

    return createServer(async (req, res) => {
        const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
        const dashboardFile = DASHBOARD_FILES.get(pathname);
        if (req.method === 'GET' && dashboardFile) {
            const filePath = path.join(__dirname, 'public', dashboardFile[0]);
            if (!fs.existsSync(filePath)) {
                return respond(res, 500, { error: 'Payment dashboard file is missing.' });
            }
            res.writeHead(200, { 'Content-Type': dashboardFile[1] });
            return fs.createReadStream(filePath).pipe(res);
        }
        if (req.method === 'GET' && pathname === '/health') {
            const available = normalizedOutcome !== 'UNAVAILABLE';
            return respond(res, available ? 200 : 503, {
                status: available ? 'ok' : 'unavailable',
                environment: 'sandbox',
            });
        }
        if (req.method === 'GET' && pathname === '/api/requests') {
            return respond(res, 200, {
                total: requestLogs.length,
                requests: [...requestLogs].reverse(),
            });
        }
        if (req.method !== 'POST' || pathname !== '/api/payments/initiate') {
            return respond(res, 404, { error: 'Route not found.' });
        }

        const startedAt = Date.now();
        const requestLog = {
            id: randomUUID(),
            timestamp: new Date(startedAt).toISOString(),
            method: req.method,
            path: pathname,
            request: paymentRequestDetails(null),
            response: {},
            duration_ms: 0,
        };
        const respondToPayment = (status, body) => {
            requestLog.response = {
                http_status: status,
                status: body.status || null,
                payment_ref_id: body.payment_ref_id || null,
                message: body.message || body.error || null,
            };
            requestLog.duration_ms = Date.now() - startedAt;
            requestLogs.push(requestLog);
            if (requestLogs.length > MAX_REQUEST_LOGS) requestLogs.shift();
            try {
                persistRequestLogs(requestLogFile, requestLogs);
            } catch (error) {
                log(JSON.stringify({ event: 'payment.request_log_failed', message: error.message }));
            }
            return respond(res, status, body);
        };

        let payload;
        try {
            payload = await readJson(req);
        } catch (error) {
            return respondToPayment(error.statusCode || 400, { error: error.message });
        }
        requestLog.request = paymentRequestDetails(payload);

        const correlationId = req.headers['x-correlation-id'];
        const validationError = validatePayment(payload, correlationId);
        if (validationError) return respondToPayment(400, { error: validationError });

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
                return respondToPayment(409, {
                    status: 'FAILED',
                    message: 'This correlation_id was already used for a different payment request.',
                });
            }
            return respondToPayment(200, previous.result);
        }

        if (normalizedOutcome === 'UNAVAILABLE') {
            return respondToPayment(503, {
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
            return respondToPayment(503, {
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
        return respondToPayment(200, result);
    });
}

if (require.main === module) {
    const port = Number(process.env.PORT || 3102);
    const outcome = process.env.SIMULATED_PAYMENT_OUTCOME || 'CONFIRMED';
    const storeFile = process.env.PAYMENT_STORE_FILE
        ? path.resolve(process.env.PAYMENT_STORE_FILE)
        : path.join(__dirname, 'data', 'transactions.json');
    const requestLogFile = process.env.PAYMENT_REQUEST_LOG_FILE
        ? path.resolve(process.env.PAYMENT_REQUEST_LOG_FILE)
        : path.join(__dirname, 'data', 'requests.json');
    const server = createPaymentServer({ outcome, storeFile, requestLogFile });
    server.listen(port, '127.0.0.1', () => {
        console.log(`Hiraya Café payment sandbox listening on http://127.0.0.1:${port} (${outcome})`);
    });
}

module.exports = { createPaymentServer };
