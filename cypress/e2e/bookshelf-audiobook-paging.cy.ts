describe('Audiobook catalog paging', () => {
  beforeEach(() => {
    cy.loginAsAdmin();
    cy.mockConfiguredMediaAvailability({ booksEnabled: true });
  });

  it('renders one page from a large audiobook catalog', () => {
    const results = Array.from({ length: 50 }, (_, index) => ({
      id: `bookshelf:1:audiobook-${index + 1}`,
      mediaType: 'book',
      bookFormat: 'audiobook',
      title: `Audiobook Fixture ${String(index + 1).padStart(5, '0')}`,
      author: 'Fixture Author',
      posterPath: '/images/seerr_poster_not_found.png',
    }));
    cy.intercept('GET', '/api/v1/discover/books*', (request) => {
      request.alias = 'discoverAudiobooks';
      request.reply({
        page: 1,
        totalPages: 100,
        totalResults: 5000,
        results,
      });
    });

    cy.visit('/discover/audiobooks');
    cy.wait('@discoverAudiobooks').then(({ request, response }) => {
      expect(request.query.format).to.equal('audiobook');
      expect(request.query.subject).to.equal(undefined);
      expect(response?.statusCode).to.equal(200);
      expect(response?.body.totalResults).to.equal(5000);
      expect(response?.body.results).to.have.length(50);
    });
    cy.get('[data-testid=title-card]').should('have.length', 50);
    cy.get('[data-testid=title-card]')
      .first()
      .should('contain.text', 'Audiobook Fixture 00001')
      .trigger('mouseover');
    cy.get('[data-testid=title-card]')
      .first()
      .contains('button', 'Request Audiobook')
      .should('be.visible');
  });
});
