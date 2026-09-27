import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('./globals.css', import.meta.url), 'utf8');
const login = readFileSync(
  new URL('../components/Login/index.tsx', import.meta.url),
  'utf8'
);

test('login scopes its original roomy button geometry separately from compact actions', () => {
  assert.match(login, /className="auth-login-page /);
  const rule = css.match(/\.auth-login-page \.app-button\s*\{([^}]+)\}/)?.[1];
  assert.ok(rule);
  for (const declaration of [
    'height: auto;',
    'min-height: 38px;',
    'max-height: none;',
    'padding-block: 8px;',
    'padding-inline: 16px !important;',
    'font-size: 14px;',
    'line-height: 20px;',
  ]) {
    assert.ok(rule.includes(declaration));
  }
  assert.doesNotMatch(rule, /--action-control/);
  assert.match(css, /--action-control-height: 1rem;/);
  assert.match(
    css,
    /\.auth-login-page \.app-button svg\s*\{[^}]*height: 20px;[^}]*max-height: none;/s
  );
});
