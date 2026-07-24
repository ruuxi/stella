import assert from 'node:assert/strict';
import test from 'node:test';

const cdpListeners = [];
const tabs = new Map();
const groups = new Map();
let nextTabId = 10;
let nextGroupId = 100;
let storage = {};

/** Calls made through chrome.debugger.sendCommand, for assertions. */
const sentCommands = [];
/** requestId -> canned Network.getResponseBody result. */
const responseBodies = new Map();
/** requestId -> canned Network.getRequestPostData result. */
const postDataById = new Map();
/** Tabs chrome.debugger.detach was called for. */
const detachedTabs = [];

const clone = (value) => structuredClone(value);
const event = (bucket) => ({
  addListener(listener) {
    bucket.push(listener);
  },
});

globalThis.chrome = {
  storage: {
    session: {
      async get(keys) {
        return Object.fromEntries(
          keys.filter((key) => storage[key] !== undefined).map((key) => [key, clone(storage[key])]),
        );
      },
      async set(value) {
        storage = { ...storage, ...clone(value) };
      },
    },
  },
  windows: {
    onRemoved: event([]),
    async get() {
      return { id: 1, type: 'normal' };
    },
    async getLastFocused() {
      return { id: 1, type: 'normal' };
    },
    async getAll() {
      return [{ id: 1, type: 'normal' }];
    },
    async create({ url }) {
      const tab = { id: nextTabId++, windowId: 1, groupId: -1, url, title: '' };
      tabs.set(tab.id, tab);
      return { id: 1, tabs: [clone(tab)] };
    },
  },
  tabGroups: {
    async query() {
      return [];
    },
    async get(groupId) {
      const group = groups.get(groupId);
      if (!group) throw new Error('group not found');
      return clone(group);
    },
    async update(groupId, updates) {
      const group = groups.get(groupId);
      if (!group) throw new Error('group not found');
      Object.assign(group, updates);
      return clone(group);
    },
  },
  tabs: {
    onCreated: event([]),
    onRemoved: event([]),
    async create({ url, windowId }) {
      const tab = { id: nextTabId++, windowId, groupId: -1, url, title: '' };
      tabs.set(tab.id, tab);
      return clone(tab);
    },
    async get(tabId) {
      const tab = tabs.get(tabId);
      if (!tab) throw new Error('tab not found');
      return clone(tab);
    },
    async query(query) {
      return [...tabs.values()]
        .filter((tab) => query.windowId === undefined || tab.windowId === query.windowId)
        .filter((tab) => query.groupId === undefined || tab.groupId === query.groupId)
        .map(clone);
    },
    async group({ tabIds, groupId, createProperties }) {
      const resolvedGroupId = groupId ?? nextGroupId++;
      if (!groups.has(resolvedGroupId)) {
        groups.set(resolvedGroupId, {
          id: resolvedGroupId,
          windowId: createProperties?.windowId ?? 1,
          title: '',
          color: 'grey',
        });
      }
      for (const tabId of tabIds) {
        const tab = tabs.get(tabId);
        if (tab) tab.groupId = resolvedGroupId;
      }
      return resolvedGroupId;
    },
    async ungroup() {},
    async move(tabId, { windowId }) {
      const tab = tabs.get(tabId);
      if (!tab) throw new Error('tab not found');
      tab.windowId = windowId;
      return clone(tab);
    },
    async remove() {},
  },
  alarms: { onAlarm: event([]) },
  debugger: {
    onEvent: event(cdpListeners),
    onDetach: event([]),
    async attach() {},
    async detach(target) {
      detachedTabs.push(target.tabId);
    },
    async sendCommand({ tabId, sessionId }, method, params) {
      sentCommands.push({ tabId, sessionId, method, params });
      if (method === 'Network.getResponseBody') {
        const canned = responseBodies.get(params.requestId);
        if (!canned) throw new Error('No resource with given identifier found');
        return canned;
      }
      if (method === 'Network.getRequestPostData') {
        const canned = postDataById.get(params.requestId);
        if (!canned) throw new Error('No post data available');
        return canned;
      }
      return {};
    },
  },
  webNavigation: {
    onCreatedNavigationTarget: event([]),
  },
};

const { getActiveTab } = await import('./tabs.js');
const { handleHarStart, handleHarStop, handleRequests } = await import('./network.js');
const { ensureDebugger, detachAllDebuggers } = await import('../lib/debugger.js');

/** Dispatch a CDP event to lib/debugger.js's global listener. */
const emitCdp = (tabId, method, params, sessionId) => {
  const source = sessionId ? { tabId, sessionId } : { tabId };
  for (const listener of cdpListeners) listener(source, method, params);
};

/**
 * Drain the microtask queue so body captures started inside CDP event handlers
 * register themselves before har_stop looks for pending work.
 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const OWNER = 'network-test-owner';

const recordExchange = async (tabId, exchange) => {
  emitCdp(tabId, 'Network.requestWillBeSent', {
    requestId: exchange.requestId,
    request: {
      url: exchange.url,
      method: exchange.method ?? 'GET',
      headers: exchange.requestHeaders ?? {},
      ...(exchange.postData !== undefined ? { postData: exchange.postData } : {}),
      ...(exchange.hasPostData ? { hasPostData: true } : {}),
    },
    timestamp: 1700000,
    type: exchange.type ?? 'XHR',
  });

  emitCdp(tabId, 'Network.responseReceived', {
    requestId: exchange.requestId,
    response: {
      status: exchange.status ?? 200,
      statusText: 'OK',
      headers: exchange.responseHeaders ?? {},
      mimeType: exchange.mimeType ?? 'application/json',
      encodedDataLength: exchange.size ?? 128,
    },
  });

  emitCdp(tabId, 'Network.loadingFinished', { requestId: exchange.requestId });
  await flush();
};

const findEntry = (result, url) =>
  result.data.log.entries.find((entry) => entry.request.url === url);

test('HAR recording captures request payloads and response bodies for API calls', async () => {
  const tab = await getActiveTab({ id: 'setup', ownerId: OWNER });
  await handleHarStart({ id: 'start', ownerId: OWNER });

  responseBodies.set('req-1', { body: '{"carts":[{"id":"abc"}]}', base64Encoded: false });
  await recordExchange(tab.id, {
    requestId: 'req-1',
    url: 'https://example.test/api/carts',
    method: 'POST',
    requestHeaders: { 'content-type': 'application/json' },
    postData: '{"storeId":"42"}',
  });

  const result = await handleHarStop({ id: 'stop', ownerId: OWNER });
  const entry = findEntry(result, 'https://example.test/api/carts');

  assert.ok(entry, 'recorded the API call');
  assert.equal(entry.request.postData.text, '{"storeId":"42"}');
  assert.equal(entry.request.postData.mimeType, 'application/json');
  assert.equal(entry.response.content.text, '{"carts":[{"id":"abc"}]}');
  assert.equal(result.data.bodiesCaptured, 1);
});

test('HAR recording skips bodies for non-API resources', async () => {
  const tab = await getActiveTab({ id: 'setup', ownerId: OWNER });
  await handleHarStart({ id: 'start', ownerId: OWNER });

  responseBodies.set('req-img', { body: 'PNGDATA', base64Encoded: true });
  await recordExchange(tab.id, {
    requestId: 'req-img',
    url: 'https://example.test/logo.png',
    type: 'Image',
    mimeType: 'image/png',
  });

  const result = await handleHarStop({ id: 'stop', ownerId: OWNER });
  const entry = findEntry(result, 'https://example.test/logo.png');

  assert.ok(entry, 'the request is still listed');
  assert.equal(entry.response.content.text, undefined, 'but its body was not copied');
  assert.equal(result.data.bodiesCaptured, 0);
});

test('HAR recording resolves post data that CDP did not inline', async () => {
  const tab = await getActiveTab({ id: 'setup', ownerId: OWNER });
  await handleHarStart({ id: 'start', ownerId: OWNER });

  responseBodies.set('req-gql', { body: '{"data":{}}', base64Encoded: false });
  postDataById.set('req-gql', { postData: '{"query":"{ viewer { id } }"}' });
  await recordExchange(tab.id, {
    requestId: 'req-gql',
    url: 'https://example.test/graphql',
    method: 'POST',
    hasPostData: true,
  });

  const result = await handleHarStop({ id: 'stop', ownerId: OWNER });
  const entry = findEntry(result, 'https://example.test/graphql');

  assert.equal(entry.request.postData.text, '{"query":"{ viewer { id } }"}');
  assert.ok(
    sentCommands.some((call) => call.method === 'Network.getRequestPostData'),
    'pulled the payload separately',
  );
});

test('a failed body read leaves the entry intact', async () => {
  const tab = await getActiveTab({ id: 'setup', ownerId: OWNER });
  await handleHarStart({ id: 'start', ownerId: OWNER });

  // No canned body: sendCommand throws, mimicking an evicted CDP buffer.
  await recordExchange(tab.id, {
    requestId: 'req-evicted',
    url: 'https://example.test/api/gone',
  });

  const result = await handleHarStop({ id: 'stop', ownerId: OWNER });
  const entry = findEntry(result, 'https://example.test/api/gone');

  assert.ok(entry, 'the exchange is still reported');
  assert.equal(entry.response.status, 200);
  assert.equal(entry.response.content.text, undefined);
});

test('an open recording survives the idle detach sweep', async (t) => {
  const tab = await getActiveTab({ id: 'setup', ownerId: OWNER });
  t.mock.timers.enable({ apis: ['setTimeout'] });

  await handleHarStart({ id: 'start', ownerId: OWNER });
  detachedTabs.length = 0;

  // Idle for longer than the 5 minute auto-detach window. A recording receives
  // CDP events without issuing commands, so nothing refreshes the timer.
  t.mock.timers.tick(300_001);
  await Promise.resolve();

  assert.ok(
    !detachedTabs.includes(tab.id),
    'the recording tab stays attached while held',
  );

  t.mock.timers.reset();

  // Once stopped, the hold is gone and the tab may idle out normally.
  await handleHarStop({ id: 'stop', ownerId: OWNER });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await ensureDebugger(tab.id);
  detachedTabs.length = 0;
  t.mock.timers.tick(300_001);
  await Promise.resolve();
  t.mock.timers.reset();

  assert.ok(detachedTabs.includes(tab.id), 'an unheld tab still idles out');
  await detachAllDebuggers();
});

test('post data too large to inline is pulled before it is evicted', async () => {
  const tab = await getActiveTab({ id: 'setup', ownerId: OWNER });
  await handleHarStart({ id: 'start', ownerId: OWNER });

  responseBodies.set('req-big-post', { body: '{"ok":true}', base64Encoded: false });
  postDataById.set('req-big-post', { postData: '{"query":"{ big }"}' });
  await recordExchange(tab.id, {
    requestId: 'req-big-post',
    url: 'https://example.test/graphql',
    method: 'POST',
    hasPostData: true,
  });

  // The pull must happen during capture, not at har_stop: clearing the canned
  // value afterwards mimics CDP dropping the payload from its buffer.
  postDataById.delete('req-big-post');

  const result = await handleHarStop({ id: 'stop', ownerId: OWNER });
  const entry = findEntry(result, 'https://example.test/graphql');
  assert.equal(entry.request.postData.text, '{"query":"{ big }"}');
});

test('a redirect hop is reported with its own status', async () => {
  const tab = await getActiveTab({ id: 'setup', ownerId: OWNER });
  await handleHarStart({ id: 'start', ownerId: OWNER });

  emitCdp(tab.id, 'Network.requestWillBeSent', {
    requestId: 'req-redir',
    request: { url: 'https://example.test/api/old', method: 'GET', headers: {} },
    timestamp: 1700000,
    type: 'XHR',
  });
  emitCdp(tab.id, 'Network.requestWillBeSent', {
    requestId: 'req-redir',
    request: { url: 'https://example.test/api/new', method: 'GET', headers: {} },
    timestamp: 1700001,
    type: 'XHR',
    redirectResponse: {
      status: 301,
      statusText: 'Moved Permanently',
      headers: { location: '/api/new' },
      mimeType: '',
    },
  });
  await flush();

  const result = await handleHarStop({ id: 'stop', ownerId: OWNER });
  const hop = findEntry(result, 'https://example.test/api/old');
  assert.equal(hop.response.status, 301, 'the redirect hop keeps its status');
});

test('har_stop distinguishes a lost recording from an empty one', async () => {
  await getActiveTab({ id: 'setup', ownerId: OWNER });

  // No har_start: mimics the recording state being lost before stop.
  const orphan = await handleHarStop({ id: 'stop', ownerId: OWNER });
  assert.equal(orphan.data.recordingWasOpen, false);

  await handleHarStart({ id: 'start', ownerId: OWNER });
  const real = await handleHarStop({ id: 'stop', ownerId: OWNER });
  assert.equal(real.data.recordingWasOpen, true);
});

test('captured bodies are released once the recording is serialized', async () => {
  const tab = await getActiveTab({ id: 'setup', ownerId: OWNER });
  await handleHarStart({ id: 'start', ownerId: OWNER });

  responseBodies.set('req-drop', { body: '{"big":"payload"}', base64Encoded: false });
  await recordExchange(tab.id, {
    requestId: 'req-drop',
    url: 'https://example.test/api/drop',
  });

  const first = await handleHarStop({ id: 'stop', ownerId: OWNER });
  assert.equal(first.data.bodiesCaptured, 1, 'the body was in the emitted HAR');

  // Stopping again returns the same requests with the payloads freed.
  const second = await handleHarStop({ id: 'stop-again', ownerId: OWNER });
  assert.equal(second.data.bodiesCaptured, 0, 'bodies are not retained in memory');
});

test('traffic from a cross-origin iframe is adopted and captured', async () => {
  const tab = await getActiveTab({ id: 'setup', ownerId: OWNER });
  await handleHarStart({ id: 'start', ownerId: OWNER });

  // Chrome reports an out-of-process iframe as a newly attached target; its
  // requests then arrive under the same tab with a sessionId.
  emitCdp(tab.id, 'Target.attachedToTarget', {
    sessionId: 'CHILD1',
    targetInfo: { targetId: 'T1', type: 'iframe', url: 'https://embed.test/player' },
  });
  await flush();

  assert.ok(
    sentCommands.some(c => c.method === 'Network.enable' && c.sessionId === 'CHILD1'),
    'network tracking is enabled on the child target',
  );

  responseBodies.set('child-req', { body: '{"stream":"ok"}', base64Encoded: false });
  emitCdp(
    tab.id,
    'Network.requestWillBeSent',
    {
      requestId: 'child-req',
      request: { url: 'https://embed.test/api/config', method: 'GET', headers: {} },
      timestamp: 1700000,
      type: 'XHR',
    },
    'CHILD1',
  );
  emitCdp(
    tab.id,
    'Network.responseReceived',
    {
      requestId: 'child-req',
      response: { status: 200, statusText: 'OK', headers: {}, mimeType: 'application/json', encodedDataLength: 15 },
    },
    'CHILD1',
  );
  emitCdp(tab.id, 'Network.loadingFinished', { requestId: 'child-req' }, 'CHILD1');
  await flush();

  const result = await handleHarStop({ id: 'stop', ownerId: OWNER });
  const entry = findEntry(result, 'https://embed.test/api/config');
  assert.ok(entry, 'the iframe request was recorded');
  assert.equal(entry.response.content.text, '{"stream":"ok"}');
  assert.ok(
    sentCommands.some(
      c => c.method === 'Network.getResponseBody' && c.sessionId === 'CHILD1',
    ),
    'its body was fetched against the owning session',
  );
});

test('websocket frames are recorded against their connection', async () => {
  const tab = await getActiveTab({ id: 'setup', ownerId: OWNER });
  await handleHarStart({ id: 'start', ownerId: OWNER });

  emitCdp(tab.id, 'Network.webSocketCreated', {
    requestId: 'ws-1',
    url: 'wss://chat.test/socket',
  });
  emitCdp(tab.id, 'Network.webSocketFrameSent', {
    requestId: 'ws-1',
    response: { opcode: 1, payloadData: '{"op":"subscribe"}' },
  });
  emitCdp(tab.id, 'Network.webSocketFrameReceived', {
    requestId: 'ws-1',
    response: { opcode: 1, payloadData: '{"event":"message","text":"hi"}' },
  });
  await flush();

  const result = await handleHarStop({ id: 'stop', ownerId: OWNER });
  const entry = findEntry(result, 'wss://chat.test/socket');
  assert.ok(entry, 'the socket is present as an entry');
  assert.equal(entry._resourceType, 'WebSocket');
  assert.deepEqual(
    entry._webSocketMessages.map(m => m.type),
    ['send', 'receive'],
  );
  assert.equal(entry._webSocketMessages[1].data, '{"event":"message","text":"hi"}');
});

test('server-sent events are recorded against their stream', async () => {
  const tab = await getActiveTab({ id: 'setup', ownerId: OWNER });
  await handleHarStart({ id: 'start', ownerId: OWNER });

  emitCdp(tab.id, 'Network.requestWillBeSent', {
    requestId: 'sse-1',
    request: { url: 'https://live.test/stream', method: 'GET', headers: {} },
    timestamp: 1700000,
    type: 'EventSource',
  });
  emitCdp(tab.id, 'Network.eventSourceMessageReceived', {
    requestId: 'sse-1',
    eventName: 'update',
    eventId: '7',
    data: '{"score":3}',
  });
  await flush();

  const result = await handleHarStop({ id: 'stop', ownerId: OWNER });
  const entry = findEntry(result, 'https://live.test/stream');
  assert.equal(entry._eventSourceMessages.length, 1);
  assert.equal(entry._eventSourceMessages[0].data, '{"score":3}');
  assert.equal(entry._eventSourceMessages[0].eventName, 'update');
});

test('streaming manifests are captured but media segments are not', async () => {
  const tab = await getActiveTab({ id: 'setup', ownerId: OWNER });
  await handleHarStart({ id: 'start', ownerId: OWNER });

  responseBodies.set('req-hls', { body: '#EXTM3U\n#EXT-X-VERSION:6', base64Encoded: false });
  await recordExchange(tab.id, {
    requestId: 'req-hls',
    url: 'https://cdn.test/video/master.m3u8',
    type: 'Other',
    mimeType: 'application/vnd.apple.mpegurl',
  });

  responseBodies.set('req-seg', { body: 'BINARYSEGMENT', base64Encoded: true });
  await recordExchange(tab.id, {
    requestId: 'req-seg',
    url: 'https://cdn.test/video/seg-00001.m4s',
    type: 'Media',
    mimeType: 'video/iso.segment',
  });

  const result = await handleHarStop({ id: 'stop', ownerId: OWNER });
  assert.ok(
    findEntry(result, 'https://cdn.test/video/master.m3u8').response.content.text.startsWith('#EXTM3U'),
    'the manifest body is kept',
  );
  assert.equal(
    findEntry(result, 'https://cdn.test/video/seg-00001.m4s').response.content.text,
    undefined,
    'the segment body is not',
  );
});

test('stream frames are bounded', async () => {
  const tab = await getActiveTab({ id: 'setup', ownerId: OWNER });
  await handleHarStart({ id: 'start', ownerId: OWNER });

  emitCdp(tab.id, 'Network.webSocketCreated', { requestId: 'ws-flood', url: 'wss://flood.test/s' });
  for (let index = 0; index < 400; index += 1) {
    emitCdp(tab.id, 'Network.webSocketFrameReceived', {
      requestId: 'ws-flood',
      response: { opcode: 1, payloadData: `frame-${index}` },
    });
  }
  await flush();

  const result = await handleHarStop({ id: 'stop', ownerId: OWNER });
  const entry = findEntry(result, 'wss://flood.test/s');
  assert.equal(entry._webSocketMessages.length, 300);
  assert.equal(entry._framesTruncated, true);
});

test('bodies are only captured while a recording is open', async () => {
  const tab = await getActiveTab({ id: 'setup', ownerId: OWNER });
  await handleRequests({ id: 'track', ownerId: OWNER });

  responseBodies.set('req-untracked', { body: '{"secret":true}', base64Encoded: false });
  await recordExchange(tab.id, {
    requestId: 'req-untracked',
    url: 'https://example.test/api/idle',
  });

  assert.ok(
    !sentCommands.some(
      (call) =>
        call.method === 'Network.getResponseBody' &&
        call.params.requestId === 'req-untracked',
    ),
    'no body read outside har_start/har_stop',
  );
});
