import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { extractCatalogue } from './extract-messages-lib.js';

function fixture(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'seerr-message-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'src'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, 'src', name), content);
  }
  return { root, entry: join(root, 'src', 'entry.ts') };
}

test('extracts imported spreads, escaped strings, ICU text, and multiple groups', (t) => {
  const { root, entry } = fixture(t, {
    'shared.ts': `export const shared = { retry: 'Try again', count: '{count, plural, one {item} other {items}}' } as const;`,
    'entry.ts': `import { shared } from '@app/shared';
      const words = { ...shared, quoted: "Artist's collection" };
      defineMessages('first', words);
      defineMessages('second', { clear: 'Clear' });`,
  });
  assert.deepEqual(JSON.parse(extractCatalogue([entry], root)), {
    'first.count': '{count, plural, one {item} other {items}}',
    'first.quoted': "Artist's collection",
    'first.retry': 'Try again',
    'second.clear': 'Clear',
  });
});

test('rejects dynamic messages without executing application code', (t) => {
  const { root, entry } = fixture(t, {
    'entry.ts': `defineMessages('unsafe', { message: (() => { throw new Error('EXECUTED'); })() });`,
  });
  assert.throws(
    () => extractCatalogue([entry], root),
    /Unsupported non-static message expression/
  );
});

test('rejects conflicting IDs rather than silently overwriting translations', (t) => {
  const { root, entry } = fixture(t, {
    'entry.ts': `defineMessages('same', { key: 'One' }); defineMessages('same', { key: 'Two' });`,
  });
  assert.throws(
    () => extractCatalogue([entry], root),
    /Conflicting message same.key/
  );
});

test('rejects circular references and malformed declarations', (t) => {
  const { root, entry } = fixture(t, {
    'entry.ts': `const loop = { ...loop }; defineMessages('loop', loop);`,
  });
  assert.throws(
    () => extractCatalogue([entry], root),
    /Circular message reference/
  );
  writeFileSync(entry, `defineMessages('broken', { key: 'unfinished });`);
  assert.throws(
    () => extractCatalogue([entry], root),
    /Invalid TypeScript syntax/
  );
});
