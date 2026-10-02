describe('User Profile', () => {
  beforeEach(() => {
    cy.loginAsAdmin();
  });

  it('opens user profile page from the home page', () => {
    cy.visit('/');

    cy.get('[data-testid=user-menu]').click();
    cy.get('[data-testid=user-menu-profile]').click();

    cy.env<{ ADMIN_EMAIL: string }>(['ADMIN_EMAIL']).then(({ ADMIN_EMAIL }) => {
      cy.get('h1').should('contain', ADMIN_EMAIL);
    });
  });

  it('opens Advanced Theme from self user settings', () => {
    cy.visit('/users/1/settings/main');

    cy.get('[data-testid=settings-nav-desktop]')
      .contains('Advanced Theme')
      .should('have.attr', 'href', '/profile/advanced-theme')
      .click();

    cy.location('pathname').should('eq', '/profile/advanced-theme');
    cy.contains('h1', 'Advanced Theme Overrides').should('be.visible');
  });

  it('loads plex watchlist', () => {
    cy.intercept('/api/v1/user/[0-9]*/watchlist', {
      fixture: 'watchlist.json',
    }).as('getWatchlist');
    // Wait for one of the watchlist movies to resolve
    cy.intercept('/api/v1/movie/361743').as('getTmdbMovie');

    cy.visit('/profile');

    cy.wait('@getWatchlist');

    const sliderHeader = cy.contains('.slider-header', 'Watchlist');

    sliderHeader.scrollIntoView();

    cy.wait('@getTmdbMovie');
    // Wait a little longer to make sure the movie component reloaded
    cy.wait(500);

    sliderHeader
      .next('[data-testid=media-slider]')
      .find('[data-testid=title-card]')
      .first()
      .trigger('mouseover')
      .find('[data-testid=title-card-title]')
      .invoke('text')
      .then((text) => {
        cy.contains('.slider-header', 'Watchlist')
          .next('[data-testid=media-slider]')
          .find('[data-testid=title-card]')
          .first()
          .click();
        cy.get('[data-testid=media-title]').should('contain', text);
      });
  });
});
