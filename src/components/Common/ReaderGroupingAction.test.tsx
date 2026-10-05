import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ReaderGroupingAction from './ReaderGroupingAction';

const state = vi.hoisted(() => ({
  allowed: true,
  settings: { preferredProvider: 'grimmory' },
  groupings: [] as Record<string, unknown>[],
  post: vi.fn(),
  mutate: vi.fn(),
}));

vi.mock('axios', () => ({
  default: {
    post: state.post,
    isAxiosError: (error: unknown) =>
      !!error && typeof error === 'object' && '_isAxiosError' in error,
  },
}));
vi.mock('swr', () => ({
  default: (key: string | null) => ({
    data:
      key === '/api/v1/settings/reader-delivery'
        ? state.settings
        : key === '/api/v1/settings/reader-delivery/groupings'
          ? state.groupings
          : undefined,
    mutate: state.mutate,
  }),
}));
vi.mock('@app/hooks/useUser', () => ({
  Permission: { ADMIN: 2 },
  useUser: () => ({ hasPermission: () => state.allowed }),
}));

let dom: JSDOM;
let root: Root;

beforeEach(() => {
  dom = new JSDOM(
    '<!doctype html><html><body><div id="root"></div></body></html>',
    {
      url: 'http://localhost',
    }
  );
  for (const key of [
    'window',
    'document',
    'Element',
    'Node',
    'HTMLElement',
    'MutationObserver',
    'MouseEvent',
    'KeyboardEvent',
  ]) {
    vi.stubGlobal(
      key,
      key === 'window' ? dom.window : dom.window[key as keyof Window]
    );
  }
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  root = createRoot(document.getElementById('root')!);
  state.allowed = true;
  state.settings = { preferredProvider: 'grimmory' };
  state.groupings = [];
  state.post.mockReset();
  state.mutate.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  dom.window.close();
  vi.unstubAllGlobals();
});

const target = {
  type: 'book-series' as const,
  id: 'series:42',
  name: 'The Broken Earth',
};

const render = async (targetOverride = target) =>
  act(async () =>
    root.render(
      <IntlProvider locale="en">
        <ReaderGroupingAction target={targetOverride} />
      </IntlProvider>
    )
  );

const click = async (label: string) => {
  const button = [...document.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === label
  );
  expect(button, `button "${label}" should exist`).toBeDefined();
  await act(async () => button!.click());
};

const readerShelfResponse = (verified = true) => ({
  data: {
    grouping: {
      id: 17,
      provider: 'grimmory',
      targetType: 'book-series',
      targetId: target.id,
      isPublic: true,
      syncToKobo: false,
      status: 'ready',
      lastMatchCount: 2,
      countVerified: verified,
      lastError: null,
      serviceUrl: 'https://grimmory.example',
      groupName: 'SeerrNG · Book Series · The Broken Earth [12345678]',
    },
    previewCount: 2,
    sampleTitles: ['The Fifth Season', 'The Obelisk Gate'],
    ruleSummary: 'Book series: The Broken Earth',
  },
});

it('shows the grouping action only to administrators and uses the preferred provider', async () => {
  state.allowed = false;
  await render();
  expect(document.body.textContent).not.toContain('Create reader shelf');

  state.allowed = true;
  state.settings = { preferredProvider: 'bookorbit' };
  await render();
  await click('Create reader shelf');
  expect(
    document.querySelector<HTMLSelectElement>('#reader-grouping-provider')
      ?.value
  ).toBe('bookorbit');
  expect(document.body.textContent).toContain(
    'Sync this BookOrbit scope to the connected Kobo account'
  );
});

it('previews titles, saves a live shelf, refreshes its mapping, and links to the service', async () => {
  state.mutate.mockRejectedValueOnce(new Error('refresh failed'));
  state.post
    .mockResolvedValueOnce({
      data: {
        provider: 'grimmory',
        matchedCount: 2,
        sampleTitles: ['The Fifth Season', 'The Obelisk Gate'],
        ruleSummary: 'Book series: The Broken Earth',
      },
    })
    .mockResolvedValueOnce(readerShelfResponse());

  await render();
  await click('Create reader shelf');
  await click('Preview matches');
  expect(document.body.textContent).toContain('The Fifth Season');
  expect(document.body.textContent).toContain('The Obelisk Gate');
  await click('Create shelf');

  expect(state.post).toHaveBeenCalledTimes(2);
  expect(state.post.mock.calls[0][0]).toBe(
    '/api/v1/settings/reader-delivery/groupings/preview'
  );
  expect(state.post.mock.calls[1][1]).toMatchObject({
    provider: 'grimmory',
    target,
    isPublic: true,
    syncToKobo: false,
    allowEmpty: false,
  });
  expect(state.mutate).toHaveBeenCalledTimes(1);
  expect(document.body.textContent).toContain('Reader shelf saved');
  expect(document.body.textContent).not.toContain(
    'The reader shelf could not be saved.'
  );
  expect(
    document.querySelector('a[href="https://grimmory.example"]')
  ).toBeTruthy();
});

it('requires an explicit opt-in before saving a rule with no current matches', async () => {
  state.post
    .mockResolvedValueOnce({
      data: {
        provider: 'grimmory',
        matchedCount: 0,
        sampleTitles: [],
        ruleSummary: 'Book series: The Broken Earth',
      },
    })
    .mockResolvedValueOnce(readerShelfResponse());

  await render();
  await click('Create reader shelf');
  await click('Preview matches');
  expect(document.body.textContent).toContain(
    'No current books match this rule.'
  );
  expect(
    [...document.querySelectorAll('button')].some(
      (button) => button.textContent?.trim() === 'Create shelf'
    )
  ).toBe(false);

  const emptyOptIn = [
    ...document.querySelectorAll('input[type="checkbox"]'),
  ].find((input) =>
    input.parentElement?.textContent?.includes('Create this live rule anyway')
  ) as HTMLInputElement | undefined;
  expect(emptyOptIn).toBeDefined();
  await act(async () => emptyOptIn!.click());
  await click('Create shelf');
  expect(state.post.mock.calls[1][1].allowEmpty).toBe(true);
});

it('keeps BookOrbit visibility immutable for an existing scope while allowing Kobo sync to be updated', async () => {
  state.settings = { preferredProvider: 'bookorbit' };
  state.groupings = [
    {
      id: 12,
      provider: 'bookorbit',
      targetType: 'book-series',
      targetId: target.id,
      isPublic: false,
      syncToKobo: false,
    },
  ];
  await render();
  await click('Update reader shelf');

  const checkboxes = [...document.querySelectorAll('input[type="checkbox"]')];
  expect((checkboxes[0] as HTMLInputElement).disabled).toBe(true);
  expect(document.body.textContent).toContain(
    'BookOrbit locks visibility when the scope is created.'
  );
  await act(async () => (checkboxes[1] as HTMLInputElement).click());
  state.post.mockResolvedValueOnce({
    data: {
      provider: 'bookorbit',
      matchedCount: 1,
      sampleTitles: ['The Fifth Season'],
      ruleSummary: 'Book series: The Broken Earth',
    },
  });
  await click('Preview matches');
  expect(state.post.mock.calls[0][1].provider).toBe('bookorbit');
});

it('discards a preview response when navigation changes the target mid-request', async () => {
  let resolvePreview!: (response: {
    data: {
      provider: string;
      matchedCount: number;
      sampleTitles: string[];
      ruleSummary: string;
    };
  }) => void;
  state.post.mockReturnValueOnce(
    new Promise((resolve) => {
      resolvePreview = resolve;
    })
  );

  await render();
  await click('Create reader shelf');
  await click('Preview matches');
  await render({ ...target, id: 'series:43', name: 'The Inheritance Trilogy' });
  await act(async () =>
    resolvePreview({
      data: {
        provider: 'grimmory',
        matchedCount: 1,
        sampleTitles: ['The Fifth Season'],
        ruleSummary: 'Book series: The Broken Earth',
      },
    })
  );

  expect(document.body.textContent).not.toContain('The Fifth Season');
  expect(document.body.textContent).not.toContain('The Broken Earth');
  expect(document.body.textContent).toContain('Create reader shelf');
  expect(document.querySelector('#reader-grouping-provider')).toBeNull();
});
