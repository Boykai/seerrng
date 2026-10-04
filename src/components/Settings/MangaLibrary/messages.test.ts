import {
  describeMangaLibraryError,
  getProposalStrength,
} from '@app/components/Settings/MangaLibrary/messages';
import { createIntl } from 'react-intl';
import { describe, expect, it } from 'vitest';

const intl = createIntl({ locale: 'en' });
const GENERIC = 'Something went wrong. Please try again.';

const failure = (data: unknown) =>
  Object.assign(new Error('Request failed'), { response: { data } });

describe('describeMangaLibraryError', () => {
  it('maps every review API code to its own text', () => {
    const expected: Record<string, string> = {
      MANGA_INVALID_REQUEST: GENERIC,
      MANGA_INSTANCE_NOT_FOUND:
        'SeerrNG cannot use this Suwayomi server. Check the Suwayomi settings.',
      MANGA_CANDIDATE_NOT_FOUND:
        'This title was matched or removed in the meantime. The list was refreshed.',
      MANGA_ITEM_NOT_FOUND:
        'This title was matched or removed in the meantime. The list was refreshed.',
      MANGA_PROPOSAL_CHANGED:
        'The proposal changed. Check the new proposal and try again.',
      MANGA_NOT_IN_LIBRARY: 'This title is no longer in the Suwayomi library.',
      MANGA_UNSUPPORTED_SERVER:
        'SeerrNG cannot use this Suwayomi server. Check the Suwayomi settings.',
      MANGA_INSTANCE_CHANGED: 'The Suwayomi settings changed. Try again.',
      MANGA_ITEM_CHANGED:
        'This title changed in the meantime. Check the refreshed list and try again.',
      MANGA_UNIQUE_CONFLICT:
        'This title changed in the meantime. Check the refreshed list and try again.',
      MANGA_SUWAYOMI_LOOKUP_FAILED:
        'Could not reach Suwayomi; nothing was changed.',
    };

    for (const [code, text] of Object.entries(expected)) {
      expect(
        describeMangaLibraryError(
          intl,
          failure({ code, message: 'upstream detail' })
        )
      ).toBe(text);
    }
  });

  it('never shows the server message', () => {
    const text = describeMangaLibraryError(
      intl,
      failure({
        code: 'MANGA_PROPOSAL_CHANGED',
        message: 'raw upstream text',
      })
    );

    expect(text).not.toContain('raw upstream text');
  });

  it('falls back to the generic message for unknown or missing codes', () => {
    for (const data of [
      { code: 'MANGA_SOMETHING_NEW', message: 'raw upstream text' },
      { code: 'constructor' },
      { code: '__proto__' },
      { code: 'hasOwnProperty' },
      { code: 42 },
      { message: 'raw upstream text' },
      'raw upstream text',
      null,
    ]) {
      expect(describeMangaLibraryError(intl, failure(data))).toBe(GENERIC);
    }
    expect(describeMangaLibraryError(intl, new Error('Network Error'))).toBe(
      GENERIC
    );
    expect(describeMangaLibraryError(intl, undefined)).toBe(GENERIC);
  });

  it('adds a well-formed Suwayomi code to a failed lookup', () => {
    expect(
      describeMangaLibraryError(
        intl,
        failure({
          code: 'MANGA_SUWAYOMI_LOOKUP_FAILED',
          message: 'raw upstream text',
          suwayomiCode: 'TIMEOUT',
        })
      )
    ).toBe('Could not reach Suwayomi; nothing was changed. (TIMEOUT)');

    for (const suwayomiCode of ['timeout <b>', 'A'.repeat(41), 7, '']) {
      expect(
        describeMangaLibraryError(
          intl,
          failure({ code: 'MANGA_SUWAYOMI_LOOKUP_FAILED', suwayomiCode })
        )
      ).toBe('Could not reach Suwayomi; nothing was changed.');
    }
  });
});

describe('getProposalStrength', () => {
  it('labels the three proposal strengths and LOW as a weak guess', () => {
    expect(
      ['HIGH', 'MEDIUM', 'LOW'].map((confidence) => {
        const strength = getProposalStrength(confidence);
        return [
          strength && intl.formatMessage(strength.message),
          strength?.badgeType,
        ];
      })
    ).toEqual([
      ['High Confidence', 'success'],
      ['Medium Confidence', 'warning'],
      ['Weak Guess', 'danger'],
    ]);
  });

  it('has no label for link confidences or unknown values', () => {
    for (const confidence of [
      'EXACT_LINK',
      'TRACKER_LINK',
      'MANUAL',
      'constructor',
      '',
    ]) {
      expect(getProposalStrength(confidence)).toBeUndefined();
    }
  });
});
