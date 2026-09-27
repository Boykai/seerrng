import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { renderToStaticMarkup } from 'react-dom/server';
import SelectionCircle, { selectFromRow } from './index';

describe('SelectionCircle', () => {
  it('exposes a mixed pressed state for partial selection', () => {
    const markup = renderToStaticMarkup(
      <SelectionCircle
        selected={false}
        partial
        label="Partially selected season"
        onClick={() => undefined}
      />
    );

    assert.match(markup, /aria-pressed="mixed"/);
    assert.match(markup, /data-partial="true"/);
  });

  it('retains the normal pressed state for full selection', () => {
    const markup = renderToStaticMarkup(
      <SelectionCircle
        selected
        label="Fully selected season"
        onClick={() => undefined}
      />
    );

    assert.match(markup, /aria-pressed="true"/);
    assert.doesNotMatch(markup, /data-partial/);
  });

  it('selects a button-role row but ignores a nested button', () => {
    const previousElement = Object.getOwnPropertyDescriptor(
      globalThis,
      'Element'
    );
    class TestElement {
      constructor(
        private parent?: TestElement,
        private interactive = false
      ) {}

      closest(): TestElement | null {
        return this.interactive ? this : (this.parent?.closest() ?? null);
      }
    }
    Object.defineProperty(globalThis, 'Element', {
      configurable: true,
      value: TestElement,
    });

    try {
      const row = new TestElement(undefined, true);
      const rowText = new TestElement(row);
      const nestedButton = new TestElement(row, true);
      let selections = 0;
      const select = () => selections++;

      selectFromRow(
        { target: rowText, currentTarget: row } as unknown as Parameters<
          typeof selectFromRow
        >[0],
        select
      );
      selectFromRow(
        { target: nestedButton, currentTarget: row } as unknown as Parameters<
          typeof selectFromRow
        >[0],
        select
      );

      assert.strictEqual(selections, 1);
    } finally {
      if (previousElement) {
        Object.defineProperty(globalThis, 'Element', previousElement);
      } else {
        Reflect.deleteProperty(globalThis, 'Element');
      }
    }
  });
});
