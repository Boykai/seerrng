type OptionalMediaSettingsOverrides = Partial<
  Record<
    | 'musicEnabled'
    | 'booksEnabled'
    | 'ebookServiceEnabled'
    | 'audiobookServiceEnabled'
    | 'comicsEnabled'
    | 'magazinesEnabled'
    | 'softwareEnabled'
    | 'romarrEnabled',
    boolean
  >
>;

export const mockConfiguredMediaAvailability = (
  overrides: OptionalMediaSettingsOverrides
) => {
  const availabilityOverrides = { ...overrides };

  if (typeof overrides.booksEnabled === 'boolean') {
    availabilityOverrides.ebookServiceEnabled ??= overrides.booksEnabled;
    availabilityOverrides.audiobookServiceEnabled ??= overrides.booksEnabled;
  }

  cy.intercept('GET', '**/api/v1/settings/public*', (request) => {
    request.continue((response) => {
      response.body = {
        ...(response.body as Record<string, unknown>),
        ...availabilityOverrides,
      };
    });
  });
};
