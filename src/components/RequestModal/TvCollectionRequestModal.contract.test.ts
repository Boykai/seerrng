import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

describe('TV collection request modal transition contract', () => {
  it('provides the transition root required by the shared modal', () => {
    const source = fs.readFileSync(
      path.join(
        process.cwd(),
        'src/components/RequestModal/TvCollectionRequestModal.tsx'
      ),
      'utf8'
    );

    assert.match(source, /import \{ Transition \} from '@headlessui\/react'/);
    assert.match(source, /<Transition show appear>[\s\S]*<Modal/);
    assert.match(source, /<\/Modal>[\s\S]*<\/Transition>/);
  });
});
