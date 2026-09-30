import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validateAdvancedThemeOverrides } from './advancedThemeOverrides';

describe('advanced theme override validation', () => {
  it('accepts only supported visual tokens and normalizes hex colors', () => {
    assert.deepEqual(
      validateAdvancedThemeOverrides({
        '--theme-page-bg': '#ABC',
        '--color-indigo-500': '#123456',
        '--theme-page-spotlight-strength': 0.4,
        '--theme-page-gradient-main-stop': '72%',
        '--theme-detail-divider-shadow': 'none',
      }),
      {
        value: {
          '--theme-page-bg': '#aabbcc',
          '--color-indigo-500': '#123456',
          '--theme-page-spotlight-strength': 0.4,
          '--theme-page-gradient-main-stop': '72%',
          '--theme-detail-divider-shadow': 'none',
        },
      }
    );
  });

  it('rejects arbitrary CSS values, variables, and out-of-range settings', () => {
    for (const overrides of [
      { '--theme-page-bg': 'url(https://example.invalid/x)' },
      { '--theme-page-bg': 'var(--something)' },
      { '--theme-unknown': '#123456' },
      { '--theme-page-spotlight-strength': 1.1 },
      { '--theme-page-gradient-main-stop': '101%' },
      { '--theme-detail-divider-shadow': '0 0 100px red' },
    ]) {
      assert.ok('error' in validateAdvancedThemeOverrides(overrides));
    }
  });

  it('treats an empty object and null as no saved overrides', () => {
    assert.deepEqual(validateAdvancedThemeOverrides({}), { value: null });
    assert.deepEqual(validateAdvancedThemeOverrides(null), { value: null });
  });
});
