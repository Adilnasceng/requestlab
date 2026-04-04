// RequestLab Panel — primary UI logic
// Runs inside the DevTools panel page (panel.html)

'use strict';

// ─── State ────────────────────────────────────────────────────────────────────
let port = null;
let tabId = null;
let isRecording = true;
let isPaused = false;
let selectedEntry = null;
let currentExportFmt = 'curl';
let editingRuleId = null;

// Request log (panel owns the authoritative copy)
const allRequests = [];           // RequestEntry[]
let filteredRequests = [];        // After filters applied
const wsConnectionMap = new Map(); // requestId -> ws object
const rlLog = [];                 // Rate-limited entries

// Virtual scroll state
const VS = {
  ROW_HEIGHT: 28,
  OVERSCAN: 6,
  scrollTop: 0,
  viewportHeight: 0,
  renderedStart: 0,
  renderedEnd: 0,
  rowPool: []
};

// CodeMirror instances
const editors = {};

// Rules
let rules = [];

// Keep-alive ping interval
let pingInterval = null;
let reconnectTimer = null;

// ─── Entry Point (called from devtools.js) ───────────────────────────────────
window.requestLabInit = function (inspectedTabId) {
  tabId = inspectedTabId;
  connectPort();
};

// ─── Port Management ──────────────────────────────────────────────────────────
function connectPort() {
  if (port) {
    try { port.disconnect(); } catch (e) {}
  }
  port = chrome.runtime.connect({ name: `panel-${tabId}` });
  port.onMessage.addListener(handleMessage);
  port.onDisconnect.addListener(handleDisconnect);

  // Request initial state
  port.postMessage({ type: 'INIT_PANEL', tabId });

  // Keep-alive ping every 20 seconds
  clearInterval(pingInterval);
  pingInterval = setInterval(() => {
    try { port.postMessage({ type: 'PING' }); } catch (e) {}
  }, 20000);

  setStatus('connected');
}

function handleDisconnect() {
  clearInterval(pingInterval);
  setStatus('disconnected');
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    connectPort();
  }, 600);
}

// ─── Message Handler ──────────────────────────────────────────────────────────
function handleMessage(msg) {
  switch (msg.type) {
    case 'INITIAL_STATE':
      if (msg.log?.length) {
        msg.log.forEach(e => addOrUpdateEntry(e, false));
        renderList();
      }
      if (msg.rules) {
        rules = msg.rules;
        renderRulesList();
      }
      if (msg.rateLimitBypass) applyRateLimitSettings(msg.rateLimitBypass);
      break;

    case 'REQUEST_STARTED':
      if (isRecording) addOrUpdateEntry(msg.entry, true);
      break;

    case 'REQUEST_COMPLETED':
      if (isRecording) {
        addOrUpdateEntry(msg.entry, false);
        if (selectedEntry?.id === msg.entry.id) {
          selectedEntry = msg.entry;
          renderDetailTabs();
        }
      }
      if (msg.entry.flags?.isRateLimited) {
        rlLog.unshift(msg.entry);
        renderRlLog();
      }
      break;

    case 'REPLAY_RESULT':
      addOrUpdateEntry(msg.entry, true);
      selectEntry(msg.entry);
      showReplayStatus(`Replay complete — status ${msg.entry.status}`, 'success');
      break;

    case 'REPLAY_ERROR':
      showReplayStatus(`Replay failed: ${msg.error}`, 'error');
      break;

    case 'RULES_UPDATED':
      rules = msg.rules;
      renderRulesList();
      break;

    case 'DEBUGGER_STATUS':
      setStatus(msg.attached ? 'connected' : 'disconnected');
      break;

    case 'DEBUGGER_ERROR':
      setStatus('error', msg.error);
      break;

    case 'PAUSE_STATE':
      isPaused = msg.paused;
      el('btn-pause').textContent = isPaused ? '▶ Resume' : '⏸ Pause';
      el('btn-pause').classList.toggle('active', isPaused);
      break;

    case 'LOG_CLEARED':
      allRequests.length = 0;
      filteredRequests = [];
      renderList();
      clearDetail();
      break;

    case 'WEBSOCKET_EVENT':
      handleWsEvent(msg.event);
      break;

    case 'PONG':
      break;
  }
}

// ─── Entry Management ─────────────────────────────────────────────────────────
function addOrUpdateEntry(entry, isNew) {
  const idx = allRequests.findIndex(e => e.id === entry.id);
  if (idx >= 0) {
    allRequests[idx] = entry;
  } else {
    allRequests.push(entry);
  }
  applyFilters();
  if (isNew) {
    const wasAtBottom = isScrolledToBottom();
    renderList();
    if (wasAtBottom) scrollToBottom();
  } else {
    const visIdx = filteredRequests.findIndex(e => e.id === entry.id);
    if (visIdx >= VS.renderedStart && visIdx < VS.renderedEnd) {
      renderList();
    }
  }
  updateFooter();
}

// ─── Filters ──────────────────────────────────────────────────────────────────
function applyFilters() {
  const urlFilter = el('filter-url').value.trim().toLowerCase();
  const methodFilter = el('filter-method').value;
  const typeFilter = el('filter-type').value;
  const rlFilter = el('filter-rate-limited').checked;

  filteredRequests = allRequests.filter(entry => {
    if (urlFilter && !entry.url.toLowerCase().includes(urlFilter) &&
        !entry.urlHost?.toLowerCase().includes(urlFilter)) return false;
    if (methodFilter && entry.method !== methodFilter) return false;
    if (typeFilter) {
      const mime = (entry.mimeType || '').toLowerCase();
      const rt = (entry.resourceType || '').toLowerCase();
      if (typeFilter === 'json' && !mime.includes('json')) return false;
      if (typeFilter === 'html' && !mime.includes('html')) return false;
      if (typeFilter === 'js' && !mime.includes('javascript') && !mime.includes('ecmascript')) return false;
      if (typeFilter === 'css' && !mime.includes('css')) return false;
      if (typeFilter === 'xhr' && rt !== 'xmlhttprequest' && rt !== 'fetch') return false;
      if (typeFilter === 'ws' && !entry.flags?.isWebSocket) return false;
    }
    if (rlFilter && !entry.flags?.isRateLimited) return false;
    return true;
  });
}

['filter-url', 'filter-method', 'filter-type', 'filter-rate-limited'].forEach(id => {
  document.addEventListener('DOMContentLoaded', () => {
    const elem = el(id);
    if (elem) {
      elem.addEventListener(id === 'filter-url' ? 'input' : 'change', () => {
        applyFilters();
        renderList();
        updateFooter();
      });
    }
  });
});

// ─── Virtual Scrolling ────────────────────────────────────────────────────────
function renderList() {
  const container = el('scroll-container');
  if (!container) return;
  VS.viewportHeight = container.clientHeight;

  const total = filteredRequests.length;
  const totalHeight = total * VS.ROW_HEIGHT;

  const start = Math.max(0, Math.floor(VS.scrollTop / VS.ROW_HEIGHT) - VS.OVERSCAN);
  const end = Math.min(total, Math.ceil((VS.scrollTop + VS.viewportHeight) / VS.ROW_HEIGHT) + VS.OVERSCAN);

  VS.renderedStart = start;
  VS.renderedEnd = end;

  el('spacer-top').style.height = `${start * VS.ROW_HEIGHT}px`;
  el('spacer-bottom').style.height = `${Math.max(0, (total - end)) * VS.ROW_HEIGHT}px`;

  const rowsContainer = el('virtual-rows');
  const visibleItems = filteredRequests.slice(start, end);

  // Reconcile DOM rows
  const existingRows = Array.from(rowsContainer.children);
  const needed = visibleItems.length;

  // Remove excess rows, return to pool
  while (rowsContainer.children.length > needed) {
    const row = rowsContainer.lastChild;
    rowsContainer.removeChild(row);
    VS.rowPool.push(row);
  }

  // Add/update rows
  visibleItems.forEach((entry, i) => {
    let row = rowsContainer.children[i];
    if (!row) {
      row = VS.rowPool.pop() || createRowElement();
      rowsContainer.appendChild(row);
    }
    populateRow(row, entry, start + i);
  });
}

function createRowElement() {
  const row = document.createElement('div');
  row.className = 'request-row';
  row.innerHTML = `<span class="col-method"></span><span class="col-status"></span><span class="col-url"></span><span class="col-type"></span><span class="col-size"></span><span class="col-time"></span>`;
  row.addEventListener('click', () => {
    if (row._entry) selectEntry(row._entry);
  });
  return row;
}

function populateRow(row, entry, _index) {
  row._entry = entry;
  row.className = 'request-row' +
    (entry.flags?.isRateLimited ? ' rate-limited' : '') +
    (entry.flags?.isReplayed ? ' replayed' : '') +
    (entry.flags?.isMocked ? ' mocked' : '') +
    (selectedEntry?.id === entry.id ? ' selected' : '');

  const cells = row.children;
  // Method
  cells[0].textContent = entry.method;
  cells[0].className = `col-method method-${entry.method}`;
  // Status
  const statusClass = !entry.status ? 'pending' :
    entry.status < 300 ? '2xx' : entry.status < 400 ? '3xx' :
    entry.status < 500 ? '4xx' : '5xx';
  cells[1].textContent = entry.status || '…';
  cells[1].className = `col-status status-${statusClass}`;
  // URL
  const url = entry.urlPath || entry.url;
  cells[2].textContent = (entry.urlHost ? entry.urlHost : '') + (url.length > 80 ? url.slice(0, 80) + '…' : url);
  cells[2].title = entry.url;
  // Type
  const mime = simplifyMime(entry.mimeType);
  cells[3].textContent = mime;
  // Size
  cells[4].textContent = entry.size?.responseBytes != null ? formatSize(entry.size.responseBytes) : '—';
  // Time
  cells[5].textContent = entry.timing?.duration != null ? `${entry.timing.duration}ms` : '…';
}

// ─── Detail Inspector ─────────────────────────────────────────────────────────
function selectEntry(entry) {
  selectedEntry = entry;
  // Update selection highlight in list
  const rows = el('virtual-rows').querySelectorAll('.request-row');
  rows.forEach(r => {
    r.classList.toggle('selected', r._entry?.id === entry.id);
  });

  // Show detail
  el('detail-empty').classList.add('hidden');
  el('detail-content').classList.remove('hidden');

  // Summary bar
  const methodEl = el('summary-method');
  methodEl.textContent = entry.method;
  methodEl.className = `method-badge method-${entry.method}`;

  const statusEl = el('summary-status');
  statusEl.textContent = entry.status || '…';
  const sc = !entry.status ? 'pending' : entry.status < 300 ? '2xx' : entry.status < 400 ? '3xx' : entry.status < 500 ? '4xx' : '5xx';
  statusEl.className = `status-badge status-${sc}`;

  el('summary-url').textContent = entry.url;
  el('summary-url').title = entry.url;
  el('summary-time').textContent = entry.timing?.duration != null ? `${entry.timing.duration}ms` : '';
  el('summary-size').textContent = entry.size?.responseBytes != null ? formatSize(entry.size.responseBytes) : '';

  // Flags
  const flagsEl = el('summary-flags');
  flagsEl.innerHTML = '';
  if (entry.flags?.isMocked) flagsEl.insertAdjacentHTML('beforeend', '<span class="flag-pill flag-mocked">MOCK</span>');
  if (entry.flags?.isModified) flagsEl.insertAdjacentHTML('beforeend', '<span class="flag-pill flag-modified">MODIFIED</span>');
  if (entry.flags?.isReplayed) flagsEl.insertAdjacentHTML('beforeend', '<span class="flag-pill flag-replayed">REPLAY</span>');
  if (entry.flags?.isRateLimited) flagsEl.insertAdjacentHTML('beforeend', '<span class="flag-pill flag-429">429</span>');

  renderDetailTabs();
}

function renderDetailTabs() {
  if (!selectedEntry) return;
  const activeTab = document.querySelector('.tab-btn.active')?.dataset.tab || 'headers';
  renderTab(activeTab);
}

function renderTab(tab) {
  if (!selectedEntry) return;
  switch (tab) {
    case 'headers': renderHeadersTab(); break;
    case 'body': renderBodyTab(); break;
    case 'response': renderResponseTab(); break;
    case 'replay': renderReplayTab(); break;
    case 'export': renderExportTab(); break;
    case 'ws': renderWsTab(); break;
  }
}

// ─── Headers Tab ─────────────────────────────────────────────────────────────
function renderHeadersTab() {
  const entry = selectedEntry;
  renderHeadersTable('req-headers-table', entry.requestHeaders || {});
  renderHeadersTable('resp-headers-table', entry.responseHeaders || {});

  // Auth tokens
  const tokens = entry.authTokens || [];
  const section = el('auth-tokens-section');
  const list = el('auth-tokens-list');
  if (tokens.length) {
    section.classList.remove('hidden');
    list.innerHTML = '';
    tokens.forEach(token => {
      const label = token.header || token.param || '';
      const div = document.createElement('div');
      div.className = 'token-entry';
      div.innerHTML = `
        <span class="token-type">${escHtml(token.type)}</span>
        <span class="token-label" style="color:var(--text-muted);font-size:10px">${escHtml(label)}</span>
        <span class="token-value" title="Click to reveal">${truncateToken(token.value)}</span>
        <button class="token-copy" title="Copy">⎘</button>
      `;
      const valEl = div.querySelector('.token-value');
      valEl.addEventListener('click', () => {
        if (valEl.classList.contains('revealed')) {
          valEl.textContent = truncateToken(token.value);
          valEl.classList.remove('revealed');
        } else {
          valEl.textContent = token.value;
          valEl.classList.add('revealed');
        }
      });
      div.querySelector('.token-copy').addEventListener('click', () => {
        navigator.clipboard.writeText(token.value);
      });
      list.appendChild(div);
    });
  } else {
    section.classList.add('hidden');
  }
}

function renderHeadersTable(tableId, headers) {
  const table = el(tableId);
  table.innerHTML = '';
  const entries = Object.entries(headers);
  if (!entries.length) {
    table.innerHTML = '<tr><td colspan="2" style="color:var(--text-muted);font-size:10px">—</td></tr>';
    return;
  }
  entries.forEach(([k, v]) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escHtml(k)}</td><td>${escHtml(v)}</td>`;
    table.appendChild(tr);
  });
}

// ─── Body Tab ────────────────────────────────────────────────────────────────
function renderBodyTab() {
  const entry = selectedEntry;
  const body = entry.requestBody || '';
  if (!editors.body) return;
  const formatted = tryFormatJSON(body);
  editors.body.setValue(formatted || body);
  editors.body.setOption('readOnly', false);
}

// ─── Response Tab ────────────────────────────────────────────────────────────
function renderResponseTab() {
  const entry = selectedEntry;
  if (!editors.response) return;

  el('response-mime').textContent = simplifyMime(entry.mimeType) || '';
  el('response-truncated').classList.toggle('hidden', !entry.responseBodyTruncated);

  const body = entry.responseBody || '';
  const formatted = entry.mimeType?.includes('json') ? (tryFormatJSON(body) || body) : body;
  editors.response.setValue(formatted);
}

// ─── Replay Tab ──────────────────────────────────────────────────────────────
function renderReplayTab() {
  const entry = selectedEntry;
  el('replay-method').value = entry.method;
  el('replay-url').value = entry.url;
  if (editors.replayHeaders) {
    editors.replayHeaders.setValue(JSON.stringify(entry.requestHeaders || {}, null, 2));
  }
  if (editors.replayBody) {
    editors.replayBody.setValue(tryFormatJSON(entry.requestBody) || entry.requestBody || '');
  }
  el('replay-status').classList.add('hidden');
}

// ─── Export Tab ──────────────────────────────────────────────────────────────
function renderExportTab() {
  const entry = selectedEntry;
  if (!entry || !editors.export) return;
  renderExportFormat(currentExportFmt, entry);
}

function renderExportFormat(fmt, entry) {
  if (!editors.export || !entry) return;
  let code = '';
  let mode = 'shell';
  switch (fmt) {
    case 'curl':
      code = generateCurl(entry);
      mode = 'shell';
      break;
    case 'fetch':
      code = generateFetch(entry);
      mode = { name: 'javascript', json: false };
      break;
    case 'python':
      code = generatePython(entry);
      mode = 'python';
      break;
  }
  editors.export.setOption('mode', mode);
  editors.export.setValue(code);
}

// ─── WebSocket Tab ────────────────────────────────────────────────────────────
function renderWsTab() {
  const entry = selectedEntry;
  if (!entry) return;

  // Find WS connection associated with this entry URL (approximate match)
  let ws = null;
  for (const [, conn] of wsConnectionMap) {
    if (conn.url === entry.url || entry.url?.includes(conn.url?.split('/').pop())) {
      ws = conn;
      break;
    }
  }

  if (!ws) {
    el('ws-empty').classList.remove('hidden');
    el('ws-info').classList.add('hidden');
    return;
  }

  el('ws-empty').classList.add('hidden');
  el('ws-info').classList.remove('hidden');

  el('ws-header-info').innerHTML =
    `<strong>${escHtml(ws.url)}</strong> &nbsp;` +
    `<span style="color:var(--text-muted)">${ws.frames.length} frames</span>` +
    (ws.closed ? ' <span style="color:var(--red)">closed</span>' : ' <span style="color:var(--green)">open</span>');

  const framesList = el('ws-frames-list');
  framesList.innerHTML = '';
  ws.frames.slice().reverse().forEach(frame => {
    const div = document.createElement('div');
    div.className = `ws-frame ${frame.direction}`;
    const ts = new Date(frame.timestamp).toLocaleTimeString();
    const dataContent = frame.isJson
      ? `<pre class="ws-json">${escHtml(JSON.stringify(frame.parsed, null, 2))}</pre>`
      : `<span class="ws-text">${escHtml(frame.data.slice(0, 500))}${frame.data.length > 500 ? '…' : ''}</span>`;
    div.innerHTML = `
      <span class="ws-dir">${frame.direction === 'inbound' ? '↓' : '↑'}</span>
      <span class="ws-time">${ts}</span>
      <div class="ws-data">${dataContent}</div>
    `;
    div.querySelector('.ws-data').addEventListener('click', e => {
      e.currentTarget.classList.toggle('expanded');
    });
    framesList.appendChild(div);
  });
}

// ─── WebSocket Event Handling ─────────────────────────────────────────────────
function handleWsEvent(event) {
  switch (event.subtype) {
    case 'created':
      wsConnectionMap.set(event.ws.id, event.ws);
      break;
    case 'frame': {
      const ws = wsConnectionMap.get(event.requestId);
      if (ws) ws.frames.push(event.frame);
      if (selectedEntry && document.querySelector('[data-tab="ws"]')?.classList.contains('active')) {
        renderWsTab();
      }
      break;
    }
    case 'closed': {
      const ws = wsConnectionMap.get(event.requestId);
      if (ws) ws.closed = true;
      break;
    }
  }
}

// ─── Export Generators ────────────────────────────────────────────────────────
function generateCurl(entry) {
  const headers = Object.entries(entry.requestHeaders || {})
    .map(([k, v]) => `  -H '${k}: ${v.replace(/'/g, "'\\''")}'`)
    .join(' \\\n');
  const body = entry.requestBody
    ? ` \\\n  --data '${entry.requestBody.replace(/'/g, "'\\''")}'`
    : '';
  return `curl -X ${entry.method} '${entry.url}' \\\n${headers}${body}`;
}

function generateFetch(entry) {
  const opts = {
    method: entry.method,
    headers: entry.requestHeaders || {}
  };
  if (entry.requestBody && !['GET', 'HEAD'].includes(entry.method)) {
    opts.body = entry.requestBody;
  }
  return `fetch('${entry.url}', ${JSON.stringify(opts, null, 2)})
  .then(r => r.json())
  .then(data => console.log(data))
  .catch(err => console.error(err));`;
}

function generatePython(entry) {
  const method = entry.method.lower ? entry.method.toLowerCase() : entry.method.toLowerCase();
  const headers = JSON.stringify(entry.requestHeaders || {}, null, 4)
    .split('\n').join('\n    ');
  let bodyLine = '';
  if (entry.requestBody && !['GET', 'HEAD'].includes(entry.method)) {
    const parsed = tryParseJSON(entry.requestBody);
    if (parsed) {
      bodyLine = `,\n    json=${JSON.stringify(parsed, null, 4).split('\n').join('\n    ')}`;
    } else {
      bodyLine = `,\n    data=${JSON.stringify(entry.requestBody)}`;
    }
  }
  return `import requests

headers = ${headers}

response = requests.${method}(
    '${entry.url}',
    headers=headers${bodyLine}
)

print(response.status_code)
print(response.json())`;
}

// ─── Rules Engine UI ──────────────────────────────────────────────────────────
function renderRulesList() {
  const list = el('rules-list');
  const empty = el('rules-empty');
  list.innerHTML = '';
  if (!rules.length) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  rules.forEach(rule => {
    const card = document.createElement('div');
    card.className = `rule-card${rule.enabled ? '' : ' disabled'}`;
    card.innerHTML = `
      <div class="rule-info">
        <div class="rule-name">${escHtml(rule.name || 'Unnamed Rule')}</div>
        <div class="rule-meta">
          <span class="rule-type-badge">${escHtml(rule.type)}</span>
          ${rule.conditions?.urlPattern ? `<span title="URL pattern">${escHtml(rule.conditions.urlPattern)}</span>` : ''}
          ${rule.hitCount ? `<span class="rule-hits">hits: ${rule.hitCount}</span>` : ''}
        </div>
      </div>
      <div class="rule-actions">
        <button class="icon-btn" title="${rule.enabled ? 'Disable' : 'Enable'}">${rule.enabled ? '●' : '○'}</button>
        <button class="icon-btn" title="Edit">✏</button>
        <button class="icon-btn danger" title="Delete">✕</button>
      </div>
    `;
    const [toggleBtn, editBtn, deleteBtn] = card.querySelectorAll('.icon-btn');
    toggleBtn.addEventListener('click', () => {
      rule.enabled = !rule.enabled;
      port.postMessage({ type: 'SAVE_RULE', rule });
    });
    editBtn.addEventListener('click', () => openRuleModal(rule));
    deleteBtn.addEventListener('click', () => {
      if (confirm(`Delete rule "${rule.name}"?`)) {
        port.postMessage({ type: 'DELETE_RULE', ruleId: rule.id });
      }
    });
    list.appendChild(card);
  });
}

// ─── Rule Modal ───────────────────────────────────────────────────────────────
function openRuleModal(existingRule) {
  editingRuleId = existingRule?.id || null;
  el('rule-modal-title').textContent = existingRule ? 'Edit Rule' : 'Add Rule';
  el('rule-name').value = existingRule?.name || '';
  el('rule-type').value = existingRule?.type || 'mock_response';
  el('rule-url-pattern').value = existingRule?.conditions?.urlPattern || '';
  el('rule-url-regex').checked = existingRule?.conditions?.urlRegex || false;
  el('rule-priority').value = existingRule?.priority || 10;
  el('rule-enabled').checked = existingRule?.enabled !== false;

  // Method checkboxes
  document.querySelectorAll('[name="rule-method"]').forEach(cb => {
    cb.checked = existingRule?.conditions?.methods?.includes(cb.value) || false;
  });

  updateRuleActionFields(el('rule-type').value, existingRule?.action);
  el('rule-modal-overlay').classList.remove('hidden');
}

function updateRuleActionFields(type, existingAction) {
  const container = el('rule-action-fields');
  container.innerHTML = '';

  const addField = (label, id, type, value, placeholder) => {
    const div = document.createElement('div');
    div.className = 'form-row';
    if (type === 'textarea') {
      div.innerHTML = `<label>${label}</label><textarea id="${id}" placeholder="${placeholder || ''}">${escHtml(value || '')}</textarea>`;
    } else {
      div.innerHTML = `<label>${label}</label><input type="${type}" id="${id}" value="${escHtml(value || '')}" placeholder="${placeholder || ''}">`;
    }
    container.appendChild(div);
  };

  switch (type) {
    case 'mock_response':
    case 'modify_response_body':
    case 'modify_request_body':
      addField('Response/Body Content', 'action-body', 'textarea', existingAction?.responseBody, '{"key": "value"}');
      addField('Status Code', 'action-status', 'number', existingAction?.statusCode || 200, '200');
      addField('MIME Type', 'action-mime', 'text', existingAction?.mimeType || 'application/json', 'application/json');
      break;
    case 'inject_request_header':
    case 'inject_response_header':
      addField('Header Name', 'action-header-name', 'text', existingAction?.headerName, 'X-Custom-Header');
      addField('Header Value', 'action-header-value', 'text', existingAction?.headerValue, 'my-value');
      break;
    case 'remove_request_header':
      addField('Header Name', 'action-header-name', 'text', existingAction?.headerName, 'X-Rate-Limit');
      break;
    case 'status_override':
      addField('Override Status Code', 'action-status', 'number', existingAction?.statusCode || 200, '200');
      break;
    case 'redirect':
      addField('Redirect URL', 'action-redirect', 'text', existingAction?.redirectUrl, 'https://example.com');
      break;
    case 'block_request':
      container.innerHTML = '<div style="color:var(--text-muted);font-size:11px;padding:4px 0">Matching requests will be blocked entirely.</div>';
      break;
  }
}

function collectRuleFromModal() {
  const type = el('rule-type').value;
  const methods = Array.from(document.querySelectorAll('[name="rule-method"]:checked')).map(c => c.value);

  const action = {};
  const bodyEl = el('action-body');
  const statusEl = el('action-status');
  const mimeEl = el('action-mime');
  const headerNameEl = el('action-header-name');
  const headerValueEl = el('action-header-value');
  const redirectEl = el('action-redirect');

  if (bodyEl) action.responseBody = bodyEl.value;
  if (statusEl) action.statusCode = parseInt(statusEl.value) || 200;
  if (mimeEl) action.mimeType = mimeEl.value;
  if (headerNameEl) action.headerName = headerNameEl.value;
  if (headerValueEl) action.headerValue = headerValueEl.value;
  if (redirectEl) action.redirectUrl = redirectEl.value;

  return {
    id: editingRuleId,
    name: el('rule-name').value || 'Unnamed Rule',
    type,
    enabled: el('rule-enabled').checked,
    priority: parseInt(el('rule-priority').value) || 10,
    conditions: {
      urlPattern: el('rule-url-pattern').value,
      urlRegex: el('rule-url-regex').checked,
      methods: methods.length ? methods : []
    },
    action
  };
}

// ─── Rate Limit Bypass UI ─────────────────────────────────────────────────────
function applyRateLimitSettings(settings) {
  el('rl-enabled').checked = settings.enabled || false;
  el('rl-strip-headers').checked = settings.stripHeaders !== false;
  el('rl-rotate-ua').checked = settings.rotateUA || false;
  el('rl-delay').value = settings.addDelay || 0;
}

function collectRlSettings() {
  return {
    enabled: el('rl-enabled').checked,
    stripHeaders: el('rl-strip-headers').checked,
    rotateUA: el('rl-rotate-ua').checked,
    addDelay: parseInt(el('rl-delay').value) || 0
  };
}

function renderRlLog() {
  const list = el('rl-log-list');
  list.innerHTML = '';
  rlLog.slice(0, 50).forEach(entry => {
    const div = document.createElement('div');
    div.className = 'rl-entry';
    div.innerHTML = `
      <span class="rl-entry-url">${escHtml(entry.url)}</span>
      <span class="rl-entry-meta">
        ${new Date(entry.timestamp).toLocaleTimeString()}
        ${entry.retryAfter ? ` · Retry-After: ${entry.retryAfter}s` : ''}
      </span>
    `;
    list.appendChild(div);
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function el(id) { return document.getElementById(id); }

function escHtml(str) {
  if (str == null) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatSize(bytes) {
  if (bytes == null) return '—';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function simplifyMime(mime) {
  if (!mime) return '';
  if (mime.includes('json')) return 'JSON';
  if (mime.includes('html')) return 'HTML';
  if (mime.includes('javascript') || mime.includes('ecmascript')) return 'JS';
  if (mime.includes('css')) return 'CSS';
  if (mime.includes('xml')) return 'XML';
  if (mime.includes('text/plain')) return 'text';
  if (mime.includes('image')) return 'img';
  if (mime.includes('font')) return 'font';
  if (mime.includes('wasm')) return 'wasm';
  return mime.split(';')[0].split('/').pop() || mime;
}

function tryFormatJSON(str) {
  if (!str) return null;
  try { return JSON.stringify(JSON.parse(str), null, 2); } catch (e) { return null; }
}

function tryParseJSON(str) {
  if (!str) return null;
  try { return JSON.parse(str); } catch (e) { return null; }
}

function truncateToken(val) {
  if (!val) return '';
  if (val.length <= 20) return val;
  return val.slice(0, 10) + '…' + val.slice(-6);
}

function setStatus(state, error) {
  const el_ = el('status-indicator');
  if (state === 'connected') {
    el_.textContent = '● Connected';
    el_.className = 'status-indicator status-connected';
  } else if (state === 'error') {
    el_.textContent = '● Error';
    el_.className = 'status-indicator status-error';
    el_.title = error || '';
  } else {
    el_.textContent = '● Disconnected';
    el_.className = 'status-indicator status-disconnected';
  }
}

function updateFooter() {
  el('request-count').textContent = `${allRequests.length} request${allRequests.length !== 1 ? 's' : ''}`;
  const fCount = filteredRequests.length;
  if (fCount !== allRequests.length) {
    el('filtered-count').textContent = `(${fCount} shown)`;
  } else {
    el('filtered-count').textContent = '';
  }
}

function clearDetail() {
  selectedEntry = null;
  el('detail-empty').classList.remove('hidden');
  el('detail-content').classList.add('hidden');
}

function isScrolledToBottom() {
  const c = el('scroll-container');
  if (!c) return true;
  return c.scrollHeight - c.scrollTop - c.clientHeight < VS.ROW_HEIGHT * 2;
}

function scrollToBottom() {
  const c = el('scroll-container');
  if (c) c.scrollTop = c.scrollHeight;
}

function showReplayStatus(msg, type) {
  const el_ = el('replay-status');
  el_.textContent = msg;
  el_.className = type;
  el_.classList.remove('hidden');
  setTimeout(() => el_.classList.add('hidden'), 4000);
}

// ─── Init CodeMirror ──────────────────────────────────────────────────────────
function initEditors() {
  const CM_OPTS = {
    theme: 'material-darker',
    lineNumbers: true,
    matchBrackets: true,
    autoCloseBrackets: true,
    foldGutter: true,
    gutters: ['CodeMirror-linenumbers', 'CodeMirror-foldgutter'],
    lineWrapping: true,
    tabSize: 2
  };

  editors.body = CodeMirror(el('codemirror-body'), {
    ...CM_OPTS,
    mode: { name: 'javascript', json: true },
    extraKeys: {
      'Ctrl-S': () => {
        if (selectedEntry && port) {
          port.postMessage({
            type: 'RESUME_REQUEST',
            requestId: selectedEntry.requestId,
            modifications: { body: editors.body.getValue() }
          });
          showReplayStatus('Body modification queued', 'success');
        }
      }
    }
  });

  editors.response = CodeMirror(el('codemirror-response'), {
    ...CM_OPTS,
    mode: { name: 'javascript', json: true },
    readOnly: true
  });

  editors.replayHeaders = CodeMirror(el('codemirror-replay-headers'), {
    ...CM_OPTS,
    mode: { name: 'javascript', json: true }
  });

  editors.replayBody = CodeMirror(el('codemirror-replay-body'), {
    ...CM_OPTS,
    mode: { name: 'javascript', json: true }
  });

  editors.export = CodeMirror(el('codemirror-export'), {
    ...CM_OPTS,
    mode: 'shell',
    readOnly: true
  });
}

// ─── DOM Event Wiring ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initEditors();

  // Scroll
  el('scroll-container').addEventListener('scroll', () => {
    VS.scrollTop = el('scroll-container').scrollTop;
    requestAnimationFrame(renderList);
  });

  // ResizeObserver for viewport height changes
  new ResizeObserver(() => {
    VS.viewportHeight = el('scroll-container').clientHeight;
    renderList();
  }).observe(el('scroll-container'));

  // Toolbar
  el('btn-record').addEventListener('click', () => {
    isRecording = !isRecording;
    el('btn-record').classList.toggle('active', isRecording);
  });

  el('btn-pause').addEventListener('click', () => {
    if (!port) return;
    isPaused = !isPaused;
    port.postMessage({ type: 'TOGGLE_PAUSE', paused: isPaused });
  });

  el('btn-clear').addEventListener('click', () => {
    if (port) port.postMessage({ type: 'CLEAR_LOG' });
    allRequests.length = 0;
    filteredRequests = [];
    renderList();
    clearDetail();
    updateFooter();
  });

  // Filters
  el('filter-url').addEventListener('input', () => { applyFilters(); renderList(); updateFooter(); });
  el('filter-method').addEventListener('change', () => { applyFilters(); renderList(); updateFooter(); });
  el('filter-type').addEventListener('change', () => { applyFilters(); renderList(); updateFooter(); });
  el('filter-rate-limited').addEventListener('change', () => { applyFilters(); renderList(); updateFooter(); });

  // Disclaimer dismiss
  el('btn-dismiss-disclaimer').addEventListener('click', () => {
    el('disclaimer-banner').classList.add('hidden');
    el('main-layout').classList.add('disclaimer-hidden');
  });

  // Detail tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => {
        p.classList.remove('active');
        p.classList.add('hidden');
      });
      btn.classList.add('active');
      const panel = el(`tab-${btn.dataset.tab}`);
      if (panel) {
        panel.classList.remove('hidden');
        panel.classList.add('active');
      }
      renderTab(btn.dataset.tab);
    });
  });

  // Body tab buttons
  el('btn-format-body').addEventListener('click', () => {
    if (!editors.body) return;
    const formatted = tryFormatJSON(editors.body.getValue());
    if (formatted) editors.body.setValue(formatted);
  });

  el('btn-apply-body').addEventListener('click', () => {
    if (selectedEntry && port) {
      port.postMessage({
        type: 'RESUME_REQUEST',
        requestId: selectedEntry.requestId,
        modifications: { body: editors.body.getValue() }
      });
      showReplayStatus('Body queued for modification', 'success');
    }
  });

  // Response tab buttons
  el('btn-format-response').addEventListener('click', () => {
    if (!editors.response) return;
    const formatted = tryFormatJSON(editors.response.getValue());
    if (formatted) editors.response.setValue(formatted);
  });

  // Replay
  el('btn-replay-send').addEventListener('click', () => {
    if (!selectedEntry || !port) return;
    let headers = {};
    try { headers = JSON.parse(editors.replayHeaders.getValue()); } catch (e) {}
    port.postMessage({
      type: 'REPLAY_REQUEST',
      entryId: selectedEntry.id,
      modifications: {
        method: el('replay-method').value,
        url: el('replay-url').value,
        headers,
        body: editors.replayBody.getValue() || null
      }
    });
    el('btn-replay-send').disabled = true;
    setTimeout(() => { el('btn-replay-send').disabled = false; }, 2000);
  });

  el('btn-replay-reset').addEventListener('click', () => {
    if (selectedEntry) renderReplayTab();
  });

  // Export format tabs
  document.querySelectorAll('.export-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.export-tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentExportFmt = btn.dataset.fmt;
      if (selectedEntry) renderExportFormat(currentExportFmt, selectedEntry);
    });
  });

  el('btn-copy-export').addEventListener('click', () => {
    if (editors.export) {
      navigator.clipboard.writeText(editors.export.getValue());
      el('btn-copy-export').textContent = 'Copied!';
      setTimeout(() => { el('btn-copy-export').textContent = 'Copy to Clipboard'; }, 1500);
    }
  });

  // Rules panel
  el('btn-rules-toggle').addEventListener('click', () => {
    el('rules-panel').classList.toggle('hidden');
    el('rl-bypass-panel').classList.add('hidden');
  });
  el('btn-rules-close').addEventListener('click', () => el('rules-panel').classList.add('hidden'));

  el('btn-add-rule').addEventListener('click', () => openRuleModal(null));

  // Rule modal
  el('rule-type').addEventListener('change', () => {
    updateRuleActionFields(el('rule-type').value, null);
  });

  el('btn-rule-save').addEventListener('click', () => {
    const rule = collectRuleFromModal();
    port.postMessage({ type: 'SAVE_RULE', rule });
    el('rule-modal-overlay').classList.add('hidden');
  });

  el('btn-rule-cancel').addEventListener('click', () => {
    el('rule-modal-overlay').classList.add('hidden');
  });

  el('btn-rule-modal-close').addEventListener('click', () => {
    el('rule-modal-overlay').classList.add('hidden');
  });

  el('rule-modal-overlay').addEventListener('click', (e) => {
    if (e.target === el('rule-modal-overlay')) el('rule-modal-overlay').classList.add('hidden');
  });

  // Rate limit bypass panel
  el('btn-rl-bypass-toggle').addEventListener('click', () => {
    el('rl-bypass-panel').classList.toggle('hidden');
    el('rules-panel').classList.add('hidden');
  });
  el('btn-rl-close').addEventListener('click', () => el('rl-bypass-panel').classList.add('hidden'));

  ['rl-enabled', 'rl-strip-headers', 'rl-rotate-ua', 'rl-delay'].forEach(id => {
    el(id)?.addEventListener('change', () => {
      if (port) port.postMessage({ type: 'UPDATE_RATE_LIMIT_SETTINGS', settings: collectRlSettings() });
    });
  });

  // Resize handle (pane drag)
  const handle = el('resize-handle');
  const listPane = el('request-list-pane');
  let dragging = false, startX = 0, startW = 0;

  handle.addEventListener('mousedown', e => {
    dragging = true;
    startX = e.clientX;
    startW = listPane.getBoundingClientRect().width;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const delta = e.clientX - startX;
    const newW = Math.min(Math.max(startW + delta, 220), window.innerWidth * 0.8);
    listPane.style.width = `${newW}px`;
  });
  document.addEventListener('mouseup', () => {
    if (dragging) {
      dragging = false;
      handle.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  });

  updateFooter();
});
