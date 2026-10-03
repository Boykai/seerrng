import type { MangaScopedRequest } from '@app/utils/mangaRequestScope';
import { MangaRequestScope } from '@server/constants/mangaRequest';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { Permission } from '@server/lib/permissions';
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
  swr: {} as Record<string, { data?: unknown; error?: unknown }>,
  post: vi.fn(),
  put: vi.fn(),
  delete: vi.fn(),
  mutate: vi.fn(),
  addToast: vi.fn(),
  onComplete: vi.fn(),
  onCancel: vi.fn(),
  granted: [] as number[],
  userId: 1,
}));
vi.mock('swr', () => ({
  default: (key: string | null) => (key ? (state.swr[key] ?? {}) : {}),
  mutate: state.mutate,
}));
vi.mock('axios', () => ({
  default: { post: state.post, put: state.put, delete: state.delete },
}));
vi.mock('@app/hooks/useToasts', () => ({
  default: () => ({ addToast: state.addToast }),
}));
vi.mock('@app/hooks/useUser', async () => {
  const permissions = await import('@server/lib/permissions');
  return {
    Permission: permissions.Permission,
    useUser: () => ({
      user: {
        id: state.userId,
        permissions: state.granted.reduce((sum, value) => sum + value, 0),
      },
      hasPermission: (required: number) => state.granted.includes(required),
    }),
  };
});
vi.mock('@app/components/Common/CachedImage', () => ({
  // eslint-disable-next-line @next/next/no-img-element
  default: ({ src }: { src: string }) => <img alt="" src={src} />,
}));
vi.mock('@app/components/RequestModal/QuotaDisplay', () => ({
  default: ({
    mediaType,
    quota,
  }: {
    mediaType: string;
    quota?: { limit: number };
  }) => (
    <div
      data-testid="quota"
      data-media-type={mediaType}
      data-limit={quota?.limit}
    />
  ),
}));
vi.mock('@app/components/Common/Modal', () => ({
  default: (props: {
    title: string;
    children: React.ReactNode;
    loading?: boolean;
    hideActions?: boolean;
    okText?: string;
    okDisabled?: boolean;
    onOk?: () => void;
    secondaryText?: string;
    onSecondary?: () => void;
    cancelText?: string;
    onCancel?: () => void;
  }) => (
    <div>
      <h2>{props.title}</h2>
      {props.loading ? <div data-testid="loading" /> : props.children}
      {!props.hideActions && props.onOk && (
        <button
          type="button"
          data-testid="modal-ok-button"
          disabled={props.okDisabled}
          onClick={props.onOk}
        >
          {props.okText}
        </button>
      )}
      {!props.hideActions && props.onSecondary && (
        <button
          type="button"
          data-testid="modal-secondary-button"
          onClick={props.onSecondary}
        >
          {props.secondaryText}
        </button>
      )}
      {!props.hideActions && (
        <button
          type="button"
          data-testid="modal-close-button"
          onClick={props.onCancel}
        >
          {props.cancelText}
        </button>
      )}
    </div>
  ),
}));

const { default: MangaRequestModal } = await import('./MangaRequestModal');

const MANGA_KEY = '/api/v1/manga/30013';
const QUOTA_KEY = '/api/v1/user/1/quota';
const REQUEST_KEY = '/api/v1/request/7';

const manga = (values: Record<string, unknown> = {}) => ({
  id: 30013,
  mediaType: 'manga',
  title: 'Sample Manga',
  posterPath: 'https://s4.anilist.co/file/cover.jpg',
  startYear: 1994,
  ...values,
});

const quota = (limit = 0, restricted = false) => ({
  manga: { days: 7, limit, used: 0, remaining: limit, restricted },
});

const pendingRequest = (
  values: Partial<MangaScopedRequest> = {}
): MangaScopedRequest =>
  ({
    id: 7,
    type: MediaType.MANGA,
    status: MediaRequestStatus.PENDING,
    requestedBy: { id: 1, displayName: 'Reader' },
    mangaScope: {
      scope: MangaRequestScope.LATEST_N,
      latestCount: 25,
      rangeStart: null,
      rangeEnd: null,
      awaitingBinding: false,
    },
    ...values,
  }) as MangaScopedRequest;

const rejected = (status: number, message: string) =>
  Object.assign(new Error('Request failed'), {
    response: { status, data: { message } },
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
  for (const mock of [
    state.post,
    state.put,
    state.delete,
    state.mutate,
    state.addToast,
    state.onComplete,
    state.onCancel,
  ]) {
    mock.mockReset();
  }
  state.swr = {
    [MANGA_KEY]: { data: manga() },
    [QUOTA_KEY]: { data: quota() },
  };
  state.granted = [Permission.REQUEST_MANGA];
  state.userId = 1;
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

const render = async (editRequest?: MangaScopedRequest) => {
  await act(async () =>
    root.render(
      <IntlProvider locale="en">
        <MangaRequestModal
          mangaId={30013}
          editRequest={editRequest}
          onComplete={state.onComplete}
          onCancel={state.onCancel}
        />
      </IntlProvider>
    )
  );
  await flush();
};

const text = () => host.textContent ?? '';
const button = (testId: string) =>
  host.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
const radio = (label: string) =>
  [...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
    (element) => element.textContent === label
  );
const input = (label: string) => {
  const element = [...host.querySelectorAll('label')].find(
    (candidate) => candidate.textContent === label
  );
  return element
    ? host.querySelector<HTMLInputElement>(
        `[id="${element.getAttribute('for')}"]`
      )
    : null;
};
const errors = () =>
  [...host.querySelectorAll('[role="alert"]')].map(
    (element) => element.textContent
  );

const click = async (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  await act(async () => {
    element!.dispatchEvent(
      new dom.window.MouseEvent('click', { bubbles: true })
    );
  });
  await flush();
};

const type = async (label: string, value: string) => {
  const element = input(label);
  expect(element).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      dom.window.HTMLInputElement.prototype,
      'value'
    )!.set!.call(element, value);
    element!.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  await flush();
};

const submit = () => click(button('modal-ok-button'));
const posted = () => state.post.mock.calls.map((call) => call[1].mangaScope);

it('posts each scope with exactly its own fields', async () => {
  state.post.mockResolvedValue({
    data: { status: MediaRequestStatus.PENDING },
  });
  await render();

  expect(text()).toContain('Request Manga');
  expect(text()).toContain('Sample Manga (1994)');
  expect(text()).toContain(
    'Chapters are chosen when the request is sent to Suwayomi.'
  );
  expect(radio('All chapters')?.getAttribute('aria-checked')).toBe('true');
  await submit();

  await click(radio('Latest chapters'));
  await type('Number of chapters', '25');
  await submit();

  await click(radio('Chapter range'));
  await type('From chapter', '10');
  await submit();
  await type('To chapter (optional)', '20.5');
  await submit();

  expect(state.post.mock.calls[0]).toStrictEqual([
    '/api/v1/request',
    {
      mediaType: 'manga',
      mediaId: 30013,
      mangaScope: { scope: MangaRequestScope.ALL_AT_DISPATCH },
    },
  ]);
  expect(posted()).toStrictEqual([
    { scope: MangaRequestScope.ALL_AT_DISPATCH },
    { scope: MangaRequestScope.LATEST_N, latestCount: 25 },
    { scope: MangaRequestScope.RANGE, rangeStart: 10 },
    { scope: MangaRequestScope.RANGE, rangeStart: 10, rangeEnd: 20.5 },
  ]);
  expect(state.onComplete).toHaveBeenCalledWith(MediaStatus.PENDING);
  expect(state.mutate).toHaveBeenCalledWith('/api/v1/request/count');
  expect(state.mutate).toHaveBeenCalledWith(
    '/api/v1/request?filter=all&take=10&sort=modified&skip=0'
  );
  expect(state.mutate).toHaveBeenCalledWith(MANGA_KEY);
  expect(state.mutate).toHaveBeenCalledWith(QUOTA_KEY);
});

it('reports an auto-approved request as processing', async () => {
  state.granted = [Permission.REQUEST_MANGA, Permission.AUTO_APPROVE_MANGA];
  state.post.mockResolvedValue({
    data: { status: MediaRequestStatus.APPROVED },
  });
  await render();

  expect(text()).toContain('Automatically');
  await submit();

  expect(state.onComplete).toHaveBeenCalledWith(MediaStatus.PROCESSING);
});

it('accepts 1 to 10,000 latest chapters and refuses 0 and 10,001', async () => {
  state.post.mockResolvedValue({ data: {} });
  await render();
  await click(radio('Latest chapters'));

  for (const value of ['0', '10001', '2.5', '-1']) {
    await type('Number of chapters', value);
    expect(errors()).toEqual(['Enter a whole number from 1 to 10,000.']);
    expect(input('Number of chapters')?.getAttribute('aria-invalid')).toBe(
      'true'
    );
    await submit();
  }
  expect(state.post).not.toHaveBeenCalled();

  for (const value of ['1', '10000']) {
    await type('Number of chapters', value);
    expect(errors()).toEqual([]);
    await submit();
  }
  expect(posted()).toStrictEqual([
    { scope: MangaRequestScope.LATEST_N, latestCount: 1 },
    { scope: MangaRequestScope.LATEST_N, latestCount: 10000 },
  ]);
});

it('flags an empty count only after a submit attempt', async () => {
  await render();
  await click(radio('Latest chapters'));

  expect(errors()).toEqual([]);
  await submit();

  expect(errors()).toEqual(['Enter a whole number from 1 to 10,000.']);
  expect(state.post).not.toHaveBeenCalled();
});

it('takes a range with or without an end and refuses an end before the start', async () => {
  state.post.mockResolvedValue({ data: {} });
  await render();
  await click(radio('Chapter range'));

  await type('From chapter', '20');
  await type('To chapter (optional)', '10');
  expect(errors()).toEqual(['The last chapter must not be before the first.']);
  await submit();
  expect(state.post).not.toHaveBeenCalled();

  await type('From chapter', '1000001');
  expect(errors()).toContain('Enter a chapter number from 0 to 1,000,000.');

  await type('From chapter', '0');
  await type('To chapter (optional)', '');
  expect(errors()).toEqual([]);
  await submit();
  expect(posted()).toStrictEqual([
    { scope: MangaRequestScope.RANGE, rangeStart: 0 },
  ]);
});

it('moves the scope choice with the arrow keys', async () => {
  await render();
  const group = host.querySelector('[role="radiogroup"]');
  expect(group?.getAttribute('aria-label')).toBe('Chapters');

  await act(async () => {
    radio('All chapters')!.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', {
        key: 'ArrowRight',
        bubbles: true,
      })
    );
  });

  expect(radio('Latest chapters')?.getAttribute('aria-checked')).toBe('true');
  expect(radio('Latest chapters')?.tabIndex).toBe(0);
  expect(radio('All chapters')?.tabIndex).toBe(-1);
  expect(document.activeElement).toBe(radio('Latest chapters'));
});

it('shows one neutral message for any title that cannot be found', async () => {
  const shown: string[] = [];
  for (const message of ['Manga not found.', 'Another reason.']) {
    state.swr[MANGA_KEY] = { error: rejected(404, message) };
    await render();
    shown.push(text());
    expect(text()).not.toContain(message);
    expect(button('modal-ok-button')).toBeNull();
  }

  expect(shown[0]).toContain('This manga could not be found.');
  expect(shown[1]).toBe(shown[0]);

  state.swr[MANGA_KEY] = { data: manga() };
  state.post.mockRejectedValue(rejected(404, 'Manga not found.'));
  await render();
  await submit();
  expect(text()).toContain('This manga could not be found.');
  expect(text()).not.toContain('Manga not found.');
});

it.each([
  [400, 'LATEST_N takes latestCount only.', 'LATEST_N takes latestCount only.'],
  [403, 'Manga Quota exceeded.', 'Manga Quota exceeded.'],
  [
    409,
    'A request for this manga already exists.',
    'A request for this manga already exists.',
  ],
  [
    429,
    'AniList rate limit.',
    'Manga details are unavailable right now. Try again later.',
  ],
  [
    503,
    'AniList failed.',
    'Manga details are unavailable right now. Try again later.',
  ],
  [
    500,
    'Internal detail.',
    'Something went wrong while submitting the request.',
  ],
])(
  'shows the right message for a %i answer',
  async (status, message, shown) => {
    state.post.mockRejectedValue(rejected(status, message));
    await render();
    await submit();

    expect(text()).toContain(shown);
    if (shown !== message) {
      expect(text()).not.toContain(message);
    }
    expect(state.onComplete).not.toHaveBeenCalled();
  }
);

it('shows the manga quota and blocks a restricted requester', async () => {
  state.swr[QUOTA_KEY] = { data: quota(5, true) };
  await render();

  const display = host.querySelector('[data-testid="quota"]');
  expect(display?.getAttribute('data-media-type')).toBe('manga');
  expect(display?.getAttribute('data-limit')).toBe('5');
  expect(button('modal-ok-button')?.disabled).toBe(true);
});

it('blocks a title that is already available or requested', async () => {
  state.swr[MANGA_KEY] = {
    data: manga({ mediaInfo: { status: MediaStatus.AVAILABLE, requests: [] } }),
  };
  await render();
  expect(button('modal-ok-button')?.disabled).toBe(true);

  state.swr[MANGA_KEY] = {
    data: manga({
      mediaInfo: {
        status: MediaStatus.PENDING,
        requests: [{ status: MediaRequestStatus.PENDING }],
      },
    }),
  };
  await render();
  expect(button('modal-ok-button')?.disabled).toBe(true);
});

it('edits a pending request scope with a PUT', async () => {
  state.granted = [Permission.REQUEST_MANGA, Permission.REQUEST_ADVANCED];
  state.put.mockResolvedValue({ data: {} });
  await render(pendingRequest());

  expect(text()).toContain('Pending Manga Request');
  expect(text()).toContain('Chapters:Latest 25');
  expect(input('Number of chapters')?.value).toBe('25');
  await type('Number of chapters', '30');
  await submit();

  expect(state.put).toHaveBeenCalledWith(REQUEST_KEY, {
    mangaScope: { scope: MangaRequestScope.LATEST_N, latestCount: 30 },
  });
  expect(state.onComplete).toHaveBeenCalledWith(MediaStatus.PENDING);
  expect(state.mutate).toHaveBeenCalledWith(REQUEST_KEY);
  expect(button('modal-secondary-button')?.textContent).toBe('Cancel Request');
});

it('shows the server message when the scope can no longer change', async () => {
  state.granted = [Permission.MANAGE_REQUESTS];
  state.userId = 2;
  state.put.mockRejectedValue(
    rejected(409, 'The chapter scope of this request can no longer change.')
  );
  await render(pendingRequest());

  expect(button('modal-secondary-button')).toBeNull();
  await click(radio('All chapters'));
  await submit();

  expect(state.put).toHaveBeenCalledWith(REQUEST_KEY, {
    mangaScope: { scope: MangaRequestScope.ALL_AT_DISPATCH },
  });
  expect(text()).toContain(
    'The chapter scope of this request can no longer change.'
  );
  expect(state.onComplete).not.toHaveBeenCalled();
});

it('waits for the request scope before showing an edit form', async () => {
  state.granted = [Permission.MANAGE_REQUESTS];
  await render(pendingRequest({ mangaScope: undefined }));
  expect(host.querySelector('[data-testid="loading"]')).toBeTruthy();

  state.swr[REQUEST_KEY] = {
    data: pendingRequest({
      mangaScope: {
        scope: MangaRequestScope.RANGE,
        latestCount: null,
        rangeStart: 10,
        rangeEnd: null,
        awaitingBinding: false,
      },
    }),
  };
  await render(pendingRequest({ mangaScope: undefined }));
  expect(text()).toContain('Chapters:10 onward');
  expect(input('From chapter')?.value).toBe('10');
});

it('lets an owner without advanced requests only cancel', async () => {
  state.delete.mockResolvedValue({});
  await render(pendingRequest());

  expect(host.querySelector('[role="radiogroup"]')).toBeNull();
  expect(text()).toContain('Your request is pending approval.');
  expect(button('modal-ok-button')?.textContent).toBe('Cancel Request');
  await submit();

  expect(state.delete).toHaveBeenCalledWith(REQUEST_KEY);
  expect(state.onComplete).toHaveBeenCalledWith(MediaStatus.UNKNOWN);
});

it('shows other users a read-only request', async () => {
  state.userId = 2;
  await render(pendingRequest());

  expect(host.querySelector('[role="radiogroup"]')).toBeNull();
  expect(button('modal-ok-button')).toBeNull();
  expect(button('modal-secondary-button')).toBeNull();
  expect(text()).toContain("Reader's request is pending approval.");
  expect(text()).toContain('Chapters:Latest 25');
});

it('shows the waiting status only for an approved request awaiting a source', async () => {
  state.granted = [Permission.MANAGE_REQUESTS];
  const waiting = {
    scope: MangaRequestScope.ALL_AT_DISPATCH,
    latestCount: null,
    rangeStart: null,
    rangeEnd: null,
    awaitingBinding: true,
  };

  await render(
    pendingRequest({
      status: MediaRequestStatus.APPROVED,
      mangaScope: waiting,
    })
  );
  expect(text()).toContain('Waiting for a source');
  expect(text()).toContain('An administrator must link a source first.');
  expect(text()).not.toContain('Approved');
  expect(button('modal-ok-button')).toBeNull();

  await render(pendingRequest({ mangaScope: waiting }));
  expect(text()).not.toContain('Waiting for a source');
});
