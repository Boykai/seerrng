import MediaQualitySelect from '@app/components/MediaDetails/MediaQualitySelect';
import RequestButton from '@app/components/RequestButton';
import { MediaStatus } from '@server/constants/media';
import type Media from '@server/entity/Media';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@app/components/Common/Tooltip', () => ({
  default: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@app/hooks/useSettings', () => ({
  default: () => ({
    currentSettings: { movie4kEnabled: true, series4kEnabled: true },
  }),
}));
vi.mock('@app/hooks/useToasts', () => ({
  default: () => ({ addToast: vi.fn() }),
}));
vi.mock('@app/hooks/useUser', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useUser: () => ({
    user: { id: 1, permissions: 2 },
    hasPermission: () => true,
  }),
}));
vi.mock('swr', () => ({
  default: () => ({
    data: [
      { id: 0, is4k: false },
      { id: 1, is4k: true },
    ],
  }),
  mutate: vi.fn(),
}));
vi.mock('next/dynamic', () => ({ default: () => () => null }));

let dom: JSDOM;
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>');
  for (const key of ['window', 'document', 'Element', 'Node', 'HTMLElement']) {
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
});
afterEach(async () => {
  await act(async () => root.unmount());
  dom.window.close();
  vi.unstubAllGlobals();
});
const renderQuality = async (
  hdDisabled: boolean,
  fourKDisabled: boolean,
  value = 'hd',
  onChange = vi.fn(),
  autoSelectAvailable = true
) => {
  await act(async () =>
    root.render(
      <IntlProvider locale="en">
        <MediaQualitySelect
          label="Quality"
          value={value}
          onChange={onChange}
          autoSelectAvailable={autoSelectAvailable}
          options={[
            { label: 'HD', value: 'hd', disabled: hdDisabled },
            { label: '4K', value: '4k', disabled: fourKDisabled },
          ]}
        />
      </IntlProvider>
    )
  );
  return onChange;
};

it('renders segmented qualities, blocks unavailable clicks and retains descriptive help', async () => {
  const change = await renderQuality(false, true);
  const hd = host.querySelector<HTMLButtonElement>(
    '[data-testid="format-request-option-hd"]'
  )!;
  const fourK = host.querySelector<HTMLButtonElement>(
    '[data-testid="format-request-option-4k"]'
  )!;
  expect(host.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe(
    'Quality'
  );
  expect(host.querySelector('[role="listbox"]')).toBeNull();
  expect(hd.getAttribute('aria-pressed')).toBe('true');
  expect(fourK.disabled).toBe(true);
  expect(fourK.getAttribute('data-disabled-reason')).toContain('not available');
  await act(async () => fourK.click());
  expect(change).not.toHaveBeenCalled();
  await act(async () => hd.click());
  expect(change).toHaveBeenCalledWith('hd');
});
it('falls back to an available quality when availability changes', async () => {
  const change = await renderQuality(true, false);
  expect(change).toHaveBeenCalledWith('4k');
});
it('can retain the HD default without automatically switching a collection to 4K', async () => {
  const change = await renderQuality(true, false, 'hd', vi.fn(), false);
  expect(change).not.toHaveBeenCalled();
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>(
        '[data-testid="format-request-option-4k"]'
      )!
      .click()
  );
  expect(change).toHaveBeenCalledExactlyOnceWith('4k');
});
it('does not select or enable anything when neither quality is available', async () => {
  const change = await renderQuality(true, true);
  expect(change).not.toHaveBeenCalled();
  expect(
    [...host.querySelectorAll('button')].every((button) => button.disabled)
  ).toBe(true);
  expect(host.querySelector('[aria-pressed="true"]')).toBeNull();
});
it('can select either quality when both are available', async () => {
  const change = await renderQuality(false, false);
  await act(async () =>
    host
      .querySelector<HTMLButtonElement>(
        '[data-testid="format-request-option-4k"]'
      )!
      .click()
  );
  expect(change).toHaveBeenCalledWith('4k');
});

it.each([
  ['movie', MediaStatus.AVAILABLE, MediaStatus.UNKNOWN, true, false],
  ['movie', MediaStatus.UNKNOWN, MediaStatus.AVAILABLE, false, true],
  ['movie', MediaStatus.AVAILABLE, MediaStatus.AVAILABLE, true, true],
  ['tv', MediaStatus.PARTIALLY_AVAILABLE, MediaStatus.UNKNOWN, false, false],
  ['tv', MediaStatus.AVAILABLE, MediaStatus.UNKNOWN, true, false],
] as const)(
  'request controls respect %s availability %s/%s even with advanced permissions',
  (mediaType, status, status4k, hdDisabled, fourKDisabled) => {
    host.innerHTML = renderToStaticMarkup(
      <IntlProvider locale="en">
        <RequestButton
          mediaType={mediaType}
          tmdbId={1}
          onUpdate={() => undefined}
          media={{ status, status4k, requests: [] } as unknown as Media}
        />
      </IntlProvider>
    );
    const hd = host.querySelector<HTMLButtonElement>(
      '[data-testid="format-request-option-standard"]'
    )!;
    const fourK = host.querySelector<HTMLButtonElement>(
      '[data-testid="format-request-option-4k"]'
    )!;
    expect(hd.disabled).toBe(hdDisabled);
    expect(fourK.disabled).toBe(fourKDisabled);
    if (hdDisabled)
      expect(hd.getAttribute('data-disabled-reason')).toBe(
        'This format is already available.'
      );
  }
);
