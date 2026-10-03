import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import type { MangaLibraryErrorCode } from '@server/interfaces/api/mangaLibraryInterfaces';
import type { IntlShape, MessageDescriptor } from 'react-intl';

export const messages = defineMessages('components.Settings.MangaLibrary', {
  queue: 'Review Queue',
  queueDescription:
    'Suwayomi library titles without an AniList match. Proposals are suggestions: nothing is matched until you confirm one or choose a title.',
  matches: 'Library Matches',
  matchesDescription:
    'Suwayomi library titles and the AniList titles they are matched to.',
  libraryTitle: 'Library Title',
  proposal: 'Proposal',
  confidence: 'Confidence',
  high: 'High Confidence',
  medium: 'Medium Confidence',
  low: 'Weak Guess',
  noProposal: 'No Proposal',
  chooseTitle: 'Choose Title',
  reject: 'Reject',
  emptyQueue: 'No Titles to Review',
  scanTip:
    'Title proposals arrive with each library scan; a large library takes several scans. Run the Manga Library Scan job in <link>Jobs & Cache</link> to get them sooner.',
  unknownTitle: 'AniList ID {id} (details unavailable)',
  aniListTitle: 'AniList Title',
  match: 'Match',
  notInLibrary: 'Not in Library',
  rejected: 'Rejected',
  anilistTracker: 'AniList Tracker Link',
  malTracker: 'MyAnimeList Tracker Link',
  mangadexLink: 'Matched with data from <link>MangaDex</link>',
  confirmedByAdmin: 'Confirmed by an Admin',
  chosenByAdmin: 'Chosen by an Admin',
  bindTip:
    'Search AniList and choose the title that matches this library title.',
  matchSaved: 'Match saved.',
  matchRejected: 'Match rejected.',
  errorGone:
    'This title was matched or removed in the meantime. The list was refreshed.',
  errorProposal: 'The proposal changed. Check the new proposal and try again.',
  errorNotInLibrary: 'This title is no longer in the Suwayomi library.',
  errorServer:
    'SeerrNG cannot use this Suwayomi server. Check the Suwayomi settings.',
  errorRetry: 'The Suwayomi settings changed. Try again.',
  errorChanged:
    'This title changed in the meantime. Check the refreshed list and try again.',
  errorLookup:
    'Could not reach Suwayomi; nothing was changed.{code, select, none {} other { ({code})}}',
});

// Ids shared with other screens. The text is identical, so the catalogue
// gains no strings for them.
export const settingsMessages = defineMessages('components.Settings', {
  menuMangaLibrary: 'Manga Library',
});
export const trackingMessages = defineMessages('components.TrackingControls', {
  confirm: 'Confirm',
});
export const requestMessages = defineMessages('components.Requests', {
  active: 'Active',
});
export const searchMessages = defineMessages(
  'components.Discover.DiscoverManga',
  { search: 'Keyword Search', searchManga: 'Search Manga' }
);

type ProposalStrength = 'HIGH' | 'MEDIUM' | 'LOW';

interface ProposalStrengthLabel {
  message: MessageDescriptor;
  badgeType: 'success' | 'warning' | 'danger';
}

const proposalStrengths: Record<ProposalStrength, ProposalStrengthLabel> = {
  HIGH: { message: messages.high, badgeType: 'success' },
  MEDIUM: { message: messages.medium, badgeType: 'warning' },
  LOW: { message: messages.low, badgeType: 'danger' },
};

/**
 * The label for a proposal's strength. On a binding, HIGH, MEDIUM or LOW is
 * the strength of the proposal an admin confirmed.
 */
export const getProposalStrength = (
  confidence: string
): ProposalStrengthLabel | undefined =>
  confidence === 'HIGH' || confidence === 'MEDIUM' || confidence === 'LOW'
    ? proposalStrengths[confidence]
    : undefined;

const errorMessages: Record<MangaLibraryErrorCode, MessageDescriptor> = {
  MANGA_INVALID_REQUEST: globalMessages.error,
  MANGA_INSTANCE_NOT_FOUND: messages.errorServer,
  MANGA_CANDIDATE_NOT_FOUND: messages.errorGone,
  MANGA_ITEM_NOT_FOUND: messages.errorGone,
  MANGA_PROPOSAL_CHANGED: messages.errorProposal,
  MANGA_NOT_IN_LIBRARY: messages.errorNotInLibrary,
  MANGA_UNSUPPORTED_SERVER: messages.errorServer,
  MANGA_INSTANCE_CHANGED: messages.errorRetry,
  MANGA_ITEM_CHANGED: messages.errorChanged,
  MANGA_UNIQUE_CONFLICT: messages.errorChanged,
  MANGA_SUWAYOMI_LOOKUP_FAILED: messages.errorLookup,
};

export const readErrorBody = (error: unknown): Record<string, unknown> => {
  const data = (error as { response?: { data?: unknown } } | null | undefined)
    ?.response?.data;
  return data && typeof data === 'object'
    ? (data as Record<string, unknown>)
    : {};
};

/**
 * Turns a review API failure into translated text. The server's `message` is
 * never shown; an unknown or missing code gets the generic error.
 */
export const describeMangaLibraryError = (
  intl: IntlShape,
  error: unknown
): string => {
  const { code, suwayomiCode } = readErrorBody(error);
  const message =
    typeof code === 'string' &&
    Object.prototype.hasOwnProperty.call(errorMessages, code)
      ? errorMessages[code as MangaLibraryErrorCode]
      : globalMessages.error;
  const detail =
    typeof suwayomiCode === 'string' && /^[A-Z][A-Z_]{0,39}$/.test(suwayomiCode)
      ? suwayomiCode
      : 'none';

  return intl.formatMessage(message, { code: detail });
};
