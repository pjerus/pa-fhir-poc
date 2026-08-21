import type { Requirement, RequirementCategory } from '../types.ts';
import type { LlmClient } from './llm-client.ts';
import { SECTION_NAMES, type SectionMap, type SectionName } from './sections.ts';

const CATEGORY_BY_SECTION: Readonly<Record<SectionName, RequirementCategory>> = {
  indications: 'indication',
  documentation: 'documentation',
  limitations: 'limitation',
};

export interface StructureInput {
  readonly lcdId: string;
  readonly sections: SectionMap;
}

interface Block {
  readonly sections: readonly SectionName[];
  readonly categories: readonly RequirementCategory[];
  readonly body: string;
}

/**
 * A heading like "Indications, Limitations, and/or Medical Necessity" lands the
 * same body under several sections. Group those into one block so the text is
 * extracted once, and let the model pick a category per requirement.
 */
function blocksOf(sections: SectionMap): Block[] {
  const bySharedBody = new Map<string, SectionName[]>();

  for (const name of SECTION_NAMES) {
    const body = sections[name];
    if (body === null || body.trim() === '') continue;
    const existing = bySharedBody.get(body);
    if (existing === undefined) bySharedBody.set(body, [name]);
    else existing.push(name);
  }

  return [...bySharedBody].map(([body, names]) => ({
    body,
    sections: names,
    categories: names.map((name) => CATEGORY_BY_SECTION[name]),
  }));
}

function responseSchema(categories: readonly RequirementCategory[]): unknown {
  return {
    type: 'object',
    required: ['requirements'],
    properties: {
      requirements: {
        type: 'array',
        items: {
          type: 'object',
          required: ['text', 'category'],
          properties: {
            text: { type: 'string' },
            category: { type: 'string', enum: categories },
          },
        },
      },
    },
  };
}

const CATEGORY_DEFINITIONS: Readonly<Record<RequirementCategory, string>> = {
  indication:
    'a clinical or eligibility criterion the beneficiary must meet for the item to qualify for coverage',
  documentation:
    'an obligation to create, retain, or produce records or evidence',
  limitation:
    'a restriction, exclusion, quantity cap, or condition under which the item is denied',
};

function buildPrompt(body: string, categories: readonly RequirementCategory[]): string {
  return [
    'You are extracting discrete coverage requirements from a Medicare coverage policy.',
    '',
    'Return ONLY a JSON object of the form:',
    '{"requirements":[{"text":"<one requirement, verbatim or lightly normalised>",' +
      `"category":"<one of: ${categories.join(', ')}>"}]}`,
    '',
    'Categories:',
    ...categories.map((category) => `- ${category}: ${CATEGORY_DEFINITIONS[category]}`),
    '',
    'Rules:',
    '- One entry per discrete, independently checkable obligation.',
    '- Do not merge two obligations into one entry, and do not split one across entries.',
    '- Do not invent requirements that are not stated in the text.',
    '- No prose, no markdown fences, no explanation. JSON only.',
    '',
    'Policy text:',
    body,
  ].join('\n');
}

interface ParsedRequirement {
  readonly text: string;
  readonly category: RequirementCategory;
}

function parseRequirements(
  raw: string,
  categories: readonly RequirementCategory[],
): ParsedRequirement[] {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || !('requirements' in parsed)) {
    throw new Error('response has no "requirements" key');
  }
  const list = (parsed as { requirements: unknown }).requirements;
  if (!Array.isArray(list)) throw new Error('"requirements" is not an array');

  return list.map((item, index) => {
    if (typeof item !== 'object' || item === null) {
      throw new Error(`requirement ${index} is not an object`);
    }
    const { text, category } = item as { text?: unknown; category?: unknown };
    if (typeof text !== 'string' || text.trim() === '') {
      throw new Error(`requirement ${index} has no text`);
    }
    if (typeof category !== 'string' || !categories.includes(category as RequirementCategory)) {
      throw new Error(
        `requirement ${index} has category ${JSON.stringify(category)}, ` +
          `expected one of: ${categories.join(', ')}`,
      );
    }
    return { text: text.trim(), category: category as RequirementCategory };
  });
}

function buildRetryPrompt(
  originalPrompt: string,
  unusableReply: string,
  reason: string,
): string {
  return [
    'Your previous reply could not be used.',
    `Reason: ${reason}`,
    '',
    'This is what you replied:',
    unusableReply,
    '',
    'Reply again with the JSON object only. Start your reply with { and end it with }.',
    'Do not restate the question, do not explain, do not use markdown fences.',
    '',
    originalPrompt,
  ].join('\n');
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One retry, then surrender loudly — never a partial or invented result. */
async function requestRequirements(block: Block, llm: LlmClient): Promise<ParsedRequirement[]> {
  const { categories } = block;
  const schema = responseSchema(categories);
  const prompt = buildPrompt(block.body, categories);

  const first = await llm.complete({ prompt, schema });
  try {
    return parseRequirements(first, categories);
  } catch (error) {
    const retry = await llm.complete({
      prompt: buildRetryPrompt(prompt, first, reasonOf(error)),
      schema,
    });
    try {
      return parseRequirements(retry, categories);
    } catch (retryError) {
      throw new Error(
        [
          `Extraction of the "${block.sections.join(' + ')}" section failed twice; ` +
            'refusing to emit ' +
            'partial or invented requirements.',
          `First attempt rejected because: ${reasonOf(error)}`,
          `Retry rejected because: ${reasonOf(retryError)}`,
          '',
          'Raw first reply:',
          first,
          '',
          'Raw retry reply:',
          retry,
        ].join('\n'),
      );
    }
  }
}

export async function structureRequirements(
  input: StructureInput,
  llm: LlmClient,
): Promise<Requirement[]> {
  const requirements: Requirement[] = [];

  for (const block of blocksOf(input.sections)) {
    for (const parsed of await requestRequirements(block, llm)) {
      const ordinal = requirements.length + 1;
      requirements.push({
        id: `${input.lcdId}-R${ordinal}`,
        text: parsed.text,
        ordinal,
        category: parsed.category,
      });
    }
  }

  return requirements;
}
