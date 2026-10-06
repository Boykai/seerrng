import ReaderDeliverySettings from '@app/components/Settings/ReaderDeliverySettings';
import { JSDOM } from 'jsdom';
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
  mutate: vi.fn(),
  settings: {
    grimmoryUrl: 'https://grimmory.example.test',
    grimmoryUsername: 'shelf-admin',
    grimmoryPassword: '[REDACTED]',
    bookorbitUrl: '',
    bookorbitUsername: '',
    bookorbitPassword: '',
    preferredProvider: 'grimmory',
  },
}));

vi.mock('axios', () => ({
  default: {
    post: state.post,
    put: state.put,
    isAxiosError: (error: unknown) =>
      !!error && typeof error === 'object' && 'isAxiosError' in error,
  },
}));
vi.mock('swr', () => ({
  default: (key: string) => ({
    data: key === '/api/v1/settings/reader-delivery' ? state.settings : [],
    error: undefined,
    mutate: state.mutate,
  }),
}));
vi.mock('@app/hooks/useToasts', () => ({
  default: () => ({ addToast: state.addToast }),
}));

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
  state.post.mockReset();
  state.put.mockReset();
  state.addToast.mockReset();
  state.mutate.mockReset();
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

const render = async () => {
  await act(async () =>
    root.render(
      <IntlProvider locale="en">
        <ReaderDeliverySettings />
      </IntlProvider>
    )
  );
  await flush();
};

const cards = () => [
  ...host.querySelectorAll<HTMLLIElement>('li.settings-service-card'),
];
const card = (name: 'Grimmory' | 'BookOrbit') =>
  cards().find(
    (item) =>
      item.querySelector('.settings-service-title')?.textContent === name
  )!;
const testButton = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === label
  )!;

const click = async (element: Element | undefined) => {
  expect(element).toBeTruthy();
  await act(async () => {
    element!.dispatchEvent(
      new dom.window.MouseEvent('click', { bubbles: true })
    );
  });
  await flush();
};

const type = async (id: string, value: string) => {
  const input = host.querySelector<HTMLInputElement>('#' + id)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      dom.window.HTMLInputElement.prototype,
      'value'
    )!.set!.call(input, value);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  await flush();
};

it('describes each reader service only in its own card', async () => {
  await render();

  const grimmory = card('Grimmory').textContent ?? '';
  const bookorbit = card('BookOrbit').textContent ?? '';
  expect(grimmory).toContain('Grimmory Administrator Username');
  expect(grimmory).toContain('Test Magic Shelf Access');
  expect(grimmory).not.toContain('BookOrbit');
  expect(grimmory).not.toContain('Smart Scope');
  expect(bookorbit).toContain('BookOrbit Account Username');
  expect(bookorbit).toContain('Test Smart Scope Access');
  expect(bookorbit).toContain('BookOrbit has no base-path setting');
  expect(bookorbit).not.toContain('Grimmory');
  expect(bookorbit).not.toContain('Komga');
  expect(bookorbit).not.toContain('Magic Shel');
  expect(
    card('BookOrbit')
      .querySelector<HTMLAnchorElement>('a[href*="smart-scopes"]')
      ?.getAttribute('href')
  ).toBe('https://bookorbit.app/smart-scopes');
});

it('tests the BookOrbit values in the form before they are saved', async () => {
  state.post.mockResolvedValue({
    data: { connected: true, existingGroupingCount: 2 },
  });
  await render();

  await type('bookorbit-url', 'https://bookorbit.example.test');
  await type('bookorbit-username', 'scope-owner');
  await type('bookorbit-password', 'typed-password');
  expect(testButton('Test Smart Scope Access').disabled).toBe(false);
  await click(testButton('Test Smart Scope Access'));

  expect(state.post).toHaveBeenCalledTimes(1);
  expect(state.post).toHaveBeenCalledWith(
    '/api/v1/settings/reader-delivery/connection-test',
    {
      provider: 'bookorbit',
      url: 'https://bookorbit.example.test',
      username: 'scope-owner',
      password: 'typed-password',
    }
  );
  expect(state.put).not.toHaveBeenCalled();
  expect(card('BookOrbit').textContent).toContain(
    'Connected. SeerrNG can manage BookOrbit Smart Scopes with this account and found 2 Smart Scopes.'
  );
});

it('sends the redacted saved password with the saved Grimmory address and account', async () => {
  state.post.mockResolvedValue({
    data: { connected: true, existingGroupingCount: 1 },
  });
  await render();

  await click(testButton('Test Magic Shelf Access'));

  expect(state.post).toHaveBeenCalledWith(
    '/api/v1/settings/reader-delivery/connection-test',
    {
      provider: 'grimmory',
      url: 'https://grimmory.example.test',
      username: 'shelf-admin',
      password: '[REDACTED]',
    }
  );
  expect(card('Grimmory').textContent).toContain('found 1 Magic Shelf.');
});

it('clears a test result when a field changes and drops an answer for older values', async () => {
  state.post.mockResolvedValueOnce({
    data: { connected: true, existingGroupingCount: 0 },
  });
  await render();
  await type('bookorbit-url', 'https://bookorbit.example.test');
  await type('bookorbit-username', 'scope-owner');
  await type('bookorbit-password', 'typed-password');
  await click(testButton('Test Smart Scope Access'));
  expect(card('BookOrbit').textContent).toContain('Connected.');

  await type('bookorbit-username', 'another-owner');
  expect(card('BookOrbit').textContent).not.toContain('Connected.');

  let answer: (value: unknown) => void = () => undefined;
  state.post.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      })
  );
  await click(testButton('Test Smart Scope Access'));
  expect(testButton('Checking BookOrbit…').disabled).toBe(true);
  await type('bookorbit-password', 'changed-password');
  await act(async () =>
    answer({ data: { connected: true, existingGroupingCount: 3 } })
  );
  await flush();

  expect(card('BookOrbit').textContent).not.toContain('Connected.');
  expect(testButton('Test Smart Scope Access').disabled).toBe(false);
});

it('offers to keep the saved password only for the saved address and username', async () => {
  await render();
  const placeholder = () =>
    host.querySelector<HTMLInputElement>('#grimmory-password')!.placeholder;

  expect(placeholder()).toBe('Saved; leave blank to keep it');
  await type('grimmory-password', 'typed');
  await type('grimmory-password', '');
  expect(placeholder()).toBe('Saved; leave blank to keep it');

  await type('grimmory-url', 'https://other.example.test');
  expect(placeholder()).toBe('');
  await type('grimmory-url', 'https://grimmory.example.test');
  expect(placeholder()).toBe('Saved; leave blank to keep it');
  await type('grimmory-username', 'other-admin');
  expect(placeholder()).toBe('');
  expect(
    host.querySelector<HTMLInputElement>('#bookorbit-password')!.placeholder
  ).toBe('');
});

it('shows the failed step under the BookOrbit failure title', async () => {
  state.post.mockRejectedValue({
    isAxiosError: true,
    response: {
      status: 502,
      data: {
        error:
          'BookOrbit refused the sign-in. Check the BookOrbit username and password.',
      },
    },
  });
  await render();
  await type('bookorbit-url', 'https://bookorbit.example.test');
  await type('bookorbit-username', 'scope-owner');
  await type('bookorbit-password', 'typed-password');

  await click(testButton('Test Smart Scope Access'));

  const text = card('BookOrbit').textContent ?? '';
  expect(text).toContain('BookOrbit Connection Test Failed');
  expect(text).toContain(
    'BookOrbit refused the sign-in. Check the BookOrbit username and password.'
  );
  expect(card('Grimmory').textContent).not.toContain('Connection Test Failed');
});
