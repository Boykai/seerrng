import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import { isOwnedListboxClick } from './isOwnedListboxClick';

afterEach(() => vi.unstubAllGlobals());

it('keeps its portalled options inside the modal interaction boundary', () => {
  const dom = new JSDOM(`<div id="modal"><span id="label">Server</span></div>
    <div role="listbox" aria-labelledby="label"><div id="option">FLAC</div></div>
    <span id="other-label">Other dialog</span>
    <div role="listbox" aria-labelledby="other-label"><div id="other-option">Other</div></div>`);
  vi.stubGlobal('Element', dom.window.Element);
  const document = dom.window.document;
  const modal = document.getElementById('modal');
  expect(isOwnedListboxClick(modal, document.getElementById('option'))).toBe(
    true
  );
  expect(
    isOwnedListboxClick(modal, document.getElementById('other-option'))
  ).toBe(false);
  expect(isOwnedListboxClick(modal, document.body)).toBe(false);
  expect(isOwnedListboxClick(null, document.body)).toBe(false);
  dom.window.close();
});
