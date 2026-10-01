import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { syncYunohostPackage } from './sync-yunohost-package.mjs';

const temporaryDirectories = new Set();

const git = (repo, args) => {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });

  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${result.stderr.trim() || result.status}`
    );
  }

  return result.stdout.trim();
};

const commit = (repo, message) => {
  git(repo, ['add', '--all']);
  git(repo, [
    '-c',
    'user.name=Sync test',
    '-c',
    'user.email=sync-test@example.invalid',
    'commit',
    '-m',
    message,
  ]);
};

const fixture = async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), 'seerrng-yunohost-sync-')
  );
  temporaryDirectories.add(root);
  const sourceRepo = path.join(root, 'seerrng');
  const packageSeed = path.join(root, 'package-seed');
  const packageOrigin = path.join(root, 'seerrng_ynh.git');
  const packageRepo = path.join(root, 'seerrng_ynh');

  await fs.mkdir(sourceRepo);
  git(sourceRepo, ['init', '--initial-branch=main']);
  await fs.mkdir(path.join(sourceRepo, 'packaging/yunohost/conf'), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(sourceRepo, 'packaging/yunohost/manifest.toml'),
    'version = "1.0"\n'
  );
  await fs.writeFile(
    path.join(sourceRepo, 'packaging/yunohost/README.md'),
    '# Source package README\n'
  );
  await fs.writeFile(
    path.join(sourceRepo, 'packaging/yunohost/conf/nginx.conf'),
    'location /old { }\n'
  );
  await fs.mkdir(path.join(sourceRepo, 'packaging/yunohost/scripts'), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(sourceRepo, 'packaging/yunohost/scripts/install'),
    '#!/bin/sh\nexit 0\n'
  );
  await fs.chmod(
    path.join(sourceRepo, 'packaging/yunohost/scripts/install'),
    0o755
  );
  await fs.writeFile(path.join(sourceRepo, 'unrelated.txt'), 'keep\n');
  commit(sourceRepo, 'initial package');

  await fs.mkdir(packageSeed);
  git(packageSeed, ['init', '--initial-branch=testing']);
  await fs.mkdir(path.join(packageSeed, 'conf'), { recursive: true });
  await fs.writeFile(
    path.join(packageSeed, 'README.md'),
    '# Generated README\n'
  );
  await fs.writeFile(
    path.join(packageSeed, 'manifest.toml'),
    'version = "0.9"\n'
  );
  await fs.writeFile(
    path.join(packageSeed, 'conf/nginx.conf'),
    'location /old { }\n'
  );
  await fs.mkdir(path.join(packageSeed, 'scripts'), { recursive: true });
  await fs.writeFile(
    path.join(packageSeed, 'scripts/install'),
    '#!/bin/sh\nexit 1\n'
  );
  await fs.chmod(path.join(packageSeed, 'scripts/install'), 0o755);
  await fs.writeFile(path.join(packageSeed, 'obsolete.txt'), 'remove me\n');
  commit(packageSeed, 'seed YunoHost package');

  git(root, ['clone', '--bare', packageSeed, packageOrigin]);
  git(root, ['clone', '--branch', 'testing', packageOrigin, packageRepo]);
  git(packageRepo, ['config', 'user.name', 'Sync test']);
  git(packageRepo, ['config', 'user.email', 'sync-test@example.invalid']);

  await fs.writeFile(
    path.join(sourceRepo, 'packaging/yunohost/manifest.toml'),
    'version = "2.0"\n'
  );
  await fs.rm(path.join(sourceRepo, 'packaging/yunohost/conf/nginx.conf'));
  await fs.mkdir(path.join(sourceRepo, 'packaging/yunohost/doc'), {
    recursive: true,
  });
  await fs.writeFile(
    path.join(sourceRepo, 'packaging/yunohost/doc/ADMIN.md'),
    '# Admin\n'
  );
  await fs.writeFile(
    path.join(sourceRepo, 'packaging/yunohost/scripts/install'),
    '#!/bin/sh\nexit 1\n'
  );
  commit(sourceRepo, 'update package');

  return { sourceRepo, packageOrigin, packageRepo };
};

afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) =>
      fs.rm(directory, { recursive: true, force: true })
    )
  );
  temporaryDirectories.clear();
});

describe('YunoHost package post-commit sync', () => {
  it('mirrors committed package files, preserves the generated README, and pushes testing', async () => {
    const { sourceRepo, packageOrigin, packageRepo } = await fixture();

    const result = await syncYunohostPackage({
      sourceRepo,
      packageRepo,
      expectedOrigin: packageOrigin,
    });

    assert.equal(result.skipped, false);
    assert.equal(
      await fs.readFile(path.join(packageRepo, 'manifest.toml'), 'utf8'),
      'version = "2.0"\n'
    );
    assert.equal(
      await fs.readFile(path.join(packageRepo, 'README.md'), 'utf8'),
      '# Generated README\n'
    );
    assert.equal(
      await fs.readFile(path.join(packageRepo, 'doc/ADMIN.md'), 'utf8'),
      '# Admin\n'
    );
    assert.equal(
      (await fs.stat(path.join(packageRepo, 'scripts/install'))).mode & 0o111,
      0o111
    );
    await assert.rejects(fs.stat(path.join(packageRepo, 'obsolete.txt')));
    assert.equal(git(packageRepo, ['branch', '--show-current']), 'testing');
    assert.match(git(packageRepo, ['status', '--porcelain']), /^$/);
    assert.equal(
      git(packageOrigin, ['show', 'refs/heads/testing:manifest.toml']),
      'version = "2.0"'
    );
  });

  it('refuses to change a dirty or wrong-branch package checkout', async () => {
    const dirty = await fixture();
    await fs.writeFile(
      path.join(dirty.packageRepo, 'README.md'),
      'local edit\n'
    );
    await assert.rejects(
      syncYunohostPackage({
        sourceRepo: dirty.sourceRepo,
        packageRepo: dirty.packageRepo,
        expectedOrigin: dirty.packageOrigin,
      }),
      /not clean/
    );

    const wrongBranch = await fixture();
    git(wrongBranch.packageRepo, ['switch', '-c', 'main']);
    await assert.rejects(
      syncYunohostPackage({
        sourceRepo: wrongBranch.sourceRepo,
        packageRepo: wrongBranch.packageRepo,
        expectedOrigin: wrongBranch.packageOrigin,
      }),
      /expected testing/
    );
  });
});
