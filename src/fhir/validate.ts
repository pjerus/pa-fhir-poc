import { spawn } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { DTR_IG_PACKAGE, DTR_STD_QUESTIONNAIRE_PROFILE, FHIR_VERSION } from './profiles.ts';

const VALIDATOR_JAR = 'tools/validator_cli.jar';
const PACKAGE_CACHE_DIR = '.fhir';
const DOCKER_IMAGE = 'eclipse-temurin:21-jre';

export interface ValidatorRun {
  /** What this run checks, for console output and the conformance report. */
  readonly label: string;
  /** The artifact file the run validates, relative to outDir. */
  readonly artifactFile: string;
  /** Full argv for `docker`, array form — never joined into a shell string. */
  readonly dockerArgs: readonly string[];
}

/**
 * The CRD card is deliberately absent: CRD v2.2.1 models the CDS Hooks
 * response as a logical model, not a FHIR resource instance, so there is no
 * StructureDefinition to validate `<lcdId>.crd.json` against (verified M4
 * finding — see docs/conformance/).
 *
 * `-tx n/a` on every run: structure and profile constraints are verified;
 * terminology membership is not.
 *
 * `-allow-example-urls`: instance canonicals here are example.org by design —
 * this repo publishes nothing (see profiles.ts CANONICAL_BASE). The flag tells
 * the validator the placeholder is deliberate; every other check runs normally.
 */
export function validatorRuns(lcdId: string, outDir: string): readonly ValidatorRun[] {
  const mounts = [
    '-v', `${resolve(VALIDATOR_JAR)}:/validator_cli.jar:ro`,
    '-v', `${resolve(outDir)}:/work:ro`,
    '-v', `${resolve(PACKAGE_CACHE_DIR)}:/root/.fhir`,
  ];
  const java = ['java', '-jar', '/validator_cli.jar'];
  const common = ['-version', FHIR_VERSION, '-tx', 'n/a', '-allow-example-urls'];

  return [
    {
      label: `DTR Questionnaire against ${DTR_STD_QUESTIONNAIRE_PROFILE} (${DTR_IG_PACKAGE})`,
      artifactFile: `${lcdId}.dtr.json`,
      dockerArgs: [
        'run', '--rm', ...mounts, DOCKER_IMAGE, ...java,
        `/work/${lcdId}.dtr.json`,
        ...common,
        '-ig', DTR_IG_PACKAGE,
        '-profile', DTR_STD_QUESTIONNAIRE_PROFILE,
      ],
    },
    {
      label: 'PlanDefinition against base FHIR R4 (no Da Vinci profile exists for it)',
      artifactFile: `${lcdId}.plandefinition.json`,
      dockerArgs: [
        'run', '--rm', ...mounts, DOCKER_IMAGE, ...java,
        `/work/${lcdId}.plandefinition.json`,
        ...common,
      ],
    },
  ];
}

async function assertExists(path: string, hint: string): Promise<void> {
  try {
    await access(path);
  } catch {
    throw new Error(`${path} not found. ${hint}`);
  }
}

/**
 * Runs the official HL7 validator in a Java container against a projected
 * LCD's artifacts. First run downloads the IG package tree into
 * `.fhir/` (gitignored); every later run is offline.
 *
 * Returns per-run exit codes; the caller decides process exit. Throws before
 * spawning anything if the jar or an artifact is missing.
 */
export async function validateProjection(lcdId: string, outDir: string): Promise<readonly { run: ValidatorRun; exitCode: number }[]> {
  await assertExists(VALIDATOR_JAR, 'Run: ./tools/fetch-validator.sh');
  // A policy with no documentation requirements projects no Questionnaire
  // (see project.ts) — that run is skipped, not failed. The PlanDefinition
  // is always projected, so its absence is still a loud error.
  const dtrExists = await access(join(outDir, `${lcdId}.dtr.json`)).then(
    () => true,
    () => false,
  );
  const runs = validatorRuns(lcdId, outDir).filter(
    (run) => dtrExists || !run.artifactFile.endsWith('.dtr.json'),
  );
  for (const run of runs) {
    await assertExists(join(outDir, run.artifactFile), `Run: node cli.ts project ${lcdId}`);
  }
  await mkdir(PACKAGE_CACHE_DIR, { recursive: true });

  const results: { run: ValidatorRun; exitCode: number }[] = [];
  for (const run of runs) {
    process.stderr.write(`\n=== ${run.label} ===\n`);
    const exitCode = await new Promise<number>((resolvePromise, rejectPromise) => {
      const child = spawn('docker', run.dockerArgs, { shell: false, stdio: 'inherit' });
      child.on('error', (error) =>
        rejectPromise(new Error(`Failed to run docker — is it installed and running? (${error.message})`)),
      );
      child.on('close', (code) => resolvePromise(code ?? 1));
    });
    results.push({ run, exitCode });
  }
  return results;
}
