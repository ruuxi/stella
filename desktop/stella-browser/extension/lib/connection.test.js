import assert from 'node:assert/strict';
import test from 'node:test';

function createEvent() {
  const listeners = [];
  return {
    addListener(listener) {
      listeners.push(listener);
    },
    emit(...args) {
      for (const listener of listeners) listener(...args);
    },
  };
}

function createPort() {
  return {
    onMessage: createEvent(),
    onDisconnect: createEvent(),
    messages: [],
    disconnect() {},
    postMessage(message) {
      this.messages.push(message);
    },
  };
}

const ports = [];
const alarmEvent = createEvent();
globalThis.fetch = async () => ({ ok: true });
globalThis.chrome = {
  action: { async setBadgeText() {} },
  alarms: {
    create() {},
    onAlarm: alarmEvent,
  },
  runtime: {
    lastError: null,
    connectNative() {
      const port = createPort();
      ports.push(port);
      return port;
    },
  },
};

const {
  connect,
  disconnect,
  isConnected,
  onCommand,
} = await import('./connection.js');

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('stale disconnect cannot clear a newer native port', async () => {
  connect();
  await flush();
  const first = ports.at(-1);

  disconnect();
  connect();
  await flush();
  const second = ports.at(-1);
  assert.notEqual(first, second);
  assert.equal(isConnected(), true);

  first.onDisconnect.emit();
  await flush();
  assert.equal(isConnected(), true);
  assert.equal(ports.at(-1), second);
  disconnect();
});

test('stale async command completion is not sent over a newer port', async () => {
  let resolveCommand;
  onCommand(() => new Promise((resolve) => {
    resolveCommand = resolve;
  }));

  connect();
  await flush();
  const first = ports.at(-1);
  first.onMessage.emit({ type: 'command', id: 'old-command' });
  await flush();

  disconnect();
  connect();
  await flush();
  const second = ports.at(-1);
  resolveCommand({ type: 'response', id: 'old-command', success: true });
  await flush();

  assert.deepEqual(
    first.messages.map((message) => message.type),
    ['hello'],
  );
  assert.deepEqual(
    second.messages.map((message) => message.type),
    ['hello'],
  );
  disconnect();
});
