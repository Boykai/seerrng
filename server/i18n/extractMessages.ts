import { promises as fs } from 'fs';
import { join } from 'path';
// Standalone extraction does not install application alias hooks.
// eslint-disable-next-line no-relative-import-paths/no-relative-import-paths
import { extractCatalogue } from '../../bin/extract-messages-lib';

async function getFiles(dir: string): Promise<string[]> {
  const entries = (await fs.readdir(dir, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name)
  );
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? getFiles(path) : [path];
    })
  );
  return files.flat();
}

async function saveMessages() {
  const targets = [
    { dir: './src/', output: './src/i18n/locale/en.json' },
    { dir: './server/', output: './server/i18n/locale/en.json' },
  ];
  // Validate both catalogues before changing either output.
  const catalogues = [];
  for (const target of targets) {
    const files = (await getFiles(target.dir)).filter(
      (file) => /\.tsx?$/.test(file) && !/\.(test|spec|d)\.tsx?$/.test(file)
    );
    catalogues.push({
      ...target,
      content: extractCatalogue(files, process.cwd()),
    });
  }
  for (const { output, content } of catalogues)
    await fs.writeFile(output, content);
}

saveMessages().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exitCode = 1;
});
