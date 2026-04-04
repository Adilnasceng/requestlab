// RequestLab Popup — lightweight status view

async function loadStats() {
  const { rules = [] } = await chrome.storage.local.get('rules');
  document.getElementById('stat-rules').textContent = rules.length;

  // Get active tabs with debugger sessions
  chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
    const tab = tabs[0];
    if (!tab) return;

    // Try to get stats by messaging the service worker
    try {
      chrome.runtime.sendMessage({ type: 'GET_STATS', tabId: tab.id }, (resp) => {
        if (chrome.runtime.lastError || !resp) {
          setStatus(false);
          return;
        }
        setStatus(resp.attached);
        document.getElementById('stat-total').textContent = resp.totalRequests || 0;
        document.getElementById('stat-429').textContent = resp.rateLimitedCount || 0;
        document.getElementById('stat-ws').textContent = resp.wsCount || 0;
      });
    } catch (e) {
      setStatus(false);
    }
  });
}

function setStatus(attached) {
  const dot = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  if (attached) {
    dot.className = 'dot-on';
    text.textContent = 'Intercepting';
  } else {
    dot.className = 'dot-off';
    text.textContent = 'No active session';
  }
}

document.getElementById('link-devtools').addEventListener('click', (e) => {
  e.preventDefault();
  // Open DevTools for current tab (can't programmatically open DevTools,
  // so show a helpful message)
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]) {
      // Best we can do: notify the user
      document.getElementById('hint').textContent = 'Press F12 to open DevTools, then click the RequestLab tab.';
    }
  });
});

// Also handle GET_STATS in service worker (register listener)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_STATS') {
    sendResponse({ attached: false, totalRequests: 0, rateLimitedCount: 0, wsCount: 0 });
  }
});

loadStats();
