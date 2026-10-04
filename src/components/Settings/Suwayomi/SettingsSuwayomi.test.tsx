import SettingsSuwayomi from '@app/components/Settings/Suwayomi/SettingsSuwayomi';
import { REDACTED_SECRET } from '@app/utils/secret';
import type * as HeadlessUi from '@headlessui/react';
import type { SuwayomiSettingsView } from '@server/interfaces/api/suwayomiInterfaces';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  data: undefined as unknown,
  error: undefined as unknown,
  revalidate: vi.fn(),
  mutate: vi.fn(),
  delete: vi.fn(),
  addToast: vi.fn(),
}));
vi.mock('swr', () => ({
  default: () => ({
    data: state.data,
    error: state.error,
    mutate: state.revalidate,
  }),
  mutate: state.mutate,
}));
vi.mock('axios', () => ({ default: { delete: state.delete } }));
vi.mock('@app/hooks/useToasts', () => ({
  default: () => ({ addToast: state.addToast }),
}));
vi.mock('next/dynamic', () => ({
  default:
    () =>
    ({
      suwayomi,
      onSave,
    }: {
      suwayomi: SuwayomiSettingsView | null;
      onSave: () => void;
    }) => (
      <div data-testid="suwayomi-modal" data-mode={suwayomi ? 'edit' : 'add'}>
        <button type="button" data-testid="modal-save" onClick={onSave} />
      </div>
    ),
}));
vi.mock('@headlessui/react', async (importOriginal) => ({
  ...(await importOriginal<typeof HeadlessUi>()),
  Transition: ({
    show,
    children,
  }: {
    show: boolean;
    children: React.ReactNode;
  }) => (show ? <>{children}</> : null),
}));
vi.mock('@app/components/Common/Modal', () => ({
  default: (props: {
    title: string;
    children: React.ReactNode;
    okText: string;
    okDisabled: boolean;
    onOk: () => void;
    onCancel: () => void;
  }) => (
    <div data-testid="delete-modal">
      <h2>{props.title}</h2>
      {props.children}
      <button
        type="button"
        data-testid="modal-ok-button"
        disabled={props.okDisabled}
        onClick={props.onOk}
      >
        {props.okText}
      </button>
      <button
        type="button"
        data-testid="modal-cancel-button"
        onClick={props.onCancel}
      >
        Cancel
      </button>
    </div>
  ),
}));

const view: SuwayomiSettingsView = {
  id: 1,
  name: 'Manga Server',
  hostname: 'suwayomi.test',
  port: 4567,
  useSsl: true,
  baseUrl: '/manga',
  isDefault: true,
  authMode: 'UI_LOGIN',
  username: 'reader',
  password: REDACTED_SECRET,
  sourceAllowlist: ['1001', '1002'],
  preferredLanguages: [],
  scanlatorPreference: [],
  requireCbz: true,
};

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
    'MutationObserver',
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
  state.data = [];
  state.error = undefined;
  state.revalidate.mockReset();
  state.mutate.mockReset();
  state.delete.mockReset();
  state.addToast.mockReset();
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
        <SettingsSuwayomi />
      </IntlProvider>
    )
  );
};

const byTestId = (testId: string) =>
  host.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
const buttonByText = (label: string) =>
  [...host.querySelectorAll('button')].find(
    (button) => button.textContent === label
  );
const text = () => host.textContent ?? '';

const click = async (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  await act(async () => {
    element!.dispatchEvent(
      new dom.window.MouseEvent('click', { bubbles: true })
    );
  });
};

const rejected = (status: number, data: unknown) =>
  Object.assign(new Error('Request failed'), { response: { status, data } });

it('offers to add a server only while none exists', async () => {
  await render();
  expect(text()).toContain('Suwayomi Settings');
  expect(byTestId('suwayomi-modal')).toBeNull();

  await click(buttonByText('Add Suwayomi Server'));
  expect(byTestId('suwayomi-modal')?.dataset.mode).toBe('add');

  await click(byTestId('modal-save'));
  expect(state.revalidate).toHaveBeenCalledTimes(1);
  expect(state.mutate).toHaveBeenCalledWith('/api/v1/settings/public');
  expect(byTestId('suwayomi-modal')).toBeNull();
});

it('shows the stored server with its address, auth mode and source count', async () => {
  state.data = [view];
  await render();

  expect(buttonByText('Add Suwayomi Server')).toBeUndefined();
  expect(text()).toContain('Manga Server');
  expect(text()).toContain('https://suwayomi.test:4567/manga');
  expect(text()).toContain('UI Login');
  expect(text()).toContain('SSL');
  const details = [...host.querySelectorAll('dt')].map((term) => [
    term.textContent,
    term.nextElementSibling?.textContent,
  ]);
  expect(details).toContainEqual(['Sources', '2']);
  expect(text()).not.toContain(REDACTED_SECRET);

  await click(buttonByText('Edit'));
  expect(byTestId('suwayomi-modal')?.dataset.mode).toBe('edit');
});

it('deletes the server after confirmation and refreshes', async () => {
  state.data = [view];
  state.delete.mockResolvedValueOnce({ status: 204 });
  await render();

  await click(buttonByText('Delete'));
  expect(byTestId('delete-modal')?.textContent).toContain(
    'Delete Suwayomi Server'
  );
  await click(byTestId('modal-ok-button'));

  expect(state.delete).toHaveBeenCalledWith('/api/v1/settings/suwayomi/1');
  expect(state.revalidate).toHaveBeenCalledTimes(1);
  expect(state.mutate).toHaveBeenCalledWith('/api/v1/settings/public');
  expect(byTestId('delete-modal')).toBeNull();
});

it('explains why a delete was refused and keeps the confirmation open', async () => {
  state.data = [view];
  state.delete.mockRejectedValueOnce(
    rejected(409, { code: 'SUWAYOMI_IN_USE', message: 'Fixed.' })
  );
  await render();

  await click(buttonByText('Delete'));
  await click(byTestId('modal-ok-button'));

  expect(state.addToast).toHaveBeenCalledWith(
    'Suwayomi is used by active manga requests and cannot be deleted.',
    expect.objectContaining({ appearance: 'error' })
  );
  expect(byTestId('delete-modal')).not.toBeNull();
  expect(byTestId('modal-ok-button')?.disabled).toBe(false);
  expect(state.revalidate).not.toHaveBeenCalled();
});

it('shows an error instead of the list when the settings fail to load', async () => {
  state.data = undefined;
  state.error = new Error('Request failed with status code 500');
  await render();

  expect(text()).toContain('Failed to load the Suwayomi settings.');
  expect(text()).not.toContain('status code');
  expect(buttonByText('Add Suwayomi Server')).toBeUndefined();
});
