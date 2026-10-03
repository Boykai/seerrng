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

  it('offers shared-size public catalog suggestions that start a search', () => {
    const publicQueries: string[] = [];
    cy.intercept('GET', '/api/v1/discover/magazines*', (request) => {
      publicQueries.push(String(request.query.query ?? ''));
      request.alias = 'publicMagazineSuggestions';
      request.reply({ page: 1, totalPages: 1, totalResults: 0, results: [] });
    });

    cy.viewport(375, 812);
    cy.visit('/discover/magazines?catalog=public');
    cy.wait('@publicMagazineSuggestions');
    cy.contains('button', 'National Geographic')
      .should('be.visible')
      .and(($button) => {
        const button = $button[0];
        const document = button.ownerDocument;
        const view = document.defaultView!;
        const probe = document.createElement('div');
        probe.style.position = 'absolute';
        probe.style.visibility = 'hidden';
        probe.style.height = view
          .getComputedStyle(button)
          .getPropertyValue('--action-control-height');
        document.body.appendChild(probe);
        const sharedHeight = parseFloat(view.getComputedStyle(probe).height);
        probe.remove();
        expect(
          sharedHeight,
          'configured shared action height'
        ).to.be.greaterThan(0);
        expect(button.getBoundingClientRect().height).to.be.closeTo(
          sharedHeight,
          0.5
        );
      })
      .click();

    cy.get('input[aria-label="Search public magazine catalog"]').should(
      'have.value',
      'National Geographic'
    );
    cy.wait('@publicMagazineSuggestions')
      .its('request.query')
      .should('deep.include', {
        catalog: 'public',
        query: 'National Geographic',
      });
    cy.then(() =>
      expect(publicQueries).to.deep.equal(['', 'National Geographic'])
    );
  });
});
