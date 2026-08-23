import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makePdf } from './make-pdf.ts';
import { extractPdfText } from '../../src/extract/pdf-text.ts';

test('pins the gotcha: a long unwrapped line is clipped by pdf.js extraction', async () => {
  // makePdf draws each array entry as one unbroken Tj run; pdf.js silently
  // drops text past roughly the page's printable width (font-metric
  // dependent, ~100 proportional-width chars). Fixture authors must wrap
  // long lines themselves (see generate-fixtures.ts). This test pins the
  // limitation so a future fixture doesn't rediscover it as a mystery.
  const dir = await mkdtemp(join(tmpdir(), 'make-pdf-clip-'));
  const path = join(dir, 'clip.pdf');
  const longLine = `${'Considered Medically Necessary when criteria in the applicable policy statements are met '.repeat(2)}END_MARKER`;
  await writeFile(path, makePdf([[longLine]]));

  const { pages } = await extractPdfText(path);
  assert.doesNotMatch(pages[0] ?? '', /END_MARKER/);
});

test('makePdf output round-trips through extractPdfText', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'make-pdf-'));
  const path = join(dir, 'sample.pdf');
  await writeFile(path, makePdf([
    ['Local Coverage Determination (LCD)', 'First page line.'],
    ['Second page line.'],
  ]));

  const { pages, totalPages } = await extractPdfText(path);
  assert.equal(totalPages, 2);
  assert.match(pages[0] ?? '', /Local Coverage Determination \(LCD\)/);
  assert.match(pages[0] ?? '', /First page line\./);
  assert.match(pages[1] ?? '', /Second page line\./);
});
