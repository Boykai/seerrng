import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
const read = (file) => readFileSync(new URL(file, import.meta.url), 'utf8');
for (const [file, media, label] of [
  ['MovieDetails/MovieDetailsLayout', 'movie', 'movieDetails'],
  ['TvDetails/SeriesDetailsLayout', 'tv', 'seriesDetails'],
  ['BookDetails/BookDetailsLayout', 'book', 'bookDetails'],
  ['MusicDetails/MusicDetailsLayout', 'music', 'albumDetails'],
]) {
  test(
    media +
      ' details use the shared disclosure button, pin and controlled card',
    () => {
      const source = read('../components/' + file + '.tsx');
      assert.match(source, /setShowDetails\(pins\.details\)/);
      assert.match(source, /\[pins\.details, data\.id\]/);
      assert.ok(
        source.includes('label={intl.formatMessage(messages.' + label + ')}')
      );
      assert.match(source, /pinned=\{pins\.details\}/);
      assert.match(source, /togglePinned\('details'\)/);
      assert.ok(source.includes('controls="' + media + '-additional-details"'));
      assert.ok(source.includes('id="' + media + '-additional-details"'));
      assert.match(source, /\{showDetails && \(/);
      assert.match(source, /className="media-detail-disclosure-row"/);
    }
  );
}
