describe('Personal game library and household play', () => {
  const assertNoHorizontalPageOverflow = () => {
    cy.document().then((document) => {
      const viewportWidth = document.documentElement.clientWidth;
      const overflowingElements = Array.from(
        document.querySelectorAll<HTMLElement>('*')
      )
        .filter((element) => {
          const style = document.defaultView?.getComputedStyle(element);
          const { right } = element.getBoundingClientRect();
          const rendered =
            style?.display !== 'none' &&
            style?.visibility !== 'hidden' &&
            element.getClientRects().length > 0;
          return (
            rendered && style?.position !== 'fixed' && right > viewportWidth + 1
          );
        })
        .slice(0, 12)
        .map((element) => {
          const classes =
            typeof element.className === 'string'
              ? `.${element.className.trim().replace(/\s+/g, '.')}`
              : '';
          const { left, right } = element.getBoundingClientRect();
          return `${element.tagName.toLowerCase()}${classes} bounds=${Math.round(left)}-${Math.round(right)} scroll=${element.scrollWidth} client=${element.clientWidth}`;
        })
        .join('; ');
      const pageScrollWidth = Math.max(
        document.documentElement.scrollWidth,
        document.body.scrollWidth
      );
      const horizontalScrollers = Array.from(
        document.querySelectorAll<HTMLElement>('*')
      )
        .filter((element) => {
          const style = document.defaultView?.getComputedStyle(element);
          return (
            style?.display !== 'none' &&
            element.getClientRects().length > 0 &&
            (style?.overflowX === 'auto' || style?.overflowX === 'scroll') &&
            element.scrollWidth > element.clientWidth + 1
          );
        })
        .map((element) => {
          const classes =
            typeof element.className === 'string'
              ? `.${element.className.trim().replace(/\s+/g, '.')}`
              : '';
          return `${element.tagName.toLowerCase()}${classes} scroll=${element.scrollWidth} client=${element.clientWidth}`;
        })
        .slice(0, 12)
        .join('; ');
      expect(
        pageScrollWidth,
        `viewport=${viewportWidth}; pageScrollWidth=${pageScrollWidth}; ${overflowingElements}`
      ).to.be.at.most(viewportWidth);
      expect(
        overflowingElements,
        'visible elements should fit page'
      ).to.have.length(0);
      expect(horizontalScrollers, 'no unexpected horizontal scrollers').to.eq(
        ''
      );
    });
  };

  const addSharedGame = (
    title: string,
    viewportWidth: number,
    viewportHeight: number
  ) => {
    cy.visit('/games');
    cy.viewport(viewportWidth, viewportHeight);
    cy.window().its('innerWidth').should('eq', viewportWidth);
    cy.window().its('innerHeight').should('eq', viewportHeight);
    cy.contains('button', 'Add a Game').click();
    cy.get('#manual-game-title').type(title);
    cy.get('[role="dialog"]')
      .filter(':visible')
      .should('have.length', 1)
      .within(() => {
        cy.get('button[aria-label="I own this outside Steam"]').click();
        cy.get('button[aria-label="Share with household"]').click();
        cy.get('[data-testid="modal-ok-button"]').click();
      });
    cy.contains('h2.card-title', title).should('be.visible');
    cy.contains('Share with household').should('be.visible');
    cy.contains('.game-library-sharing-label', 'Share with household').should(
      ($label) => {
        expect($label.css('color')).not.to.equal('rgb(0, 0, 0)');
      }
    );
  };

  it('shares manually owned games and finds household overlap on desktop and mobile', () => {
    const title = `QA game ${Date.now()}`;

    cy.loginAsAdmin();
    cy.viewport(1280, 900);
    addSharedGame(title, 1280, 900);
    assertNoHorizontalPageOverflow();
    cy.screenshot('game-library-my-games-desktop', { capture: 'viewport' });

    cy.loginAsUser();
    cy.viewport(1280, 900);
    addSharedGame(title, 1280, 900);

    cy.loginAsAdmin();
    cy.viewport(1280, 900);
    cy.visit('/games');
    cy.viewport(1280, 900);
    cy.window().its('innerWidth').should('eq', 1280);
    cy.window().its('innerHeight').should('eq', 900);
    cy.contains('button', 'Play Together').click();
    cy.contains(title).should('be.visible');
    cy.contains('2 people own this').should('be.visible');
    cy.get('button[aria-label="Owners"]')
      .should('be.visible')
      .and('contain.text', '2+ people');
    assertNoHorizontalPageOverflow();
    cy.screenshot('game-library-play-together-desktop', {
      capture: 'viewport',
    });

    cy.viewport(390, 844);
    cy.window().its('innerWidth').should('eq', 390);
    cy.window().its('innerHeight').should('eq', 844);
    assertNoHorizontalPageOverflow();
    cy.screenshot('game-library-play-together-mobile', {
      capture: 'viewport',
    });
  });
});
