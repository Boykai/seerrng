import SuwayomiModal from '@app/components/Settings/Suwayomi/SuwayomiModal';
import { REDACTED_SECRET } from '@app/utils/secret';
import type * as HeadlessUi from '@headlessui/react';
import type { SuwayomiSettingsView } from '@server/interfaces/api/suwayomiInterfaces';
import { JSDOM } from 'jsdom';
import { randomUUID } from 'node:crypto';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// React DOM checks for the input event when it loads, so a DOM must exist
// before React is imported for typed text to reach the change handlers.
await vi.hoisted(async () => {
  const { JSDOM } = await import('jsdom');
  const { window } = new JSDOM();
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
});

const state = vi.hoisted(() => ({
  post: vi.fn(),
  put: vi.fn(),
  addToast: vi.fn(),
  onClose: vi.fn(),
  onSave: vi.fn(),
}));
vi.mock('axios', () => ({ default: { post: state.post, put: state.put } }));
vi.mock('@app/hooks/useToasts', () => ({
  default: () => ({ addToast: state.addToast }),
}));
vi.mock('@headlessui/react', async (importOriginal) => ({
  ...(await importOriginal<typeof HeadlessUi>()),
  Transition: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@app/components/Common/Modal', () => ({
  default: (props: {
    title: string;
    children: React.ReactNode;
    okText: string;
    okDisabled: boolean;
    onOk: () => void;
    secondaryText: string;
    secondaryDisabled: boolean;
    onSecondary: () => void;
    onCancel: () => void;
  }) => (
    <div>
      <h2>{props.title}</h2>
      {props.children}
      <button
        type="button"
        data-testid="modal-ok-button"
        disabled={props.okDisabled}
        onClick={props.onOk}
      >
        {props.okText}
      </button>
      <button
        type="button"
        data-testid="modal-secondary-button"
        disabled={props.secondaryDisabled}
        onClick={props.onSecondary}
      >
        {props.secondaryText}
      </button>
      <button
        type="button"
        data-testid="modal-cancel-button"
        onClick={props.onCancel}
      >
        Cancel
      </button>
    </div>
  ),
}));

const view: SuwayomiSettingsView = {
  id: 1,
  name: 'Suwayomi',
  hostname: 'suwayomi.test',
  port: 4567,
  useSsl: false,
  baseUrl: '',
  isDefault: true,
  authMode: 'UI_LOGIN',
  username: 'reader',
  password: REDACTED_SECRET,
  sourceAllowlist: [],
  preferredLanguages: [],
  scanlatorPreference: [],
  requireCbz: true,
};

const sources = [
  {
    id: '1001',
    name: 'Source A',
    displayName: 'Source A (EN)',
    lang: 'en',
    contentWarning: 'SAFE',
    hasUpdate: false,
    isObsolete: false,
  },
  {
    id: '1002',
    name: 'Source B',
    displayName: 'Source B',
    lang: 'ja',
    contentWarning: 'NSFW',
    hasUpdate: true,
    isObsolete: false,
  },
  {
    id: '1003',
    name: 'Source C',
    displayName: 'Source C (EN)',
    lang: 'en',
    contentWarning: 'MIXED',
    hasUpdate: false,
    isObsolete: true,
  },
];

const passed = (overrides: Record<string, unknown> = {}) => ({
  data: {
    success: true,
    authMode: 'UI_LOGIN',
    version: 'v2.4.2366',
    capabilities: { supported: true, missingFields: [] },
    health: {
      downloaderState: 'STOPPED',
      queueLength: 0,
      queueErrors: 0,
      sourceCount: sources.length,
      downloadAsCbz: true,
    },
    warnings: [],
    sources,
    ...overrides,
  },
});

const rejected = (status: number, data: unknown) =>
  Object.assign(new Error('Request failed'), { response: { status, data } });

let dom: JSDOM;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  for (const key of [
    'window',
    'document',
    'Element',
    'Node',
    'HTMLElement',
    'HTMLButtonElement',
    'HTMLInputElement',
    'MutationObserver',
    'Event',
  ]) {
    vi.stubGlobal(
      key,
      key === 'window' ? dom.window : dom.window[key as keyof Window]
    );
  }
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  for (const mock of Object.values(state)) {
    mock.mockReset();
  }
});
afterEach(async () => {
  await act(async () => root.unmount());
  dom.window.close();
  vi.unstubAllGlobals();
});

const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

const render = async (suwayomi: SuwayomiSettingsView | null = null) => {
  await act(async () =>
    root.render(
      <IntlProvider locale="en">
        <SuwayomiModal
          suwayomi={suwayomi}
          onClose={state.onClose}
          onSave={state.onSave}
        />
      </IntlProvider>
    )
  );
  await flush();
};

const button = (testId: string) =>
  host.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!;
const field = (id: string) =>
  host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`)!;
const text = () => host.textContent ?? '';

const click = async (element: Element | null) => {
  expect(element).toBeTruthy();
  await act(async () => {
    element!.dispatchEvent(
      new dom.window.MouseEvent('click', { bubbles: true })
    );
  });
  await flush();
};

const type = async (id: string, value: string) => {
  const input = field(id);
  const prototype =
    input instanceof dom.window.HTMLTextAreaElement
      ? dom.window.HTMLTextAreaElement.prototype
      : dom.window.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(
      input,
      value
    );
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  await flush();
};

const runTest = () => click(button('modal-secondary-button'));
const save = () => click(button('modal-ok-button'));
const saveDisabled = () => button('modal-ok-button').disabled;

const cards = () =>
  [...host.querySelectorAll('.settings-library-card')].map(
    (card) => card.textContent
  );
const circle = (label: string) =>
  host.querySelector<HTMLButtonElement>(
    `.settings-library-card button[aria-label="${label}"]`
  );

it('keeps Save disabled until a test passes, then saves the detected auth mode', async () => {
  const password = randomUUID();
  await render();
  expect(saveDisabled()).toBe(true);
  expect(button('modal-secondary-button').disabled).toBe(true);
  expect(field('password').type).toBe('password');
  expect(field('password').getAttribute('autocomplete')).toBe('new-password');
  expect(field('username').getAttribute('autocomplete')).toBe('off');

  await type('name', 'Manga');
  await type('hostname', ' suwayomi.test ');
  await type('username', 'reader');
  await type('password', password);
  expect(button('modal-secondary-button').disabled).toBe(false);
  expect(saveDisabled()).toBe(true);

  state.post.mockResolvedValueOnce(
    passed({
      authMode: 'BASIC_AUTH',
      warnings: [{ code: 'BASIC_AUTH_IN_USE' }],
    })
  );
  await runTest();

  expect(state.post).toHaveBeenCalledWith(
    '/api/v1/settings/suwayomi/test',
    {
      hostname: 'suwayomi.test',
      port: 4567,
      useSsl: false,
      baseUrl: '',
      username: 'reader',
      password,
      requireCbz: true,
      sourceAllowlist: [],
    },
    expect.objectContaining({ signal: expect.anything() })
  );
  expect(text()).toContain('Basic Auth');
  expect(text()).toContain('v2.4.2366');
  expect(text()).toContain(
    'Suwayomi uses basic authentication. UI login is recommended.'
  );
  expect(state.addToast).toHaveBeenCalledWith(
    'Suwayomi connection established successfully!',
    expect.objectContaining({ appearance: 'success' })
  );
  expect(saveDisabled()).toBe(false);

  state.post.mockResolvedValueOnce({ data: {} });
  await save();

  expect(state.post).toHaveBeenLastCalledWith('/api/v1/settings/suwayomi', {
    name: 'Manga',
    hostname: 'suwayomi.test',
    port: 4567,
    useSsl: false,
    baseUrl: '',
    authMode: 'BASIC_AUTH',
    username: 'reader',
    password,
    sourceAllowlist: [],
    preferredLanguages: [],
    scanlatorPreference: [],
    requireCbz: true,
  });
  expect(state.onSave).toHaveBeenCalledTimes(1);
});

it('saves a stored server with its stored auth mode and password before any test', async () => {
  await render(view);
  expect(field('password').value).toBe(REDACTED_SECRET);
  expect(saveDisabled()).toBe(false);

  await type('name', 'Renamed');
  await type('preferredLanguages', 'en, ja');
  await type('scanlatorPreference', 'Group One\nGroup Two');
  expect(saveDisabled()).toBe(false);

  state.put.mockResolvedValueOnce({ data: view });
  await save();

  expect(state.put).toHaveBeenCalledTimes(1);
  const [url, body] = state.put.mock.calls[0];
  expect(url).toBe('/api/v1/settings/suwayomi/1');
  expect(body).toMatchObject({
    name: 'Renamed',
    authMode: 'UI_LOGIN',
    password: REDACTED_SECRET,
    preferredLanguages: ['en', 'ja'],
    scanlatorPreference: ['Group One', 'Group Two'],
  });
  expect(body).not.toHaveProperty('id');
  expect(body).not.toHaveProperty('isDefault');
  expect(state.onSave).toHaveBeenCalledTimes(1);
});

it('tests a stored server by id and clears its password when the address changes', async () => {
  await render(view);
  state.post.mockResolvedValueOnce(passed());
  await runTest();

  expect(state.post.mock.calls[0][1]).toMatchObject({
    id: 1,
    username: 'reader',
    password: REDACTED_SECRET,
  });
  expect(text()).toContain('v2.4.2366');

  await type('hostname', 'other.test');

  expect(field('password').value).toBe('');
  expect(saveDisabled()).toBe(true);
  expect(text()).not.toContain('v2.4.2366');
});

it('resets validation but keeps the stored password when Require CBZ changes', async () => {
  await render(view);
  await click(host.querySelector('#requireCbz'));

  expect(field('password').value).toBe(REDACTED_SECRET);
  expect(saveDisabled()).toBe(true);
});

it('selects the stored-password marker on focus so typing replaces it', async () => {
  await render(view);
  const password = field('password') as HTMLInputElement;
  await act(async () => password.focus());

  expect(password.selectionStart).toBe(0);
  expect(password.selectionEnd).toBe(REDACTED_SECRET.length);
});

it('shows only mapped text for a failed test with partial diagnostics', async () => {
  await render();
  await type('hostname', 'suwayomi.test');
  state.post.mockRejectedValueOnce(
    rejected(502, {
      success: false,
      code: 'SUWAYOMI_UNSUPPORTED_SERVER',
      message: 'upstream GraphQL error token=abc123',
      authMode: 'UI_LOGIN',
      version: 'v2.0.1',
      missingFields: ['privateFieldName'],
      warnings: [
        { code: 'BELOW_PINNED_REVISION' },
        { code: 'INTROSPECTION_UNAVAILABLE' },
      ],
      stack: 'Error: token=abc123',
    })
  );
  await runTest();

  const shown = text();
  expect(shown).toContain(
    'This Suwayomi server lacks features SeerrNG needs. Update Suwayomi to v2.3.2223 or later.'
  );
  expect(shown).toContain('UI Login');
  expect(shown).toContain('v2.0.1');
  expect(shown.indexOf('older than the one')).toBeLessThan(
    shown.indexOf('refused the schema check')
  );
  for (const leak of ['upstream', 'GraphQL', 'token', 'abc123', 'private']) {
    expect(shown).not.toContain(leak);
  }
  expect(state.addToast).toHaveBeenCalledTimes(1);
  expect(state.addToast).toHaveBeenCalledWith(
    'Failed to connect to Suwayomi.',
    expect.objectContaining({ appearance: 'error' })
  );
  expect(saveDisabled()).toBe(true);
});

it('shows the fixed message of an unknown code and a generic text without a code', async () => {
  await render();
  await type('hostname', 'suwayomi.test');
  state.post.mockRejectedValueOnce(
    rejected(502, {
      success: false,
      code: 'SUWAYOMI_SOMETHING_NEW',
      message: 'A fixed English message.',
      detail: 'token-xyz',
      warnings: [],
    })
  );
  await runTest();
  expect(text()).toContain('A fixed English message.');
  expect(text()).not.toContain('token-xyz');

  state.post.mockRejectedValueOnce(
    rejected(400, {
      message: 'request/body must NOT have additional properties',
      errors: [{ path: '.body.id' }],
    })
  );
  await runTest();
  expect(text()).toContain('Failed to connect to Suwayomi.');
  expect(text()).not.toContain('request/body');
  expect(text()).not.toContain('A fixed English message.');

  state.post.mockRejectedValueOnce(new Error('Network Error'));
  await runTest();
  expect(text()).toContain('Failed to connect to Suwayomi.');
  expect(text()).not.toContain('Network Error');
  expect(state.addToast).toHaveBeenCalledTimes(3);
});

it('maps a refused test request to its code', async () => {
  await render(view);
  state.post.mockRejectedValueOnce(
    rejected(400, {
      code: 'SUWAYOMI_PASSWORD_REQUIRED',
      message: 'Fixed.',
    })
  );
  await runTest();

  expect(text()).toContain(
    'Enter the password again: the server address or username changed.'
  );
  expect(text()).not.toContain('Fixed.');
  expect(saveDisabled()).toBe(true);
});

it('shows disabled authentication as its own error ahead of the other warnings', async () => {
  await render();
  await type('name', 'Manga');
  await type('hostname', 'suwayomi.test');
  state.post.mockResolvedValueOnce(
    passed({
      authMode: 'NONE',
      warnings: [
        { code: 'AUTH_DISABLED' },
        { code: 'CBZ_DISABLED' },
        { code: 'QUEUE_ERRORS', count: 2 },
        { code: 'SOURCE_UPDATE_AVAILABLE', sourceIds: ['1002'] },
      ],
    })
  );
  await runTest();

  const authAlert = [...host.querySelectorAll('.bg-red-600')].find((alert) =>
    alert.textContent?.includes('Authentication is disabled')
  );
  expect(authAlert?.textContent).toContain('No Authentication');
  const items = [...host.querySelectorAll('li')].map(
    (item) => item.textContent
  );
  expect(items.slice(0, 3)).toEqual([
    'Suwayomi does not save downloads as CBZ files. CBZ downloads are recommended.',
    '2 downloads in the Suwayomi queue failed.',
    'Updates are available for: Source B.',
  ]);
  expect(
    authAlert!.compareDocumentPosition(host.querySelector('li')!) &
      dom.window.Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy();
  expect(saveDisabled()).toBe(false);

  state.post.mockResolvedValueOnce({ data: {} });
  await save();
  expect(state.post.mock.calls[1][1]).toMatchObject({ authMode: 'NONE' });
});

it('shows a busy test and aborts it on cancel without a toast', async () => {
  let signal: AbortSignal | undefined;
  state.post.mockImplementationOnce(
    (_url: string, _body: unknown, config: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        signal = config.signal;
        signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' }))
        );
      })
  );
  await render(view);
  await runTest();

  expect(button('modal-secondary-button').textContent).toBe('Testing…');
  expect(button('modal-secondary-button').disabled).toBe(true);
  expect(saveDisabled()).toBe(true);

  await click(button('modal-cancel-button'));

  expect(signal?.aborted).toBe(true);
  expect(state.onClose).toHaveBeenCalledTimes(1);
  expect(state.addToast).not.toHaveBeenCalled();
  expect(text()).not.toContain('Failed to connect');
});

it('ignores a test that finishes after a connection field changed', async () => {
  let finish: (value: unknown) => void = () => undefined;
  state.post.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  await render();
  await type('name', 'Manga');
  await type('hostname', 'suwayomi.test');
  await runTest();
  await type('port', '4568');

  expect(button('modal-secondary-button').disabled).toBe(false);
  await act(async () => finish(passed()));
  await flush();

  expect(state.addToast).not.toHaveBeenCalled();
  expect(text()).not.toContain('v2.4.2366');
  expect(saveDisabled()).toBe(true);
});

it('orders, filters and marks sources, and saves them in priority order', async () => {
  await render({ ...view, sourceAllowlist: ['1003', '1009'] });
  expect(text()).toContain('Run a test to load the source list.');
  expect(cards()).toEqual(['1003Priority 1', '1009Priority 2']);
  expect(host.querySelector('#sourceFilter')).toBeNull();

  state.post.mockResolvedValueOnce(passed());
  await runTest();
  expect(text()).not.toContain('Run a test to load the source list.');
  expect(cards()).toEqual([
    'Source C (EN)Priority 1ObsoleteMixed',
    '1009Priority 2Missing',
    'Source A (EN)Safe',
    'Source BUpdate AvailableNSFWJA',
  ]);

  await click(circle('Source B'));
  expect(cards()[2]).toBe('Source BPriority 3Update AvailableNSFWJA');

  await type('sourceFilter', 'ja');
  expect(cards()).toEqual(['Source BPriority 3Update AvailableNSFWJA']);
  await type('sourceFilter', 'nothing matches');
  expect(cards()).toEqual([]);
  expect(text()).toContain('No results');
  await type('sourceFilter', '');
  expect(cards()).toHaveLength(4);
  expect(saveDisabled()).toBe(false);

  state.put.mockResolvedValueOnce({ data: view });
  await save();
  expect(state.put.mock.calls[0][1]).toMatchObject({
    sourceAllowlist: ['1003', '1009', '1002'],
  });
});

it('stops offering sources at the allowlist limit', async () => {
  const full = Array.from({ length: 200 }, (_, i) => String(i + 1));
  await render({ ...view, sourceAllowlist: full });
  state.post.mockResolvedValueOnce(passed());
  await runTest();

  expect(text()).toContain('You can select up to 200 sources.');
  expect(circle('Source A (EN)')?.disabled).toBe(true);
  expect(circle('200')?.disabled).toBe(false);

  await click(circle('200'));
  expect(text()).not.toContain('You can select up to 200 sources.');
  expect(circle('Source A (EN)')?.disabled).toBe(false);
});

it('reports a refused save by its code or a generic text', async () => {
  await render(view);
  state.put.mockRejectedValueOnce(
    rejected(409, { code: 'SUWAYOMI_INSTANCE_LIMIT', message: 'Fixed.' })
  );
  await save();
  expect(state.addToast).toHaveBeenLastCalledWith(
    'Only one Suwayomi server can be configured.',
    expect.objectContaining({ appearance: 'error' })
  );

  state.put.mockRejectedValueOnce(
    rejected(404, { status: 404, message: 'Not Found' })
  );
  await save();
  expect(state.addToast).toHaveBeenLastCalledWith(
    'Failed to save the Suwayomi server.',
    expect.objectContaining({ appearance: 'error' })
  );
  expect(state.onSave).not.toHaveBeenCalled();
});
