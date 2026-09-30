import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  validateCurrentBatchContract,
} = require('./check-current-batch-contract-lib.js');

const repositoryFilesWith = (overrides = {}) =>
  new Proxy(overrides, {
    has: (target, key) =>
      typeof key === 'string' &&
      (Object.hasOwn(target, key) ||
        existsSync(new URL(`../${key}`, import.meta.url))),
    get: (target, key) => {
      if (typeof key !== 'string') return undefined;
      if (Object.hasOwn(target, key)) return target[key];
      return readFileSync(new URL(`../${key}`, import.meta.url), 'utf8');
    },
  });

test('current shared owners pass their checks and functional mutations fail', () => {
  const cases = [
    [
      'src/components/MediaDetails/MusicRatings.tsx',
      'getSafeHref(rating?.url)',
      'rating?.url',
      'music rating links must pass through the shared safe URL boundary',
    ],
    [
      'src/components/MediaDetails/MediaQualitySelect.tsx',
      'if (!option.disabled) onChange(option.value);',
      'onChange(option.value);',
      'detail quality options must not activate unavailable formats',
    ],
    [
      'src/components/Requests/destructiveActions.tsx',
      'okDisabled={disabled || busy}',
      'okDisabled={disabled}',
      'request deletion confirmations must preserve shared surfaces and busy-write guards',
    ],
    [
      'src/components/ManageSlideOver/ManageMediaActions.tsx',
      'issuesExpanded && canViewIssues && issues.length > 0',
      'issuesExpanded && issues.length > 0',
      'media management must guard the expandable Issue list by permission and availability',
    ],
    [
      'src/components/CollectionDetails/index.tsx',
      '(part) => !hasManualPlaybackSelection || selectedMediaIds.includes(part.id)',
      '() => true',
      'Collection playback must preserve oldest-first ordering and an intentionally empty selection',
    ],
    [
      'src/styles/globals.css',
      '.app-button-playback:hover {\n    border-color: rgb(var(--color-gray-200));',
      '.app-button-playback:hover {\n    border-color: rgb(var(--color-gray-600));',
      'playback buttons must restore the bright hover border without changing their black surface',
    ],
    [
      'src/styles/globals.css',
      '.media-request-submit-action {\n    @apply ml-auto flex min-w-0 items-center justify-end;',
      '.media-request-submit-action {\n    @apply flex min-w-0 items-center justify-start;',
      'detail Request controls must remain right-justified opposite Search Prowlarr',
    ],
  ];
  for (const [fileName, original, replacement, reason] of cases) {
    const source = readFileSync(
      new URL(`../${fileName}`, import.meta.url),
      'utf8'
    );
    assert.ok(source.includes(original), `${fileName}: mutation target exists`);
    assert.ok(
      !validateCurrentBatchContract(
        repositoryFilesWith({ [fileName]: source })
      ).some((error) => error.includes(reason)),
      reason
    );
    assert.ok(
      validateCurrentBatchContract(
        repositoryFilesWith({
          [fileName]: source.replace(original, replacement),
        })
      ).some((error) => error.includes(reason)),
      reason
    );
  }
});

test('reports missing files instead of silently skipping contract checks', () => {
  const errors = validateCurrentBatchContract({});
  assert.ok(errors.some((error) => error.includes('Missing contract input:')));
});

test('Docker keeps the host npm configuration out of the build context', () => {
  const dockerfile = readFileSync(
    new URL('../Dockerfile', import.meta.url),
    'utf8'
  );
  const ignoreRules = readFileSync(
    new URL('../.dockerignore', import.meta.url),
    'utf8'
  );
  const validErrors = validateCurrentBatchContract(
    repositoryFilesWith({
      Dockerfile: dockerfile,
      '.dockerignore': ignoreRules,
    })
  );
  assert.ok(
    !validErrors.some((error) => error.includes('without copying .npmrc')),
    validErrors.join('\n')
  );

  const weakInstallErrors = validateCurrentBatchContract(
    repositoryFilesWith({
      Dockerfile: dockerfile.replace(
        'pnpm --config.engine-strict=true install --prod --frozen-lockfile',
        'pnpm install --prod --frozen-lockfile'
      ),
    })
  );
  assert.ok(
    weakInstallErrors.some((error) =>
      error.includes(
        'production dependency installation must keep strict engine checks'
      )
    )
  );

  const exposedConfigErrors = validateCurrentBatchContract(
    repositoryFilesWith({ '.dockerignore': `${ignoreRules}\n!/.npmrc\n` })
  );
  assert.ok(
    exposedConfigErrors.some((error) =>
      error.includes('must not re-include host package-manager configuration')
    )
  );
});

test('reports a button-order regression', () => {
  const proxy = new Proxy(
    {},
    {
      has: () => true,
      get: (_target, key) =>
        String(key).endsWith('/index.tsx')
          ? 'buttonType="reportIssue" <ExclamationTriangleIcon /> </Button> buttonType="manage" buttonType="blocklist" buttonSize="sm"'
          : '',
    }
  );
  const errors = validateCurrentBatchContract(proxy);
  assert.ok(
    errors.some((error) =>
      error.includes(
        'detail actions must begin Blocklist, Manage, then Report an Issue'
      )
    )
  );
});

test('reports a shared selection-circle asset regression', () => {
  const proxy = new Proxy(
    {},
    {
      has: () => true,
      get: (_target, key) =>
        String(key).endsWith('src/components/RequestModal/TvRequestModal.tsx')
          ? '<RequestMediaCard'
          : '',
    }
  );
  const errors = validateCurrentBatchContract(proxy);
  assert.ok(
    errors.some((error) =>
      error.includes(
        'selector component must use the established solid CheckIcon'
      )
    )
  );
});

test('rejects the defective selector pattern in any component', () => {
  const errors = validateCurrentBatchContract({
    'src/components/UnexpectedSelector/index.tsx':
      '<button aria-pressed={selected}><CheckCircleIcon /></button>',
  });
  assert.ok(
    errors.some((error) =>
      error.includes(
        'interactive selection controls must use SelectionCircle instead of embedding CheckCircleIcon'
      )
    )
  );
});

test('reports an incomplete Books discovery navigation contract', () => {
  const proxy = new Proxy(
    {},
    {
      has: () => true,
      get: () => '',
    }
  );
  const errors = validateCurrentBatchContract(proxy);
  assert.ok(
    errors.some((error) =>
      error.includes(
        'Books discovery must preserve the All Books, Books, Audiobooks format order'
      )
    )
  );
  assert.ok(
    errors.some((error) =>
      error.includes(
        'the Book poster-card Request action must navigate to the auto-open Details flow'
      )
    )
  );
  assert.ok(
    errors.some((error) =>
      error.includes(
        'an empty default all-books provider response must surface as a provider failure'
      )
    )
  );
  assert.ok(
    errors.some((error) =>
      error.includes(
        'book discovery must retire browser cache entries created under the old stale-empty response contract'
      )
    )
  );
});

test('reports incomplete primary navigation cleanup', () => {
  const proxy = new Proxy(
    {},
    {
      has: () => true,
      get: (_target, key) =>
        String(key).includes('Layout/Sidebar') ||
        String(key).includes('Layout/MobileMenu')
          ? "href: '/discover/audiobooks' href: '/discover/audiobooks' href: '/requests/status'"
          : '',
    }
  );
  const errors = validateCurrentBatchContract(proxy);

  assert.ok(
    errors.some((error) =>
      error.includes(
        'primary navigation must contain exactly one Audiobooks entry'
      )
    )
  );
  assert.ok(
    errors.some((error) =>
      error.includes(
        'primary navigation must not contain the removed Request Status entry'
      )
    )
  );
  assert.ok(
    errors.some((error) =>
      error.includes(
        'primary navigation must retain exactly one main Requests entry'
      )
    )
  );
});

test('reports filter-control and reset regressions', () => {
  const proxy = new Proxy(
    {},
    {
      has: () => true,
      get: () => '',
    }
  );
  const errors = validateCurrentBatchContract(proxy);

  for (const expected of [
    'compact discovery selectors must override the white third-party control surface',
    'Clear Filters must restore the default sort order on every filtered page',
    'Movie and Series Genres must load the complete type-specific option list',
    'Movie and Series Genres must use the same shared single-value dropdown as neighboring filters',
    'the style standard must preserve single-value Genres filtering site-wide',
  ]) {
    assert.ok(
      errors.some((error) => error.includes(expected)),
      expected
    );
  }
});

test('rejects the former Movie and Series Genres multi-select', () => {
  const proxy = new Proxy(
    {},
    {
      has: () => true,
      get: (_target, key) =>
        String(key).endsWith('src/components/Discover/FilterPanel/index.tsx')
          ? "<GenreSelector isMulti onChange={(value) => updateFilter('genre', value?.map((v) => v.value).join(','))} />"
          : '',
    }
  );
  const errors = validateCurrentBatchContract(proxy);

  for (const expected of [
    'Movie and Series Genres must not restore the multi-select control',
    'Movie and Series Genres must not concatenate multiple selections',
  ]) {
    assert.ok(
      errors.some((error) => error.includes(expected)),
      expected
    );
  }
});

test('reports refreshed Users page contract regressions', () => {
  const proxy = new Proxy(
    {},
    {
      has: () => true,
      get: (_target, key) =>
        String(key).endsWith('src/components/UserList/index.tsx')
          ? '<PaginationFooter><Table.TH><input id="selectAll" type="checkbox" className="w-full" />'
          : '',
    }
  );
  const errors = validateCurrentBatchContract(proxy);

  for (const expected of [
    'the Users page must use the standardized card, filters, sorts, scrollable table, and actions',
    'the Users table must use shared selection circles for select-all and row selection',
    'the Users table must load one scrollable user set instead of paging the page',
    'the Users page must not restore pagination, legacy table controls, native row checkboxes, or full-width actions',
    'Users table geometry, typography, and divider styling must resolve through shared global classes',
    'the style standard must explicitly govern the refreshed Users page',
  ]) {
    assert.ok(
      errors.some((error) => error.includes(expected)),
      expected
    );
  }
});

test('reports shared Settings shell and group regressions', () => {
  const proxy = new Proxy(
    {},
    {
      has: () => true,
      get: (_target, key) =>
        String(key).endsWith('src/components/Settings/SettingsLayout.tsx')
          ? '<div className="mt-10 text-white">{children}</div>'
          : '',
    }
  );
  const errors = validateCurrentBatchContract(proxy);

  for (const expected of [
    'every Settings route must use the shared shell, navigation, actions, and unsaved-change workflow',
    'Settings content must not restore the uncontained legacy layout',
    'Settings route navigation must reuse the shared filter-button component styling',
    'General Settings and Playlist Integrations must be separate standard subcards',
    'Settings layout, groups, actions, and change state must resolve through shared global classes',
    'the style standard must explicitly govern the shared Settings refresh',
  ]) {
    assert.ok(
      errors.some((error) => error.includes(expected)),
      expected
    );
  }
});

test('rejects legacy Blocklist divider tracks and standalone divider elements', () => {
  const proxy = new Proxy(
    {},
    {
      has: () => true,
      get: (_target, key) =>
        String(key).endsWith('src/components/Blocklist/index.tsx')
          ? 'grid-cols-[max-content_0.75rem_6rem_1px_0.75rem_minmax(0,1fr)] card:block hidden bg-gray-600'
          : '',
    }
  );
  const errors = validateCurrentBatchContract(proxy);

  for (const expected of [
    'both Blocklist card detail separators must use the shared owning-column border class',
    'Blocklist cards must not restore the legacy one-pixel divider track',
    'Blocklist cards must not insert a separate gray divider element',
  ]) {
    assert.ok(
      errors.some((error) => error.includes(expected)),
      expected
    );
  }
});

test('reports Issue divider and compact status badge regressions', () => {
  const proxy = new Proxy(
    {},
    {
      has: () => true,
      get: () => '',
    }
  );
  const errors = validateCurrentBatchContract(proxy);

  for (const expected of [
    'Affected Episodes headings must use the shared two-pixel dark table divider',
    'Issue status badges must use the shared compact detail-status geometry',
    'Blocklist source badges must share the compact Issue-status geometry',
    'compact Issue and Blocklist badge geometry and colors must resolve through shared global classes',
    'the style standard must explicitly govern Blocklist and Affected Episodes dividers',
  ]) {
    assert.ok(
      errors.some((error) => error.includes(expected)),
      expected
    );
  }
});

test('reports Global Search progress positioning regressions', () => {
  const proxy = new Proxy(
    {},
    {
      has: () => true,
      get: () => '',
    }
  );
  const errors = validateCurrentBatchContract(proxy);

  for (const expected of [
    'Global Search progress must use the shared non-collapsing title-margin region',
    'Global Search progress must reference its shared indicator style',
    'the Global Search progress region must prevent page-title margin collapse',
    'Global Search progress must occupy the reserved margin above the page title',
    'the shared UI standard must preserve Search progress above page titles',
  ]) {
    assert.ok(
      errors.some((error) => error.includes(expected)),
      expected
    );
  }
});

test('reports shared modal screen-backdrop regressions', () => {
  const proxy = new Proxy(
    {},
    {
      has: () => true,
      get: (_target, key) =>
        String(key).endsWith('Common/Modal/index.tsx') ? 'bg-gray-800/70' : '',
    }
  );
  const errors = validateCurrentBatchContract(proxy);

  for (const expected of [
    'every shared modal must reference the site-wide screen-backdrop style',
    'the shared modal must not restore the blue-gray screen tint',
    'the shared modal backdrop must use the approved less-transparent black layer',
    'the shared UI standard must preserve the site-wide modal backdrop treatment',
  ]) {
    assert.ok(
      errors.some((error) => error.includes(expected)),
      expected
    );
  }
});

test('reports poster Associations style drift', () => {
  const proxy = new Proxy(
    {},
    {
      has: () => true,
      get: () => '',
    }
  );
  const errors = validateCurrentBatchContract(proxy);

  assert.ok(
    errors.some((error) =>
      error.includes(
        'the poster Associations action must use the independent poster-control style'
      )
    )
  );
});

test('reports Associations result navigation and redundant status regressions', () => {
  const missingWiring = new Proxy(
    {},
    {
      has: () => true,
      get: () => '',
    }
  );
  const wiringErrors = validateCurrentBatchContract(missingWiring);

  for (const expected of [
    'the shared association detail card must expose one navigation-close callback',
    'both the association poster and title links must invoke the shared navigation-close callback',
    'every Associations popup result group must pass through the navigation-close callback',
    'selecting an Associations popup result must close the popup as navigation begins',
    'collection association links must close their popup as navigation begins',
  ]) {
    assert.ok(
      wiringErrors.some((error) => error.includes(expected)),
      expected
    );
  }

  const redundantStatus = new Proxy(
    {},
    {
      has: () => true,
      get: (_target, key) =>
        String(key).endsWith('AssociationDetailCard.tsx')
          ? '<dt>Status:</dt>'
          : '',
    }
  );
  const statusErrors = validateCurrentBatchContract(redundantStatus);
  assert.ok(
    statusErrors.some((error) =>
      error.includes(
        'association detail cards must not repeat a separate Status heading or value'
      )
    )
  );
});

test('reports poster availability control drift', () => {
  const proxy = new Proxy(
    {},
    {
      has: () => true,
      get: () => '',
    }
  );
  const errors = validateCurrentBatchContract(proxy);

  for (const expected of [
    'poster quality states must use the shared rounded status badge',
    'poster quality states must match the rounded media-type badge silhouette',
    'available poster qualities must place the outlined availability icon after the green quality label',
    'poster overlays must use independent full-width rows with primary status on row one, Associations on row two left, and secondary status on row two right',
    'music posters must preserve separate MP3 and FLAC request states',
    'pending bell and processing timer badges must explain their meaning in tooltips',
  ]) {
    assert.ok(
      errors.some((error) => error.includes(expected)),
      expected
    );
  }
});

test('reports persistent detail disclosure pin contract drift', () => {
  const proxy = new Proxy(
    {},
    {
      has: () => true,
      get: () => '',
    }
  );
  const errors = validateCurrentBatchContract(proxy);

  for (const expected of [
    'detail disclosure pins must expose their selected state',
    'detail disclosure pins must use the authenticated category-scoped per-user settings endpoint',
    'detail disclosure pin settings must expose one read and one write route',
    'the disclosure row must consume the shared spacing role',
    'the Subject Tags pin must carry into Music details',
    'refreshed inset cards must use the darker translucent control surface without changing outer cards',
  ]) {
    assert.ok(
      errors.some((error) => error.includes(expected)),
      expected
    );
  }
});

test('reports request-card contrast and Advanced Options contract drift', () => {
  const proxy = new Proxy(
    {},
    {
      has: () => true,
      get: (_target, key) =>
        String(key).endsWith('src/components/RequestModal/TvRequestModal.tsx')
          ? '<RequestMediaCard backdropFull'
          : '',
    }
  );
  const errors = validateCurrentBatchContract(proxy);

  for (const expected of [
    'request controls must use the shared dropdown treatment',
    'request table and details dividers must use the shared theme border color',
    'detail columns must own their responsive divider border',
    'detail columns must resolve through the shared divider class',
    'root-folder scrolling must begin only after five rows',
    'Destination Server, Metadata Profile, Quality Profile, Root Folder, and Language must all use the shared request listbox',
    'Root Folder must use the shared request listbox with its selected path',
    'request listbox menus must mark their selected option with a check icon',
    'request dropdown color, geometry, and selection styling must live in shared global classes',
    'fresh request forms must open Advanced Options by default',
    'full-size request cards must use the site background gradient',
    'Request Series must reuse the shared request site canvas and inset artwork card',
    'Request Series must keep artwork in the media card, not behind the page heading',
    'Report Issue and Request Series must share one main-card layout class',
    'Report Issue and Request Series must consume the same main-card layout class',
    'artwork forms must leave vertical scrolling on the full modal viewport rather than the main card',
    'request-edit Close actions must use the shared red danger treatment',
    'the Series request-edit Close action must use the shared red danger treatment',
    'request cards must resolve wrapping action alignment through the shared global style',
    'request action rows must remain fully justified',
    'the style standard must require Root Folder to reuse the shared request listbox',
    'the style standard must preserve full justification when request actions wrap',
  ]) {
    assert.ok(
      errors.some((error) => error.includes(expected)),
      expected
    );
  }
});

test('rejects legacy Issue card divider tracks and elements', () => {
  const proxy = new Proxy(
    {},
    {
      has: () => true,
      get: (_target, key) =>
        String(key).endsWith('src/components/IssueList/IssueItem/index.tsx')
          ? 'media-detail-column-divider media-detail-column-divider card:grid-cols-[max-content_0.75rem_6rem_0.75rem_1px_0.75rem_minmax(0,1fr)] card:block hidden bg-gray-600'
          : '',
    }
  );
  const errors = validateCurrentBatchContract(proxy);

  for (const expected of [
    'Issue cards must not restore the legacy one-pixel divider track',
    'Issue cards must not insert a separate gray divider element',
  ]) {
    assert.ok(
      errors.some((error) => error.includes(expected)),
      expected
    );
  }
});

test('reports Firefox dynamic detail-artwork contract drift', () => {
  const proxy = new Proxy(
    {},
    {
      has: () => true,
      get: () => '',
    }
  );
  const errors = validateCurrentBatchContract(proxy);

  for (const expected of [
    'artwork-backed detail cards must use the stable shared artwork layer',
    'the Firefox artwork fallback must reuse the resolved cached image URL',
    'the dynamic artwork workaround must remain Firefox-specific',
    'Firefox must render expanding detail artwork through a stable background layer',
  ]) {
    assert.ok(
      errors.some((error) => error.includes(expected)),
      expected
    );
  }
});

test('reports recovered visual-contract and evidence-provenance regressions', () => {
  const proxy = new Proxy(
    {},
    {
      has: () => true,
      get: () => '',
    }
  );
  const errors = validateCurrentBatchContract(proxy);

  for (const expected of [
    'the style standard must preserve the single wrapping Request Status task row',
    'the style standard must keep All Books distinct from Clear Filters',
    'the style standard must keep Approval in the right request-details group',
    'the historical visual audit must not claim current render evidence for post-r3 source',
    'Request Status task summaries must retain the approved single-row order',
    'request forms must render Approval in their details grid',
    'request admission must identify a matching promotable pending request',
    'matching-pending promotion must retain cross-media route coverage',
    'request forms must permit authorized matching-pending promotion',
  ]) {
    assert.ok(
      errors.some((error) => error.includes(expected)),
      expected
    );
  }
});

test('reports refreshed Manage, Issue action, availability, and Association card regressions', () => {
  const proxy = new Proxy(
    {},
    {
      has: () => true,
      get: (_target, key) => {
        const fileName = String(key);
        if (fileName.includes('ManageSlideOver')) {
          return 'className="w-full" buttonSize="sm" actionButtonSize="default" intl.formatMessage(messages.manageModalMedia)';
        }
        if (
          fileName.endsWith('src/components/IssueDetails/IssueDiscussion.tsx')
        ) {
          return 'buttonSize="default"';
        }
        return '';
      },
    }
  );
  const errors = validateCurrentBatchContract(proxy);

  for (const expected of [
    'media management actions must never use a full-width button override',
    'media management actions must not use the ambiguously named small size',
    'the management Cancel action must use the shared standard size',
    'media management must delegate common actions to their shared owner',
    'media management must not retain a standalone Media card heading',
    'the management Cancel action must retain the approved alignment without local spacing',
    'Report an Issue actions must preserve the standard icon-to-label gap',
    'both inline issue actions must use the shared small action size',
    'the ratings row must not add bottom spacing before the primary actions',
    'ratings and primary actions must retain the shared card-spacing gap',
    'availability headings and status icons must share one centered cell style',
    'scrolling media table headers must reserve the shared thin scrollbar width',
    'both series selector headers must reserve the same right-side space as their rows',
    'playback selector headers must reserve the same right-side space as their rows',
    'association results must reuse the complete artwork-backed Issue card surface',
    'association detail cards must retain the shared artwork, poster, and scrim block',
    'association results must resolve per-title background artwork through one shared helper',
    'both Issue card detail separators must use the shared owning-column border class',
    'Issue cards must not reserve a standalone divider track between detail groups',
    'the style standard must explicitly govern both Issue card dividers',
  ]) {
    assert.ok(
      errors.some((error) => error.includes(expected)),
      expected
    );
  }
});

test('shared CSS checks accept grouped selectors but reject unrelated declarations', () => {
  const validate = (css) =>
    validateCurrentBatchContract({
      'src/styles/globals.css': css,
    });
  const reason = 'manage button must turn white on hover';
  assert.ok(
    !validate(
      '.app-button-manage:hover, .detail-disclosure-control:hover { color: #fff; }'
    ).some((error) => error.includes(reason))
  );
  assert.ok(
    validate(
      '.app-button-manage:hover { color: hsl(258 90% 83%); } .unrelated:hover { color: #fff; }'
    ).some((error) => error.includes(reason))
  );
  const spacing =
    'wrapped discovery filter rows must use the shared card spacing';
  assert.ok(
    !validate(
      '.discover-filter-secondary-row, .other { gap: var(--card-spacing); margin-top: var(--card-spacing); }'
    ).some((error) => error.includes(spacing))
  );
  assert.ok(
    validate(
      '.discover-filter-secondary-row { gap: 5px; } .other { gap: var(--card-spacing); margin-top: var(--card-spacing); }'
    ).some((error) => error.includes(spacing))
  );
});

test('reports related-media controls, inset-heading, and duplicate icon-gap regressions', () => {
  const proxy = new Proxy(
    {},
    {
      has: () => true,
      get: (_target, key) =>
        String(key).endsWith('src/components/Association/AssociationBadge.tsx')
          ? 'className="ml-1.5"'
          : String(key).endsWith('src/styles/globals.css')
            ? '.media-playback-control-group'
            : '',
    }
  );
  const errors = validateCurrentBatchContract(proxy);

  for (const expected of [
    'movie and series discovery must consume the shared filter and sort controls',
    'linked Recommendations and Similar pages must reuse their media discovery controls',
    'linked Recommendations and Similar pages must apply their visible filters and sorts',
    'media inset and table headings must use their shared mode-aware typography',
    'detail action labels must not duplicate the shared button icon gap',
    'quality selection and ratings must use the compact full-width shared row',
    'rating image and value pairs must use only the shared five-pixel internal gap',
    'playback controls must not be nested in a group that defeats full-row justification',
    'Movie quality selection and ratings must precede playback in the primary action row',
  ]) {
    assert.ok(
      errors.some((error) => error.includes(expected)),
      expected
    );
  }
});

test('reports Discover media tabs, compact filters, button shadows, and scoped pin regressions', () => {
  const proxy = new Proxy(
    {},
    {
      has: () => true,
      get: () => '',
    }
  );
  const errors = validateCurrentBatchContract(proxy);

  for (const expected of [
    'Discover media filters must retain the Movies, Series, Music, Books, Audiobooks order',
    'Trending must retain its own five-choice shared media filter row',
    'Trending media choices must render the corresponding complete discovery controls',
    'every Trending media destination must place the shared media filters above its own Filters controls',
    'filter buttons must resolve through the shared 20-pixel height',
    'filter button focus emphasis must render outside the fixed control box',
    'selected filter emphasis must render outside the fixed control box',
    'pinned filter section icons must use the shared dark-blue selected surface',
    'the title visibility filter must consume the shared compact filter button',
    'non-filter buttons must retain the shared ratings-style black readability shadow',
    'filter and sort buttons must remain exempt from the shared action-button shadow',
    'the legacy Request List sort-direction button must remain shadow-free',
    'detail disclosure pins must use the authenticated category-scoped per-user settings endpoint',
    'detail disclosure pin storage must be scoped by media category',
    'each detail page must consume only its own persistent pin category',
  ]) {
    assert.ok(
      errors.some((error) => error.includes(expected)),
      expected
    );
  }
});
