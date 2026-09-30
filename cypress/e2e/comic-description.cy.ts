describe('ComicVine overview formatting', () => {
  beforeEach(() => {
    cy.loginAsAdmin();
    cy.mockConfiguredMediaAvailability({ comicsEnabled: true });
    cy.intercept('GET', '/api/v1/comic/4567', {
      body: {
        id: '4567',
        provider: 'comicvine',
        mediaType: 'comic',
        title: 'Test Comic',
        publisher: 'Test Publisher',
        startYear: '2009',
        issueCount: 21,
        description:
          '<p>The series is written by <strong>Test Author</strong>.</p><ul><li>First arc</li></ul>',
        onUserWatchlist: false,
      },
    }).as('comicDetails');
    cy.intercept('GET', '/api/v1/comic/4567/issues*', (request) => {
      const page = new URL(request.url).searchParams.get('page');
      if (page === '1') {
        request.alias = 'firstIssuePage';
        request.reply({
          page: 1,
          totalPages: 2,
          totalResults: 21,
          results: [
            {
              id: 1,
              issueNumber: '1',
              name: 'First Issue',
              coverDate: '2009-01-01',
              coverUrl: null,
            },
          ],
        });
      } else if (page === '2') {
        request.alias = 'secondIssuePage';
        request.reply({
          page: 2,
          totalPages: 2,
          totalResults: 21,
          results: [
            {
              id: 21,
              issueNumber: '21',
              name: 'Final Issue',
              coverDate: '2010-09-01',
              coverUrl: null,
            },
          ],
        });
      } else {
        request.reply({
          statusCode: 400,
          body: { message: `Unexpected issue page ${page}.` },
        });
      }
    });
  });

  it('renders safe ComicVine description markup as formatted content', () => {
    cy.visit('/comic/4567');
    cy.wait('@comicDetails');

    cy.get('[data-testid=comic-description]')
      .find('strong')
      .should('contain.text', 'Test Author');
    cy.get('[data-testid=comic-description]')
      .find('li')
      .should('contain.text', 'First arc');
    cy.get('[data-testid=comic-description]').should('not.contain.text', '<p>');
  });

  it('loads the next ComicVine issue page when requested', () => {
    cy.visit('/comic/4567');
    cy.wait('@comicDetails');
    cy.wait('@firstIssuePage');
    cy.contains('h2', 'Issues in this volume').scrollIntoView();
    cy.get('[data-testid=comic-description]')
      .parent()
      .next()
      .contains('li', '#1 · First Issue')
      .should('be.visible');

    cy.contains('button', 'Load more issues').should('be.visible').click();
    cy.wait('@secondIssuePage');
    cy.location('pathname').should('eq', '/comic/4567');
    cy.get('ol').contains('li', '#21 · Final Issue').should('be.visible');
  });
});
