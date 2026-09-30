import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const waiterPath = path.join(scriptsDirectory, 'wait-for-launchpad-ppa.py');

test('reports a published source through its stable self link', () => {
  const python = [
    'import contextlib',
    'import importlib.util',
    'import io',
    'import sys',
    'import types',
    'from datetime import datetime, timezone',
    'sys.dont_write_bytecode = True',
    '',
    'launchpadlib = types.ModuleType("launchpadlib")',
    'launchpadlib.__path__ = []',
    'launchpad_module = types.ModuleType("launchpadlib.launchpad")',
    'launchpad_module.Launchpad = object',
    'sys.modules["launchpadlib"] = launchpadlib',
    'sys.modules["launchpadlib.launchpad"] = launchpad_module',
    '',
    'spec = importlib.util.spec_from_file_location("waiter", sys.argv[1])',
    'waiter = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(waiter)',
    '',
    'source_link = "https://api.launchpad.net/1.0/+sourcepub/12345"',
    'binary = types.SimpleNamespace(',
    '    binary_package_name="seerrng",',
    '    status="Published",',
    '    web_link="https://launchpad.net/+binarypub/67890",',
    ')',
    'build = types.SimpleNamespace(',
    '    arch_tag="amd64",',
    '    buildstate="Successfully built",',
    ')',
    '',
    'class SourcePublication:',
    '    status = "Published"',
    '    date_created = datetime.now(timezone.utc)',
    '    self_link = source_link',
    '',
    '    def getBuilds(self):',
    '        return [build]',
    '',
    '    def getPublishedBinaries(self):',
    '        return [binary]',
    '',
    'class Archive:',
    '    def getPublishedSources(self, **kwargs):',
    '        return [SourcePublication()]',
    '',
    'archive = Archive()',
    'client = types.SimpleNamespace(',
    '    load=lambda archive_url: archive,',
    '    distributions={',
    '        "ubuntu": types.SimpleNamespace(',
    '            getSeries=lambda name_or_version: object()',
    '        )',
    '    },',
    ')',
    'waiter.create_launchpad_client = lambda: client',
    'sys.argv = [',
    '    waiter.__file__,',
    '    "--archive-url", "https://api.launchpad.net/1.0/~owner/+archive/ubuntu/seerrng",',
    '    "--archive-web", "https://launchpad.net/~owner/+archive/ubuntu/seerrng",',
    '    "--series", "jammy",',
    '    "--source-version", "3.41.1+ppa1",',
    '    "--timeout-minutes", "1",',
    ']',
    '',
    'output = io.StringIO()',
    'with contextlib.redirect_stdout(output):',
    '    status = waiter.main()',
    '',
    'assert status == 0, output.getvalue()',
    'assert source_link in output.getvalue(), output.getvalue()',
    'assert "Published binary:" in output.getvalue(), output.getvalue()',
  ].join('\n');
  const pythonCommand = process.platform === 'win32' ? 'python' : 'python3';
  const result = spawnSync(pythonCommand, ['-c', python, waiterPath], {
    encoding: 'utf8',
  });

  assert.equal(
    result.status,
    0,
    'Launchpad publication regression failed.\n' +
      result.stdout +
      '\n' +
      result.stderr
  );
});
