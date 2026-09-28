import assert from 'node:assert/strict';
import { it, mock } from 'node:test';
import { createBrowserActionId } from './browserActionId';
it('creates unique UUIDs without relying on the secure-context-only randomUUID method', () => {
  const stub = mock.method(globalThis.crypto, 'randomUUID', () => {
    throw new Error('not available on HTTP');
  });
  try {
    const values = Array.from({ length: 100 }, createBrowserActionId);
    assert.equal(new Set(values).size, 100);
    values.forEach((value) =>
      assert.match(
        value,
        /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
      )
    );
  } finally {
    stub.mock.restore();
  }
});
