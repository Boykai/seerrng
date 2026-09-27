type OptionalMediaSettingsOverrides = Partial<
  Record<
    | 'musicEnabled'
    | 'booksEnabled'
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
  cy.intercept('GET', '**/api/v1/settings/public*', (request) => {
    request.continue((response) => {
      response.body = {
        ...(response.body as Record<string, unknown>),
        ...overrides,
      };
    });
  });
};
