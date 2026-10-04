// Audits every media-type enum in seerr-api.yml. Each one must list manga or
// carry a reviewed exclusion that names its reason and its owner: the stack
// layer (L2-L14) or planned follow-up (P1 chapter browser, P2 release
// calendar, P3 discover filters, P4 watchlist) that decides it, post-MVP for
// work outside the plan, or not applicable. The server validates requests
// against this spec, so a request enum without manga rejects manga with a
// 400. Responses are not validated, so a response enum without manga only
// documents the API wrongly.
import { MediaType } from '@server/constants/media';
import { load as loadYaml } from 'js-yaml';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

type EnumSite = {
  location: string;
  name?: string;
  values: readonly unknown[];
};

type Exclusion = {
  owner: string;
  reason: string;
};

const HTTP_METHODS = new Set([
  'delete',
  'get',
  'head',
  'options',
  'patch',
  'post',
  'put',
  'trace',
]);
const COMPOSITION_KEYWORDS = new Set(['allOf', 'anyOf', 'oneOf']);
const MEDIA_TYPE_VALUES: ReadonlySet<unknown> = new Set(
  Object.values(MediaType)
);
const OWNER_PATTERN = /^(?:L(?:[2-9]|1[0-4])|P[1-4]|post-MVP|not applicable)$/u;

const TMDB_DISCOVERY = 'Movie and TV discovery integrations keyed by TMDB.';
const PROWLARR_CATEGORIES =
  'Prowlarr indexer categories; manga is acquired through Suwayomi, not indexers.';
const DEPRECATED_BLACKLIST =
  'Deprecated alias of /blocklist; new media types are added to /blocklist only.';
const MEDIA_SERVER_LIBRARY_TYPES =
  'Media-server library section types, not SeerrNG media types.';
const COLLECTION_CATALOG =
  'TV franchise and artist album collections; manga collections are outside the MVP.';

// Keyed by the location printed in a failure. Remove an entry when its enum
// gains manga; the audit fails on entries that no longer match.
const MANGA_ENUM_EXCLUSIONS: Record<string, Exclusion> = {
  'schema BulkMediaRequestBody mediaType': {
    owner: 'post-MVP',
    reason:
      'Bulk requests cover music and book selections; manga requests are single-title in the MVP.',
  },
  'schema DiscoveryFeedItem mediaType': {
    owner: 'not applicable',
    reason: TMDB_DISCOVERY,
  },
  'schema PersonalLibraryItem mediaType': {
    owner: 'not applicable',
    reason: TMDB_DISCOVERY,
  },
  'schema ProviderLibraryRepairRequest mediaType': {
    owner: 'not applicable',
    reason: TMDB_DISCOVERY,
  },
  'schema DiscoveryIdentityMappingRequest mediaType': {
    owner: 'not applicable',
    reason: TMDB_DISCOVERY,
  },
  'schema DiscoveryIdentityMapping mediaType': {
    owner: 'not applicable',
    reason: TMDB_DISCOVERY,
  },
  'schema PersonalIdentityMappingPackEntry mediaType': {
    owner: 'not applicable',
    reason: TMDB_DISCOVERY,
  },
  'schema DiscoveryTrackingRequest mediaType': {
    owner: 'not applicable',
    reason: TMDB_DISCOVERY,
  },
  'GET /integrations/discovery/library/{provider} query mediaType': {
    owner: 'not applicable',
    reason: TMDB_DISCOVERY,
  },
  'GET /discover/trending query mediaType': {
    owner: 'not applicable',
    reason: 'TMDB movie and TV trending; manga discovery uses its own routes.',
  },
  'POST /discover/home/state body items[].oneOf[0].mediaType': {
    owner: 'not applicable',
    reason: 'TMDB-keyed Discover items (movie and TV).',
  },
  'GET /playback/watched/{mediaType}/{tmdbId} path mediaType': {
    owner: 'not applicable',
    reason: 'Media-server watched state for TMDB movies and series.',
  },
  'schema PlexLibrary type': {
    owner: 'not applicable',
    reason: MEDIA_SERVER_LIBRARY_TYPES,
  },
  'schema JellyfinLibrary type': {
    owner: 'not applicable',
    reason: MEDIA_SERVER_LIBRARY_TYPES,
  },
  'PUT /settings/plex/library/{libraryId}/type body type': {
    owner: 'not applicable',
    reason: 'Plex library classification (music or book).',
  },
  'schema ProwlarrSearchResultsResponse category': {
    owner: 'not applicable',
    reason: PROWLARR_CATEGORIES,
  },
  'GET /indexer-search/configuration response 200 categories[].category': {
    owner: 'not applicable',
    reason: PROWLARR_CATEGORIES,
  },
  'POST /indexer-search/search body category': {
    owner: 'not applicable',
    reason: PROWLARR_CATEGORIES,
  },
  'GET /blacklist/{tmdbId} query mediaType': {
    owner: 'not applicable',
    reason: DEPRECATED_BLACKLIST,
  },
  'DELETE /blacklist/{tmdbId} query mediaType': {
    owner: 'not applicable',
    reason: DEPRECATED_BLACKLIST,
  },
  'schema AssociationGraph root.mediaType': {
    owner: 'post-MVP',
    reason: 'Cross-medium associations are outside the manga MVP.',
  },
  'GET /association/{mediaType}/{id} path mediaType': {
    owner: 'post-MVP',
    reason: 'Cross-medium associations are outside the manga MVP.',
  },
  '/collection-catalog/{kind}/{id} path kind': {
    owner: 'post-MVP',
    reason: COLLECTION_CATALOG,
  },
  '/collection-catalog/{kind}/{id}/availability path kind': {
    owner: 'post-MVP',
    reason: COLLECTION_CATALOG,
  },
  '/collection-catalog/{kind}/{id}/server path kind': {
    owner: 'post-MVP',
    reason: COLLECTION_CATALOG,
  },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const formatLocation = (scope: string, segments: readonly string[]) => {
  const suffix = segments.reduce(
    (formatted, segment) =>
      segment === '[]'
        ? `${formatted}[]`
        : formatted
          ? `${formatted}.${segment}`
          : segment,
    ''
  );

  if (!suffix) {
    return scope;
  }

  return suffix.startsWith('[]') ? `${scope}${suffix}` : `${scope} ${suffix}`;
};

const collectSchemaEnums = (
  schema: unknown,
  scope: string,
  segments: readonly string[],
  name: string | undefined,
  sites: EnumSite[]
): void => {
  if (Array.isArray(schema)) {
    schema.forEach((member, index) =>
      collectSchemaEnums(member, scope, [...segments, `${index}`], name, sites)
    );
    return;
  }
  if (!isRecord(schema)) {
    return;
  }

  if (Array.isArray(schema.enum)) {
    sites.push({
      location: formatLocation(scope, segments),
      name,
      values: schema.enum,
    });
  }

  for (const [keyword, child] of Object.entries(schema)) {
    if (keyword === 'enum') {
      continue;
    }

    if (keyword === 'properties' && isRecord(child)) {
      for (const [property, propertySchema] of Object.entries(child)) {
        collectSchemaEnums(
          propertySchema,
          scope,
          [...segments, property],
          property,
          sites
        );
      }
    } else if (keyword === 'items') {
      collectSchemaEnums(child, scope, [...segments, '[]'], name, sites);
    } else if (COMPOSITION_KEYWORDS.has(keyword) && Array.isArray(child)) {
      child.forEach((member, index) =>
        collectSchemaEnums(
          member,
          scope,
          [...segments, `${keyword}[${index}]`],
          name,
          sites
        )
      );
    } else {
      collectSchemaEnums(child, scope, [...segments, keyword], name, sites);
    }
  }
};

const collectParameterEnums = (
  parameters: unknown,
  scope: string,
  sites: EnumSite[]
) => {
  if (!Array.isArray(parameters)) {
    return;
  }

  for (const parameter of parameters) {
    if (!isRecord(parameter)) {
      continue;
    }
    const name = String(parameter.name);
    collectSchemaEnums(
      parameter.schema,
      `${scope} ${String(parameter.in)} ${name}`,
      [],
      name,
      sites
    );
  }
};

const collectContentEnums = (
  content: unknown,
  scope: string,
  sites: EnumSite[]
) => {
  if (!isRecord(content)) {
    return;
  }

  const entries = Object.entries(content);
  for (const [contentType, entry] of entries) {
    if (isRecord(entry)) {
      collectSchemaEnums(
        entry.schema,
        entries.length > 1 ? `${scope} (${contentType})` : scope,
        [],
        undefined,
        sites
      );
    }
  }
};

// Walks component schemas, path and operation parameters, request bodies,
// response bodies and response headers. Locations read as
// "schema <Name> <property path>" or "<METHOD> <route> <part> <property path>".
const collectEnumSites = (document: Record<string, unknown>): EnumSite[] => {
  const sites: EnumSite[] = [];
  const components = isRecord(document.components) ? document.components : {};
  const schemas = isRecord(components.schemas) ? components.schemas : {};
  for (const [schemaName, schema] of Object.entries(schemas)) {
    collectSchemaEnums(schema, `schema ${schemaName}`, [], undefined, sites);
  }

  const paths = isRecord(document.paths) ? document.paths : {};
  for (const [route, pathItem] of Object.entries(paths)) {
    if (!isRecord(pathItem)) {
      continue;
    }
    collectParameterEnums(pathItem.parameters, route, sites);

    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method) || !isRecord(operation)) {
        continue;
      }
      const scope = `${method.toUpperCase()} ${route}`;
      collectParameterEnums(operation.parameters, scope, sites);
      if (isRecord(operation.requestBody)) {
        collectContentEnums(
          operation.requestBody.content,
          `${scope} body`,
          sites
        );
      }

      const responses = isRecord(operation.responses)
        ? operation.responses
        : {};
      for (const [status, response] of Object.entries(responses)) {
        if (!isRecord(response)) {
          continue;
        }
        const responseScope = `${scope} response ${status}`;
        collectContentEnums(response.content, responseScope, sites);
        const headers = isRecord(response.headers) ? response.headers : {};
        for (const [header, definition] of Object.entries(headers)) {
          if (isRecord(definition)) {
            collectSchemaEnums(
              definition.schema,
              `${responseScope} header ${header}`,
              [],
              header,
              sites
            );
          }
        }
      }
    }
  }

  return sites;
};

const countEnums = (value: unknown): number => {
  if (Array.isArray(value)) {
    return value.reduce<number>((total, child) => total + countEnums(child), 0);
  }
  if (!isRecord(value)) {
    return 0;
  }

  return Object.entries(value).reduce<number>(
    (total, [key, child]) =>
      key === 'enum' ? total : total + countEnums(child),
    Array.isArray(value.enum) ? 1 : 0
  );
};

// A media-type enum is named mediaType or lists at least two media types.
// Single-value enums are discriminators of one result type (for example
// BookResult), not lists of accepted media types.
const isMediaTypeEnum = (site: EnumSite) => {
  const values = site.values.filter((value) => value !== null);
  if (values.length < 2) {
    return false;
  }

  const mediaTypeCount = values.filter((value) =>
    MEDIA_TYPE_VALUES.has(value)
  ).length;
  return /mediatype/iu.test(site.name ?? '') || mediaTypeCount >= 2;
};

const findUncoveredEnums = (
  sites: readonly EnumSite[],
  exclusions: ReadonlyMap<string, Exclusion>
) =>
  sites
    .filter(
      (site) =>
        !site.values.includes(MediaType.MANGA) && !exclusions.has(site.location)
    )
    .map((site) => `${site.location} ${JSON.stringify(site.values)}`);

const findStaleExclusions = (
  sites: readonly EnumSite[],
  exclusions: ReadonlyMap<string, Exclusion>
) => {
  const sitesByLocation = new Map(sites.map((site) => [site.location, site]));
  return [...exclusions.keys()].filter((location) => {
    const site = sitesByLocation.get(location);
    return !site || site.values.includes(MediaType.MANGA);
  });
};

describe('OpenAPI media-type enum audit helpers', () => {
  const fixture = {
    components: {
      schemas: {
        Example: {
          type: 'object',
          properties: {
            mediaType: { type: 'string', enum: ['movie', 'other'] },
            kind: { type: 'string', enum: ['book', 'comic'] },
            status: { type: 'string', enum: ['pending', 'book'] },
            entries: {
              type: 'array',
              items: {
                oneOf: [
                  {
                    type: 'object',
                    properties: {
                      mediaType: { type: 'string', enum: ['music', 'book'] },
                    },
                  },
                ],
              },
            },
          },
        },
        BookResult: {
          type: 'object',
          properties: { mediaType: { type: 'string', enum: ['book'] } },
        },
      },
    },
    paths: {
      '/things/{kind}': {
        parameters: [
          {
            name: 'kind',
            in: 'path',
            schema: { type: 'string', enum: ['tv', 'music'] },
          },
        ],
        get: {
          parameters: [
            {
              name: 'mediaType',
              in: 'query',
              schema: { type: 'array', items: { enum: ['all', 'movie'] } },
            },
          ],
          responses: {
            '200': {
              headers: {
                'X-Media-Type': {
                  schema: { type: 'string', enum: ['manga', 'comic'] },
                },
              },
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      results: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            mediaType: { enum: ['movie', 'manga'] },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        post: {
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    mediaType: { type: 'string', enum: ['movie', 'tv', null] },
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  it('finds every enum and selects media-type enums by name or by values', () => {
    const sites = collectEnumSites(fixture);

    assert.equal(sites.length, countEnums(fixture));
    assert.deepEqual(
      sites.filter(isMediaTypeEnum).map((site) => site.location),
      [
        'schema Example mediaType',
        'schema Example kind',
        'schema Example entries[].oneOf[0].mediaType',
        '/things/{kind} path kind',
        'GET /things/{kind} query mediaType[]',
        'GET /things/{kind} response 200 results[].mediaType',
        'GET /things/{kind} response 200 header X-Media-Type',
        'POST /things/{kind} body mediaType',
      ]
    );
  });

  it('reports enums without manga or an exclusion, and stale exclusions', () => {
    const sites = collectEnumSites(fixture).filter(isMediaTypeEnum);
    const exclusions = new Map<string, Exclusion>([
      ['schema Example mediaType', { owner: 'L2', reason: 'Fixture.' }],
      [
        'GET /things/{kind} response 200 results[].mediaType',
        { owner: 'L2', reason: 'Fixture: already lists manga.' },
      ],
      ['schema Missing mediaType', { owner: 'L2', reason: 'Fixture.' }],
    ]);

    assert.deepEqual(findUncoveredEnums(sites, exclusions), [
      'schema Example kind ["book","comic"]',
      'schema Example entries[].oneOf[0].mediaType ["music","book"]',
      '/things/{kind} path kind ["tv","music"]',
      'GET /things/{kind} query mediaType[] ["all","movie"]',
      'POST /things/{kind} body mediaType ["movie","tv",null]',
    ]);
    assert.deepEqual(findStaleExclusions(sites, exclusions), [
      'GET /things/{kind} response 200 results[].mediaType',
      'schema Missing mediaType',
    ]);
  });
});

describe('seerr-api.yml media-type enums', () => {
  const document = loadYaml(
    readFileSync(path.join(process.cwd(), 'seerr-api.yml'), 'utf8')
  ) as Record<string, unknown>;
  const sites = collectEnumSites(document);
  const mediaTypeSites = sites.filter(isMediaTypeEnum);
  const exclusions = new Map(Object.entries(MANGA_ENUM_EXCLUSIONS));

  it('walks every enum in the document', () => {
    assert.equal(sites.length, countEnums(document));
  });

  it('gives every media-type enum a unique location', () => {
    const locations = mediaTypeSites.map((site) => site.location);
    assert.equal(new Set(locations).size, locations.length);
  });

  it('lists manga in every media-type enum or records a reviewed exclusion', () => {
    assert.deepEqual(
      findUncoveredEnums(mediaTypeSites, exclusions),
      [],
      'Add manga to these enums, or add a reviewed exclusion with a reason and an owner.'
    );
  });

  it('keeps no exclusion for a missing enum or one that now lists manga', () => {
    assert.deepEqual(findStaleExclusions(mediaTypeSites, exclusions), []);
  });

  it('records a reason and an owner for every exclusion', () => {
    for (const [location, exclusion] of exclusions) {
      assert.match(exclusion.owner, OWNER_PATTERN, location);
      assert.ok(exclusion.reason.trim().length > 0, location);
    }
  });
});
