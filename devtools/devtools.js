// RequestLab DevTools entry point
// Creates the panel and bridges the tabId to panel.js

chrome.devtools.panels.create(
  'RequestLab',
  '/icons/icon.svg',
  '/devtools/panel.html',
  (panel) => {
    panel.onShown.addListener((panelWindow) => {
      // Pass tabId to panel when it becomes visible
      const tabId = chrome.devtools.inspectedWindow.tabId;
      if (panelWindow.requestLabInit) {
        panelWindow.requestLabInit(tabId);
      } else {
        // Panel script may not be ready yet — wait for it
        panelWindow.addEventListener('load', () => {
          if (panelWindow.requestLabInit) {
            panelWindow.requestLabInit(tabId);
          }
        });
      }
    });
  }
);
