import assert from 'node:assert/strict';
import test from 'node:test';

const noopEvent = { addListener() {} };
let sendCommandImpl;

globalThis.chrome = {
  debugger: {
    onEvent: noopEvent,
    onDetach: noopEvent,
    async attach() {},
    async detach() {},
    sendCommand(...args) {
      return sendCommandImpl(...args);
    },
  },
  tabs: { onRemoved: noopEvent },
};

const { detachAllDebuggers, evaluateRuntime } = await import('./debugger.js');

test('Runtime.evaluate awaits async expression results', async () => {
  let observed;
  sendCommandImpl = async (target, method, params) => {
    observed = { target, method, params };
    return { result: { value: 'resolved' } };
  };

  const value = await evaluateRuntime(17, 'Promise.resolve("resolved")');
  assert.equal(value, 'resolved');
  assert.deepEqual(observed.target, { tabId: 17 });
  assert.equal(observed.method, 'Runtime.evaluate');
  assert.equal(observed.params.awaitPromise, true);
  assert.equal(observed.params.returnByValue, true);
  assert.equal(observed.params.timeout, 30_000);
  await detachAllDebuggers();
});

test('Runtime.evaluate surfaces async rejection details', async () => {
  sendCommandImpl = async () => ({
    exceptionDetails: {
      text: 'Uncaught (in promise)',
      exception: { description: 'Error: async rejection' },
    },
  });

  await assert.rejects(
    evaluateRuntime(18, 'Promise.reject(new Error("async rejection"))'),
    /async rejection/,
  );
  await detachAllDebuggers();
});

test('Runtime.evaluate can grant native user activation', async () => {
  let observedParams;
  sendCommandImpl = async (_target, _method, params) => {
    observedParams = params;
    return { result: { value: true } };
  };

  await evaluateRuntime(19, 'document.querySelector("a").click()', {
    userGesture: true,
  });
  assert.equal(observedParams.userGesture, true);
  assert.equal(observedParams.awaitPromise, true);
  await detachAllDebuggers();
});
