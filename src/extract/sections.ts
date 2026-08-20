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

export function splitSections(text: string): SplitResult {
  const bodies = new Map<SectionName, string[]>();
  let current: readonly SectionName[] = [];

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();

    const headings = headingsFor(line);
    if (headings.length > 0) {
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
