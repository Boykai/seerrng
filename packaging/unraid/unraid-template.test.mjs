import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { parseStringPromise } from 'xml2js';

const repositoryRoot = path.resolve(import.meta.dirname, '../..');
const templatePath = path.join(repositoryRoot, 'packaging/unraid/seerrng.xml');
const profilePath = path.join(repositoryRoot, 'ca_profile.xml');
const templateUrl =
  'https://raw.githubusercontent.com/snapetech/seerrng/main/packaging/unraid/seerrng.xml';

const readXml = async (filePath) =>
  parseStringPromise(await fs.readFile(filePath, 'utf8'), {
    explicitArray: false,
    trim: true,
  });

const asArray = (value) =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

test('Unraid template exposes the stable image and canonical raw URL', async () => {
  const document = await readXml(templatePath);
  const container = document.Container;

  assert.equal(container.$.version, '2');
  assert.equal(container.Name, 'SeerrNG');
  assert.equal(container.Repository, 'ghcr.io/snapetech/seerrng:latest');
  assert.equal(container.TemplateURL, templateUrl);
  assert.equal(container.WebUI, 'http://[IP]:[PORT:5055]/');
  assert.equal(container.Network, 'bridge');
  assert.equal(container.Privileged, 'false');
  assert.equal(container.License, 'MIT License');
  assert.match(container.Icon, /^https:\/\/raw\.githubusercontent\.com\//u);
  assert.match(
    container.Support,
    /^https:\/\/github\.com\/snapetech\/seerrng\/issues$/u
  );
  assert.match(
    container.Project,
    /^https:\/\/github\.com\/snapetech\/seerrng$/u
  );

  const configs = asArray(container.Config);
  const configByTarget = new Map(
    configs.map((config) => [config.$.Target, config])
  );
  assert.equal(
    configs.length,
    configByTarget.size,
    'Config targets must be unique'
  );
  assert.deepEqual([...configByTarget.keys()].slice(0, 3), [
    '5055',
    '5056',
    '/app/config',
  ]);
  assert.equal(configByTarget.get('5055').$.Type, 'Port');
  assert.equal(configByTarget.get('5056').$.Type, 'Port');
  assert.equal(configByTarget.get('/app/config').$.Type, 'Path');
  assert.equal(
    configByTarget.get('/app/config')._,
    '/mnt/user/appdata/seerrng'
  );
  assert.equal(configByTarget.get('TMDB_API_KEY').$.Mask, 'true');
  assert.equal(configByTarget.get('TMDB_READ_ACCESS_TOKEN').$.Mask, 'true');
  assert.equal(configByTarget.get('METRICS_AUTH_TOKEN').$.Mask, 'true');
});

test('Unraid repository profile has the required public metadata', async () => {
  const document = await readXml(profilePath);
  const profile = document.CommunityApplications;

  assert.ok(profile.Profile.length > 20);
  assert.match(profile.Icon, /^https:\/\/raw\.githubusercontent\.com\//u);
  assert.equal(profile.WebPage, 'https://github.com/snapetech/seerrng');
  assert.equal(profile.Forum, 'https://github.com/snapetech/seerrng/issues');
  assert.equal(profile.Discord, 'https://discord.gg/5PyXBfvS6T');
  assert.equal(profile.DonateLink, 'https://ko-fi.com/snapetech');
  assert.ok(profile.DonateText);
});

test('repository license keeps the canonical MIT header for feed detection', async () => {
  const license = await fs.readFile(
    path.join(repositoryRoot, 'LICENSE'),
    'utf8'
  );

  assert.match(
    license,
    /^MIT License\n\nCopyright \(c\) 2020 sct\n\nPermission is hereby granted/u
  );
});
