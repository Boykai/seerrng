import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ControlProps } from 'react-select';
import { expect, it, vi } from 'vitest';
import { compactSelectComponents } from './index';

it('keeps the base layout class separate in every compact control state', () => {
  vi.stubGlobal('React', React);
  const Control = compactSelectComponents.Control;
  for (const isDisabled of [false, true]) {
    for (const isFocused of [false, true]) {
      for (const menuIsOpen of [false, true]) {
        const props = {
          isDisabled,
          isFocused,
          menuIsOpen,
          innerProps: {},
          children: 'Artist',
        } as ControlProps<unknown, false>;
        const html = renderToStaticMarkup(<Control {...props} />);
        const classes = html.match(/class="([^"]+)"/)![1].split(' ');
        expect(classes).toContain('react-select__control');
        expect(classes.includes('react-select__control--is-focused')).toBe(
          isFocused
        );
        expect(classes.includes('react-select__control--is-disabled')).toBe(
          isDisabled
        );
        expect(classes.includes('react-select__control--menu-is-open')).toBe(
          menuIsOpen
        );
      }
    }
  }
});
