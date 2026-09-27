import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('./globals.css', import.meta.url), 'utf8');

test('shared icon-only buttons reserve space without text padding or shrinking', () => {
  const rule = css.match(
    /\.app-button\.app-button-icon-only\s*\{([^}]+)\}/
  )?.[1];
  assert.ok(rule);
  assert.match(rule, /padding: 0 !important;/);
  assert.match(rule, /width: 1\.5rem;/);
  assert.match(rule, /min-width: 1\.5rem;/);
  assert.match(rule, /flex-shrink: 0;/);
  const icon = css.match(
    /\.app-button\.app-button-icon-only svg\s*\{([^}]+)\}/
  )?.[1];
  assert.ok(icon);
  assert.match(icon, /width: var\(--action-control-content-height\);/);
  assert.match(icon, /margin: 0;/);
  assert.match(icon, /flex-shrink: 0;/);
});

test('all media posters opt into shared icon-only geometry with an accessible label', () => {
  const source = readFileSync(
    new URL('../components/TitleCard/index.tsx', import.meta.url),
    'utf8'
  );
  const action = source.split('buttonType="ghost"')[1]?.split('</Button>')[0];
  assert.ok(action);
  assert.match(action, /\biconOnly\b/);
  assert.match(action, /aria-label=/);
  assert.match(action, /<EyeSlashIcon \/>/);
  assert.doesNotMatch(action, /\b(?:h-6|w-6|p-0)\b/);
});
