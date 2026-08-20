import test from 'node:test';
import assert from 'node:assert/strict';

import { collapseRepeatedRuns, extractPdfText } from './pdf-text.ts';

test('throws an actionable error naming the PDF that is missing', async () => {
  await assert.rejects(
    () => extractPdfText('fixtures/L00000.pdf'),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /fixtures\/L00000\.pdf/);
      assert.match(error.message, /place/i);
      return true;
    },
  );
});

// test/fixtures/two-page-policy.pdf is a 978-byte generated PDF: page 1 holds
// "Indications", page 2 holds "Documentation Requirements", each with one line
// of body text. It exists so this adapter can be tested without a real LCD.
test('extracts text from every page of a PDF', async () => {
  const { pages, totalPages, text } = await extractPdfText('test/fixtures/two-page-policy.pdf');

  assert.equal(totalPages, 2);
  assert.equal(pages.length, 2);
  assert.match(pages[0] ?? '', /Indications/);
  assert.match(pages[0] ?? '', /documented diagnosis/);
  assert.match(pages[1] ?? '', /Documentation Requirements/);
  assert.match(text, /Indications[\s\S]*Documentation Requirements/);
});

test('collapses a line that is one substring consecutively repeated', () => {
  const text = [
    'Coding GuidelinesCoding GuidelinesCoding Guidelines',
    'A normal line stays intact.',
  ].join('\n');

  assert.equal(
    collapseRepeatedRuns(text),
    ['Coding Guidelines', 'A normal line stays intact.'].join('\n'),
  );
});

test('does not alter a line that only coincidentally repeats a short word', () => {
  const text = 'The device must be used as directed as directed by the physician.';

  assert.equal(collapseRepeatedRuns(text), text);
});
