#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPlan,
  executePlan,
  preflight,
  printPlan,
} from './local-validation.mjs';

const args = process.argv.slice(2);
const allowed = new Set(['--help', '-h', '--plan', '--json', '--tests-only']);
if (args.some((arg) => !allowed.has(arg))) {
  process.stderr.write('Unknown option. Use --help.\n');
  process.exitCode = 1;
} else if (args.includes('--help') || args.includes('-h')) {
  process.stdout
    .write(`Usage: node bin/run-local-validation.mjs [--tests-only] [--plan [--json]]

Runs the existing local validators, formatting, lint, types, and discovered tests.
--tests-only  Run all discovered test suites once, preserving their native runner.
--plan        Print files, framework ownership, platform exclusions, and commands;
              do not create files or launch children.
--json        Machine-readable plan (requires --plan).
--help        Show help without reading the project or creating files.

Does not install dependencies, apply migrations, or edit GitHub workflows.
Native, Vitest-only, tooling and CI commands retain their existing behavior.
Failures and zero active tests fail closed.\n`);
} else {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  try {
    if (args.includes('--json') && !args.includes('--plan'))
      throw new Error('--json requires --plan');
    const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
    preflight(root, { testsOnly: args.includes('--tests-only') });
    const plan = createPlan(root, { testsOnly: args.includes('--tests-only') });
    if (args.includes('--plan')) {
      if (args.includes('--json'))
        process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
      else printPlan(plan);
    } else {
      printPlan(plan, process.stdout, { details: false });
      process.on('SIGINT', interrupt);
      process.on('SIGTERM', interrupt);
      const totals = await executePlan(plan, { signal: controller.signal });
      for (const [lane, count] of totals)
        process.stdout.write(
          `${lane}: ${count.total} tests, ${count.active} active\n`
        );
      process.stdout.write('\nLocal validation passed.\n');
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = controller.signal.aborted ? 130 : error.exitCode || 1;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}
