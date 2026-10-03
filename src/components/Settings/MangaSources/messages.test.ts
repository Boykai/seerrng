import {
  describeResolveError,
  getFailureMessage,
  getReasonMessage,
  getStatusLabel,
} from '@app/components/Settings/MangaSources/messages';
import { createIntl } from 'react-intl';
import { describe, expect, it } from 'vitest';

const intl = createIntl({ locale: 'en' });
const GENERIC = 'Something went wrong. Please try again.';

const failure = (data: unknown) =>
  Object.assign(new Error('Request failed'), { response: { data } });

describe('getStatusLabel', () => {
  it('labels every status with its own badge', () => {
    expect(
      [
        'AWAITING_APPROVAL',
        'QUEUED',
        'NEEDS_PICK',
        'NO_MATCH',
        'EXCLUDED',
        'BOUND',
      ].map((status) => {
        const label = getStatusLabel(status);
        return [label && intl.formatMessage(label.message), label?.badgeType];
      })
    ).toEqual([
      ['Awaiting Approval', 'warning'],
      ['Queued', 'default'],
      ['Needs Pick', 'warning'],
      ['No Match', 'danger'],
      ['Excluded', 'dark'],
      ['Bound', 'success'],
    ]);
  });

  it('has no label for unknown values', () => {
    for (const status of ['PENDING', 'constructor', '__proto__', '']) {
      expect(getStatusLabel(status)).toBeUndefined();
    }
  });
});

describe('getReasonMessage', () => {
  it('gives every reason one fixed message', () => {
    const expected: Record<string, string> = {
      EXISTING_BINDING: 'The title already had a library match.',
      MANGADEX_AMBIGUOUS: 'Several MangaDex entries list this title.',
      EXACT_IN_LIBRARY: 'The exact match is already in the Suwayomi library.',
      EXACT_BOUND_ELSEWHERE: 'The exact match is used by another title.',
      EXACT_REJECTED: 'An admin rejected the exact match.',
      EXACT_NOT_PREFERRED: 'The exact match is not in a preferred language.',
      EXACT_BY_TITLE: 'Only a title search found the exact match.',
      TITLE_MATCHES: 'Only title matches were found.',
      NO_CANDIDATES: 'No source returned this title.',
      NO_ELIGIBLE_SOURCES: 'No selected source can search this title.',
      MANGADEX_FAILED: 'The MangaDex search failed.',
      CONTENT_POLICY: 'The Manga Content settings hide this title.',
      ANILIST_NOT_FOUND: 'AniList no longer lists this title.',
    };

    for (const [reason, text] of Object.entries(expected)) {
      const message = getReasonMessage(reason);
      expect(message && intl.formatMessage(message)).toBe(text);
    }
  });

  it('leaves the credit reasons and unknown values to the caller', () => {
    for (const reason of [
      'EXACT_LINK',
      'ADMIN_BIND',
      'constructor',
      'SOMETHING_NEW',
      null,
    ]) {
      expect(getReasonMessage(reason)).toBeUndefined();
    }
  });
});

describe('getFailureMessage', () => {
  it('gives every failure one fixed message', () => {
    const expected: Record<string, string> = {
      ANILIST_FAILED: 'The AniList lookup failed.',
      ANILIST_RATE_LIMITED: 'AniList is limiting requests.',
      MANGADEX_COOLDOWN: 'MangaDex is limiting requests.',
      MANGADEX_FAILED: 'The MangaDex search failed.',
      SOURCE_SEARCH_FAILED: 'A source search failed.',
      SUWAYOMI_UNAVAILABLE: 'Suwayomi could not be reached.',
      BIND_FAILED: 'The match could not be saved.',
    };

    for (const [code, text] of Object.entries(expected)) {
      const message = getFailureMessage(code);
      expect(message && intl.formatMessage(message)).toBe(text);
    }
    expect(getFailureMessage(null)).toBeUndefined();
    expect(getFailureMessage('toString')).toBeUndefined();
  });
});

describe('describeResolveError', () => {
  it('maps every picker API code to its text and recovery', () => {
    const changed =
      'This title changed in the meantime. Check the refreshed list and try again.';
    const server =
      'SeerrNG cannot use this Suwayomi server. Check the Suwayomi settings.';
    const expected: Record<string, [string, boolean, boolean]> = {
      MANGA_INVALID_REQUEST: [GENERIC, false, false],
      MANGA_SOURCE_NOT_ALLOWED: [
        'This source is not selected in the Suwayomi settings.',
        false,
        false,
      ],
      MANGA_RESOLVE_TITLE_NOT_FOUND: [
        'This title was matched or removed in the meantime. The list was refreshed.',
        false,
        true,
      ],
      MANGA_INSTANCE_NOT_FOUND: [server, false, true],
      MANGA_CANDIDATE_NOT_FOUND: [changed, false, true],
      MANGA_ITEM_NOT_FOUND: [
        'Suwayomi does not know this manga. Search for it in Suwayomi first, then try again.',
        false,
        false,
      ],
      MANGA_ALREADY_BOUND: [
        'This title already has a library match. The list was refreshed.',
        false,
        true,
      ],
      MANGA_CANDIDATE_GONE: [
        'Suwayomi no longer has this suggestion. Search again for new suggestions.',
        false,
        true,
      ],
      MANGA_ITEM_BOUND_ELSEWHERE: [
        'This manga is matched to another title. Reject that match on the Manga Library page first.',
        false,
        false,
      ],
      MANGA_UNSUPPORTED_SERVER: [server, false, false],
      MANGA_INSTANCE_CHANGED: [
        'The Suwayomi settings changed. Try again.',
        true,
        false,
      ],
      MANGA_ITEM_CHANGED: [changed, false, true],
      MANGA_UNIQUE_CONFLICT: [changed, false, true],
      MANGA_SUWAYOMI_LOOKUP_FAILED: [
        'Could not reach Suwayomi; nothing was changed.',
        true,
        false,
      ],
    };

    for (const [code, [text, retry, reload]] of Object.entries(expected)) {
      expect(
        describeResolveError(
          intl,
          failure({ code, message: 'Fixed server text.' })
        )
      ).toEqual({ text, retry, reload });
    }
  });

  it('shows the server message only for an unknown code', () => {
    expect(
      describeResolveError(
        intl,
        failure({ code: 'MANGA_SOMETHING_NEW', message: 'A new problem.' })
      )
    ).toEqual({ text: 'A new problem.', retry: false, reload: false });

    for (const data of [
      { code: 'constructor', message: '  ' },
      { code: '__proto__' },
      { code: 'MANGA_SOMETHING_NEW', message: 42 },
    ]) {
      expect(describeResolveError(intl, failure(data)).text).toBe(GENERIC);
    }
  });

  it('shows the generic message for a body without a code', () => {
    for (const data of [
      { status: 400, message: 'request/body must have required property' },
      { code: 42, message: 'Fixed server text.' },
      'Fixed server text.',
      null,
    ]) {
      expect(describeResolveError(intl, failure(data))).toEqual({
        text: GENERIC,
        retry: false,
        reload: false,
      });
    }
    expect(describeResolveError(intl, new Error('Network Error')).text).toBe(
      GENERIC
    );
    expect(describeResolveError(intl, undefined).text).toBe(GENERIC);
  });

  it('adds a well-formed Suwayomi code to a failed lookup', () => {
    expect(
      describeResolveError(
        intl,
        failure({
          code: 'MANGA_SUWAYOMI_LOOKUP_FAILED',
          message: 'Fixed server text.',
          suwayomiCode: 'TIMEOUT',
        })
      ).text
    ).toBe('Could not reach Suwayomi; nothing was changed. (TIMEOUT)');

    for (const suwayomiCode of ['timeout <b>', 'A'.repeat(41), 7, '']) {
      expect(
        describeResolveError(
          intl,
          failure({ code: 'MANGA_SUWAYOMI_LOOKUP_FAILED', suwayomiCode })
        ).text
      ).toBe('Could not reach Suwayomi; nothing was changed.');
    }
  });
});
