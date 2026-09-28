describe('Discovery provider integrations', () => {
  beforeEach(() => {
    cy.loginAsAdmin();
    cy.intercept('GET', '/api/v1/integrations/discovery/configuration', {
      trakt: { clientId: 'application-id', configured: true },
      anilist: { clientId: 'anilist-id', configured: true },
      simkl: { clientId: 'simkl-id', configured: false },
      mdblist: { configured: true },
    });
    cy.intercept('GET', '/api/v1/integrations/discovery/accounts', {
      accounts: [],
    });
  });
  it('shows application credentials without exposing saved secrets', () => {
    cy.visit('/settings/discovery');
    cy.get('#trakt-clientId').should('have.value', 'application-id');
    cy.get('#trakt-clientSecret')
      .should('have.value', '')
      .and('have.attr', 'type', 'password');
    cy.intercept(
      'PUT',
      '/api/v1/integrations/discovery/configuration',
      (request) => {
        expect(request.body).to.deep.equal({
          trakt: { clientSecret: 'replacement-secret' },
        });
        request.reply({
          trakt: { clientId: 'application-id', configured: true },
          anilist: { clientId: 'anilist-id', configured: true },
          simkl: { clientId: 'simkl-id', configured: false },
          mdblist: { configured: true },
        });
      }
    ).as('saveIntegrations');
    cy.get('#trakt-clientSecret').type('replacement-secret');
    cy.contains('button', 'Save integration settings').click();
    cy.wait('@saveIntegrations');
    cy.contains('Integration settings saved.').should('be.visible');
    cy.get('#trakt-clientSecret').should('have.value', '');
    cy.screenshot('discovery-integrations-settings');
  });
  it('shows personal authorization codes and permits cancelling an attempt', () => {
    cy.intercept(
      'POST',
      '/api/v1/integrations/discovery/accounts/trakt/connect',
      {
        userCode: 'PUBLIC-CODE',
        verificationUrl: 'https://trakt.tv/activate',
        interval: 60,
        expiresIn: 600,
      }
    );
    cy.intercept('DELETE', '/api/v1/integrations/discovery/accounts/trakt', {
      statusCode: 204,
    }).as('cancelConnection');
    cy.visit('/profile/settings/linked-accounts');
    cy.get('section[aria-labelledby="discovery-accounts-title"]').within(() => {
      cy.contains('h4', 'Trakt')
        .parent()
        .parent()
        .contains('button', 'Connect')
        .click();
      cy.contains('PUBLIC-CODE').should('be.visible');
      cy.contains('a', 'Open authorization page').should(
        'have.attr',
        'href',
        'https://trakt.tv/activate'
      );
      cy.contains('button', 'Cancel').click();
    });
    cy.wait('@cancelConnection');
    cy.contains('PUBLIC-CODE').should('not.exist');
  });
  for (const width of [390, 1280])
    it(`browses native catalog results and pages at ${width}px`, () => {
      cy.viewport(width, 900);
      cy.intercept(
        'GET',
        '/api/v1/integrations/discovery/feeds/anilist/trending*',
        (request) => {
          const page = Number(request.query.page ?? 1);
          request.reply({
            page,
            hasMore: page === 1,
            missingMappings: 1,
            items: [
              {
                id: `anilist:${page}`,
                source: 'anilist',
                sourceId: String(page),
                title: `Native catalog title ${page}`,
                mediaType: 'tv',
              },
            ],
          });
        }
      ).as('nativeFeed');
      cy.visit('/discover/providers');
      cy.get('#provider-feed').select('anilist/trending');
      cy.wait('@nativeFeed');
      cy.contains('Native catalog title 1').should('be.visible');
      cy.contains('Catalog match pending').should('be.visible');
      cy.contains('button', 'Next').click();
      cy.wait('@nativeFeed');
      cy.contains('Native catalog title 2').should('be.visible');
      cy.contains('button', 'Next').should('be.disabled');
      cy.document().then((doc) =>
        expect(doc.documentElement.scrollWidth).to.be.at.most(width)
      );
      cy.screenshot(`provider-discovery-${width}`);
    });
});
