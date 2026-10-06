import LibraryPage from '@app/pages/library';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

interface SwrResponse {
  data?: unknown;
  error?: unknown;
  isLoading?: boolean;
  mutate?: () => unknown;
}

const MANGA_PREFIX = '/api/v1/discover/manga/library';

const state = vi.hoisted(() => ({
  keys: [] as (string | null)[],
  connections: {} as Record<string, unknown>,
  settings: {} as Record<string, unknown>,
  library: {} as SwrResponse,
  manga: {} as SwrResponse,
  listProps: [] as Record<string, unknown>[],
}));

vi.mock('swr', () => ({
  default: (key: string | null) => {
    state.keys.push(key);
    if (key === '/api/v1/integrations/discovery/accounts') {
      return { data: state.connections };
    }
    if (key?.startsWith('/api/v1/discover/manga/library')) return state.manga;
    if (key) return state.library;
    return { data: undefined, error: undefined, isLoading: false };
  },
}));
vi.mock('axios', () => ({ default: { post: vi.fn() } }));
vi.mock('@app/hooks/useSettings', () => ({
  default: () => ({ currentSettings: state.settings }),
}));
vi.mock('@app/components/Common/PageTitle', () => ({ default: () => null }));
vi.mock('@app/components/Common/ListView', () => ({
  default: (props: {
    items: { id: number }[];
    isEmpty: boolean;
    emptyMessage?: string;
  }) => {
    state.listProps.push(props);
    return (
      <div data-testid="manga-list">
        {props.isEmpty
          ? props.emptyMessage
          : props.items.map((item) => item.id).join(',')}
      </div>
    );
  },
}));
vi.mock(
  '@app/components/DiscoveryIntegrations/IdentityMappingControls',
  () => ({ default: () => null })
);
vi.mock(
  '@app/components/DiscoveryIntegrations/IdentityMappingPackControls',
  () => ({ default: () => null })
);
vi.mock('@app/components/DiscoveryIntegrations/TrackingControls', () => ({
  default: () => null,
}));
vi.mock('@app/components/TitleCard/TmdbTitleCard', () => ({
  default: () => null,
}));
vi.mock('next/image', () => ({ default: () => null }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: unknown }) => (
    <a href={href}>{children as React.ReactNode}</a>
  ),
}));

let root: Root;
let host: HTMLDivElement;
let dom: JSDOM;

const mangaPage = (page: number, totalPages: number, ids: number[]) => ({
  data: {
    page,
    totalPages,
    totalResults: ids.length,
    results: ids.map((id) => ({
      id,
      mediaType: 'manga',
      title: `Title ${id}`,
    })),
  },
  error: undefined,
  isLoading: false,
  mutate: vi.fn(),
});

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  state.keys = [];
  state.listProps = [];
  state.connections = { accounts: [], mediaServer: null };
  state.settings = {
    enabledMediaCategories: { manga: true },
    suwayomiEnabled: true,
  };
  state.library = {
    data: { items: [], hasMore: false, allowWrites: false },
    error: undefined,
    isLoading: false,
    mutate: vi.fn(),
  };
  state.manga = mangaPage(1, 1, [7, 3]);
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
        <LibraryPage />
      </IntlProvider>
    )
  );
};

const source = () =>
  host.querySelector<HTMLSelectElement>('#library-source') as HTMLSelectElement;
const mangaOption = () => source().querySelector('option[value="manga"]');
const mangaKeys = () =>
  state.keys.filter((key) => key?.startsWith(MANGA_PREFIX));
const button = (label: string) =>
  [...host.querySelectorAll('button')].find(
    (element) => element.textContent === label
  ) as HTMLButtonElement;
const choose = async (value: string) => {
  await act(async () => {
    source().value = value;
    source().dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
};

it('selects the manga library when nothing else is connected', async () => {
  await render();

  expect(mangaOption()?.textContent).toBe('Manga library (Suwayomi)');
  expect(source().value).toBe('manga');
  expect(mangaKeys().at(-1)).toBe(`${MANGA_PREFIX}?page=1`);
  expect(host.querySelector('[data-testid="manga-list"]')?.textContent).toBe(
    '7,3'
  );
  expect(state.listProps.at(-1)).toMatchObject({ isReachingEnd: true });
  expect(host.querySelector('#library-shelf')).toBeNull();
  expect(host.querySelector('#library-type')).toBeNull();
  expect(host.querySelector('#library-server-library')).toBeNull();
  expect(host.textContent).not.toContain('Connect a tracking account');
  expect(
    state.keys.some((key) =>
      key?.startsWith('/api/v1/integrations/discovery/library/')
    )
  ).toBe(false);
});

it('selects the manga library when the media server is linked but not connected', async () => {
  state.connections = {
    accounts: [],
    mediaServer: { provider: 'plex', connected: false },
  };
  await render();

  expect(source().value).toBe('manga');
});

it('keeps the connected media server as the default source', async () => {
  state.connections = {
    accounts: [{ provider: 'anilist' }],
    mediaServer: { provider: 'jellyfin', connected: true },
  };
  await render();

  expect(source().value).toBe('jellyfin');
  expect(mangaOption()).not.toBeNull();
  expect(mangaKeys()).toEqual([]);
});

it('keeps the first tracking account as the default source', async () => {
  state.connections = { accounts: [{ provider: 'simkl' }], mediaServer: null };
  await render();

  expect(source().value).toBe('simkl');
  expect(host.querySelector('#library-shelf')).not.toBeNull();
});

it.each([
  ['Suwayomi is not configured', { manga: true }, false],
  ['the manga category is off', { manga: false }, true],
])(
  'leaves the manga library out when %s',
  async (_label, enabledMediaCategories, suwayomiEnabled) => {
    state.settings = { enabledMediaCategories, suwayomiEnabled };
    await render();

    expect(mangaOption()).toBeNull();
    expect(source().value).toBe('trakt');
    expect(host.textContent).toContain(
      'Connect a tracking account under Linked Accounts to browse its library.'
    );
    expect(mangaKeys()).toEqual([]);
  }
);

it('switches to the manga library and pages through it', async () => {
  state.connections = {
    accounts: [{ provider: 'anilist' }],
    mediaServer: null,
  };
  state.manga = mangaPage(1, 2, [9]);
  await render();
  expect(source().value).toBe('anilist');
  expect(host.querySelector('#library-shelf')).not.toBeNull();

  await choose('manga');

  expect(source().value).toBe('manga');
  expect(host.querySelector('#library-shelf')).toBeNull();
  expect(host.querySelector('#library-type')).toBeNull();
  expect(mangaKeys().at(-1)).toBe(`${MANGA_PREFIX}?page=1`);
  expect(button('Previous page').disabled).toBe(true);
  expect(button('Next page').disabled).toBe(false);

  state.manga = mangaPage(2, 2, [4]);
  await act(async () => button('Next page').click());

  expect(mangaKeys().at(-1)).toBe(`${MANGA_PREFIX}?page=2`);
  expect(host.textContent).toContain('Page 2');
  expect(button('Next page').disabled).toBe(true);
  expect(button('Previous page').disabled).toBe(false);

  await choose('anilist');

  expect(source().value).toBe('anilist');
  expect(state.keys.at(-1)).toBeNull();
  expect(state.keys.at(-2)).toMatch(
    /^\/api\/v1\/integrations\/discovery\/library\/anilist\?/
  );
  expect(host.querySelector('#library-shelf')).not.toBeNull();
  expect(host.textContent).toContain('Page 1');
});

it('shows the empty message for an empty manga library', async () => {
  state.manga = mangaPage(1, 1, []);
  await render();

  expect(host.querySelector('[data-testid="manga-list"]')?.textContent).toBe(
    'No manga library titles to show.'
  );
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(button('Next page').disabled).toBe(true);
});

it('offers a retry when the manga library cannot be loaded', async () => {
  const mutate = vi.fn();
  state.manga = {
    data: undefined,
    error: new Error('Request failed'),
    isLoading: false,
    mutate,
  };
  await render();

  expect(host.querySelector('[role="alert"]')?.textContent).toContain(
    'Your manga library could not be loaded. Try again.'
  );
  expect(host.querySelector('[data-testid="manga-list"]')).toBeNull();
  await act(async () => button('Retry').click());
  expect(mutate).toHaveBeenCalledTimes(1);
});
