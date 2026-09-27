import { JSDOM } from 'jsdom';
import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import useModalBackNavigation from './useModalBackNavigation';

afterEach(() => {
  vi.unstubAllGlobals();
});

it('closes the top screen with browser Back and consumes its entry on Cancel', async () => {
  const dom = new JSDOM('<html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/music/album',
  });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const root = createRoot(document.getElementById('root')!);

  function Screen() {
    const [open, setOpen] = useState(true);
    return (
      <>
        {open && <Dialog onCancel={() => setOpen(false)} />}
        {!open && <button onClick={() => setOpen(true)}>Open</button>}
      </>
    );
  }

  function Dialog({ onCancel }: { onCancel: () => void }) {
    useModalBackNavigation(onCancel);
    return <button onClick={onCancel}>Cancel</button>;
  }

  try {
    await act(async () =>
      root.render(
        <React.StrictMode>
          <Screen />
        </React.StrictMode>
      )
    );
    expect(document.body.textContent).toBe('Cancel');
    expect(window.history.length).toBe(2);

    await act(async () => {
      const popped = new Promise<void>((resolve) =>
        window.addEventListener('popstate', () => resolve(), { once: true })
      );
      window.history.back();
      await popped;
    });
    expect(document.body.textContent).toBe('Open');
    expect(window.location.pathname).toBe('/music/album');

    await act(async () => {
      document.querySelector<HTMLButtonElement>('button')!.click();
    });
    expect(document.body.textContent).toBe('Cancel');

    await act(async () => {
      const popped = new Promise<void>((resolve) =>
        window.addEventListener('popstate', () => resolve(), { once: true })
      );
      document.querySelector<HTMLButtonElement>('button')!.click();
      await popped;
    });
    expect(document.body.textContent).toBe('Open');
    expect(window.location.pathname).toBe('/music/album');
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

it('closes only the top screen when dialogs are nested', async () => {
  const dom = new JSDOM('<html><body><div id="root"></div></body></html>', {
    url: 'http://localhost/music/album',
  });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const root = createRoot(document.getElementById('root')!);

  function Dialog({ onCancel }: { onCancel: () => void }) {
    useModalBackNavigation(onCancel);
    return <button onClick={onCancel}>Cancel</button>;
  }

  function Screens() {
    const [innerOpen, setInnerOpen] = useState(true);
    return (
      <>
        <Dialog onCancel={() => undefined} />
        {innerOpen && <Dialog onCancel={() => setInnerOpen(false)} />}
        <output>{innerOpen ? 'both' : 'outer only'}</output>
      </>
    );
  }

  try {
    await act(async () => root.render(<Screens />));
    expect(window.history.length).toBe(3);
    await act(async () => {
      const popped = new Promise<void>((resolve) =>
        window.addEventListener('popstate', () => resolve(), { once: true })
      );
      window.history.back();
      await popped;
    });
    expect(document.querySelector('output')?.textContent).toBe('outer only');
    expect(document.querySelectorAll('button')).toHaveLength(1);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
