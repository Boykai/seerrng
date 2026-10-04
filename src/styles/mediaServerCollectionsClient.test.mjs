import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(path.resolve('package.json'));
const ts = require('typescript');
const React = require('react');
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = require('react-dom/client');
const { act } = React;
const sourceRoot = process.env.COLLECTION_TEST_SOURCE_ROOT ?? '.';
const source = fs.readFileSync(
  path.resolve(
    sourceRoot,
    'src/components/MediaDetails/MediaServerCollectionButton.tsx'
  ),
  'utf8'
);
let environment;
const useMockSWR = (key, fetcher) => {
  const keyString = JSON.stringify(key);
  const request = React.useRef({ key, fetcher });
  request.current = { key, fetcher };
  const current = React.useRef(keyString);
  current.current = keyString;
  const [state, setState] = React.useState({ isLoading: !!key });
  const load = React.useCallback(async () => {
    const { key, fetcher } = request.current;
    if (!key) return undefined;
    setState((previous) => ({ ...previous, isValidating: true }));
    try {
      const data = await fetcher(key);
      if (current.current === keyString) setState({ data });
      return data;
    } catch (error) {
      if (current.current === keyString) setState({ error });
      throw error;
    }
  }, [keyString]);
  React.useEffect(() => {
    environment.keys.push(request.current.key);
    setState({ isLoading: !!request.current.key });
    if (request.current.key) void load().catch(() => {});
  }, [keyString, load]);
  return {
    ...state,
    mutate: async (data, options) => {
      if (options?.revalidate === false) {
        environment.mutations.push(data);
        setState({ data });
        return data;
      }
      return load();
    },
  };
};
const Dropdown = ({
  text,
  buttonType,
  disabled,
  disabledReason,
  children,
  ...props
}) => {
  const [open, setOpen] = React.useState(false);
  return React.createElement(
    'div',
    { 'data-dropdown': true },
    React.createElement(
      'button',
      {
        ...props,
        disabled,
        title: disabledReason,
        'data-style': buttonType,
        'data-trigger': true,
        onClick: () => setOpen(!open),
      },
      text
    ),
    open && React.createElement('div', { role: 'menu' }, children)
  );
};
Dropdown.Item = ({ children, buttonType, ...props }) =>
  React.createElement(
    'button',
    {
      ...props,
      role: 'menuitem',
      'data-style': buttonType,
    },
    children
  );
const dependencies = {
  react: React,
  'react/jsx-runtime': require('react/jsx-runtime'),
  '@app/components/Common/Dropdown': { default: Dropdown, __esModule: true },
  '@app/components/Common/MediaServerIcon': {
    default: ({ mediaServerType, className }) =>
      React.createElement('i', { className, 'data-logo': mediaServerType }),
    getMediaServerName: (type) =>
      ({ 1: 'Plex', 2: 'Jellyfin', 3: 'Emby' })[type],
    __esModule: true,
  },
  '@app/components/Common/Tooltip': {
    default: ({ content, children }) =>
      React.createElement('div', { 'data-tooltip': content }, children),
    __esModule: true,
  },
  '@app/components/Common/PageErrorMessage': {
    default: ({ title, description, retry }) =>
      React.createElement(
        'section',
        { role: 'alert' },
        title,
        description,
        React.createElement(
          'button',
          {
            'data-retry': true,
            disabled: retry.busy,
            title: retry.tooltip,
            onClick: retry.onClick,
          },
          'Retry'
        )
      ),
    __esModule: true,
  },
  '@app/hooks/useSettings': {
    default: () => {
      environment.settingsReads++;
      return { currentSettings: { mediaServerType: environment.type } };
    },
    __esModule: true,
  },
  '@app/hooks/useUser': {
    useUser: () => {
      environment.userReads++;
      return {
        user: environment.user,
        loading: false,
        error: environment.userError ?? '',
        revalidate: async () => {
          environment.refreshes++;
          return environment.refresh ? environment.refresh() : environment.user;
        },
      };
    },
  },
  '@app/utils/defineMessages': {
    default: (_id, values) =>
      Object.fromEntries(
        Object.entries(values).map(([key, defaultMessage]) => [
          key,
          { defaultMessage },
        ])
      ),
    __esModule: true,
  },
  'react-intl': {
    useIntl: () => ({
      formatMessage: (message, values = {}) =>
        message.defaultMessage.replace(
          /\{(\w+)\}/g,
          (_match, key) => values[key]
        ),
    }),
  },
  swr: { default: useMockSWR, __esModule: true },
  axios: {
    default: {
      get: async (url, options) => {
        environment.gets.push(url);
        environment.getOptions.push(options);
        return { data: await environment.get(url) };
      },
      post: async (url, body) => {
        environment.posts.push({ url, body });
        return { data: await environment.post(url, body) };
      },
    },
    __esModule: true,
  },
};
const compiledModule = { exports: {} };
new Function(
  'require',
  'module',
  'exports',
  ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText
)(
  (id) => {
    assert.ok(id in dependencies, `Unexpected dependency ${id}`);
    return dependencies[id];
  },
  compiledModule,
  compiledModule.exports
);
const Component = compiledModule.exports.default;
const status = (member = false, type = 1) => ({
  serverType: type,
  available: true,
  collections: [{ id: '81', name: 'Watch Next', member }],
});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const fixture = async (props = {}, overrides = {}) => {
  environment = {
    type: 1,
    user: { id: 7, plexId: 9, updatedAt: '2026-10-02T00:00:00Z' },
    keys: [],
    gets: [],
    getOptions: [],
    posts: [],
    mutations: [],
    refreshes: 0,
    userReads: 0,
    settingsReads: 0,
    get: async () => status(),
    post: async (_url, body) => status(body.member),
    ...overrides,
  };
  const env = environment;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let currentProps = { tvId: 42, is4k: false, ...props };
  const render = async (next = {}) => {
    currentProps = { ...currentProps, ...next };
    await act(async () => {
      root.render(React.createElement(Component, currentProps));
      await tick();
    });
  };
  const click = async (element) => {
    await act(async () => {
      element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await tick();
    });
  };
  await render();
  return {
    env,
    container,
    render,
    click,
    trigger: () => container.querySelector('[data-trigger]'),
    item: () => container.querySelector('[role=menuitem]'),
    open: async () => click(container.querySelector('[data-trigger]')),
    settle: async (callback) =>
      act(async () => {
        callback();
        await tick();
      }),
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
};

test('Disabled integration boundary mounts no hooks or network reads', async () => {
  const f = await fixture({ enabled: false });
  assert.equal(f.container.textContent, '');
  assert.equal(f.env.userReads, 0);
  assert.equal(f.env.settingsReads, 0);
  assert.deepEqual(f.env.gets, []);
  assert.deepEqual(f.env.posts, []);
  await f.cleanup();
});
test('Invalid TV/quality props and missing user cannot start native collection reads', async () => {
  for (const props of [{ tvId: 0 }, { tvId: NaN }, { is4k: 'true' }]) {
    const f = await fixture(props);
    assert.deepEqual(f.env.gets, []);
    await f.cleanup();
  }
  const f = await fixture({}, { user: undefined });
  assert.equal(f.trigger().disabled, true);
  assert.deepEqual(f.env.gets, []);
  await f.cleanup();
});
test('Tuple cache identity is explicit while native requests contain only TV and quality', async () => {
  const f = await fixture({ is4k: true });
  assert.deepEqual(f.env.gets, [
    '/api/v1/tv/42/media-server-collections?is4k=true',
  ]);
  assert.equal(f.env.keys[0][0], f.env.gets[0]);
  assert.equal(f.env.keys[0][2], 1);
  assert.ok(f.env.keys[0][1].includes('true'));
  assert.equal(f.env.gets[0].includes('user'), false);
  assert.deepEqual(f.env.getOptions[0], {
    headers: { 'Cache-Control': 'no-cache' },
  });
  assert.equal(f.container.querySelector('[data-logo]').dataset.logo, '1');
  assert.equal(f.trigger().dataset.style, 'playback');
  await f.cleanup();
});
test('Existing collection menus describe exact Add/Remove actions without creation controls', async () => {
  const f = await fixture(
    {},
    {
      get: async () => ({
        ...status(),
        collections: [
          { id: '81', name: 'Watch Next', member: false },
          { id: '82', name: 'Weekend', member: true },
        ],
      }),
    }
  );
  await f.open();
  assert.deepEqual(
    [...f.container.querySelectorAll('[role=menuitem]')].map(
      (item) => item.textContent
    ),
    ['Add to Watch Next', 'Remove from Weekend']
  );
  assert.equal(f.container.textContent.includes('Create'), false);
  await f.cleanup();
});
test('Membership writes revalidate current user and source, send exact desired state, then display confirmed response', async () => {
  const f = await fixture({ is4k: true });
  await f.open();
  await f.click(f.item());
  assert.equal(f.env.refreshes, 1);
  assert.equal(f.env.gets.length, 2);
  assert.deepEqual(f.env.getOptions, [
    { headers: { 'Cache-Control': 'no-cache' } },
    { headers: { 'Cache-Control': 'no-cache' } },
  ]);
  assert.deepEqual(f.env.posts, [
    {
      url: '/api/v1/tv/42/media-server-collections/81',
      body: { member: true, is4k: true },
    },
  ]);
  assert.equal(f.item().textContent, 'Remove from Watch Next');
  await f.cleanup();
});
test('Explicit desired state is not inverted if another client already completed the action', async () => {
  let count = 0;
  const f = await fixture({}, { get: async () => status(++count > 1) });
  await f.open();
  await f.click(f.item());
  assert.deepEqual(f.env.posts, []);
  assert.equal(f.item().textContent, 'Remove from Watch Next');
  await f.cleanup();
});
test('Permission/zero-collection/limit states retain disabled control with truthful help', async () => {
  for (const [value, word] of [
    [
      {
        serverType: 1,
        available: false,
        reason: 'not-authorized',
        collections: [],
      },
      'permission',
    ],
    [
      {
        serverType: 1,
        available: false,
        reason: 'account-not-linked',
        collections: [],
      },
      'Link',
    ],
    [
      {
        serverType: 1,
        available: false,
        reason: 'series-not-found',
        collections: [],
      },
      'selected quality',
    ],
    [
      {
        serverType: 1,
        available: false,
        reason: 'collection-limit',
        collections: [],
      },
      'limit',
    ],
    [
      { serverType: 1, available: true, collections: [] },
      'existing collections',
    ],
  ]) {
    const f = await fixture({}, { get: async () => value });
    assert.equal(f.trigger().disabled, true);
    assert.ok(
      f.container.querySelector('[data-tooltip]').dataset.tooltip.includes(word)
    );
    assert.deepEqual(f.env.posts, []);
    await f.cleanup();
  }
});
test('Changed linked account before mutation never reaches native collection writes', async () => {
  const f = await fixture(
    {},
    { refresh: async () => ({ id: 8, plexId: 10, updatedAt: 'later' }) }
  );
  await f.open();
  await f.click(f.item());
  assert.deepEqual(f.env.posts, []);
  assert.equal(f.env.gets.length, 1);
  assert.ok(f.container.querySelector('[role=alert]'));
  await f.cleanup();
});
test('Late preflight responses for a different title/quality cannot issue a mutation', async () => {
  const pending = deferred();
  let count = 0;
  const f = await fixture(
    {},
    { get: async () => (++count === 2 ? pending.promise : status()) }
  );
  await f.open();
  await f.click(f.item());
  await f.render({ tvId: 43, is4k: true });
  await f.settle(() => pending.resolve(status()));
  assert.deepEqual(f.env.posts, []);
  assert.equal(f.env.mutations.length, 0);
  await f.cleanup();
});
test('Late mutation confirmation cannot update another title or user cache', async () => {
  const pending = deferred();
  const f = await fixture({}, { post: async () => pending.promise });
  await f.open();
  await f.click(f.item());
  f.env.user = { id: 8, plexId: 10, updatedAt: 'later' };
  await f.render({ tvId: 43 });
  await f.settle(() => pending.resolve(status(true)));
  assert.equal(f.env.mutations.length, 0);
  assert.equal(f.item().textContent, 'Add to Watch Next');
  await f.cleanup();
});
test('Concurrent menu clicks are guarded before React state updates', async () => {
  const pending = deferred();
  const f = await fixture({}, { post: async () => pending.promise });
  await f.open();
  await act(async () => {
    const item = f.item();
    item.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    item.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await tick();
  });
  assert.equal(f.env.posts.length, 1);
  await f.settle(() => pending.resolve(status(true)));
  await f.cleanup();
});
test('Unconfirmed writes show shared error; Retry only reads and never repeats membership mutation', async () => {
  const f = await fixture({}, { post: async () => status(false) });
  await f.open();
  await f.click(f.item());
  assert.ok(f.container.querySelector('[role=alert]'));
  assert.equal(f.trigger().disabled, true);
  assert.equal(f.env.mutations.length, 0);
  await f.click(f.container.querySelector('[data-retry]'));
  assert.equal(f.env.posts.length, 1);
  assert.equal(f.env.gets.length, 3);
  assert.equal(f.container.querySelector('[role=alert]'), null);
  await f.cleanup();
});
test('Malformed/foreign-provider source responses never enable the chooser', async () => {
  for (const value of [
    status(false, 2),
    {
      ...status(),
      collections: [{ id: '../81', name: 'Oops', member: false }],
    },
    { ...status(), collections: [{ id: '81', name: 'Oops' }] },
    { ...status(), reason: 'not-authorized' },
  ]) {
    const f = await fixture({}, { get: async () => value });
    assert.equal(f.trigger().disabled, true);
    assert.ok(f.container.querySelector('[role=alert]'));
    assert.deepEqual(f.env.posts, []);
    await f.cleanup();
  }
});
test('Loading is reported upward and unmount clears it without rendering another spinner', async () => {
  const pending = deferred();
  const updates = [];
  const f = await fixture(
    { onLoadingChange: (value) => updates.push(value) },
    { get: async () => pending.promise }
  );
  assert.ok(updates.includes(true));
  assert.equal(f.container.querySelector('[role=status]'), null);
  await f.cleanup();
  assert.equal(updates.at(-1), false);
  await act(async () => {
    pending.resolve(status());
    await tick();
  });
});
