import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import type Media from '@server/entity/Media';
import { Permission } from '@server/lib/permissions';
import axios from 'axios';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import RequestButton from './index';

const state = vi.hoisted(() => ({
  permissions: 0,
  services: [] as { is4k: boolean }[],
}));
vi.mock('axios', () => ({ default: { post: vi.fn() } }));
vi.mock('swr', () => ({
  default: () => ({ data: state.services }),
  mutate: vi.fn(),
}));
vi.mock('@app/hooks/useSettings', () => ({
  default: () => ({ currentSettings: { series4kEnabled: true } }),
}));
vi.mock('@app/hooks/useToasts', () => ({
  default: () => ({ addToast: vi.fn() }),
}));
vi.mock('@app/hooks/useUser', async () => {
  const { Permission, hasPermission } = await import('@server/lib/permissions');
  return {
    Permission,
    useUser: () => ({
      user: { id: 7, permissions: state.permissions },
      hasPermission: (
        permissions: Parameters<typeof hasPermission>[0],
        options?: Parameters<typeof hasPermission>[2]
      ) => hasPermission(permissions, state.permissions, options),
    }),
  };
});
vi.mock('next/dynamic', () => ({
  default: () =>
    function RequestScreen({
      is4k,
      show4kSelector,
      editRequest,
    }: {
      is4k?: boolean;
      show4kSelector?: boolean;
      editRequest?: { id: number };
    }) {
      return (
        <div
          data-testid="request-screen"
          data-quality={is4k ? '4k' : 'hd'}
          data-quality-selector={show4kSelector}
          data-edit={editRequest?.id}
        />
      );
    },
}));
vi.mock('@app/components/Common/Button', () => ({
  default: ({
    children,
    onClick,
    disabled,
    buttonType,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    buttonType?: string;
  }) => (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-button-type={buttonType}
    >
      {children}
    </button>
  ),
}));
vi.mock('@app/components/Common/Tooltip', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));

let dom: JSDOM;
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
beforeEach(() => {
  state.permissions = Permission.REQUEST_TV | Permission.REQUEST_4K_TV;
  state.services = [{ is4k: false }, { is4k: true }];
  vi.clearAllMocks();
  dom = new JSDOM('<!doctype html><body></body>');
  vi.stubGlobal('React', React);
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  dom.window.close();
  vi.unstubAllGlobals();
});
const render = async (
  props: Partial<React.ComponentProps<typeof RequestButton>> = {}
) => {
  await act(async () =>
    root.render(
      <IntlProvider locale="en">
        <RequestButton
          mediaType="tv"
          tmdbId={1}
          onUpdate={vi.fn()}
          buttonType="detailRequest"
          singleRequestEntry
          {...props}
        />
      </IntlProvider>
    )
  );
};
const clickRequest = async () => {
  const button = Array.from(host.querySelectorAll('button')).find(
    (node) => node.textContent === 'Request'
  );
  expect(button).toBeDefined();
  await act(async () => button!.click());
  return button!;
};

it('opens the request screen from one shared action, leaving quality selection inside', async () => {
  await render();
  expect(host.querySelectorAll('button')).toHaveLength(1);
  expect(
    host.querySelector('[data-testid="format-request-control"]')
  ).toBeNull();
  const button = await clickRequest();
  expect(button.dataset.buttonType).toBe('detailRequest');
  expect(
    host
      .querySelector('[data-testid="request-screen"]')
      ?.getAttribute('data-quality-selector')
  ).toBe('true');
  expect(
    host
      .querySelector('[data-testid="request-screen"]')
      ?.getAttribute('data-quality')
  ).toBe('hd');
  expect(axios.post).not.toHaveBeenCalled();
});
it('opens the permitted 4K target when HD cannot be requested', async () => {
  state.permissions = Permission.REQUEST_4K_TV;
  await render();
  await clickRequest();
  expect(
    host
      .querySelector('[data-testid="request-screen"]')
      ?.getAttribute('data-quality')
  ).toBe('4k');
});
it('opens a pending request for review instead of approving it on navigation', async () => {
  state.permissions |= Permission.AUTO_APPROVE_TV | Permission.MANAGE_REQUESTS;
  await render({
    media: {
      status: MediaStatus.PENDING,
      status4k: MediaStatus.UNKNOWN,
      requests: [
        {
          id: 11,
          status: MediaRequestStatus.PENDING,
          is4k: false,
          requestedBy: { id: 7 },
        },
      ],
    } as Media,
  });
  await clickRequest();
  expect(
    host
      .querySelector('[data-testid="request-screen"]')
      ?.getAttribute('data-edit')
  ).toBe('11');
  expect(axios.post).not.toHaveBeenCalled();
});
it('keeps the entry disabled when no configured service is eligible', async () => {
  state.services = [];
  await render();
  expect((await clickRequest()).disabled).toBe(true);
  expect(host.querySelector('[data-testid="request-screen"]')).toBeNull();
});
it('does not expose the entry without request permission', async () => {
  state.permissions = 0;
  await render();
  expect(host.querySelector('button')).toBeNull();
});
it('preserves split quality controls for consumers that have not opted in', async () => {
  await render({ singleRequestEntry: false });
  expect(
    host.querySelector('[data-testid="format-request-option-standard"]')
      ?.textContent
  ).toBe('HD');
  expect(
    host.querySelector('[data-testid="format-request-option-4k"]')?.textContent
  ).toBe('4K');
});
