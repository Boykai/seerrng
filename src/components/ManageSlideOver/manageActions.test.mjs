import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
test('Manage icons, counts and disclosure share the global controls', () => {
  const source = read('./ManageMediaActions.tsx');
  assert.match(source, /<ArchiveBoxXMarkIcon aria-hidden="true" \/>/);
  assert.match(source, /<NoSymbolIcon aria-hidden="true" \/>/);
  assert.match(source, /<TrashIcon aria-hidden="true" \/>/);
  assert.match(
    source,
    /<EyeIcon aria-hidden="true" \/>\s*\{intl.formatMessage\(messages.block\)/
  );
  assert.equal(
    (source.match(/className="button-count-badge"/g) ?? []).length,
    2
  );
  assert.doesNotMatch(source, /Issues \(\{count/);
  assert.match(source, /className="disclosure-chevron"/);
  assert.match(
    read('../MediaDetails/DetailDisclosureButton.tsx'),
    /className="disclosure-chevron"/
  );
  assert.match(
    read('../Requests/destructiveActions.tsx'),
    /<TrashIcon aria-hidden="true" \/>/
  );
});
test('inline discussion follows the details without an extra bordered surface', () => {
  const source = read('../IssueList/IssueItem/index.tsx');
  const css = read('../../styles/globals.css');
  assert.match(
    source,
    /className="issue-discussion-content card-spacing-before"/
  );
  assert.doesNotMatch(source, /issue-discussion-inset|messages.viewissue/);
  const rule = css.match(/\.issue-discussion-content\s*\{([^}]*)\}/s)?.[1];
  assert.ok(rule);
  assert.doesNotMatch(rule, /border|background|padding/);
});
test('blocklist buttons use confirmed success while parent refresh catches up', () => {
  const source = read('./ManageMediaActions.tsx');
  assert.match(
    source,
    /await addManageBlocklist[^;]+;\s*await setBlocklisted\(true\)/
  );
  assert.match(
    source,
    /await removeManageBlocklist[^;]+;\s*await setBlocklisted\(false\)/
  );
  assert.doesNotMatch(source, /confirmedBlocklist/);
  assert.match(source, /useTitleBlocklist\(/);
  for (const type of ['Movie', 'Tv', 'Book', 'Music']) {
    const details = read(`../${type}Details/index.tsx`);
    assert.match(details, /useTitleBlocklist\(/);
    assert.match(details, /await setBlocklisted\(true\)/);
  }
  assert.match(source, /const canUnblock =[\s\S]*?isBlocklisted/);
  assert.match(source, /const canBlock =[\s\S]*?!isBlocklisted/);
});
test('confirmation title cards use media title/year rather than service IDs', () => {
  const source = read('./ManageMediaActions.tsx');
  assert.match(source, /titleWithYear: '\{title\} \(\{year\}\)'/);
  assert.match(source, /removeAllTitle: 'Delete From Library\?'/);
  assert.match(source, /blockConfirm: 'Blocklist Title\?'/);
  assert.match(
    source,
    /\{displayTitle\} — \{copy.service\} — \{copy.quality\}/
  );
  assert.doesNotMatch(source, /#\{copy.externalId\}/);
  assert.match(
    source,
    /<div className="card-stack">\s*<p className="refreshed-inset-surface request-action-explanation">\s*\{displayTitle\}/
  );
  assert.doesNotMatch(source, /issues\}\} for \{title\}/);
  assert.match(
    read('./index.tsx'),
    /data\.releaseDate\s*:\s*data\.firstAirDate/
  );
  assert.match(
    read('../ExternalMediaManageSlideOver/index.tsx'),
    /firstPublishYear/
  );
});
test('issue navigation shares the same green color rule as Previous and Next controls', () => {
  const css = read('../../styles/globals.css');
  assert.match(css, /\.app-button-success\s*\{\s*@apply border-green-500/);
  assert.match(
    read('./ManageMediaActions.tsx'),
    /buttonType="success"\s*disabled=\{!canViewIssues/
  );
  assert.match(read('../Slider/index.tsx'), /buttonType="success"/);
});
test('Manage uses yellow for closing issues and red for destructive confirmations', () => {
  const source = read('./ManageMediaActions.tsx');
  assert.match(source, /buttonType="warning"[\s\S]*?messages.closeDescription/);
  assert.match(source, /buttonType="danger"[\s\S]*?messages.deleteDescription/);
  assert.match(source, /action === 'closeIssues' \? 'warning' : 'danger'/);
  assert.match(
    source,
    /disabled=\{busy \|\| !!libraryError \|\| !targets.length\}/
  );
});

test('library deletion shares red styling and disabled Manage issue actions keep semantic colors', () => {
  const css = read('../../styles/globals.css');
  assert.match(
    css,
    /\.app-button-danger,\s*\.request-destructive-action-delete,\s*\.request-destructive-action-remove\s*\{\s*@apply border-red-500/
  );
  assert.doesNotMatch(
    css,
    /\.manage-advanced-sections \.app-button-\w+:disabled/
  );
  assert.match(
    read('./ManageMediaActions.tsx'),
    /data-testid="manage-advanced-sections" className="card-stack"/
  );
  const action = read('../Requests/destructiveActions.tsx');
  assert.match(action, /remove: 'Delete From Library'/);
  assert.match(action, /disabled=\{disabled \|\| busy\}/);
});

test('disabled View Issues shares normal disabled styling without text or icon shadows', () => {
  const css = read('../../styles/globals.css');
  assert.match(css, /button\.app-button:disabled\s*\{\s*text-shadow: none;/);
  assert.match(css, /button\.app-button:disabled svg\s*\{\s*filter: none;/);
  const base = css.match(/\.app-button\s*\{([^}]*)\}/s)?.[1];
  assert.match(base, /disabled:opacity-60/);
  assert.doesNotMatch(base, /disabled:brightness|disabled:grayscale/);
});

test('English wording uses the current catalog instead of a preserved state snapshot', () => {
  const app = read('../../pages/_app.tsx');
  assert.match(
    app,
    /messages=\{currentLocale === 'en' \? enMessages : loadedMessages\}/
  );
});

for (const file of [
  './index.tsx',
  '../ExternalMediaManageSlideOver/index.tsx',
]) {
  test(`${file} has only shared destructive actions and no forced availability`, () => {
    const source = read(file);
    assert.match(source, /<ManageMediaActions/);
    assert.doesNotMatch(
      source,
      /markAvailable|deleteMediaFile|deleteMedia\s*=|ConfirmButton|manageModalClearMedia|\/available/
    );
    assert.match(read('./ManageMediaActions.tsx'), /buttonType="warning"/);
    assert.doesNotMatch(source, /openIssues.map|<IssueItem/);
    assert.doesNotMatch(source, /label: 'Requests'/);
    assert.doesNotMatch(
      source,
      /label: intl.formatMessage\(messages.manageModalIssues\)/
    );
    assert.doesNotMatch(source, /manageModalAdvanced/);
    assert.match(source, /hideDeleteAction/);
    assert.match(source, /backgroundClickable=\{!confirmationOpen\}/);
    assert.match(source, /onDialogChange=\{setConfirmationOpen\}/);
    assert.match(source, /contentClass="manage-dialog-content"/);
    assert.match(source, /<IssueMediaSummary/);
  });
}
test('global Manage spacing separates 8px padding from gaps and the issue action is not clipped', () => {
  const css = read('../../styles/globals.css');
  assert.match(css, /--card-spacing: 8px/);
  assert.match(css, /padding: var\(--main-card-padding\) !important/);
  assert.match(css, /gap: var\(--card-spacing\)/);
  assert.match(css, /\.issue-action-value\s*\{[^}]*overflow: visible/s);
});

test('Manage buttons no longer show a red issue dot for any media type', () => {
  for (const type of ['Movie', 'Tv', 'Book', 'Music']) {
    assert.doesNotMatch(read(`../${type}Details/index.tsx`), /animate-ping/);
  }
});
test('request screen consumes the same buttons, confirmations and destructive endpoints', () => {
  const source = read('../Requests/index.tsx');
  assert.match(source, /<RequestActionButton/);
  assert.match(source, /<RequestActionConfirmation/);
  assert.match(source, /await deleteRequestStatus\(requestId\)/);
  assert.match(source, /await deleteLibraryMedia\(selection\)/);
});
