describe('Title card image fill', () => {
  beforeEach(() => {
    cy.loginAsAdmin();
  });

  it('fills book and music cards with cover images like video cards', () => {
    cy.mockConfiguredMediaAvailability({ booksEnabled: true });
    cy.intercept('GET', '/api/v1/discover/books*', {
      page: 1,
      totalPages: 1,
      totalResults: 1,
      results: [
        {
          id: 'OLIMAGEW',
          mediaType: 'book',
          title: 'Filled Book',
          author: 'Card Author',
          firstPublishYear: 2026,
          posterPath: 'http://localhost:5055/images/seerr_poster_not_found.png',
        },
      ],
    }).as('getBooks');

    cy.visit('/discover/books');
    cy.wait('@getBooks');
    cy.get('[data-testid=title-card]')
      .first()
      .as('bookCard')
      .find('img')
      .should('have.css', 'object-fit', 'cover')
      .and('have.css', 'position', 'absolute');
    cy.get('@bookCard').screenshot('book-card-image-fill');

    cy.intercept('GET', '/api/v1/discover/music*', {
      page: 1,
      totalPages: 1,
      totalResults: 1,
      results: [
        {
          id: '11111111-1111-1111-1111-111111111111',
          mediaType: 'album',
          title: 'Filled Album',
          'primary-type': 'Album',
          'first-release-date': '2026-05-01',
          posterPath: 'http://localhost:5055/images/seerr_poster_not_found.png',
          'artist-credit': [{ name: 'Card Artist' }],
        },
      ],
    }).as('getMusic');

    cy.visit('/discover/music');
    cy.wait('@getMusic');
    cy.get('[data-testid=title-card]')
      .first()
      .as('musicCard')
      .find('img')
      .should('have.css', 'object-fit', 'cover')
      .and('have.css', 'position', 'absolute');
    cy.get('@musicCard').screenshot('music-card-image-fill');
  });
});
