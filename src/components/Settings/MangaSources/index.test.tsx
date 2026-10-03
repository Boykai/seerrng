import MangaSources from '@app/components/Settings/MangaSources';
import type * as QueryParams from '@app/hooks/useUpdateQueryParams';
import type { MangaResolveTitle } from '@server/interfaces/api/mangaResolveInterfaces';
import type { SuwayomiSettingsView } from '@server/interfaces/api/suwayomiInterfaces';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// React DOM checks for DOM events when it loads, so a DOM must exist first.
await vi.hoisted(async () => {
  const { JSDOM } = await import('jsdom');
  const { window } = new JSDOM();
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
});

interface SwrOptions {
  refreshInterval?: number;
  dedupingInterval?: number;
}

const state = vi.hoisted(() => ({
  responses: new Map<string, { data?: unknown; error?: unknown }>(),
  keys: [] as unknown[],
  options: new Map<string, SwrOptions>(),
  mutate: vi.fn(),
  post: vi.fn(),
  addToast: vi.fn(),
  updateQuery: vi.fn(),
  route: vi.fn(),
  back: vi.fn(),
  query: {} as Record<string, string | string[]>,
  settings: {} as Record<string, unknown>,
}));
vi.mock('swr', () => ({
  default: (key: string | null, options?: SwrOptions) => {
    state.keys.push(key);
    if (key) state.options.set(key, options ?? {});
    const response = key ? state.responses.get(key) : undefined;
    return {
      data: response?.data,
      error: response?.error,
      isLoading: Boolean(key) && !response,
      mutate: state.mutate,
    };
  },
}));
vi.mock('axios', () => ({ default: { post: state.post } }));
vi.mock('next/router', () => ({
  useRouter: () => ({
    query: state.query,
    pathname: '/settings/manga-sources',
    asPath: '/settings/manga-sources',
    back: state.back,
  }),
}));
vi.mock('next/link', () => ({
  default: ({
    href,
    className,
    children,
  }: {
    href: string;
    className?: string;
    children: React.ReactNode;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));
vi.mock('next/dynamic', () => ({
  default: () =>
    function TitleDetail(props: {
      anilistId: number;
      instanceId: number;
      confirmSearch?: boolean;
      onClose: () => void;
      onListChange: () => Promise<unknown>;
    }) {
      return (
        <div
          data-testid="title-detail"
          data-anilist-id={props.anilistId}
          data-instance-id={props.instanceId}
          data-confirm-search={String(Boolean(props.confirmSearch))}
        >
          <button
            type="button"
            data-testid="detail-close"
            onClick={props.onClose}
          >
            close
          </button>
          <button
            type="button"
            data-testid="detail-change"
            onClick={() => void props.onListChange()}
          >
            change
          </button>
        </div>
      );
    },
}));
vi.mock('@app/hooks/useUpdateQueryParams', async (importOriginal) => ({
  ...(await importOriginal<typeof QueryParams>()),
  useUpdateQueryParams: () => state.updateQuery,
  useQueryParams: () => state.route,
}));
vi.mock('@app/hooks/useSettings', () => ({
  default: () => ({ currentSettings: state.settings }),
}));
vi.mock('@app/hooks/useToasts', () => ({
  default: () => ({ addToast: state.addToast }),
}));
vi.mock('@app/components/Common/PageTitle', () => ({ default: () => null }));
vi.mock('@app/components/Common/CachedImage', () => ({
  default: ({ src, alt }: { src: string; alt: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img alt={alt} src={src} />
  ),
}));
vi.mock('@app/components/Common/LoadingSpinner', () => ({
  default: () => <div data-testid="loading" />,
}));
vi.mock('@app/pages/_error', () => ({
  default: ({ statusCode }: { statusCode: number }) => (
    <div data-testid="error-page">{statusCode}</div>
  ),
}));
vi.mock('@app/components/Discover/FilterPanel/CompactFilterSelect', () => ({
  CompactSelect: ({
    label,
    value,
    options,
    onChange,
  }: {
    label: string;
    value: string;
    options: { label: string; value: string }[];
    onChange: (value: string) => void;
  }) => (
    <select
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

const API = '/api/v1/manga/resolve';
const LIST = `${API}?take=10&skip=0`;
const INSTANCES = '/api/v1/settings/suwayomi';
const SUMMARIES = '/api/v1/manga?ids=9001%2C9002%2C9003%2C9004';
const PUSH = { shallow: true, scroll: false };

const title = (
  anilistId: number,
  values: Partial<Record<keyof MangaResolveTitle, unknown>> = {}
): MangaResolveTitle =>
  ({
    anilistId,
    instanceId: 0,
    status: 'NEEDS_PICK',
    reason: 'TITLE_MATCHES',
    mangadexUuid: null,
    approved: true,
    requestId: 77,
    candidateCount: 3,
    attempts: 1,
    checkedAt: '2026-10-01T10:00:00.000Z',
    searchedAt: '2026-10-01T10:00:00.000Z',
    nextAttemptAt: '2026-10-02T10:00:00.000Z',
    searchRequestedAt: null,
    lastError: null,
    ...values,
  }) as MangaResolveTitle;

const titles = [
  title(9001),
  title(9002, {
    status: 'AWAITING_APPROVAL',
    reason: null,
    approved: false,
    candidateCount: 0,
    attempts: 0,
    checkedAt: null,
    searchedAt: null,
    nextAttemptAt: null,
  }),
  // The Manga Content settings hide AniList IDs 9003 and 9004.
  title(9003, { status: 'EXCLUDED', reason: 'CONTENT_POLICY' }),
  title(9004, {
    status: 'QUEUED',
    reason: null,
    lastError: 'SOURCE_SEARCH_FAILED',
  }),
];

const page = (results: MangaResolveTitle[], number = 1, pages = 1) => ({
  data: {
    pageInfo: { page: number, pages, pageSize: 10, results: results.length },
    results,
  },
});

const instance = (id: number, name: string): SuwayomiSettingsView =>
  ({ id, name, sourceAllowlist: ['0', '1002'] }) as SuwayomiSettingsView;

const summary = (id: number, posterPath?: string) => ({
  id,
  mediaType: 'manga',
  title: `Catalog Title ${id}`,
  posterPath,
});

const rejected = (status: number, data: unknown) =>
  Object.assign(new Error('Request failed'), { response: { status, data } });

const deferred = () => {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

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
    'HTMLSelectElement',
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
  state.responses.clear();
  state.keys.length = 0;
  state.options.clear();
  state.query = {};
  state.settings = {
    enabledMediaCategories: { manga: true },
    suwayomiEnabled: true,
  };
  for (const mock of [
    state.mutate,
    state.post,
    state.addToast,
    state.updateQuery,
    state.route,
    state.back,
  ]) {
    mock.mockReset();
  }
  state.mutate.mockResolvedValue(undefined);
  state.responses.set(LIST, page(titles));
  state.responses.set(INSTANCES, {
    data: [instance(0, 'Synthetic Server')],
  });
  state.responses.set(SUMMARIES, {
    data: {
      results: [
        summary(9001, 'https://s4.anilist.co/file/synthetic/9001.jpg'),
        summary(9002),
      ],
    },
  });
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
        <MangaSources />
      </IntlProvider>
    )
  );
  await flush();
};

const rows = () => [...host.querySelectorAll('tbody tr')];
const cells = (row: number) => [...rows()[row].querySelectorAll('td')];
const buttonIn = (scope: Element | undefined, text: string) =>
  [...(scope?.querySelectorAll('button') ?? [])].find(
    (button) => button.textContent === text
  );
const rowButtons = () => [
  ...host.querySelectorAll<HTMLButtonElement>('tbody button'),
];
const detail = () => host.querySelector('[data-testid="title-detail"]');
const heading = () => host.querySelector('h3.heading');

const click = async (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  await act(async () => {
    element!.dispatchEvent(
      new dom.window.MouseEvent('click', { bubbles: true })
    );
  });
  await flush();
};

const change = async (select: HTMLSelectElement | null, value: string) => {
  expect(select).toBeTruthy();
  await act(async () => {
    select!.value = value;
    select!.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  await flush();
};

const statusFilter = () =>
  host.querySelector<HTMLSelectElement>('select[aria-label="Status"]');

// JSDOM keeps the focus on a disabled button, so move it away by hand.
const dropFocus = () => {
  const elsewhere = document.createElement('input');
  document.body.append(elsewhere);
  elsewhere.focus();
  elsewhere.remove();
};

describe('MangaSources', () => {
  it('shows a 404 and loads nothing while the manga category is off', async () => {
    state.settings = { enabledMediaCategories: { manga: false } };
    await render();

    expect(host.querySelector('[data-testid="error-page"]')?.textContent).toBe(
      '404'
    );
    expect(state.keys.filter(Boolean)).toEqual([]);
  });

  it('shows a 404 when the server does not offer the list', async () => {
    state.responses.set(LIST, { error: rejected(404, {}) });
    await render();

    expect(host.querySelector('[data-testid="error-page"]')?.textContent).toBe(
      '404'
    );
  });

  it('lists each waiting title with its status, reason and checks', async () => {
    await render();

    expect(heading()?.textContent).toBe('Manga Sources');
    expect(rows()).toHaveLength(4);

    const [name, status, last, next, actions] = cells(0);
    expect(name.textContent).toBe('Catalog Title 9001');
    expect(name.querySelector('a')?.getAttribute('href')).toBe('/manga/9001');
    expect(name.querySelector('img')?.getAttribute('alt')).toBe('');
    expect(name.querySelector('img')?.getAttribute('src')).toBe(
      '/imageproxy/anilist/file/synthetic/9001.jpg'
    );
    expect(status.textContent).toBe('Needs PickOnly title matches were found.');
    expect(last.querySelector('time')?.getAttribute('datetime')).toBe(
      '2026-10-01T10:00:00.000Z'
    );
    expect(next.querySelector('time')?.getAttribute('datetime')).toBe(
      '2026-10-02T10:00:00.000Z'
    );
    expect(
      [...actions.querySelectorAll('button')].map((b) => b.textContent)
    ).toEqual(['Open', 'Search Now']);

    // Nothing was checked yet.
    expect(cells(1)[1].textContent).toBe('Awaiting Approval');
    expect(cells(1)[2].textContent).toBe('');
    expect(cells(1)[3].textContent).toBe('');
    expect(cells(1)[0].querySelector('img')?.getAttribute('src')).toBe(
      '/images/seerr_poster_not_found.png'
    );

    // The titles load in one batch.
    expect(
      state.keys.filter(
        (key) => typeof key === 'string' && key.startsWith('/api/v1/manga?')
      )
    ).toEqual(expect.arrayContaining([SUMMARIES]));
    expect(
      new Set(
        state.keys.filter(
          (key) => typeof key === 'string' && key.startsWith('/api/v1/manga?')
        )
      ).size
    ).toBe(1);
    expect(state.post).not.toHaveBeenCalled();
  });

  it('never explains a missing title and still shows its status', async () => {
    await render();

    expect(cells(2)[0].textContent).toBe(
      'AniList ID 9003 (details unavailable)'
    );
    expect(cells(2)[0].querySelector('a')).toBeNull();
    expect(cells(2)[1].textContent).toBe(
      'ExcludedThe Manga Content settings hide this title.'
    );
    expect(cells(3)[0].textContent).toBe(
      'AniList ID 9004 (details unavailable)'
    );
    expect(cells(3)[1].textContent).toBe('QueuedA source search failed.');
  });

  it('says a title is loading until the titles arrive', async () => {
    state.responses.delete(SUMMARIES);
    await render();

    expect(cells(0)[0].textContent).toBe('Loading…');
    expect(cells(0)[1].textContent).toBe(
      'Needs PickOnly title matches were found.'
    );
  });

  it('shows the loading and error states of the list', async () => {
    state.responses.delete(LIST);
    await render();
    expect(rows()[0].querySelector('[data-testid="loading"]')).not.toBeNull();

    state.responses.set(LIST, { error: rejected(500, {}) });
    await render();
    expect(rows()[0].textContent).toBe(
      'Something went wrong. Please try again.'
    );
  });

  it('names the server only when there are several', async () => {
    state.responses.set(INSTANCES, {
      data: [
        instance(0, 'Synthetic Server'),
        instance(1, 'Synthetic Server Two'),
      ],
    });
    state.responses.set(
      LIST,
      page([title(9001), title(9001, { instanceId: 1 })])
    );
    state.responses.set('/api/v1/manga?ids=9001', {
      data: { results: [summary(9001)] },
    });
    await render();

    expect(cells(0)[0].textContent).toBe('Catalog Title 9001Synthetic Server');
    expect(cells(1)[0].textContent).toBe(
      'Catalog Title 9001Synthetic Server Two'
    );

    await click(buttonIn(cells(1)[4], 'Open'));
    expect(state.route).toHaveBeenCalledWith(
      { anilistId: '9001', instanceId: '1' },
      'push',
      PUSH
    );
  });

  it('filters by status and starts again on the first page', async () => {
    await render();

    expect(
      [...statusFilter()!.options].map((option) => option.textContent)
    ).toEqual([
      'All',
      'Awaiting Approval',
      'Queued',
      'Needs Pick',
      'No Match',
      'Excluded',
    ]);

    state.responses.set(`${LIST}&status=NEEDS_PICK`, page([title(9001)]));
    await change(statusFilter(), 'NEEDS_PICK');

    expect(state.keys).toContain(`${LIST}&status=NEEDS_PICK`);
    expect(state.updateQuery).toHaveBeenCalledWith('page', undefined);
    expect(rows()).toHaveLength(1);
  });

  it('tells an empty list from an empty filter', async () => {
    state.responses.set(LIST, page([], 1, 0));
    await render();
    expect(rows()[0].textContent).toBe(
      'Titles appear here while a manga request waits for a source.'
    );

    state.responses.set(`${LIST}&status=EXCLUDED`, page([], 1, 0));
    await change(statusFilter(), 'EXCLUDED');
    expect(rows()[0].textContent).toBe('No results');
  });

  it('reads the page from the address and steps back from past the end', async () => {
    state.query = { page: '3' };
    state.responses.set(`${API}?take=10&skip=20`, page([], 3, 2));
    await render();

    expect(state.keys).toContain(`${API}?take=10&skip=20`);
    expect(state.updateQuery).toHaveBeenCalledWith('page', '2');
  });

  it('starts again on the first page with a new page size', async () => {
    state.query = { page: '2' };
    await render();

    await change(host.querySelector('nav select'), '25');
    expect(state.updateQuery).toHaveBeenCalledWith('page', undefined);

    state.query = {};
    await render();
    expect(state.keys).toContain(`${API}?take=25&skip=0`);
  });

  it('polls only while a title waits for its queued search', async () => {
    await render();
    expect(state.options.get(LIST)).toEqual({
      refreshInterval: 0,
      dedupingInterval: 2_000,
    });

    state.responses.set(
      LIST,
      page([
        title(9001, { searchRequestedAt: '2026-10-01T11:00:00.000Z' }),
        ...titles.slice(1),
      ])
    );
    await render();
    expect(cells(0)[1].textContent).toBe(
      'Needs PickSearch QueuedOnly title matches were found.'
    );
    expect(state.options.get(LIST)?.refreshInterval).toBe(10_000);

    state.responses.set(LIST, page(titles));
    await render();
    expect(state.options.get(LIST)?.refreshInterval).toBe(0);
  });

  it('searches an approved title at once and locks the list meanwhile', async () => {
    const request = deferred();
    state.post.mockReturnValue(request.promise);
    await render();

    const trigger = buttonIn(cells(0)[4], 'Search Now')!;
    trigger.focus();
    await click(trigger);

    expect(state.post).toHaveBeenCalledWith(`${API}/9001/search`, {
      instanceId: 0,
    });
    expect(rowButtons().every((button) => button.disabled)).toBe(true);
    // A browser drops the focus from the disabled button.
    dropFocus();
    expect(document.activeElement).toBe(document.body);

    await act(async () =>
      request.resolve({ data: { title: titles[0], runStarted: true } })
    );
    await flush();

    expect(state.post).toHaveBeenCalledTimes(1);
    expect(state.addToast).toHaveBeenCalledWith('Search Queued', {
      appearance: 'success',
      autoDismiss: true,
    });
    expect(state.mutate).toHaveBeenCalledTimes(1);
    expect(rowButtons().some((button) => button.disabled)).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it('reports a failed search and reloads the list', async () => {
    state.post.mockRejectedValue(
      rejected(404, {
        code: 'MANGA_RESOLVE_TITLE_NOT_FOUND',
        message: 'raw server text',
      })
    );
    await render();

    await click(buttonIn(cells(0)[4], 'Search Now'));

    expect(state.addToast).toHaveBeenCalledWith(
      'This title was matched or removed in the meantime. The list was refreshed.',
      { appearance: 'error', autoDismiss: true }
    );
    expect(state.mutate).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[data-testid="error-page"]')).toBeNull();
  });

  it('asks in the detail before an unapproved title is searched', async () => {
    await render();

    const trigger = buttonIn(cells(1)[4], 'Search Now')!;
    await click(trigger);

    expect(state.post).not.toHaveBeenCalled();
    expect(state.route).toHaveBeenCalledWith(
      { anilistId: '9002', instanceId: '0' },
      'push',
      PUSH
    );

    state.query = { anilistId: '9002', instanceId: '0' };
    await render();
    expect(detail()?.getAttribute('data-anilist-id')).toBe('9002');
    expect(detail()?.getAttribute('data-confirm-search')).toBe('true');

    // The page pushed the detail, so closing it goes back.
    await click(host.querySelector('[data-testid="detail-close"]'));
    expect(state.back).toHaveBeenCalledTimes(1);
    expect(state.route).toHaveBeenCalledTimes(1);

    state.query = {};
    await render();
    expect(detail()).toBeNull();
    expect(document.activeElement).toBe(trigger);

    // Opening the title again does not ask.
    await click(buttonIn(cells(1)[4], 'Open'));
    state.query = { anilistId: '9002', instanceId: '0' };
    await render();
    expect(detail()?.getAttribute('data-confirm-search')).toBe('false');
  });

  it('asks only for the title whose search was asked for', async () => {
    await render();

    await click(buttonIn(cells(1)[4], 'Search Now'));
    // The address names another title before the detail opened.
    state.query = { anilistId: '9001', instanceId: '0' };
    await render();

    expect(detail()?.getAttribute('data-anilist-id')).toBe('9001');
    expect(detail()?.getAttribute('data-confirm-search')).toBe('false');
  });

  it('opens a linked detail on server 0 and replaces the address on close', async () => {
    state.query = { anilistId: '9001', instanceId: '0' };
    await render();

    expect(detail()?.getAttribute('data-anilist-id')).toBe('9001');
    expect(detail()?.getAttribute('data-instance-id')).toBe('0');
    expect(detail()?.getAttribute('data-confirm-search')).toBe('false');

    // A write in the detail reloads the list.
    await click(host.querySelector('[data-testid="detail-change"]'));
    expect(state.mutate).toHaveBeenCalledTimes(1);

    await click(host.querySelector('[data-testid="detail-close"]'));
    expect(state.back).not.toHaveBeenCalled();
    expect(state.route).toHaveBeenCalledWith(
      { anilistId: undefined, instanceId: undefined },
      'replace',
      PUSH
    );

    state.query = {};
    await render();
    expect(detail()).toBeNull();
    expect(document.activeElement).toBe(heading());
  });

  it.each([
    [{ anilistId: '0', instanceId: '0' }],
    [{ anilistId: '9001' }],
    [{ anilistId: '9001', instanceId: '-1' }],
    [{ anilistId: '9001', instanceId: '2147483648' }],
    [{ anilistId: '1e3', instanceId: '0' }],
    [{ anilistId: '0x10', instanceId: '0' }],
    [{ anilistId: ' 9001', instanceId: '0' }],
    [{ anilistId: ['9001', '9002'], instanceId: '0' }],
  ])('ignores the detail address %j', async (query) => {
    state.query = query;
    await render();

    expect(detail()).toBeNull();
    expect(rows()).toHaveLength(4);
  });
});
