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

/** A heading pattern is tested against the head window of a heading-like line. */
export interface SectionHeadingSpec {
  readonly sections: readonly SectionName[];
  readonly pattern: RegExp;
}

/**
 * The per-publisher vocabulary the structural splitter runs with: which
 * headings open which sections, which headings merely END a section
 * (boundaries — recognized but never extracted from), and the terminal
 * heading after which everything is change-log boilerplate.
 */
export interface SectionVocabulary {
  readonly headings: readonly SectionHeadingSpec[];
  readonly boundaries: readonly RegExp[];
  readonly terminal: RegExp;
}

const MAX_HEADING_WORDS = 12;

// PDF exports hard-wrap prose, so a mid-sentence fragment can land on its
// own short line ("of 10 events and documentation of:"). True headings start
// with a capital and name their section within the first few words; fragments
// start lowercase, with a digit, or a quote, or bury the keyword mid-sentence.
const KEYWORD_WORD_WINDOW = 3;

// A dot-leader run marks a table-of-contents line ("Coverage Policy .... 2"),
// which repeats real heading text without being a heading.
const DOT_LEADER = /\.{4,}/;

// Revision-history tables repeat INDICATION/LIMITATION-style labels far more
// often than a real heading recurs in the same document; past this count a
// verbatim-matching heading candidate is treated as a recurring table label.
const MAX_HEADING_RECURRENCE = 3;

/**
 * Publisher formatting varies, so headings are recognised structurally rather
 * than by an exact-title list: a short, non-sentence line that names a section.
 */
function isHeadingLike(line: string): boolean {
  if (line === '' || line.endsWith('.')) return false;
  if (!/^[A-Z]/.test(line)) return false;
  if (DOT_LEADER.test(line)) return false;
  return line.split(/\s+/).length <= MAX_HEADING_WORDS;
}

type HeadingMatch =
  | { readonly kind: 'sections'; readonly names: readonly SectionName[] }
  | { readonly kind: 'boundary' }
  | null;

/** A heading may name several sections ("Indications, Limitations, and/or..."). */
function matchHeading(line: string, vocabulary: SectionVocabulary): HeadingMatch {
  if (!isHeadingLike(line)) return null;
  const head = line.split(/\s+/).slice(0, KEYWORD_WORD_WINDOW).join(' ');
  const names = vocabulary.headings
    .filter(({ pattern }) => pattern.test(head))
    .flatMap(({ sections }) => sections);
  if (names.length > 0) return { kind: 'sections', names: [...new Set(names)] };
  if (vocabulary.boundaries.some((pattern) => pattern.test(head))) return { kind: 'boundary' };
  return null;
}

/**
 * The terminal heading is always last in these documents: everything from it
 * onward is change-log boilerplate, not policy text, and no later heading
 * candidate may resume section assignment. Returns the text up to (excluding)
 * that heading, or the whole input if it never appears.
 */
export function cutAtTerminal(text: string, terminal: RegExp): string {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    if (isHeadingLike(line) && terminal.test(line)) {
      return lines.slice(0, i).join('\n');
    }
  }
  return text;
}

export function splitSections(text: string, vocabulary: SectionVocabulary): SplitResult {
  const lines = cutAtTerminal(text, vocabulary.terminal)
    .split('\n')
    .map((rawLine) => rawLine.trim());

  const candidateCounts = new Map<string, number>();
  for (const line of lines) {
    if (matchHeading(line, vocabulary)?.kind === 'sections') {
      candidateCounts.set(line, (candidateCounts.get(line) ?? 0) + 1);
    }
  }

  const bodies = new Map<SectionName, string[]>();
  let current: readonly SectionName[] = [];

  for (const line of lines) {
    const match = matchHeading(line, vocabulary);
    if (match?.kind === 'sections') {
      const isRecurringLabel = (candidateCounts.get(line) ?? 0) > MAX_HEADING_RECURRENCE;
      if (isRecurringLabel) continue;

      current = match.names;
      for (const name of match.names) {
        if (!bodies.has(name)) bodies.set(name, []);
      }
      continue;
    }
    if (match?.kind === 'boundary') {
      current = [];
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
