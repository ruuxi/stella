import assert from 'node:assert/strict';
import test from 'node:test';

const noopEvent = { addListener() {} };
globalThis.chrome = {
  storage: {
    session: {
      async get() { return {}; },
      async set() {},
    },
  },
  debugger: { onEvent: noopEvent, onDetach: noopEvent },
  tabs: { onCreated: noopEvent, onRemoved: noopEvent },
  windows: { onRemoved: noopEvent },
};

const {
  CHAIN_ACTION_ALLOWLIST,
  handleChain,
  MAX_CHAIN_STEPS,
  validateChainCommand,
} = await import('./chain.js');
const { authorizeOwnerLease } = await import('./tabs.js');

test('chain defaults to no random delay and preserves abort-on-error behavior', async () => {
  const originalSetTimeout = globalThis.setTimeout;
  let timeoutCalls = 0;
  globalThis.setTimeout = (callback) => {
    timeoutCalls += 1;
    callback();
    return 0;
  };

  try {
    const handlers = {
      click: async (command) => ({ success: true, data: { tabId: command.tabId } }),
      fill: async () => {
        throw new Error('fill failed');
      },
      snapshot: async () => ({ success: true, data: {} }),
    };
    const response = await handleChain(
      {
        id: 'chain-1',
        action: 'chain',
        ownerId: 'owner-a',
        tabId: 17,
        steps: [
          { action: 'click', selector: undefined },
          { action: 'fill' },
          { action: 'snapshot' },
        ],
      },
      handlers,
    );

    assert.equal(timeoutCalls, 0);
    assert.equal(response.success, false);
    assert.equal(response.error, 'Chain step 1 (fill) failed: fill failed');
    assert.equal(response.data.results.length, 2);
    assert.equal(response.data.results[0].data.tabId, 17);
    assert.match(response.data.results[1].error, /fill failed/);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});
test('chain only delays when an explicit delay object is supplied', async () => {
  const originalSetTimeout = globalThis.setTimeout;
  const delays = [];
  globalThis.setTimeout = (callback, milliseconds) => {
    delays.push(milliseconds);
    callback();
    return 0;
  };

  try {
    const handlers = {
      click: async () => ({ success: true, data: {} }),
    };
    await handleChain(
      {
        id: 'chain-delay',
        action: 'chain',
        ownerId: 'owner-a',
        steps: [{ action: 'click' }, { action: 'click' }],
        delay: { min: 5, max: 5 },
      },
      handlers,
    );
    assert.deepEqual(delays, [5]);
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('chain rechecks the owner lease before each later step', async () => {
  const oldLease = {
    id: 'chain-old',
    action: 'chain',
    ownerId: 'chain-owner',
    ownerLeaseId: 'chain-kernel-old',
    ownerLeaseIssuedAt: 100,
  };
  const newLease = {
    ...oldLease,
    id: 'chain-new',
    ownerLeaseId: 'chain-kernel-new',
    ownerLeaseIssuedAt: 200,
  };
  await authorizeOwnerLease(oldLease);

  let releaseFirst;
  let firstStarted;
  const firstStartedPromise = new Promise((resolve) => { firstStarted = resolve; });
  const releaseFirstPromise = new Promise((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  const chainPromise = handleChain(
    { ...oldLease, steps: [{ action: 'click' }, { action: 'click' }] },
    {
      click: async () => {
        calls += 1;
        if (calls === 1) {
          firstStarted();
          await releaseFirstPromise;
        }
        return { success: true, data: {} };
      },
    },
  );

  await firstStartedPromise;
  await authorizeOwnerLease(newLease);
  releaseFirst();
  await assert.rejects(chainPromise, /Stale browser owner lease rejected/);
  assert.equal(calls, 1);
});

test('chain validation rejects nested, oversized, and unsafe shapes', () => {
  for (const action of ['chain', 'finalize_tabs', 'close_owner', 'not_real']) {
    assert.equal(CHAIN_ACTION_ALLOWLIST.has(action), false);
    assert.throws(
      () => validateChainCommand({ steps: [{ action }] }),
      /action is not allowed/,
    );
  }
  assert.throws(
    () =>
      validateChainCommand({
        steps: Array.from({ length: MAX_CHAIN_STEPS + 1 }, () => ({ action: 'click' })),
      }),
    /maximum/,
  );
  assert.throws(
    () => validateChainCommand({ steps: [{ action: 'click' }], ownerId: 'a', extra: true }),
    /Unknown or unsafe chain option/,
  );
  assert.throws(
    () => validateChainCommand({ steps: [{ action: 'click', tabId: 0 }] }),
    /positive integer/,
  );
  assert.throws(
    () => validateChainCommand({ steps: [{ action: 'evaluate', timeout: 30_001 }] }),
    /timeout must be between/,
  );
  assert.throws(
    () => validateChainCommand({ steps: [{ action: 'click' }], waitTimeout: 30_001 }),
    /waitTimeout must be between/,
  );
});

test('chain stops before starting work after its execution budget expires', async () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const response = await handleChain(
      {
        id: 'chain-budget',
        ownerId: 'owner-a',
        steps: [{ action: 'click' }, { action: 'click' }],
      },
      {
        click: async () => {
          now += 45_001;
          return { success: true, data: {} };
        },
      },
    );
    assert.equal(response.success, false);
    assert.equal(response.data.results.length, 2);
    assert.match(response.data.results[1].error, /execution budget/);
  } finally {
    Date.now = originalNow;
  }
});

test('requested screenshot failures fail the chain with format metadata', async () => {
  const response = await handleChain(
    {
      id: 'chain-shot-failure',
      ownerId: 'owner-a',
      steps: [{ action: 'click' }],
      returnScreenshot: true,
    },
    {
      click: async () => ({ success: true, data: {} }),
      screenshot: async () => {
        throw new Error('capture failed');
      },
    },
  );

  assert.equal(response.success, false);
  assert.equal(response.error, 'capture failed');
  assert.deepEqual(response.data.screenshotError, {
    error: 'capture failed',
    format: 'jpeg',
  });
});

test('failed action responses propagate the action and concrete message', async () => {
  const response = await handleChain(
    {
      id: 'chain-action-failure',
      ownerId: 'owner-a',
      steps: [{ action: 'click' }],
    },
    {
      click: async () => ({ success: false, error: 'target was detached' }),
    },
  );

  assert.equal(response.success, false);
  assert.equal(response.error, 'Chain step 0 (click) failed: target was detached');
  assert.equal(response.data.results[0].error, 'target was detached');
});

test('requested snapshot failures fail the chain', async () => {
  const response = await handleChain(
    {
      id: 'chain-snapshot-failure',
      ownerId: 'owner-a',
      steps: [{ action: 'click' }],
      returnSnapshot: true,
    },
    {
      click: async () => ({ success: true, data: {} }),
      snapshot: async () => {
        throw new Error('snapshot failed');
      },
    },
  );

  assert.equal(response.success, false);
  assert.equal(response.error, 'snapshot failed');
  assert.equal(response.data.snapshotError, 'snapshot failed');
});

test('requested screenshots preserve base64 compatibility and expose format', async () => {
  const response = await handleChain(
    {
      id: 'chain-shot-success',
      ownerId: 'owner-a',
      steps: [{ action: 'click' }],
      returnScreenshot: true,
    },
    {
      click: async () => ({ success: true, data: {} }),
      screenshot: async () => ({
        success: true,
        data: { base64: 'image-data', format: 'png' },
      }),
    },
  );

  assert.equal(response.success, true);
  assert.equal(response.data.screenshot, 'image-data');
  assert.equal(response.data.screenshotFormat, 'png');
});
