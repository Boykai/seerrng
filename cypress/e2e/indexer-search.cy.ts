describe('Indexer Search', () => {
  beforeEach(() => cy.loginAsAdmin());

  it('prefills a search from a media-detail link', () => {
    cy.intercept('GET', '/api/v1/indexer-search/configuration', {
      configured: true,
      categories: [],
    }).as('configuration');
    cy.intercept('POST', '/api/v1/indexer-search/search', (request) => {
      expect(request.body).to.deep.equal({
        category: 'audiobook',
        query: 'Project Hail Mary',
        offset: 0,
      });
      request.reply({ results: [], limit: 50, offset: 0, hasMore: false });
    }).as('search');

    cy.visit('/indexer-search?category=audiobook&query=Project+Hail+Mary');
    cy.wait('@configuration');
    cy.get('form select').should('have.value', 'audiobook');
    cy.get('form input').should('have.value', 'Project Hail Mary');
    cy.contains('button', 'Search indexers').click();
    cy.wait('@search');
  });
});
