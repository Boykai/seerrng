import { JSDOM } from 'jsdom';
import type * as ReactModule from 'react';
import React, { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { PinnedFilterSectionGroup } from './PinnedFilterSection';

const state = vi.hoisted(() => ({
  pins: {
    taskFilters: false,
    mediaFilters: false,
    filters: false,
    sortBy: false,
  },
  togglePinned: vi.fn(),
}));
// React may defer a functional updater. Exercise that supported scheduling
// explicitly: correctness must not depend on an eager synchronous callback.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>();
  return {
    ...actual,
    useState: <T,>(initial: T | (() => T)) => {
      const [value, update] = actual.useState(initial);
      const deferredUpdate = (next: React.SetStateAction<T>) => {
        queueMicrotask(() => update(next));
      };
      return [value, deferredUpdate] as const;
    },
  };
});
vi.mock('@app/hooks/useDetailDisclosurePins', () => ({ default: () => state }));
vi.mock('@app/components/MediaDetails/DetailDisclosureButton', () => ({
  default: ({
    label,
    open,
    pinned,
    onClick,
    onPinClick,
    controls,
  }: {
    label: string;
    open: boolean;
    pinned: boolean;
    onClick: () => void;
    onPinClick: () => void;
    controls: string;
  }) => (
    <>
      <button
        type="button"
        aria-label={'Pin ' + label}
        aria-pressed={pinned}
        onClick={onPinClick}
      >
        Pin
      </button>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={controls}
        onClick={onClick}
      >
        {label}
      </button>
    </>
  ),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function fixture(
  run: (render: () => Promise<void>, doc: Document) => Promise<void>
) {
  const dom = new JSDOM('<div id="root"></div>');
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('React', React);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.pins = {
    taskFilters: false,
    mediaFilters: false,
    filters: false,
    sortBy: false,
  };
  const root = createRoot(document.getElementById('root')!);
  const render = async () => {
    await act(async () =>
      root.render(
        <StrictMode>
          <PinnedFilterSectionGroup
            mediaType="tv"
            sections={[
              {
                section: 'filters',
                label: 'Filters',
                children: <span>Filter controls</span>,
              },
              {
                section: 'sortBy',
                label: 'Sort',
                children: <span>Sort controls</span>,
              },
            ]}
          />
        </StrictMode>
      )
    );
  };
  try {
    await render();
    await run(render, document);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
}

it('late saved pins expand and unpins collapse the matching section in StrictMode', async () => {
  await fixture(async (render, doc) => {
    const heading = () => doc.querySelector('button[aria-controls]')!;
    expect(heading().getAttribute('aria-expanded')).toBe('false');
    state.pins = { ...state.pins, filters: true };
    await render();
    expect(heading().getAttribute('aria-expanded')).toBe('true');
    expect(doc.body.textContent).toContain('Filter controls');
    state.pins = { ...state.pins, filters: false };
    await render();
    expect(heading().getAttribute('aria-expanded')).toBe('false');
    expect(doc.body.textContent).not.toContain('Filter controls');
  });
});

it('a pin change leaves other sections and manual heading toggles independent', async () => {
  await fixture(async (render, doc) => {
    const headings = () =>
      Array.from(
        doc.querySelectorAll<HTMLButtonElement>('button[aria-controls]')
      );
    await act(async () => headings()[1].click());
    expect(headings()[1].getAttribute('aria-expanded')).toBe('true');
    state.pins = { ...state.pins, filters: true };
    await render();
    expect(headings()[0].getAttribute('aria-expanded')).toBe('true');
    expect(headings()[1].getAttribute('aria-expanded')).toBe('true');
    await act(async () => headings()[0].click());
    expect(headings()[0].getAttribute('aria-expanded')).toBe('false');
    await act(async () =>
      (
        doc.querySelector(
          'button[aria-label="Pin Filters"]'
        ) as HTMLButtonElement
      ).click()
    );
    expect(state.togglePinned).toHaveBeenCalledExactlyOnceWith('filters');
  });
});

it('restored saved pin state reverses optimistic expansion without a provider or account write', async () => {
  await fixture(async (render, doc) => {
    state.pins = { ...state.pins, filters: true, sortBy: true };
    await render();
    expect(doc.querySelectorAll('button[aria-expanded="true"]')).toHaveLength(
      2
    );
    state.pins = { ...state.pins, filters: false };
    await render();
    expect(doc.querySelectorAll('button[aria-expanded="true"]')).toHaveLength(
      1
    );
    expect(doc.body.textContent).toContain('Sort controls');
    expect(doc.body.textContent).not.toContain('Filter controls');
  });
});
