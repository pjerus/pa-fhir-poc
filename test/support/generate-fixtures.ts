/**
 * One-shot generator for the committed test-fixture PDFs. Run manually after
 * changing fixture content:  node test/support/generate-fixtures.ts
 * The PDFs are committed; this script is NOT part of npm test.
 */
import { writeFile } from 'node:fs/promises';

import { makePdf } from './make-pdf.ts';

// MAC-shaped: page-1 banner is the dialect sniff target; the bare
// "two-page-policy" token is what the MAC id cross-check finds.
const MAC_PAGES: ReadonlyArray<readonly string[]> = [
  [
    'Local Coverage Determination (LCD)',
    'Sample Policy',
    'two-page-policy',
    'Indications',
    'The patient must have a documented diagnosis.',
  ],
  ['Documentation Requirements', 'The treating order must be retained.'],
];

// Cigna-shaped: banner + policy-number field on page 1; Coverage Policy
// criteria, stance-stratified Coding Information, and noise sections that
// must be bounded out. Ids and codes are synthetic (CIGNA-0101, 12345…).
const CIGNA_PAGES: ReadonlyArray<readonly string[]> = [
  [
    'Medical Coverage Policy',
    'Effective Date 1/1/2026',
    'Coverage Policy Number 0101',
    'Table of Contents',
    'Overview ................................ 2',
    'Coverage Policy ......................... 2',
    'INSTRUCTIONS FOR USE',
    'Coverage determinations require consideration of the applicable plan document.',
  ],
  [
    'Overview',
    'This Coverage Policy addresses widget therapy.',
    'Coverage Policy',
    'Widget therapy is considered medically necessary when ALL of the following are met:',
    'documented diagnosis of testitis',
    'documentation that demonstrates conservative therapy failure',
    'Widget removal as a stand-alone procedure is considered not medically necessary.',
  ],
  [
    'Coding Information',
    'Notes:',
    // Wrapped: makePdf draws one unbroken Tj per array entry, and a single
    // line past ~100 proportional-width characters gets silently clipped by
    // pdf.js's text extraction. Keep long lines split like this one.
    'Considered Medically Necessary when criteria in the applicable policy statements listed',
    'above are met:',
    'CPT Codes Description',
    '12345 Widget implantation',
    'A1234 Widget device',
    'Considered Not Medically Necessary when used to report widget removal as a stand-alone procedure:',
    '23456 Widget removal',
    'Considered Experimental/Investigational/Unproven for the treatment of testitis:',
    '34567 Widget ablation',
    'General Background',
    'Literature review noise that must not bleed into requirements.',
    'References',
    'Revision Details',
    'Annual review 1/1/2026',
  ],
];

await writeFile('test/fixtures/two-page-policy.pdf', makePdf(MAC_PAGES));
await writeFile('test/fixtures/CIGNA-0101.pdf', makePdf(CIGNA_PAGES));
process.stderr.write('regenerated test/fixtures/two-page-policy.pdf and test/fixtures/CIGNA-0101.pdf\n');
