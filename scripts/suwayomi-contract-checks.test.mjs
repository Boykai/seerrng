import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import test from 'node:test';
import { crc32, inflateSync } from 'node:zlib';

import { CLEANUP_TIMEOUT_MS, UsageError } from './manga-migration-checks.mjs';
import {
  containerRemoveArguments,
  CONTRACT_TEST,
  contractTestEnvironment,
  createPng,
  createStoredZip,
  DATA_DIRECTORY,
  defaultRun,
  DOWNLOAD_DIRECTORY,
  DOWNLOADED_CHAPTER,
  FIXTURE_TITLE,
  fixtureArchive,
  fixtureDescription,
  fixtureFiles,
  fixtureWriteArguments,
  FORWARDER_IMAGE,
  FORWARDER_SCRIPT,
  forwarderRoutes,
  forwarderRunArguments,
  LOCAL_SOURCE_DIRECTORY,
  networkCreateArguments,
  networkRemoveArguments,
  parseArguments,
  parseLoopbackPort,
  PENDING_CHAPTER,
  probeSuwayomi,
  READY_TIMEOUT_MS,
  redactLog,
  REFRESH_EXPIRY_SECONDS,
  runContractChecks,
  SUWAYOMI_IMAGE,
  SUWAYOMI_INSTANCES,
  SUWAYOMI_USERNAME,
  suwayomiRunArguments,
  TOKEN_EXPIRY_SECONDS,
} from './suwayomi-contract-checks.mjs';

const PASSWORDS = ['fixture-main/+=', 'fixture-basic/+=', 'fixture-simple/+='];
const NETWORK = 'seerrng-suwayomi-contract-fixture';
const EDGE = `${NETWORK}-edge`;
const FORWARDER = `${NETWORK}-forwarder`;
const CONTAINERS = ['main', 'basic', 'simple', 'none'].map(
  (key) => `${NETWORK}-${key}`
);
// A documentation address (RFC 5737), as a container log might show one.
const ADDRESS = '192.0.2.10';
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// `interruptWhen` returns a signal to send while a command runs. The fake
// exit only records the status; `timeline` shows the order of logs, calls,
// removals and exits.
const fakeDependencies = ({
  env = { GITHUB_ACTIONS: 'true', PATH: 'path-fixture' },
  failWhen = () => false,
  probeFailures = 0,
  stopped,
  interruptWhen = () => undefined,
} = {}) => {
  const calls = [];
  const logs = [];
  const timeline = [];
  const handlers = [];
  let listener;
  let passwords = 0;
  let probes = 0;
  let waits = 0;
  let now = 0;

  return {
    calls,
    logs,
    timeline,
    handlersDone: () => Promise.all(handlers),
    get listening() {
      return listener !== undefined;
    },
    get waits() {
      return waits;
    },
    dependencies: {
      env,
      log: (message) => {
        logs.push(message);
        timeline.push(`log ${message}`);
      },
      createPassword: () => PASSWORDS[passwords++],
      createRunId: () => 'fixture',
      makeConfigDirectory: () => 'config-fixture',
      removeConfigDirectory: (directory) =>
        timeline.push(`remove ${directory}`),
      probe: async () => {
        probes += 1;
        return probes > probeFailures;
      },
      now: () => now,
      wait: async () => {
        waits += 1;
        now += 2000;
      },
      onInterrupt: (handler) => {
        listener = handler;
        return () => {
          listener = undefined;
        };
      },
      exit: (code) => timeline.push(`exit ${code}`),
      run: (command, args, options = {}) => {
        calls.push({ command, args, ...options });
        timeline.push(`run ${[command, ...args].join(' ')}`);
        const signal = interruptWhen(command, args);
        if (signal) {
          handlers.push(listener(signal));
        }
        if (failWhen(command, args)) {
          return {
            status: 3,
            stdout: '',
            stderr: `fixture failure ${PASSWORDS[1]} at ${ADDRESS}\n`,
          };
        }
        if (command === 'docker' && args[0] === 'inspect') {
          return {
            status: 0,
            stdout: args.at(-1) === stopped ? 'false\n' : 'true\n',
            stderr: '',
          };
        }
        if (command === 'docker' && args[0] === 'port') {
          const [port] = args[2].split('/');
          return { status: 0, stdout: `127.0.0.1:5${port}\n`, stderr: '' };
        }
        if (command === 'docker' && args[0] === 'logs') {
          return {
            status: 0,
            stdout: `login as ${PASSWORDS[0]} from ${ADDRESS}`,
            stderr: '',
          };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    },
  };
};

const dockerCalls = (fake, verb) =>
  fake.calls.filter(
    (call) => call.command === 'docker' && call.args[0] === verb
  );

const isRemoval = ({ args }) =>
  args[0] === 'rm' || (args[0] === 'network' && args[1] === 'rm');

const removals = [
  containerRemoveArguments(FORWARDER),
  ...[...CONTAINERS].reverse().map(containerRemoveArguments),
  networkRemoveArguments(EDGE),
  networkRemoveArguments(NETWORK),
];

const removalCalls = (fake) =>
  fake.calls.filter(isRemoval).map((call) => call.args);

// Runs the harness with a fake docker in a child process whose stdout has no
// reader, as after a closed terminal, so every write to it fails. A hangup
// arrives while the run waits for Suwayomi. The child records each command
// and removal on stderr.
const CLOSED_OUTPUT_SCRIPT = [
  "import { writeSync } from 'node:fs';",
  `import { ignoreOutputErrors, runContractChecks } from ${JSON.stringify(
    new URL('./suwayomi-contract-checks.mjs', import.meta.url).href
  )};`,
  "const record = (entry) => writeSync(2, 'record ' + JSON.stringify(entry) + '\\n');",
  "if (process.argv[1] === 'guarded') ignoreOutputErrors();",
  'await runContractChecks({',
  '  env: {},',
  "  log: (message) => process.stdout.write(message + '\\n'),",
  "  createPassword: () => 'fixture-password',",
  "  createRunId: () => 'fixture',",
  "  makeConfigDirectory: () => 'config-fixture',",
  '  removeConfigDirectory: (directory) => record({ directory }),',
  '  probe: async () => false,',
  '  now: () => 0,',
  "  wait: () => new Promise(() => setImmediate(() => process.emit('SIGHUP', 'SIGHUP'))),",
  '  onInterrupt: (listener) => {',
  "    process.on('SIGHUP', listener);",
  "    return () => process.off('SIGHUP', listener);",
  '  },',
  '  exit: (code) => process.exit(code),',
  '  run: (command, args) => {',
  '    record({ command, args });',
  "    const stdout = { inspect: 'true\\n', port: '127.0.0.1:54001\\n' }[args[0]] ?? '';",
  "    return { status: 0, stdout, stderr: '' };",
  '  },',
  '});',
].join('\n');

const runWithClosedOutput = (mode) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', CLOSED_OUTPUT_SCRIPT, mode],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, windowsHide: true }
    );
    child.stdout.destroy();
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (status) => {
      const records = stderr
        .split('\n')
        .filter((line) => line.startsWith('record '))
        .map((line) => JSON.parse(line.slice('record '.length)));
      resolve({
        status,
        removed: records.filter(
          (entry) => entry.directory !== undefined || isRemoval(entry)
        ),
      });
    });
  });

const readPng = (png) => {
  assert.deepEqual(png.subarray(0, 8), PNG_SIGNATURE);
  const chunks = [];
  for (let cursor = 8; cursor < png.length;) {
    const length = png.readUInt32BE(cursor);
    const typed = png.subarray(cursor + 4, cursor + 8 + length);
    assert.equal(png.readUInt32BE(cursor + 8 + length), crc32(typed));
    chunks.push({
      type: typed.subarray(0, 4).toString('latin1'),
      data: typed.subarray(4),
    });
    cursor += 12 + length;
  }
  return chunks;
};

const readZip = (archive) => {
  const end = archive.length - 22;
  assert.equal(archive.readUInt32LE(end), 0x06054b50);
  const count = archive.readUInt16LE(end + 10);
  const directoryOffset = archive.readUInt32LE(end + 16);
  assert.equal(directoryOffset + archive.readUInt32LE(end + 12), end);
  const entries = [];
  for (let index = 0, cursor = directoryOffset; index < count; index += 1) {
    assert.equal(archive.readUInt32LE(cursor), 0x02014b50);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const local = archive.readUInt32LE(cursor + 42);
    assert.equal(archive.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + archive.readUInt16LE(local + 26);
    entries.push({
      name: archive
        .subarray(cursor + 46, cursor + 46 + nameLength)
        .toString('utf8'),
      flags: archive.readUInt16LE(cursor + 8),
      method: archive.readUInt16LE(cursor + 10),
      checksum: archive.readUInt32LE(cursor + 16),
      bytes: archive.subarray(start, start + archive.readUInt32LE(cursor + 20)),
    });
    cursor += 46 + nameLength;
  }
  return entries;
};

test('parseArguments accepts no arguments', () => {
  assert.deepStrictEqual(parseArguments([]), {});
  assert.throws(() => parseArguments(['--keep']), UsageError);
});

test('both images are pinned by digest', () => {
  assert.match(
    SUWAYOMI_IMAGE,
    /^ghcr\.io\/suwayomi\/suwayomi-server:v2\.4\.2366@sha256:[0-9a-f]{64}$/
  );
  assert.match(FORWARDER_IMAGE, /^node:[\w.-]+@sha256:[0-9a-f]{64}$/);
});

test('Suwayomi runs hardened on its network with no password argument', () => {
  const [main, , , none] = SUWAYOMI_INSTANCES;
  const args = suwayomiRunArguments('suwayomi', 'internal', main);
  assert.equal(args.at(-1), SUWAYOMI_IMAGE);
  assert.equal(args[args.indexOf('--network') + 1], 'internal');
  assert.ok(!args.includes('--publish'));
  for (const expected of [
    'ALL',
    'no-new-privileges',
    'WEB_UI_ENABLED=false',
    'AUTH_MODE=ui_login',
    `AUTH_USERNAME=${SUWAYOMI_USERNAME}`,
    'AUTH_PASSWORD',
    'DOWNLOAD_AS_CBZ=true',
    `JWT_TOKEN_EXPIRY=${TOKEN_EXPIRY_SECONDS}s`,
    `JWT_REFRESH_EXPIRY=${REFRESH_EXPIRY_SECONDS}s`,
  ]) {
    assert.ok(args.includes(expected), expected);
  }
  assert.ok(!args.some((arg) => arg.startsWith('AUTH_PASSWORD=')));

  const open = suwayomiRunArguments('suwayomi', 'internal', none);
  assert.ok(open.includes('AUTH_MODE=none'));
  assert.ok(!open.includes('AUTH_PASSWORD'));
  assert.ok(!open.some((arg) => arg.startsWith('AUTH_USERNAME')));
});

test('the forwarder publishes each instance on 127.0.0.1 only', () => {
  const instances = [
    { listenPort: 4001, containerName: 'first' },
    { listenPort: 4002, containerName: 'second' },
  ];
  assert.equal(forwarderRoutes(instances), '4001:first:4567,4002:second:4567');

  const args = forwarderRunArguments('forwarder', 'edge', instances);
  const published = args.flatMap((arg, index) =>
    args[index - 1] === '--publish' ? [arg] : []
  );
  assert.deepStrictEqual(published, ['127.0.0.1::4001', '127.0.0.1::4002']);
  assert.equal(args[args.indexOf('--network') + 1], 'edge');
  assert.equal(args[args.indexOf('--user') + 1], 'node');
  assert.ok(args.includes('--read-only'));
  assert.ok(args.includes(`FORWARD_ROUTES=${forwarderRoutes(instances)}`));
  assert.deepStrictEqual(args.slice(-4), [
    FORWARDER_IMAGE,
    'node',
    '-e',
    FORWARDER_SCRIPT,
  ]);
});

test('a fixture path reaches the container as an argument, not as shell text', () => {
  const file = {
    path: `${DATA_DIRECTORY}/a "$(b)"/c.png`,
    bytes: Buffer.alloc(1),
  };
  const args = fixtureWriteArguments('suwayomi', file);
  assert.deepStrictEqual(args.slice(0, 3), [
    'exec',
    '--interactive',
    'suwayomi',
  ]);
  assert.equal(args.at(-1), file.path);
  assert.ok(!args.slice(0, -1).some((arg) => arg.includes('$(b)')));
});

test('parseLoopbackPort accepts loopback mappings only', () => {
  assert.equal(parseLoopbackPort('127.0.0.1:49153\n'), 49153);
  for (const output of [
    '',
    '0.0.0.0:49153',
    '127.0.0.1:49153\n[::]:49153',
    '127.0.0.1:not-a-port',
  ]) {
    assert.throws(() => parseLoopbackPort(output), /127\.0\.0\.1 only/);
  }
});

test('createPng writes a valid solid-colour image', () => {
  const chunks = readPng(createPng(2, 3, [10, 20, 30]));
  assert.deepStrictEqual(
    chunks.map(({ type }) => type),
    ['IHDR', 'IDAT', 'IEND']
  );
  const [header, data] = chunks;
  assert.equal(header.data.readUInt32BE(0), 2);
  assert.equal(header.data.readUInt32BE(4), 3);
  const row = Buffer.from([0, 10, 20, 30, 10, 20, 30]);
  assert.deepEqual(inflateSync(data.data), Buffer.concat([row, row, row]));
});

test('createStoredZip writes an uncompressed archive with UTF-8 names', () => {
  const entries = [
    { name: 'página 1.png', bytes: Buffer.from('first') },
    { name: '002.png', bytes: Buffer.from('second') },
  ];
  const archive = createStoredZip(entries);
  const read = readZip(archive);
  assert.deepStrictEqual(
    read.map(({ name, bytes }) => ({ name, bytes: bytes.toString() })),
    [
      { name: 'página 1.png', bytes: 'first' },
      { name: '002.png', bytes: 'second' },
    ]
  );
  for (const entry of read) {
    assert.equal(entry.method, 0);
    assert.equal(entry.flags & 0x0800, 0x0800);
    assert.equal(entry.checksum, crc32(entry.bytes));
  }
  assert.deepEqual(createStoredZip(entries), archive);
});

test('the fixture is generated the same way every run and described by its hashes', () => {
  const files = fixtureFiles();
  for (const file of files) {
    assert.ok(file.path.startsWith(`${DATA_DIRECTORY}/`), file.path);
    assert.ok(!file.path.split('/').includes('..'), file.path);
  }
  const manga = `${LOCAL_SOURCE_DIRECTORY}/${FIXTURE_TITLE}`;
  const byPath = new Map(files.map((file) => [file.path, file.bytes]));
  const cover = byPath.get(`${manga}/cover.png`);
  const archive = byPath.get(
    `${DOWNLOAD_DIRECTORY}/${FIXTURE_TITLE}/${DOWNLOADED_CHAPTER}.cbz`
  );
  assert.ok(byPath.has(`${manga}/${DOWNLOADED_CHAPTER}/001.png`));
  assert.ok(byPath.has(`${manga}/${PENDING_CHAPTER}/001.png`));
  assert.deepEqual(archive, fixtureArchive());
  assert.deepEqual(
    readZip(archive).map(({ name }) => name),
    ['001.png', '002.png']
  );
  for (const { bytes } of readZip(archive)) {
    readPng(bytes);
  }

  assert.deepStrictEqual(fixtureDescription(), {
    title: FIXTURE_TITLE,
    downloadedChapter: DOWNLOADED_CHAPTER,
    pendingChapter: PENDING_CHAPTER,
    archiveBytes: archive.length,
    archiveSha256: sha256(archive),
    coverSha256: sha256(cover),
  });
  assert.deepEqual(
    fixtureFiles().map(({ bytes }) => sha256(bytes)),
    files.map(({ bytes }) => sha256(bytes))
  );
});

test('contractTestEnvironment passes the instances and keeps the network guard', () => {
  const baseEnv = {
    PATH: 'path-fixture',
    ALLOW_NETWORK: 'true',
    SEERR_TEST_SUWAYOMI_STALE_URL: 'http://stale.invalid',
  };
  const env = contractTestEnvironment({
    baseEnv,
    configDirectory: 'config-fixture',
    instances: [
      { key: 'MAIN', url: 'http://127.0.0.1:54001', password: PASSWORDS[0] },
      { key: 'NONE', url: 'http://127.0.0.1:54004', password: undefined },
    ],
  });

  assert.deepStrictEqual(env, {
    PATH: 'path-fixture',
    CONFIG_DIRECTORY: 'config-fixture',
    SEERR_TEST_FAIL_ON_NETWORK: 'true',
    SEERR_TEST_SUWAYOMI_TOKEN_EXPIRY_SECONDS: String(TOKEN_EXPIRY_SECONDS),
    SEERR_TEST_SUWAYOMI_REFRESH_EXPIRY_SECONDS: String(REFRESH_EXPIRY_SECONDS),
    SEERR_TEST_SUWAYOMI_FIXTURE: JSON.stringify(fixtureDescription()),
    SEERR_TEST_SUWAYOMI_MAIN_URL: 'http://127.0.0.1:54001',
    SEERR_TEST_SUWAYOMI_MAIN_USERNAME: SUWAYOMI_USERNAME,
    SEERR_TEST_SUWAYOMI_MAIN_PASSWORD: PASSWORDS[0],
    SEERR_TEST_SUWAYOMI_NONE_URL: 'http://127.0.0.1:54004',
  });
  assert.equal(baseEnv.ALLOW_NETWORK, 'true');
});

test('redactLog removes the passwords and every IPv4 address', () => {
  assert.equal(
    redactLog(
      `login ${PASSWORDS[0]} from ${ADDRESS}:4567, again ${PASSWORDS[0]}`,
      [PASSWORDS[0]]
    ),
    'login *** from <address>:4567, again ***'
  );
});

test('probeSuwayomi treats any answer below 500 as ready', async () => {
  const statuses = [401, 200, 503];
  const seen = [];
  const server = createServer((request, response) => {
    seen.push(
      `${request.method} ${request.url} ${request.headers.authorization}`
    );
    response.writeHead(statuses.shift() ?? 500).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(await probeSuwayomi(url), true);
    assert.equal(await probeSuwayomi(url), true);
    assert.equal(await probeSuwayomi(url), false);
    assert.deepStrictEqual(seen, Array(3).fill('POST /api/graphql undefined'));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(await probeSuwayomi(url), false);
});

test('defaultRun feeds the input and reports a time limit', () => {
  const echo = defaultRun(
    process.execPath,
    ['-e', 'process.stdin.pipe(process.stdout)'],
    { capture: true, input: 'fixture bytes' }
  );
  assert.equal(echo.status, 0);
  assert.equal(echo.stdout, 'fixture bytes');

  const slow = defaultRun(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 60000)'],
    { capture: true, timeout: 200 }
  );
  assert.equal(slow.status, 1);
  assert.match(slow.stderr, /ETIMEDOUT/);
});

test('a run masks the passwords, starts offline servers, runs the tests and removes everything', async () => {
  const fake = fakeDependencies();

  await runContractChecks(fake.dependencies);

  // Every password is masked before the first command runs.
  assert.deepStrictEqual(
    fake.timeline.slice(0, PASSWORDS.length),
    PASSWORDS.map((password) => `log ::add-mask::${password}`)
  );
  assert.ok(
    fake.calls.every((call) =>
      call.args.every(
        (arg) => !PASSWORDS.some((password) => String(arg).includes(password))
      )
    ),
    'a password must never appear on a command line'
  );

  const [internal, edge] = dockerCalls(fake, 'network').filter(
    ({ args }) => args[1] === 'create'
  );
  assert.deepStrictEqual(
    internal.args,
    networkCreateArguments(NETWORK, { internal: true })
  );
  assert.deepStrictEqual(
    edge.args,
    networkCreateArguments(EDGE, { internal: false })
  );

  const started = dockerCalls(fake, 'run');
  assert.deepStrictEqual(
    started.map(({ args }) => args[args.indexOf('--name') + 1]),
    [...CONTAINERS, FORWARDER]
  );
  started.slice(0, 4).forEach(({ args, env }, index) => {
    assert.equal(args[args.indexOf('--network') + 1], NETWORK);
    assert.equal(env.AUTH_PASSWORD, PASSWORDS[index]);
  });
  assert.equal(started[4].env.AUTH_PASSWORD, undefined);
  assert.ok(
    started[4].args.includes(
      `FORWARD_ROUTES=${CONTAINERS.map((name, index) => `${4001 + index}:${name}:4567`).join(',')}`
    )
  );
  assert.deepStrictEqual(
    fake.calls.find((call) => call.args[1] === 'connect').args,
    ['network', 'connect', NETWORK, FORWARDER]
  );

  const writes = dockerCalls(fake, 'exec');
  assert.deepStrictEqual(
    writes.map(({ args, input }) => ({
      path: args.at(-1),
      input,
      container: args[2],
    })),
    fixtureFiles().map(({ path, bytes }) => ({
      path,
      input: bytes,
      container: CONTAINERS[0],
    }))
  );

  const tests = fake.calls.find((call) => call.command === process.execPath);
  assert.deepStrictEqual(tests.args, ['server/test/index.mts', CONTRACT_TEST]);
  assert.equal(
    tests.env.SEERR_TEST_SUWAYOMI_MAIN_URL,
    'http://127.0.0.1:54001'
  );
  assert.equal(tests.env.SEERR_TEST_SUWAYOMI_MAIN_PASSWORD, PASSWORDS[0]);
  assert.equal(
    tests.env.SEERR_TEST_SUWAYOMI_NONE_URL,
    'http://127.0.0.1:54004'
  );
  assert.equal(tests.env.SEERR_TEST_SUWAYOMI_NONE_PASSWORD, undefined);
  assert.equal(tests.env.CONFIG_DIRECTORY, 'config-fixture');

  assert.deepStrictEqual(removalCalls(fake), removals);
  assert.ok(
    fake.calls
      .filter(isRemoval)
      .every((call) => call.timeout === CLEANUP_TIMEOUT_MS)
  );
  assert.equal(fake.timeline.at(-1), 'remove config-fixture');
  assert.equal(dockerCalls(fake, 'logs').length, 0);
  assert.equal(fake.listening, false);
});

test('a failing contract run prints redacted container logs and still cleans up', async () => {
  const fake = fakeDependencies({
    failWhen: (command) => command === process.execPath,
  });

  await assert.rejects(
    runContractChecks(fake.dependencies),
    /^Error: run the Suwayomi contract tests failed \(exit 3\)\.$/
  );

  assert.deepStrictEqual(
    dockerCalls(fake, 'logs').map(({ args }) => args.at(-1)),
    [...CONTAINERS, FORWARDER]
  );
  // Only the mask commands may carry a password.
  const printed = fake.logs
    .filter((line) => !line.startsWith('::add-mask::'))
    .join('\n');
  assert.ok(!PASSWORDS.some((password) => printed.includes(password)));
  assert.ok(!printed.includes(ADDRESS));
  assert.match(printed, /login as \*\*\* from <address>/);
  assert.deepStrictEqual(removalCalls(fake), removals);
  assert.equal(fake.timeline.at(-1), 'remove config-fixture');
});

test('a failing docker step reports its redacted error and removes what it created', async () => {
  const fake = fakeDependencies({
    failWhen: (_command, args) =>
      args[0] === 'run' && args.includes(CONTAINERS[1]),
  });

  await assert.rejects(
    runContractChecks(fake.dependencies),
    /start Suwayomi with AUTH_MODE=basic_auth on the internal network failed \(exit 3\): fixture failure \*\*\* at <address>$/
  );
  assert.deepStrictEqual(removalCalls(fake), [
    containerRemoveArguments(CONTAINERS[1]),
    containerRemoveArguments(CONTAINERS[0]),
    networkRemoveArguments(EDGE),
    networkRemoveArguments(NETWORK),
  ]);
  assert.equal(fake.timeline.at(-1), 'remove config-fixture');
});

test('the run waits for every instance and gives up at the deadline', async () => {
  const ready = fakeDependencies({ probeFailures: 4 });
  await runContractChecks(ready.dependencies);
  assert.equal(ready.waits, 1);

  const silent = fakeDependencies({ probeFailures: Infinity });
  await assert.rejects(
    runContractChecks(silent.dependencies),
    new RegExp(
      `did not answer within ${READY_TIMEOUT_MS / 1000} s: ui_login, basic_auth, simple_login, none\\.$`
    )
  );
  assert.equal(silent.waits, READY_TIMEOUT_MS / 2000);
  assert.deepStrictEqual(removalCalls(silent), removals);
});

test('an instance that stops while starting fails the run at once', async () => {
  const fake = fakeDependencies({ stopped: CONTAINERS[2] });

  await assert.rejects(
    runContractChecks(fake.dependencies),
    /Suwayomi \(simple_login\) stopped before it was ready\./
  );
  assert.equal(fake.waits, 0);
  assert.deepStrictEqual(removalCalls(fake), removals);
});

test('an interrupt cleans up once, skips the remaining steps and exits with the signal status', async () => {
  const fake = fakeDependencies({
    interruptWhen: (_command, args) =>
      args[0] === 'network' && args[1] === 'connect' ? 'SIGINT' : undefined,
  });

  await assert.rejects(
    runContractChecks(fake.dependencies),
    /Interrupted by SIGINT\./
  );
  await fake.handlersDone();

  assert.equal(dockerCalls(fake, 'port').length, 0);
  assert.equal(dockerCalls(fake, 'logs').length, 0);
  assert.deepStrictEqual(removalCalls(fake), removals);
  assert.deepStrictEqual(fake.timeline.slice(-2), [
    'remove config-fixture',
    'exit 130',
  ]);
  assert.equal(fake.listening, false);
});

test('an interrupt still cleans up everything when the output is closed', async () => {
  // Without the guard, the first failed write ends the run before any removal.
  const unguarded = await runWithClosedOutput('unguarded');
  assert.equal(unguarded.status, 1);
  assert.deepStrictEqual(unguarded.removed, []);

  const guarded = await runWithClosedOutput('guarded');
  assert.equal(guarded.status, 129);
  assert.deepStrictEqual(guarded.removed, [
    ...removals.map((args) => ({ command: 'docker', args })),
    { directory: 'config-fixture' },
  ]);
});
