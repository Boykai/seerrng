import CollectionPage from '@app/pages/collections/[kind]/[id]';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  query: { kind: 'music', id: 'artist-id', view: 'discography' },
  isReady: true,
}));
vi.mock('next/router', () => ({ useRouter: () => state }));
vi.mock('@app/pages/_error', () => ({
  default: () => <div>Not found</div>,
}));
vi.mock('@app/components/CollectionDetails/CuratedCollectionDetails', () => ({
  default: (props: { discographyArtist?: string }) => (
    <main>
      {props.discographyArtist !== undefined ? 'Discography' : 'Collection'}
    </main>
  ),
}));

it('renders discography in the normal page rather than a dialog', () => {
  expect(renderToStaticMarkup(<CollectionPage />)).toBe(
    '<main>Discography</main>'
  );
});

it('keeps normal collections and TV collections unchanged', () => {
  state.query.view = '';
  expect(renderToStaticMarkup(<CollectionPage />)).toBe(
    '<main>Collection</main>'
  );
  state.query.view = 'discography';
  state.query.kind = 'tv';
  expect(renderToStaticMarkup(<CollectionPage />)).toBe(
    '<main>Collection</main>'
  );
  state.query.kind = 'music';
});

it('retains invalid collection routing protection', () => {
  state.query.id = '../invalid';
  expect(renderToStaticMarkup(<CollectionPage />)).toBe('<div>Not found</div>');
  state.query.id = 'artist-id';
});
