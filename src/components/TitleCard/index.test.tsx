import { MediaStatus } from '@server/constants/media';
import { Permission } from '@server/lib/permissions';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import TitleCard from '.';

const state = vi.hoisted(() => ({
  post: vi.fn(),
  remove: vi.fn(),
  granted: [] as number[],
  settings: {} as { suwayomiEnabled?: boolean },
}));
vi.mock('axios', () => ({
  default: { post: state.post, delete: state.remove },
}));
vi.mock('swr', () => ({ mutate: vi.fn() }));
vi.mock('next/router', () => ({
  useRouter: () => ({ asPath: '/', query: {} }),
}));
vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));
vi.mock('next/dynamic', () => ({
  default:
    () =>
    ({
      show,
      type,
      mangaId,
    }: {
      show?: boolean;
      type?: string;
      mangaId?: number;
    }) =>
      show ? (
        <div
          data-testid="request-modal"
          data-type={type}
          data-manga-id={mangaId}
        />
      ) : null,
}));
vi.mock('@app/assets/spinner.svg', () => ({ default: () => null }));
vi.mock('@headlessui/react', () => ({
  Transition: ({
    show,
    children,
  }: {
    show: boolean;
    children: React.ReactNode;
  }) => (show ? children : null),
}));
vi.mock('@app/components/Common/CachedImage', () => ({
  default: ({ src }: { src: string }) => <img alt="" src={src} />,
}));
vi.mock('@app/components/Association/AssociationBadge', () => ({
  default: () => null,
}));
vi.mock('@app/components/TitleCard/PosterRatingPopover', () => ({
  default: () => null,
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
vi.mock('@app/components/BlocklistConfirmationModal', () => ({
  default: ({ onComplete }: { onComplete: () => void }) => (
    <button type="button" data-testid="confirm-blocklist" onClick={onComplete}>
      confirm
    </button>
  ),
}));
vi.mock('@app/hooks/useIsTouch', () => ({ useIsTouch: () => false }));
vi.mock('@app/hooks/useAlbumArtwork', () => ({
  default: (_id: string | undefined, image: string | undefined) => image,
}));
vi.mock('@app/hooks/useWatchStatus', () => ({
  default: () => ({ data: undefined }),
}));
vi.mock('@app/hooks/useToasts', () => ({
  default: () => ({ addToast: vi.fn() }),
}));
vi.mock('@app/hooks/useSettings', () => ({
  default: () => ({ currentSettings: state.settings }),
}));
vi.mock('@app/hooks/useUser', async () => {
  const permissions = await import('@server/lib/permissions');
  const user = await import('@server/constants/user');
  return {
    Permission: permissions.Permission,
    UserType: user.UserType,
    useUser: () => ({
      user: { id: 7 },
      hasPermission: (required: number | number[]) =>
        (Array.isArray(required) ? required : [required]).some((permission) =>
          state.granted.includes(permission)
        ),
    }),
  };
});

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
  state.post.mockReset();
  state.remove.mockReset();
  state.settings = {};
  state.granted = [
    Permission.REQUEST,
    Permission.REQUEST_MANGA,
    Permission.MANAGE_BLOCKLIST,
  ];
});

afterEach(async () => {
  await act(async () => root.unmount());
  dom.window.close();
  vi.unstubAllGlobals();
});

const renderManga = async (status?: MediaStatus) => {
  await act(async () =>
    root.render(
      <IntlProvider locale="en">
        <TitleCard
          id={30013}
          image="/imageproxy/anilist/file/cover.jpg"
          title="Sample Manga"
          year="1994"
          status={status}
          mediaType="manga"
        />
      </IntlProvider>
    )
  );
};

const click = async (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  await act(async () => {
    element!.dispatchEvent(
      new dom.window.MouseEvent('click', { bubbles: true })
    );
  });
};

const openDetails = () =>
  click(host.querySelector('.app-card-poster-interactive'));

it('renders a manga card with its badge, proxied poster and manga link but no request action', async () => {
  await renderManga();

  expect(host.querySelector('.poster-control-type-manga')?.textContent).toBe(
    'Manga'
  );
  expect(host.querySelector('img')?.getAttribute('src')).toBe(
    '/imageproxy/anilist/file/cover.jpg'
  );

  await openDetails();

  expect(host.querySelector('a')?.getAttribute('href')).toBe('/manga/30013');
  expect(
    [...host.querySelectorAll('button')].map((button) => button.textContent)
  ).not.toContain('Request');
  expect(host.textContent).not.toContain('Request');
});

it('blocklists a manga card by its canonical AniList id', async () => {
  state.post.mockResolvedValue({ status: 201 });
  await renderManga();
  await openDetails();
  await click(host.querySelector('button[aria-label="Add to Blocklist"]'));
  await click(host.querySelector('[data-testid="confirm-blocklist"]'));

  expect(state.post).toHaveBeenCalledWith('/api/v1/blocklist', {
    externalId: '30013',
    externalProvider: 'anilist',
    mediaType: 'manga',
    title: 'Sample Manga',
    user: 7,
  });
  expect(host.querySelector('[data-testid="title-card"]')).toBeNull();
});

it('offers blocklist actions only to blocklist managers', async () => {
  state.granted = [Permission.REQUEST, Permission.REQUEST_MANGA];
  await renderManga();
  await openDetails();

  expect(
    host.querySelector('button[aria-label="Add to Blocklist"]')
  ).toBeNull();
});

it('removes a blocklisted manga card from the manga blocklist', async () => {
  state.remove.mockResolvedValue({ status: 204 });
  await renderManga(MediaStatus.BLOCKLISTED);
  await openDetails();
  await click(host.querySelector('span[title="Remove from Blocklist"] button'));

  expect(state.remove).toHaveBeenCalledWith(
    '/api/v1/blocklist/30013?mediaType=manga'
  );
});

const requestButton = () =>
  [...host.querySelectorAll('button')].find(
    (button) => button.textContent === 'Request'
  );

it.each([
  ['a manga request permission', true, [Permission.REQUEST_MANGA], true],
  ['the general request permission', true, [Permission.REQUEST], true],
  ['only another media permission', true, [Permission.REQUEST_COMIC], false],
  [
    'no configured Suwayomi server',
    false,
    [Permission.REQUEST, Permission.REQUEST_MANGA],
    false,
  ],
])(
  'shows the manga Request button with %s: %s',
  async (_case, suwayomiEnabled, granted, shown) => {
    state.settings = { suwayomiEnabled };
    state.granted = granted;
    await renderManga();
    await openDetails();

    expect(host.querySelector('a')?.getAttribute('href')).toBe('/manga/30013');
    expect(!!requestButton()).toBe(shown);
  }
);

it.each([
  [undefined, true],
  [MediaStatus.UNKNOWN, true],
  [MediaStatus.DELETED, true],
  [MediaStatus.PARTIALLY_AVAILABLE, true],
  [MediaStatus.PENDING, false],
  [MediaStatus.PROCESSING, false],
  [MediaStatus.AVAILABLE, false],
  [MediaStatus.BLOCKLISTED, false],
])('offers a manga request at status %s: %s', async (status, shown) => {
  state.settings = { suwayomiEnabled: true };
  await renderManga(status);
  await openDetails();

  expect(!!requestButton()).toBe(shown);
});

it('opens the manga request modal with the AniList id', async () => {
  state.settings = { suwayomiEnabled: true };
  await renderManga();
  await openDetails();
  expect(host.querySelector('[data-testid="request-modal"]')).toBeNull();
  await click(requestButton());

  const modal = host.querySelector('[data-testid="request-modal"]');
  expect(modal?.getAttribute('data-type')).toBe('manga');
  expect(modal?.getAttribute('data-manga-id')).toBe('30013');
});
