#!/usr/bin/env node

import { execFile } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ACTIVE_RUN_STATES = new Set([
  'queued',
  'in_progress',
  'waiting',
  'requested',
  'pending',
]);
const RETRY_INTERVAL_MS = 15_000;

const runGitHubCli = async (args) => {
  const { stdout } = await execFileAsync('gh', args, { encoding: 'utf8' });
  return stdout;
};

const wait = (duration) =>
  new Promise((resolve) => setTimeout(resolve, duration));

const errorText = (error) =>
  [error?.message, error?.stderr, error?.code]
    .filter((value) => value !== undefined && value !== null)
    .join(' ');

export const isTransientGitHubApiError = (error) =>
  /\bHTTP\s+5\d\d\b/u.test(errorText(error)) ||
  /\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)\b/u.test(
    errorText(error)
  );

export const watchGitHubRun = async (
  repository,
  runId,
  { runGitHub = runGitHubCli, sleep = wait, onRetry = () => {} } = {}
) => {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error('A GitHub repository in owner/name format is required.');
  }
  if (!/^\d+$/u.test(String(runId))) {
    throw new Error('A numeric GitHub Actions run ID is required.');
  }

  while (true) {
    try {
      await runGitHub([
        'run',
        'watch',
        String(runId),
        '--repo',
        repository,
        '--interval',
        '15',
        '--exit-status',
      ]);
      return;
    } catch (watchError) {
      let run;

      try {
        const response = await runGitHub([
          'api',
          `repos/${repository}/actions/runs/${runId}`,
        ]);
        run = JSON.parse(response);
      } catch (statusError) {
        if (
          isTransientGitHubApiError(watchError) ||
          isTransientGitHubApiError(statusError)
        ) {
          onRetry(
            `GitHub API temporarily failed while checking run ${runId}; retrying.`
          );
          await sleep(RETRY_INTERVAL_MS);
          continue;
        }

        throw statusError;
      }

      if (run.status === 'completed') {
        if (run.conclusion === 'success') {
          return;
        }

        throw new Error(
          `GitHub Actions run ${runId} completed with ${run.conclusion ?? 'no conclusion'}.`,
          { cause: watchError }
        );
      }

      if (!ACTIVE_RUN_STATES.has(run.status)) {
        throw new Error(
          `GitHub Actions run ${runId} has unexpected status ${run.status ?? 'unknown'}.`,
          { cause: watchError }
        );
      }

      if (!isTransientGitHubApiError(watchError)) {
        throw watchError;
      }

      onRetry(
        `GitHub API temporarily failed while watching active run ${runId}; retrying.`
      );
      await sleep(RETRY_INTERVAL_MS);
    }
  }
};

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  const [repository, runId] = process.argv.slice(2);

  watchGitHubRun(repository ?? '', runId ?? '', {
    onRetry: (message) => process.stderr.write(`${message}\n`),
  }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
