describe('Per-user request destination folders', () => {
  const folderSelect = 'select[id="request-folder-radarr:1"]';

  beforeEach(() => {
    cy.loginAsAdmin();

    cy.intercept('GET', '/api/v1/service/radarr', {
      body: [{ id: 1, name: 'Main Radarr' }],
    });
    cy.intercept('GET', '/api/v1/service/radarr/1', {
      body: {
        rootFolders: [
          { path: '/media/Movies' },
          { path: '/media/Movies/David' },
        ],
      },
    });
    for (const service of ['sonarr', 'lidarr', 'readarr']) {
      cy.intercept('GET', `/api/v1/service/${service}`, { body: [] });
    }
    cy.intercept('GET', '/api/v1/service/comic', { body: [] });
    cy.intercept('POST', '/api/v1/user/*/settings/main').as('saveUserSettings');

    cy.visit('/profile/settings/main');
    cy.contains('label', 'Default Request Folders')
      .scrollIntoView()
      .should('be.visible');
  });

  it('saves a user-named folder, stays usable on narrow screens, and clears to the service default', () => {
    cy.get(folderSelect)
      .should('be.visible')
      .select('/media/Movies/David')
      .should('have.value', '/media/Movies/David');
    cy.get(folderSelect).scrollIntoView();
    cy.screenshot('request-folder-defaults-desktop', {
      capture: 'viewport',
    });

    cy.viewport(390, 844);
    cy.get(folderSelect)
      .scrollIntoView()
      .should('be.visible')
      .and('have.value', '/media/Movies/David');
    cy.scrollTo('bottom');
    cy.get(folderSelect).should('be.visible');
    cy.screenshot('request-folder-defaults-mobile', { capture: 'viewport' });

    cy.contains('button', 'Save Changes').click();
    cy.wait('@saveUserSettings').then(({ request, response }) => {
      expect(response?.statusCode).to.eq(200);
      expect(request.body.requestRootFolders).to.deep.equal({
        'radarr:1': '/media/Movies/David',
      });
    });

    cy.get(folderSelect).select('');
    cy.contains('button', 'Save Changes').click();
    cy.wait('@saveUserSettings').then(({ request, response }) => {
      expect(response?.statusCode).to.eq(200);
      expect(request.body.requestRootFolders).to.deep.equal({});
    });

    cy.reload();
    cy.get(folderSelect).should('have.value', '');
  });
});
