import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import postcss from 'postcss';

const css = readFileSync(new URL('./globals.css', import.meta.url), 'utf8');
const palette = readFileSync(
  new URL('../components/MediaDetails/subjectTagStyle.ts', import.meta.url),
  'utf8'
);
const tones = [...palette.matchAll(/^\s*'([a-z]+)',/gm)].map(
  (match) => match[1]
);

test('every tag tone has one shared CSS owner for legacy and semantic consumers', () => {
  const root = postcss.parse(css);
  const owned = (selector) => {
    const rules = [];
    root.walkRules((rule) => {
      if (rule.selectors.includes(selector)) rules.push(rule);
    });
    assert.equal(rules.length, 1, `${selector} has one owner`);
    assert.ok(
      !rules[0].nodes.some(
        (node) => node.type === 'atrule' && node.name === 'apply'
      )
    );
    return new Map(
      rules[0].nodes
        .filter((node) => node.type === 'decl')
        .map((node) => [node.prop, node.value])
    );
  };
  assert.equal(tones.length, 12);
  for (const tone of tones) {
    const semantic = `.subject-tag[data-tone='${tone}']`;
    const legacy = `.subject-tag-${tone}`;
    for (const state of ['', ':hover', ':active']) {
      const owner = owned(`${semantic}${state}`);
      assert.deepEqual(
        owner,
        owned(`${legacy}${state}`),
        `${tone} legacy and semantic states agree`
      );
      assert.ok(
        owner.get('background-color'),
        `${tone}${state}: authored surface`
      );
      if (!state) {
        assert.ok(owner.get('border-color'));
        assert.ok(owner.get('color'));
        assert.notEqual(owner.get('color'), 'white');
      }
    }
  }
  assert.match(palette, /export const subjectTagTone/);
  assert.match(palette, /subject-tag-\$\{subjectTagTone\(index\)\}/);
});

test('tag consumers choose shared tone metadata rather than local presentation utilities', () => {
  for (const file of [
    'MovieDetails/MovieDetailsLayout.tsx',
    'TvDetails/SeriesDetailsLayout.tsx',
    'BookDetails/BookDetailsLayout.tsx',
    'MusicDetails/MusicDetailsLayout.tsx',
    'CollectionDetails/CollectionMetadataDisclosures.tsx',
  ]) {
    const source = readFileSync(
      new URL(`../components/${file}`, import.meta.url),
      'utf8'
    );
    assert.ok(
      /className=\{subjectTagClassName\(index\)\}/.test(source) ||
        /className="compact-control subject-tag"\s+data-tone=\{subjectTagTone\(index\)\}/.test(
          source
        ),
      file
    );
    // Inspect this asset role, not unrelated utilities elsewhere on its page.
    for (const match of source.matchAll(
      /className="([^"]*\bsubject-tag\b[^"]*)"/g
    )) {
      assert.doesNotMatch(match[1], /(?:border|bg|text)-[a-z]+-\d/, file);
    }
  }
});
