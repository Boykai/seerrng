import TitleDetail from '@app/components/Settings/MangaSources/TitleDetail';
import type * as HeadlessUi from '@headlessui/react';
import { MediaStatus } from '@server/constants/media';
import type { MangaLibraryBinding } from '@server/interfaces/api/mangaLibraryInterfaces';
import type {
  MangaResolveCandidate,
  MangaResolveDetail,
} from '@server/interfaces/api/mangaResolveInterfaces';
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
  options: new Map<string, SwrOptions>(),
  mutate: vi.fn(),
  post: vi.fn(),
  addToast: vi.fn(),
  onClose: vi.fn(),
  onListChange: vi.fn(),
}));
vi.mock('swr', () => ({
  default: (key: string | null, options?: SwrOptions) => {
    const response = key ? state.responses.get(key) : undefined;
    if (key) state.options.set(key, options ?? {});
    return {
      data: response?.data,
      error: response?.error,
      isLoading: Boolean(key) && !response,
      mutate: state.mutate,
    };
  },
}));
vi.mock('axios', () => ({ default: { post: state.post } }));
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
vi.mock('@headlessui/react', async (importOriginal) => ({
  ...(await importOriginal<typeof HeadlessUi>()),
  Transition: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
// The shared Modal forwards its ref to the backdrop around the dialog.
vi.mock('@app/components/Common/Modal', async () => {
  const { forwardRef } = await import('react');
  return {
    default: forwardRef<
      HTMLDivElement,
      {
        title: string;
        subTitle?: string;
        children: React.ReactNode;
        cancelText: string;
        cancelButtonProps?: { disabled?: boolean };
        onCancel: () => void;
      }
    >(function Modal(props, ref) {
      return (
        <div ref={ref} data-testid="modal-backdrop">
          <div role="dialog" aria-modal="true">
            <h2>{props.title}</h2>
            {props.subTitle && (
              <h3 data-testid="modal-subtitle">{props.subTitle}</h3>
            )}
            {props.children}
            <button
              type="button"
              data-testid="modal-cancel-button"
              disabled={props.cancelButtonProps?.disabled}
              onClick={props.onCancel}
            >
              {props.cancelText}
            </button>
          </div>
        </div>
      );
    }),
  };
});
vi.mock('@app/hooks/useToasts', () => ({
  default: () => ({ addToast: state.addToast }),
}));
vi.mock('@app/components/Common/LoadingSpinner', () => ({
  default: () => <div data-testid="loading" />,
}));

const API = '/api/v1/manga/resolve';
const DETAIL = `${API}/9001?instanceId=0`;
const INSTANCES = '/api/v1/settings/suwayomi';
const SUMMARY = '/api/v1/manga?ids=9001';

const candidate = (
  id: number,
  values: Partial<Record<keyof MangaResolveCandidate, unknown>> = {}
): MangaResolveCandidate =>
  ({
    id,
    sourceId: '1002',
    sourceName: 'Synthetic Source 1002',
    sourceLang: 'en',
    url: `/manga/synthetic-${id}`,
    suwayomiMangaId: 500 + id,
    title: `Synthetic Manga ${id}`,
    inLibrary: false,
    score: 0.8,
    confidence: 'HIGH',
    matchedBy: 'title',
    createdAt: '2026-10-01T00:00:00.000Z',
    ...values,
  }) as MangaResolveCandidate;

const binding = (
  values: Partial<Record<keyof MangaLibraryBinding, unknown>> = {}
): MangaLibraryBinding =>
  ({
    id: 31,
    instanceId: 0,
    sourceId: '1002',
    url: '/manga/synthetic-bound',
    suwayomiMangaId: 531,
    title: 'Synthetic Bound Manga',
    anilistId: 9001,
    confidence: 'MANUAL',
    matchedBy: 'manual',
    origin: 'manual',
    state: 'ACTIVE',
    inLibrary: true,
    availability: MediaStatus.UNKNOWN,
    chapterCount: null,
    downloadCount: null,
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...values,
  }) as MangaLibraryBinding;

const detail = (
  values: Partial<Record<keyof MangaResolveDetail, unknown>> = {}
) => ({
  data: {
    anilistId: 9001,
    instanceId: 0,
    status: 'NEEDS_PICK',
    reason: 'TITLE_MATCHES',
    mangadexUuid: null,
    approved: true,
    requestId: 77,
    candidateCount: 4,
    attempts: 1,
    checkedAt: '2026-10-01T10:00:00.000Z',
    searchedAt: '2026-10-01T10:00:00.000Z',
    nextAttemptAt: '2026-10-02T10:00:00.000Z',
    searchRequestedAt: null,
    lastError: null,
    candidates: [
      candidate(1, {
        confidence: 'EXACT_LINK',
        matchedBy: 'mangadex-link',
        score: 1,
      }),
      candidate(2),
      candidate(3, {
        confidence: 'LOW',
        sourceId: '1003',
        sourceName: '',
        sourceLang: '',
      }),
      candidate(4, { confidence: 'MEDIUM', inLibrary: true }),
    ],
    bindings: [],
    ...values,
  } as MangaResolveDetail,
});

const instance = (
  values: Partial<Record<keyof SuwayomiSettingsView, unknown>> = {}
): SuwayomiSettingsView =>
  ({
    id: 0,
    name: 'Synthetic Server',
    sourceAllowlist: ['0', '1002', '1003'],
    ...values,
  }) as SuwayomiSettingsView;

const rejected = (status: number, data: unknown) =>
  Object.assign(new Error('Request failed'), { response: { status, data } });

const deferred = () => {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

const bound = () => ({
  data: { outcome: 'bound', binding: binding(), title: detail().data },
});

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
  state.options.clear();
  for (const mock of [
    state.mutate,
    state.post,
    state.addToast,
    state.onClose,
    state.onListChange,
  ]) {
    mock.mockReset();
  }
  state.onListChange.mockResolvedValue(undefined);
  state.responses.set(DETAIL, detail());
  state.responses.set(INSTANCES, { data: [instance()] });
  state.responses.set(SUMMARY, {
    data: {
      results: [{ id: 9001, mediaType: 'manga', title: 'Catalog Title 9001' }],
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

const render = async ({
  confirmSearch,
}: {
  confirmSearch?: boolean;
} = {}) => {
  await act(async () =>
    root.render(
      <IntlProvider locale="en">
        <TitleDetail
          anilistId={9001}
          instanceId={0}
          confirmSearch={confirmSearch}
          onClose={state.onClose}
          onListChange={state.onListChange}
        />
      </IntlProvider>
    )
  );
  await flush();
};

const dialog = () => host.querySelector<HTMLElement>('[role="dialog"]')!;
const section = (heading: string) =>
  [...host.querySelectorAll('section')].find(
    (element) => element.querySelector('h4')?.textContent === heading
  );
const buttonIn = (scope: ParentNode | undefined, text: string) =>
  [...(scope?.querySelectorAll('button') ?? [])].find(
    (button) => button.textContent === text
  );
const cardFor = (title: string) =>
  [...host.querySelectorAll('li')].find(
    (item) =>
      item.querySelector('.settings-manga-sources-item-title')?.textContent ===
      title
  );
const field = <T extends HTMLElement>(text: string) => {
  const label = [...host.querySelectorAll('label')].find(
    (element) => element.textContent === text
  );
  return label ? (document.getElementById(label.htmlFor) as T | null) : null;
};
const forms = () => [...host.querySelectorAll('form')];
const closeButton = () =>
  host.querySelector<HTMLButtonElement>('[data-testid="modal-cancel-button"]')!;
const confirmPanel = () => host.querySelector('[role="group"]');

const click = async (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  await act(async () => {
    element!.dispatchEvent(
      new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })
    );
  });
  await flush();
};

const press = async (key: string, shiftKey = false) => {
  await act(async () => {
    (document.activeElement ?? document.body).dispatchEvent(
      new dom.window.KeyboardEvent('keydown', {
        key,
        shiftKey,
        bubbles: true,
        cancelable: true,
      })
    );
  });
  await flush();
};

const type = async (input: HTMLInputElement | null, value: string) => {
  expect(input).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      dom.window.HTMLInputElement.prototype,
      'value'
    )!.set!.call(input, value);
    input!.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  await flush();
};

const choose = async (select: HTMLSelectElement | null, value: string) => {
  expect(select).toBeTruthy();
  await act(async () => {
    select!.value = value;
    select!.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  await flush();
};

const submit = (form: HTMLFormElement | undefined) =>
  click(form?.querySelector('button[type="submit"]'));

describe('TitleDetail', () => {
  it('shows the status, matches and suggestions as plain text', async () => {
    state.responses.set(
      DETAIL,
      detail({
        bindings: [binding()],
        lastError: 'SUWAYOMI_UNAVAILABLE',
        searchRequestedAt: '2026-10-01T11:00:00.000Z',
      })
    );
    await render();

    expect(host.querySelector('h2')?.textContent).toBe('Catalog Title 9001');
    expect(host.querySelector('[data-testid="modal-subtitle"]')).toBeNull();
    const status = section('Status')!;
    expect(status.querySelector('[role="status"]')?.textContent).toBe(
      'Needs PickSearch Queued'
    );
    expect(status.textContent).toContain('Only title matches were found.');
    expect(status.textContent).toContain('Suwayomi could not be reached.');
    expect(status.textContent).toContain('Last Check');
    expect(status.textContent).toContain('Next Check');
    expect(status.querySelector('time')?.getAttribute('datetime')).toBe(
      '2026-10-01T10:00:00.000Z'
    );
    expect(
      [...status.querySelectorAll('a')].map((link) => [
        link.getAttribute('href'),
        link.textContent,
      ])
    ).toEqual([['/requests?requestId=77', 'View Request']]);

    const match = section('Library Matches')!.querySelector('li')!;
    expect(match.textContent).toContain('Synthetic Bound Manga');
    expect(match.textContent).toContain('SourceSynthetic Source 1002');
    expect(match.textContent).toContain('Chosen by an Admin');
    expect(match.textContent).toContain('In Suwayomi Library');

    // Never a URL: source-relative paths stay out of the page.
    expect(host.innerHTML).not.toContain('/manga/synthetic');
    expect(state.post).not.toHaveBeenCalled();
  });

  it('credits MangaDex for an exact link and shows title matches as suggestions', async () => {
    await render();

    const exact = cardFor('Synthetic Manga 1')!;
    expect(exact.textContent).toContain('Matched with data from MangaDex');
    expect(exact.querySelector('a')?.getAttribute('href')).toBe(
      'https://mangadex.org/'
    );
    expect(exact.textContent).not.toContain('Confidence');

    const high = cardFor('Synthetic Manga 2')!;
    expect(high.textContent).toContain('SourceSynthetic Source 1002');
    expect(high.textContent).toContain('Languageen');
    expect(high.textContent).toContain('High Confidence');
    // A title match is a suggestion, never an admin's confirmation.
    expect(host.textContent).not.toContain('Confirmed by an Admin');

    const weak = cardFor('Synthetic Manga 3')!;
    expect(weak.textContent).toContain('Source1003');
    expect(weak.textContent).not.toContain('Language');
    expect(weak.textContent).toContain('Weak Guess');

    const owned = cardFor('Synthetic Manga 4')!;
    expect(owned.textContent).toContain('Medium Confidence');
    expect(owned.textContent).toContain('In Suwayomi Library');

    expect(section('Library Matches')).toBeUndefined();
  });

  it('names the title while its summary loads or is unavailable', async () => {
    state.responses.delete(SUMMARY);
    await render();
    expect(host.querySelector('h2')?.textContent).toBe('Loading…');

    state.responses.set(SUMMARY, { data: { results: [] } });
    await render();
    expect(host.querySelector('h2')?.textContent).toBe(
      'AniList ID 9001 (details unavailable)'
    );
  });

  it('names the server only when there are several', async () => {
    state.responses.set(INSTANCES, {
      data: [instance(), instance({ id: 1, name: 'Second Server' })],
    });
    await render();

    expect(
      host.querySelector('[data-testid="modal-subtitle"]')?.textContent
    ).toBe('Synthetic Server');
  });

  it('shows why an exact link or an admin bound the title', async () => {
    state.responses.set(
      DETAIL,
      detail({
        status: 'BOUND',
        reason: 'EXACT_LINK',
        bindings: [binding({ matchedBy: 'mangadex-link' })],
      })
    );
    await render();
    expect(
      section('Status')!.querySelector('.settings-manga-sources-stack')
        ?.textContent
    ).toBe('BoundMatched with data from MangaDex');

    state.responses.set(
      DETAIL,
      detail({ status: 'BOUND', reason: 'ADMIN_BIND', bindings: [binding()] })
    );
    await render();
    expect(
      section('Status')!.querySelector('.settings-manga-sources-stack')
        ?.textContent
    ).toBe('BoundChosen by an Admin');
  });

  it('confirms a suggestion inline, then saves it and closes', async () => {
    await render();

    await click(buttonIn(cardFor('Synthetic Manga 2'), 'Match'));
    const panel = confirmPanel()!;
    expect(cardFor('Synthetic Manga 2')!.contains(panel)).toBe(true);
    expect(panel.textContent).toContain(
      'Match this title to “Synthetic Manga 2”?'
    );
    expect(panel.textContent).not.toContain('second');
    expect(document.activeElement?.textContent).toBe('Cancel');
    expect(
      [...panel.querySelectorAll('button')].map((item) => item.textContent)
    ).toEqual(['Cancel', 'Confirm']);
    expect(state.post).not.toHaveBeenCalled();

    state.post.mockResolvedValue(bound());
    await click(buttonIn(panel, 'Confirm'));

    expect(state.post).toHaveBeenCalledTimes(1);
    expect(state.post).toHaveBeenCalledWith(`${API}/9001/select`, {
      instanceId: 0,
      candidateId: 2,
    });
    expect(state.mutate).toHaveBeenCalled();
    expect(state.onListChange).toHaveBeenCalled();
    expect(state.addToast).toHaveBeenCalledWith('Match saved.', {
      appearance: 'success',
      autoDismiss: true,
    });
    expect(state.onClose).toHaveBeenCalledTimes(1);
  });

  it('warns that a pick adds a second match to an active one', async () => {
    state.responses.set(DETAIL, detail({ bindings: [binding()] }));
    await render();

    await click(buttonIn(cardFor('Synthetic Manga 2'), 'Match'));

    const warning = confirmPanel()!.querySelector('.warning')!;
    expect(warning.textContent).toBe(
      'This title already has a library match. Confirming adds a second one.'
    );
    expect(
      buttonIn(confirmPanel()!, 'Confirm')
        ?.getAttribute('aria-describedby')
        ?.split(' ')
    ).toContain(warning.id);
  });

  it('does not warn about a match that is no longer active', async () => {
    state.responses.set(
      DETAIL,
      detail({ bindings: [binding({ state: 'ORPHANED' })] })
    );
    await render();

    await click(buttonIn(cardFor('Synthetic Manga 2'), 'Match'));

    expect(confirmPanel()!.querySelector('.warning')).toBeNull();
  });

  it('cancels a pick and gives the focus back to its Match button', async () => {
    await render();
    const trigger = buttonIn(cardFor('Synthetic Manga 2'), 'Match')!;

    await click(trigger);
    await click(buttonIn(confirmPanel()!, 'Cancel'));
    expect(confirmPanel()).toBeNull();
    expect(document.activeElement).toBe(trigger);

    // Escape closes an open confirm before it closes the dialog.
    await click(trigger);
    await press('Escape');
    expect(confirmPanel()).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(state.onClose).not.toHaveBeenCalled();
    expect(state.post).not.toHaveBeenCalled();
  });

  it('searches an approved title at once', async () => {
    state.post.mockResolvedValue({
      data: { title: detail().data, runStarted: true },
    });
    await render();

    await click(buttonIn(section('Status'), 'Search Now'));

    expect(confirmPanel()).toBeNull();
    expect(state.post).toHaveBeenCalledWith(`${API}/9001/search`, {
      instanceId: 0,
    });
    expect(state.onClose).not.toHaveBeenCalled();
  });

  it('asks before an unapproved title is searched', async () => {
    state.responses.set(DETAIL, detail({ approved: false }));
    state.post.mockResolvedValue({
      data: { title: detail().data, runStarted: true },
    });
    await render();
    const trigger = buttonIn(section('Status'), 'Search Now')!;

    await click(trigger);
    expect(confirmPanel()?.textContent).toContain(
      'Searching sends this title to MangaDex and to the selected sources, even though its request is not approved.'
    );
    expect(document.activeElement?.textContent).toBe('Cancel');
    expect(state.post).not.toHaveBeenCalled();

    await click(buttonIn(confirmPanel()!, 'Confirm'));
    expect(state.post).toHaveBeenCalledWith(`${API}/9001/search`, {
      instanceId: 0,
    });
    expect(confirmPanel()).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('opens with the search confirm when the list asked for it', async () => {
    state.responses.set(DETAIL, detail({ approved: false }));
    await render({ confirmSearch: true });

    expect(confirmPanel()?.textContent).toContain('Searching sends');
    expect(document.activeElement?.textContent).toBe('Cancel');

    await click(buttonIn(confirmPanel()!, 'Cancel'));
    expect(confirmPanel()).toBeNull();
    expect(document.activeElement).toBe(dialog());
    expect(state.post).not.toHaveBeenCalled();
  });

  it('skips the search confirm for an approved title', async () => {
    await render({ confirmSearch: true });

    expect(confirmPanel()).toBeNull();
  });

  it('polls while a queued search waits and stops once it ran', async () => {
    const queued = detail({
      searchRequestedAt: '2026-10-01T11:00:00.000Z',
    }).data;
    state.post.mockImplementation(async () => {
      state.responses.set(DETAIL, { data: queued });
      return { data: { title: queued, runStarted: false } };
    });
    await render();
    expect(state.options.get(DETAIL)).toEqual({
      refreshInterval: 0,
      dedupingInterval: 1_000,
    });

    await click(buttonIn(section('Status'), 'Search Now'));
    expect(state.options.get(DETAIL)?.refreshInterval).toBe(5_000);
    expect(section('Status')!.textContent).toContain('Search Queued');

    state.responses.set(
      DETAIL,
      detail({
        searchedAt: '2026-10-01T11:05:00.000Z',
        searchRequestedAt: null,
      })
    );
    await render();
    expect(state.options.get(DETAIL)?.refreshInterval).toBe(0);
  });

  it('stops polling once a search ran, even if another is queued', async () => {
    const queued = detail({
      searchRequestedAt: '2026-10-01T11:00:00.000Z',
    }).data;
    state.post.mockImplementation(async () => {
      state.responses.set(DETAIL, { data: queued });
      return { data: { title: queued, runStarted: false } };
    });
    await render();
    await click(buttonIn(section('Status'), 'Search Now'));
    expect(state.options.get(DETAIL)?.refreshInterval).toBe(5_000);

    state.responses.set(
      DETAIL,
      detail({
        searchedAt: '2026-10-01T11:05:00.000Z',
        searchRequestedAt: '2026-10-01T11:06:00.000Z',
      })
    );
    await render();
    expect(state.options.get(DETAIL)?.refreshInterval).toBe(0);
  });

  it('polls a search queued before the dialog opened until it ran', async () => {
    state.responses.set(
      DETAIL,
      detail({ searchRequestedAt: '2026-10-01T11:00:00.000Z' })
    );
    await render();
    expect(state.options.get(DETAIL)?.refreshInterval).toBe(5_000);

    state.responses.set(
      DETAIL,
      detail({ searchedAt: '2026-10-01T11:05:00.000Z' })
    );
    await render();
    expect(state.options.get(DETAIL)?.refreshInterval).toBe(0);
  });

  it('binds by Suwayomi manga ID with only that field', async () => {
    state.post.mockResolvedValue(bound());
    await render();

    await type(field<HTMLInputElement>('Suwayomi Manga ID'), ' 42 ');
    await submit(forms()[0]);

    expect(state.post).toHaveBeenCalledTimes(1);
    expect(state.post).toHaveBeenCalledWith(`${API}/9001/bind`, {
      instanceId: 0,
      suwayomiMangaId: 42,
    });
    expect(state.addToast).toHaveBeenCalledWith('Match saved.', {
      appearance: 'success',
      autoDismiss: true,
    });
    expect(state.onClose).toHaveBeenCalledTimes(1);
  });

  it('binds by source and URL with only those fields', async () => {
    state.post.mockResolvedValue(bound());
    await render();

    const select = field<HTMLSelectElement>('Source')!;
    expect(
      [...select.options].map((option) => [option.value, option.textContent])
    ).toEqual([
      ['', 'Choose Source'],
      ['1002', 'Synthetic Source 1002'],
      ['1003', '1003'],
    ]);
    await choose(select, '1002');
    await type(
      field<HTMLInputElement>('Source-Relative URL'),
      ' /manga/synthetic-9 '
    );
    await submit(forms()[1]);

    expect(state.post).toHaveBeenCalledTimes(1);
    expect(state.post).toHaveBeenCalledWith(`${API}/9001/bind`, {
      instanceId: 0,
      sourceId: '1002',
      url: '/manga/synthetic-9',
    });
    expect(state.onClose).toHaveBeenCalledTimes(1);
  });

  it('refuses a hand match the server would refuse, before sending it', async () => {
    await render();
    const mangaId = field<HTMLInputElement>('Suwayomi Manga ID')!;

    await type(mangaId, '0');
    await submit(forms()[0]);
    expect(host.textContent).toContain('Enter a positive whole number.');
    expect(mangaId.getAttribute('aria-invalid')).toBe('true');
    expect(
      document.getElementById(mangaId.getAttribute('aria-describedby')!)
        ?.textContent
    ).toBe('Enter a positive whole number.');
    expect(document.activeElement).toBe(mangaId);

    await type(mangaId, '4');
    expect(mangaId.getAttribute('aria-invalid')).toBeNull();
    expect(host.textContent).not.toContain('Enter a positive whole number.');

    await submit(forms()[1]);
    expect(host.textContent).toContain('Choose a source.');
    expect(document.activeElement).toBe(field('Source'));

    await choose(field<HTMLSelectElement>('Source'), '1002');
    await type(field<HTMLInputElement>('Source-Relative URL'), 'a\u0007b');
    await submit(forms()[1]);
    expect(host.textContent).toContain(
      'Enter a URL of up to 2,048 characters without control characters.'
    );
    expect(document.activeElement).toBe(field('Source-Relative URL'));

    expect(state.post).not.toHaveBeenCalled();
  });

  it('offers no hand match when the server has no selected sources', async () => {
    state.responses.set(INSTANCES, {
      data: [instance({ sourceAllowlist: ['0'] })],
    });
    await render();

    const hand = section('Match by Hand')!;
    expect(hand.textContent).toBe(
      'Match by HandNo sources are selected for this Suwayomi server. Select some in the Suwayomi settings.'
    );
    expect(hand.querySelector('a')?.getAttribute('href')).toBe(
      '/settings/services'
    );
    expect(hand.querySelector('form')).toBeNull();
  });

  it('offers the manga ID form alone while the server is unknown', async () => {
    state.responses.delete(INSTANCES);
    await render();

    let hand = section('Match by Hand')!;
    expect(hand.textContent).toContain('Enter its Suwayomi manga ID.');
    expect(hand.querySelectorAll('form')).toHaveLength(1);
    expect(hand.querySelector('select')).toBeNull();

    state.responses.set(INSTANCES, { data: [instance({ id: 5 })] });
    await render();

    hand = section('Match by Hand')!;
    expect(hand.querySelectorAll('form')).toHaveLength(1);
    expect(hand.querySelector('select')).toBeNull();
  });

  it('offers both forms when the server has selected sources', async () => {
    await render();

    const hand = section('Match by Hand')!;
    expect(hand.textContent).toContain(
      'Enter its Suwayomi manga ID, or choose its source and enter its URL relative to that source.'
    );
    expect(hand.querySelectorAll('form')).toHaveLength(2);
  });

  it('locks every action and the dialog while a write runs', async () => {
    const request = deferred();
    state.post.mockReturnValue(request.promise);
    await render();

    await click(buttonIn(cardFor('Synthetic Manga 2'), 'Match'));
    await click(buttonIn(confirmPanel()!, 'Confirm'));

    expect(
      [...host.querySelectorAll('button')].every((button) => button.disabled)
    ).toBe(true);
    expect(closeButton().disabled).toBe(true);
    await press('Escape');
    expect(confirmPanel()).not.toBeNull();
    await click(closeButton());
    expect(state.onClose).not.toHaveBeenCalled();
    await submit(forms()[0]);
    expect(state.post).toHaveBeenCalledTimes(1);

    await act(async () => request.resolve(bound()));
    await flush();
    expect(state.onClose).toHaveBeenCalledTimes(1);
  });

  it('offers a retry when the same write may succeed again', async () => {
    state.post
      .mockRejectedValueOnce(
        rejected(502, {
          code: 'MANGA_SUWAYOMI_LOOKUP_FAILED',
          message: 'raw upstream text',
          suwayomiCode: 'TIMEOUT',
        })
      )
      .mockResolvedValueOnce(bound());
    await render();

    await click(buttonIn(cardFor('Synthetic Manga 2'), 'Match'));
    await click(buttonIn(confirmPanel()!, 'Confirm'));

    const suggestions = section('Suggestions')!;
    expect(suggestions.querySelector('[role="alert"]')?.textContent).toBe(
      'Could not reach Suwayomi; nothing was changed. (TIMEOUT)'
    );
    expect(host.textContent).not.toContain('raw upstream text');
    expect(state.onClose).not.toHaveBeenCalled();

    await click(buttonIn(suggestions, 'Retry'));
    expect(state.post).toHaveBeenCalledTimes(2);
    expect(state.post.mock.calls[1]).toEqual(state.post.mock.calls[0]);
    expect(state.onClose).toHaveBeenCalledTimes(1);
  });

  it('drops a stale confirm when the title changed', async () => {
    state.post.mockRejectedValue(
      rejected(409, {
        code: 'MANGA_CANDIDATE_GONE',
        message: 'Candidate gone',
      })
    );
    await render();

    await click(buttonIn(cardFor('Synthetic Manga 2'), 'Match'));
    await click(buttonIn(confirmPanel()!, 'Confirm'));

    expect(confirmPanel()).toBeNull();
    expect(
      section('Suggestions')!.querySelector('[role="alert"]')?.textContent
    ).toBe(
      'Suwayomi no longer has this suggestion. Search again for new suggestions.'
    );
    expect(buttonIn(section('Suggestions'), 'Retry')).toBeUndefined();
    expect(dialog().contains(document.activeElement)).toBe(true);
    expect(state.mutate).toHaveBeenCalled();
    expect(state.onListChange).toHaveBeenCalled();
  });

  it("shows a newer server's message for a code it does not know", async () => {
    state.post.mockRejectedValue(
      rejected(409, {
        code: 'MANGA_SOMETHING_NEW',
        message: 'A newer server refused this.',
      })
    );
    await render();

    await type(field<HTMLInputElement>('Suwayomi Manga ID'), '42');
    await submit(forms()[0]);

    expect(
      section('Match by Hand')!.querySelector('[role="alert"]')?.textContent
    ).toBe('A newer server refused this.');
  });

  it('shows the generic error for a refusal without a code', async () => {
    state.post.mockRejectedValue(
      rejected(400, { message: 'raw validator text' })
    );
    await render();

    await click(buttonIn(section('Status'), 'Search Now'));

    expect(
      section('Status')!.querySelector('[role="alert"]')?.textContent
    ).toBe('Something went wrong. Please try again.');
    expect(host.textContent).not.toContain('raw validator text');
  });

  it('reports a detail that failed to load and refreshes it', async () => {
    state.responses.set(DETAIL, {
      error: rejected(404, {
        code: 'MANGA_RESOLVE_TITLE_NOT_FOUND',
        message: 'Not found',
      }),
    });
    await render();

    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      'This title was matched or removed in the meantime. The list was refreshed.'
    );
    await click(buttonIn(dialog(), 'Refresh'));
    expect(state.mutate).toHaveBeenCalledTimes(1);
    expect(state.onListChange).toHaveBeenCalledTimes(1);
  });

  it('keeps the focus inside the dialog and closes on Escape', async () => {
    await render();
    expect(document.activeElement).toBe(dialog());

    const first = dialog().querySelector<HTMLElement>('a[href]')!;
    expect(first.textContent).toBe('View Request');

    await press('Tab', true);
    expect(document.activeElement).toBe(closeButton());
    await press('Tab');
    expect(document.activeElement).toBe(first);
    await press('Tab', true);
    expect(document.activeElement).toBe(closeButton());

    await press('Escape');
    expect(state.onClose).toHaveBeenCalledTimes(1);
  });

  it('closes from its Close button', async () => {
    await render();

    await click(closeButton());

    expect(closeButton().textContent).toBe('Close');
    expect(state.onClose).toHaveBeenCalledTimes(1);
  });
});
