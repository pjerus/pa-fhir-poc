export type SectionName = 'indications' | 'documentation' | 'limitations';

export const SECTION_NAMES: readonly SectionName[] = [
  'indications',
  'documentation',
  'limitations',
];

export type SectionMap = Readonly<Record<SectionName, string | null>>;

export interface SplitResult {
  readonly sections: SectionMap;
  readonly warnings: readonly string[];
}

const HEADING_PATTERNS: ReadonlyArray<readonly [SectionName, RegExp]> = [
  ['indications', /\bindications?\b/i],
  ['documentation', /\bdocumentation\b/i],
  ['limitations', /\blimitations?\b/i],
];

const MAX_HEADING_WORDS = 12;

// Revision-history tables repeat INDICATION/LIMITATION-style labels far more
// often than a real heading recurs in the same document; past this count a
// verbatim-matching heading candidate is treated as a recurring table label.
const MAX_HEADING_RECURRENCE = 3;

const REVISION_HISTORY_HEADING = /revision history/i;

/**
 * MAC formatting varies, so headings are recognised structurally rather than by
 * an exact-title list: a short, non-sentence line that names a section.
 */
function isHeadingLike(line: string): boolean {
  if (line === '' || line.endsWith('.')) return false;
  return line.split(/\s+/).length <= MAX_HEADING_WORDS;
}

/** A heading may name several sections ("Indications, Limitations, and/or..."). */
function headingsFor(line: string): readonly SectionName[] {
  if (!isHeadingLike(line)) return [];
  return HEADING_PATTERNS.filter(([, pattern]) => pattern.test(line)).map(([name]) => name);
}

/**
 * Revision-history is always terminal in these documents: everything from
 * that heading onward is change-log boilerplate, not policy text, and no
 * later heading candidate may resume section assignment. Returns the text
 * up to (excluding) that heading, or the whole input if it never appears.
 */
export function cutAtRevisionHistory(text: string): string {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    if (isHeadingLike(line) && REVISION_HISTORY_HEADING.test(line)) {
      return lines.slice(0, i).join('\n');
    }
  }
  return text;
}

export function splitSections(text: string): SplitResult {
  const lines = cutAtRevisionHistory(text)
    .split('\n')
    .map((rawLine) => rawLine.trim());

  const candidateCounts = new Map<string, number>();
  for (const line of lines) {
    if (headingsFor(line).length > 0) {
      candidateCounts.set(line, (candidateCounts.get(line) ?? 0) + 1);
    }
  }

  const bodies = new Map<SectionName, string[]>();
  let current: readonly SectionName[] = [];

  for (const line of lines) {
    const headings = headingsFor(line);
    if (headings.length > 0) {
      const isRecurringLabel = (candidateCounts.get(line) ?? 0) > MAX_HEADING_RECURRENCE;
      if (isRecurringLabel) continue;

      current = headings;
      for (const name of headings) {
        if (!bodies.has(name)) bodies.set(name, []);
      }
      continue;
    }

    if (line === '') continue;
    for (const name of current) bodies.get(name)?.push(line);
  }

  const sections: Record<SectionName, string | null> = {
    indications: null,
    documentation: null,
    limitations: null,
  };
  const warnings: string[] = [];

  for (const name of SECTION_NAMES) {
    const body = bodies.get(name);
    if (body === undefined) {
      warnings.push(`No "${name}" heading found; downstream extraction will skip that section.`);
      continue;
    }
    sections[name] = body.join('\n');
  }

  return { sections, warnings };
}
