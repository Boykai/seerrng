import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { rewriteServerAliases } from './replace-server-import-aliases.mjs';

const temporaryDirectories = [];

const createOutputDirectory = async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), 'seerrng-server-aliases-')
  );
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('compiled server import alias rewriting', () => {
  it('rewrites root, nested, and directory-index imports to emitted files', async () => {
    const outputDirectory = await createOutputDirectory();
    await mkdir(path.join(outputDirectory, 'api'), { recursive: true });
    await mkdir(path.join(outputDirectory, 'lib', 'settings'), {
      recursive: true,
    });
    await writeFile(path.join(outputDirectory, 'api', 'plexapi.js'), '');
    await writeFile(
      path.join(outputDirectory, 'lib', 'settings', 'index.js'),
      ''
    );
    const entryPath = path.join(outputDirectory, 'routes', 'startup.js');
    await mkdir(path.dirname(entryPath), { recursive: true });
    await writeFile(
      entryPath,
      [
        'const PlexAPI = require("@server/api/plexapi");',
        "const settings = require('@server/lib/settings');",
      ].join('\n')
    );

    const replacements = await rewriteServerAliases(outputDirectory);
    const compiledSource = await readFile(entryPath, 'utf8');

    assert.strictEqual(replacements, 2);
    assert.match(compiledSource, /require\("\.\.\/api\/plexapi\.js"\)/);
    assert.match(compiledSource, /require\('\.\.\/lib\/settings\/index\.js'\)/);
    assert.doesNotMatch(compiledSource, /@server\//);
  });

  it('fails the build when an alias target is missing or escapes the output', async () => {
    const outputDirectory = await createOutputDirectory();
    await writeFile(
      path.join(outputDirectory, 'entry.js'),
      'require("@server/missing/module");'
    );

    await assert.rejects(
      rewriteServerAliases(outputDirectory),
      /Compiled server module for @server\/missing\/module was not found/
    );

    await writeFile(
      path.join(outputDirectory, 'entry.js'),
      'require("@server/../outside");'
    );
    await assert.rejects(
      rewriteServerAliases(outputDirectory),
      /Invalid compiled server module alias/
    );
  });

  it('accepts server output where aliases were already resolved', async () => {
    const outputDirectory = await createOutputDirectory();
    await writeFile(
      path.join(outputDirectory, 'entry.js'),
      'module.exports = 1;'
    );

    assert.strictEqual(await rewriteServerAliases(outputDirectory), 0);
  });
});
