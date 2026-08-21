import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

import { validatorRuns } from './validate.ts';
import { DTR_IG_PACKAGE, DTR_STD_QUESTIONNAIRE_PROFILE } from './profiles.ts';

test('validatorRuns', async (t) => {
  const runs = validatorRuns('L99999', 'out');

  await t.test('covers exactly the two artifacts a StructureDefinition applies to', () => {
    assert.deepEqual(
      runs.map((run) => run.artifactFile),
      ['L99999.dtr.json', 'L99999.plandefinition.json'],
    );
  });

  await t.test('validates the Questionnaire against the DTR profile from its own IG package', () => {
    const [dtr] = runs;
    assert.ok(dtr);
    const args = dtr.dockerArgs;
    assert.equal(args[args.indexOf('-ig') + 1], DTR_IG_PACKAGE);
    assert.equal(args[args.indexOf('-profile') + 1], DTR_STD_QUESTIONNAIRE_PROFILE);
  });

  await t.test('validates the PlanDefinition against base R4 only — no profile flag', () => {
    const planDefinition = runs[1];
    assert.ok(planDefinition);
    assert.ok(!planDefinition.dockerArgs.includes('-profile'));
    assert.ok(!planDefinition.dockerArgs.includes('-ig'));
  });

  await t.test('disables terminology checking on every run', () => {
    for (const run of runs) {
      const args = run.dockerArgs;
      assert.equal(args[args.indexOf('-tx') + 1], 'n/a');
    }
  });

  await t.test('permits the deliberate example.org instance canonicals on every run', () => {
    for (const run of runs) {
      assert.ok(run.dockerArgs.includes('-allow-example-urls'));
    }
  });

  await t.test('mounts artifacts and the jar read-only, resolved to absolute paths', () => {
    for (const run of runs) {
      const mounts = run.dockerArgs.filter((arg) => arg.includes(':/'));
      assert.ok(mounts.some((m) => m === `${resolve('tools/validator_cli.jar')}:/validator_cli.jar:ro`));
      assert.ok(mounts.some((m) => m === `${resolve('out')}:/work:ro`));
    }
  });
});
