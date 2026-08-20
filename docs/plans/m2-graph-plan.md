# M2 plan — deterministic graph layer

Spec: PA-AI-POC-PLAN.md (M2) as amended by CLAUDE.md "Graph model" (CLAUDE.md supersedes on: Article node, unified Code label, composite key, no per-requirement code edges).

## Global Constraints

- TypeScript strict, ESM, runs unbuilt via Node type stripping: imports use `.ts` extensions; tsconfig has `erasableSyntaxOnly` — **no enums, no namespaces, no parameter properties**. `npx tsc --noEmit` must stay clean.
- No `any` in domain types. No document-specific data (L33822, A52464, HCPCS codes, requirement wording) in `src/` — synthetic test data uses ids prefixed `TEST-`.
- Fail loud: missing files/unreachable Neo4j throw with actionable messages naming what to do. Never stub silently.
- Tests: `node --test`, colocated `*.test.ts`. Graph tests are integration tests against the running `pa-fhir-poc-neo4j` container (config from env / `.env`); if Neo4j is unreachable they must fail with "start it with: docker compose up -d", not skip. Tests clean up everything they create (all test node ids/codes start with `TEST`).
- Only dependency to add: `neo4j-driver` (^5). Use `driver.executeQuery` / sessions with the `database` from config.
- Commit per logical step, plain messages, **no Co-Authored-By trailer**.
- Env: `src/graph/config.ts` provides `loadGraphConfig()` → `{ uri, user, password, database }` from `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`, `NEO4J_DATABASE`; before reading, call `process.loadEnvFile('.env')` guarded by `existsSync('.env')`. Missing vars → throw naming the var and `.env.example`.

## Graph shape (binding)

```
(LCD {id, title?, version?, status: 'draft'|'approved', sourceHash})-[:REQUIRES]->(Requirement {id, text, ordinal, category})
(LCD)-[:COVERS]->(Code {system, code})
(LCD)-[:HAS_ARTICLE]->(Article {id, title?, version?, sourceHash})
(Article)-[:LISTS]->(Code)
(Article)-[:DEFINES]->(DenialReason {id, text})
```

Constraints: uniqueness `LCD.id`, `Article.id`, `Requirement.id`; composite NODE KEY `(Code.system, Code.code)`; uniqueness `DenialReason.id`.
Note: node key constraints require Enterprise; on Community use a composite uniqueness constraint... Community does NOT support composite uniqueness either — therefore: single-property uniqueness on LCD.id/Article.id/Requirement.id/DenialReason.id, and for Code enforce `(system, code)` uniqueness in write.ts by always MERGE-ing on both properties, with a TODO comment naming the Enterprise node-key upgrade. validate.ts checks for duplicate `(system, code)` pairs as a backstop.

## Task 1 — driver adapter + schema

Files: `package.json` (add neo4j-driver), `src/graph/config.ts`, `src/graph/db.ts`, `src/graph/schema.ts`, `src/graph/schema.test.ts`.

- `config.ts`: as in Global Constraints.
- `db.ts`: `createGraph(config)` → `{ run(cypher, params): Promise<Record[]>, close(): Promise<void> }` — thin adapter so nothing else imports neo4j-driver. Map Neo4j integers to JS numbers (`disableLosslessIntegers: true`). A connect failure anywhere must surface: "Cannot reach Neo4j at <uri> (db <database>): <cause>. Start it with: docker compose up -d".
- `schema.ts`: exported constants for the five labels and five relationship types (single source of truth: `NODE`, `REL` const objects); `ensureConstraints(graph)` creates the four uniqueness constraints with `IF NOT EXISTS`, plus a TODO comment on the Code node-key (see Graph shape).
- Test: `ensureConstraints` twice (idempotent); `SHOW CONSTRAINTS` returns the four expected ones.

## Task 2 — write.ts upsert

Files: `src/types.ts` (extend), `src/graph/write.ts`, `src/graph/write.test.ts`.

Types to add to `src/types.ts`:
```ts
export type LcdStatus = 'draft' | 'approved';
export interface CodeRef { readonly system: string; readonly code: string; }
export interface DenialReason { readonly id: string; readonly text: string; }
export interface LcdInput {
  readonly id: string; readonly title?: string; readonly version?: string;
  readonly sourceHash: string;
  readonly requirements: readonly Requirement[];
  readonly coveredCodes: readonly CodeRef[];
}
export interface ArticleInput {
  readonly id: string; readonly title?: string; readonly version?: string;
  readonly sourceHash: string;
  readonly listedCodes: readonly CodeRef[];
  readonly denialReasons: readonly DenialReason[];
}
```

`loadSubgraph(graph, { lcd, article? })`:
- MERGE everything (idempotent; re-run creates no duplicates).
- **Status is graph-owned lifecycle, not input**: ON CREATE set `status:'draft'`. ON MATCH: if stored `sourceHash` ≠ input's, set `status:'draft'` and update the hash (a changed source PDF voids a prior approval); if equal, leave `status` untouched.
- Requirements upsert on `Requirement.id`; refresh `text`, `ordinal`, `category` from input.
- Stale-edge cleanup: after upsert, delete `REQUIRES`/`COVERS`/`LISTS`/`DEFINES` edges from this LCD/article to nodes not in the current input (a re-extraction that drops a requirement must not leave it attached).

Tests (synthetic `TEST-` data): load then query back edge counts and properties; re-load → same counts; load with changed sourceHash on an `approved` LCD (set approved via direct Cypher in the test) → status back to `draft`; re-load with one requirement removed → its REQUIRES edge gone.

## Task 3 — validate.ts

Files: `src/graph/validate.ts`, `src/graph/validate.test.ts`.

`validateGraph(graph)` → `{ clean: boolean, issues: { kind: string, detail: string }[]` with checks:
- `duplicate-requirement-text`: two Requirements with identical `text` under the same LCD.
- `orphan-code`: Code with no incoming COVERS or LISTS.
- `orphan-denial-reason`: DenialReason with no incoming DEFINES.
- `requirement-cycle`: any cycle among Requirement nodes over any relationship type.
- `duplicate-code-pair`: two Code nodes with same `(system, code)` (backstop for the missing composite constraint).

Tests: clean synthetic graph → `clean: true`; inject each defect via direct Cypher → its issue kind appears with a detail naming the offending id/text.

## Task 4 — read.ts + cli load

Files: `src/graph/read.ts`, `src/graph/read.test.ts`, `cli.ts` (add verb), `test/cli-load.test.ts`.

- `read.ts`: `readApprovedSubgraph(graph, lcdId)` → `{ lcd: { id, title?, version?, status, sourceHash }, requirements: Requirement[] (ordered by ordinal), coveredCodes: CodeRef[], article?: { id, sourceHash, listedCodes, denialReasons } }`. Throws if the LCD is absent ("run: node cli.ts load <lcdId>") and if `status !== 'approved'` ("its review has not been approved" — name the actual status). This throw is what M4 leans on.
- `cli.ts load <lcdId> [articleId]`: read `fixtures/<lcdId>.extracted.json` (absent → throw telling the human to run `node cli.ts extract`); if articleId given, read `fixtures/<articleId>.article.json` (absent → throw; the article extractor that produces this file is a later milestone). Map snapshot → `LcdInput` (coveredCodes: `[]` until HCPCS extraction exists — leave a TODO), call `ensureConstraints`, `loadSubgraph`, then `validateGraph`; print the report as JSON to stdout; exit code 1 if not clean.
- cli test mirrors test/cli-extract.test.ts (temp cwd, synthetic fixtures) but points NEO4J_* at the running container; cleans up its TEST- nodes.
