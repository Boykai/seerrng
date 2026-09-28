describe('Download Inbox', () => {
  beforeEach(() => cy.loginAsAdmin());
  for (const width of [390, 1280])
    it(`previews files, submits imports and shows history at ${width}px`, () => {
      cy.viewport(width, 900);
      let state = 'active';
      const row = () => ({
        id: 1,
        serviceType: 'radarr',
        serviceId: 1,
        serviceName: 'Movie acquisition',
        title:
          'A long movie release title that stays readable on narrow screens',
        warnings: ['Existing file is better; review before importing.'],
        state,
        resolution: state === 'resolved' ? 'manual-import' : null,
        actorId: 1,
        manualImportCapable: true,
        actions:
          state === 'active'
            ? []
            : [
                {
                  at: new Date().toISOString(),
                  actorId: 1,
                  action: 'import',
                  state: state === 'resolved' ? 'manual-import' : 'importing',
                  options: { importMode: 'copy', fileCount: 1 },
                },
              ],
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        actionAt: null,
        resolvedAt: null,
      });
      cy.intercept('GET', '/api/v1/downloads/interventions?*', (req) =>
        req.reply({
          results: [row()],
          total: 1,
          page: 1,
          partialSources: [{ serviceType: 'sonarr', serviceId: 2 }],
          truncated: false,
        })
      ).as('inbox');
      cy.intercept('GET', '/api/v1/downloads/interventions/1/preview', {
        candidates: [
          {
            id: 7,
            name: 'Confirmed movie file.mkv',
            size: 1048576,
            eligible: true,
            rejections: ['Existing file is better'],
          },
          {
            id: 8,
            name: 'Unmatched file.mkv',
            size: 1048576,
            eligible: false,
            rejections: [],
          },
        ],
        fingerprint: 'a'.repeat(64),
      }).as('preview');
      cy.intercept(
        'POST',
        '/api/v1/downloads/interventions/1/import',
        (req) => {
          expect(req.body).to.deep.equal({
            candidateIds: [7],
            importMode: 'copy',
            fingerprint: 'a'.repeat(64),
          });
          state = 'importing';
          req.reply(row());
        }
      ).as('import');
      cy.visit('/downloads');
      cy.wait('@inbox');
      cy.contains('Some acquisition services could not be checked.').should(
        'be.visible'
      );
      cy.contains('button', 'Preview files').click();
      cy.wait('@preview');
      cy.get('input[aria-label="Select Unmatched file.mkv"]').should(
        'be.disabled'
      );
      cy.get('input[aria-label="Select Confirmed movie file.mkv"]').check();
      cy.contains('button', 'Import selected files').click();
      cy.wait('@import');
      cy.contains('Import pending').should('be.visible');
      cy.then(() => {
        state = 'resolved';
      });
      cy.contains('button', 'History').click();
      cy.wait('@inbox');
      cy.contains('summary', 'Action history').click();
      cy.contains('User 1').should('be.visible');
      cy.contains('Copy or hardlink').should('be.visible');
      cy.document().then((doc) =>
        expect(doc.documentElement.scrollWidth).to.be.at.most(width)
      );
      cy.screenshot(`download-inbox-${width}`);
    });
  it('requires confirmation and keeps client deletion opt-in', () => {
    cy.viewport(390, 900);
    const row = {
      id: 2,
      serviceType: 'sonarr',
      serviceId: 2,
      serviceName: 'Series acquisition',
      title: 'Unwanted download',
      warnings: ['Wrong release'],
      state: 'active',
      actions: [],
      manualImportCapable: true,
    };
    cy.intercept('GET', '/api/v1/downloads/interventions?*', {
      results: [row],
      total: 1,
      page: 1,
      partialSources: [],
      truncated: false,
    });
    cy.intercept('POST', '/api/v1/downloads/interventions/2/reject', (req) => {
      expect(req.body).to.deep.equal({
        blocklist: true,
        removeFromClient: false,
      });
      req.reply({ ...row, state: 'resolved', resolution: 'manual-blocklist' });
    }).as('reject');
    cy.visit('/downloads');
    cy.contains('button', 'Reject download').click();
    cy.contains('label', 'Remove the download and files')
      .find('input')
      .should('not.be.checked');
    cy.contains('button', 'Cancel').click();
    cy.contains('button', 'Confirm rejection').should('not.exist');
    cy.contains('button', 'Reject download').click();
    cy.contains('button', 'Confirm rejection').click();
    cy.wait('@reject');
  });
});
