import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const listJavaScriptFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return listJavaScriptFiles(entryPath);
      }
      return entry.isFile() && entry.name.endsWith('.js') ? [entryPath] : [];
    })
  );

  return nested.flat();
};

const getCompiledModulePath = async (outputDirectory, aliasTarget) => {
  if (
    !aliasTarget ||
    aliasTarget.includes('\\') ||
    aliasTarget.split('/').some((part) => part === '.' || part === '..')
  ) {
    throw new Error(`Invalid compiled server module alias: ${aliasTarget}`);
  }

  const basePath = path.resolve(outputDirectory, aliasTarget);
  const candidates = path.extname(basePath)
    ? [basePath]
    : [
        `${basePath}.js`,
        `${basePath}.json`,
        path.join(basePath, 'index.js'),
        path.join(basePath, 'index.json'),
      ];

  for (const candidate of candidates) {
    const relativePath = path.relative(outputDirectory, candidate);
    if (
      relativePath.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relativePath)
    ) {
      continue;
    }

    try {
      if ((await stat(candidate)).isFile()) {
        return candidate;
      }
    } catch {
      // Try the next standard Node module resolution candidate.
    }
  }

  throw new Error(
    `Compiled server module for @server/${aliasTarget} was not found.`
  );
};

export const rewriteServerAliases = async (outputDirectory) => {
  const absoluteOutputDirectory = path.resolve(outputDirectory);
  const files = await listJavaScriptFiles(absoluteOutputDirectory);
  let replacements = 0;

  for (const filePath of files) {
    const source = await readFile(filePath, 'utf8');
    const rewritten = await replaceAliasesInSource(
      source,
      filePath,
      absoluteOutputDirectory,
      (count) => {
        replacements += count;
      }
    );

    if (rewritten !== source) {
      await writeFile(filePath, rewritten);
    }
  }

  return replacements;
};

const replaceAliasesInSource = async (
  source,
  filePath,
  outputDirectory,
  onReplace
) => {
  let replacements = 0;
  const rewritten = await Promise.all(
    source.split(/(["'])@server\/([^"'\r\n]+)\1/g).map(async (part, index) => {
      // The split captures quote and path separately. Path captures are at
      // every third position after the initial source fragment.
      if (index % 3 !== 2) {
        return part;
      }

      const target = await getCompiledModulePath(outputDirectory, part);
      let relativeTarget = path
        .relative(path.dirname(filePath), target)
        .split(path.sep)
        .join('/');
      if (!relativeTarget.startsWith('.')) {
        relativeTarget = `./${relativeTarget}`;
      }
      replacements += 1;
      return relativeTarget;
    })
  );

  onReplace(replacements);

  // Reassemble the captured quote and path groups as import specifiers.
  let result = '';
  for (let index = 0; index < rewritten.length; index += 3) {
    result += rewritten[index] ?? '';
    if (index + 2 < rewritten.length) {
      result += `${rewritten[index + 1]}${rewritten[index + 2]}${rewritten[index + 1]}`;
    }
  }

  return result;
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const outputDirectory = process.argv[2] ?? 'dist';
  try {
    const replacements = await rewriteServerAliases(outputDirectory);
    console.log(
      replacements > 0
        ? `Rewrote ${replacements} compiled @server import(s).`
        : 'Compiled server imports were already resolved.'
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
