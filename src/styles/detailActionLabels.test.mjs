import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

for (const page of [
  'MovieDetails',
  'TvDetails',
  'BookDetails',
  'MusicDetails',
]) {
  test(`${page} labels Manage and Report Issue but keeps Blocklist icon-only`, () => {
    const source = readFileSync(
      new URL(`../components/${page}/index.tsx`, import.meta.url),
      'utf8'
    );
    for (const [type, label] of [
      ['manage', 'manage'],
      ['reportIssue', 'reportIssue'],
    ]) {
      const action = source
        .split(`buttonType="${type}"`)[1]
        ?.split('</Button>')[0];
      assert.ok(action);
      assert.ok(
        action.includes(
          `<span>{intl.formatMessage(globalMessages.${label})}</span>`
        )
      );
      assert.ok(!action.includes('!mr-0'));
    }
    const blocklist = source
      .split('buttonType="blocklist"')[1]
      ?.split('</Button>')[0];
    assert.ok(blocklist?.includes('<EyeSlashIcon />'));
    assert.ok(!blocklist.includes('<span>'));
  });
}
