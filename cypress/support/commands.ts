/// <reference types="cypress" />
import 'cy-mobile-commands';
import { mockConfiguredMediaAvailability } from './configuredMedia';

Cypress.Commands.add('login', (email, password) => {
  cy.session(
    [email, password],
    () => {
      cy.request({
        method: 'POST',
        url: '/api/v1/auth/local',
        body: { email, password },
        // Tell express-session that this test request represents the HTTPS
        // edge. The browser still runs on localhost HTTP, so the Secure
        // cookie is copied into Cypress's test-only jar below.
        headers: { 'X-Forwarded-Proto': 'https' },
      }).then((response) => {
        expect(response.status).to.eq(200);

        // The application must emit a Secure session cookie. Cypress runs
        // this production build over plain localhost HTTP, so the browser
        // correctly refuses to store that cookie. Copy only this test
        // session into Cypress's local HTTP jar; production never uses this
        // path.
        const setCookie = response.headers['set-cookie'];
        const cookieHeaders = Array.isArray(setCookie)
          ? setCookie
          : setCookie
            ? [setCookie]
            : [];
        const sessionCookie = cookieHeaders
          .map((cookie) => cookie.match(/^connect\.sid=([^;]+)/)?.[1])
          .find((value): value is string => Boolean(value));

        if (!sessionCookie) {
          throw new Error('Login response did not include connect.sid');
        }

        cy.setCookie('connect.sid', sessionCookie, {
          httpOnly: true,
          sameSite: 'lax',
          secure: false,
        });
      });
    },
    {
      validate() {
        cy.request('/api/v1/auth/me').its('status').should('eq', 200);
      },
    }
  );
});

Cypress.Commands.add('loginAsAdmin', () => {
  cy.env<{ ADMIN_EMAIL: string; ADMIN_PASSWORD: string }>([
    'ADMIN_EMAIL',
    'ADMIN_PASSWORD',
  ]).then(({ ADMIN_EMAIL, ADMIN_PASSWORD }) => {
    cy.login(ADMIN_EMAIL, ADMIN_PASSWORD);
  });
});

Cypress.Commands.add('loginAsUser', () => {
  cy.env<{ USER_EMAIL: string; USER_PASSWORD: string }>([
    'USER_EMAIL',
    'USER_PASSWORD',
  ]).then(({ USER_EMAIL, USER_PASSWORD }) => {
    cy.login(USER_EMAIL, USER_PASSWORD);
  });
});

Cypress.Commands.add(
  'mockConfiguredMediaAvailability',
  mockConfiguredMediaAvailability
);
