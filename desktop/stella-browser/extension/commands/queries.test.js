import assert from 'node:assert/strict';
import test from 'node:test';

const noopEvent = { addListener() {} };
const tab = { id: 17, windowId: 1, groupId: -1, url: 'https://example.com' };
let runtimeEvaluation;
let scriptingCalls = 0;
let storage = {
  agentWindowId: 1,
  stellaGroupId: null,
  ownerTabState: {
    'owner-a': {
      tabIds: [17],
      activeTabId: 17,
      lastTouchedAtByTabId: { 17: Date.now() },
    },
  },
};

globalThis.chrome = {
  storage: {
    session: {
      async get(keys) {
        return Object.fromEntries(keys.map((key) => [key, storage[key]]));
      },
      async set(value) {
        storage = { ...storage, ...value };
      },
    },
  },
  windows: {
    onRemoved: noopEvent,
    async get() { return { id: 1, type: 'normal' }; },
    async getLastFocused() { return { id: 1, type: 'normal' }; },
    async getAll() { return [{ id: 1, type: 'normal' }]; },
  },
  tabGroups: {
    async query() { return []; },
    async get() { throw new Error('group not found'); },
  },
  tabs: {
    onCreated: noopEvent,
    onRemoved: noopEvent,
    async get(tabId) {
      if (tabId !== tab.id) throw new Error('tab not found');
      return { ...tab };
    },
    async query() { return [{ ...tab }]; },
  },
  scripting: {
    async executeScript() {
      scriptingCalls += 1;
      return [{ result: 2 }];
    },
  },
  debugger: {
    onEvent: noopEvent,
    onDetach: noopEvent,
    async attach() {},
    async detach() {},
    async sendCommand(target, method, params) {
      runtimeEvaluation = { target, method, params };
      return { result: { value: 3 } };
    },
  },
};

const { handleCount } = await import('./queries.js');
const { encodeSemanticSelector } = await import('../lib/selector.js');
const { detachAllDebuggers } = await import('../lib/debugger.js');

test('count resolves semantic aria locators through the all-match evaluator', async () => {
  const selector = encodeSemanticSelector({ kind: 'role', role: 'button', name: 'Save' });
  const response = await handleCount({
    id: 'semantic-count',
    ownerId: 'owner-a',
    selector,
  });

  assert.equal(response.data.count, 3);
  assert.equal(scriptingCalls, 0);
  assert.equal(runtimeEvaluation.method, 'Runtime.evaluate');
  assert.equal(runtimeEvaluation.params.awaitPromise, true);
  assert.match(runtimeEvaluation.params.expression, /return matches/);
  assert.equal(runtimeEvaluation.params.expression.includes(selector), false);
  await detachAllDebuggers();
});

test('count retains the CSS executeScript path for CSS selectors', async () => {
  const response = await handleCount({
    id: 'css-count',
    ownerId: 'owner-a',
    selector: '.item',
  });

  assert.equal(response.data.count, 2);
  assert.equal(scriptingCalls, 1);
});
