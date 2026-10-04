import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import BulkEditModal from './BulkEditModal';

const state = vi.hoisted(() => ({
  enabledMediaCategories: undefined as Record<string, boolean> | undefined,
  put: vi.fn(),
}));

vi.mock('axios', () => ({ default: { put: state.put } }));
vi.mock('@app/hooks/useSettings', () => ({
  default: () => ({
    currentSettings: { enabledMediaCategories: state.enabledMediaCategories },
  }),
}));
vi.mock('@app/hooks/useUser', async () => ({
  Permission: (await import('@server/lib/permissions')).Permission,
  useUser: () => ({ user: { id: 1 } }),
}));
vi.mock('@app/hooks/useToasts', () => ({
  default: () => ({ addToast: vi.fn() }),
}));
vi.mock('@app/components/PermissionEdit', () => ({ default: () => null }));
vi.mock('@app/components/Common/Modal', () => ({
  default: ({
    children,
    onOk,
  }: {
    children: React.ReactNode;
    onOk: () => void;
  }) => (
    <div>
      <button type="button" data-testid="save" onClick={onOk} />
      {children}
    </div>
  ),
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
  state.enabledMediaCategories = undefined;
  state.put.mockReset().mockResolvedValue({ data: [] });
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
        <BulkEditModal
          selectedUserIds={[2, 3]}
          users={
            [
              { id: 2, permissions: 0 },
              { id: 3, permissions: 0 },
            ] as never
          }
        />
      </IntlProvider>
    )
  );
};

const mangaSelect = () =>
  host.querySelector<HTMLSelectElement>('#bulk-watchlistSyncManga');

it('hides the manga auto-request setting while manga is disabled', async () => {
  await render();

  expect(mangaSelect()).toBeNull();
  expect(host.querySelector('#bulk-watchlistSyncComics')).not.toBeNull();
});

it('updates the manga auto-request setting for the selected users', async () => {
  state.enabledMediaCategories = { manga: true };
  await render();

  await act(async () => {
    mangaSelect()!.value = 'enabled';
    mangaSelect()!.dispatchEvent(
      new dom.window.Event('change', { bubbles: true })
    );
  });
  await act(async () => {
    host.querySelector<HTMLButtonElement>('[data-testid="save"]')!.click();
  });

  expect(state.put).toHaveBeenCalledWith('/api/v1/user', {
    ids: [2, 3],
    settings: { watchlistSyncManga: true },
  });
});
