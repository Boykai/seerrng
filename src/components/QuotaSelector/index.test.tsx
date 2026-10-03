import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IntlProvider } from 'react-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import QuotaSelector from '.';

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

const render = async (labelId?: string) => {
  await act(async () =>
    root.render(
      <IntlProvider locale="en" defaultLocale="en" messages={{}}>
        <QuotaSelector
          mediaType="manga"
          defaultLimit={5}
          defaultDays={30}
          dayFieldName="mangaQuotaDays"
          limitFieldName="mangaQuotaLimit"
          labelId={labelId}
          onChange={vi.fn()}
        />
      </IntlProvider>
    )
  );
  return [...host.querySelectorAll('select')];
};

it('names both selects after the given label', async () => {
  const [limit, days] = await render('quotaLabel');

  expect(limit.id).toBe('quotaLabel-limit');
  expect(limit.getAttribute('aria-labelledby')).toBe('quotaLabel');
  expect(days.getAttribute('aria-labelledby')).toBe(
    'quotaLabel quotaLabel-days'
  );
  expect(host.querySelector('#quotaLabel-days')?.textContent).toBe('days');
  expect(host.textContent).toContain('manga per');
});

it('renders unnamed selects when no label is given', async () => {
  const selects = await render();

  expect(selects).toHaveLength(2);
  for (const select of selects) {
    expect(select.hasAttribute('id')).toBe(false);
    expect(select.hasAttribute('aria-labelledby')).toBe(false);
  }
  expect(host.querySelector('[id]')).toBeNull();
  expect(host.textContent).toContain('manga per');
  expect(host.textContent).toContain('days');
});
