describe('Discover Customization', () => {
  beforeEach(() => {
    cy.loginAsAdmin();
    cy.intercept('/api/v1/settings/discover').as('getDiscoverSliders');
  });

  it('show the discover customization settings', () => {
    cy.visit('/');

    cy.get('[data-testid=discover-start-editing]').click();

    cy.get('[data-testid=create-slider-header')
      .should('contain', 'Create New Slider')
      .scrollIntoView();

    // There should be some built in options
    cy.get('[data-testid=discover-slider-edit-mode]').should(
      'contain',
      'Recently Added'
    );
    cy.get('[data-testid=discover-slider-edit-mode]').should(
      'contain',
      'Recent Requests'
    );
  });

  it('can re-order elements and save to persist the changes', () => {
    let firstTitle = '';
    let secondTitle = '';
    cy.visit('/');

    cy.get('[data-testid=discover-start-editing]').click();

    cy.get('[data-testid=discover-slider-edit-mode]')
      .eq(0)
      .find('[data-testid=discover-slider-title]')
      .invoke('text')
      .then((text) => {
        firstTitle = text.trim();
      });
    cy.get('[data-testid=discover-slider-edit-mode]')
      .eq(1)
      .find('[data-testid=discover-slider-title]')
      .invoke('text')
      .then((text) => {
        secondTitle = text.trim();
      });

    cy.get('[data-testid=discover-slider-edit-mode]')
      .first()
      .find('[data-testid=discover-slider-move-down]')
      .click();

    cy.then(() => {
      cy.get('[data-testid=discover-slider-edit-mode]')
        .eq(1)
        .find('[data-testid=discover-slider-title]')
        .should('have.text', firstTitle);
    });

    cy.get('[data-testid=discover-customize-submit').click();
    cy.wait('@getDiscoverSliders');

    cy.reload();

    cy.get('[data-testid=discover-start-editing]').click();

    cy.then(() => {
      cy.get('[data-testid=discover-slider-edit-mode]')
        .eq(1)
        .find('[data-testid=discover-slider-title]')
        .should('have.text', firstTitle);
    });

    cy.get('[data-testid=discover-slider-edit-mode]')
      .first()
      .find('[data-testid=discover-slider-move-down]')
      .click();

    cy.then(() => {
      cy.get('[data-testid=discover-slider-edit-mode]')
        .eq(1)
        .find('[data-testid=discover-slider-title]')
        .should('have.text', secondTitle);
    });

    cy.get('[data-testid=discover-customize-submit').click();
    cy.wait('@getDiscoverSliders');
  });

  it('can create a new discover option and remove it', () => {
    cy.visit('/');
    cy.intercept('POST', '/api/v1/settings/discover/add').as(
      'addDiscoverSlider'
    );
    cy.intercept('DELETE', '/api/v1/settings/discover/*').as(
      'deleteDiscoverSlider'
    );

    cy.get('[data-testid=discover-start-editing]').click();

    const sliderTitle = `Custom Keyword Slider ${Date.now()}`;

    cy.get('#sliderType').select('TMDB Movie Keyword');

    cy.get('#title').type(sliderTitle);
    // First confirm that an invalid keyword doesn't allow us to submit anything
    cy.get('#data').type('invalidkeyword', { delay: 100 });

    cy.get('[data-testid=create-discover-option-form]')
      .find('button')
      .should('be.disabled');

    cy.get('#data').clear();
    cy.get('#data').type('christmas', { delay: 100 });
    cy.get('.react-select__option').first().click();

    // Confirming we have some results
    cy.contains('.slider-header', sliderTitle)
      .closest('[data-testid=media-slider]')
      .find('[data-testid=title-card]');

    cy.get('[data-testid=create-discover-option-form]').submit();

    cy.wait('@addDiscoverSlider').its('response.statusCode').should('eq', 200);

    cy.contains('[data-testid=discover-slider-edit-mode]', sliderTitle).should(
      'be.visible'
    );

    // Make sure its still there even if we reload
    cy.reload();

    cy.get('[data-testid=discover-start-editing]').click();

    cy.contains('[data-testid=discover-slider-edit-mode]', sliderTitle).should(
      'be.visible'
    );

    // Verify it's not rendering on our discover page (its still disabled!)
    cy.visit('/');

    cy.get('.slider-header').should('not.contain', sliderTitle);

    cy.get('[data-testid=discover-start-editing]').click();

    // Enable it, and check again
    cy.contains('[data-testid=discover-slider-edit-mode]', sliderTitle)
      .find('[role="checkbox"]')
      .click();

    cy.get('[data-testid=discover-customize-submit').click();
    cy.wait('@getDiscoverSliders');

    cy.visit('/');

    cy.contains('.slider-header', sliderTitle)
      .closest('[data-testid=media-slider]')
      .find('[data-testid=title-card]');

    cy.get('[data-testid=discover-start-editing]').click();

    // let's delete it and confirm its deleted.
    cy.contains('[data-testid=discover-slider-edit-mode]', sliderTitle)
      .find('[data-testid=discover-slider-remove-button]')
      .click();

    cy.wait('@deleteDiscoverSlider')
      .its('response.statusCode')
      .should('eq', 204);

    cy.contains('[data-testid=discover-slider-edit-mode]', sliderTitle).should(
      'not.exist'
    );
  });
});
