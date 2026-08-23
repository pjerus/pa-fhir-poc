import test from 'node:test';
import assert from 'node:assert/strict';

import { sniffDialect, sniffPdfDialect } from './index.ts';

const MAC_PAGE1 = ['Local Coverage Determination (LCD)', 'Glucose Things', 'TEST-L1'].join('\n');
const CIGNA_PAGE1 = ['Medical Coverage Policy', 'Effective Date 1/1/2026', 'Coverage Policy Number............. 0101'].join('\n');

test('sniffs the MAC banner', () => {
  assert.equal(sniffDialect(MAC_PAGE1).name, 'mac');
});

test('sniffs the Cigna banner, dot leaders and all', () => {
  assert.equal(sniffDialect(CIGNA_PAGE1).name, 'cigna');
});

test('no banner: throws naming the known dialects', () => {
  assert.throws(() => sniffDialect('Just some PDF.'), /mac.*cigna|cigna.*mac/s);
});

test('both banners: throws as ambiguous', () => {
  assert.throws(() => sniffDialect(`${MAC_PAGE1}\n${CIGNA_PAGE1}`), /ambiguous/i);
});

test('MAC id cross-check: the filename-derived id must appear on page 1', () => {
  const mac = sniffDialect(MAC_PAGE1);
  mac.verifyId('TEST-L1', MAC_PAGE1); // no throw
  assert.throws(() => mac.verifyId('TEST-L2', MAC_PAGE1), /TEST-L2/);
});

test('Cigna id cross-check: CIGNA-<policy number> must match the banner field', () => {
  const cigna = sniffDialect(CIGNA_PAGE1);
  cigna.verifyId('CIGNA-0101', CIGNA_PAGE1); // no throw
  assert.throws(() => cigna.verifyId('CIGNA-0158', CIGNA_PAGE1), /0101/);
  assert.throws(() => cigna.verifyId('0101', CIGNA_PAGE1), /CIGNA-0101/);
});

test('sniffPdfDialect reads page 1 of a real PDF', async () => {
  assert.equal((await sniffPdfDialect('test/fixtures/two-page-policy.pdf')).name, 'mac');
  assert.equal((await sniffPdfDialect('test/fixtures/CIGNA-0101.pdf')).name, 'cigna');
});
