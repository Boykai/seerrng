import { MediaRequestStatus } from '@server/constants/media';
import type { RequestStatusResultsResponse } from '@server/interfaces/api/requestInterfaces';
import { Permission } from '@server/lib/permissions';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Requests from '.';

type StatusItem = RequestStatusResultsResponse['results'][number];

const state = vi.hoisted(() => ({
  results: [] as unknown[],
  post: vi.fn(),
  mutate: vi.fn(),
  addToast: vi.fn(),
  user: { id: 0, permissions: 0 },
}));
vi.mock('swr', () => ({
  default: (key: string | null) =>
    key?.startsWith('/api/v1/request/status?')
      ? {
          data: {
            pageInfo: { pages: 1, pageSize: 10, results: 1, page: 1 },
            results: state.results,
            counts: {
              total: state.results.length,
              active: 0,
              incomplete: 0,
              attention: state.results.length,
              completed: 0,
              unavailable: 0,
              failed: state.results.length,
            },
            olderCount: 0,
          },
          error: undefined,
          isValidating: false,
          mutate: state.mutate,
        }
      : { mutate: vi.fn() },
  useSWRConfig: () => ({ cache: new Map(), mutate: vi.fn() }),
}));
vi.mock('axios', () => ({
  default: {
    post: state.post,
    get: vi.fn(),
    put: vi.fn(),
    isAxiosError: () => false,
  },
}));
vi.mock('next/router', () => ({
  useRouter: () => ({
    isReady: true,
    query: {},
    pathname: '/requests',
    asPath: '/requests',
    push: vi.fn(),
    replace: vi.fn(),
  }),
}));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('next/link', () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));
vi.mock('@app/hooks/useUser', async () => {
  const permissions = await import('@server/lib/permissions');
  return {
    Permission: permissions.Permission,
    useUser: () => ({
      user: state.user,
      hasPermission: (
        required: number | number[],
        options?: { type: 'and' | 'or' }
      ) => permissions.hasPermission(required, state.user.permissions, options),
    }),
  };
});
vi.mock('@app/hooks/useSettings', () => ({
  default: () => ({ currentSettings: {} }),
}));
vi.mock('@app/hooks/useToasts', () => ({
  default: () => ({ addToast: state.addToast }),
}));
vi.mock('@app/hooks/useMediaFilterPin', () => ({
  default: () => ({
    available: false,
    busy: false,
    error: false,
    toggle: vi.fn(),
  }),
}));
vi.mock('@app/hooks/useRequestStatusScrollRestoration', () => ({
  default: () => undefined,
}));
vi.mock('@app/hooks/useSearchActivity', () => ({
  default: () => false,
  useSearchActivityReporter: () => undefined,
}));
vi.mock('@app/components/Common/PageTitle', () => ({ default: () => null }));
vi.mock('@app/components/Common/PaginationFooter', () => ({
  default: () => null,
}));
vi.mock('@app/components/Common/CachedImage', () => ({
  default: () => null,
}));
vi.mock('@app/components/Common/Tooltip', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@app/components/RequestStatus/SoftwareRequests', () => ({
  default: () => null,
}));
vi.mock('@app/components/RequestModal/AdvancedRequester', () => ({
  RequestListboxControl: () => null,
}));
vi.mock('@app/components/Discover/FilterPanel/CompactFilterSelect', () => ({
  CompactSelect: () => null,
  FilterResetButton: () => null,
  getFilterToggleButtonClass: () => '',
}));
vi.mock('@app/components/Discover/PinnedFilterSection', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PinnedFilterSectionGroup: ({
    sections,
  }: {
    sections: { section: string; children: React.ReactNode }[];
  }) =>
    sections.map(({ section, children }) => (
      <React.Fragment key={section}>{children}</React.Fragment>
    )),
}));
vi.mock('@app/components/Discover/MediaFilterOption', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const OWNER_ID = 7;
const MANAGER_ID = 1;

const statusItem = (
  id: number,
  type: 'manga' | 'movie',
  status: MediaRequestStatus
): StatusItem =>
  ({
    request: {
      id,
      type,
      status,
      is4k: false,
      createdAt: '2026-10-01T12:00:00.000Z',
      updatedAt: '2026-10-02T12:00:00.000Z',
      requestedBy: {
        id: OWNER_ID,
        displayName: 'Requesting User',
        avatar: '',
      },
      media: { id: id + 100, tmdbId: type === 'movie' ? 9101 : 0 },
    },
    status: {
      stage: 'failed',
      attempt: 0,
      percent: null,
      size: null,
      sizeLeft: null,
      estimatedCompletionTime: null,
      downloadCount: 0,
      downloadId: null,
      service: null,
      message: 'Some chapters failed to download.',
      observedAt: '2026-10-02T12:00:00.000Z',
      isTerminal: true,
      needsAttention: true,
      retryable: true,
    },
  }) as unknown as StatusItem;

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
  state.post.mockReset().mockResolvedValue({ data: {} });
  state.mutate.mockReset().mockResolvedValue(undefined);
  state.addToast.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  dom.window.close();
  vi.unstubAllGlobals();
});

const render = async (results: StatusItem[], user: typeof state.user) => {
  state.results = results;
  state.user = user;
  await act(async () =>
    root.render(
      <IntlProvider locale="en">
        <Requests />
      </IntlProvider>
    )
  );
};

const retryButtons = () =>
  [...host.querySelectorAll<HTMLButtonElement>('article button')].filter(
    (button) => button.textContent === 'Retry'
  );

const click = async (button: HTMLButtonElement) => {
  await act(async () => {
    button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
};

it('keeps the chapter retry of an approved manga request from its requester', async () => {
  await render([statusItem(41, 'manga', MediaRequestStatus.APPROVED)], {
    id: OWNER_ID,
    permissions: Permission.REQUEST | Permission.REQUEST_MANGA,
  });

  const buttons = retryButtons();
  expect(buttons.length).toBeGreaterThan(0);
  expect(buttons.every((button) => button.disabled)).toBe(true);

  await click(buttons[0]);

  expect(state.post).not.toHaveBeenCalled();
});

it.each([
  ['a request manager', Permission.MANAGE_REQUESTS],
  ['an administrator', Permission.ADMIN],
])(
  'lets %s retry the chapters of an approved manga request',
  async (_viewer, permissions) => {
    await render([statusItem(41, 'manga', MediaRequestStatus.APPROVED)], {
      id: MANAGER_ID,
      permissions,
    });

    const [button] = retryButtons();
    expect(button?.disabled).toBe(false);

    await click(button);

    expect(state.post).toHaveBeenCalledWith('/api/v1/request/41/retry');
    expect(state.mutate).toHaveBeenCalled();
  }
);

it.each([
  ['a failed manga request', 'manga', MediaRequestStatus.FAILED],
  ['an approved movie request', 'movie', MediaRequestStatus.APPROVED],
] as const)(
  'still lets the requester retry %s',
  async (_label, type, status) => {
    await render([statusItem(42, type, status)], {
      id: OWNER_ID,
      permissions: Permission.REQUEST | Permission.REQUEST_MANGA,
    });

    const [button] = retryButtons();
    expect(button?.disabled).toBe(false);

    await click(button);

    expect(state.post).toHaveBeenCalledWith('/api/v1/request/42/retry');
  }
);
