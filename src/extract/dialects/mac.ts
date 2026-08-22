import type { SectionVocabulary } from '../sections.ts';

/**
 * The CMS MAC template's section vocabulary — the exact patterns that were
 * hardcoded in sections.ts before the dialect seam. MAC documents have no
 * boundary-only headings the splitter needs: text after unrecognized
 * headings simply keeps accumulating, matching pre-seam behavior that both
 * MAC ground truths were reviewed against.
 */
export const MAC_VOCABULARY: SectionVocabulary = {
  headings: [
    { sections: ['indications'], pattern: /\bindications?\b/i },
    { sections: ['documentation'], pattern: /\bdocumentation\b/i },
    { sections: ['limitations'], pattern: /\blimitations?\b/i },
  ],
  boundaries: [],
  terminal: /revision history/i,
};
