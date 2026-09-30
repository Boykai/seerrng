import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('./globals.css', import.meta.url), 'utf8');
const requestRule = css.match(/\.format-request-control\s*\{([^}]+)\}/)?.[1];
const component = (path) =>
  readFileSync(new URL(`../components/${path}`, import.meta.url), 'utf8');

test('segmented Request uses the shared action height, not a fixed size', () => {
  assert.ok(requestRule);
  for (const property of ['height', 'min-height', 'max-height']) {
    assert.ok(
      requestRule.includes(`${property}: var(--action-control-height);`)
    );
  }
  assert.match(requestRule, /box-sizing: border-box;/);
  assert.doesNotMatch(requestRule, /\b(?:h|min-h|max-h)-\S+/);
});

test('Request preserves its typography, color and border styling', () => {
  for (const utility of [
    'text-xs',
    'font-medium',
    'text-green-200',
    'border-green-500/80',
    'bg-green-950/35',
    'rounded-md',
    'items-stretch',
  ]) {
    assert.ok(requestRule?.includes(utility));
  }
});

test('action buttons fit a 16px detail row without shrinking their text', () => {
  assert.match(css, /--action-control-height: 1rem;/);
  assert.match(css, /--action-control-padding-x: 7px;/);
  assert.match(css, /--compact-button-padding-x: 7px;/);
  assert.match(
    css,
    /padding-inline: var\(--action-control-padding-x\) !important/
  );
  assert.match(
    css,
    /padding-inline: var\(--compact-button-padding-x\) !important/
  );
  assert.match(
    css,
    /\.issue-action-value\s*\{[^}]*display: flex;[^}]*align-items: center;/s
  );
  assert.match(css, /\.button-sm\s*\{[^}]*text-xs/s);
});

test('form input and dropdown control heights remain 20px', () => {
  assert.match(css, /--compact-control-height: 1\.25rem;/);
  assert.match(
    css,
    /\.compact-control:is\(button, a\):not\(\[aria-haspopup\]\):not\(\[role='combobox'\]\)/
  );
  assert.match(
    css,
    /\.app-button\[aria-haspopup\]:not\(\.playback-dropdown-trigger\),[\s\S]*?height: var\(--compact-control-height\) !important;/
  );
});

test('poster badges keep the shared compact poster geometry', () => {
  assert.match(css, /--poster-control-height: 1rem;/);
  assert.match(css, /--poster-control-padding-x: 4px;/);
  assert.match(css, /--poster-control-gap: 0\.125rem;/);
  assert.match(
    css,
    /\.poster-control\s*\{[^}]*rounded-md[^}]*height: var\(--action-control-height\);[^}]*padding-inline: var\(--action-control-padding-x\);[^}]*column-gap: var\(--poster-control-gap\);/s
  );
  assert.match(
    css,
    /\.poster-control \.watched-status-logo\s*\{[^}]*width: auto;[^}]*height: var\(--poster-control-content-height\);/s
  );
  for (const path of [
    'Common/MediaTypeBadge/index.tsx',
    'Common/BookFormatBadge/index.tsx',
    'Common/StatusBadgeMini/index.tsx',
    'Association/AssociationBadge.tsx',
  ]) {
    assert.match(component(path), /poster-control/, path);
  }
  assert.match(
    component('Association/AssociationBadge.tsx'),
    /poster-control poster-control-association app-control-shadow-exempt/
  );
  assert.match(
    component('TitleCard/index.tsx'),
    /poster-control poster-control-blocklist app-control-shadow-exempt/
  );
});

test('poster availability and watched badges share a translucent poster surface', () => {
  assert.match(
    css,
    /\.poster-control\s*\{[^}]*background-color: transparent;/s
  );
  assert.match(css, /--poster-control-background-opacity: 0\.7;/);
  assert.match(
    css,
    /\.poster-control\.poster-control-available\s*\{[^}]*background-color: hsl\([^)]*var\(--poster-control-background-opacity\)/s
  );
  assert.doesNotMatch(
    css.match(/\.watched-status-badge\s*\{([^}]+)\}/)?.[1] ?? '',
    /\bbg-black(?!\/35)\b/
  );
  assert.match(
    css.match(/\.watched-status-badge\s*\{([^}]+)\}/)?.[1] ?? '',
    /background-color: rgb\(0 0 0 \/ var\(--poster-control-background-opacity\)\)/
  );
  assert.match(
    component('Common/WatchedBadge/index.tsx'),
    /poster-control watched-status-badge/
  );
  assert.match(
    component('Common/StatusBadgeMini/index.tsx'),
    /poster-control-available/
  );
  for (const path of [
    'Common/MediaTypeBadge/index.tsx',
    'Common/BookFormatBadge/index.tsx',
    'Association/AssociationBadge.tsx',
  ]) {
    assert.match(
      component(path),
      /poster-control-(?:type|book-format|association)/
    );
  }
});

test('request-card availability uses the standard control corner radius', () => {
  assert.match(
    css,
    /\.app-control-standard-radius\s*\{[^}]*border-radius: var\(--control-corner-radius\);/s
  );
  const requests = component('Requests/index.tsx');
  assert.match(requests, /app-control-standard-radius/);
  assert.doesNotMatch(
    requests.match(/className=\{`app-control-standard-radius[^`]+`\}/)?.[0] ??
      '',
    /rounded-full/
  );
});

test('Blocklist source and Issues status badges use the standard radius', () => {
  assert.match(
    component('BlocklistedTagsBadge/index.tsx'),
    /shape=\{compact \? 'standard' : 'pill'\}/
  );
  assert.match(component('IssueList/IssueItem/index.tsx'), /shape="standard"/);
});

test('page buttons and filters retain their approved opacity levels', () => {
  const rule = (selector) => {
    const start = css.indexOf(`\n  ${selector} {`);
    const combinedStart = css.indexOf(`\n  ${selector},`);
    const matchStart = start >= 0 ? start : combinedStart;
    if (matchStart < 0) {
      return '';
    }
    const open = css.indexOf('{', matchStart);
    return css.slice(open + 1, css.indexOf('}', open));
  };

  for (const selector of [
    '.app-button-manage',
    '.app-button-bulk-request',
    '.app-button-ghost',
  ]) {
    const declaration = rule(selector);
    assert.match(declaration, /(?:\/ 0\.55\)|bg-[\w-]+\/55)/, selector);
  }

  assert.match(rule('.app-button-playback'), /\/ 0\.7\)/);

  for (const selector of [
    '.app-filter-button-idle',
    '.discover-filter-control',
  ]) {
    assert.match(rule(selector), /\/ 0\.35\)/, selector);
    assert.match(rule(`${selector}:hover`), /\/ 0\.55\)/, selector);
    assert.match(rule(`${selector}:active`), /\/ 0\.7\)/, selector);
  }

  assert.match(rule('.app-filter-button-active'), /bg-indigo-500\b/);
  assert.match(
    rule('.watched-status-badge'),
    /var\(--poster-control-background-opacity\)/
  );
});

test('Episode Queue keeps its dropdown label and compact generated-request badge', () => {
  for (const path of [
    'Requests/index.tsx',
    'RequestList/RequestItem/index.tsx',
  ]) {
    const source = component(path);
    assert.match(source, /watchAheadEpisodeBadge: 'Auto-Queued'/, path);
    assert.match(source, /Automatically requested by the Episode Queue/, path);
  }
  assert.match(
    component('Requests/index.tsx'),
    /watchAheadLabel: 'Episode Queue'/
  );
  assert.match(component('Requests/index.tsx'), /RequestListboxControl/);
});

test('segmented filters keep the outward focus ring', () => {
  for (const path of [
    'Blocklist/index.tsx',
    'Discover/BookFormatTabs/index.tsx',
    'Discover/DiscoverMediaTabs.tsx',
    'Discover/MediaFilterOption.tsx',
    'IssueList/index.tsx',
    'Requests/index.tsx',
    'Search/index.tsx',
  ]) {
    const source = component(path);
    assert.match(source, /app-filter-segment-focus/, path);
    assert.doesNotMatch(source, /focus:ring-inset/, path);
  }
});
