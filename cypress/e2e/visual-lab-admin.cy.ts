describe('Visual Lab route access', () => {
  const pages = [
    '/visual-lab',
    '/visual-lab/title-text',
    '/visual-lab/borders',
    '/visual-lab/buttons',
  ];

  it('redirects non-admin users from every Visual Lab page', () => {
    cy.loginAsUser();

    pages.forEach((page) => {
      cy.visit(page);
      cy.location('pathname').should('not.eq', page);
    });
  });

  it('allows administrators to open every Visual Lab page', () => {
    cy.loginAsAdmin();

    pages.forEach((page) => {
      cy.visit(page);
      cy.location('pathname').should('eq', page);
      cy.get('iframe[title]').should('be.visible');
    });
  });
});
