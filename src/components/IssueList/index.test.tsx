import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import IssueList from '.';

const state = vi.hoisted(() => ({
  keys: [] as (string | null)[],
  pinValues: [] as unknown[],
  settings: {} as Record<string, unknown>,
}));
vi.mock('swr', () => ({
  default: (key: string | null) => {
    state.keys.push(key);
    return key?.startsWith('/api/v1/issue?')
      ? {
          data: {
            pageInfo: { pages: 1, pageSize: 10, results: 0, page: 1 },
            results: [],
            counts: { all: 0, open: 0, resolved: 0 },
          },
          error: undefined,
          isValidating: false,
        }
      : {};
  },
}));
vi.mock('next/router', () => ({
  useRouter: () => ({
    query: {},
    pathname: '/issues',
    asPath: '/issues',
    replace: vi.fn(),
    push: vi.fn(),
  }),
}));
vi.mock('@app/components/Common/PageTitle', () => ({ default: () => null }));
vi.mock('@app/components/Common/LoadingSpinner', () => ({
  default: () => null,
}));
vi.mock('@app/components/Common/PaginationFooter', () => ({
  default: () => null,
}));
vi.mock('@app/components/IssueList/IssueItem', () => ({
  default: () => null,
}));
vi.mock('@app/components/IssueList/FocusedIssue', () => ({
  default: () => null,
}));
vi.mock('@app/components/Discover/NetworkSlider', () => ({ tvNetworks: [] }));
vi.mock('@app/components/Discover/StudioSlider', () => ({ studios: [] }));
vi.mock('@app/components/Discover/FilterPanel/CompactFilterSelect', () => ({
  CompactSelect: ({ label }: { label: string }) => (
    <span data-testid="compact-select">{label}</span>
  ),
  FilterResetButton: ({ label }: { label: string }) => (
    <button type="button">{label}</button>
  ),
  getFilterToggleButtonClass: () => '',
}));
vi.mock('@app/components/Discover/PinnedFilterSection', () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <section data-testid="media-filters">{children}</section>
  ),
}));
vi.mock('@app/components/Discover/MediaFilterOption', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@app/hooks/useMediaFilterPin', () => ({
  default: ({ values }: { values: unknown }) => {
    state.pinValues.push(values);
    return { available: true, busy: false, error: false, toggle: vi.fn() };
  },
}));
vi.mock('@app/hooks/useSearchActivity', () => ({
  useSearchActivityReporter: () => undefined,
}));
vi.mock('@app/hooks/useSettings', () => ({
  default: () => ({ currentSettings: state.settings }),
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
  state.keys = [];
  state.pinValues = [];
  state.settings = { enabledMediaCategories: { manga: true } };
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
        <IssueList />
      </IntlProvider>
    )
  );
};

const mediaFilterButtons = () => [
  ...host.querySelectorAll<HTMLButtonElement>(
    '[data-testid="media-filters"] button'
  ),
];

const selectMediaFilter = async (label: string) => {
  const button = mediaFilterButtons().find(
    (candidate) => candidate.textContent === label
  );
  await act(async () => {
    button!.dispatchEvent(
      new dom.window.MouseEvent('click', { bubbles: true })
    );
  });
  return button;
};

const selectLabels = () =>
  [...host.querySelectorAll('[data-testid="compact-select"]')].map(
    (select) => select.textContent
  );

const lastIssueQuery = () =>
  new URLSearchParams(
    state.keys
      .filter((key) => key?.startsWith('/api/v1/issue?'))
      .at(-1)!
      .split('?')[1]
  );

it('offers the manga issue filter only while manga is enabled', async () => {
  await render();

  expect(mediaFilterButtons().map((button) => button.textContent)).toContain(
    'Manga'
  );
  expect(state.pinValues.at(-1)).toContain('manga');

  state.settings = { enabledMediaCategories: { manga: false } };
  await render();

  expect(
    mediaFilterButtons().map((button) => button.textContent)
  ).not.toContain('Manga');
  expect(state.pinValues.at(-1)).not.toContain('manga');

  state.settings = {};
  await render();

  expect(
    mediaFilterButtons().map((button) => button.textContent)
  ).not.toContain('Manga');
});

it('requests manga issues without year or genre filters', async () => {
  await render();

  await selectMediaFilter('Books');
  expect(selectLabels()).toEqual(
    expect.arrayContaining(['First Published', 'Genres'])
  );

  const mangaFilter = await selectMediaFilter('Manga');

  expect(mangaFilter?.getAttribute('aria-pressed')).toBe('true');
  expect(selectLabels()).not.toContain('Genres');
  expect(selectLabels()).not.toContain('Release Date');
  expect(lastIssueQuery().get('mediaType')).toBe('manga');
  expect(lastIssueQuery().has('releaseYear')).toBe(false);
  expect(lastIssueQuery().has('genre')).toBe(false);
});
