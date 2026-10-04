#!/usr/bin/env node
// Runs the Suwayomi contract tests (server/api/suwayomi/suwayomi.contract.test.ts)
// against disposable Suwayomi-Server containers. Used locally and by
// .github/workflows/manga-checks.yml.
//
//   node scripts/suwayomi-contract-checks.mjs
//
// One container per authentication mode runs from a digest-pinned image on an
// internal Docker network, which has no route out. A forwarder container from
// a digest-pinned Node.js image joins that network and a normal one and
// publishes one port per instance on 127.0.0.1 only, so the tests run on the
// host while Suwayomi stays offline. The fixture manga and its downloaded
// chapter archive are generated at run time. Passwords are random, masked in
// GitHub Actions and never appear on a command line. The containers, the
// networks and the temporary config directory are removed when the run ends,
// fails or is interrupted, as in scripts/manga-migration-checks.mjs.

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  setTimeout as delay,
  setImmediate as nextTurn,
} from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

import {
  CLEANUP_TIMEOUT_MS,
  INTERRUPT_SIGNALS,
  UsageError,
  actionsMaskCommand,
  createCleanups,
  createDatabasePassword,
  signalExitCode,
} from './manga-migration-checks.mjs';

export const SUWAYOMI_IMAGE =
  'ghcr.io/suwayomi/suwayomi-server:v2.4.2366@sha256:1fac27c387dc2ea9949e1a01ad7f6d6de9d72d3988338a95476748e5c45c4582';
export const FORWARDER_IMAGE =
  'node:24.21.0-alpine3.23@sha256:9ec4a2e289874ed0d722e1772ec2de45d2801541db8612f3638b26f128c69ac2';
export const SUWAYOMI_PORT = 4567;
export const SUWAYOMI_USERNAME = 'seerrng-ci';
export const CONTRACT_TEST = 'server/api/suwayomi/suwayomi.contract.test.ts';
export const DATA_DIRECTORY = '/home/suwayomi/.local/share/Tachidesk';
export const LOCAL_SOURCE_DIRECTORY = `${DATA_DIRECTORY}/local`;
// Where Suwayomi keeps CBZ downloads of local-source chapters.
export const DOWNLOAD_DIRECTORY = `${DATA_DIRECTORY}/downloads/mangas/Local source`;
export const FIXTURE_TITLE = 'SeerrNG Contract Fixture';
export const DOWNLOADED_CHAPTER = 'Chapter 1';
export const PENDING_CHAPTER = 'Chapter 2';
// Short lifetimes let the tests watch the client refresh and log in again.
export const TOKEN_EXPIRY_SECONDS = 15;
export const REFRESH_EXPIRY_SECONDS = 45;
export const FORWARDER_FIRST_PORT = 4001;
export const READY_TIMEOUT_MS = 5 * 60 * 1000;

// The first instance receives the fixture and runs the end-to-end checks.
export const SUWAYOMI_INSTANCES = [
  {
    key: 'MAIN',
    authMode: 'ui_login',
    credentials: true,
    settings: {
      DOWNLOAD_AS_CBZ: 'true',
      JWT_TOKEN_EXPIRY: `${TOKEN_EXPIRY_SECONDS}s`,
      JWT_REFRESH_EXPIRY: `${REFRESH_EXPIRY_SECONDS}s`,
    },
  },
  { key: 'BASIC', authMode: 'basic_auth', credentials: true, settings: {} },
  { key: 'SIMPLE', authMode: 'simple_login', credentials: true, settings: {} },
  { key: 'NONE', authMode: 'none', credentials: false, settings: {} },
];

// Runs in the forwarder container: FORWARD_ROUTES is a comma-separated list
// of listenPort:host:targetPort.
export const FORWARDER_SCRIPT = [
  "const net = require('node:net');",
  "for (const route of process.env.FORWARD_ROUTES.split(',')) {",
  "  const [port, host, targetPort] = route.split(':');",
  '  net',
  '    .createServer((client) => {',
  '      const upstream = net.connect(Number(targetPort), host);',
  '      const fail = () => {',
  '        client.destroy();',
  '        upstream.destroy();',
  '      };',
  "      client.on('error', fail);",
  "      upstream.on('error', fail);",
  '      client.pipe(upstream).pipe(client);',
  '    })',
  '    .listen(Number(port));',
  '}',
].join('\n');

const rootDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const STEP_TIMEOUT_MS = 15 * 60 * 1000;
const PROBE_TIMEOUT_MS = 5_000;
const LOG_LINES = '80';

export const parseArguments = (argv) => {
  if (argv.length > 0) {
    throw new UsageError('Usage: node scripts/suwayomi-contract-checks.mjs');
  }
  return {};
};

const pngChunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
};

/** A solid-colour 8-bit RGB PNG. */
export const createPng = (width, height, [red, green, blue]) => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  // Each row starts with filter type 0.
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) {
    row.set([red, green, blue], 1 + x * 3);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(Buffer.concat(Array(height).fill(row)))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
};

// 1980-01-01, the first DOS date, keeps the archive identical on every run.
const ZIP_DATE = (1 << 5) | 1;

/** An uncompressed ZIP with UTF-8 names, which is what a CBZ archive is. */
export const createStoredZip = (entries) => {
  const records = [];
  const directory = [];
  let offset = 0;
  for (const { name, bytes } of entries) {
    const fileName = Buffer.from(name, 'utf8');
    const checksum = crc32(bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(ZIP_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(ZIP_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(bytes.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(offset, 42);
    records.push(local, fileName, bytes);
    directory.push(central, fileName);
    offset += local.length + fileName.length + bytes.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(
    directory.reduce((size, part) => size + part.length, 0),
    12
  );
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...records, ...directory, end]);
};

const fixtureCover = () => createPng(60, 90, [40, 90, 160]);
const downloadedPages = () => [
  { name: '001.png', bytes: createPng(80, 120, [200, 60, 60]) },
  { name: '002.png', bytes: createPng(80, 120, [60, 160, 60]) },
];

/** The CBZ that Suwayomi would have written for the downloaded chapter. */
export const fixtureArchive = () => createStoredZip(downloadedPages());

/**
 * A local-source manga with a cover and two chapters of page images. The
 * first chapter also has a downloaded archive; Suwayomi's own downloader
 * cannot produce one offline.
 */
export const fixtureFiles = () => {
  const manga = `${LOCAL_SOURCE_DIRECTORY}/${FIXTURE_TITLE}`;
  return [
    { path: `${manga}/cover.png`, bytes: fixtureCover() },
    ...downloadedPages().map(({ name, bytes }) => ({
      path: `${manga}/${DOWNLOADED_CHAPTER}/${name}`,
      bytes,
    })),
    {
      path: `${manga}/${PENDING_CHAPTER}/001.png`,
      bytes: createPng(80, 120, [60, 60, 200]),
    },
    {
      path: `${DOWNLOAD_DIRECTORY}/${FIXTURE_TITLE}/${DOWNLOADED_CHAPTER}.cbz`,
      bytes: fixtureArchive(),
    },
  ];
};

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** What the contract tests need to know about the fixture. */
export const fixtureDescription = () => {
  const archive = fixtureArchive();
  const cover = fixtureCover();
  return {
    title: FIXTURE_TITLE,
    downloadedChapter: DOWNLOADED_CHAPTER,
    pendingChapter: PENDING_CHAPTER,
    archiveBytes: archive.length,
    archiveSha256: sha256(archive),
    coverSha256: sha256(cover),
  };
};

const HARDENING = ['--cap-drop', 'ALL', '--security-opt', 'no-new-privileges'];

export const networkCreateArguments = (name, { internal }) => [
  'network',
  'create',
  ...(internal ? ['--internal'] : []),
  name,
];

export const networkRemoveArguments = (name) => ['network', 'rm', name];

export const containerRemoveArguments = (name) => [
  'rm',
  '--force',
  '--volumes',
  name,
];

export const suwayomiRunArguments = (
  containerName,
  network,
  instance,
  image = SUWAYOMI_IMAGE
) => [
  'run',
  '--detach',
  '--name',
  containerName,
  '--network',
  network,
  ...HARDENING,
  '--env',
  'WEB_UI_ENABLED=false',
  '--env',
  `AUTH_MODE=${instance.authMode}`,
  ...(instance.credentials
    ? // Without a value, docker reads AUTH_PASSWORD from its own environment.
      ['--env', `AUTH_USERNAME=${SUWAYOMI_USERNAME}`, '--env', 'AUTH_PASSWORD']
    : []),
  ...Object.entries(instance.settings).flatMap(([name, value]) => [
    '--env',
    `${name}=${value}`,
  ]),
  image,
];

export const forwarderRoutes = (instances) =>
  instances
    .map(
      ({ listenPort, containerName }) =>
        `${listenPort}:${containerName}:${SUWAYOMI_PORT}`
    )
    .join(',');

export const forwarderRunArguments = (
  containerName,
  network,
  instances,
  image = FORWARDER_IMAGE
) => [
  'run',
  '--detach',
  '--name',
  containerName,
  '--network',
  network,
  ...HARDENING,
  '--read-only',
  '--user',
  'node',
  '--env',
  `FORWARD_ROUTES=${forwarderRoutes(instances)}`,
  ...instances.flatMap(({ listenPort }) => [
    '--publish',
    `127.0.0.1::${listenPort}`,
  ]),
  image,
  'node',
  '-e',
  FORWARDER_SCRIPT,
];

export const fixtureWriteArguments = (containerName, file) => [
  'exec',
  '--interactive',
  containerName,
  'sh',
  '-c',
  'mkdir -p "$(dirname "$1")" && cat > "$1"',
  'write-fixture',
  file.path,
];

export const parseLoopbackPort = (output) => {
  const mappings = String(output)
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const ports = mappings.map(
    (mapping) => /^127\.0\.0\.1:(\d{1,5})$/u.exec(mapping)?.[1]
  );
  if (ports.length === 0 || ports.some((port) => port === undefined)) {
    throw new Error(
      `The forwarder must publish on 127.0.0.1 only; docker reported: ${
        mappings.join(', ') || '(no mapping)'
      }`
    );
  }
  return Number(ports[0]);
};

export const contractTestEnvironment = ({
  baseEnv,
  configDirectory,
  instances,
}) => {
  const env = { ...baseEnv };
  // The test network guard stays on: only the loopback forwarder is reachable.
  delete env.ALLOW_NETWORK;
  for (const key of Object.keys(env)) {
    if (key.startsWith('SEERR_TEST_SUWAYOMI_')) {
      delete env[key];
    }
  }
  env.CONFIG_DIRECTORY = configDirectory;
  env.SEERR_TEST_FAIL_ON_NETWORK = 'true';
  env.SEERR_TEST_SUWAYOMI_TOKEN_EXPIRY_SECONDS = String(TOKEN_EXPIRY_SECONDS);
  env.SEERR_TEST_SUWAYOMI_REFRESH_EXPIRY_SECONDS = String(
    REFRESH_EXPIRY_SECONDS
  );
  env.SEERR_TEST_SUWAYOMI_FIXTURE = JSON.stringify(fixtureDescription());
  for (const instance of instances) {
    const prefix = `SEERR_TEST_SUWAYOMI_${instance.key}`;
    env[`${prefix}_URL`] = instance.url;
    if (instance.password !== undefined) {
      env[`${prefix}_USERNAME`] = SUWAYOMI_USERNAME;
      env[`${prefix}_PASSWORD`] = instance.password;
    }
  }
  return env;
};

/** Removes secrets and addresses from container logs before printing them. */
export const redactLog = (text, secrets) => {
  let redacted = String(text);
  for (const secret of secrets) {
    redacted = redacted.split(secret).join('***');
  }
  return redacted.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/gu, '<address>');
};

/** Any HTTP answer below 500 means the instance is listening. */
export const probeSuwayomi = async (url) => {
  try {
    const response = await fetch(new URL('/api/graphql', url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query: 'query Ready { aboutServer { version } }',
      }),
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    await response.body?.cancel();
    return response.status < 500;
  } catch {
    return false;
  }
};

export const defaultRun = (
  command,
  args,
  { env, capture = false, timeout = STEP_TIMEOUT_MS, input } = {}
) => {
  const output = capture ? 'pipe' : 'inherit';
  const result = spawnSync(command, args, {
    cwd: rootDirectory,
    env,
    input,
    encoding: 'utf8',
    stdio: [input === undefined ? 'ignore' : 'pipe', output, output],
    timeout,
    windowsHide: true,
  });

  return {
    status: result.error ? 1 : result.status,
    stdout: result.stdout ?? '',
    stderr: result.error ? result.error.message : (result.stderr ?? ''),
  };
};

// A closed terminal or pipe makes every write to stdout or stderr fail, and
// Node reports each failure as an 'error' event. Without a listener, that
// event ends the process before the cleanup has removed what the run started.
export const ignoreOutputErrors = (
  streams = [process.stdout, process.stderr]
) => {
  for (const stream of streams) {
    stream.on('error', () => {});
  }
};

const defaultDependencies = () => ({
  run: defaultRun,
  log: (message) => process.stdout.write(`${message}\n`),
  env: process.env,
  createPassword: createDatabasePassword,
  createRunId: () => randomBytes(6).toString('hex'),
  makeConfigDirectory: () =>
    mkdtempSync(path.join(tmpdir(), 'seerrng-suwayomi-contract-')),
  removeConfigDirectory: (directory) =>
    rmSync(directory, { recursive: true, force: true }),
  probe: probeSuwayomi,
  now: () => Date.now(),
  wait: () => delay(2000),
  onInterrupt: (listener) => {
    for (const signal of INTERRUPT_SIGNALS) {
      process.on(signal, listener);
    }
    return () => {
      for (const signal of INTERRUPT_SIGNALS) {
        process.off(signal, listener);
      }
    };
  },
  exit: (code) => process.exit(code),
});

const runStep = async (context, label, command, args, options) => {
  // Lets Node deliver a pending signal before the next blocking step.
  await nextTurn();
  context.interruption.throwIfAborted();

  const inActions = context.env.GITHUB_ACTIONS === 'true';
  context.log(inActions ? `::group::${label}` : `==> ${label}`);
  const result = context.run(command, args, options);
  if (inActions) {
    context.log('::endgroup::');
  }

  if (result.status !== 0) {
    const detail = options?.capture
      ? redactLog(result.stderr.trim(), context.secrets)
      : '';
    throw new Error(
      `${label} failed (exit ${result.status})${detail ? `: ${detail}` : '.'}`
    );
  }

  return result;
};

const removeLater = (context, args, description) => {
  context.cleanups.add(() => {
    const removal = context.run('docker', args, {
      env: context.env,
      capture: true,
      timeout: CLEANUP_TIMEOUT_MS,
    });
    if (removal.status !== 0) {
      context.log(`Could not remove ${description}: ${removal.stderr.trim()}`);
    }
  });
};

const createNetwork = async (context, name, internal) => {
  // Registered before the network exists: an interrupted create can still
  // leave it behind.
  removeLater(context, networkRemoveArguments(name), `network ${name}`);
  await runStep(
    context,
    `create the ${internal ? 'internal' : 'forwarder'} network`,
    'docker',
    networkCreateArguments(name, { internal }),
    { env: context.env, capture: true }
  );
};

const startContainer = async (context, name, label, args, env) => {
  removeLater(context, containerRemoveArguments(name), `container ${name}`);
  context.containers.push(name);
  await runStep(context, label, 'docker', args, {
    env,
    capture: true,
  });
};

const waitForInstances = async (context, instances) => {
  const deadline = context.now() + READY_TIMEOUT_MS;
  const pending = new Set(instances);
  context.log(`==> wait for ${pending.size} Suwayomi instances to answer`);
  for (;;) {
    for (const instance of [...pending]) {
      context.interruption.throwIfAborted();
      const state = context.run(
        'docker',
        ['inspect', '--format', '{{.State.Running}}', instance.containerName],
        { env: context.env, capture: true }
      );
      if (state.status !== 0 || state.stdout.trim() !== 'true') {
        throw new Error(
          `Suwayomi (${instance.authMode}) stopped before it was ready.`
        );
      }
      if (await context.probe(instance.url)) {
        pending.delete(instance);
      }
    }
    if (pending.size === 0) {
      return;
    }
    if (context.now() >= deadline) {
      throw new Error(
        `Suwayomi did not answer within ${READY_TIMEOUT_MS / 1000} s: ${[
          ...pending,
        ]
          .map((instance) => instance.authMode)
          .join(', ')}.`
      );
    }
    await context.wait();
  }
};

export const startEnvironment = async (context) => {
  const runId = context.createRunId();
  const internalNetwork = `seerrng-suwayomi-contract-${runId}`;
  const edgeNetwork = `${internalNetwork}-edge`;
  const instances = SUWAYOMI_INSTANCES.map((instance, index) => ({
    ...instance,
    containerName: `${internalNetwork}-${instance.key.toLowerCase()}`,
    listenPort: FORWARDER_FIRST_PORT + index,
    password: instance.credentials ? context.createPassword() : undefined,
  }));
  for (const { password } of instances) {
    if (password !== undefined) {
      context.secrets.push(password);
      const mask = actionsMaskCommand(password, context.env);
      if (mask) {
        context.log(mask);
      }
    }
  }

  await createNetwork(context, internalNetwork, true);
  await createNetwork(context, edgeNetwork, false);
  for (const instance of instances) {
    await startContainer(
      context,
      instance.containerName,
      `start Suwayomi with AUTH_MODE=${instance.authMode} on the internal network`,
      suwayomiRunArguments(instance.containerName, internalNetwork, instance),
      instance.password === undefined
        ? context.env
        : { ...context.env, AUTH_PASSWORD: instance.password }
    );
  }

  const forwarder = `${internalNetwork}-forwarder`;
  await startContainer(
    context,
    forwarder,
    'start the forwarder on 127.0.0.1',
    forwarderRunArguments(forwarder, edgeNetwork, instances),
    context.env
  );
  await runStep(
    context,
    'connect the forwarder to the internal network',
    'docker',
    ['network', 'connect', internalNetwork, forwarder],
    { env: context.env, capture: true }
  );
  for (const instance of instances) {
    const { stdout } = await runStep(
      context,
      `read the loopback port for ${instance.authMode}`,
      'docker',
      ['port', forwarder, `${instance.listenPort}/tcp`],
      { env: context.env, capture: true }
    );
    instance.url = `http://127.0.0.1:${parseLoopbackPort(stdout)}`;
  }

  await waitForInstances(context, instances);
  for (const file of fixtureFiles()) {
    await runStep(
      context,
      `write the fixture file ${path.posix.relative(DATA_DIRECTORY, file.path)}`,
      'docker',
      fixtureWriteArguments(instances[0].containerName, file),
      { env: context.env, capture: true, input: file.bytes }
    );
  }
  return instances;
};

const printContainerLogs = (context) => {
  const inActions = context.env.GITHUB_ACTIONS === 'true';
  for (const name of context.containers) {
    const result = context.run('docker', ['logs', '--tail', LOG_LINES, name], {
      env: context.env,
      capture: true,
      timeout: CLEANUP_TIMEOUT_MS,
    });
    context.log(inActions ? `::group::logs of ${name}` : `==> logs of ${name}`);
    context.log(
      redactLog(`${result.stdout}${result.stderr}`.trim(), context.secrets)
    );
    if (inActions) {
      context.log('::endgroup::');
    }
  }
};

export const runContractChecks = async (
  dependencies = defaultDependencies()
) => {
  const cleanups = createCleanups(dependencies.log);
  const interruption = new AbortController();
  const context = {
    ...dependencies,
    cleanups,
    interruption: interruption.signal,
    secrets: [],
    containers: [],
  };
  const stopListening = dependencies.onInterrupt(async (signal) => {
    interruption.abort(new Error(`Interrupted by ${signal}.`));
    dependencies.log(`${signal} received; cleaning up before exiting.`);
    await cleanups.run();
    dependencies.exit(signalExitCode(signal));
  });

  try {
    const configDirectory = dependencies.makeConfigDirectory();
    cleanups.add(() => dependencies.removeConfigDirectory(configDirectory));
    const instances = await startEnvironment(context);
    await runStep(
      context,
      'run the Suwayomi contract tests',
      process.execPath,
      ['server/test/index.mts', CONTRACT_TEST],
      {
        env: contractTestEnvironment({
          baseEnv: dependencies.env,
          configDirectory,
          instances,
        }),
      }
    );
  } catch (error) {
    if (!interruption.signal.aborted) {
      printContainerLogs(context);
    }
    throw error;
  } finally {
    await cleanups.run();
    // A signal that arrived during the last step is still pending. Deliver it
    // while the handler is registered rather than dropping it.
    await nextTurn();
    stopListening();
  }
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  ignoreOutputErrors();
  try {
    parseArguments(process.argv.slice(2));
    await runContractChecks();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}
