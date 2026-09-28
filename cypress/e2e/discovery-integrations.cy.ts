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
  for (const width of [390, 1280])
    it(`browses and updates a personal library at ${width}px`, () => {
      cy.viewport(width, 900);
      cy.intercept('GET', '/api/v1/integrations/discovery/accounts', {
        accounts: [
          { provider: 'anilist', username: 'Reader', allowWrites: true },
        ],
      });
      cy.intercept('GET', '/imageproxy/anilist/**', {
        statusCode: 200,
        headers: { 'content-type': 'image/svg+xml' },
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="blue"/></svg>',
      });
      cy.intercept('GET', '/api/v1/integrations/discovery/library/anilist*', {
        items: [
          {
            id: 'anilist:101',
            source: 'anilist',
            sourceId: '101',
            title: 'Personal anime title',
            mediaType: 'tv',
            status: 'watching',
            rating: 7.5,
            progress: 3,
            totalEpisodes: 12,
            imageUrl: 'https://s4.anilist.co/file/cover.jpg',
          },
        ],
        page: 1,
        hasMore: false,
        allowWrites: true,
        missingMappings: 1,
        truncated: false,
      });
      cy.intercept(
        'POST',
        '/api/v1/integrations/discovery/tracking/anilist',
        (request) => {
          expect(request.body.requestId).to.match(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
          );
          request.reply({
            requestId: request.body.requestId,
            provider: 'anilist',
            state: 'succeeded',
            createdAt: new Date().toISOString(),
          });
        }
      ).as('trackingUpdate');
      cy.visit('/library');
      cy.contains('Personal anime title').should('be.visible');
      cy.get('img[src*="/imageproxy/anilist/"]').should('be.visible');
      cy.contains('Some titles retain their original provider identity').should(
        'be.visible'
      );
      cy.get('input[aria-label="Your rating"]')
        .should('have.value', '7.5')
        .clear()
        .type('7.8');
      cy.contains('button', 'Save rating').click();
      cy.wait('@trackingUpdate').its('request.body').should('include', {
        action: 'rating',
        value: 7.8,
        anilistId: 101,
      });
      cy.contains('button', 'Mark watched').click();
      cy.contains('This updates watched status for the full series.').should(
        'be.visible'
      );
      cy.contains('button', 'Confirm').click();
      cy.wait('@trackingUpdate').its('request.body').should('include', {
        action: 'watched',
        value: true,
        anilistId: 101,
      });
      cy.document().then((doc) =>
        expect(doc.documentElement.scrollWidth).to.be.at.most(width)
      );
      cy.get('input[aria-label="Your rating"]').scrollIntoView();
      cy.screenshot(`personal-provider-library-${width}`, {
        capture: 'viewport',
      });
    });
});
