import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_MANIFEST = 'packaging/yunohost/manifest.toml';
const RELEASE_PATTERN = /^v(\d+\.\d+\.\d+(?:\.\d+)?)$/u;
const ARCHITECTURES = [
  { key: 'amd64', assetSuffix: 'linux-x64' },
  { key: 'arm64', assetSuffix: 'linux-arm64' },
];

const parseArgs = (args) => {
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--tag' || argument === '--assets-dir') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${argument}.`);
      }
      options[argument.slice(2)] = value;
      index += 1;
      continue;
    }

    throw new Error(`Unexpected argument: ${argument}`);
  }

  if (!options.tag || !options['assets-dir']) {
    throw new Error(
      'Usage: update-yunohost-release.mjs --tag <release-tag> --assets-dir <directory>'
    );
  }

  return { tag: options.tag, assetsDirectory: options['assets-dir'] };
};

const compareVersions = (left, right) => {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  const partCount = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < partCount; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return Math.sign(difference);
    }
  }

  return 0;
};

const replaceUniqueLine = (contents, expression, replacement, label) => {
  const globalExpression = new RegExp(
    expression.source,
    expression.flags.includes('g') ? expression.flags : `${expression.flags}g`
  );
  const matches = [...contents.matchAll(globalExpression)];
  if (matches.length !== 1) {
    throw new Error(
      `Expected one ${label} entry in the YunoHost manifest; found ${matches.length}.`
    );
  }

  return contents.replace(expression, replacement);
};

const fileSha256 = async (filename) =>
  createHash('sha256')
    .update(await fs.readFile(filename))
    .digest('hex');

const verifyReleaseAsset = async (assetsDirectory, tag, suffix) => {
  const name = `seerrng-${tag}-${suffix}.tar.gz`;
  const archivePath = path.join(assetsDirectory, name);
  const checksumPath = path.join(
    assetsDirectory,
    `seerrng-${tag}-${suffix}.sha256`
  );
  const actualChecksum = await fileSha256(archivePath);
  const checksumContent = (await fs.readFile(checksumPath, 'utf8')).trim();
  const [declaredChecksum, declaredName] = checksumContent.split(/\s+/u);

  if (!/^[a-f\d]{64}$/iu.test(declaredChecksum ?? '')) {
    throw new Error(`Invalid SHA-256 sidecar for ${name}.`);
  }
  if (declaredName && declaredName.replace(/^\*/u, '') !== name) {
    throw new Error(`Unexpected filename in the SHA-256 sidecar for ${name}.`);
  }
  if (declaredChecksum.toLowerCase() !== actualChecksum) {
    throw new Error(`SHA-256 sidecar does not match ${name}.`);
  }

  return { name, checksum: actualChecksum };
};

const updateYunohostRelease = async ({
  manifestPath = DEFAULT_MANIFEST,
  tag,
  assetsDirectory,
}) => {
  const releaseMatch = tag.match(RELEASE_PATTERN);
  if (!releaseMatch) {
    console.log(`Skipping YunoHost release update for non-stable tag ${tag}.`);
    return { updated: false, reason: 'non-stable-release' };
  }

  const releaseVersion = releaseMatch[1];
  let manifest = await fs.readFile(manifestPath, 'utf8');
  const currentVersionMatch = manifest.match(/^version = "([^"]+)"$/mu);
  if (!currentVersionMatch) {
    throw new Error(
      'Could not read the YunoHost package version from the manifest.'
    );
  }

  const currentVersion = currentVersionMatch[1];
  const currentPackageVersion = currentVersion.match(
    /^(\d+\.\d+\.\d+(?:\.\d+)?)(?:~ynh(\d+))?$/u
  );
  if (!currentPackageVersion) {
    throw new Error(`Unsupported YunoHost package version: ${currentVersion}.`);
  }

  const order = compareVersions(releaseVersion, currentPackageVersion[1]);
  if (order < 0) {
    console.log(
      `Skipping older YunoHost release ${tag}; the manifest already targets ${currentPackageVersion[1]}.`
    );
    return { updated: false, reason: 'older-release' };
  }

  const ynhRevision = order === 0 ? (currentPackageVersion[2] ?? '1') : '1';
  const packageVersion = `${releaseVersion}~ynh${ynhRevision}`;
  const assets = new Map();
  for (const architecture of ARCHITECTURES) {
    assets.set(
      architecture.key,
      await verifyReleaseAsset(assetsDirectory, tag, architecture.assetSuffix)
    );
  }

  manifest = replaceUniqueLine(
    manifest,
    /^version = "[^"]+"$/mu,
    `version = "${packageVersion}"`,
    'package version'
  );

  for (const architecture of ARCHITECTURES) {
    const asset = assets.get(architecture.key);
    const url = `https://github.com/snapetech/seerrng/releases/download/${tag}/${asset.name}`;
    manifest = replaceUniqueLine(
      manifest,
      new RegExp(`^    ${architecture.key}\\.url = "[^"]+"$`, 'mu'),
      `    ${architecture.key}.url = "${url}"`,
      `${architecture.key} archive URL`
    );
    manifest = replaceUniqueLine(
      manifest,
      new RegExp(`^    ${architecture.key}\\.sha256 = "[^"]+"$`, 'mu'),
      `    ${architecture.key}.sha256 = "${asset.checksum}"`,
      `${architecture.key} archive checksum`
    );
  }

  await fs.writeFile(manifestPath, manifest);
  console.log(
    `Updated the YunoHost manifest to ${packageVersion} from ${tag} release archives.`
  );
  return { updated: true, version: packageVersion };
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await updateYunohostRelease({ ...parseArgs(process.argv.slice(2)) });
  } catch (error) {
    console.error(`YunoHost release update failed: ${error.message}`);
    process.exitCode = 1;
  }
}

export { updateYunohostRelease };
