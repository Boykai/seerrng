import './commands';

beforeEach(() => {
  // These tests explicitly assert metadata HTTP responses. A browser-cached
  // response bypasses cy.intercept even when the real UI loads successfully.
  // Keep real payloads, requests and assertions; disable only test-side caching
  // of read-only movie/series details and season metadata, before any visit.
  cy.intercept(
    {
      method: 'GET',
      pathname: /^\/api\/v1\/(?:movie|tv)\/\d+(?:\/season\/\d+)?$/,
      middleware: true,
    },
    (request) => {
      request.on('before:response', (response) => {
        response.headers['cache-control'] = 'no-store';
      });
    }
  );
});

before(() => {
  if (Cypress.expose('SEED_DATABASE') === true) {
    cy.task('seedDatabase');
  }
});
