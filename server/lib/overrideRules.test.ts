import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import OverrideRule from '@server/entity/OverrideRule';
import {
  catalogOverrideRuleMatches,
  getOverrideRuleProfileId,
  getOverrideRuleSpecificity,
  getOverrideRuleTagIds,
  overrideRuleMatchesUser,
  selectMostSpecificOverrideRule,
} from './overrideRules';

describe('override rule selection', () => {
  it('falls back when catalog metadata needed by a rule is absent', () => {
    const metadataRule = new OverrideRule({
      users: '7',
      genre: 'Rock',
      keywords: 'Acoustic',
      language: 'en',
    });
    assert.strictEqual(catalogOverrideRuleMatches(metadataRule, 7), false);
    assert.strictEqual(
      catalogOverrideRuleMatches(metadataRule, 7, {
        genres: ['rock'],
        keywords: ['ACOUSTIC'],
        languages: ['eng'],
      }),
      true
    );
    assert.strictEqual(
      catalogOverrideRuleMatches(metadataRule, 8, {
        genres: ['rock'],
        keywords: ['acoustic'],
        languages: ['eng'],
      }),
      false
    );
    assert.strictEqual(
      catalogOverrideRuleMatches(new OverrideRule({ users: '7' }), 7),
      true
    );
  });
  it('counts every configured condition and ignores empty legacy values', () => {
    assert.strictEqual(
      getOverrideRuleSpecificity(
        new OverrideRule({
          users: '7',
          genre: '18',
          language: ' ',
          keywords: null as unknown as string,
        })
      ),
      2
    );
  });

  it('prefers user-specific rules and uses stable IDs for ties', () => {
    const general = new OverrideRule({ id: 1, genre: '18' });
    const laterTie = new OverrideRule({ id: 9, users: '7', genre: '18' });
    const earlierTie = new OverrideRule({ id: 4, users: '7', keywords: '99' });

    assert.strictEqual(
      selectMostSpecificOverrideRule([laterTie, general, earlierTie]),
      earlierTie
    );
    assert.strictEqual(overrideRuleMatchesUser(earlierTie, 7), true);
    assert.strictEqual(overrideRuleMatchesUser(earlierTie, 8), false);
    assert.strictEqual(overrideRuleMatchesUser(new OverrideRule(), 8), true);
  });

  it('does not mutate repository result ordering', () => {
    const first = new OverrideRule({ id: 1 });
    const second = new OverrideRule({ id: 2, users: '7' });
    const rules = [first, second];

    assert.strictEqual(selectMostSpecificOverrideRule(rules), second);
    assert.deepStrictEqual(rules, [first, second]);
  });

  it('can rank only conditions supported by a media type', () => {
    const irrelevantConditions = new OverrideRule({
      id: 1,
      genre: '18',
      language: 'en',
      keywords: '99',
    });
    const musicUser = new OverrideRule({ id: 2, users: '7' });

    assert.strictEqual(
      selectMostSpecificOverrideRule(
        [irrelevantConditions, musicUser],
        ['users']
      ),
      musicUser
    );
  });

  it('sanitizes legacy routing values before provider use', () => {
    assert.strictEqual(
      getOverrideRuleProfileId(new OverrideRule({ profileId: 0 })),
      0
    );
    assert.strictEqual(
      getOverrideRuleProfileId(new OverrideRule({ profileId: -1 })),
      undefined
    );
    assert.deepStrictEqual(
      getOverrideRuleTagIds(
        new OverrideRule({ tags: '7,nope,-1,7,0,1000000001' })
      ),
      [7, 0]
    );
  });
});
