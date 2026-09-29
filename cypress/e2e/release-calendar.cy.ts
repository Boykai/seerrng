describe('Release Calendar', () => {
  beforeEach(() => cy.loginAsAdmin());
  for (const width of [390, 1280])
    it(`keeps movie, episode, and game releases readable at ${width}px`, () => {
      cy.viewport(width, 900);
      cy.intercept('GET', '/api/v1/calendar*', (request) => {
        const month = String(request.query.start).slice(0, 7);
        const results = [
          {
            id: 'movie',
            source: 'radarr',
            mediaType: 'movie',
            title: 'Calendar movie',
            startsAt: `${month}-12T00:00:00.000Z`,
            dateType: 'digital',
            allDay: true,
            available: false,
            is4k: false,
          },
          {
            id: 'episode',
            source: 'sonarr',
            mediaType: 'tv',
            title: 'Calendar series',
            startsAt: `${month}-13T20:00:00.000Z`,
            dateType: 'air',
            allDay: false,
            available: true,
            is4k: true,
            seasonNumber: 1,
            episodeNumber: 2,
            episodeTitle: 'Episode title',
          },
          {
            id: 'software:game:42',
            source: 'questarr',
            mediaType: 'software',
            title: 'Calendar game',
            startsAt: `${month}-18T00:00:00.000Z`,
            dateType: 'game',
            allDay: true,
            softwareCategory: 'game',
            igdbId: 42,
            platformName: 'Windows · x64',
            available: false,
            is4k: false,
          },
        ];
        request.reply({
          results:
            request.query.mediaType === 'software'
              ? results.filter((item) => item.mediaType === 'software')
              : results,
          partialSources: [{ source: 'sonarr', serverId: 2 }],
          truncated: false,
        });
      }).as('calendar');
      cy.visit('/calendar');
      cy.wait('@calendar');
      cy.contains('Calendar movie').should('be.visible');
      cy.contains('h2', 'Calendar series')
        .should('be.visible')
        .then((element) =>
          expect(element[0].getBoundingClientRect().width).to.be.greaterThan(
            150
          )
        );
      cy.contains('Season 1, episode 2').should('be.visible');
      cy.contains(
        'Some acquisition services or game catalogs could not be reached.'
      ).should('be.visible');
      cy.contains('a', 'Calendar game')
        .should('be.visible')
        .and('have.attr', 'href', '/software?category=game&game=42');
      cy.contains('PC game').should('be.visible');
      cy.contains('Requested for Windows · x64').should('be.visible');
      cy.get('#calendar-media-type').select('software');
      cy.wait('@calendar')
        .its('request.query.mediaType')
        .should('eq', 'software');
      cy.contains('Calendar movie').should('not.exist');
      cy.contains('Calendar game').should('be.visible');
      cy.get('#calendar-scope').should('have.value', 'mine').select('all');
      cy.wait('@calendar').its('request.query.scope').should('eq', 'all');
      cy.contains('button', 'Next month').click();
      cy.wait('@calendar');
      cy.document().then((doc) =>
        expect(doc.documentElement.scrollWidth).to.be.at.most(width)
      );
      cy.screenshot(`release-calendar-${width}`);
    });
});
