import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const rootRequire = createRequire(import.meta.url);

const emailTemplatesPath = rootRequire.resolve('email-templates');
const emailTemplatesRequire = createRequire(emailTemplatesPath);
const i18nPath = emailTemplatesRequire.resolve('@ladjs/i18n');
const i18nRequire = createRequire(i18nPath);
const multimatchPath = i18nRequire.resolve('multimatch');
const multimatchRequire = createRequire(multimatchPath);
const minimatchPath = multimatchRequire.resolve('minimatch');
const minimatchRequire = createRequire(minimatchPath);
const braceExpansionPath = minimatchRequire.resolve('brace-expansion');
const braceExpansionRequire = createRequire(braceExpansionPath);
const braceExpansion = braceExpansionRequire(braceExpansionPath);
const expand =
  braceExpansion.expand ?? braceExpansion.default ?? braceExpansion;

test('production brace expansion handles both known stack-exhaustion inputs', () => {
  assert.equal(typeof expand, 'function');

  const nestedPattern = '{'.repeat(3200) + 'a,b' + '}'.repeat(3200);
  const nestedResults = expand(nestedPattern);
  assert.ok(Array.isArray(nestedResults));

  const commaPartsPattern = '{' + '{a},'.repeat(7000) + 'b}';
  const commaPartsResults = expand(commaPartsPattern);
  assert.equal(commaPartsResults.length, 7001);
});
