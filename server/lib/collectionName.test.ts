import { expect, it } from 'vitest';
import { getTvCollectionName } from './collectionName';

it.each([
  ['Yellowstone Franchise', 'Yellowstone Collection'],
  ['Star Trek', 'Star Trek Collection'],
  ['Star Trek Collection', 'Star Trek Collection'],
  ['  Yellowstone FRANCHISE  ', 'Yellowstone Collection'],
  ['The Franchise Story', 'The Franchise Story Collection'],
  ['', 'Collection'],
])(
  'normalizes %s without altering words within its name',
  (input, expected) => {
    expect(getTvCollectionName(input)).toBe(expected);
  }
);
