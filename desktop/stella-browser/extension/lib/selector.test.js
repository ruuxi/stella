import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildRoleMatcherAllScript,
  buildRoleMatcherScript,
  clearOwnerRefMaps,
  encodeSemanticSelector,
  parseSemanticSelector,
  resolveSelector,
  setRefMap,
} from './selector.js';

test('semantic selectors round-trip all supported locator kinds', () => {
  const selectors = [
    { kind: 'role', role: 'button', name: 'Save', nth: 1, exact: true },
    { kind: 'text', value: 'Welcome back', exact: true },
    { kind: 'label', value: 'Email address' },
    { kind: 'placeholder', value: 'name@example.com', nth: 2 },
    { kind: 'testid', value: 'submit-button', exact: true },
  ];

  for (const selector of selectors) {
    const encoded = encodeSemanticSelector(selector);
    assert.match(encoded, /^aria=/);
    const parsed = parseSemanticSelector(encoded);
    assert.equal(parsed.kind, selector.kind);
    assert.equal(parsed.exact, selector.exact === true);

    const resolved = resolveSelector(encoded, 'owner-a', 17);
    assert.equal(resolved.isRef, true);
    assert.equal(resolved.isSemantic, true);
    assert.deepEqual(resolved.role, parsed);

    const script = buildRoleMatcherScript(resolved.role, resolved.name, resolved.nth);
    assert.match(script, new RegExp(`"kind":"${selector.kind}"`));
    assert.match(script, /matcher\.exact/);
    assert.match(script, /\\s\+/);

    const allScript = buildRoleMatcherAllScript(resolved.role, resolved.name);
    assert.match(allScript, /return matches/);
    assert.doesNotMatch(allScript, /Element index/);
  }
});

test('single semantic matcher applies nth after resolving all matches', () => {
  const selector = encodeSemanticSelector({
    kind: 'role',
    role: 'button',
    name: 'Save',
    nth: 2,
  });
  const resolved = resolveSelector(selector, 'owner-a', 17);
  const script = buildRoleMatcherScript(resolved.role, resolved.name, resolved.nth);

  assert.match(script, /const matches =/);
  assert.match(script, /const index = 2/);
  assert.match(script, /return matches\[index\]/);
});

test('semantic selector parsing rejects malformed and unsafe payloads', () => {
  assert.throws(() => parseSemanticSelector('aria='), /payload is empty/);
  assert.throws(() => parseSemanticSelector('aria=%E0%A4%A'), /percent-encoding/);
  assert.throws(() => parseSemanticSelector('aria=not-json'), /valid JSON/);
  assert.throws(
    () => encodeSemanticSelector({ kind: 'role', role: 'button"]', name: 'Save' }),
    /invalid format/,
  );
  assert.throws(
    () => encodeSemanticSelector({ kind: 'text', value: 'x', nth: -1 }),
    /field 'nth'/,
  );
  assert.throws(
    () => encodeSemanticSelector({ kind: 'label', value: 'Email', extra: true }),
    /Unknown semantic selector field/,
  );
  assert.throws(
    () => encodeSemanticSelector({ kind: 'placeholder', value: '', exact: true }),
    /non-empty string/,
  );
  assert.throws(
    () => encodeSemanticSelector({ kind: 'testid', value: 'submit', exact: 'yes' }),
    /must be a boolean/,
  );
});

test('normal CSS and owner/tab-scoped refs retain existing behavior', () => {
  clearOwnerRefMaps();
  assert.deepEqual(resolveSelector('#submit', 'owner-a', 1), {
    css: '#submit',
    isRef: false,
  });

  setRefMap('owner-a', 1, {
    e1: { role: 'button', name: 'Owner A', nth: 0 },
  });
  setRefMap('owner-b', 1, {
    e1: { role: 'button', name: 'Owner B', nth: 0 },
  });

  assert.equal(resolveSelector('@e1', 'owner-a', 1).name, 'Owner A');
  assert.equal(resolveSelector('@e1', 'owner-b', 1).name, 'Owner B');
  assert.throws(() => resolveSelector('@e1', 'owner-a', 2), /Unknown ref/);
  clearOwnerRefMaps();
});
