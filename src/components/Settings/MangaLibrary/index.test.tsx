import type * as QueryParams from '@app/hooks/useUpdateQueryParams';
import { MediaStatus } from '@server/constants/media';
import type {
  MangaLibraryBinding,
  MangaLibraryCandidate,
} from '@server/interfaces/api/mangaLibraryInterfaces';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MangaLibrary from '.';

// React DOM checks for DOM events when it loads, so a DOM must exist first.
await vi.hoisted(async () => {
  const { JSDOM } = await import('jsdom');
  const { window } = new JSDOM();
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', window.document);
});

const state = vi.hoisted(() => ({
  responses: new Map<string, { data?: unknown; error?: unknown }>(),
  keys: [] as unknown[],
  mutate: vi.fn(),
  post: vi.fn(),
  addToast: vi.fn(),
  updateQuery: vi.fn(),
  query: {} as Record<string, string>,
  settings: {} as Record<string, unknown>,
}));
vi.mock('swr', () => ({
  default: (key: string | null) => {
    state.keys.push(key);
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
    pathname: '/settings/manga-library',
    asPath: '/settings/manga-library',
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
    function BindModal(props: {
      libraryTitle: string | null;
      busy: boolean;
      onBind: (anilistId: number) => void;
      onCancel: () => void;
    }) {
      return (
        <div data-testid="bind-modal" data-busy={String(props.busy)}>
          <span>{props.libraryTitle}</span>
          <button
            type="button"
            data-testid="bind-pick"
            onClick={() => props.onBind(555)}
          >
            pick
          </button>
          <button
            type="button"
            data-testid="bind-cancel"
            onClick={props.onCancel}
          >
            cancel
          </button>
        </div>
      );
    },
}));
vi.mock('@app/hooks/useUpdateQueryParams', async (importOriginal) => ({
  ...(await importOriginal<typeof QueryParams>()),
  useUpdateQueryParams: () => state.updateQuery,
}));
vi.mock('@app/hooks/useSettings', () => ({
  default: () => ({ currentSettings: state.settings }),
}));
vi.mock('@app/hooks/useToasts', () => ({
  default: () => ({ addToast: state.addToast }),
}));
vi.mock('@app/components/Common/PageTitle', () => ({ default: () => null }));
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

const CANDIDATES = '/api/v1/manga/library/candidates?take=10&skip=0';
const BINDINGS = '/api/v1/manga/library/bindings?take=10&skip=0&state=ACTIVE';

const page = <T,>(results: T[], page = 1, pages = 1) => ({
  data: {
    pageInfo: { page, pages, pageSize: 10, results: results.length },
    results,
  },
});

const candidate = (
  id: number,
  proposal: MangaLibraryCandidate['proposal']
): MangaLibraryCandidate => ({
  id,
  instanceId: 1,
  suwayomiMangaId: 100 + id,
  sourceId: '9001',
  url: `/private/path/${id}`,
  title: `Sample Manga ${String.fromCharCode(64 + id)}`,
  proposal,
  updatedAt: '2026-10-01T00:00:00.000Z',
});

const proposal = (
  anilistId: number,
  confidence: 'HIGH' | 'MEDIUM' | 'LOW'
): MangaLibraryCandidate['proposal'] =>
  ({ anilistId, confidence, score: 0.9 }) as MangaLibraryCandidate['proposal'];

const candidates = [
  candidate(1, proposal(101, 'HIGH')),
  candidate(2, proposal(102, 'MEDIUM')),
  candidate(3, proposal(103, 'LOW')),
  candidate(4, null),
  // AniList ID 104 is hidden by the Manga Content settings.
  candidate(5, proposal(104, 'HIGH')),
];

const binding = (
  id: number,
  values: Partial<Record<keyof MangaLibraryBinding, unknown>>
): MangaLibraryBinding =>
  ({
    id,
    instanceId: 1,
    sourceId: '9001',
    url: `/private/bound/${id}`,
    suwayomiMangaId: 300 + id,
    title: `Sample Manga ${String.fromCharCode(74 + id)}`,
    anilistId: 200 + id,
    confidence: 'EXACT_LINK',
    matchedBy: 'anilist-tracker',
    origin: 'scan',
    state: 'ACTIVE',
    inLibrary: true,
    availability: MediaStatus.UNKNOWN,
    chapterCount: null,
    downloadCount: null,
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...values,
  }) as MangaLibraryBinding;

const bindings = [
  binding(1, { availability: MediaStatus.AVAILABLE }),
  binding(2, {
    matchedBy: 'mal-tracker',
    confidence: 'TRACKER_LINK',
    availability: MediaStatus.PARTIALLY_AVAILABLE,
  }),
  binding(3, { matchedBy: 'mangadex-link' }),
  binding(4, { matchedBy: 'title', confidence: 'MEDIUM', inLibrary: false }),
  binding(5, { matchedBy: 'manual', confidence: 'MANUAL', state: 'ORPHANED' }),
  binding(6, { matchedBy: 'manual', confidence: 'MANUAL', state: 'REJECTED' }),
];

const summaries = (ids: number[]) => ({
  data: {
    results: ids.map((id) => ({
      id,
      mediaType: 'manga',
      title: `Catalog Title ${id}`,
    })),
  },
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
  ]) {
    mock.mockReset();
  }
  state.responses.set(CANDIDATES, page(candidates));
  state.responses.set(BINDINGS, page(bindings));
  state.responses.set(
    '/api/v1/manga?ids=101%2C102%2C103%2C104',
    summaries([101, 102, 103])
  );
  state.responses.set(
    '/api/v1/manga?ids=201%2C202%2C203%2C204%2C205%2C206',
    summaries([201, 202, 203, 204, 205, 206])
  );
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
        <MangaLibrary />
      </IntlProvider>
    )
  );
  await flush();
};

const tables = () => [...host.querySelectorAll('table')];
const rows = (table: number) => [
  ...tables()[table].querySelectorAll('tbody tr'),
];
const cells = (table: number, row: number) => [
  ...rows(table)[row].querySelectorAll('td'),
];
// Button wraps its children in a span; the inner span is the label. A
// ConfirmButton also renders its hidden confirm text outside that label.
const label = (button: Element) =>
  button.querySelector('span span')?.textContent;
const buttonIn = (element: Element, text: string) =>
  [...element.querySelectorAll('button')].find(
    (button) => label(button) === text
  );
const labels = (element: Element) =>
  [...element.querySelectorAll('button')].map(label);

const click = async (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  await act(async () => {
    element!.dispatchEvent(
      new dom.window.MouseEvent('click', { bubbles: true })
    );
  });
  await flush();
};

const choose = async (label: string, value: string) => {
  const select = host.querySelector<HTMLSelectElement>(
    `select[aria-label="${label}"]`
  )!;
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  await flush();
};

describe('MangaLibrary', () => {
  it('shows a 404 and loads nothing while the manga category is off', async () => {
    state.settings = { enabledMediaCategories: { manga: false } };
    await render();

    expect(host.querySelector('[data-testid="error-page"]')?.textContent).toBe(
      '404'
    );
    expect(state.keys.filter(Boolean)).toEqual([]);
  });

  it('lists proposals with their strength, never preselected', async () => {
    await render();

    expect(cells(0, 0)[0].textContent).toBe('Sample Manga A');
    expect(cells(0, 0)[1].textContent).toBe('Catalog Title 101High Confidence');
    expect(labels(cells(0, 0)[2])).toEqual([
      'Confirm',
      'Choose Title',
      'Reject',
    ]);
    expect(cells(0, 1)[1].textContent).toBe(
      'Catalog Title 102Medium Confidence'
    );
    expect(cells(0, 2)[1].textContent).toBe('Catalog Title 103Weak Guess');
    expect(cells(0, 3)[1].textContent).toBe('No Proposal');
    expect(labels(cells(0, 3)[2])).toEqual(['Choose Title']);
    expect(host.querySelector('a[href="/manga/101"]')?.textContent).toBe(
      'Catalog Title 101'
    );
    // Library titles are text only.
    expect(cells(0, 0)[0].querySelector('a')).toBeNull();
    expect(state.post).not.toHaveBeenCalled();
    expect(host.textContent).not.toMatch(/Confirm All|Select All/);
  });

  it('reads proposal titles in one batch and hides what the content settings hide', async () => {
    await render();

    const reads = state.keys.filter(
      (key): key is string =>
        typeof key === 'string' && key.startsWith('/api/v1/manga?')
    );
    expect(new Set(reads)).toEqual(
      new Set([
        '/api/v1/manga?ids=101%2C102%2C103%2C104',
        '/api/v1/manga?ids=201%2C202%2C203%2C204%2C205%2C206',
      ])
    );
    expect(
      state.keys.some(
        (key) => typeof key === 'string' && /\/api\/v1\/manga\/\d/.test(key)
      )
    ).toBe(false);
    expect(cells(0, 4)[1].textContent).toBe(
      'AniList ID 104 (details unavailable)High Confidence'
    );
    expect(host.querySelector('a[href="/manga/104"]')).toBeNull();
  });

  it('never renders source URLs', async () => {
    await render();

    expect(host.innerHTML).not.toContain('/private/');
  });

  it('confirms a proposal once and refreshes both lists', async () => {
    const request = deferred();
    const reload = deferred();
    state.post.mockReturnValue(request.promise);
    state.mutate.mockReturnValue(reload.promise);
    await render();

    const confirm = buttonIn(rows(0)[0], 'Confirm');
    await act(async () => {
      confirm!.dispatchEvent(
        new dom.window.MouseEvent('click', { bubbles: true })
      );
      confirm!.dispatchEvent(
        new dom.window.MouseEvent('click', { bubbles: true })
      );
    });
    await flush();

    expect(state.post).toHaveBeenCalledTimes(1);
    expect(state.post).toHaveBeenCalledWith(
      '/api/v1/manga/library/candidates/1/confirm',
      { anilistId: 101 }
    );
    expect(labels(cells(0, 0)[2])).toEqual(['Saving…']);
    expect(buttonIn(rows(0)[1], 'Confirm')?.disabled).toBe(true);
    expect(buttonIn(rows(1)[0], 'Choose Title')?.disabled).toBe(true);

    await click(buttonIn(rows(0)[1], 'Confirm'));
    expect(state.post).toHaveBeenCalledTimes(1);

    await act(async () => request.resolve({ data: {} }));
    await flush();

    expect(state.addToast).toHaveBeenCalledWith('Match saved.', {
      appearance: 'success',
      autoDismiss: true,
    });
    expect(state.mutate).toHaveBeenCalledTimes(2);
    // The decided row stays busy until both lists have reloaded.
    expect(labels(cells(0, 0)[2])).toEqual(['Saving…']);
    expect(buttonIn(rows(0)[1], 'Confirm')?.disabled).toBe(true);

    await act(async () => reload.resolve(undefined));
    await flush();

    expect(state.post).toHaveBeenCalledTimes(1);
    expect(buttonIn(rows(0)[1], 'Confirm')?.disabled).toBe(false);
  });

  it('explains a changed proposal without the server text', async () => {
    state.post.mockRejectedValue(
      rejected(409, {
        code: 'MANGA_PROPOSAL_CHANGED',
        message: 'raw upstream text',
      })
    );
    await render();

    await click(buttonIn(rows(0)[1], 'Confirm'));

    expect(state.addToast).toHaveBeenCalledWith(
      'The proposal changed. Check the new proposal and try again.',
      { appearance: 'error', autoDismiss: true }
    );
    expect(host.textContent).not.toContain('raw upstream text');
    expect(state.mutate).toHaveBeenCalledTimes(2);
    expect(buttonIn(rows(0)[1], 'Confirm')?.disabled).toBe(false);
  });

  it('rejects a proposal only after a second click', async () => {
    state.post.mockResolvedValue({ data: {} });
    await render();

    await click(buttonIn(rows(0)[2], 'Reject'));
    expect(state.post).not.toHaveBeenCalled();

    await click(buttonIn(rows(0)[2], 'Reject'));

    expect(state.post).toHaveBeenCalledTimes(1);
    expect(state.post).toHaveBeenCalledWith('/api/v1/manga/library/reject', {
      instanceId: 1,
      sourceId: '9001',
      url: '/private/path/3',
      anilistId: 103,
    });
    expect(state.addToast).toHaveBeenCalledWith('Match rejected.', {
      appearance: 'success',
      autoDismiss: true,
    });
  });

  it('binds a library title by its key to the AniList title picked in the catalog', async () => {
    state.post.mockResolvedValue({ data: {} });
    await render();

    await click(buttonIn(rows(0)[3], 'Choose Title'));
    const modal = host.querySelector('[data-testid="bind-modal"]');
    expect(modal?.textContent).toContain('Sample Manga D');

    await click(host.querySelector('[data-testid="bind-pick"]'));

    expect(state.post).toHaveBeenCalledWith('/api/v1/manga/library/bind', {
      instanceId: 1,
      anilistId: 555,
      sourceId: '9001',
      url: '/private/path/4',
    });
    expect(host.querySelector('[data-testid="bind-modal"]')).toBeNull();
  });

  it('keeps the title picker open when a bind fails', async () => {
    state.post.mockRejectedValue(
      rejected(502, {
        code: 'MANGA_SUWAYOMI_LOOKUP_FAILED',
        message: 'raw upstream text',
        suwayomiCode: 'TIMEOUT',
      })
    );
    await render();

    await click(buttonIn(rows(1)[0], 'Choose Title'));
    await click(host.querySelector('[data-testid="bind-pick"]'));

    expect(state.addToast).toHaveBeenCalledWith(
      'Could not reach Suwayomi; nothing was changed. (TIMEOUT)',
      { appearance: 'error', autoDismiss: true }
    );
    expect(
      host
        .querySelector('[data-testid="bind-modal"]')
        ?.getAttribute('data-busy')
    ).toBe('false');
  });

  it('points to the Jobs page while the queue is empty', async () => {
    state.responses.set(CANDIDATES, page([], 1, 0));
    await render();

    expect(cells(0, 0)[0].textContent).toBe('No Titles to Review');
    const jobs = host.querySelector('a[href="/settings/jobs"]');
    expect(jobs?.textContent).toBe('Jobs & Cache');
    expect(jobs?.parentElement?.textContent).toContain('Manga Library Scan');
    expect(jobs?.parentElement?.textContent).not.toMatch(/\d/);
  });

  it('filters the queue by strength from the first page', async () => {
    await render();

    await choose('Confidence', 'LOW');

    expect(state.keys).toContain(`${CANDIDATES}&confidence=LOW`);
    expect(state.updateQuery).toHaveBeenCalledWith('queuePage', undefined);
  });

  it('steps back when a decision empties the last page', async () => {
    state.query = { queuePage: '3' };
    state.responses.set(
      '/api/v1/manga/library/candidates?take=10&skip=20',
      page([], 3, 2)
    );
    await render();

    expect(state.updateQuery).toHaveBeenCalledWith('queuePage', '2');
  });

  it('says in words how each title was matched and credits MangaDex', async () => {
    await render();

    expect(
      rows(1).map((row) => row.querySelectorAll('td')[2].textContent)
    ).toEqual([
      'AniList Tracker Link',
      'MyAnimeList Tracker Link',
      'Matched with data from MangaDex',
      'Confirmed by an AdminMedium Confidence',
      'Chosen by an Admin',
      'Chosen by an Admin',
    ]);
    const credits = host.querySelectorAll('a[href="https://mangadex.org/"]');
    expect(credits).toHaveLength(1);
    expect(rows(1)[2].contains(credits[0])).toBe(true);
    expect(credits[0].getAttribute('target')).toBe('_blank');
    expect(credits[0].getAttribute('rel')).toBe('noopener noreferrer');
    expect(host.querySelector('img')).toBeNull();
  });

  it('shows availability and the actions each binding state allows', async () => {
    await render();

    expect(
      rows(1).map((row) => row.querySelectorAll('td')[3].textContent)
    ).toEqual([
      'Available',
      'Partially Available',
      'In Suwayomi Library',
      'Active',
      'Not in Library',
      'Rejected',
    ]);
    expect(rows(1).map((row) => labels(row.querySelectorAll('td')[4]))).toEqual(
      [
        ['Choose Title', 'Reject'],
        ['Choose Title', 'Reject'],
        ['Choose Title', 'Reject'],
        ['Choose Title', 'Reject'],
        ['Reject'],
        ['Choose Title'],
      ]
    );
    expect(cells(1, 0)[1].querySelector('a')?.getAttribute('href')).toBe(
      '/manga/201'
    );
  });

  it('rejects a binding with its own AniList ID', async () => {
    state.post.mockResolvedValue({ data: {} });
    await render();

    await click(buttonIn(rows(1)[4], 'Reject'));
    await click(buttonIn(rows(1)[4], 'Reject'));

    expect(state.post).toHaveBeenCalledWith('/api/v1/manga/library/reject', {
      instanceId: 1,
      sourceId: '9001',
      url: '/private/bound/5',
      anilistId: 205,
    });
  });
});
