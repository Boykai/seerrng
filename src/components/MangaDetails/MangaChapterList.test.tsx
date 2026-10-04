import type {
  MangaChapterPageResponse,
  MangaChapterResult,
} from '@server/interfaces/api/mangaChapterInterfaces';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import MangaChapterList from './MangaChapterList';

interface SwrEntry {
  data?: unknown;
  error?: unknown;
  isValidating?: boolean;
}

const state = vi.hoisted(() => ({
  byKey: {} as Record<string, SwrEntry>,
  keys: [] as string[],
  options: undefined as unknown,
  laggy: undefined as unknown,
  mutate: vi.fn(),
}));
vi.mock('swr', () => ({
  default: (key: string, options?: { keepPreviousData?: boolean }) => {
    state.keys.push(key);
    state.options = options;
    const entry = state.byKey[key] ?? {};
    // keepPreviousData returns the last loaded page until this key has data.
    const data =
      entry.data ?? (options?.keepPreviousData ? state.laggy : undefined);
    if (entry.data !== undefined) state.laggy = entry.data;
    return {
      data,
      error: entry.error,
      isValidating: entry.isValidating ?? false,
      mutate: state.mutate,
    };
  },
}));
vi.mock('@app/components/Common/LoadingSpinner', () => ({
  SmallLoadingSpinner: () => <div data-testid="loading" />,
}));
vi.mock('@app/components/Common/Tooltip', () => ({
  default: ({
    children,
    content,
  }: {
    children: React.ReactNode;
    content: string;
  }) => <span title={content}>{children}</span>,
}));
vi.mock('@app/components/Common/PaginationFooter', () => ({
  default: ({
    defaultPageSize,
    page,
    pageSize,
    totalPages,
    pageSizeOptions,
    onPageChange,
    onPageSizeChange,
  }: {
    defaultPageSize?: number;
    page: number;
    pageSize: number;
    totalPages: number;
    pageSizeOptions?: readonly number[];
    onPageChange: (page: number) => void;
    onPageSizeChange: (pageSize: number) => void;
  }) => (
    <nav
      data-testid="pagination"
      data-default-page-size={defaultPageSize}
      data-page={page}
      data-page-size={pageSize}
      data-pages={totalPages}
      data-options={pageSizeOptions?.join(',')}
    >
      <button
        type="button"
        data-testid="previous"
        onClick={() => onPageChange(page - 1)}
      />
      <button
        type="button"
        data-testid="next"
        onClick={() => onPageChange(page + 1)}
      />
      <button
        type="button"
        data-testid="size-10"
        onClick={() => onPageSizeChange(10)}
      />
    </nav>
  ),
}));

const chapter = (
  values: Partial<MangaChapterResult> = {}
): MangaChapterResult => ({
  number: 12.5,
  name: 'Into the Storm',
  uploadedAt: '2026-01-15T10:00:00.000Z',
  status: 'notRequested',
  ...values,
});

const chapterPage = (
  results: MangaChapterResult[],
  pageInfo: Partial<MangaChapterPageResponse['pageInfo']> = {},
  inLibrary = true
): MangaChapterPageResponse => ({
  inLibrary,
  pageInfo: {
    page: 1,
    pageSize: 50,
    pages: 1,
    results: results.length,
    ...pageInfo,
  },
  results,
});

const key = (page = 1, pageSize = 50) =>
  `/api/v1/manga/30013/chapters?page=${page}&pageSize=${pageSize}`;

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
  state.byKey = {};
  state.keys = [];
  state.options = undefined;
  state.laggy = undefined;
  state.mutate.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  dom.window.close();
  vi.unstubAllGlobals();
});

const render = async () => {
  await act(async () =>
    root.render(
      <IntlProvider locale="en" timeZone="UTC">
        <MangaChapterList mangaId={30013} />
      </IntlProvider>
    )
  );
};

const click = async (testId: string) => {
  const element = host.querySelector(`[data-testid="${testId}"]`);
  expect(element).toBeTruthy();
  await act(async () => {
    element!.dispatchEvent(
      new dom.window.MouseEvent('click', { bubbles: true })
    );
  });
};

const rows = () =>
  [...host.querySelectorAll('tbody tr')].map((row) =>
    [...row.querySelectorAll('td')].map((cell) => cell.textContent)
  );
const pagination = () => host.querySelector('[data-testid="pagination"]');
const message = () => host.querySelector('.page-error-message');

it('loads the first page of 50 in a titled section', async () => {
  await render();

  expect(state.keys).toEqual([key()]);
  expect(state.options).toEqual({ keepPreviousData: true });
  const section = host.querySelector('section');
  expect(section?.getAttribute('aria-labelledby')).toBe(
    'manga-chapter-list-heading'
  );
  expect(host.querySelector('#manga-chapter-list-heading')?.textContent).toBe(
    'Chapters'
  );
  expect(
    [...host.querySelectorAll('th')].map((heading) => heading.textContent)
  ).toEqual(['Chapter', 'Name', 'Uploaded', 'Status', '']);
  expect(host.querySelector('[data-testid="loading"]')).toBeTruthy();
  expect(message()).toBeNull();
  expect(pagination()?.getAttribute('data-page')).toBe('1');
  expect(pagination()?.getAttribute('data-page-size')).toBe('50');
  expect(pagination()?.getAttribute('data-pages')).toBe('1');
  expect(pagination()?.getAttribute('data-default-page-size')).toBe('50');
  expect(pagination()?.getAttribute('data-options')).toBe('10,25,50,100');
});

it('shows the number, name, upload date and state of each chapter', async () => {
  state.byKey[key()] = {
    data: chapterPage([
      chapter({ status: 'available' }),
      chapter({ number: 1000, name: 'Harbor', status: 'requested' }),
      chapter({ number: null, name: '', uploadedAt: null }),
    ]),
  };
  await render();

  expect(host.querySelector('[data-testid="loading"]')).toBeNull();
  expect(rows()).toEqual([
    ['12.5', 'Into the Storm', 'Jan 15, 2026', 'Downloaded', ''],
    ['1000', 'Harbor', 'Jan 15, 2026', 'Requested', ''],
    ['Unknown', '—', '—', 'Not Requested', ''],
  ]);
  expect(
    [...host.querySelectorAll('[data-availability-tone]')].map((value) =>
      value.getAttribute('data-availability-tone')
    )
  ).toEqual(['available', 'processing', 'unavailable']);
  expect(host.querySelector('a')).toBeNull();
});

it('renders only the chapter fields it knows', async () => {
  state.byKey[key()] = {
    data: chapterPage([
      {
        ...chapter(),
        scanlator: 'Sample Group',
        url: 'https://source.example/chapter/1',
        sourceName: 'Sample Source',
      } as MangaChapterResult,
    ]),
  };
  await render();

  expect(rows()).toEqual([
    ['12.5', 'Into the Storm', 'Jan 15, 2026', 'Not Requested', ''],
  ]);
  expect(host.textContent).not.toMatch(/Sample Group|example|Sample Source/);
});

it('links only a verified copy to the existing download route', async () => {
  state.byKey[key()] = {
    data: chapterPage([
      chapter({
        status: 'available',
        download: { requestId: 41, assetId: 'asset id/1' },
      }),
      chapter({ number: 13, status: 'available' }),
      chapter({
        number: null,
        name: 'Extra',
        status: 'available',
        download: { requestId: 42, assetId: 'asset-2' },
      }),
    ]),
  };
  await render();

  const links = [...host.querySelectorAll('a')].map((link) => ({
    href: link.getAttribute('href'),
    download: link.hasAttribute('download'),
    label: link.getAttribute('aria-label'),
    help: link.getAttribute('data-button-help'),
  }));
  expect(links).toEqual([
    {
      href: '/api/v1/request/status/41/downloads/asset%20id%2F1',
      download: true,
      label: 'Download chapter 12.5',
      help: 'Download your copy of this chapter.',
    },
    {
      href: '/api/v1/request/status/42/downloads/asset-2',
      download: true,
      label: 'Download chapter Extra',
      help: 'Download your copy of this chapter.',
    },
  ]);
});

it('pages forward without showing the previous page and starts over on a new page size', async () => {
  state.byKey[key()] = {
    data: chapterPage([chapter()], { pages: 3, results: 101 }),
  };
  await render();
  expect(pagination()?.getAttribute('data-pages')).toBe('3');

  await click('next');

  expect(state.keys.at(-1)).toBe(key(2));
  expect(host.querySelector('[data-testid="loading"]')).toBeTruthy();
  expect(host.textContent).not.toContain('Into the Storm');
  expect(pagination()?.getAttribute('data-page')).toBe('2');
  expect(pagination()?.getAttribute('data-pages')).toBe('3');

  state.byKey[key(2)] = {
    data: chapterPage([chapter({ number: 7, name: 'Second Page' })], {
      page: 2,
      pages: 3,
      results: 101,
    }),
  };
  await render();
  expect(rows()).toEqual([
    ['7', 'Second Page', 'Jan 15, 2026', 'Not Requested', ''],
  ]);

  await click('size-10');

  expect(state.keys.at(-1)).toBe(key(1, 10));
  expect(pagination()?.getAttribute('data-page')).toBe('1');
  expect(pagination()?.getAttribute('data-page-size')).toBe('10');
});

it.each([
  [
    'a library title',
    true,
    'No Chapters',
    'The library has no chapters for this title yet.',
  ],
  [
    'a title outside the library',
    false,
    'Not in the Library Yet',
    'Chapters appear here once this title is in the library.',
  ],
])(
  'explains an empty list for %s',
  async (_case, inLibrary, title, description) => {
    state.byKey[key()] = {
      data: chapterPage([], { results: 0 }, inLibrary),
    };
    await render();

    expect(message()?.getAttribute('data-severity')).toBe('empty');
    expect(message()?.getAttribute('role')).toBe('status');
    expect(message()?.querySelector('h3')?.textContent).toBe(title);
    expect(message()?.querySelector('p')?.textContent).toBe(description);
    expect(host.querySelector('table')).toBeNull();
    expect(pagination()).toBeNull();
    expect(host.textContent).not.toContain('Retry');
  }
);

it.each([
  [503, 'The chapter list could not be loaded right now.'],
  [500, 'The chapter list could not be loaded right now.'],
  [undefined, 'The chapter list could not be loaded right now.'],
  [429, 'Too many requests right now. Try again in a moment.'],
])(
  'shows fixed text with a retry when loading fails with %s',
  async (status, description) => {
    state.byKey[key()] = {
      error: {
        message: 'socket hang up',
        response:
          status === undefined
            ? undefined
            : { status, data: { message: 'Upstream detail' } },
      },
    };
    await render();

    expect(message()?.getAttribute('data-severity')).toBe('error');
    expect(message()?.getAttribute('role')).toBe('alert');
    expect(message()?.querySelector('h3')?.textContent).toBe(
      'Chapters Unavailable'
    );
    expect(message()?.querySelector('p')?.textContent).toBe(description);
    expect(host.textContent).not.toMatch(/Upstream detail|socket hang up/);
    expect(host.querySelector('table')).toBeNull();
    expect(pagination()).toBeNull();

    const retry = host.querySelector(
      'span[title="Load the chapter list again."] button'
    );
    expect(retry?.textContent).toBe('Retry');
    await act(async () => {
      retry!.dispatchEvent(
        new dom.window.MouseEvent('click', { bubbles: true })
      );
    });
    expect(state.mutate).toHaveBeenCalledTimes(1);
  }
);

it('disables the retry while the list reloads', async () => {
  state.byKey[key()] = {
    error: { response: { status: 503 } },
    isValidating: true,
  };
  await render();

  expect(
    host
      .querySelector('span[title="Load the chapter list again."] button')
      ?.hasAttribute('disabled')
  ).toBe(true);
});

it('keeps the loaded rows when a refresh fails', async () => {
  state.byKey[key()] = {
    data: chapterPage([chapter()]),
    error: { response: { status: 503 } },
  };
  await render();

  expect(message()?.getAttribute('data-severity')).toBe('error');
  expect(rows()).toEqual([
    ['12.5', 'Into the Storm', 'Jan 15, 2026', 'Not Requested', ''],
  ]);
  expect(pagination()).toBeTruthy();
});

it('keeps the pages when a page change fails so the reader can page back', async () => {
  state.byKey[key()] = {
    data: chapterPage([chapter()], { pages: 3, results: 101 }),
  };
  state.byKey[key(2)] = { error: { response: { status: 503 } } };
  await render();

  await click('next');

  expect(message()?.getAttribute('data-severity')).toBe('error');
  expect(host.querySelector('table')).toBeNull();
  expect(pagination()?.getAttribute('data-page')).toBe('2');
  expect(pagination()?.getAttribute('data-pages')).toBe('3');

  await click('previous');

  expect(state.keys.at(-1)).toBe(key());
  expect(message()).toBeNull();
  expect(rows()).toEqual([
    ['12.5', 'Into the Storm', 'Jan 15, 2026', 'Not Requested', ''],
  ]);
});

it('moves to the new last page when the list shrinks', async () => {
  state.byKey[key()] = {
    data: chapterPage([chapter()], { pages: 2, results: 60 }),
  };
  state.byKey[key(2)] = {
    data: chapterPage([], { page: 2, pages: 1, results: 40 }),
  };
  await render();

  await click('next');

  expect(state.keys).toContain(key(2));
  expect(state.keys.at(-1)).toBe(key());
  expect(pagination()?.getAttribute('data-page')).toBe('1');
  expect(rows()).toEqual([
    ['12.5', 'Into the Storm', 'Jan 15, 2026', 'Not Requested', ''],
  ]);
});
