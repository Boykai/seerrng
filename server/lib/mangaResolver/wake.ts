let start: (() => void) | undefined;

/** The job scheduler sets how a source resolve run starts. */
export const setMangaSourceResolveStarter = (
  starter: (() => void) | undefined
): void => {
  start = starter;
};

/**
 * Starts a source resolve run now, so a newly approved title is looked for
 * at once. Does nothing while the jobs are not scheduled; never waits.
 */
export const wakeMangaSourceResolve = (): void => {
  start?.();
};
