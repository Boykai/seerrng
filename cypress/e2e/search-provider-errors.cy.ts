describe('Search provider errors', () => {
  beforeEach(() => {
    cy.loginAsAdmin();
  });

  it('shows an audiobook catalog failure message and a retry action', () => {
    cy.intercept('GET', '/api/v1/discover/books*', {
      statusCode: 503,
      body: {
        message:
          'The configured audiobook catalog is unavailable. Please try again.',
      },
    }).as('audiobookSearch');

    cy.visit('/search?query=pacific&type=book&format=audiobook');
    cy.wait('@audiobookSearch');
    cy.get('[role="alert"]')
      .should(
        'contain.text',
        'The configured audiobook catalog is unavailable. Please try again.'
      )
      .and('contain.text', 'The catalog could not be reached. Try again.');
    cy.get('[role="alert"]')
      .contains('button', 'Try again')
      .should('be.visible');
  });
});
