import type { WatchProviderDetails } from '@server/models/common';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import type * as ReactIntl from 'react-intl';
import { afterEach, expect, it, vi } from 'vitest';
import { WatchProviderSelector } from './index';

const fixtureState = vi.hoisted(() => ({
  providers: [] as WatchProviderDetails[],
  isLoading: false,
}));
vi.mock('swr', () => ({
  default: () => ({
    data: fixtureState.providers,
    isLoading: fixtureState.isLoading,
  }),
}));
vi.mock('@app/hooks/useSettings', () => ({
  default: () => ({ currentSettings: { discoverRegion: 'US' } }),
}));
vi.mock('@app/hooks/useSearchActivity', () => ({
  useSearchActivityReporter: vi.fn(),
}));
vi.mock('@app/hooks/useDiscover', () => ({
  encodeURIExtraParams: encodeURIComponent,
}));
vi.mock('react-intl', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactIntl>()),
  useIntl: () => ({
    formatMessage: ({ defaultMessage }: { defaultMessage: string }) =>
      defaultMessage,
  }),
}));
vi.mock('@app/components/Common/Tooltip', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@app/components/Common/CachedImage', () => ({
  default: ({ src, alt }: { src: string; alt: string }) => (
    <img src={src} alt={alt} />
  ),
}));
vi.mock('@app/components/Common/Button', () => ({
  default: (
    props: React.ButtonHTMLAttributes<HTMLButtonElement> & {
      buttonSize?: string;
    }
  ) => {
    const attributes = { ...props };
    delete attributes.buttonSize;
    return <button {...attributes} />;
  },
}));
vi.mock('@app/components/RegionSelector', () => ({
  default: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (name: string, value: string) => void;
  }) => (
    <select
      aria-label="Region"
      value={value}
      onChange={(event) => onChange('watchRegion', event.target.value)}
    >
      <option value="US">US</option>
      <option value="GB">GB</option>
    </select>
  ),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function fixture(
  run: (doc: Document, onChange: ReturnType<typeof vi.fn>) => Promise<void>
) {
  const dom = new JSDOM('<form><div id="root"></div></form>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  fixtureState.isLoading = false;
  fixtureState.providers = Array.from({ length: 27 }, (_, id) => ({
    id,
    name: `Fixture Provider ${id}`,
    logoPath: `/provider-${id}.png`,
    displayPriority: id,
  })).reverse();
  const onChange = vi.fn();
  const root = createRoot(document.getElementById('root')!);
  try {
    await act(async () =>
      root.render(
        <WatchProviderSelector
          type="tv"
          region="US"
          regionLabel="Region"
          activeProviders={[0, 26]}
          onChange={onChange}
        />
      )
    );
    onChange.mockClear();
    await run(document, onChange);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
}

function tiles(doc: Document) {
  return Array.from(
    doc.querySelectorAll<HTMLButtonElement>('.provider-container')
  );
}

it('initial provider choices use named native non-submit buttons and expose selection', async () => {
  await fixture(async (doc) => {
    const choices = tiles(doc);
    expect(choices).toHaveLength(24);
    choices.forEach((choice, index) => {
      expect(choice.tagName).toBe('BUTTON');
      expect(choice.type).toBe('button');
      expect(choice.getAttribute('aria-label')).toBe(
        `Fixture Provider ${index}`
      );
      expect(choice.getAttribute('aria-pressed')).toBe(String(index === 0));
      expect(choice.getAttribute('data-selected')).toBe(String(index === 0));
      expect(choice.querySelector('img')?.getAttribute('alt')).toBe('');
      expect(choice.querySelector('img')?.getAttribute('src')).toContain(
        `/provider-${index}.png`
      );
      expect(choice.hasAttribute('role')).toBe(false);
      expect(choice.hasAttribute('tabindex')).toBe(false);
    });
  });
});

it('expanded choices retain order, names and state without changing the filter', async () => {
  await fixture(async (doc, onChange) => {
    const expand = () =>
      doc.querySelector<HTMLButtonElement>(
        '[data-provider-region="expand-control"]'
      )!;
    await act(async () => expand().click());
    const expanded = Array.from(
      doc.querySelectorAll<HTMLButtonElement>(
        '[data-provider-region="expanded"] .provider-container'
      )
    );
    expect(expanded).toHaveLength(3);
    expanded.forEach((choice, index) => {
      expect(choice.tagName).toBe('BUTTON');
      expect(choice.type).toBe('button');
      expect(choice.getAttribute('aria-label')).toBe(
        `Fixture Provider ${index + 24}`
      );
      expect(choice.getAttribute('aria-pressed')).toBe(String(index === 2));
      expect(choice.getAttribute('data-selected')).toBe(String(index === 2));
      expect(choice.querySelector('img')?.getAttribute('alt')).toBe('');
    });
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => expand().click());
    expect(tiles(doc)).toHaveLength(24);
    expect(tiles(doc)[0].getAttribute('aria-pressed')).toBe('true');
    expect(onChange).not.toHaveBeenCalled();
  });
});

it('each native activation toggles once and preserves region reset and selected-ID ordering', async () => {
  await fixture(async (doc, onChange) => {
    const submit = vi.fn((event: Event) => event.preventDefault());
    doc.querySelector('form')!.addEventListener('submit', submit);
    await act(async () => tiles(doc)[1].click());
    expect(onChange).toHaveBeenCalledExactlyOnceWith('US', [0, 26, 1]);
    expect(tiles(doc)[1].getAttribute('aria-pressed')).toBe('true');
    onChange.mockClear();
    await act(async () => tiles(doc)[1].click());
    expect(onChange).toHaveBeenCalledExactlyOnceWith('US', [0, 26]);
    expect(tiles(doc)[1].getAttribute('aria-pressed')).toBe('false');
    expect(submit).not.toHaveBeenCalled();
    onChange.mockClear();
    await act(async () =>
      doc
        .querySelector<HTMLButtonElement>(
          '[data-provider-region="expand-control"]'
        )!
        .click()
    );
    await act(async () => tiles(doc)[26].click());
    expect(onChange).toHaveBeenCalledExactlyOnceWith('US', [0]);
    expect(tiles(doc)[26].getAttribute('aria-pressed')).toBe('false');
    onChange.mockClear();
    await act(async () => tiles(doc)[26].click());
    expect(onChange).toHaveBeenCalledExactlyOnceWith('US', [0, 26]);
    expect(tiles(doc)[26].getAttribute('aria-pressed')).toBe('true');
    expect(submit).not.toHaveBeenCalled();
    onChange.mockClear();
    const region = doc.querySelector<HTMLSelectElement>('select')!;
    await act(async () => {
      region.value = 'GB';
      region.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledExactlyOnceWith('GB', []);
    expect(
      tiles(doc).every((tile) => tile.getAttribute('aria-pressed') === 'false')
    ).toBe(true);
  });
});
