// RequestLab Service Worker
// Handles: debugger lifecycle, request interception, rules engine, replay, WebSocket monitoring

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  debuggerSessions: new Map(),  // tabId -> { attached: bool, paused: bool }
  requestLog: new Map(),        // entryId -> RequestEntry
  panelPorts: new Map(),        // tabId -> port
  wsConnections: new Map(),     // requestId -> { url, frames[], createdAt, closed }
  pendingRequests: new Map(),   // requestId -> { tabId, resolve } (paused requests)
  rules: [],                    // Rule[]
  rateLimitBypass: {
    enabled: false,
    stripHeaders: true,
    rotateUA: false,
    addDelay: 0
  },
  requestCounter: 0,
  attachLocks: new Set()
};

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15'
];
let uaRotateIndex = 0;

// ─── Initialization ───────────────────────────────────────────────────────────
async function init() {
  await loadRules();
  await loadRateLimitSettings();
}
init();

// ─── Port Management ──────────────────────────────────────────────────────────
chrome.runtime.onConnect.addListener((port) => {
  if (!port.name.startsWith('panel-')) return;
  const tabId = parseInt(port.name.split('-')[1]);
  if (isNaN(tabId)) return;

  state.panelPorts.set(tabId, port);

  port.onMessage.addListener((msg) => handlePanelMessage(tabId, msg));
  port.onDisconnect.addListener(() => {
    state.panelPorts.delete(tabId);
    detachDebugger(tabId);
  });
});

// ─── Panel Message Handler ────────────────────────────────────────────────────
async function handlePanelMessage(tabId, msg) {
  switch (msg.type) {
    case 'INIT_PANEL':
      await attachDebugger(tabId);
      sendToPanel(tabId, {
        type: 'INITIAL_STATE',
        log: Array.from(state.requestLog.values()).filter(e => e.tabId === tabId),
        rules: state.rules,
        rateLimitBypass: state.rateLimitBypass,
        wsConnections: Array.from(state.wsConnections.values())
      });
      break;

    case 'ATTACH_DEBUGGER':
      await attachDebugger(tabId);
      break;

    case 'DETACH_DEBUGGER':
      await detachDebugger(tabId);
      break;

    case 'TOGGLE_PAUSE': {
      const session = state.debuggerSessions.get(tabId);
      if (session) {
        session.paused = msg.paused;
        sendToPanel(tabId, { type: 'PAUSE_STATE', paused: session.paused });
      }
      break;
    }

    case 'RESUME_REQUEST': {
      const pending = state.pendingRequests.get(msg.requestId);
      if (pending) {
        pending.resolve(msg.modifications || null);
        state.pendingRequests.delete(msg.requestId);
      }
      break;
    }

    case 'REPLAY_REQUEST':
      replayRequest(tabId, msg.entryId, msg.modifications);
      break;

    case 'SAVE_RULE':
      await saveRule(msg.rule);
      break;

    case 'DELETE_RULE':
      await deleteRule(msg.ruleId);
      break;

    case 'REORDER_RULES':
      await reorderRules(msg.ruleIds);
      break;

    case 'UPDATE_RATE_LIMIT_SETTINGS':
      state.rateLimitBypass = { ...state.rateLimitBypass, ...msg.settings };
      await chrome.storage.local.set({ rateLimitBypass: state.rateLimitBypass });
      break;

    case 'CLEAR_LOG':
      for (const [id, entry] of state.requestLog) {
        if (entry.tabId === tabId) state.requestLog.delete(id);
      }
      sendToPanel(tabId, { type: 'LOG_CLEARED' });
      break;

    case 'PING':
      sendToPanel(tabId, { type: 'PONG' });
      break;
  }
}

// ─── Send to Panel ────────────────────────────────────────────────────────────
function sendToPanel(tabId, msg) {
  const port = state.panelPorts.get(tabId);
  if (port) {
    try { port.postMessage(msg); } catch (e) { /* port disconnected */ }
  }
}

// ─── Debugger Lifecycle ───────────────────────────────────────────────────────
async function attachDebugger(tabId) {
  if (state.debuggerSessions.get(tabId)?.attached) return;
  if (state.attachLocks.has(tabId)) return;
  state.attachLocks.add(tabId);

  try {
    await chrome.debugger.attach({ tabId }, '1.3');
    await chrome.debugger.sendCommand({ tabId }, 'Fetch.enable', {
      patterns: [
        { urlPattern: '*', requestStage: 'Request' },
        { urlPattern: '*', requestStage: 'Response' }
      ]
    });
    await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {});
    state.debuggerSessions.set(tabId, { attached: true, paused: false });
    sendToPanel(tabId, { type: 'DEBUGGER_STATUS', attached: true, tabId });
  } catch (err) {
    const msg = err.message || String(err);
    if (msg.includes('already attached')) {
      sendToPanel(tabId, {
        type: 'DEBUGGER_ERROR',
        error: 'Another debugger is already attached to this tab. Close Chrome DevTools or other debugger extensions first.'
      });
    } else {
      sendToPanel(tabId, { type: 'DEBUGGER_ERROR', error: msg });
    }
  } finally {
    state.attachLocks.delete(tabId);
  }
}

async function detachDebugger(tabId) {
  const session = state.debuggerSessions.get(tabId);
  if (!session?.attached) return;
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Fetch.disable');
    await chrome.debugger.detach({ tabId });
  } catch (e) { /* tab may be closed */ }
  state.debuggerSessions.delete(tabId);
  sendToPanel(tabId, { type: 'DEBUGGER_STATUS', attached: false, tabId });
}

chrome.debugger.onDetach.addListener((source, reason) => {
  const { tabId } = source;
  state.debuggerSessions.delete(tabId);
  // Resume any pending paused requests to avoid hanging the tab
  for (const [reqId, pending] of state.pendingRequests) {
    if (pending.tabId === tabId) {
      pending.resolve(null);
      state.pendingRequests.delete(reqId);
    }
  }
  sendToPanel(tabId, { type: 'DEBUGGER_STATUS', attached: false, reason, tabId });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  state.debuggerSessions.delete(tabId);
  state.panelPorts.delete(tabId);
  for (const [id, entry] of state.requestLog) {
    if (entry.tabId === tabId) state.requestLog.delete(id);
  }
});

// ─── CDP Event Handler ────────────────────────────────────────────────────────
chrome.debugger.onEvent.addListener(async (source, method, params) => {
  const { tabId } = source;
  const session = state.debuggerSessions.get(tabId);
  if (!session?.attached) return;

  if (method === 'Fetch.requestPaused') {
    if (params.responseStatusCode !== undefined || params.responseErrorReason !== undefined) {
      await handleResponseStage(tabId, params);
    } else {
      await handleRequestStage(tabId, params);
    }
    return;
  }

  // WebSocket events
  switch (method) {
    case 'Network.webSocketCreated':
      handleWsCreated(tabId, params);
      break;
    case 'Network.webSocketHandshakeResponseReceived':
      handleWsHandshake(tabId, params);
      break;
    case 'Network.webSocketFrameReceived':
      handleWsFrame(tabId, params, 'inbound');
      break;
    case 'Network.webSocketFrameSent':
      handleWsFrame(tabId, params, 'outbound');
      break;
    case 'Network.webSocketClosed':
      handleWsClosed(tabId, params);
      break;
  }
});

// ─── Request Stage ────────────────────────────────────────────────────────────
async function handleRequestStage(tabId, params) {
  const { requestId, request, frameId, resourceType } = params;

  // Always pass through WebSocket upgrades unmodified
  const isWsUpgrade = (request.headers['upgrade'] || request.headers['Upgrade'] || '').toLowerCase() === 'websocket';
  if (isWsUpgrade) {
    await cdpContinueRequest(tabId, requestId);
    return;
  }

  const session = state.debuggerSessions.get(tabId);
  const entryId = `${tabId}-${++state.requestCounter}`;

  // Parse URL
  let urlParsed;
  try { urlParsed = new URL(request.url); } catch (e) { urlParsed = null; }

  // Normalise headers to lowercase keys
  const reqHeaders = normalizeHeaders(request.headers || {});

  // Build entry
  const entry = {
    id: entryId,
    requestId,
    tabId,
    timestamp: Date.now(),
    method: request.method,
    url: request.url,
    urlHost: urlParsed?.hostname || '',
    urlPath: urlParsed?.pathname || '',
    requestHeaders: reqHeaders,
    requestBody: request.postData || null,
    requestBodyParsed: tryParseJSON(request.postData),
    status: null,
    responseHeaders: {},
    responseBody: null,
    responseBodyParsed: null,
    mimeType: reqHeaders['content-type'] || '',
    resourceType: resourceType || '',
    timing: { requestStart: Date.now(), responseStart: null, responseEnd: null, duration: null },
    size: { requestBytes: estimateRequestSize(request), responseBytes: null },
    flags: { isRateLimited: false, isModified: false, isMocked: false, isReplayed: false },
    authTokens: extractAuthTokens(reqHeaders, urlParsed),
    wsFrames: []
  };

  state.requestLog.set(entryId, entry);
  // Map requestId -> entryId for response stage lookup
  state.requestLog.set(`rid:${requestId}:${tabId}`, entryId);

  // ── Apply rules ──
  const matchingRules = findMatchingRules(entry, 'request');
  let modifiedHeaders = { ...reqHeaders };
  let modifiedBody = entry.requestBody;
  let mocked = false;

  for (const rule of matchingRules) {
    if (!rule.enabled) continue;
    rule.hitCount = (rule.hitCount || 0) + 1;
    rule.lastHit = Date.now();

    if (rule.type === 'mock_response') {
      const responseBody = rule.action.responseBody || '{}';
      const status = rule.action.statusCode || 200;
      const mime = rule.action.mimeType || 'application/json';
      await chrome.debugger.sendCommand({ tabId }, 'Fetch.fulfillRequest', {
        requestId,
        responseCode: status,
        responseHeaders: [
          { name: 'content-type', value: mime },
          { name: 'x-requestlab-mocked', value: 'true' }
        ],
        body: btoa(unescape(encodeURIComponent(responseBody)))
      });
      entry.flags.isMocked = true;
      entry.flags.isModified = true;
      entry.status = status;
      entry.responseBody = responseBody;
      entry.responseBodyParsed = tryParseJSON(responseBody);
      entry.mimeType = mime;
      entry.timing.responseStart = Date.now();
      entry.timing.responseEnd = Date.now();
      entry.timing.duration = 0;
      sendToPanel(tabId, { type: 'REQUEST_STARTED', entry: serializeEntry(entry) });
      sendToPanel(tabId, { type: 'REQUEST_COMPLETED', entry: serializeEntry(entry) });
      mocked = true;
      break;
    }

    if (rule.type === 'inject_request_header') {
      modifiedHeaders[rule.action.headerName.toLowerCase()] = rule.action.headerValue;
      entry.flags.isModified = true;
    }
    if (rule.type === 'remove_request_header') {
      delete modifiedHeaders[rule.action.headerName.toLowerCase()];
      entry.flags.isModified = true;
    }
    if (rule.type === 'modify_request_body' && modifiedBody) {
      modifiedBody = applyBodyModification(modifiedBody, rule.action);
      entry.flags.isModified = true;
    }
  }

  if (mocked) return;

  // ── Rate limit bypass ──
  if (state.rateLimitBypass.enabled) {
    if (state.rateLimitBypass.stripHeaders) {
      for (const key of Object.keys(modifiedHeaders)) {
        if (/^x-ratelimit/i.test(key) || key === 'retry-after') {
          delete modifiedHeaders[key];
        }
      }
    }
    if (state.rateLimitBypass.rotateUA) {
      modifiedHeaders['user-agent'] = USER_AGENTS[uaRotateIndex % USER_AGENTS.length];
      uaRotateIndex++;
    }
    if (state.rateLimitBypass.addDelay > 0) {
      await sleep(state.rateLimitBypass.addDelay);
    }
  }

  // Notify panel before continuing (so it shows immediately)
  sendToPanel(tabId, { type: 'REQUEST_STARTED', entry: serializeEntry(entry) });

  // ── If paused, wait for user to resume ──
  if (session?.paused) {
    const modifications = await waitForResume(requestId, tabId);
    if (modifications) {
      if (modifications.headers) modifiedHeaders = modifications.headers;
      if (modifications.body !== undefined) modifiedBody = modifications.body;
      if (modifications.url) {
        // redirect to new URL
        await chrome.debugger.sendCommand({ tabId }, 'Fetch.continueRequest', {
          requestId,
          url: modifications.url,
          headers: headersToArray(modifiedHeaders),
          postData: modifiedBody ? btoa(unescape(encodeURIComponent(modifiedBody))) : undefined
        });
        return;
      }
    }
  }

  // Continue with (possibly modified) request
  const continueParams = { requestId };
  const headersArr = headersToArray(modifiedHeaders);
  if (entry.flags.isModified) {
    continueParams.headers = headersArr;
    if (modifiedBody !== entry.requestBody) {
      continueParams.postData = modifiedBody ? btoa(unescape(encodeURIComponent(modifiedBody))) : undefined;
    }
  }

  try {
    await chrome.debugger.sendCommand({ tabId }, 'Fetch.continueRequest', continueParams);
  } catch (e) {
    // Request may have been cancelled
  }
}

// ─── Response Stage ───────────────────────────────────────────────────────────
async function handleResponseStage(tabId, params) {
  const { requestId, responseStatusCode, responseHeaders, responseErrorReason } = params;

  // Look up entry
  const entryIdKey = `rid:${requestId}:${tabId}`;
  const entryId = state.requestLog.get(entryIdKey);
  const entry = entryId ? state.requestLog.get(entryId) : null;

  if (entry) {
    entry.timing.responseStart = Date.now();
    entry.status = responseStatusCode || 0;
    entry.responseHeaders = normalizeHeaders(
      Array.isArray(responseHeaders)
        ? responseHeaders.reduce((acc, h) => ({ ...acc, [h.name]: h.value }), {})
        : (responseHeaders || {})
    );
    entry.mimeType = entry.responseHeaders['content-type'] || '';

    // Tag rate-limited responses
    if (responseStatusCode === 429) {
      entry.flags.isRateLimited = true;
      const retryAfter = entry.responseHeaders['retry-after'];
      entry.retryAfter = retryAfter || null;
    }
  }

  // Find response rules
  const matchingRules = entry ? findMatchingRules(entry, 'response') : [];
  let statusOverride = null;
  let bodyModRule = null;

  for (const rule of matchingRules) {
    if (!rule.enabled) continue;
    rule.hitCount = (rule.hitCount || 0) + 1;
    rule.lastHit = Date.now();
    if (rule.type === 'status_override') statusOverride = rule.action.statusCode;
    if (rule.type === 'modify_response_body') bodyModRule = rule;
  }

  // Check if we need to capture body (for modification or recording)
  const needsBody = bodyModRule !== null || (entry && shouldCaptureBody(entry));
  let capturedBody = null;
  let capturedBodyRaw = null;

  if (needsBody && !responseErrorReason) {
    const contentLength = parseInt(entry?.responseHeaders?.['content-length'] || '0');
    if (contentLength < 10 * 1024 * 1024) { // < 10MB
      try {
        const result = await chrome.debugger.sendCommand({ tabId }, 'Fetch.getResponseBody', { requestId });
        capturedBodyRaw = result;
        capturedBody = result.base64Encoded
          ? decodeURIComponent(escape(atob(result.body)))
          : result.body;
      } catch (e) { /* body unavailable */ }
    } else if (entry) {
      entry.responseBodyTruncated = true;
    }
  }

  if (entry && capturedBody !== null) {
    entry.responseBody = capturedBody;
    entry.responseBodyParsed = tryParseJSON(capturedBody);
    entry.size.responseBytes = capturedBody.length;
  }

  // Apply body modification rule
  if (bodyModRule && capturedBody !== null) {
    const newBody = applyBodyModification(capturedBody, bodyModRule.action);
    const finalStatus = statusOverride || responseStatusCode || 200;
    const respHeaders = responseHeaders || [];
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Fetch.fulfillRequest', {
        requestId,
        responseCode: finalStatus,
        responseHeaders: respHeaders,
        body: btoa(unescape(encodeURIComponent(newBody)))
      });
      if (entry) {
        entry.responseBody = newBody;
        entry.responseBodyParsed = tryParseJSON(newBody);
        entry.flags.isModified = true;
        entry.status = finalStatus;
      }
    } catch (e) {
      await safeContinueResponse(tabId, requestId, statusOverride, responseHeaders);
    }
  } else if (statusOverride) {
    // Status-only override with existing body
    try {
      const bodyToUse = capturedBodyRaw?.base64Encoded
        ? capturedBodyRaw.body
        : (capturedBody ? btoa(unescape(encodeURIComponent(capturedBody))) : '');
      await chrome.debugger.sendCommand({ tabId }, 'Fetch.fulfillRequest', {
        requestId,
        responseCode: statusOverride,
        responseHeaders: responseHeaders || [],
        body: bodyToUse
      });
      if (entry) {
        entry.status = statusOverride;
        entry.flags.isModified = true;
      }
    } catch (e) {
      await safeContinueResponse(tabId, requestId, null, responseHeaders);
    }
  } else {
    await safeContinueResponse(tabId, requestId, null, responseHeaders);
  }

  if (entry) {
    entry.timing.responseEnd = Date.now();
    entry.timing.duration = entry.timing.responseEnd - entry.timing.requestStart;
    sendToPanel(tabId, { type: 'REQUEST_COMPLETED', entry: serializeEntry(entry) });
    // Clean up requestId mapping
    state.requestLog.delete(entryIdKey);
  }
}

async function safeContinueResponse(tabId, requestId, statusOverride, responseHeaders) {
  try {
    const params = { requestId };
    if (statusOverride) params.responseCode = statusOverride;
    await chrome.debugger.sendCommand({ tabId }, 'Fetch.continueResponse', params);
  } catch (e) { /* request may have been cancelled */ }
}

async function cdpContinueRequest(tabId, requestId) {
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Fetch.continueRequest', { requestId });
  } catch (e) { /* ignore */ }
}

// ─── WebSocket Monitoring ─────────────────────────────────────────────────────
function handleWsCreated(tabId, params) {
  const ws = {
    id: params.requestId,
    url: params.url,
    frames: [],
    createdAt: Date.now(),
    closed: false
  };
  state.wsConnections.set(params.requestId, ws);
  sendToPanel(tabId, { type: 'WEBSOCKET_EVENT', event: { subtype: 'created', ws } });
}

function handleWsHandshake(tabId, params) {
  const ws = state.wsConnections.get(params.requestId);
  if (ws) {
    ws.status = params.response?.status;
    sendToPanel(tabId, { type: 'WEBSOCKET_EVENT', event: { subtype: 'handshake', requestId: params.requestId, status: ws.status } });
  }
}

function handleWsFrame(tabId, params, direction) {
  const ws = state.wsConnections.get(params.requestId);
  const frame = {
    direction,
    timestamp: params.timestamp ? params.timestamp * 1000 : Date.now(),
    data: params.response?.payloadData || '',
    opcode: params.response?.opcode || 1,
    isJson: false,
    parsed: null
  };
  try {
    frame.parsed = JSON.parse(frame.data);
    frame.isJson = true;
  } catch (e) {}

  if (ws) ws.frames.push(frame);
  sendToPanel(tabId, {
    type: 'WEBSOCKET_EVENT',
    event: { subtype: 'frame', requestId: params.requestId, frame }
  });
}

function handleWsClosed(tabId, params) {
  const ws = state.wsConnections.get(params.requestId);
  if (ws) {
    ws.closed = true;
    ws.closedAt = Date.now();
  }
  sendToPanel(tabId, { type: 'WEBSOCKET_EVENT', event: { subtype: 'closed', requestId: params.requestId } });
}

// ─── Rules Engine ─────────────────────────────────────────────────────────────
async function loadRules() {
  const { rules = [] } = await chrome.storage.local.get('rules');
  state.rules = rules.sort((a, b) => (b.priority || 0) - (a.priority || 0));
  await syncRulesToDNR();
}

async function saveRule(rule) {
  if (!rule.id) rule.id = generateId();
  rule.hitCount = rule.hitCount || 0;
  rule.createdAt = rule.createdAt || Date.now();

  const idx = state.rules.findIndex(r => r.id === rule.id);
  if (idx >= 0) {
    state.rules[idx] = rule;
  } else {
    state.rules.push(rule);
  }
  state.rules.sort((a, b) => (b.priority || 0) - (a.priority || 0));

  await chrome.storage.local.set({ rules: state.rules });
  await syncRulesToDNR();

  // Notify all panels
  for (const [tid] of state.panelPorts) {
    sendToPanel(tid, { type: 'RULES_UPDATED', rules: state.rules });
  }
}

async function deleteRule(ruleId) {
  state.rules = state.rules.filter(r => r.id !== ruleId);
  await chrome.storage.local.set({ rules: state.rules });
  await syncRulesToDNR();
  for (const [tid] of state.panelPorts) {
    sendToPanel(tid, { type: 'RULES_UPDATED', rules: state.rules });
  }
}

async function reorderRules(ruleIds) {
  const ruleMap = new Map(state.rules.map(r => [r.id, r]));
  state.rules = ruleIds.map(id => ruleMap.get(id)).filter(Boolean);
  state.rules.forEach((r, i) => r.priority = state.rules.length - i);
  await chrome.storage.local.set({ rules: state.rules });
  await syncRulesToDNR();
}

function findMatchingRules(entry, stage) {
  return state.rules.filter(rule => {
    if (!rule.enabled) return false;
    const { conditions } = rule;

    // Stage filtering
    const isRequestRule = ['mock_response', 'inject_request_header', 'remove_request_header', 'modify_request_body'].includes(rule.type);
    const isResponseRule = ['modify_response_body', 'inject_response_header', 'status_override'].includes(rule.type);
    if (stage === 'request' && isResponseRule) return false;
    if (stage === 'response' && isRequestRule) return false;

    // URL pattern
    if (conditions?.urlPattern) {
      if (conditions.urlRegex) {
        try {
          if (!new RegExp(conditions.urlPattern).test(entry.url)) return false;
        } catch (e) { return false; }
      } else {
        if (!entry.url.includes(conditions.urlPattern)) return false;
      }
    }

    // Method
    if (conditions?.methods?.length && !conditions.methods.includes(entry.method)) return false;

    // Status code (for response rules)
    if (stage === 'response' && conditions?.statusCodes?.length) {
      if (!conditions.statusCodes.includes(entry.status)) return false;
    }

    return true;
  });
}

async function syncRulesToDNR() {
  const DNR_TYPES = ['inject_request_header', 'inject_response_header', 'remove_request_header', 'block_request', 'redirect'];
  const dnrRules = state.rules
    .filter(r => r.enabled && DNR_TYPES.includes(r.type))
    .map((rule, index) => ruleToDNR(rule, index + 1))
    .filter(Boolean);

  try {
    const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
    const existingIds = existingRules.map(r => r.id);
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existingIds,
      addRules: dnrRules
    });
  } catch (e) {
    console.error('DNR sync failed:', e);
  }
}

function ruleToDNR(rule, id) {
  const RESOURCE_TYPES = ['main_frame', 'sub_frame', 'xmlhttprequest', 'other', 'script', 'image', 'stylesheet', 'font', 'media'];
  const cond = {
    urlFilter: rule.conditions?.urlPattern || '*',
    resourceTypes: RESOURCE_TYPES
  };

  if (rule.type === 'block_request') {
    return { id, priority: rule.priority || 1, condition: cond, action: { type: 'block' } };
  }
  if (rule.type === 'redirect') {
    if (!rule.action?.redirectUrl) return null;
    return { id, priority: rule.priority || 1, condition: cond, action: { type: 'redirect', redirect: { url: rule.action.redirectUrl } } };
  }
  if (rule.type === 'inject_request_header') {
    if (!rule.action?.headerName) return null;
    return {
      id, priority: rule.priority || 1, condition: cond,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: rule.action.headerName, operation: 'set', value: rule.action.headerValue || '' }] }
    };
  }
  if (rule.type === 'inject_response_header') {
    if (!rule.action?.headerName) return null;
    return {
      id, priority: rule.priority || 1, condition: cond,
      action: { type: 'modifyHeaders', responseHeaders: [{ header: rule.action.headerName, operation: 'set', value: rule.action.headerValue || '' }] }
    };
  }
  if (rule.type === 'remove_request_header') {
    if (!rule.action?.headerName) return null;
    return {
      id, priority: rule.priority || 1, condition: cond,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: rule.action.headerName, operation: 'remove' }] }
    };
  }
  return null;
}

// ─── Replay ───────────────────────────────────────────────────────────────────
async function replayRequest(tabId, entryId, modifications) {
  const entry = state.requestLog.get(entryId);
  if (!entry) {
    sendToPanel(tabId, { type: 'REPLAY_ERROR', error: 'Entry not found', entryId });
    return;
  }

  const url = modifications?.url || entry.url;
  const method = modifications?.method || entry.method;
  const headers = modifications?.headers || entry.requestHeaders;
  const body = modifications?.body !== undefined ? modifications.body : entry.requestBody;

  try {
    const fetchOptions = {
      method,
      headers: new Headers(headers)
    };
    if (body && !['GET', 'HEAD'].includes(method)) {
      fetchOptions.body = body;
    }

    const startTime = Date.now();
    const response = await fetch(url, fetchOptions);
    const responseText = await response.text();
    const duration = Date.now() - startTime;

    const respHeaders = {};
    response.headers.forEach((v, k) => { respHeaders[k] = v; });

    const newEntryId = `${tabId}-${++state.requestCounter}`;
    const newEntry = {
      ...entry,
      id: newEntryId,
      requestId: null,
      timestamp: Date.now(),
      url,
      method,
      requestHeaders: headers,
      requestBody: body,
      requestBodyParsed: tryParseJSON(body),
      status: response.status,
      responseHeaders: respHeaders,
      responseBody: responseText,
      responseBodyParsed: tryParseJSON(responseText),
      mimeType: respHeaders['content-type'] || '',
      timing: { requestStart: startTime, responseStart: startTime, responseEnd: Date.now(), duration },
      size: { requestBytes: estimateSize(body || ''), responseBytes: responseText.length },
      flags: { ...entry.flags, isReplayed: true, isMocked: false },
      authTokens: extractAuthTokens(headers)
    };
    state.requestLog.set(newEntryId, newEntry);

    sendToPanel(tabId, { type: 'REPLAY_RESULT', originalEntryId: entryId, entry: serializeEntry(newEntry) });
  } catch (err) {
    sendToPanel(tabId, { type: 'REPLAY_ERROR', error: err.message, entryId });
  }
}

// ─── Rate Limit Settings ──────────────────────────────────────────────────────
async function loadRateLimitSettings() {
  const { rateLimitBypass } = await chrome.storage.local.get('rateLimitBypass');
  if (rateLimitBypass) state.rateLimitBypass = rateLimitBypass;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function normalizeHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k.toLowerCase()] = v;
  }
  return out;
}

function headersToArray(headers) {
  return Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }));
}

function tryParseJSON(str) {
  if (!str) return null;
  try { return JSON.parse(str); } catch (e) { return null; }
}

function estimateRequestSize(request) {
  let size = `${request.method} ${request.url} HTTP/1.1\r\n`.length;
  for (const [k, v] of Object.entries(request.headers || {})) {
    size += `${k}: ${v}\r\n`.length;
  }
  size += (request.postData || '').length;
  return size;
}

function estimateSize(str) {
  return new TextEncoder().encode(str).length;
}

function extractAuthTokens(headers, urlParsed) {
  const tokens = [];

  if (headers['authorization']) {
    const auth = headers['authorization'];
    if (auth.startsWith('Bearer ')) {
      tokens.push({ type: 'Bearer', header: 'Authorization', value: auth.slice(7) });
    } else if (auth.startsWith('Basic ')) {
      tokens.push({ type: 'Basic', header: 'Authorization', value: auth.slice(6) });
    } else {
      tokens.push({ type: 'Auth', header: 'Authorization', value: auth });
    }
  }

  for (const [k, v] of Object.entries(headers)) {
    if (/^x-api-key$/i.test(k) || /^api[_-]?key$/i.test(k)) {
      tokens.push({ type: 'APIKey', header: k, value: v });
    }
  }

  if (urlParsed) {
    for (const [k, v] of urlParsed.searchParams) {
      if (/^(api[_-]?key|token|access[_-]?token|apikey|key)$/i.test(k)) {
        tokens.push({ type: 'URLParam', param: k, value: v });
      }
    }
  }

  return tokens;
}

function shouldCaptureBody(entry) {
  const ct = entry.mimeType || '';
  return ct.includes('json') || ct.includes('text') || ct.includes('xml') || ct.includes('javascript');
}

function applyBodyModification(body, action) {
  if (!action) return body;
  if (action.responseBodyType === 'literal' || !action.responseBodyType) {
    return action.responseBody || body;
  }
  if (action.responseBodyType === 'json') {
    return JSON.stringify(JSON.parse(action.responseBody), null, 2);
  }
  if (action.responseBodyType === 'regex_replace' && action.regexPattern) {
    try {
      return body.replace(new RegExp(action.regexPattern, 'g'), action.regexReplacement || '');
    } catch (e) { return body; }
  }
  return body;
}

function waitForResume(requestId, tabId) {
  return new Promise((resolve) => {
    state.pendingRequests.set(requestId, { tabId, resolve });
    // Auto-resume after 30 seconds to avoid indefinitely hanging pages
    setTimeout(() => {
      if (state.pendingRequests.has(requestId)) {
        state.pendingRequests.delete(requestId);
        resolve(null);
      }
    }, 30000);
  });
}

function serializeEntry(entry) {
  // Return a plain object safe for postMessage (no circular refs)
  return {
    id: entry.id,
    requestId: entry.requestId,
    tabId: entry.tabId,
    timestamp: entry.timestamp,
    method: entry.method,
    url: entry.url,
    urlHost: entry.urlHost,
    urlPath: entry.urlPath,
    requestHeaders: entry.requestHeaders,
    requestBody: entry.requestBody,
    requestBodyParsed: entry.requestBodyParsed,
    status: entry.status,
    responseHeaders: entry.responseHeaders,
    responseBody: entry.responseBody,
    responseBodyParsed: entry.responseBodyParsed,
    responseBodyTruncated: entry.responseBodyTruncated || false,
    mimeType: entry.mimeType,
    resourceType: entry.resourceType,
    timing: entry.timing,
    size: entry.size,
    flags: entry.flags,
    authTokens: entry.authTokens,
    retryAfter: entry.retryAfter || null,
    wsFrames: entry.wsFrames || []
  };
}

function generateId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Popup Stats Handler ──────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_STATS') {
    const tabId = msg.tabId;
    const attached = state.debuggerSessions.get(tabId)?.attached || false;
    const entries = Array.from(state.requestLog.values()).filter(e => e.tabId === tabId);
    const totalRequests = entries.length;
    const rateLimitedCount = entries.filter(e => e.flags?.isRateLimited).length;
    const wsCount = state.wsConnections.size;
    sendResponse({ attached, totalRequests, rateLimitedCount, wsCount });
    return true; // async response
  }
});
