describe('BackIssue collection scan task', () => {
  beforeEach(() => {
    cy.loginAsAdmin();
    cy.intercept('GET', '/api/v1/settings/jobs', {
      body: [
        {
          id: 'backissue-scan',
          name: 'BackIssue Comics Scan',
          type: 'process',
          interval: 'hours',
          cronSchedule: '0 30 5 * * *',
          enabled: true,
          nextExecutionTime: new Date(Date.now() + 60_000).toISOString(),
          running: false,
        },
      ],
    }).as('backissueJobs');
    cy.intercept('POST', '/api/v1/settings/jobs/backissue-scan/run', {
      statusCode: 200,
      body: {
        id: 'backissue-scan',
        name: 'BackIssue Comics Scan',
        type: 'process',
        interval: 'hours',
        cronSchedule: '0 30 5 * * *',
        enabled: true,
        nextExecutionTime: null,
        running: true,
      },
    }).as('runBackIssueScan');
    cy.intercept('GET', '/api/v1/status/appdata', {
      body: { appDataPath: '/app/config' },
    });
    cy.intercept('GET', '/api/v1/settings/cache', {
      body: {
        apiCaches: [],
        imageCache: {
          tmdb: { imageCount: 0, size: 0 },
          avatar: { imageCount: 0, size: 0 },
        },
      },
    });
  });

  it('shows the named task and lets an administrator start it', () => {
    cy.visit('/settings/jobs');
    cy.wait('@backissueJobs');

    cy.contains('tr', 'BackIssue Comics Scan').within(() => {
      cy.contains('button', 'Run Now').click();
    });
    cy.wait('@runBackIssueScan').its('response.statusCode').should('eq', 200);
    cy.contains('BackIssue Comics Scan started.').should('be.visible');
  });
});
