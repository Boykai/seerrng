import type { CollectionSyncStatus } from '@server/interfaces/api/collectionSync';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  availableDestinationCount,
  availableDestinationIds,
  collectionAddState,
  collectionRemoveState,
} from './collectionActionState';
const status = (
  state: 'exists' | 'missing' | 'unknown' | 'conflict',
  count = 1
): CollectionSyncStatus => ({
  supported: true,
  checkedAt: 1,
  destinations: [
    {
      libraryId: '1',
      libraryName: 'Movies',
      state,
      count,
      availableIds: Array.from({ length: count }, (_, index) => `${index + 1}`),
      managed: true,
      removalToken: state === 'exists' ? 'token' : undefined,
    },
  ],
});
describe('collection buttons', () => {
  it('keeps collection disclosure controls left aligned in shared CSS', () => {
    const css = readFileSync('src/styles/globals.css', 'utf8');
    expect(
      css.match(/\.media-detail-disclosure-row\s*\{([^}]+)\}/)?.[1]
    ).not.toContain('justify-between');
    expect(
      css.match(/\.collection-detail-disclosure-row\s*\{([^}]+)\}/)?.[1]
    ).toContain('justify-start');
  });
  it('enables add only for confirmed missing collections with available members', () => {
    expect(collectionAddState(status('missing'))).toBe('ready');
    expect(collectionAddState(status('missing', 0))).toBe('empty');
    expect(collectionAddState(status('exists'))).toBe('exists');
  });
  it('enables removal only for verified existing collections', () => {
    // Removal intentionally does not depend on the current item selection.
    expect(collectionRemoveState(status('exists'))).toBe('ready');
    expect(collectionRemoveState(status('missing'))).toBe('absent');
    const unverified = status('exists');
    delete unverified.destinations[0].removalToken;
    expect(collectionRemoveState(unverified)).toBe('absent');
  });
  it('enables Add Collection from any available member, independent of card selection', () => {
    const available = status('missing', 2);
    available.destinations[0].availableIds = ['available', 'other'];
    expect(collectionAddState(available)).toBe('ready');
    expect(collectionAddState(status('missing', 0))).toBe('empty');
    expect(availableDestinationCount(available.destinations[0])).toBe(2);
  });
  it('submits all available member IDs across the chosen libraries', () => {
    const first = status('missing', 2).destinations[0];
    first.availableIds = ['available', 'other'];
    const second = {
      ...first,
      libraryId: '2',
      availableIds: ['other', 'another'],
    };
    expect(availableDestinationIds([first, second])).toEqual([
      'available',
      'other',
      'another',
    ]);
  });
  it('limits Add Collection to available members included by the active filters', () => {
    const available = status('missing', 3);
    available.destinations[0].availableIds = ['first', 'filtered', 'last'];
    const visibleIds = ['filtered', 'not-available'];

    expect(collectionAddState(available, undefined, visibleIds)).toBe('ready');
    expect(
      availableDestinationCount(available.destinations[0], visibleIds)
    ).toBe(1);
    expect(availableDestinationIds(available.destinations, visibleIds)).toEqual(
      ['filtered']
    );
    expect(collectionAddState(available, undefined, ['not-available'])).toBe(
      'empty'
    );
  });
  it('disables both actions during uncertainty, ambiguity and unsupported configurations', () => {
    for (const action of [collectionAddState, collectionRemoveState]) {
      expect(action()).toBe('checking');
      expect(action(status('unknown'))).toBe('unavailable');
      expect(action(status('conflict'))).toBe('conflict');
      expect(action(status('exists'), new Error('offline'))).toBe(
        'unavailable'
      );
      expect(action({ ...status('missing'), supported: false })).toBe(
        'unavailable'
      );
    }
  });
});
