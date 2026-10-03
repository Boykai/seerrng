import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_PATH = 'packaging/yunohost';
const APP_BRANCH = 'main';
const PACKAGE_BRANCH = 'testing';
const GENERATED_README = 'README.md';
const DEFAULT_PACKAGE_ORIGIN =
  'https://github.com/YunoHost-Apps/seerrng_ynh.git';

const git = (repo, args, { allowFailure = false, binary = false } = {}) => {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: binary ? null : 'utf8',
    windowsHide: true,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0 && !allowFailure) {
    const details = binary ? result.stderr?.toString() : result.stderr;
    throw new Error(
      `git ${args.join(' ')} failed in ${repo}: ${details?.trim() || result.status}`
    );
  }

  return result;
};

const gitOutput = (repo, args, options) =>
  git(repo, args, options).stdout.toString().trim();

const normalizeOrigin = (origin) =>
  origin
    .replace(/\/+$/u, '')
    .replace(/\.git$/u, '')
    .toLowerCase();

const clonePackageRepository = (destination) => {
  const result = spawnSync(
    'git',
    [
      'clone',
      '--branch',
      PACKAGE_BRANCH,
      '--single-branch',
      DEFAULT_PACKAGE_ORIGIN,
      destination,
    ],
    { encoding: 'utf8', windowsHide: true }
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `Could not clone ${DEFAULT_PACKAGE_ORIGIN}: ${result.stderr?.trim() || result.status}`
    );
  }
};

const trackedFiles = (repo) =>
  gitOutput(repo, ['ls-files', '-z'], { binary: true })
    .split('\0')
    .filter(Boolean);

const changedPackagePaths = (repo, commit) => {
  const parents = gitOutput(repo, ['rev-list', '--parents', '-n', '1', commit])
    .split(' ')
    .slice(1);
  const parent = parents[0];
  const args = parent
    ? ['diff', '--name-only', '-z', parent, commit, '--', PACKAGE_PATH]
    : ['ls-tree', '-r', '--name-only', '-z', commit, '--', PACKAGE_PATH];

  return gitOutput(repo, args, { binary: true }).split('\0').filter(Boolean);
};

const committedPackageFiles = (repo, commit) => {
  const records = gitOutput(repo, [
    'ls-tree',
    '-r',
    '-z',
    commit,
    '--',
    `${PACKAGE_PATH}/`,
  ])
    .split('\0')
    .filter(Boolean);

  return records
    .map((record) => {
      const separator = record.indexOf('\t');
      const [mode, objectType, objectId] = record
        .slice(0, separator)
        .split(' ');
      const file = record.slice(separator + 1);

      if (!file.startsWith(`${PACKAGE_PATH}/`)) {
        throw new Error(`Unexpected package source path: ${file}`);
      }
      if (objectType !== 'blob' || !['100644', '100755'].includes(mode)) {
        throw new Error(
          `Unsupported YunoHost package file mode ${mode}: ${file}`
        );
      }

      return { mode, objectId, file };
    })
    .filter(({ file }) => file !== `${PACKAGE_PATH}/${GENERATED_README}`)
    .map(({ mode, objectId, file }) => {
      return {
        path: file.slice(PACKAGE_PATH.length + 1),
        mode,
        contents: git(repo, ['cat-file', 'blob', objectId], {
          binary: true,
        }).stdout,
      };
    });
};

const assertClean = (repo) => {
  const status = gitOutput(repo, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all',
  ]);

  if (status) {
    throw new Error(`YunoHost package checkout is not clean:\n${status}`);
  }
};

const safeDestination = (repo, relativePath) => {
  const destination = path.resolve(repo, relativePath);
  const repoPath = path.resolve(repo);

  if (!destination.startsWith(`${repoPath}${path.sep}`)) {
    throw new Error(`Refusing package path outside checkout: ${relativePath}`);
  }

  return destination;
};

const mirrorPackageFiles = async (sourceFiles, packageRepo) => {
  const desiredPaths = new Set(sourceFiles.map(({ path: file }) => file));
  const existingPaths = trackedFiles(packageRepo);

  for (const file of existingPaths) {
    if (file !== GENERATED_README && !desiredPaths.has(file)) {
      await fs.rm(safeDestination(packageRepo, file), { force: true });
    }
  }

  for (const { path: file, mode, contents } of sourceFiles) {
    const destination = safeDestination(packageRepo, file);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, contents);
    await fs.chmod(destination, mode === '100755' ? 0o755 : 0o644);
  }
};

const syncYunohostPackage = async ({
  sourceRepo,
  packageRepo,
  expectedOrigin = DEFAULT_PACKAGE_ORIGIN,
  commit,
  syncAll = false,
}) => {
  const appBranch = gitOutput(sourceRepo, ['branch', '--show-current']);
  if (appBranch !== APP_BRANCH) {
    console.log(
      `YunoHost package sync skipped: SeerrNG branch is ${appBranch || 'detached'}, not ${APP_BRANCH}.`
    );
    return { skipped: true, reason: 'wrong-app-branch' };
  }

  const sourceCommit = commit ?? gitOutput(sourceRepo, ['rev-parse', 'HEAD']);
  if (!syncAll && changedPackagePaths(sourceRepo, sourceCommit).length === 0) {
    console.log(
      `YunoHost package sync skipped: ${sourceCommit.slice(0, 12)} did not change ${PACKAGE_PATH}.`
    );
    return { skipped: true, reason: 'no-package-changes' };
  }

  const packageRoot = gitOutput(packageRepo, ['rev-parse', '--show-toplevel']);
  if (path.resolve(packageRoot) !== path.resolve(packageRepo)) {
    throw new Error(
      `YunoHost package path must be a repository root: ${packageRepo}`
    );
  }

  const packageBranch = gitOutput(packageRepo, ['branch', '--show-current']);
  if (packageBranch !== PACKAGE_BRANCH) {
    throw new Error(
      `YunoHost package checkout is on ${packageBranch || 'detached'}; expected ${PACKAGE_BRANCH}.`
    );
  }

  const origin = gitOutput(packageRepo, ['remote', 'get-url', 'origin']);
  if (normalizeOrigin(origin) !== normalizeOrigin(expectedOrigin)) {
    throw new Error(
      `YunoHost package origin is ${origin}; expected ${expectedOrigin}.`
    );
  }

  assertClean(packageRepo);
  git(packageRepo, [
    'fetch',
    'origin',
    `refs/heads/${PACKAGE_BRANCH}:refs/remotes/origin/${PACKAGE_BRANCH}`,
    '--quiet',
  ]);

  const divergence = gitOutput(packageRepo, [
    'rev-list',
    '--left-right',
    '--count',
    `HEAD...origin/${PACKAGE_BRANCH}`,
  ])
    .split(/\s+/)
    .map(Number);
  const [localOnly, remoteOnly] = divergence;

  if (localOnly > 0) {
    throw new Error(
      `YunoHost ${PACKAGE_BRANCH} has ${localOnly} local-only commit(s); refusing to overwrite them.`
    );
  }

  if (remoteOnly > 0) {
    git(packageRepo, ['merge', '--ff-only', `origin/${PACKAGE_BRANCH}`]);
  }
  assertClean(packageRepo);

  const sourceFiles = committedPackageFiles(sourceRepo, sourceCommit);
  await mirrorPackageFiles(sourceFiles, packageRepo);
  git(packageRepo, ['add', '--all']);

  const staged = git(packageRepo, ['diff', '--cached', '--quiet'], {
    allowFailure: true,
  });
  if (staged.status === 0) {
    console.log('YunoHost package sync skipped: package files already match.');
    return { skipped: true, reason: 'already-synced' };
  }

  git(packageRepo, [
    'commit',
    '-m',
    `chore(yunohost): sync package from SeerrNG ${sourceCommit.slice(0, 12)}`,
  ]);
  git(packageRepo, ['push', 'origin', `HEAD:refs/heads/${PACKAGE_BRANCH}`]);

  console.log(
    `Synced ${sourceFiles.length} YunoHost package files from ${sourceCommit.slice(0, 12)} to origin/${PACKAGE_BRANCH}.`
  );
  return {
    skipped: false,
    commit: sourceCommit,
    fileCount: sourceFiles.length,
  };
};

const run = async () => {
  const sourceRepo = gitOutput(process.cwd(), ['rev-parse', '--show-toplevel']);
  const sourceBranch = gitOutput(sourceRepo, ['branch', '--show-current']);
  if (sourceBranch !== APP_BRANCH) {
    console.log(
      `YunoHost package sync skipped: SeerrNG branch is ${sourceBranch || 'detached'}, not ${APP_BRANCH}.`
    );
    return { skipped: true, reason: 'wrong-app-branch' };
  }

  const sourceCommit = gitOutput(sourceRepo, ['rev-parse', 'HEAD']);
  const syncAll = process.env.SEERRNG_SYNC_ALL === 'true';
  if (!syncAll && changedPackagePaths(sourceRepo, sourceCommit).length === 0) {
    console.log(
      `YunoHost package sync skipped: ${sourceCommit.slice(0, 12)} did not change ${PACKAGE_PATH}.`
    );
    return { skipped: true, reason: 'no-package-changes' };
  }

  const configuredPath = process.env.SEERRNG_YNH_REPO;
  const siblingPath = path.resolve(sourceRepo, '..', 'seerrng_ynh');
  let packageRepo = path.resolve(configuredPath ?? siblingPath);
  let temporaryRoot;

  try {
    if (!(await fs.stat(packageRepo).catch(() => null))) {
      if (configuredPath) {
        throw new Error(
          `YunoHost package checkout not found at ${packageRepo}. Remove SEERRNG_YNH_REPO to use the automatic temporary checkout.`
        );
      }

      temporaryRoot = await fs.mkdtemp(
        path.join(os.tmpdir(), 'seerrng-yunohost-sync-')
      );
      packageRepo = path.join(temporaryRoot, 'seerrng_ynh');
      clonePackageRepository(packageRepo);
    }

    return await syncYunohostPackage({
      sourceRepo,
      packageRepo,
      expectedOrigin:
        process.env.SEERRNG_YNH_EXPECTED_ORIGIN ?? DEFAULT_PACKAGE_ORIGIN,
      commit: sourceCommit,
      syncAll,
    });
  } finally {
    if (temporaryRoot) {
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  }
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  run().catch((error) => {
    console.error(`YunoHost package sync failed: ${error.message}`);
    process.exitCode = 1;
  });
}

export { syncYunohostPackage };
