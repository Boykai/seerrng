describe('Release Calendar manga chapters', () => {
  const mangaEntries = (month: string) => [
    {
      id: `suwayomi:manga:9101:${month}-07`,
      source: 'suwayomi',
      mediaType: 'manga',
      title: 'Calendar manga',
      startsAt: `${month}-07T00:00:00.000Z`,
      dateType: 'chapter',
      allDay: true,
      mangaId: 9101,
      chapterCount: 3,
      available: false,
      is4k: false,
    },
    {
      id: `suwayomi:manga:9102:${month}-09`,
      source: 'suwayomi',
      mediaType: 'manga',
      title: 'Downloaded calendar manga',
      startsAt: `${month}-09T00:00:00.000Z`,
      dateType: 'chapter',
      allDay: true,
      mangaId: 9102,
      chapterCount: 1,
      available: true,
      is4k: false,
    },
  ];

  const stubCalendar = () =>
    cy
      .intercept('GET', '/api/v1/calendar*', (request) => {
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
          ...mangaEntries(month),
        ];
        request.reply({
          results: request.query.mediaType
            ? results.filter(
                (item) => item.mediaType === request.query.mediaType
              )
            : results,
          partialSources: [],
          truncated: false,
        });
      })
      .as('calendar');

  const setMangaCategory = (enabled: boolean) =>
    cy.intercept('GET', '**/api/v1/settings/public*', (request) => {
      request.continue((response) => {
        response.body.enabledMediaCategories = {
          ...response.body.enabledMediaCategories,
          manga: enabled,
        };
      });
    });

  beforeEach(() => cy.loginAsAdmin());

  for (const width of [390, 1280])
    it(`shows released manga chapters readably at ${width}px`, () => {
      cy.viewport(width, 900);
      setMangaCategory(true);
      stubCalendar();
      cy.visit('/calendar');
      cy.wait('@calendar');
      cy.contains('and manga chapters that have already been released.').should(
        'be.visible'
      );
      cy.contains('a', 'Calendar manga')
        .should('be.visible')
        .and('have.attr', 'href', '/manga/9101');
      cy.contains('li', 'Calendar manga').within(() => {
        cy.contains('3 new chapters').should('be.visible');
        cy.contains('Released').should('be.visible');
      });
      cy.contains('a', 'Downloaded calendar manga').should(
        'have.attr',
        'href',
        '/manga/9102'
      );
      cy.contains('li', 'Downloaded calendar manga').within(() => {
        cy.contains('1 new chapter').should('be.visible');
        cy.contains('Available').should('be.visible');
      });
      cy.get('#calendar-media-type option[value="manga"]').should(
        'have.text',
        'Manga'
      );
      cy.get('#calendar-media-type').select('manga');
      cy.wait('@calendar').its('request.query.mediaType').should('eq', 'manga');
      cy.contains('Calendar manga').should('be.visible');
      cy.contains('Calendar movie').should('not.exist');
      cy.document().then((doc) =>
        expect(doc.documentElement.scrollWidth).to.be.at.most(width)
      );
      cy.screenshot(`release-calendar-manga-${width}`);
    });

  it('offers no manga filter while the manga category is off', () => {
    setMangaCategory(false);
    stubCalendar();
    cy.visit('/calendar');
    cy.wait('@calendar');
    cy.get('#calendar-media-type option[value="magazine"]').should('exist');
    cy.get('#calendar-media-type option[value="manga"]').should('not.exist');
    cy.contains('manga chapters that have already been released').should(
      'not.exist'
    );
  });
});
