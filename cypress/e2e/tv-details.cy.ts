describe('TV Details', () => {
  it('loads a tv details page', () => {
    cy.loginAsAdmin();
    // Try to load stranger things
    cy.visit('/tv/66732');

    cy.get('[data-testid=media-title]').should(
      'contain',
      'Stranger Things (2016)'
    );
  });

  it('shows standard and 4K requests in one segmented control', () => {
    cy.loginAsAdmin();
    cy.intercept('GET', '/api/v1/settings/public', (request) => {
      request.continue((response) => {
        response.body.series4kEnabled = true;
      });
    });
    cy.visit('/tv/66732');

    cy.get('[data-testid=format-request-option-standard]')
      .filter(':visible')
      .last()
      .then(($standardButton) => {
        cy.get('[data-testid=format-request-option-4k]')
          .filter(':visible')
          .last()
          .should('be.visible')
          .then(($fourKButton) => {
            expect(
              $fourKButton[0].getBoundingClientRect().left
            ).to.be.greaterThan(
              $standardButton[0].getBoundingClientRect().left
            );
          });
      });
    cy.get('[role="group"][aria-label="Quality"]')
      .should('be.visible')
      .contains('button', 'HD')
      .should('be.visible');
  });

  it('hides the playback quality selector when 4K is not configured', () => {
    cy.loginAsAdmin();
    cy.intercept('GET', '/api/v1/settings/public', (request) => {
      request.continue((response) => {
        response.body.series4kEnabled = false;
      });
    });
    cy.visit('/tv/66732');

    cy.get('[aria-label^="Quality:"]').should('not.exist');
  });

  it('shows seasons and expands episodes', () => {
    cy.loginAsAdmin();

    // Try to load stranger things
    cy.visit('/tv/66732');

    // intercept request for season info
    cy.intercept('/api/v1/tv/66732/season/4').as('season4');

    cy.contains('Season 4').should('be.visible').scrollIntoView().click();

    cy.wait('@season4');

    cy.contains('Chapter Nine').should('be.visible');
  });
});
