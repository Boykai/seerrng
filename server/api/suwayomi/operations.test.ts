import {
  INSTANCE_MARKER_KEY,
  REQUEST_INDEX_PREFIX,
  REQUEST_STAMP_KEY,
  ROOT_FIELDS,
  SUWAYOMI_OPERATIONS,
} from '@server/api/suwayomi/operations';
import { goodFaithViolations } from '@server/test/fakeSuwayomi';
import {
  Kind,
  parse,
  visit,
  type DocumentNode,
  type OperationDefinitionNode,
  type ValueNode,
} from 'graphql';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const SETTINGS_ALLOW_LIST = [
  'autoDownloadNewChapters',
  'downloadAsCbz',
  'excludeEntryWithUnreadChapters',
  'excludeNotStarted',
  'excludeUnreadChapters',
  'flareSolverrEnabled',
  'globalUpdateInterval',
  'maxSourcesInParallel',
];
const FORBIDDEN_ROOT_FIELD =
  /extension|setting|track|deleteDownloaded|backup|restore|webui|clear|subscri/i;
const FORBIDDEN_FIELDS = new Set([
  'thumbnailUrl',
  'realUrl',
  'remoteUrl',
  'pkgName',
]);
const SECRET_FIELD = /password|username|secret|apikey|cookie|proxy|socks|url$/i;
const VARIABLE_META_KEYS = new Set(['SetRequestIndex', 'DeleteRequestIndex']);
// The capability probe the pinned server refused with HTTP 200 and `errors`.
const REFUSED_CAPABILITIES = `query Capabilities {
  aboutServer { name version buildType }
  __schema {
    queryType { fields(includeDeprecated: true) { name } }
    mutationType { fields(includeDeprecated: true) { name } }
  }
  mangaType: __type(name: "MangaType") { fields(includeDeprecated: true) { name } }
  chapterType: __type(name: "ChapterType") { fields(includeDeprecated: true) { name } }
}`;

const entries = Object.entries(SUWAYOMI_OPERATIONS);

const operationOf = (document: DocumentNode): OperationDefinitionNode => {
  assert.equal(document.definitions.length, 1);
  const [definition] = document.definitions;
  assert.equal(definition.kind, Kind.OPERATION_DEFINITION);
  return definition as OperationDefinitionNode;
};

const rootFields = (operation: OperationDefinitionNode) =>
  operation.selectionSet.selections.map((selection) => {
    assert.equal(selection.kind, Kind.FIELD);
    return selection.kind === Kind.FIELD ? selection.name.value : '';
  });

const stringValues = (value: ValueNode): string[] =>
  value.kind === Kind.STRING
    ? [value.value]
    : value.kind === Kind.OBJECT
      ? value.fields.flatMap((field) => stringValues(field.value))
      : [];

describe('Suwayomi operation documents', () => {
  it('contain exactly one named query or mutation each', () => {
    for (const [name, operation] of entries) {
      const definition = operationOf(parse(operation.document));
      assert.equal(definition.name?.value, name);
      assert.equal(
        definition.operation,
        operation.callClass === 'query' ? 'query' : 'mutation',
        name
      );
      visit(parse(operation.document), {
        FragmentSpread: () => assert.fail(`${name} uses a fragment`),
        InlineFragment: () => assert.fail(`${name} uses a fragment`),
        Directive: () => assert.fail(`${name} uses a directive`),
      });
    }
  });

  it('use only the declared root fields, and all of them', () => {
    const used = { query: new Set<string>(), mutation: new Set<string>() };
    for (const [name, operation] of entries) {
      const definition = operationOf(parse(operation.document));
      const type = definition.operation as 'query' | 'mutation';
      for (const field of rootFields(definition)) {
        if (field === '__schema' || field === '__type') {
          assert.equal(name, 'Capabilities');
          continue;
        }
        assert.ok(
          (ROOT_FIELDS[type] as readonly string[]).includes(field),
          `${name} uses undeclared root field ${field}`
        );
        used[type].add(field);
      }
    }
    assert.deepEqual([...used.query].sort(), [...ROOT_FIELDS.query].sort());
    assert.deepEqual(
      [...used.mutation].sort(),
      [...ROOT_FIELDS.mutation].sort()
    );
  });

  it('stay within the introspection limits Suwayomi enforces', () => {
    for (const [name, operation] of entries) {
      assert.deepEqual(goodFaithViolations(operation.document), [], name);
    }
  });

  it('would catch the capability probe the pinned server refused', () => {
    assert.deepEqual(goodFaithViolations(REFUSED_CAPABILITIES), [
      'Query.__type',
      '__Type.fields',
    ]);
  });

  it('size-limit only introspection, as the server does', () => {
    const wide = Array.from({ length: 500 }, (_, i) => `f${i}: name`).join(' ');
    const deep = `{ __schema { types { fields { type { ${'ofType { '.repeat(16)}name${' }'.repeat(20)} }`;
    assert.deepEqual(goodFaithViolations(`{ aboutServer { ${wide} } }`), []);
    assert.deepEqual(
      goodFaithViolations(`{ __schema { types { ${wide} } } }`),
      ['more than 500 fields']
    );
    assert.deepEqual(goodFaithViolations(deep), ['deeper than 20 levels']);
    assert.deepEqual(goodFaithViolations('{'), []);
  });

  it('never reach extension, tracker, backup or file-deletion fields, or change settings', () => {
    for (const field of ROOT_FIELDS.mutation) {
      assert.doesNotMatch(field, FORBIDDEN_ROOT_FIELD);
    }
    for (const field of ROOT_FIELDS.query) {
      if (field !== 'settings') {
        assert.doesNotMatch(field, FORBIDDEN_ROOT_FIELD);
      }
    }
    for (const [name, operation] of entries) {
      assert.doesNotMatch(operation.document, /clearCategories/, name);
      visit(parse(operation.document), {
        Field(node) {
          assert.ok(!FORBIDDEN_FIELDS.has(node.name.value), name);
        },
      });
    }
  });

  it('read only the tracker and remote IDs of track records, and only to match', () => {
    for (const [name, operation] of entries) {
      visit(parse(operation.document), {
        Field(node) {
          if (node.name.value !== 'trackRecords') return;
          assert.equal(name, 'LibraryTrackRecords');
          const [nodesField, ...rest] = node.selectionSet?.selections ?? [];
          assert.deepEqual(rest, [], name);
          assert.ok(
            nodesField?.kind === Kind.FIELD &&
              nodesField.name.value === 'nodes',
            name
          );
          const selected = (nodesField.selectionSet?.selections ?? []).map(
            (selection) =>
              selection.kind === Kind.FIELD ? selection.name.value : ''
          );
          assert.deepEqual(selected.sort(), ['remoteId', 'trackerId']);
        },
      });
    }
  });

  it('select only non-secret settings, and only for health', () => {
    for (const [name, operation] of entries) {
      visit(parse(operation.document), {
        Field(node) {
          if (node.name.value !== 'settings') return;
          assert.equal(name, 'Health');
          const selected = (node.selectionSet?.selections ?? []).map(
            (selection) =>
              selection.kind === Kind.FIELD ? selection.name.value : ''
          );
          assert.deepEqual(selected.sort(), SETTINGS_ALLOW_LIST);
        },
      });
    }
  });

  it('select no credential fields outside login and refresh', () => {
    for (const [name, operation] of entries) {
      visit(parse(operation.document), {
        Field(node) {
          if (name === 'Login' || name === 'Refresh') return;
          assert.ok(
            !SECRET_FIELD.test(node.name.value) || node.name.value === 'url',
            `${name} selects ${node.name.value}`
          );
          assert.doesNotMatch(node.name.value, /token/i, name);
        },
      });
    }
  });

  it('write and read only seerrng meta keys', () => {
    for (const key of [
      REQUEST_STAMP_KEY,
      REQUEST_INDEX_PREFIX,
      INSTANCE_MARKER_KEY,
    ]) {
      assert.match(key, /^seerrng\./);
    }
    for (const [name, operation] of entries) {
      const check = (value: ValueNode) => {
        if (value.kind === Kind.VARIABLE) {
          assert.ok(
            VARIABLE_META_KEYS.has(name),
            `${name} uses a key variable`
          );
          return;
        }
        const strings = stringValues(value);
        assert.ok(strings.length > 0, name);
        for (const key of strings) {
          assert.match(key, /^seerrng\./, name);
        }
      };
      visit(parse(operation.document), {
        Argument(node) {
          if (node.name.value === 'key') check(node.value);
        },
        ObjectField(node) {
          if (node.name.value === 'key') check(node.value);
        },
      });
    }
  });

  it('define every variable they use and use every variable they define', () => {
    for (const [name, operation] of entries) {
      const definition = operationOf(parse(operation.document));
      const defined = new Set(
        (definition.variableDefinitions ?? []).map(
          (variable) => variable.variable.name.value
        )
      );
      const used = new Set<string>();
      visit(definition.selectionSet, {
        Variable(node) {
          used.add(node.name.value);
        },
      });
      assert.deepEqual([...used].sort(), [...defined].sort(), name);
    }
  });

  it('send credentials only where each operation needs them', () => {
    for (const [name, operation] of entries) {
      const expected =
        name === 'Login' || name === 'Refresh'
          ? 'none'
          : name === 'Probe'
            ? 'public'
            : 'user';
      assert.equal(operation.auth, expected, name);
    }
  });
});
