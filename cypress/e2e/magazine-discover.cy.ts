describe('Magazine discovery sources', () => {
  beforeEach(() => {
    cy.loginAsAdmin();
    cy.mockConfiguredMediaAvailability({ magazinesEnabled: true });
  });

  it('searches the public catalog and preserves the query when switching sources', () => {
    const requestedCatalogs: string[] = [];
    cy.intercept('GET', '/api/v1/discover/magazines*', (request) => {
      const publicCatalog = request.query.catalog === 'public';
      requestedCatalogs.push(publicCatalog ? 'public' : 'tracked');
      request.alias = publicCatalog
        ? 'publicMagazineCatalog'
        : 'trackedMagazineCatalog';
      request.reply({
        page: 1,
        totalPages: 1,
        totalResults: publicCatalog ? 1 : 0,
        results: publicCatalog
          ? [
              {
                id: 'Science Monthly',
                provider: 'googlebooks',
                mediaType: 'magazine',
                title: 'Science Monthly',
                publisher: 'Example Press',
                firstPublishYear: 2026,
                latestIssue: '2026-08',
                requestable: false,
              },
            ]
          : [],
      });
    });

    cy.visit('/discover/magazines?catalog=public&query=science');
    cy.wait('@publicMagazineCatalog')
      .its('request.query')
      .should('deep.include', { catalog: 'public', query: 'science' });
    cy.then(() => expect(requestedCatalogs).to.deep.equal(['public']));

    cy.contains('[data-testid=page-header]', 'Magazines').should('be.visible');
    cy.contains('p', 'Search Google Books for magazine titles.').should(
      'be.visible'
    );
    cy.get('input[aria-label="Search public magazine catalog"]')
      .should('be.visible')
      .and('have.value', 'science');
    cy.get('[data-testid=title-card]')
      .first()
      .trigger('mouseover')
      .within(() => {
        cy.get('[data-testid=title-card-title]').should(
          'contain.text',
          'Science Monthly'
        );
        cy.contains('Example Press').should('be.visible');
        cy.contains('button', 'Request').should('not.exist');
      });

    cy.contains('button', 'Tracked titles').click();
    cy.location('search')
      .should('include', 'query=science')
      .and('not.include', 'catalog=public');
    cy.get('[aria-label="Magazine catalog source"] button')
      .contains('Tracked titles')
      .should('have.attr', 'aria-pressed', 'true');
    cy.get('input[aria-label="Search tracked magazines"]').should(
      'have.value',
      'science'
    );
    cy.wait('@trackedMagazineCatalog')
      .its('request.query')
      .should('deep.include', { query: 'science' })
      .and('not.have.property', 'catalog');
    cy.then(() =>
      expect(requestedCatalogs).to.deep.equal(['public', 'tracked'])
    );
  });
});
