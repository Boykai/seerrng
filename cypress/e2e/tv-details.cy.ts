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

  it('opens one request screen and chooses HD or 4K inside it without submitting', () => {
    cy.loginAsAdmin();
    let submissions = 0;
    cy.intercept('POST', '/api/v1/request*', (request) => {
      submissions += 1;
      request.reply({
        statusCode: 500,
        body: { error: 'Unexpected submission' },
      });
    });
    cy.intercept('GET', '/api/v1/settings/public', (request) => {
      request.continue((response) => {
        response.body.series4kEnabled = true;
      });
    });
    cy.intercept('GET', '/api/v1/tv/66732', (request) => {
      request.continue((response) => {
        // This entry test uses unrequested media, independently of saved requests.
        response.body.mediaInfo = null;
      });
    });
    cy.visit('/tv/66732');

    cy.get('[data-testid=format-request-option-standard]').should('not.exist');
    cy.contains('button', /^Request$/)
      .filter(':visible')
      .should('be.enabled')
      .click();
    cy.get('[role="dialog"]')
      .should('be.visible')
      .within(() => {
        cy.get('[role="group"][aria-label="Quality"]')
          .contains('button', /^HD$/)
          .should('be.visible')
          .and('have.attr', 'aria-pressed', 'true');
        cy.get('[role="group"][aria-label="Quality"]')
          .contains('button', /^4K$/)
          .should('be.enabled')
          .click();
        cy.get('[role="group"][aria-label="Quality"]')
          .contains('button', /^4K$/)
          .should('have.attr', 'aria-pressed', 'true');
        cy.get('[role="group"][aria-label="Quality"]')
          .contains('button', /^HD$/)
          .click()
          .should('have.attr', 'aria-pressed', 'true');
      });
    cy.then(() =>
      expect(
        submissions,
        'screen entry and quality choices do not submit'
      ).to.eq(0)
    );
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

    // The current tree prefetches season metadata before disclosure opens.
    cy.intercept('/api/v1/tv/66732/season/4').as('season4');
    cy.visit('/tv/66732');
    cy.wait('@season4').its('response.statusCode').should('eq', 200);

    cy.get('button[aria-label="Expand Season 04"]')
      .should('be.visible')
      .and('have.attr', 'aria-expanded', 'false')
      .scrollIntoView()
      .click();
    cy.get('button[aria-label="Collapse Season 04"]').should(
      'have.attr',
      'aria-expanded',
      'true'
    );

    cy.get('[data-tree-part="episodes"][aria-label="Season 04 Episodes"]')
      .should('be.visible')
      .contains('[data-tree-part="name"]', 'Chapter Nine')
      .scrollIntoView()
      .should('be.visible');
  });
});
