const statusText = document.getElementById('status-text');

chrome.runtime.sendMessage({ type: 'getStatus' }, (response) => {
  statusText.textContent = response?.connected ? 'Connected' : 'Disconnected';
});
