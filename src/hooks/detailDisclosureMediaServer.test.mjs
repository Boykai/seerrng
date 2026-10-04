import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// Evaluate pure preference helpers only: no server imports, HTTP or database.
const sourceRoot =
  process.env.PIN_SOURCE_ROOT ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (name) => fs.readFileSync(path.join(sourceRoot, name), 'utf8');
const declarations = (source, names) => {
  const ast = ts.createSourceFile(
    'pins.ts',
    source,
    ts.ScriptTarget.Latest,
    true
  );
  return ast.statements
    .filter(
      (node) =>
        ts.isVariableStatement(node) &&
        node.declarationList.declarations.some((declaration) =>
          names.includes(declaration.name.getText(ast))
        )
    )
    .map((node) => node.getText(ast))
    .join('\n');
};
const evaluate = (source, names) => {
  const javascript = ts.transpileModule(declarations(source, names), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
  return new Function(`${javascript}\nreturn {${names.join(',')}};`)();
};
const hookSource = read('src/hooks/useDetailDisclosurePins.ts');
const { defaultPins, fromUserSettings } = evaluate(hookSource, [
  'defaultPins',
  'fromUserSettings',
]);
const serverSource = read('server/routes/user/usersettings.ts');
const { serializeScopedDetailDisclosurePins, parseDetailDisclosurePinsBody } =
  evaluate(serverSource, [
    'hasOwn',
    'parseUserSettingsBodyObject',
    'serializeScopedDetailDisclosurePins',
    'parseDetailDisclosurePinsBody',
  ]);

test('new Media Server pin is off for missing and legacy TV preferences', () => {
  assert.equal(defaultPins.mediaServer, false);
  assert.equal(fromUserSettings(undefined, 'tv').mediaServer, false);
  assert.deepEqual(serializeScopedDetailDisclosurePins(undefined, 'tv'), {
    details: false,
    mediaServer: false,
    overview: false,
    cast: false,
    crew: false,
    artists: false,
    subjectTags: false,
  });
  const legacy = {
    detailDisclosureCastPinned: true,
    detailDisclosureCrewPinned: true,
  };
  assert.equal(fromUserSettings(legacy, 'tv').mediaServer, false);
  assert.equal(fromUserSettings(legacy, 'movie').cast, true);
  assert.equal(serializeScopedDetailDisclosurePins(legacy, 'movie').cast, true);
});

test('TV preference serialization preserves prior pins and the saved Media Server value', () => {
  const settings = {
    detailDisclosurePins: {
      tv: { cast: true, crew: true, mediaServer: true },
      movie: { cast: false, collection: true },
    },
  };
  assert.equal(fromUserSettings(settings, 'tv').mediaServer, true);
  assert.deepEqual(serializeScopedDetailDisclosurePins(settings, 'tv'), {
    details: false,
    mediaServer: true,
    overview: false,
    cast: true,
    crew: true,
    artists: false,
    subjectTags: false,
  });
  assert.equal(
    serializeScopedDetailDisclosurePins(settings, 'movie').mediaServer,
    undefined
  );
  assert.equal(
    serializeScopedDetailDisclosurePins(settings, 'movie').collection,
    true
  );
});

test('the scoped TV allowlist accepts boolean Media Server values only', () => {
  for (const mediaServer of [true, false])
    assert.deepEqual(
      parseDetailDisclosurePinsBody(
        { mediaServer, cast: true },
        false,
        true,
        true
      ),
      { value: { cast: true, mediaServer } }
    );
  for (const mediaServer of ['true', 1, null, [], {}])
    assert.deepEqual(
      parseDetailDisclosurePinsBody({ mediaServer }, false, true, true),
      { error: 'mediaServer must be a boolean.' }
    );
  assert.deepEqual(
    parseDetailDisclosurePinsBody({ mediaServer: true }, true, true, false),
    { value: {} }
  );
  assert.deepEqual(parseDetailDisclosurePinsBody({ mediaServer: true }), {
    value: {},
  });
  assert.match(
    serverSource,
    /parseDetailDisclosurePinsBody\(\s*req\.body,\s*mediaType === 'movie',\s*true,\s*mediaType === 'tv',\s*mediaType === 'tv'\s*\)/
  );
});

test('pin updates preserve the existing media-scoped storage and partial-update path', () => {
  assert.match(
    serverSource,
    /const updatedPins = \{ \.\.\.currentPins, \.\.\.parsedBody\.value \}/
  );
  assert.match(serverSource, /case 'tv':\s*nextPins\.tv = updatedPins/);
  assert.match(serverSource, /user\.settings\.detailDisclosurePins = nextPins/);
  assert.match(
    hookSource,
    /axios\.post<UserSettingsDetailDisclosureResponse>\(endpoint, \{\s*\[section\]: pinned/
  );
  assert.match(
    read('server/interfaces/api/userSettingsInterfaces.ts'),
    /\| 'mediaServer'/
  );
});

test('Overview is off by default, preserves saved pins, and accepts booleans only in the TV scope', () => {
  assert.equal(defaultPins.overview, false);
  assert.equal(fromUserSettings(undefined, 'tv').overview, false);
  assert.equal(
    serializeScopedDetailDisclosurePins(undefined, 'tv').overview,
    false
  );
  const settings = {
    detailDisclosurePins: { tv: { overview: true, cast: true } },
  };
  assert.equal(
    serializeScopedDetailDisclosurePins(settings, 'tv').overview,
    true
  );
  assert.equal(fromUserSettings(settings, 'tv').cast, true);
  for (const overview of [true, false])
    assert.deepEqual(
      parseDetailDisclosurePinsBody({ overview }, false, true, true, true),
      { value: { overview } }
    );
  for (const overview of ['true', 1, null, [], {}])
    assert.deepEqual(
      parseDetailDisclosurePinsBody({ overview }, false, true, true, true),
      { error: 'overview must be a boolean.' }
    );
  assert.deepEqual(
    parseDetailDisclosurePinsBody({ overview: true }, true, true, false, false),
    { value: {} }
  );
  assert.equal(
    serializeScopedDetailDisclosurePins(undefined, 'movie').overview,
    undefined
  );
});
