import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const EXPECTED_EXTENSION_ID = 'kfnchfpocpmdblhfgcnpfaaebaioojnl';

const extensionIdFromKey = (key) =>
  [...createHash('sha256').update(Buffer.from(key, 'base64')).digest().subarray(0, 16)]
    .map((byte) =>
      String.fromCharCode(97 + (byte >> 4), 97 + (byte & 0x0f)),
    )
    .join('');

test('manifest key preserves the production native-messaging extension ID', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('./manifest.json', import.meta.url), 'utf8'),
  );
  assert.equal(extensionIdFromKey(manifest.key), EXPECTED_EXTENSION_ID);
  assert.equal(manifest.version, '1.2.6');
});
