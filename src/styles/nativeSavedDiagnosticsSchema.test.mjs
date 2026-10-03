import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const spec = yaml.load(readFileSync('seerr-api.yml', 'utf8'));

test('native saved-state errors declare only bounded diagnostic fields, never native credentials or identities', () => {
  const route = spec.paths['/tv/{tvId}/media-server-saved-item'];
  const schemas = ['get', 'post'].map(
    (method) =>
      route[method].responses['502'].content['application/json'].schema
  );
  assert.deepEqual(schemas[0], schemas[1]);
  const failure = schemas[0];
  assert.equal(failure.additionalProperties, false);
  assert.deepEqual(Object.keys(failure.properties).sort(), [
    'diagnostic',
    'message',
  ]);
  const diagnostic = failure.properties.diagnostic;
  assert.equal(diagnostic.additionalProperties, false);
  assert.deepEqual(diagnostic.required.sort(), ['category', 'phase']);
  assert.deepEqual(Object.keys(diagnostic.properties).sort(), [
    'category',
    'phase',
    'upstreamStatus',
  ]);
  for (const field of ['category', 'phase']) {
    assert.equal(diagnostic.properties[field].type, 'string');
    assert.ok(diagnostic.properties[field].enum.length > 0);
  }
  assert.deepEqual(diagnostic.properties.upstreamStatus, {
    type: 'integer',
    minimum: 400,
    maximum: 599,
  });
});
