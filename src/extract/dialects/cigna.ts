import type { SectionVocabulary } from '../sections.ts';

/**
 * Cigna "Medical Coverage Policy" documents put all criteria (indications
 * AND limitations, interleaved) under one "Coverage Policy" heading, and
 * carry no documentation-requirements section at all — the resulting
 * `documentation: null` is a faithful finding, not a parse failure.
 *
 * Heading patterns are line-start anchored (`^`) against the head window:
 * the running page footer "Medical Coverage Policy: NNNN" and the page-1
 * banner contain the phrase mid-line and must not open the section. The
 * negative lookahead keeps the page-1 "Coverage Policy Number …" field from
 * opening it either (its dot leaders usually reject it first, but layout
 * extraction is not guaranteed to preserve them).
 * Boundary headings are load-bearing here (unlike MAC): General Background
 * is a literature review that would otherwise flood the criteria body.
 */
export const CIGNA_VOCABULARY: SectionVocabulary = {
  headings: [{ sections: ['indications', 'limitations'], pattern: /^Coverage\s+Policy\b(?!\s+Number)/i }],
  boundaries: [
    /^Overview\b/i,
    /^INSTRUCTIONS\s+FOR\s+USE\b/i,
    /^Coding\s+Information\b/i,
    /^General\s+Background\b/i,
    /^Health\s+Equity\b/i,
    /^References\b/i,
  ],
  terminal: /^Revision\s+Details\b/i,
};
