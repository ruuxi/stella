/**
 * Stella Browser Bridge — Background Service Worker
 *
 * Connects to the stella-browser daemon via WebSocket and routes
 * commands to Chrome extension APIs.
 */

import { connect, disconnect, isConnected, onCommand, onStatus } from './lib/connection.js';
import { handleTabNew, handleTabList, handleTabSwitch, handleTabClose, closeAgentWindow } from './commands/tabs.js';
import { handleNavigate, handleBack, handleForward, handleReload, handleUrl, handleTitle } from './commands/navigation.js';
import {
  handleClick, handleFill, handleType, handleHover, handleSelect,
  handlePress, handleScroll, handleClear, handleCheck, handleUncheck,
  handleFocus, handleDblclick, handleWait,
  handleClipboard, handleMouseMove, handleMouseDown, handleMouseUp,
  handleDrag, handleKeyDown, handleKeyUp, handleInsertText,
} from './commands/interaction.js';
import {
  handleScreenshot, handleSnapshot, handleContent, handleEvaluate,
  handleGetText, handleGetAttribute, handlePdf,
} from './commands/capture.js';
import { handleCookiesGet, handleCookiesSet, handleCookiesClear } from './commands/cookies.js';
import {
  handleInnerText, handleInnerHtml, handleInputValue, handleBoundingBox,
  handleWaitForUrl, handleScrollIntoView, handleIsVisible, handleIsEnabled,
  handleIsChecked, handleCount, handleStyles, handleBringToFront,
} from './commands/queries.js';
import {
  handleRequests, handleResponseBody, handleRoute, handleUnroute,
  handleHarStart, handleHarStop,
} from './commands/network.js';
import { handleDownload } from './commands/downloads.js';
import { handleChain } from './commands/chain.js';

// --- Command Router ---

const HANDLERS = {
  // Health check (used by daemon to verify service worker is alive)
  healthcheck: async (cmd) => ({ id: cmd.id, success: true, data: {} }),

  // Navigation
  navigate: handleNavigate,
  open: handleNavigate, // alias
  back: handleBack,
  forward: handleForward,
  reload: handleReload,
  url: handleUrl,
  title: handleTitle,

  // DOM Interaction
  click: handleClick,
  fill: handleFill,
  type: handleType,
  hover: handleHover,
  select: handleSelect,
  press: handlePress,
  scroll: handleScroll,
  clear: handleClear,
  check: handleCheck,
  uncheck: handleUncheck,
  focus: handleFocus,
  dblclick: handleDblclick,
  wait: handleWait,

  // Capture
  screenshot: handleScreenshot,
  snapshot: handleSnapshot,
  content: handleContent,
  evaluate: handleEvaluate,
  gettext: handleGetText,
  getattribute: handleGetAttribute,
  pdf: handlePdf,

  // Element Queries
  innertext: handleInnerText,
  innerhtml: handleInnerHtml,
  inputvalue: handleInputValue,
  boundingbox: handleBoundingBox,
  scrollintoview: handleScrollIntoView,
  isvisible: handleIsVisible,
  isenabled: handleIsEnabled,
  ischecked: handleIsChecked,
  count: handleCount,
  styles: handleStyles,
  waitforurl: handleWaitForUrl,
  bringtofront: handleBringToFront,

  // Network
  requests: handleRequests,
  responsebody: handleResponseBody,
  route: handleRoute,
  unroute: handleUnroute,
  har_start: handleHarStart,
  har_stop: handleHarStop,

  // Downloads
  download: handleDownload,

  // Clipboard
  clipboard: handleClipboard,

  // Advanced Input
  mousemove: handleMouseMove,
  mousedown: handleMouseDown,
  mouseup: handleMouseUp,
  drag: handleDrag,
  keydown: handleKeyDown,
  keyup: handleKeyUp,
  inserttext: handleInsertText,

  // Tabs
  tab_new: handleTabNew,
  tab_list: handleTabList,
  tab_switch: handleTabSwitch,
  tab_close: handleTabClose,

  // Cookies
  cookies_get: handleCookiesGet,
  cookies_set: handleCookiesSet,
  cookies_clear: handleCookiesClear,

  // Chain (batched sequential execution)
  chain: (cmd) => handleChain(cmd, HANDLERS),
};

// Commands that we acknowledge but don't support in extension mode
const UNSUPPORTED = new Set([
  'launch', 'trace_start', 'trace_stop',
  'state_save', 'state_load', 'video_start', 'video_stop',
  'recording_start', 'recording_stop', 'recording_restart',
  'screencast_start', 'screencast_stop',
  'input_mouse', 'input_keyboard', 'input_touch',
  'frame', 'mainframe', 'expose', 'highlight',
  'dialog', 'geolocation', 'permissions', 'viewport',
  'device', 'useragent', 'emulatemedia', 'offline',
  'headers', 'credentials', 'timezone', 'locale',
  'addscript', 'addstyle', 'addinitscript',
  'console', 'errors', 'keyboard',
  'window_new', 'upload',
  'getbyrole', 'getbytext', 'getbylabel', 'getbyplaceholder',
  'getbyalttext', 'getbytitle', 'getbytestid', 'nth',
  'tap', 'wheel', 'multiselect',
  'selectall', 'dispatch', 'evalhandle', 'pause',
  'waitforloadstate',
  'waitforfunction', 'waitfordownload',
  'getboundingbox',
]);

async function handleCommand(message) {
  const { action, id } = message;

  // Handle 'close' command — close agent window, then acknowledge
  if (action === 'close') {
    await closeAgentWindow();
    return { type: 'response', id, success: true, data: { closed: true } };
  }

  // Handle 'launch' — in extension mode the browser is already running
  if (action === 'launch') {
    return { type: 'response', id, success: true, data: { launched: true, provider: 'extension' } };
  }

  // Known handler
  const handler = HANDLERS[action];
  if (handler) {
    try {
      const result = await handler(message);
      return { type: 'response', ...result };
    } catch (err) {
      return {
        type: 'response',
        id,
        success: false,
        error: err.message || String(err),
      };
    }
  }

  // Known unsupported
  if (UNSUPPORTED.has(action)) {
    return {
      type: 'response',
      id,
      success: false,
      error: `Command '${action}' is not supported in extension mode`,
    };
  }

  // Unknown command
  return {
    type: 'response',
    id,
    success: false,
    error: `Unknown command: ${action}`,
  };
}

// --- Initialization ---

onCommand(handleCommand);

onStatus((connected) => {
  console.log('[background] Connection status:', connected ? 'connected' : 'disconnected');
  if (!connected) {
    closeAgentWindow();
  }
});

// Keep service worker alive via offscreen document port
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'keepalive') {
    // Port keeps the service worker alive — nothing else needed
  }
});

// Create offscreen document to maintain keepalive port
async function ensureOffscreen() {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL('offscreen.html')],
    });
    if (contexts.length === 0) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['WORKERS'],
        justification: 'Keep service worker alive for WebSocket connection',
      });
      console.log('[background] Offscreen keepalive document created');
    }
  } catch (err) {
    console.error('[background] Failed to create offscreen document:', err);
  }
}

ensureOffscreen();

// Auto-connect on service worker load (this runs on every SW start, including
// browser startup and extension install/update — no need for separate listeners)
async function autoConnect() {
  const config = await chrome.storage.local.get(['port', 'token']);
  const port = config.port || 9224;
  const token = config.token || '';
  console.log('[background] Auto-connecting to port', port);
  connect(port, token);
}

autoConnect();

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'connect') {
    connect(message.port, message.token);
    sendResponse({ ok: true });
  } else if (message.type === 'disconnect') {
    disconnect();
    sendResponse({ ok: true });
  } else if (message.type === 'getStatus') {
    sendResponse({ connected: isConnected() });
  }
});
