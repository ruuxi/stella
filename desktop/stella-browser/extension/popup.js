const portInput = document.getElementById('port');
const tokenInput = document.getElementById('token');
const connectBtn = document.getElementById('connect-btn');
const disconnectBtn = document.getElementById('disconnect-btn');
const statusEl = document.getElementById('status');
const statusText = document.getElementById('status-text');

// Load saved config
chrome.storage.local.get(['port', 'token'], (config) => {
  if (config.port) portInput.value = config.port;
  if (config.token) tokenInput.value = config.token;
});

// Check current connection status
chrome.runtime.sendMessage({ type: 'getStatus' }, (response) => {
  if (response?.connected) {
    setConnected(true);
  }
});

connectBtn.addEventListener('click', () => {
  const port = parseInt(portInput.value, 10);
  const token = tokenInput.value.trim();

  if (!port || port < 1024 || port > 65535) {
    portInput.focus();
    return;
  }

  chrome.storage.local.set({ port, token, autoConnect: true });
  chrome.runtime.sendMessage({ type: 'connect', port, token });

  connectBtn.disabled = true;
  connectBtn.textContent = 'Connecting...';

  // Check status after a brief delay
  setTimeout(() => {
    chrome.runtime.sendMessage({ type: 'getStatus' }, (response) => {
      if (response?.connected) {
        setConnected(true);
      } else {
        connectBtn.disabled = false;
        connectBtn.textContent = 'Connect';
      }
    });
  }, 1500);
});

disconnectBtn.addEventListener('click', () => {
  chrome.storage.local.set({ autoConnect: false });
  chrome.runtime.sendMessage({ type: 'disconnect' });
  setConnected(false);
});

function setConnected(connected) {
  statusEl.className = 'status ' + (connected ? 'connected' : 'disconnected');
  statusText.textContent = connected ? 'Connected' : 'Disconnected';
  connectBtn.disabled = connected;
  connectBtn.textContent = 'Connect';
  disconnectBtn.disabled = !connected;
}
