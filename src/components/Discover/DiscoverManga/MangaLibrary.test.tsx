import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import MangaLibrary from './MangaLibrary';

const state = vi.hoisted(() => ({
  discoverCalls: [] as unknown[][],
  restoration: [] as unknown[],
  listProps: [] as Record<string, unknown>[],
  discover: {} as Record<string, unknown>,
}));
vi.mock('@app/hooks/useDiscover', () => ({
  default: (...args: unknown[]) => {
    state.discoverCalls.push(args);
    return state.discover;
  },
}));
vi.mock('@app/hooks/useDiscoverScrollRestoration', () => ({
  default: (options: unknown) => {
    state.restoration.push(options);
  },
}));
vi.mock('@app/hooks/useSearchActivity', () => ({ default: () => false }));
vi.mock('@app/components/Common/PageTitle', () => ({ default: () => null }));
vi.mock('@app/components/Common/ListView', () => ({
  default: (props: { items: { id: number }[]; isEmpty: boolean }) => {
    state.listProps.push(props);
    return (
      <div data-testid="list" data-empty={String(props.isEmpty)}>
        {props.items.map((item) => item.id).join(',')}
      </div>
    );
  },
}));

let root: Root;
let host: HTMLDivElement;
let dom: JSDOM;

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  state.discoverCalls = [];
  state.restoration = [];
  state.listProps = [];
  state.discover = {
    titles: [],
    isEmpty: false,
    isLoadingInitialData: false,
    isLoadingMore: false,
    isReachingEnd: true,
    fetchMore: vi.fn(),
    error: undefined,
    shuffleSeed: 'seed',
  };
});

afterEach(async () => {
  await act(async () => root.unmount());
  dom.window.close();
  vi.unstubAllGlobals();
});

const render = async () => {
  await act(async () =>
    root.render(
      <IntlProvider locale="en">
        <MangaLibrary />
      </IntlProvider>
    )
  );
};

it('lists the manga library with infinite scroll', async () => {
  state.discover = {
    ...state.discover,
    titles: [{ id: 3 }, { id: 1 }],
    isReachingEnd: false,
  };
  await render();

  expect(host.querySelector('[data-testid="page-header"]')?.textContent).toBe(
    'Your Manga Library'
  );
  expect(state.discoverCalls.at(-1)).toEqual([
    '/api/v1/discover/manga/library',
    {},
    {
      hideAvailable: false,
      showErrorToast: false,
      hideErrorWithResults: false,
    },
  ]);
  expect(host.querySelector('[data-testid="list"]')?.textContent).toBe('3,1');
  expect(state.listProps.at(-1)).toMatchObject({
    isReachingEnd: false,
    onScrollBottom: state.discover.fetchMore,
  });
  expect(state.restoration.at(-1)).toMatchObject({
    mediaType: 'manga',
    itemCount: 2,
  });
});

it('shows the list empty state, not an error, for an empty library', async () => {
  state.discover = { ...state.discover, isEmpty: true };
  await render();

  expect(
    host.querySelector('[data-testid="list"]')?.getAttribute('data-empty')
  ).toBe('true');
  expect(host.textContent).not.toContain('unavailable');
});

it('shows the provider message when the library cannot be read', async () => {
  state.discover = {
    ...state.discover,
    error: { response: { data: { message: 'AniList is unavailable.' } } },
  };
  await render();

  expect(host.textContent).toContain('AniList is unavailable.');
  expect(host.querySelector('[data-testid="list"]')).toBeNull();
});

it('shows a fallback message when the failure has none', async () => {
  state.discover = { ...state.discover, error: new Error('Network Error') };
  await render();

  expect(host.textContent).toContain(
    'Your manga library is unavailable right now.'
  );
  expect(host.textContent).not.toContain('Network Error');
});
