import { Permission } from '@server/lib/permissions';

const visitUserEditPage = (email: string): void => {
  cy.visit('/users');

  cy.contains('[data-testid=user-list-row]', email).contains('Edit').click();
};

describe('Auto Request Settings', () => {
  beforeEach(() => {
    cy.loginAsAdmin();
  });

  it('should not see watchlist sync settings on an account without permissions', () => {
    cy.env<{ USER_EMAIL: string }>(['USER_EMAIL']).then(({ USER_EMAIL }) => {
      visitUserEditPage(USER_EMAIL);
    });

    cy.contains('Auto-Request Movies').should('not.exist');
    cy.contains('Auto-Request Series').should('not.exist');
  });

  it('should see watchlist sync settings on an admin account', () => {
    cy.env<{ ADMIN_EMAIL: string }>(['ADMIN_EMAIL']).then(({ ADMIN_EMAIL }) => {
      visitUserEditPage(ADMIN_EMAIL);
    });

    cy.contains('Auto-Request Movies').should('exist');
    cy.contains('Auto-Request Series').should('exist');
  });

  it('should see auto-request settings after being given permission', () => {
    cy.env<{ USER_EMAIL: string }>(['USER_EMAIL']).then(({ USER_EMAIL }) => {
      cy.request<{ results: { id: number; email: string }[] }>(
        '/api/v1/user?take=100'
      )
        .then(({ body }) => {
          const user = body.results.find(
            (result) => result.email === USER_EMAIL
          );

          if (!user) {
            throw new Error(`Could not find the seeded user ${USER_EMAIL}`);
          }

          return cy.request(
            'POST',
            `/api/v1/user/${user.id}/settings/permissions`,
            { permissions: Permission.REQUEST }
          );
        })
        .its('status')
        .should('eq', 200)
        .then(() => visitUserEditPage(USER_EMAIL));
    });

    cy.get('[data-testid=settings-nav-desktop').contains('Permissions').click();

    cy.get('#autorequest').should('not.be.checked').click();

    cy.intercept('/api/v1/user/*/settings/permissions').as('userPermissions');

    cy.contains('Save Changes').click();

    cy.wait('@userPermissions');

    cy.reload();

    cy.get('#autorequest').should('be.checked');
    cy.get('#autorequestmovies').should('be.checked');
    cy.get('#autorequesttv').should('be.checked');

    cy.get('[data-testid=settings-nav-desktop').contains('General').click();

    cy.contains('Auto-Request Movies').should('exist');
    cy.contains('Auto-Request Series').should('exist');

    cy.get('#watchlistSyncMovies').should('not.be.checked').click();
    cy.get('#watchlistSyncTv').should('not.be.checked').click();

    cy.intercept('/api/v1/user/*/settings/main').as('userMain');

    cy.contains('Save Changes').click();

    cy.wait('@userMain');

    cy.reload();

    cy.get('#watchlistSyncMovies').should('be.checked').click();
    cy.get('#watchlistSyncTv').should('be.checked').click();

    cy.contains('Save Changes').click();

    cy.wait('@userMain');

    cy.get('[data-testid=settings-nav-desktop').contains('Permissions').click();

    cy.get('#autorequest').should('be.checked').click();

    cy.contains('Save Changes').click();
  });
});
