import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makePdf } from './make-pdf.ts';
import { extractPdfText } from '../../src/extract/pdf-text.ts';

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
