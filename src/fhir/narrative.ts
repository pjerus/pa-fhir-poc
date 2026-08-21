import type { Narrative } from 'fhir/r4';

function escapeXhtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** dom-6 best practice: every projected FHIR resource carries a generated narrative. */
export function generatedNarrative(summary: string): Narrative {
  return {
    status: 'generated',
    div: `<div xmlns="http://www.w3.org/1999/xhtml"><p>${escapeXhtml(summary)}</p></div>`,
  };
}
