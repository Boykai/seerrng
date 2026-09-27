#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));
const base =
  'https://raw.githubusercontent.com/snapetech/seerrng/main/packaging/unraid';
const escapeXml = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const port = (name, target, value = target) => ({
  name,
  target: String(target),
  value: String(value),
  type: 'Port',
  mode: 'tcp',
  description: `${name} for the standalone web interface.`,
});
const mount = (name, target, value, description) => ({
  name,
  target,
  value,
  type: 'Path',
  mode: 'rw',
  description,
});
const variable = (name, value, description, options = {}) => ({
  name,
  target: name,
  value,
  type: 'Variable',
  mode: '',
  description,
  ...options,
});
const commonVariables = [
  variable('PUID', '99', 'User ID for files created by this service.'),
  variable('PGID', '100', 'Group ID for files created by this service.'),
  variable('TZ', 'Etc/UTC', 'Time zone used by this service.'),
];

const templates = [
  {
    file: 'bookshelfng.xml',
    name: 'BookshelfNG-SeerrNG',
    image: 'ghcr.io/snapetech/bookshelfng:hardcover',
    registry: 'https://ghcr.io/snapetech/bookshelfng',
    project: 'https://github.com/snapetech/bookshelfng',
    icon: 'https://raw.githubusercontent.com/snapetech/bookshelfng/main/Logo/512.png',
    port: 8787,
    category: 'MediaApp:Books',
    overview:
      'Standalone NG fork of Bookshelf for ebook and audiobook management, with optional SeerrNG integration. One instance can handle both formats.',
    description:
      'BookshelfNG is a complete standalone library and acquisition app; SeerrNG is optional. This Snapetech NG fork supplies the book contract used by SeerrNG. The Hardcover image needs a personal Hardcover API token for native metadata. Add it in HARDCOVER_AUTH or in BookshelfNG settings. One instance can manage both ebooks and audiobooks; point both SeerrNG service entries at this instance when using both formats. Do not attach an existing softcover or Readarr database to the Hardcover image without migration.',
    terms: 'bookshelfng bookshelf readarr hardcover ebook audiobook seerrng',
    configs: [
      port('Web UI Port', 8787),
      mount(
        'Appdata',
        '/config',
        '/mnt/user/appdata/seerrng-bookshelfng',
        'Persistent BookshelfNG database, settings, and logs.'
      ),
      mount(
        'Media',
        '/data',
        '/mnt/user/media',
        'Ebook and audiobook library root.'
      ),
      mount(
        'Downloads',
        '/download',
        '/mnt/user/downloads',
        'Downloads shared with the configured download client.'
      ),
      ...commonVariables,
      variable(
        'HARDCOVER',
        'true',
        'Enable Hardcover metadata for this image.',
        { display: 'advanced' }
      ),
      variable(
        'HARDCOVER_NATIVE',
        'true',
        'Use native Hardcover metadata access.',
        { display: 'advanced' }
      ),
      variable(
        'HARDCOVER_AUTH',
        '',
        'Personal Hardcover API token, including the Bearer prefix. Can also be entered in BookshelfNG settings.',
        { mask: 'true' }
      ),
    ],
  },
  {
    file: 'romarrng.xml',
    name: 'ROMarrNG-SeerrNG',
    image: 'ghcr.io/snapetech/romarrng:latest',
    registry: 'https://ghcr.io/snapetech/romarrng',
    project: 'https://github.com/snapetech/ROMarrNG',
    port: 6868,
    category: 'MediaApp:Other',
    overview:
      'Standalone NG fork of ROMarr for ROM discovery and acquisition, with optional SeerrNG integration.',
    description:
      'ROMarrNG is a complete standalone ROM manager; SeerrNG is optional. This Snapetech NG fork includes SeerrNG request and library APIs. The default folder library uses the mapped /roms path and needs no separate library server. Open ROMarrNG to set its password, indexers, and download client, then configure its API key in SeerrNG if desired.',
    terms: 'romarrng romarr rom emulation game seerrng',
    configs: [
      port('Web UI Port', 6868),
      mount(
        'Appdata',
        '/config',
        '/mnt/user/appdata/seerrng-romarrng',
        'Persistent ROMarrNG settings and database.'
      ),
      mount(
        'ROM Library',
        '/roms',
        '/mnt/user/media/roms',
        'ROM library root.'
      ),
      mount(
        'Downloads',
        '/downloads',
        '/mnt/user/downloads',
        'Downloads shared with the configured download client.'
      ),
      ...commonVariables,
      variable(
        'LIBRARY_KIND',
        'folder',
        'Use the mapped ROM folder without an external library server.'
      ),
      variable(
        'LIBRARY_PATH',
        '/roms',
        'ROM library path inside the container.'
      ),
    ],
  },
  {
    file: 'questarrng.xml',
    name: 'QuestarrNG-SeerrNG',
    image: 'ghcr.io/snapetech/questarrng:latest',
    registry: 'https://ghcr.io/snapetech/questarrng',
    project: 'https://github.com/snapetech/QuestarrNG',
    icon: 'https://raw.githubusercontent.com/snapetech/QuestarrNG/main/images/Questarr_icon.png',
    port: 5000,
    category: 'MediaApp:Other',
    overview:
      'Standalone NG fork of Questarr for PC game discovery and acquisition, with optional SeerrNG integration.',
    description:
      'QuestarrNG runs independently for PC game collection and downloads; SeerrNG is optional. This Snapetech NG fork includes the SeerrNG catalog, request, and library API contract that the upstream Questarr listing lacks. Configure QuestarrNG and its download client first, then enter its API key in SeerrNG if desired.',
    terms: 'questarrng questarr pc game igdb seerrng',
    configs: [
      port('Web UI Port', 5000),
      mount(
        'Appdata',
        '/app/data',
        '/mnt/user/appdata/seerrng-questarrng',
        'Persistent QuestarrNG database and settings.'
      ),
      mount(
        'Game Library',
        '/data',
        '/mnt/user/media/games',
        'Game library root.'
      ),
      mount(
        'Downloads',
        '/downloads',
        '/mnt/user/downloads',
        'Downloads shared with the configured download client.'
      ),
      ...commonVariables,
      variable('PORT', '5000', 'Internal QuestarrNG web port.', {
        display: 'advanced',
      }),
    ],
  },
];

const renderConfig = (config) => {
  const attrs = {
    Name: config.name,
    Target: config.target,
    Default: config.value,
    Mode: config.mode,
    Description: config.description,
    Type: config.type,
    Display: config.display ?? 'always',
    Required: config.required ?? 'false',
    Mask: config.mask ?? 'false',
  };
  return `  <Config ${Object.entries(attrs)
    .map(([key, value]) => `${key}="${escapeXml(value)}"`)
    .join(' ')}>${escapeXml(config.value)}</Config>`;
};

const renderTemplate = (template) => {
  const tag = (name, value) =>
    value ? `  <${name}>${escapeXml(value)}</${name}>\n` : '';
  return `<?xml version="1.0"?>\n<Container version="2">\n${tag('Name', template.name)}${tag('Repository', template.image)}${tag('Registry', template.registry)}${tag('Network', 'bridge')}${tag('Shell', 'sh')}${tag('Privileged', 'false')}${tag('Icon', template.icon)}${tag('WebUI', `http://[IP]:[PORT:${template.port}]/`)}${tag('Overview', template.overview)}${tag('Description', template.description)}${tag('Support', 'https://github.com/snapetech/seerrng/issues')}${tag('Project', template.project)}${tag('TemplateURL', `${base}/${template.file}`)}${tag('ReadMe', 'https://github.com/snapetech/seerrng/blob/main/docs/getting-started/third-parties/unraid.mdx')}${tag('Category', template.category)}${tag('ExtraSearchTerms', template.terms)}${tag('Changes', 'Standalone optional companion template for SeerrNG.')}${tag('Requires', 'Docker and persistent appdata. Configure this app independently before connecting it to SeerrNG.')}${tag('ExtraParams', '--restart=unless-stopped')}\n${template.configs.map(renderConfig).join('\n')}\n</Container>\n`;
};

const check = process.argv.includes('--check');
for (const template of templates) {
  const file = path.join(directory, template.file);
  const content = renderTemplate(template);
  if (check) {
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== content) {
      console.error(`${template.file} is out of date.`);
      process.exitCode = 1;
    }
  } else {
    fs.writeFileSync(file, content);
  }
}
