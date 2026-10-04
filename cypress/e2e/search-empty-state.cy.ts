describe('Empty Search page', () => {
  beforeEach(() => {
    cy.loginAsAdmin();
  });

  it('renders its ready state without a hydration error', () => {
    const hydrationErrors: string[] = [];

    cy.on('window:before:load', (win) => {
      cy.stub(win.console, 'error').callsFake((...args) => {
        const message = args.map(String).join(' ');

        if (message.includes('#418') || message.includes('Hydration failed')) {
          hydrationErrors.push(message);
        }
      });
    });

    cy.visit('/search');
    cy.contains('button', 'Continue Search').should('be.visible');

    cy.then(() => {
      expect(hydrationErrors).to.deep.equal([]);
    });
  });
});
