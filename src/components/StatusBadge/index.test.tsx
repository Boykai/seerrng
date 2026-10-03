import { MediaStatus } from '@server/constants/media';
import { Permission } from '@server/lib/permissions';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import StatusBadge from '.';

const state = vi.hoisted(() => ({ granted: [] as number[] }));
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
vi.mock('@app/assets/spinner.svg', () => ({ default: () => null }));
vi.mock('@app/components/DownloadBlock', () => ({ default: () => null }));
vi.mock('@app/components/Common/Tooltip', () => ({
  default: ({
    children,
    content,
  }: {
    children: React.ReactNode;
    content?: string;
  }) => <span title={content}>{children}</span>,
}));
vi.mock('@app/hooks/useSettings', () => ({
  default: () => ({ currentSettings: {} }),
}));
vi.mock('@app/hooks/useUser', async () => ({
  Permission: (await import('@server/lib/permissions')).Permission,
  useUser: () => ({
    hasPermission: (required: number | number[]) =>
      (Array.isArray(required) ? required : [required]).some((permission) =>
        state.granted.includes(permission)
      ),
  }),
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
});

afterEach(async () => {
  await act(async () => root.unmount());
  dom.window.close();
  vi.unstubAllGlobals();
});

const render = async (status: MediaStatus) => {
  await act(async () =>
    root.render(
      <IntlProvider locale="en">
        <StatusBadge
          status={status}
          mediaType="manga"
          externalId="30013"
          plexUrl="https://media.invalid/web/item/1"
          serviceUrl="https://service.invalid/manga/1"
        />
      </IntlProvider>
    )
  );
};

it('links managers to the manga page without play or service links', async () => {
  state.granted = [Permission.ADMIN, Permission.MANAGE_REQUESTS];

  for (const [status, label] of [
    [MediaStatus.AVAILABLE, 'Available'],
    [MediaStatus.PARTIALLY_AVAILABLE, 'Partially Available'],
    [MediaStatus.PROCESSING, 'Requested'],
    [MediaStatus.PENDING, 'Pending'],
  ] as const) {
    await render(status);

    expect(host.textContent).toContain(label);
    expect(host.querySelector('a')?.getAttribute('href')).toBe('/manga/30013');
    expect(host.querySelector('span[title]')?.getAttribute('title')).toBe(
      'Manage Manga'
    );
  }
});

it('gives manga requesters a badge with no media server link', async () => {
  state.granted = [Permission.REQUEST, Permission.REQUEST_MANGA];
  await render(MediaStatus.AVAILABLE);

  expect(host.textContent).toContain('Available');
  expect(host.querySelector('a')).toBeNull();
});
