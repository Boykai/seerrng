import { Permission } from '@server/lib/permissions';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PermissionEdit } from '.';

vi.mock('@app/hooks/useSettings', () => ({
  default: () => ({
    currentSettings: { movie4kEnabled: false, series4kEnabled: false },
  }),
}));
vi.mock('@app/hooks/useUser', async () => ({
  Permission: (await import('@server/lib/permissions')).Permission,
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

const render = async (currentPermission: number, onUpdate = vi.fn()) => {
  await act(async () =>
    root.render(
      <IntlProvider locale="en">
        <PermissionEdit
          currentPermission={currentPermission}
          onUpdate={onUpdate}
        />
      </IntlProvider>
    )
  );
  return onUpdate;
};

const checkbox = (id: string) =>
  host.querySelector<HTMLInputElement>(`input[id="${id}"]`);

it('offers manga request and auto-approve permissions but no manga auto-request', async () => {
  await render(0);

  expect(host.textContent).toContain('Request Manga');
  expect(host.textContent).toContain(
    'Grant permission to submit manga requests.'
  );
  expect(host.textContent).toContain('Auto-Approve Manga');
  expect(host.textContent).not.toContain('Auto-Request Manga');
  expect(checkbox('request-manga')).toBeTruthy();
  expect(checkbox('autoapprovemanga')).toBeTruthy();
  expect(host.querySelector('input[id*="autorequestmanga"]')).toBeNull();
});

it('lets auto-approve manga follow the request or manga request permission', async () => {
  await render(0);
  expect(checkbox('autoapprovemanga')?.disabled).toBe(true);

  const onUpdate = await render(Permission.REQUEST_MANGA);
  expect(checkbox('autoapprovemanga')?.disabled).toBe(false);
  await act(async () => {
    checkbox('autoapprovemanga')!.click();
  });
  expect(onUpdate).toHaveBeenCalledWith(
    Permission.REQUEST_MANGA + Permission.AUTO_APPROVE_MANGA
  );

  await render(Permission.REQUEST);
  expect(checkbox('request-manga')?.checked).toBe(true);
  expect(checkbox('request-manga')?.disabled).toBe(true);
  expect(checkbox('autoapprovemanga')?.disabled).toBe(false);
});

it('grants the manga request permission on its own', async () => {
  const onUpdate = await render(0);
  await act(async () => {
    checkbox('request-manga')!.click();
  });

  expect(onUpdate).toHaveBeenCalledWith(Permission.REQUEST_MANGA);
});
