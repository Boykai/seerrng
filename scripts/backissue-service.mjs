#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

const API_PREFIX = '/api/v1/settings/backissue';

export const usage = `Manage a BackIssue connection in SeerrNG (administrator API key required)

Commands:
  pnpm backissue:service -- list
  pnpm backissue:service -- test --host backissue --api-key-env BACKISSUE_API_KEY
  pnpm backissue:service -- add --name Home --host backissue --api-key-env BACKISSUE_API_KEY --default --sync
  pnpm backissue:service -- update 1 --host backissue-new --default
  pnpm backissue:service -- remove 1

Options:
  --name NAME               Display name (required for add)
  --host HOST               BackIssue hostname or IP address
  --port PORT               BackIssue port (default: 8787)
  --api-key-env NAME        Environment variable holding the BackIssue key
                            (default: BACKISSUE_API_KEY)
  --base-url PATH           Optional URL base, such as /backissue
  --external-url URL        Optional link users can open in their browser
  --https / --http          Select HTTPS or HTTP
  --default / --no-default  Use or stop using this server for comic requests
  --sync / --no-sync        Enable or disable collection scanning

Environment:
  SEERRNG_URL       SeerrNG base URL, for example https://media.example.com
  SEERRNG_API_KEY   SeerrNG administrator API key (not the BackIssue key)
  BACKISSUE_API_KEY BackIssue key, unless --api-key-env selects another name

The command sends keys through environment variables, never command-line arguments.
`;

const valueOptions = new Set([
  '--name',
  '--host',
  '--hostname',
  '--port',
  '--api-key-env',
  '--base-url',
  '--external-url',
]);

export const parseArgs = (args) => {
  const command = args[0];
  if (!command || command === '--help' || command === '-h') {
    return { command: command ?? 'help', help: true, options: {} };
  }
  if (!['list', 'test', 'add', 'update', 'remove'].includes(command)) {
    throw new Error(`Unknown command: ${command}`);
  }

  const parsed = { command, id: undefined, options: {}, help: false };
  let index = 1;
  if (['update', 'remove'].includes(command)) {
    const id = args[index];
    if (!id || !/^\d+$/.test(id) || Number(id) < 0) {
      throw new Error(`${command} requires a non-negative service ID.`);
    }
    parsed.id = Number(id);
    index += 1;
  }

  for (; index < args.length; index += 1) {
    const option = args[index];
    if (option === '--help' || option === '-h') {
      parsed.help = true;
    } else if (valueOptions.has(option)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`${option} requires a value.`);
      }
      const name = option === '--hostname' ? '--host' : option;
      if (Object.hasOwn(parsed.options, name)) {
        throw new Error(`${name} may only be provided once.`);
      }
      parsed.options[name] = value;
      index += 1;
    } else if (
      [
        '--https',
        '--http',
        '--default',
        '--no-default',
        '--sync',
        '--no-sync',
      ].includes(option)
    ) {
      const name =
        option === '--https' || option === '--http'
          ? '--https'
          : option === '--default' || option === '--no-default'
            ? '--default'
            : '--sync';
      if (Object.hasOwn(parsed.options, name)) {
        throw new Error(`${name} may only be provided once.`);
      }
      parsed.options[name] = !['--http', '--no-default', '--no-sync'].includes(
        option
      );
    } else {
      throw new Error(`Unknown option: ${option}`);
    }
  }

  if (parsed.help) return parsed;
  if (command === 'list' || command === 'remove') {
    if (Object.keys(parsed.options).length > 0) {
      throw new Error(`${command} does not accept options.`);
    }
  }
  const allowedOptions = new Set(
    command === 'test'
      ? ['--host', '--port', '--api-key-env', '--base-url', '--https']
      : command === 'add' || command === 'update'
        ? [
            '--name',
            '--host',
            '--port',
            '--api-key-env',
            '--base-url',
            '--external-url',
            '--https',
            '--default',
            '--sync',
          ]
        : []
  );
  const unsupportedOption = Object.keys(parsed.options).find(
    (option) => !allowedOptions.has(option)
  );
  if (unsupportedOption) {
    throw new Error(`${unsupportedOption} cannot be used with ${command}.`);
  }
  if (command === 'add' && !parsed.options['--name']?.trim()) {
    throw new Error('add requires --name.');
  }
  if (['test', 'add'].includes(command) && !parsed.options['--host']?.trim()) {
    throw new Error(`${command} requires --host.`);
  }
  if (parsed.options['--port'] !== undefined) {
    const port = Number(parsed.options['--port']);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
      throw new Error('--port must be an integer from 1 to 65535.');
    }
    parsed.options['--port'] = port;
  }
  return parsed;
};

export const normalizeServerBase = (value) => {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('SEERRNG_URL must be an absolute HTTP or HTTPS URL.');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'SEERRNG_URL must be an HTTP(S) base URL without credentials, query, or fragment.'
    );
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
};

const apiCredentials = (env) => {
  if (!env.SEERRNG_URL || !env.SEERRNG_API_KEY) {
    throw new Error(
      'Set SEERRNG_URL and SEERRNG_API_KEY before running this command.'
    );
  }
  return {
    base: normalizeServerBase(env.SEERRNG_URL),
    key: env.SEERRNG_API_KEY,
  };
};

const request = async (credentials, method, path, body) => {
  const response = await fetch(`${credentials.base}${API_PREFIX}${path}`, {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(30_000),
    headers: {
      'X-Api-Key': credentials.key,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    throw new Error(
      `SeerrNG returned a non-JSON response (HTTP ${response.status}).`
    );
  }
  if (!response.ok) {
    const message =
      typeof data?.message === 'string'
        ? data.message
        : `HTTP ${response.status}`;
    throw new Error(`SeerrNG request failed: ${message}`);
  }
  return data;
};

const backIssueKey = (env, options) => {
  const name = options['--api-key-env'] ?? 'BACKISSUE_API_KEY';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error('--api-key-env must be a valid environment variable name.');
  }
  if (!env[name]) {
    throw new Error(
      `Set ${name} in the environment before running this command.`
    );
  }
  return env[name];
};

const connection = (env, options) => ({
  hostname: options['--host'],
  port: options['--port'] ?? 8787,
  apiKey: backIssueKey(env, options),
  useSsl: options['--https'] ?? false,
  baseUrl: options['--base-url'] ?? '',
});

const serviceSettings = (env, options, existing = {}) => ({
  ...existing,
  ...(options['--name'] !== undefined ? { name: options['--name'] } : {}),
  ...(options['--host'] !== undefined ? { hostname: options['--host'] } : {}),
  ...(options['--port'] !== undefined ? { port: options['--port'] } : {}),
  ...(options['--https'] !== undefined ? { useSsl: options['--https'] } : {}),
  ...(options['--base-url'] !== undefined
    ? { baseUrl: options['--base-url'] }
    : {}),
  ...(options['--external-url'] !== undefined
    ? { externalUrl: options['--external-url'] }
    : {}),
  ...(options['--default'] !== undefined
    ? { isDefault: options['--default'] }
    : {}),
  ...(options['--sync'] !== undefined
    ? { syncEnabled: options['--sync'] }
    : {}),
  apiKey:
    existing.id === undefined || options['--api-key-env'] !== undefined
      ? backIssueKey(env, options)
      : existing.apiKey,
  tags: existing.tags ?? [],
  preventSearch: existing.preventSearch ?? false,
});

const displayList = (items) => {
  if (!Array.isArray(items) || items.length === 0) {
    console.log('No BackIssue servers are configured.');
    return;
  }
  const rows = items.map((item) => ({
    ID: item.id,
    Name: item.name,
    Address: `${item.useSsl ? 'https' : 'http'}://${item.hostname}:${item.port}${item.baseUrl ?? ''}`,
    Default: item.isDefault ? 'yes' : '',
    Sync: item.syncEnabled ? 'yes' : 'no',
  }));
  const columns = ['ID', 'Name', 'Address', 'Default', 'Sync'];
  const widths = columns.map((key) =>
    Math.max(key.length, ...rows.map((row) => String(row[key]).length))
  );
  const line = (row) =>
    columns
      .map((key, index) => String(row[key]).padEnd(widths[index]))
      .join('  ');
  console.log(line(Object.fromEntries(columns.map((key) => [key, key]))));
  console.log(widths.map((width) => '-'.repeat(width)).join('  '));
  for (const row of rows) console.log(line(row));
};

export const run = async (args = process.argv.slice(2), env = process.env) => {
  let parsed;
  try {
    parsed = parseArgs(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(`\n${usage}`);
    return 2;
  }
  if (parsed.help) {
    console.log(usage);
    return 0;
  }

  try {
    const credentials = apiCredentials(env);
    if (parsed.command === 'list') {
      displayList(await request(credentials, 'GET', '', undefined));
      return 0;
    }
    if (parsed.command === 'remove') {
      const removed = await request(
        credentials,
        'DELETE',
        `/${parsed.id}`,
        undefined
      );
      console.log(`Removed BackIssue server ${removed.name} (${removed.id}).`);
      return 0;
    }
    if (parsed.command === 'test') {
      const result = await request(
        credentials,
        'POST',
        '/test',
        connection(env, parsed.options)
      );
      console.log(
        `Connected to BackIssue (version ${result.version ?? 'unknown'}).`
      );
      return 0;
    }
    if (parsed.command === 'add') {
      const created = await request(
        credentials,
        'POST',
        '',
        serviceSettings(env, parsed.options, {
          ...connection(env, parsed.options),
          name: parsed.options['--name'],
          isDefault: parsed.options['--default'] ?? false,
          syncEnabled: parsed.options['--sync'] ?? false,
          externalUrl: parsed.options['--external-url'] ?? '',
          tags: [],
          preventSearch: false,
        })
      );
      console.log(`Added BackIssue server ${created.name} (${created.id}).`);
      return 0;
    }

    const items = await request(credentials, 'GET', '', undefined);
    const existing = Array.isArray(items)
      ? items.find((item) => item.id === parsed.id)
      : undefined;
    if (!existing) {
      throw new Error(`BackIssue server ${parsed.id} was not found.`);
    }
    const updated = await request(
      credentials,
      'PUT',
      `/${parsed.id}`,
      serviceSettings(env, parsed.options, existing)
    );
    console.log(`Updated BackIssue server ${updated.name} (${updated.id}).`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = await run();
}
