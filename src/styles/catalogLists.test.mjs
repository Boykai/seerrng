import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
test('bibliography and discography actions live in the disclosure row, outside primary requests', () => {
  for (const type of ['Book', 'Music']) {
    const source = read(`../components/${type}Details/index.tsx`);
    assert.match(source, /catalogActions=\{catalogActions\}/);
    const primary = source.slice(
      source.indexOf('const primaryActions'),
      source.indexOf('const secondaryActions')
    );
    assert.doesNotMatch(primary, /setShowBulkRequestModal/);
    const layout = read(
      `../components/${type}Details/${type}DetailsLayout.tsx`
    );
    const row = layout.slice(
      layout.indexOf('<div className="media-detail-disclosure-row">')
    );
    assert.ok(row.indexOf('{catalogActions}') < row.indexOf('</div>'));
    assert.match(row, /controls="(?:book|music)-additional-details"/);
  }
});
test('bulk requests and association sections use the same three-card scroll component', () => {
  assert.match(
    read('../components/RequestModal/BulkRequestModal.tsx'),
    /<ThreeItemScroll/
  );
  assert.match(
    read('../components/Association/AssociationWall.tsx'),
    /<ThreeItemScroll/
  );
  const css = read('./globals.css');
  assert.match(css, /\.three-item-scroll\s*\{[^}]*overflow-y: auto/);
  assert.match(
    css,
    /\.three-item-scroll-list\s*\{[^}]*gap: var\(--card-spacing\)/
  );
});
