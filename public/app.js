'use strict';

const requestRows = document.getElementById('request-rows');
const searchInput = document.getElementById('search-input');
const statusFilter = document.getElementById('status-filter');
const refreshButton = document.getElementById('refresh-button');
const scenarioSelect = document.getElementById('scenario-select');
const scenarioButton = document.getElementById('run-scenario');
const scenarioResult = document.getElementById('scenario-result');
const drawer = document.getElementById('detail-drawer');
const drawerBackdrop = document.getElementById('drawer-backdrop');
let requests = [];
let lastFocusedElement = null;

function paymentStatus(request) {
    const httpStatus = Number(request.response.http_status);
    if (httpStatus === 409) return 'CONFLICT';
    if (httpStatus >= 400 && httpStatus < 500) return 'REJECTED';
    const status = request.response.status;
    if (status) return status.toUpperCase();
    return 'UNKNOWN';
}

function formattedAmount(amount, currency) {
    if (typeof amount !== 'number' || !Number.isFinite(amount)) return '—';
    try {
        return new Intl.NumberFormat('en-PH', {
            style: 'currency',
            currency: currency || 'PHP',
            minimumFractionDigits: 2,
        }).format(amount);
    } catch {
        return `${currency || 'PHP'} ${amount.toFixed(2)}`;
    }
}

function formattedTime(timestamp) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return 'Time unavailable';
    return new Intl.DateTimeFormat('en-PH', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    }).format(date);
}

function addCell(row, className, content) {
    const cell = document.createElement('td');
    if (className) cell.className = className;
    if (content instanceof Node) cell.append(content);
    else cell.textContent = content;
    row.append(cell);
    return cell;
}

function renderRows() {
    const query = searchInput.value.trim().toLowerCase();
    const selectedStatus = statusFilter.value;
    const visibleRequests = requests.filter(request => {
        const status = paymentStatus(request);
        const searchable = [
            request.request.order_id,
            request.request.external_order_id,
            request.request.correlation_id,
            request.response.payment_ref_id,
            request.request.channel,
        ].filter(Boolean).join(' ').toLowerCase();
        return (selectedStatus === 'all' || status === selectedStatus)
            && (!query || searchable.includes(query));
    });

    requestRows.replaceChildren();
    if (!visibleRequests.length) {
        const row = document.createElement('tr');
        const cell = addCell(row, 'empty-cell', requests.length
            ? 'No requests match your search or filters.'
            : 'No payment requests yet. New requests will appear here as they arrive.');
        cell.colSpan = 6;
        requestRows.append(row);
    } else {
        visibleRequests.forEach(request => {
            const row = document.createElement('tr');
            const requestCell = document.createElement('td');
            const requestButton = document.createElement('button');
            requestButton.className = 'request-link';
            requestButton.type = 'button';
            requestButton.textContent = request.request.external_order_id || 'Invalid payment request';
            requestButton.addEventListener('click', () => openDetails(request));
            const requestMeta = document.createElement('span');
            requestMeta.className = 'request-meta';
            requestMeta.textContent = `${formattedTime(request.timestamp)} · ${request.request.correlation_id || 'No correlation ID'}`;
            requestCell.append(requestButton, requestMeta);
            row.append(requestCell);
            addCell(row, 'channel-label', request.request.channel || '—');
            addCell(row, 'amount-cell', formattedAmount(request.request.amount, request.request.currency));
            const resultCell = addCell(row, '', '');
            const status = paymentStatus(request);
            const badge = document.createElement('span');
            badge.className = `status-badge status-${status.toLowerCase()}`;
            badge.textContent = status === 'REJECTED' ? 'Rejected' : status[0] + status.slice(1).toLowerCase();
            resultCell.append(badge);
            addCell(row, 'latency-cell', `${Number(request.duration_ms) || 0} ms`);
            const actionCell = addCell(row, '');
            const detailsButton = document.createElement('button');
            detailsButton.className = 'details-button';
            detailsButton.type = 'button';
            detailsButton.setAttribute('aria-label', `View details for ${request.request.external_order_id || 'payment request'}`);
            detailsButton.textContent = '›';
            detailsButton.addEventListener('click', () => openDetails(request));
            actionCell.append(detailsButton);
            requestRows.append(row);
        });
    }
    document.getElementById('request-count').textContent =
        `${visibleRequests.length} ${visibleRequests.length === 1 ? 'request' : 'requests'}`;
    document.getElementById('table-footer-text').textContent =
        `Showing ${visibleRequests.length} of ${requests.length} recent payment attempts`;
}

function updateMetrics() {
    const today = new Date().toLocaleDateString();
    const todayRequests = requests.filter(request => new Date(request.timestamp).toLocaleDateString() === today);
    const confirmed = requests.filter(request => paymentStatus(request) === 'CONFIRMED');
    const attention = requests.filter(request => ['FAILED', 'UNAVAILABLE', 'REJECTED', 'CONFLICT'].includes(paymentStatus(request)));
    const volume = confirmed.reduce((sum, request) => sum + (Number(request.request.amount) || 0), 0);
    document.getElementById('metric-today').textContent = String(todayRequests.length);
    document.getElementById('metric-confirmed').textContent = String(confirmed.length);
    document.getElementById('metric-confirmed-note').textContent =
        `${requests.length ? Math.round((confirmed.length / requests.length) * 100) : 0}% of recorded attempts`;
    document.getElementById('metric-volume').textContent = formattedAmount(volume, 'PHP');
    document.getElementById('metric-attention').textContent = String(attention.length);
}

function updateConnection(health) {
    const banner = document.getElementById('connection-banner');
    const available = health.status === 'ok';
    document.getElementById('connection-endpoint').textContent = window.location.host;
    banner.classList.toggle('online', available);
    banner.classList.toggle('offline', !available);
    document.getElementById('connection-title').textContent =
        available ? 'Gateway is online' : 'Gateway is unavailable';
    document.getElementById('connection-message').textContent = available
        ? 'Ready to receive payment requests'
        : 'Start or check the Hiraya sandbox service';
}

function renderDetailField(label, value, { full = false, code = false, error = false } = {}) {
    const field = document.createElement('div');
    field.className = `detail-field${full ? ' full' : ''}`;
    const name = document.createElement('span');
    name.textContent = label;
    const content = document.createElement(code ? 'code' : 'strong');
    content.textContent = value == null || value === '' ? '—' : String(value);
    if (error) content.classList.add('error-message');
    field.append(name, content);
    return field;
}

function renderJson(value) {
    return JSON.stringify(value, null, 2);
}

function diagnoseRequest(request) {
    const httpStatus = Number(request.response.http_status);
    if (httpStatus === 400) {
        return {
            title: 'Invalid or missing request data',
            cause: request.response.message || 'The gateway rejected a required or invalid payment field.',
            recovery: 'Correct the field identified in the response. Check the PHP amount, supported channel, order status, and that correlation_id matches the X-Correlation-Id header.',
        };
    }
    if (httpStatus === 409) {
        return {
            title: 'Correlation ID reused with changed payment data',
            cause: request.response.message || 'A correlation ID was already used for a different payment request.',
            recovery: 'For a retry, send the exact same payment payload to receive the original result. For a new payment, generate a new correlation ID; never change the amount under an existing ID.',
        };
    }
    if (httpStatus === 503 || paymentStatus(request) === 'UNAVAILABLE') {
        return {
            title: 'Payment destination unavailable',
            cause: request.response.message || 'The gateway could not complete the request.',
            recovery: 'Check that the Hiraya service is listening and its transaction store is writable. For the sandbox, set SIMULATED_PAYMENT_OUTCOME=CONFIRMED and restart it, then retry with the same correlation ID.',
        };
    }
    if (paymentStatus(request) === 'FAILED') {
        return {
            title: 'Payment was declined',
            cause: request.response.message || 'The payment partner returned a failed result.',
            recovery: 'Keep the order unconfirmed. Review the payment method and partner response; only retry when the customer starts a new attempt.',
        };
    }
    return null;
}

function openDetails(request) {
    lastFocusedElement = document.activeElement;
    const content = document.getElementById('drawer-content');
    content.replaceChildren();
    const status = paymentStatus(request);
    const statusBlock = document.createElement('div');
    statusBlock.className = 'detail-status';
    const badge = document.createElement('span');
    badge.className = `status-badge status-${status.toLowerCase()}`;
    badge.textContent = status === 'REJECTED' ? 'Rejected' : status[0] + status.slice(1).toLowerCase();
    statusBlock.append(badge);
    content.append(statusBlock);

    const overview = document.createElement('section');
    overview.className = 'detail-section';
    const overviewTitle = document.createElement('h3');
    overviewTitle.textContent = 'Request overview';
    const grid = document.createElement('div');
    grid.className = 'detail-grid';
    grid.append(
        renderDetailField('Order reference', request.request.external_order_id),
        renderDetailField('Amount', formattedAmount(request.request.amount, request.request.currency)),
        renderDetailField('Payment channel', request.request.channel),
        renderDetailField('Gateway result', status),
        renderDetailField('HTTP response', `${request.response.http_status || '—'}${request.response.http_status ? ` ${httpStatusName(request.response.http_status)}` : ''}`),
        renderDetailField('Request route', `${request.method || 'POST'} ${request.path || '/api/payments/initiate'}`, { full: true, code: true }),
        renderDetailField('Received at', formattedTime(request.timestamp)),
        renderDetailField('Response time', `${Number(request.duration_ms) || 0} ms`),
        renderDetailField('Correlation ID', request.request.correlation_id, { full: true, code: true }),
        renderDetailField('Payment reference', request.response.payment_ref_id, { full: true, code: true }),
        renderDetailField('Gateway message', request.response.message, { full: true, error: ['FAILED', 'UNAVAILABLE', 'REJECTED', 'CONFLICT'].includes(status) }),
    );
    overview.append(overviewTitle, grid);
    content.append(overview);

    const diagnosis = diagnoseRequest(request);
    if (diagnosis) {
        const issue = document.createElement('section');
        issue.className = 'detail-section issue-card';
        const issueTitle = document.createElement('h3');
        issueTitle.textContent = 'Issue diagnosis';
        const issueName = document.createElement('strong');
        issueName.className = 'issue-title';
        issueName.textContent = diagnosis.title;
        const issueCause = document.createElement('p');
        issueCause.textContent = diagnosis.cause;
        const recoveryHeading = document.createElement('h4');
        recoveryHeading.textContent = 'Recovery';
        const recovery = document.createElement('p');
        recovery.textContent = diagnosis.recovery;
        issue.append(issueTitle, issueName, issueCause, recoveryHeading, recovery);
        content.append(issue);
    }

    [['Request payload', request.request], ['Response summary', request.response]].forEach(([title, data]) => {
        const section = document.createElement('section');
        section.className = 'detail-section';
        const heading = document.createElement('h3');
        heading.textContent = title;
        const payload = document.createElement('pre');
        payload.className = 'payload-block';
        payload.textContent = renderJson(data);
        section.append(heading, payload);
        content.append(section);
    });

    drawer.classList.add('open');
    drawer.setAttribute('aria-hidden', 'false');
    drawerBackdrop.hidden = false;
    document.getElementById('close-drawer').focus();
}

function httpStatusName(status) {
    return ({ 200: 'OK', 400: 'Bad Request', 409: 'Conflict', 503: 'Service Unavailable' })[Number(status)] || '';
}

function createScenarioRequest(correlationId, channel = 'GCASH', amount = 25) {
    return {
        order_id: `MROYAL-${Math.floor(1000000 + Math.random() * 9000000)}`,
        external_order_id: '',
        amount,
        currency: 'PHP',
        channel,
        order_status: 'PENDING',
        correlation_id: correlationId,
    };
}

async function submitScenarioRequest(payload, correlationId) {
    const response = await fetch('/api/payments/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Correlation-Id': correlationId },
        body: JSON.stringify(payload),
    });
    const result = await response.json();
    return { status: response.status, result };
}

async function runScenario() {
    scenarioButton.disabled = true;
    scenarioResult.classList.remove('scenario-error');
    scenarioResult.textContent = 'Sending sandbox request…';
    const correlationId = crypto.randomUUID();
    const payload = createScenarioRequest(correlationId);
    payload.external_order_id = payload.order_id;

    try {
        let response;
        let summary;
        if (scenarioSelect.value === 'duplicate') {
            const first = await submitScenarioRequest(payload, correlationId);
            const changedPayload = { ...payload, amount: payload.amount + 0.5 };
            response = await submitScenarioRequest(changedPayload, correlationId);
            summary = `Setup request: HTTP ${first.status}. Reused ID with changed amount: HTTP ${response.status}.`;
        } else {
            delete payload.channel;
            response = await submitScenarioRequest(payload, correlationId);
            summary = `Gateway response: HTTP ${response.status} — ${response.result.error || response.result.message || 'Request rejected'}`;
        }

        await refresh();
        const failedRequest = requests.find(request =>
            request.request.correlation_id === correlationId
            && Number(request.response.http_status) >= 400
        );
        scenarioResult.textContent = summary;
        if (failedRequest) openDetails(failedRequest);
    } catch (error) {
        scenarioResult.classList.add('scenario-error');
        scenarioResult.textContent = `Could not run the scenario: ${error.message}`;
    } finally {
        scenarioButton.disabled = false;
    }
}

function closeDetails() {
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    drawerBackdrop.hidden = true;
    if (lastFocusedElement) lastFocusedElement.focus();
}

async function refresh() {
    refreshButton.classList.add('is-refreshing');
    try {
        const [requestResponse, healthResponse] = await Promise.all([
            fetch('/api/requests', { cache: 'no-store' }),
            fetch('/health', { cache: 'no-store' }),
        ]);
        if (!requestResponse.ok) throw new Error(`Request history returned HTTP ${requestResponse.status}.`);
        const data = await requestResponse.json();
        if (!Array.isArray(data.requests)) throw new Error('Request history response has an invalid format.');
        requests = data.requests;
        updateMetrics();
        renderRows();
        if (healthResponse.ok) {
            updateConnection(await healthResponse.json());
        } else {
            updateConnection({ status: 'unavailable' });
        }
    } catch (error) {
        document.getElementById('connection-banner').classList.add('offline');
        document.getElementById('connection-title').textContent = 'Could not load gateway activity';
        document.getElementById('connection-message').textContent = error.message;
        if (!requests.length) {
            requestRows.replaceChildren();
            const row = document.createElement('tr');
            const cell = addCell(row, 'empty-cell', 'Unable to load payment requests. Check that the local gateway is running and refresh.');
            cell.colSpan = 6;
            requestRows.append(row);
        }
    } finally {
        refreshButton.classList.remove('is-refreshing');
    }
}

searchInput.addEventListener('input', renderRows);
statusFilter.addEventListener('change', renderRows);
refreshButton.addEventListener('click', refresh);
scenarioButton.addEventListener('click', runScenario);
document.getElementById('close-drawer').addEventListener('click', closeDetails);
drawerBackdrop.addEventListener('click', closeDetails);
document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && drawer.classList.contains('open')) closeDetails();
});

refresh();
window.setInterval(refresh, 5000);
