describe('Discovery provider integrations', () => {
  beforeEach(() => {
    cy.loginAsAdmin();
    cy.intercept('GET', '/api/v1/integrations/discovery/configuration', {
      trakt: { clientId: 'application-id', configured: true },
      anilist: { clientId: 'anilist-id', configured: true },
      simkl: { clientId: 'simkl-id', configured: false },
      mdblist: { configured: true },
    });
    cy.intercept('GET', '/api/v1/integrations/discovery/accounts', {
      accounts: [],
    });
  });
  it('shows application credentials without exposing saved secrets', () => {
    cy.visit('/settings/discovery');
    cy.get('#trakt-clientId').should('have.value', 'application-id');
    cy.get('#trakt-clientSecret')
      .should('have.value', '')
      .and('have.attr', 'type', 'password');
    cy.intercept(
      'PUT',
      '/api/v1/integrations/discovery/configuration',
      (request) => {
        expect(request.body).to.deep.equal({
          trakt: { clientSecret: 'replacement-secret' },
        });
        request.reply({
          trakt: { clientId: 'application-id', configured: true },
          anilist: { clientId: 'anilist-id', configured: true },
          simkl: { clientId: 'simkl-id', configured: false },
          mdblist: { configured: true },
        });
      }
    ).as('saveIntegrations');
    cy.get('#trakt-clientSecret').type('replacement-secret');
    cy.contains('button', 'Save integration settings').click();
    cy.wait('@saveIntegrations');
    cy.contains('Integration settings saved.').should('be.visible');
    cy.get('#trakt-clientSecret').should('have.value', '');
    cy.screenshot('discovery-integrations-settings');
  });
  it('publishes and removes shared packs with an instance-wide confirmation', () => {
    const packUrl = '/api/v1/integrations/discovery/mappings/packs';
    const pack = {
      format: 'seerrng.curated-title-matches',
      version: 1,
      packId: 'anime-core',
      name: 'Anime core',
      exportedAt: new Date().toISOString(),
      entries: [{ identity: 'anilist:123', tmdbId: 456, mediaType: 'tv' }],
    };
    const summary = {
      packId: 'anime-core',
      name: 'Anime core',
      version: 1,
      count: 1,
      updatedAt: new Date().toISOString(),
    };
    let published = false;
    cy.intercept('GET', packUrl, (request) =>
      request.reply({ packs: published ? [summary] : [] })
    ).as('sharedPacks');
    cy.intercept('POST', packUrl, (request) => {
      expect(request.headers['content-type']).to.contain('text/plain');
      expect(JSON.parse(request.body)).to.deep.equal(pack);
      published = true;
      request.reply({
        packId: 'anime-core',
        name: 'Anime core',
        imported: 1,
        updated: 0,
        unchanged: 0,
        removed: 0,
        total: 1,
      });
    }).as('publishPack');
    cy.intercept('DELETE', `${packUrl}/anime-core`, (request) => {
      published = false;
      request.reply({ removed: true });
    }).as('deletePack');

    cy.visit('/settings/discovery');
    cy.wait('@sharedPacks');
    cy.contains(
      'Every pack below affects all accounts on this SeerrNG instance'
    ).should('be.visible');
    cy.get('#curated-identity-pack-file').selectFile({
      contents: Cypress.Buffer.from(JSON.stringify(pack)),
      fileName: 'anime-core.json',
      mimeType: 'application/json',
    });
    cy.contains('Anime core (anime-core) contains 1 title matches').should(
      'be.visible'
    );
    cy.contains(
      'label',
      'I understand this shared pack applies to every account'
    )
      .find('input')
      .check();
    cy.contains('button', 'Publish shared pack').click();
    cy.wait('@publishPack');
    cy.wait('@sharedPacks');
    cy.contains('Shared pack “Anime core” saved. Entries: 1').should(
      'be.visible'
    );
    cy.contains('button', 'Delete pack').click();
    cy.contains(
      'Deleting “Anime core” removes its shared matches for every account'
    ).should('be.visible');
    cy.contains('button', 'Delete shared pack').click();
    cy.wait('@deletePack');
    cy.wait('@sharedPacks');
    cy.contains(
      'Shared pack “Anime core” was deleted for every account.'
    ).should('be.visible');
  });
  it('labels administrator-curated title matches and offers private overrides', () => {
    cy.intercept(
      'GET',
      '/api/v1/integrations/discovery/feeds/anilist/trending*',
      {
        page: 1,
        hasMore: false,
        missingMappings: 0,
        items: [
          {
            id: 'anilist:456',
            source: 'anilist',
            sourceId: '456',
            title: 'Shared catalog series',
            mediaType: 'tv',
            tmdbId: 987,
            identityResolution: 'curated',
            mappingAvailable: true,
          },
        ],
      }
    ).as('curatedFeed');
    cy.intercept('/api/v1/tv/987*', {
      id: 987,
      name: 'Shared catalog series',
      firstAirDate: '2021-01-01',
      genreIds: [],
    });
    cy.visit('/discover/providers');
    cy.get('#provider-feed').select('anilist/trending');
    cy.wait('@curatedFeed');
    cy.contains('Shared catalog series').should('be.visible');
    cy.contains(
      'This match comes from an administrator-managed shared pack. Choose another title to save a private override.'
    ).should('be.visible');
    cy.contains('button', 'Change title match').should('be.visible');
    cy.contains('button', 'Reset title match').should('not.exist');
  });
  it('shows personal authorization codes and permits cancelling an attempt', () => {
    cy.intercept(
      'POST',
      '/api/v1/integrations/discovery/accounts/trakt/connect',
      {
        userCode: 'PUBLIC-CODE',
        verificationUrl: 'https://trakt.tv/activate',
        interval: 60,
        expiresIn: 600,
      }
    );
    cy.intercept('DELETE', '/api/v1/integrations/discovery/accounts/trakt', {
      statusCode: 204,
    }).as('cancelConnection');
    cy.visit('/profile/settings/linked-accounts');
    cy.get('section[aria-labelledby="discovery-accounts-title"]').within(() => {
      cy.contains('h4', 'Trakt')
        .parent()
        .parent()
        .contains('button', 'Connect')
        .click();
      cy.contains('PUBLIC-CODE').should('be.visible');
      cy.contains('a', 'Open authorization page').should(
        'have.attr',
        'href',
        'https://trakt.tv/activate'
      );
      cy.contains('button', 'Cancel').click();
    });
    cy.wait('@cancelConnection');
    cy.contains('PUBLIC-CODE').should('not.exist');
  });
  for (const width of [390, 1280])
    it(`browses native catalog results and pages at ${width}px`, () => {
      cy.viewport(width, 900);
      cy.intercept(
        'GET',
        '/api/v1/integrations/discovery/feeds/anilist/trending*',
        (request) => {
          const page = Number(request.query.page ?? 1);
          request.reply({
            page,
            hasMore: page === 1,
            missingMappings: 1,
            items: [
              {
                id: `anilist:${page}`,
                source: 'anilist',
                sourceId: String(page),
                title: `Native catalog title ${page}`,
                mediaType: 'tv',
              },
            ],
          });
        }
      ).as('nativeFeed');
      cy.visit('/discover/providers');
      cy.get('#provider-feed').select('anilist/trending');
      cy.wait('@nativeFeed');
      cy.contains('Native catalog title 1').should('be.visible');
      cy.contains('Catalog match pending').should('be.visible');
      cy.contains('button', 'Next').click();
      cy.wait('@nativeFeed');
      cy.contains('Native catalog title 2').should('be.visible');
      cy.contains('button', 'Next').should('be.disabled');
      cy.document().then((doc) =>
        expect(doc.documentElement.scrollWidth).to.be.at.most(width)
      );
      cy.screenshot(`provider-discovery-${width}`);
    });
  for (const width of [390, 1280])
    it(`repairs unmatched discovery titles at ${width}px`, () => {
      cy.viewport(width, 900);
      let matched = false;
      cy.intercept(
        'GET',
        '/api/v1/integrations/discovery/feeds/anilist/trending*',
        (request) =>
          request.reply({
            page: 1,
            hasMore: false,
            missingMappings: matched ? 0 : 1,
            items: [
              {
                id: 'anilist:22',
                source: 'anilist',
                sourceId: '22',
                title: 'Unmatched discovery anime',
                mediaType: 'tv',
                mappingAvailable: true,
                ...(matched ? { tmdbId: 456, identityMapped: true } : {}),
              },
            ],
          })
      ).as('discoveryFeed');
      cy.intercept('GET', '/api/v1/search?*', {
        page: 1,
        totalPages: 1,
        totalResults: 1,
        results: [
          {
            id: 456,
            mediaType: 'tv',
            name: 'Matched discovery series',
            firstAirDate: '2020-01-01',
          },
        ],
      }).as('discoveryMappingSearch');
      cy.intercept(
        'PUT',
        '/api/v1/integrations/discovery/mappings',
        (request) => {
          expect(request.body).to.deep.equal({
            identity: 'anilist:22',
            tmdbId: 456,
            mediaType: 'tv',
          });
          matched = true;
          request.reply({
            identity: 'anilist:22',
            tmdbId: 456,
            mediaType: 'tv',
            updatedAt: new Date().toISOString(),
          });
        }
      ).as('saveDiscoveryMapping');
      cy.intercept(
        'DELETE',
        '/api/v1/integrations/discovery/mappings/*',
        (request) => {
          matched = false;
          request.reply({ removed: true });
        }
      ).as('resetDiscoveryMapping');

      cy.visit('/discover/providers');
      cy.get('#provider-feed').select('anilist/trending');
      cy.wait('@discoveryFeed');
      cy.contains('Catalog match pending').should('be.visible');
      cy.get('input[type="checkbox"]').check();
      cy.contains('button', 'Match catalog title').click();
      cy.get('input[aria-label="Search SeerrNG catalog"]').type('Matched');
      cy.wait('@discoveryMappingSearch');
      cy.contains('button', 'Use this match').click();
      cy.wait('@saveDiscoveryMapping');
      cy.contains('No unmatched titles remain on this page.').should(
        'be.visible'
      );
      cy.get('input[type="checkbox"]').uncheck();
      cy.contains('button', 'Reset title match').click();
      cy.wait('@resetDiscoveryMapping');
      cy.contains('Catalog match pending').should('be.visible');
      cy.document().then((doc) =>
        expect(doc.documentElement.scrollWidth).to.be.at.most(width)
      );
      cy.screenshot(`provider-discovery-repair-${width}`);
    });
  it('labels exact external-ID matches and allows a private override', () => {
    let overridden = false;
    cy.intercept(
      'GET',
      '/api/v1/integrations/discovery/feeds/trakt/watchlist*',
      (request) =>
        request.reply({
          page: 1,
          hasMore: false,
          missingMappings: 0,
          items: [
            {
              id: 'trakt:tv:101',
              source: 'trakt',
              sourceId: '101',
              title: 'Exact ID series',
              mediaType: 'tv',
              tmdbId: 456,
              identityResolution: overridden ? 'personal' : 'external-id',
              identityMapped: overridden,
              mappingAvailable: true,
            },
          ],
        })
    ).as('resolvedFeed');
    cy.intercept('GET', '/api/v1/tv/456*', {
      id: 456,
      name: 'Exact ID series',
      posterPath: null,
      mediaType: 'tv',
    });
    cy.intercept('GET', '/api/v1/search?*', {
      page: 1,
      totalPages: 1,
      totalResults: 1,
      results: [
        {
          id: 789,
          mediaType: 'tv',
          name: 'Override series',
          firstAirDate: '2021-01-01',
        },
      ],
    });
    cy.intercept(
      'PUT',
      '/api/v1/integrations/discovery/mappings',
      (request) => {
        expect(request.body).to.deep.equal({
          identity: 'trakt:tv:101',
          tmdbId: 789,
          mediaType: 'tv',
        });
        overridden = true;
        request.reply({
          identity: 'trakt:tv:101',
          tmdbId: 789,
          mediaType: 'tv',
          updatedAt: new Date().toISOString(),
        });
      }
    ).as('savePrivateOverride');

    cy.visit('/discover/providers');
    cy.get('#provider-feed').select('trakt/watchlist');
    cy.wait('@resolvedFeed');
    cy.contains('Exact ID series').should('be.visible');
    cy.contains('exact IMDb or TVDB ID').should('be.visible');
    cy.contains('button', 'Change title match').click();
    cy.get('input[aria-label="Search SeerrNG catalog"]').type('Override');
    cy.contains('button', 'Use this match').click();
    cy.wait('@savePrivateOverride');
    cy.contains('Reset title match').should('be.visible');
    cy.contains('private override').should('not.exist');
  });
  it('shows personalized Discover rows only for connected provider accounts', () => {
    cy.intercept('GET', '/api/v1/integrations/discovery/accounts', {
      accounts: [
        { provider: 'trakt', username: 'MovieFan', allowWrites: false },
        { provider: 'anilist', username: 'AnimeFan', allowWrites: false },
      ],
    }).as('personalAccounts');
    cy.intercept(
      'GET',
      '/api/v1/integrations/discovery/feeds/trakt/recommendations-movie*',
      {
        page: 1,
        hasMore: false,
        missingMappings: 1,
        items: [
          {
            id: 'trakt:movie:101',
            source: 'trakt',
            sourceId: '101',
            title: 'A Trakt movie recommendation',
            mediaType: 'movie',
          },
        ],
      }
    ).as('traktRecommendations');
    cy.intercept(
      'GET',
      '/api/v1/integrations/discovery/feeds/trakt/recommendations-tv*',
      { page: 1, hasMore: false, missingMappings: 0, items: [] }
    ).as('traktSeriesRecommendations');
    cy.intercept(
      'GET',
      '/api/v1/integrations/discovery/feeds/trakt/watchlist*',
      { page: 1, hasMore: false, missingMappings: 0, items: [] }
    ).as('traktWatchlist');
    cy.intercept(
      'GET',
      '/api/v1/integrations/discovery/library/anilist*',
      (request) => {
        const watching = request.query.shelf === 'in-progress';
        request.reply({
          items: watching
            ? [
                {
                  id: 'anilist:202',
                  source: 'anilist',
                  sourceId: '202',
                  title: 'An AniList series in progress',
                  mediaType: 'tv',
                  status: 'watching',
                },
              ]
            : [],
          page: 1,
          hasMore: false,
          allowWrites: false,
          missingMappings: 0,
          truncated: false,
        });
      }
    ).as('anilistPersonalRows');

    cy.visit('/');
    cy.wait('@personalAccounts');
    cy.wait('@traktRecommendations');
    cy.wait('@traktSeriesRecommendations');
    cy.wait('@traktWatchlist');
    cy.contains('h2', 'Picked for You').should('be.visible');
    cy.get('[data-testid=personal-discovery-row-trakt-recommended-movies]')
      .should('contain', 'A Trakt movie recommendation')
      .and('contain', 'Catalog match pending');
    cy.get('[data-testid=personal-discovery-row-anilist-watching]')
      .scrollIntoView()
      .should('be.visible');
    cy.wait('@anilistPersonalRows');
    cy.get('[data-testid=personal-discovery-row-anilist-watching]').should(
      'contain',
      'An AniList series in progress'
    );
    cy.get(
      '[data-testid=personal-discovery-row-trakt-recommended-series]'
    ).should('not.exist');
    cy.get('[data-testid=personal-discovery-row-simkl-watching]').should(
      'not.exist'
    );
  });
  it('holds provider retries until the reported quota cooldown ends', () => {
    cy.intercept(
      'GET',
      '/api/v1/integrations/discovery/feeds/anilist/trending*',
      {
        statusCode: 429,
        headers: { 'retry-after': '2' },
        body: { code: 'PROVIDER_RATE_LIMITED' },
      }
    ).as('limitedFeed');

    cy.visit('/discover/providers');
    cy.wait('@limitedFeed');
    cy.get('[role="alert"]').should(
      'contain.text',
      'The provider request limit was reached.'
    );
    cy.contains('[role="alert"] button', 'Retry').should('be.disabled');
    cy.wait(2100);
    cy.contains('[role="alert"] button', 'Retry').should('be.enabled');
    cy.contains('[role="alert"] button', 'Retry').click();
    cy.wait('@limitedFeed');
  });
  it('links expired accounts to recovery and identifies missing public lists', () => {
    cy.intercept(
      'GET',
      '/api/v1/integrations/discovery/feeds/anilist/trending*',
      {
        statusCode: 409,
        body: { code: 'RECONNECT_REQUIRED' },
      }
    ).as('expiredFeed');
    cy.intercept('GET', '/api/v1/integrations/discovery/feeds/mdblist/list*', {
      statusCode: 404,
      body: { code: 'PROVIDER_LIST_NOT_FOUND' },
    }).as('missingList');

    cy.visit('/discover/providers');
    cy.wait('@expiredFeed');
    cy.contains('[role="alert"]', 'needs to be reconnected').should(
      'be.visible'
    );
    cy.contains('a', 'Manage linked accounts').should(
      'have.attr',
      'href',
      '/profile/settings/linked-accounts'
    );

    cy.get('#provider-feed').select('mdblist/list');
    cy.get('#mdblist-reference').type('123');
    cy.contains('button', 'Browse list').click();
    cy.wait('@missingList');
    cy.contains('[role="alert"]', 'make sure the list is public').should(
      'be.visible'
    );
    cy.get('[role="alert"] button').should('not.exist');
  });
  for (const width of [390, 1280])
    it(`browses and updates a personal library at ${width}px`, () => {
      cy.viewport(width, 900);
      cy.intercept('GET', '/api/v1/integrations/discovery/accounts', {
        accounts: [
          { provider: 'anilist', username: 'Reader', allowWrites: true },
        ],
      });
      cy.intercept('GET', '/imageproxy/anilist/**', {
        statusCode: 200,
        headers: { 'content-type': 'image/svg+xml' },
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><rect width="1" height="1" fill="blue"/></svg>',
      });
      cy.intercept('GET', '/api/v1/integrations/discovery/library/anilist*', {
        items: [
          {
            id: 'anilist:101',
            source: 'anilist',
            sourceId: '101',
            title: 'Personal anime title',
            mediaType: 'tv',
            status: 'watching',
            rating: 7.5,
            progress: 3,
            totalEpisodes: 12,
            imageUrl: 'https://s4.anilist.co/file/cover.jpg',
          },
        ],
        page: 1,
        hasMore: false,
        allowWrites: true,
        missingMappings: 1,
        truncated: false,
      });
      cy.intercept(
        'POST',
        '/api/v1/integrations/discovery/tracking/anilist',
        (request) => {
          expect(request.body.requestId).to.match(
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
          );
          request.reply({
            requestId: request.body.requestId,
            provider: 'anilist',
            state: 'succeeded',
            createdAt: new Date().toISOString(),
          });
        }
      ).as('trackingUpdate');
      cy.visit('/library');
      cy.contains('Personal anime title').should('be.visible');
      cy.get('img[src*="/imageproxy/anilist/"]').should('be.visible');
      cy.contains('Some titles retain their original provider identity').should(
        'be.visible'
      );
      cy.get('input[aria-label="Your rating"]')
        .should('have.value', '7.5')
        .clear()
        .type('7.8');
      cy.contains('button', 'Save rating').click();
      cy.wait('@trackingUpdate').its('request.body').should('include', {
        action: 'rating',
        value: 7.8,
        anilistId: 101,
      });
      cy.contains('button', 'Mark watched').click();
      cy.contains('This updates watched status for the full series.').should(
        'be.visible'
      );
      cy.contains('button', 'Confirm').click();
      cy.wait('@trackingUpdate').its('request.body').should('include', {
        action: 'watched',
        value: true,
        anilistId: 101,
      });
      cy.document().then((doc) =>
        expect(doc.documentElement.scrollWidth).to.be.at.most(width)
      );
      cy.get('input[aria-label="Your rating"]').scrollIntoView();
      cy.screenshot(`personal-provider-library-${width}`, {
        capture: 'viewport',
      });
    });

  it('repairs and resets an unmatched personal library title', () => {
    cy.viewport(1280, 900);
    let matched = false;
    cy.intercept('GET', '/api/v1/integrations/discovery/accounts', {
      accounts: [
        { provider: 'anilist', username: 'Reader', allowWrites: false },
      ],
    });
    cy.intercept(
      'GET',
      '/api/v1/integrations/discovery/library/anilist*',
      (request) =>
        request.reply({
          items: [
            {
              id: 'anilist:101',
              source: 'anilist',
              sourceId: '101',
              title: 'Unmatched personal anime',
              mediaType: 'tv',
              ...(matched ? { tmdbId: 456, identityMapped: true } : {}),
            },
          ],
          page: 1,
          hasMore: false,
          allowWrites: false,
          missingMappings: matched ? 0 : 1,
          truncated: false,
        })
    ).as('personalLibrary');
    cy.intercept('GET', '/api/v1/search?*', (request) => {
      expect(request.query.type).to.equal('tv');
      request.reply({
        page: 1,
        totalPages: 1,
        totalResults: 1,
        results: [
          {
            id: 456,
            mediaType: 'tv',
            name: 'Confirmed catalog series',
            firstAirDate: '2020-01-01',
          },
        ],
      });
    }).as('mappingSearch');
    cy.intercept(
      'PUT',
      '/api/v1/integrations/discovery/mappings',
      (request) => {
        expect(request.body).to.deep.equal({
          identity: 'anilist:101',
          tmdbId: 456,
          mediaType: 'tv',
        });
        matched = true;
        request.reply({
          identity: 'anilist:101',
          tmdbId: 456,
          mediaType: 'tv',
          updatedAt: new Date().toISOString(),
        });
      }
    ).as('saveIdentityMapping');
    cy.intercept(
      'DELETE',
      '/api/v1/integrations/discovery/mappings/*',
      (request) => {
        matched = false;
        request.reply({ removed: true });
      }
    ).as('resetIdentityMapping');
    cy.intercept('GET', '/api/v1/tv/456', {
      id: 456,
      name: 'Confirmed catalog series',
      firstAirDate: '2020-01-01',
      genreIds: [],
    });

    cy.visit('/library');
    cy.contains('Unmatched personal anime').should('be.visible');
    cy.contains('button', 'Match catalog title').click();
    cy.wait('@mappingSearch');
    cy.contains('button', 'Use this match').click();
    cy.wait('@saveIdentityMapping');
    cy.wait('@personalLibrary');
    cy.contains('button', 'Reset title match').should('be.visible').click();
    cy.wait('@resetIdentityMapping');
    cy.wait('@personalLibrary');
    cy.contains('button', 'Match catalog title').should('be.visible');
  });

  it('imports and exports private title-match packs from My Library', () => {
    cy.viewport(1280, 900);
    let matched = false;
    const pack = {
      format: 'seerrng.personal-title-matches',
      version: 1,
      exportedAt: new Date().toISOString(),
      entries: [{ identity: 'anilist:123', tmdbId: 456, mediaType: 'movie' }],
    };
    cy.intercept('GET', '/api/v1/integrations/discovery/accounts', {
      accounts: [
        { provider: 'anilist', username: 'Reader', allowWrites: false },
      ],
    });
    cy.intercept(
      'GET',
      '/api/v1/integrations/discovery/library/anilist*',
      (request) =>
        request.reply({
          items: [
            {
              id: 'anilist:123',
              source: 'anilist',
              sourceId: '123',
              title: 'Imported title match',
              mediaType: 'movie',
              ...(matched ? { tmdbId: 456, identityMapped: true } : {}),
            },
          ],
          page: 1,
          hasMore: false,
          allowWrites: false,
          missingMappings: matched ? 0 : 1,
          truncated: false,
        })
    ).as('packPersonalLibrary');
    cy.intercept('GET', '/api/v1/movie/456*', {
      id: 456,
      title: 'Imported catalog movie',
      releaseDate: '2024-01-01',
      genreIds: [],
      posterPath: null,
      backdropPath: null,
      overview: '',
    });
    cy.intercept(
      'POST',
      '/api/v1/integrations/discovery/mappings/pack',
      (request) => {
        expect(request.headers['content-type']).to.include('text/plain');
        expect(JSON.parse(request.body)).to.deep.equal(pack);
        matched = true;
        request.reply({ imported: 1, updated: 0, unchanged: 0, total: 1 });
      }
    ).as('importTitlePack');
    cy.intercept(
      'GET',
      '/api/v1/integrations/discovery/mappings/pack',
      (request) =>
        request.reply({ ...pack, entries: matched ? pack.entries : [] })
    ).as('exportTitlePack');

    cy.visit('/library');
    cy.wait('@packPersonalLibrary');
    cy.get('#identity-mapping-pack').selectFile({
      contents: Cypress.Buffer.from(JSON.stringify(pack)),
      fileName: 'personal-title-matches.json',
      mimeType: 'application/json',
    });
    cy.contains('personal-title-matches.json contains 1 title matches.').should(
      'be.visible'
    );
    cy.contains('button', 'Import title matches').click();
    cy.wait('@importTitlePack');
    cy.wait('@packPersonalLibrary');
    cy.contains('Imported 1, updated 0, and left 0 unchanged.').should(
      'be.visible'
    );
    cy.contains('button', 'Change title match').should('be.visible');

    cy.contains('button', 'Export title matches').click();
    cy.wait('@exportTitlePack')
      .its('response.body.entries')
      .should('have.length', 1);
  });

  for (const width of [390, 1280])
    it(`browses the linked media server library at ${width}px`, () => {
      cy.viewport(width, 900);
      cy.intercept('GET', '/api/v1/integrations/discovery/accounts', {
        accounts: [],
        mediaServer: { provider: 'jellyfin', connected: true },
      });
      cy.intercept(
        'GET',
        '/api/v1/integrations/discovery/library/jellyfin*',
        (request) => {
          const url = new URL(request.url);
          const libraryId = url.searchParams.get('libraryId');
          const shelf = url.searchParams.get('shelf');
          const cursor = Number(url.searchParams.get('cursor') ?? 0);
          const nextInProgressPage =
            shelf === 'in-progress' && libraryId === 'shows' && cursor === 41;
          const hasNextInProgressPage =
            shelf === 'in-progress' && libraryId === 'shows' && cursor === 0;
          const libraries = [
            { id: 'movies', name: 'Movies', type: 'movie' },
            { id: 'shows', name: 'Series', type: 'show' },
          ];
          request.reply({
            items: libraryId
              ? [
                  {
                    id: `jellyfin:${libraryId}:item-1`,
                    source: 'jellyfin',
                    sourceId: nextInProgressPage ? 'item-2' : 'item-1',
                    title:
                      libraryId === 'shows'
                        ? nextInProgressPage
                          ? 'Native series title page 2'
                          : 'Native series title'
                        : 'Native movie title',
                    mediaType: libraryId === 'shows' ? 'tv' : 'movie',
                    year: 2025,
                    status:
                      url.searchParams.get('shelf') === 'in-progress'
                        ? 'watching'
                        : 'unwatched',
                    progress: libraryId === 'shows' ? 3 : undefined,
                    totalEpisodes: libraryId === 'shows' ? 8 : undefined,
                  },
                ]
              : [],
            libraries,
            page: Number(url.searchParams.get('page') ?? 1),
            total: hasNextInProgressPage ? 2 : 1,
            hasMore: hasNextInProgressPage,
            nextCursor: hasNextInProgressPage ? 41 : undefined,
            allowWrites: false,
            missingMappings: 0,
            truncated: false,
          });
        }
      ).as('nativeLibrary');

      cy.visit('/library');
      cy.wait('@nativeLibrary');
      cy.wait('@nativeLibrary');
      cy.get('#library-source').should('have.value', 'jellyfin');
      cy.get('#library-server-library').should('be.visible');
      cy.contains('Native movie title').should('be.visible');
      cy.get('#library-server-library').select('shows');
      cy.wait('@nativeLibrary');
      cy.contains('Native series title').should('be.visible');
      cy.get('#library-shelf').select('in-progress');
      cy.wait('@nativeLibrary');
      cy.contains('Watching').should('be.visible');
      cy.contains('button', 'Mark watched').should('not.exist');
      cy.contains('button', 'Save rating').should('not.exist');
      cy.contains('button', 'Next').click();
      cy.wait('@nativeLibrary').then(({ request }) => {
        expect(new URL(request.url).searchParams.get('cursor')).to.equal('41');
      });
      cy.contains('Native series title page 2').should('be.visible');
      cy.document().then((doc) =>
        expect(doc.documentElement.scrollWidth).to.be.at.most(width)
      );
    });
});
