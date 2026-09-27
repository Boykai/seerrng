import { expect, it } from 'vitest';
import { hasMoreSearchPages } from './searchPagination';
it('uses provider pages instead of the number of matching cards', () => {
  expect(hasMoreSearchPages(50, 1)).toBe(true);
  expect(hasMoreSearchPages(2, 2)).toBe(false);
  expect(hasMoreSearchPages(1, 1)).toBe(false);
  expect(hasMoreSearchPages(undefined, 1)).toBe(false);
});
it('respects the API maximum rather than requesting page 500 repeatedly', () => {
  expect(hasMoreSearchPages(22103, 499)).toBe(true);
  expect(hasMoreSearchPages(22103, 500)).toBe(false);
});
