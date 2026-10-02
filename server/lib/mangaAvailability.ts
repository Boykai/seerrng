import { MediaStatus } from '@server/constants/media';

/** One stored chapter, as Suwayomi lists it. */
export interface MangaChapterState {
  chapterNumber: number;
  isDownloaded: boolean;
}

export interface MangaAvailabilityInput {
  /** Suwayomi's `chapters.totalCount`. */
  chapterCount: number;
  downloadCount: number;
  hasDuplicateChapters: boolean;
  /** Every chapter of the manga; read only when `needsMangaChapterStates`. */
  chapterStates?: readonly MangaChapterState[];
}

/**
 * `'none'` means no downloaded chapter: an "in library" marker only.
 * `'unreadable'` means the inputs contradict each other, so the caller keeps
 * what it had.
 */
export type MangaAvailability =
  | MediaStatus.AVAILABLE
  | MediaStatus.PARTIALLY_AVAILABLE
  | 'none'
  | 'unreadable';

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Duplicate chapter numbers with some, but not all, chapters downloaded. */
export const needsMangaChapterStates = ({
  chapterCount,
  downloadCount,
  hasDuplicateChapters,
}: MangaAvailabilityInput): boolean =>
  hasDuplicateChapters === true &&
  isCount(chapterCount) &&
  isCount(downloadCount) &&
  downloadCount > 0 &&
  downloadCount < chapterCount;

/**
 * The single manga availability rule, shared by every writer so they never
 * disagree. Pure: plain data in, a status out; callers decide how to apply it.
 *
 * With duplicate chapter numbers (several releases of one chapter), each
 * distinct number from 0 up is one wanted unit and is downloaded when any of
 * its rows is. A negative number means "unnumbered", so each such row is a
 * unit of its own.
 */
export const computeMangaAvailability = ({
  chapterCount,
  downloadCount,
  hasDuplicateChapters,
  chapterStates,
}: MangaAvailabilityInput): MangaAvailability => {
  if (
    !isCount(chapterCount) ||
    !isCount(downloadCount) ||
    typeof hasDuplicateChapters !== 'boolean'
  ) {
    return 'unreadable';
  }
  if (chapterCount === 0 || downloadCount === 0) return 'none';
  if (downloadCount >= chapterCount) return MediaStatus.AVAILABLE;
  if (!hasDuplicateChapters) return MediaStatus.PARTIALLY_AVAILABLE;

  // The list must be the same snapshot the counts came from.
  if (!Array.isArray(chapterStates) || chapterStates.length !== chapterCount) {
    return 'unreadable';
  }
  // Map keys compare with SameValueZero, so -0 and 0 are one unit.
  const numbered = new Map<number, boolean>();
  let unnumberedMissing = false;
  let downloaded = 0;
  for (const state of chapterStates) {
    if (
      typeof state?.chapterNumber !== 'number' ||
      !Number.isFinite(state.chapterNumber) ||
      typeof state.isDownloaded !== 'boolean'
    ) {
      return 'unreadable';
    }
    if (state.isDownloaded) downloaded += 1;
    if (state.chapterNumber < 0) {
      unnumberedMissing ||= !state.isDownloaded;
    } else {
      numbered.set(
        state.chapterNumber,
        numbered.get(state.chapterNumber) === true || state.isDownloaded
      );
    }
  }
  if (downloaded !== downloadCount) return 'unreadable';
  return !unnumberedMissing && [...numbered.values()].every(Boolean)
    ? MediaStatus.AVAILABLE
    : MediaStatus.PARTIALLY_AVAILABLE;
};
