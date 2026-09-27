describe('Movie Details', () => {
  it('loads a movie page', () => {
    cy.loginAsAdmin();
    // Try to load minions: rise of gru
    cy.visit('/movie/438148');

    cy.get('[data-testid=media-title]').should(
      'contain',
      'Minions: The Rise of Gru (2022)'
    );
  });

  it('shows standard and 4K requests in one segmented control', () => {
    cy.loginAsAdmin();
    cy.intercept('GET', '/api/v1/settings/public', (request) => {
      request.continue((response) => {
        response.body.movie4kEnabled = true;
      });
    });
    cy.visit('/movie/438148');

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
  });

  it('hides the 4K request action without 4K request permission', () => {
    cy.loginAsUser();
    cy.intercept('GET', '/api/v1/settings/public', (request) => {
      request.continue((response) => {
        response.body.movie4kEnabled = true;
      });
    });
    cy.visit('/movie/438148');

    cy.get('[data-testid=format-request-option-standard]').should('be.visible');
    cy.get('[data-testid=format-request-option-4k]').should('not.exist');
  });

  it('opens a single-quality request from anywhere on the request button', () => {
    cy.loginAsAdmin();
    cy.intercept('GET', '/api/v1/settings/public', (request) => {
      request.continue((response) => {
        response.body.movie4kEnabled = false;
      });
    });
    cy.intercept('GET', '/api/v1/service/radarr', [
      {
        id: 1,
        name: 'Test Radarr',
        is4k: false,
        isDefault: true,
        activeProfileId: 1,
        activeDirectory: '/movies',
        activeTags: [],
      },
    ]);
    cy.visit('/movie/438148');

    cy.get('[data-testid=format-request-control]')
      .filter(':has([data-testid="format-request-option-standard"])')
      .first()
      .should('be.visible')
      .and('be.enabled')
      .click('left');

    cy.get('[role="dialog"]').should('be.visible');
    cy.get('[role="dialog"]').should('contain.text', 'Movie · HD');
  });

  it('keeps unavailable management visible but disabled with an explanation', () => {
    cy.loginAsAdmin();
    cy.visit('/movie/438148?manage=1');
    cy.get('button[aria-label="Manage Movie"]')
      .should('be.visible')
      .and('be.disabled')
      .and(
        'have.attr',
        'data-disabled-reason',
        'This title must be added to a media service before it can be managed.'
      );
    cy.get('button[aria-label="Close panel"]').should('not.exist');
  });
});
