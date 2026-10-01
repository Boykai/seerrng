describe('Search provider errors', () => {
  beforeEach(() => {
    cy.loginAsAdmin();
  });

  it('shows an audiobook catalog failure message and a retry action', () => {
    cy.mockConfiguredMediaAvailability({ booksEnabled: true });
    cy.intercept('GET', '/api/v1/discover/books*', {
      page: 1,
      totalPages: 1,
      totalResults: 0,
      results: [],
    }).as('audiobookCatalog');
    cy.intercept('GET', '/api/v1/search*', (request) => {
      expect(request.query.type).to.eq('book');
      expect(request.query.format).to.eq('audiobook');
      request.reply({
        statusCode: 503,
        body: {
          message:
            'The configured audiobook catalog is unavailable. Please try again.',
        },
      });
    }).as('audiobookSearch');

    cy.visit('/search');
    cy.contains('button', 'Media Filters').click();
    cy.contains('button', 'Audiobooks').click();
    cy.location('search').should('include', 'type=book');
    cy.location('search').should('include', 'format=audiobook');
    cy.wait('@audiobookCatalog');
    cy.get('#search_field').type('pacific');
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
