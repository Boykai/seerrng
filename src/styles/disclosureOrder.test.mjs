import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(path.resolve('package.json'));
const ts = require('typescript');
const React = require('react');
const sourceRoot =
  process.env.DISCLOSURE_ORDER_SOURCE_ROOT ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const load = (relative, imports = require) => {
  const source = fs.readFileSync(path.join(sourceRoot, relative), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: {
      jsx: ts.JsxEmit.React,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const loadedModule = { exports: {} };
  new Function('require', 'module', 'exports', 'React', js)(
    imports,
    loadedModule,
    loadedModule.exports,
    React
  );
  return loadedModule.exports;
};
const helpers = load('server/utils/detailDisclosureOrder.ts');

test('drag feedback is globally styled without changing established control dimensions', () => {
  const css = fs.readFileSync(
    path.join(sourceRoot, 'src/styles/globals.css'),
    'utf8'
  );
  for (const state of ['ready', 'dragging']) {
    const rule = css.match(
      new RegExp(
        `\\.detail-disclosure-control\\[data-reorder-state='${state}'\\]\\s*\\{([^}]+)\\}`
      )
    )?.[1];
    assert.ok(rule);
    assert.doesNotMatch(
      rule,
      /padding|margin|width|height|font-size|transform/
    );
  }
  assert.match(css, /@keyframes disclosure-order-ready/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(
    css,
    /\.disclosure-order-announcement\s*\{[^}]*clip-path:\s*inset\(50%\)/
  );
});

test('saved ordering normalizes legacy, unknown, duplicated and newly added roles without replacing valid order', () => {
  assert.deepEqual(helpers.normalizeSeriesDisclosureOrder(undefined), [
    'overview',
    ...helpers.seriesDisclosureRoles.filter((role) => role !== 'overview'),
  ]);
  assert.deepEqual(
    helpers.normalizeSeriesDisclosureOrder([
      'mediaServer',
      'cast',
      'cast',
      'obsolete',
    ]),
    ['overview', 'mediaServer', 'cast', 'crew', 'subjectTags', 'details']
  );
  assert.equal(helpers.parseSeriesDisclosureOrder(['cast', 'cast']), null);
  assert.equal(helpers.parseSeriesDisclosureOrder(['__proto__']), null);
  assert.equal(helpers.parseSeriesDisclosureOrder({ cast: 1 }), null);
  assert.deepEqual(
    helpers.parseSeriesDisclosureOrder(['mediaServer', 'cast']),
    ['overview', 'mediaServer', 'cast', 'crew', 'subjectTags', 'details']
  );
  assert.deepEqual(
    helpers.insertDisclosureRole(
      helpers.seriesDisclosureRoles,
      'mediaServer',
      'cast',
      true
    ),
    ['cast', 'mediaServer', 'crew', 'subjectTags', 'details', 'overview']
  );
  assert.deepEqual(
    helpers.insertDisclosureRole(
      helpers.seriesDisclosureRoles,
      'cast',
      'mediaServer',
      true
    ),
    ['crew', 'subjectTags', 'details', 'mediaServer', 'cast', 'overview']
  );
});

test('one-second mouse hold, insertion, clicks, pin isolation, cancellation, keyboard and stable panels', async () => {
  const { JSDOM } = require('jsdom');
  const { createRoot } = require('react-dom/client');
  const dom = new JSDOM('<div id="root"></div>');
  const globals = {
    window: globalThis.window,
    document: globalThis.document,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  let now = 0,
    nextTimer = 0;
  const timers = new Map();
  globalThis.setTimeout = (callback, delay) => {
    const id = ++nextTimer;
    timers.set(id, { callback, at: now + delay });
    return id;
  };
  globalThis.clearTimeout = (id) => timers.delete(id);
  const advance = async (ms) =>
    React.act(async () => {
      now += ms;
      for (const [id, timer] of timers)
        if (timer.at <= now) {
          timers.delete(id);
          timer.callback();
        }
    });
  const icon = (props) => React.createElement('svg', props);
  const imports = (id) => {
    if (id === 'react') return React;
    if (id === 'react-dom') return require('react-dom');
    if (id === 'react-intl')
      return {
        useIntl: () => ({
          formatMessage: (message, values = {}) =>
            message.defaultMessage.replace(/\{(\w+)\}/g, (_, key) =>
              String(values[key])
            ),
        }),
      };
    if (id.endsWith('/defineMessages'))
      return {
        __esModule: true,
        default: (_prefix, messages) =>
          Object.fromEntries(
            Object.entries(messages).map(([key, defaultMessage]) => [
              key,
              { defaultMessage },
            ])
          ),
      };
    if (id.endsWith('/Tooltip'))
      return { __esModule: true, default: ({ children }) => children };
    if (id.endsWith('/outline')) return { ChevronDownIcon: icon };
    if (id.endsWith('/detailDisclosureOrder')) return helpers;
    throw new Error(`Unexpected import ${id}`);
  };
  const Disclosure = load(
    'src/components/MediaDetails/DetailDisclosureButton.tsx',
    imports
  ).default;
  const {
    default: Row,
    OrderedDisclosurePanels,
    DISCLOSURE_DRAG_HOLD_MS,
  } = load('src/components/MediaDetails/ReorderableDisclosureRow.tsx', imports);
  assert.equal(DISCLOSURE_DRAG_HOLD_MS, 1000);
  let toggles = 0,
    pins = 0,
    writes = [],
    mounted = 0;
  const Panel = ({ role }) => {
    const [value, setValue] = React.useState(0);
    React.useEffect(() => {
      mounted++;
    }, []);
    return React.createElement(
      'button',
      { 'data-panel': role, onClick: () => setValue(value + 1) },
      `${role}:${value}`
    );
  };
  const Harness = () => {
    const [order, setOrder] = React.useState(helpers.seriesDisclosureRoles);
    return React.createElement(
      React.Fragment,
      null,
      React.createElement(
        Row,
        {
          order,
          onOrderChange: async (next) => {
            writes.push(next);
            setOrder(next);
          },
        },
        helpers.seriesDisclosureRoles.map((role) =>
          React.createElement(Disclosure, {
            key: role,
            label: role,
            open: true,
            onClick: () => toggles++,
            onPinClick: () => pins++,
          })
        )
      ),
      React.createElement(
        OrderedDisclosurePanels,
        { order },
        helpers.seriesDisclosureRoles.map((role) =>
          React.createElement(
            React.Fragment,
            { key: role },
            React.createElement(Panel, { role })
          )
        )
      )
    );
  };
  const root = createRoot(document.getElementById('root'));
  const control = (role) =>
    document.querySelector(`[data-disclosure-role="${role}"]`);
  const button = (role) =>
    control(role).querySelector('.detail-disclosure-button');
  const pointer = async (role, type, x = 0, y = 0) =>
    React.act(async () => {
      const event = new dom.window.MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: x,
        clientY: y,
      });
      Object.defineProperties(event, {
        pointerId: { value: 1 },
        isPrimary: { value: true },
        pointerType: { value: 'mouse' },
      });
      button(role).dispatchEvent(event);
    });
  const click = async (element) => React.act(async () => element.click());
  try {
    await React.act(async () => root.render(React.createElement(Harness)));
    await click(document.querySelector('[data-panel="mediaServer"]'));
    for (const [index, role] of helpers.seriesDisclosureRoles.entries()) {
      control(role).getBoundingClientRect = () => ({
        left: index * 110,
        top: 0,
        width: 100,
        height: 20,
      });
    }
    await pointer('cast', 'pointerdown');
    await advance(999);
    assert.equal(control('cast').dataset.reorderState, undefined);
    await pointer('cast', 'pointerup');
    await click(button('cast'));
    assert.equal(toggles, 1);
    assert.equal(writes.length, 0);
    const wanted = [
      'cast',
      'mediaServer',
      'crew',
      'subjectTags',
      'details',
      'overview',
    ];
    await pointer('mediaServer', 'pointerdown', 450, 10);
    await advance(1000);
    assert.equal(control('mediaServer').dataset.reorderState, 'ready');
    assert.equal(document.querySelector('.disclosure-drag-ghost'), null);
    document.elementFromPoint = () => control('cast');
    await pointer('mediaServer', 'pointermove', 90, 15);
    const ghost = document.querySelector('.disclosure-drag-ghost');
    assert.ok(ghost.hasAttribute('inert'));
    assert.equal(ghost.getAttribute('aria-hidden'), 'true');
    assert.equal(ghost.style.getPropertyValue('--disclosure-drag-x'), '80px');
    assert.equal(ghost.style.getPropertyValue('--disclosure-drag-y'), '5px');
    assert.equal(
      ghost.style.getPropertyValue('--disclosure-drag-width'),
      '100px'
    );
    assert.equal(
      ghost.style.getPropertyValue('--disclosure-drag-height'),
      '20px'
    );
    assert.ok(ghost.querySelector('.detail-disclosure-pin'));
    assert.equal(
      ghost.querySelectorAll(
        '[id],[aria-controls],[aria-describedby],[data-disclosure-role],[data-reorder-state]'
      ).length,
      0
    );
    assert.equal(
      [...ghost.querySelectorAll('button')].every(
        (button) => button.tabIndex === -1
      ),
      true
    );
    assert.equal(control('mediaServer').dataset.reorderState, 'dragging');
    assert.equal(writes.length, 0);
    assert.deepEqual(
      [...document.querySelectorAll('[data-disclosure-role]')].map(
        (el) => el.dataset.disclosureRole
      ),
      wanted
    );
    assert.deepEqual(
      [...document.querySelectorAll('[data-panel]')].map(
        (el) => el.dataset.panel
      ),
      helpers.seriesDisclosureRoles
    );
    // A sibling reflowing under the cursor must not change the insertion slot.
    control('cast').getBoundingClientRect = () => ({
      left: 1000,
      top: 0,
      width: 100,
      height: 20,
    });
    await pointer('mediaServer', 'pointermove', 90, 15);
    assert.deepEqual(
      [...document.querySelectorAll('[data-disclosure-role]')].map(
        (el) => el.dataset.disclosureRole
      ),
      wanted
    );
    await click(ghost.querySelector('.detail-disclosure-pin'));
    await click(ghost.querySelector('.detail-disclosure-button'));
    assert.equal(pins, 0);
    assert.equal(toggles, 1);
    control('cast').getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 100,
      height: 20,
    });
    await pointer('mediaServer', 'pointerup', 90);
    await click(button('mediaServer'));
    assert.deepEqual(writes[0], wanted);
    assert.deepEqual(
      [...document.querySelectorAll('[data-disclosure-role]')].map(
        (el) => el.dataset.disclosureRole
      ),
      wanted
    );
    assert.deepEqual(
      [...document.querySelectorAll('[data-panel]')].map(
        (el) => el.dataset.panel
      ),
      wanted
    );
    assert.equal(
      document.querySelector('[data-panel="mediaServer"]').textContent,
      'mediaServer:1'
    );
    assert.equal(mounted, helpers.seriesDisclosureRoles.length);
    assert.equal(toggles, 1);
    await click(control('crew').querySelector('.detail-disclosure-pin'));
    assert.equal(pins, 1);
    assert.equal(timers.size, 0);
    await pointer('cast', 'pointerdown');
    await advance(1000);
    await React.act(async () =>
      window.dispatchEvent(
        new dom.window.KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
        })
      )
    );
    await pointer('cast', 'pointerup');
    await click(button('cast'));
    assert.equal(toggles, 1);
    assert.equal(writes.length, 1);
    // A cancelled Cast drag must not swallow another button's keyboard click.
    await click(button('crew'));
    assert.equal(toggles, 2);
    await pointer('cast', 'pointerdown');
    await pointer('cast', 'pointermove', 20);
    await advance(1000);
    assert.equal(control('cast').dataset.reorderState, undefined);
    await React.act(async () =>
      button('details').dispatchEvent(
        new dom.window.KeyboardEvent('keydown', {
          key: 'ArrowLeft',
          shiftKey: true,
          altKey: true,
          bubbles: true,
        })
      )
    );
    assert.equal(writes.length, 2);
    assert.equal(writes[1].indexOf('details'), 3);
    await pointer('crew', 'pointerdown');
    await advance(1000);
    document.elementFromPoint = () => control('cast');
    await pointer('crew', 'pointermove', 10);
    assert.ok(document.querySelector('.disclosure-drag-ghost'));
    document.elementFromPoint = () => document.body;
    // Release outside without a final pointermove: stale hover must not save.
    await pointer('crew', 'pointerup', 300);
    assert.equal(document.querySelector('.disclosure-drag-ghost'), null);
    assert.deepEqual(
      [...document.querySelectorAll('[data-disclosure-role]')].map(
        (el) => el.dataset.disclosureRole
      ),
      writes[1]
    );
    assert.equal(writes.length, 2);
    for (const type of ['blur', 'pointercancel', 'lostpointercapture']) {
      await pointer('crew', 'pointerdown', 230, 10);
      await advance(1000);
      document.elementFromPoint = () => control('cast');
      await pointer('crew', 'pointermove', 10);
      assert.ok(document.querySelector('.disclosure-drag-ghost'));
      await React.act(async () => {
        const event = new dom.window.MouseEvent(type, { bubbles: true });
        Object.defineProperty(event, 'pointerId', { value: 1 });
        (type === 'blur'
          ? window
          : control('crew').closest('.media-detail-disclosure-row')
        ).dispatchEvent(event);
      });
      assert.equal(document.querySelector('.disclosure-drag-ghost'), null);
      assert.deepEqual(
        [...document.querySelectorAll('[data-disclosure-role]')].map(
          (el) => el.dataset.disclosureRole
        ),
        writes[1]
      );
      assert.equal(writes.length, 2);
    }
    await pointer('cast', 'pointerdown');
    await React.act(async () => root.unmount());
    assert.equal(timers.size, 0);
  } finally {
    Object.assign(globalThis, globals);
    dom.window.close();
  }
});

test('server persistence is tv-scoped, self-owned and independent of pins; migrations are reversible nullable additions', () => {
  const route = fs.readFileSync(
    path.join(sourceRoot, 'server/routes/user/usersettings.ts'),
    'utf8'
  );
  const orderSection = route.slice(
    route.indexOf('const userSettingsRoutes'),
    route.indexOf('const updateMediaFilterPin')
  );
  assert.equal((orderSection.match(/isOwnProfile\(\)/g) ?? []).length, 2);
  assert.match(orderSection, /actor\.id !== userId/);
  assert.match(orderSection, /req\.params\.mediaType !== ['"]tv['"]/);
  assert.match(orderSection, /parseSeriesDisclosureOrder\(req\.body\.order\)/);
  assert.match(
    orderSection,
    /\.\.\.user\.settings\.detailDisclosureOrder,\s*tv: order/
  );
  assert.doesNotMatch(orderSection, /detailDisclosurePins|\.query\(/);
  for (const type of ['sqlite', 'postgres']) {
    const migration = fs.readFileSync(
      path.join(
        sourceRoot,
        `server/migration/${type}/1791000000000-AddDetailDisclosureOrder.ts`
      ),
      'utf8'
    );
    assert.match(migration, /ADD(?: COLUMN)? "detailDisclosureOrder" text/);
    assert.match(migration, /DROP COLUMN "detailDisclosureOrder"/);
    assert.doesNotMatch(migration, /NOT NULL|UPDATE|DELETE/);
  }
});

test('actual settings handlers validate inputs and save only the current user without altering pins', async () => {
  const source = fs.readFileSync(
    path.join(sourceRoot, 'server/routes/user/usersettings.ts'),
    'utf8'
  );
  const section = source.slice(
    source.indexOf('const userSettingsRoutes'),
    source.indexOf('const updateMediaFilterPin')
  );
  const code = ts.transpileModule(section, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;
  const routes = {},
    stored = new Map([
      [
        1,
        { id: 1, settings: { detailDisclosurePins: { tv: { cast: true } } } },
      ],
      [2, { id: 2, settings: {} }],
    ]);
  let saves = 0;
  const router = {
    get: (_path, ...handlers) => (routes.get = handlers.at(-1)),
    post: (_path, ...handlers) => (routes.post = handlers.at(-1)),
  };
  new Function(
    'Router',
    'isOwnProfile',
    'parsePositiveRouteId',
    'runUserSecurityReadWithActor',
    'runUserSecurityMutationWithActor',
    'Permission',
    'getRepository',
    'User',
    'UserSettings',
    'UserMutationActorUnauthorizedError',
    'normalizeSeriesDisclosureOrder',
    'parseSeriesDisclosureOrder',
    code
  )(
    () => router,
    () => () => undefined,
    (id) => (Number(id) > 0 ? Number(id) : undefined),
    async (_actor, _target, _permission, run) => run(),
    async (actor, _target, _permission, run) => run({ id: actor }),
    {},
    () => ({
      findOne: async ({ where }) => stored.get(where.id),
      save: async (user) => {
        saves++;
        stored.set(user.id, user);
        return user;
      },
    }),
    class {},
    class {
      constructor(value) {
        Object.assign(this, value);
      }
    },
    class extends Error {},
    helpers.normalizeSeriesDisclosureOrder,
    helpers.parseSeriesDisclosureOrder
  );
  const call = async (method, userId, targetId, body, mediaType = 'tv') => {
    const result = {};
    await routes[method](
      {
        params: { id: String(targetId), mediaType },
        user: { id: userId },
        body,
      },
      {
        status: (code) => {
          result.status = code;
          return { json: (value) => (result.value = value) };
        },
      },
      (error) => (result.error = error)
    );
    return result;
  };
  const updated = [
    'overview',
    'mediaServer',
    'cast',
    'details',
    'crew',
    'subjectTags',
  ];
  assert.equal((await call('post', 1, 1, { order: updated })).status, 200);
  assert.deepEqual((await call('get', 1, 1)).value, updated);
  assert.deepEqual(
    (await call('get', 2, 2)).value,
    helpers.normalizeSeriesDisclosureOrder(undefined)
  );
  assert.deepEqual(stored.get(1).settings.detailDisclosurePins, {
    tv: { cast: true },
  });
  assert.equal(
    (await call('post', 1, 2, { order: updated })).error.status,
    403
  );
  assert.equal(
    (await call('post', 1, 1, { order: ['cast', 'cast'] })).error.status,
    400
  );
  assert.equal(
    (await call('post', 1, 1, { order: updated, unexpected: true })).error
      .status,
    400
  );
  assert.equal(
    (await call('post', 1, 1, { order: updated }, 'movie')).error.status,
    400
  );
  assert.equal(saves, 1);
});

test('migration methods only add/remove the nullable order field with a mocked query runner', async () => {
  for (const type of ['sqlite', 'postgres']) {
    const Module = load(
      `server/migration/${type}/1791000000000-AddDetailDisclosureOrder.ts`
    );
    const migration = new Module.AddDetailDisclosureOrder1791000000000();
    const queries = [];
    const runner = { query: async (query) => queries.push(query) };
    await migration.up(runner);
    await migration.down(runner);
    assert.equal(queries.length, 2);
    assert.match(queries[0], /ADD(?: COLUMN)? "detailDisclosureOrder" text$/);
    assert.match(queries[1], /DROP COLUMN "detailDisclosureOrder"$/);
  }
});

test('preference hook restores each user independently and rolls failed saves back without leaking late responses', async () => {
  const { JSDOM } = require('jsdom');
  const { createRoot } = require('react-dom/client');
  const dom = new JSDOM('<div id="root"></div>');
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  };
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  let user = { id: 1 },
    hook,
    failure = false,
    late;
  const cache = new Map(),
    posts = [];
  const useSWR = (key) => {
    const [, update] = React.useState(0);
    return {
      data: cache.get(key),
      mutate: async (value) => {
        cache.set(key, value);
        update((n) => n + 1);
        return value;
      },
    };
  };
  const imports = (id) => {
    if (id === 'react') return React;
    if (id.endsWith('/useUser')) return { useUser: () => ({ user }) };
    if (id.endsWith('/detailDisclosureOrder')) return helpers;
    if (id === 'swr') return { __esModule: true, default: useSWR };
    if (id === 'axios')
      return {
        __esModule: true,
        default: {
          post: async (endpoint, body) => {
            posts.push({ endpoint, body });
            if (failure) throw Error('save failed');
            if (late) return await late;
            return { data: body.order };
          },
        },
      };
    throw Error(`Unexpected import ${id}`);
  };
  const useOrder = load(
    'src/hooks/useDetailDisclosureOrder.ts',
    imports
  ).default;
  const Harness = () => {
    hook = useOrder();
    return null;
  };
  const root = createRoot(document.getElementById('root'));
  const render = () =>
    React.act(async () => root.render(React.createElement(Harness)));
  try {
    await render();
    const next = [
      'overview',
      'mediaServer',
      'cast',
      'details',
      'crew',
      'subjectTags',
    ];
    await React.act(async () => hook.setOrder(next));
    assert.deepEqual(hook.order, next);
    assert.match(posts[0].endpoint, /\/user\/1\//);
    user = { id: 2 };
    await render();
    assert.deepEqual(
      hook.order,
      helpers.normalizeSeriesDisclosureOrder(undefined)
    );
    user = { id: 1 };
    await render();
    assert.deepEqual(hook.order, next);
    failure = true;
    await React.act(async () => {
      await assert.rejects(hook.setOrder(helpers.seriesDisclosureRoles));
    });
    assert.deepEqual(hook.order, next);
    failure = false;
    let resolveLate;
    late = new Promise((resolve) => (resolveLate = resolve));
    let pending;
    await React.act(async () => {
      pending = hook.setOrder(helpers.seriesDisclosureRoles);
      await Promise.resolve();
    });
    user = { id: 2 };
    await render();
    await React.act(async () => {
      resolveLate({ data: next });
      await pending;
    });
    assert.deepEqual(
      hook.order,
      helpers.normalizeSeriesDisclosureOrder(undefined)
    );
    assert.equal(hook.preferenceKey.includes('/user/2/'), true);
    user = undefined;
    await render();
    assert.equal(hook.canReorder, false);
  } finally {
    await React.act(async () => root.unmount());
    Object.assign(globalThis, previous);
    dom.window.close();
  }
});
