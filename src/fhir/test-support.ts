import type { ApprovedSubgraph } from '../graph/read.ts';

/** Named so the `*.test.ts` glob skips it; shared fixture for the M4 FHIR builder tests. */
export function syntheticSubgraph(overrides: Partial<ApprovedSubgraph> = {}): ApprovedSubgraph {
  return {
    lcd: {
      id: 'TEST-P-LCD1',
      title: 'Test policy',
      version: '3',
      status: 'approved',
      sourceHash: 'hash-lcd',
    },
    requirements: [
      { id: 'TEST-P-LCD1-R1', text: 'Indication requirement one.', ordinal: 1, category: 'indication' },
      { id: 'TEST-P-LCD1-R2', text: 'Documentation requirement one.', ordinal: 2, category: 'documentation' },
      { id: 'TEST-P-LCD1-R3', text: 'Documentation requirement two.', ordinal: 3, category: 'documentation' },
      { id: 'TEST-P-LCD1-R4', text: 'Limitation requirement one.', ordinal: 4, category: 'limitation' },
    ],
    coveredCodes: [
      { system: 'HCPCS', code: 'E9819' },
      { system: 'HCPCS', code: 'K9813' },
    ],
    article: {
      id: 'TEST-P-ART1',
      sourceHash: 'hash-art',
      listedCodes: [{ system: 'ICD-10-CM', code: 'E99.1' }],
      denialReasons: [{ id: 'TEST-P-ART1-D1', text: 'Not medically necessary.' }],
    },
    ...overrides,
  };
}
