/**
 * OD Next settlement driven by real CLI streams.
 *
 * The chain test beside this one (`od-next-automatic-simple-server.test.ts`)
 * proves the daemon against a hand-written fake CLI. This file replays
 * anonymized recordings of the real `claude` and `codex` CLIs (the corpus
 * under `mocks/`) through the same HTTP path, so every settlement reason is
 * exercised by a stream an actual CLI once produced. The mock CLIs render the
 * recorded tool calls as protocol events but never touch the file system, which
 * is what makes them useful here:
 *
 * - a recorded Write/Edit reaches the daemon only through the tool-stream
 *   ledger, so "the ledger alone proves delivery" gets its own row;
 * - a Codex recording writes through Bash, which the ledger cannot see, so the
 *   round settles without delivery — the real daemon would have seen the
 *   file-system diff instead.
 *
 * Skipped when the recording corpus has not been fetched
 * (`bash mocks/scripts/fetch-recordings.sh`).
 */
import type { Server } from 'node:http';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Agent, fetch as undiciFetch } from 'undici';
import type { StrategyTaskProjectionV2 } from '@open-design/contracts';

import { closeDatabase } from '../src/db.js';
import { AGENT_DEFS } from '../src/runtimes/registry.js';
import { agentBinEnvKey } from '../src/runtimes/executables.js';
import { startServer } from '../src/server.js';
import { startCaptureSink, type CaptureSink } from './first-visible-output-harness.js';

const DAEMON_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(DAEMON_ROOT, '..', '..');
const MOCK_AGENT = path.join(REPO_ROOT, 'mocks', 'mock-agent.mjs');
const RECORDINGS_DIR = path.join(REPO_ROOT, 'mocks', 'recordings');

/** Recordings picked from `mocks/manifest.json` for the shape of their stream. */
const TRACES = {
  /** claude: no tool calls, the reply is a `<question-form>` brief. */
  claudeQuestion: 'a8e51f72-982d-4b39-b8c9-86c9457fe61b',
  /** claude: two Bash calls and a text reply; nothing written through a write tool. */
  claudeTextOnly: 'fa8d8b16-802e-4006-b19f-59b028996356',
  /** claude: Bash/Grep/Read, then one successful Edit of `index.html`. */
  claudeEditsIndex: '072ae827-f4b6-42e3-93e2-6c2c3a157366',
  /** codex: fourteen Bash calls (its writes go through the shell) and a text reply. */
  codexBashOnly: 'dcdff3b3-cd39-4dcd-be83-372830a29639',
} as const;

const recordingsAvailable = Object.values(TRACES).every((trace) => (
  existsSync(path.join(RECORDINGS_DIR, `${trace}.jsonl`))
));

type StartedServer = { url: string; server: Server; shutdown?: () => Promise<void> | void };
type RunStatus = {
  id: string;
  status: string;
  error?: string | null;
  errorCode?: string | null;
  exitCode?: number | null;
  signal?: string | null;
  failureDetail?: unknown;
  strategyTask?: StrategyTaskProjectionV2;
};
type Invocation = { argv: string[]; cwd: string };

const fixtureAgentBinEnvKeys = [...new Set(
  AGENT_DEFS.map((def) => agentBinEnvKey(def.id)).filter((key): key is string => key !== null),
)];

describe.skipIf(!recordingsAvailable)('OD Next settlement replayed from recorded CLI streams', () => {
  let started: StartedServer | null = null;
  let dispatcher: Agent | null = null;
  let fixtureRoot: string | null = null;
  let sink: CaptureSink | null = null;
  let previousEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    previousEnv = Object.fromEntries([
      'PATH', 'OD_AGENT_HOME', 'OD_CODEX_TRANSPORT', 'OD_NEXT_STRATEGY_ROLLOUT',
      'OD_NEXT_STRATEGY_LOCAL_SYNTHETIC_CANARY', 'POSTHOG_KEY', 'POSTHOG_HOST',
      ...fixtureAgentBinEnvKeys,
    ].map((key) => [key, process.env[key]]));
    delete process.env.POSTHOG_KEY;
    delete process.env.POSTHOG_HOST;
    process.env.OD_CODEX_TRANSPORT = 'exec-json';
    process.env.OD_NEXT_STRATEGY_ROLLOUT = 'active';
    process.env.OD_NEXT_STRATEGY_LOCAL_SYNTHETIC_CANARY = '1';
  });

  afterEach(async () => {
    try {
      await started?.shutdown?.();
      started?.server.close();
      await dispatcher?.close();
      await sink?.close();
      closeDatabase();
      if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
    } finally {
      started = null;
      dispatcher = null;
      sink = null;
      fixtureRoot = null;
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  function fetch(input: string, init?: Parameters<typeof undiciFetch>[1]) {
    return undiciFetch(input, { ...init, dispatcher: dispatcher! });
  }

  /**
   * A CLI shim on the daemon's PATH. It answers the daemon's version probe,
   * records every invocation, and otherwise replays one recording per
   * invocation through the shared mock (the last recording repeats).
   */
  async function installReplayCli(
    agent: 'claude' | 'codex',
    traces: string[],
    version: string,
    options: { captureAnalytics?: boolean } = {},
  ) {
    if (options.captureAnalytics) {
      // A stand-in for PostHog ingestion, wired before the daemon starts so its
      // analytics client posts every capture here.
      sink = await startCaptureSink();
      process.env.POSTHOG_KEY = 'phc_od_next_replay_settlement';
      process.env.POSTHOG_HOST = sink.url;
    }
    const helpFlags = agent === 'claude'
      ? ['  --include-partial-messages', '  --forward-subagent-text', '  --agents <json>', '  --add-dir <dirs...>']
      : ['  exec', '  --json', '  resume'];
    fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'od-next-mock-replay-'));
    const bin = path.join(fixtureRoot, 'bin');
    const home = path.join(fixtureRoot, 'home');
    await mkdir(bin);
    await mkdir(home);
    await symlink(process.execPath, path.join(bin, 'node'));
    const shim = path.join(bin, agent);
    const invocationsPath = path.join(fixtureRoot, 'invocations.jsonl');
    await writeFile(path.join(fixtureRoot, 'replay.json'), JSON.stringify({
      agent, traces, version, helpFlags, mockAgent: MOCK_AGENT, recordingsDir: RECORDINGS_DIR, invocationsPath,
    }));
    await writeFile(shim, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'replay.json'), 'utf8'));
const argv = process.argv.slice(2);
if (argv.includes('--version')) { console.log(config.version); process.exit(0); }
if (argv.includes('--help')) {
  // Advertise the flags the daemon probes for; the mock ignores them.
  console.log(['Usage: ' + config.agent + ' [options]', ...config.helpFlags].join(String.fromCharCode(10)));
  process.exit(0);
}
if (argv[0] === 'auth' || argv[0] === 'login') { console.log('Logged in'); process.exit(0); }
if (argv[0] === 'debug') { process.exit(0); }
// Only replays count as invocations; the probes above are detection traffic.
if (argv.includes('__od_capability_probe__')) {
  // The hidden-flag probe expects the CLI to reject the value; refuse it as an
  // unknown option so no hidden capability is recorded.
  console.error('error: unknown option ' + argv[argv.indexOf('__od_capability_probe__') - 1]);
  process.exit(1);
}
const seen = fs.existsSync(config.invocationsPath)
  ? fs.readFileSync(config.invocationsPath, 'utf8').split('\\n').filter(Boolean).length
  : 0;
fs.appendFileSync(config.invocationsPath, JSON.stringify({ argv, cwd: process.cwd() }) + '\\n');
const trace = config.traces[Math.min(seen, config.traces.length - 1)];
const result = spawnSync(process.execPath, [config.mockAgent, '--as', config.agent, ...argv], {
  stdio: 'inherit',
  env: {
    ...process.env,
    OD_MOCKS_TRACE: trace,
    OD_MOCKS_NO_DELAY: '1',
    OD_MOCKS_RECORDINGS_DIR: config.recordingsDir,
  },
});
process.exit(result.status ?? 1);
`);
    await chmod(shim, 0o755);
    process.env.OD_AGENT_HOME = home;
    process.env.PATH = [bin, '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter);
    for (const key of fixtureAgentBinEnvKeys) delete process.env[key];

    started = await startServer({ port: 0, returnServer: true }) as StartedServer;
    dispatcher = new Agent();
    const binEnvKey = agentBinEnvKey(agent)!;
    const config = await fetch(`${started.url}/api/app-config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: agent,
        agentCliEnv: { [agent]: { [binEnvKey]: shim } },
        telemetry: { metrics: options.captureAnalytics === true, content: false, artifactManifest: false },
        privacyDecisionAt: Date.now(),
      }),
    });
    expect(config.status).toBe(200);
    expect((await fetch(`${started.url}/api/agents`)).status).toBe(200);
    return { invocationsPath };
  }

  async function createPrototypeProject(label: string, options: { ordinaryPath?: boolean } = {}) {
    const projectId = `od-next-replay-${label}-${Date.now()}`;
    const response = await fetch(`${started!.url}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: projectId,
        name: `OD Next replay ${label}`,
        metadata: { kind: 'prototype' },
        conversationMode: 'design',
        // A project that names its scenario plugin explicitly takes the
        // ordinary route; only the automatic task profile admits OD Next.
        ...(options.ordinaryPath
          ? { pluginId: 'example-web-prototype' }
          : { automaticStrategyTaskProfile: 'prototype' }),
        skipDiscoveryBrief: true,
      }),
    });
    expect(response.status).toBe(200);
    const { conversationId } = await response.json() as { conversationId: string };
    return { projectId, conversationId };
  }

  const ANALYTICS_HEADERS = {
    'x-od-analytics-device-id': 'od-next-replay-device',
    'x-od-analytics-session-id': 'od-next-replay-session',
    'x-od-analytics-client-type': 'web',
  };

  async function startTask(
    agent: 'claude' | 'codex',
    project: { projectId: string; conversationId: string },
    message: string,
    options: { expectTask?: boolean } = {},
  ) {
    const response = await fetch(`${started!.url}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ANALYTICS_HEADERS },
      body: JSON.stringify({
        projectId: project.projectId,
        conversationId: project.conversationId,
        agentId: agent,
        userMessageId: `user-${project.projectId}`,
        assistantMessageId: `assistant-${project.projectId}`,
        clientRequestId: `request-${project.projectId}`,
        message,
        currentPrompt: message,
      }),
    });
    const body = await response.json() as { runId: string; taskExecutionId?: string; strategyTask?: StrategyTaskProjectionV2 };
    expect(response.status, JSON.stringify(body)).toBe(202);
    if (options.expectTask === false) {
      expect(body.strategyTask).toBeUndefined();
    } else {
      expect(body.strategyTask).toMatchObject({ inputStage: 'request', terminal: false });
    }
    return body as { runId: string; taskExecutionId: string };
  }

  async function waitForRunTerminal(runId: string): Promise<RunStatus> {
    const deadline = Date.now() + 25_000;
    let latest: RunStatus | null = null;
    while (Date.now() < deadline) {
      const response = await fetch(`${started!.url}/api/runs/${encodeURIComponent(runId)}`);
      latest = await response.json() as RunStatus;
      if (['succeeded', 'failed', 'canceled'].includes(latest.status)) return latest;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`run ${runId} did not finish: ${JSON.stringify(latest)}`);
  }

  /** Every capture the daemon posted for one Run, after draining its analytics client. */
  async function capturedRunEvents(runId: string, eventName: 'run_created' | 'run_finished') {
    const find = () => sink!.captured().filter((record) => (
      record.event === eventName && record.properties.run_id === runId
    ));
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && find().length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (find().length === 0) {
      // The daemon's shutdown drains posthog-node; after it the sink holds
      // everything the daemon will ever send.
      await started!.shutdown?.();
      started = null;
    }
    return find();
  }

  async function waitForTerminalTask(runId: string): Promise<StrategyTaskProjectionV2> {
    const deadline = Date.now() + 25_000;
    let latest: RunStatus | null = null;
    while (Date.now() < deadline) {
      const response = await fetch(`${started!.url}/api/runs/${encodeURIComponent(runId)}`);
      latest = await response.json() as RunStatus;
      if (latest.strategyTask?.terminal) {
        const { status, error, errorCode, exitCode, signal, failureDetail } = latest;
        expect(status, JSON.stringify({ error, errorCode, exitCode, signal, failureDetail })).toBe('succeeded');
        return latest.strategyTask;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`task on run ${runId} did not settle: ${JSON.stringify(latest)}`);
  }

  async function taskRuns(projectId: string, taskExecutionId: string) {
    const response = await fetch(`${started!.url}/api/runs?projectId=${encodeURIComponent(projectId)}`);
    const body = await response.json() as {
      runs: Array<{ id: string; status: string; strategyTask?: StrategyTaskProjectionV2 }>;
    };
    return body.runs.filter((run) => run.strategyTask?.taskExecutionId === taskExecutionId);
  }

  async function invocations(invocationsPath: string): Promise<Invocation[]> {
    const raw = await readFile(invocationsPath, 'utf8').catch(() => '');
    return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Invocation);
  }

  it('settles on the question when a recorded claude reply renders a form', async () => {
    const { invocationsPath } = await installReplayCli('claude', [TRACES.claudeQuestion], '2.1.259 (Claude Code)');
    const project = await createPrototypeProject('question');
    const created = await startTask('claude', project, 'Make a website for a watchdog organization.');

    const task = await waitForTerminalTask(created.runId);
    expect(task).toMatchObject({
      taskExecutionId: created.taskExecutionId,
      inputStage: 'request',
      outcome: 'completed',
      settlementReason: 'question',
      deliverableWritten: false,
      autoRoundCount: 0,
    });
    expect(await taskRuns(project.projectId, created.taskExecutionId)).toHaveLength(1);
    expect(await invocations(invocationsPath)).toHaveLength(1);
  }, 40_000);

  it('gives a recorded text-only claude round its one build round in the continued session, then stops', async () => {
    const { invocationsPath } = await installReplayCli('claude', [TRACES.claudeTextOnly], '2.1.259 (Claude Code)');
    const project = await createPrototypeProject('text-only');
    const created = await startTask('claude', project, 'Commit this stage.');

    const task = await waitForTerminalTask(created.runId);
    expect(task).toMatchObject({
      taskExecutionId: created.taskExecutionId,
      inputStage: 'production',
      outcome: 'completed',
      settlementReason: 'text_only',
      deliverableWritten: false,
      autoRoundCount: 1,
    });
    const runs = await taskRuns(project.projectId, created.taskExecutionId);
    expect(runs).toHaveLength(2);
    expect(runs.every((run) => run.status === 'succeeded')).toBe(true);
    const spawned = await invocations(invocationsPath);
    expect(spawned).toHaveLength(2);
    // The build round continued the planning round's native session.
    expect(spawned[1]!.argv).toContain('--resume');
    expect(spawned[0]!.argv).not.toContain('--resume');
  }, 40_000);

  it('counts a recorded claude Edit as delivery through the tool-stream ledger alone', async () => {
    const { invocationsPath } = await installReplayCli('claude', [TRACES.claudeEditsIndex], '2.1.259 (Claude Code)');
    const project = await createPrototypeProject('ledger');
    const created = await startTask('claude', project, 'Remove the latest image and restore the index.');

    const task = await waitForTerminalTask(created.runId);
    expect(task).toMatchObject({
      inputStage: 'request',
      outcome: 'completed',
      settlementReason: 'deliverable_changed',
      deliverableWritten: true,
      autoRoundCount: 0,
    });
    expect(await taskRuns(project.projectId, created.taskExecutionId)).toHaveLength(1);
    expect(await invocations(invocationsPath)).toHaveLength(1);
  }, 40_000);

  it('marks the task delivered when the build round writes what the planning round did not', async () => {
    const { invocationsPath } = await installReplayCli(
      'claude',
      [TRACES.claudeTextOnly, TRACES.claudeEditsIndex],
      '2.1.259 (Claude Code)',
    );
    const project = await createPrototypeProject('chain');
    const created = await startTask('claude', project, 'Build the index page.');

    const task = await waitForTerminalTask(created.runId);
    expect(task).toMatchObject({
      inputStage: 'production',
      outcome: 'completed',
      settlementReason: 'deliverable_changed',
      deliverableWritten: true,
      autoRoundCount: 1,
    });
    expect(await taskRuns(project.projectId, created.taskExecutionId)).toHaveLength(2);
    expect(await invocations(invocationsPath)).toHaveLength(2);
  }, 40_000);

  it('reports the task identity on run_created and the settlement, reason codes and launch fact on run_finished', async () => {
    const { invocationsPath } = await installReplayCli(
      'claude',
      [TRACES.claudeTextOnly],
      '2.1.259 (Claude Code)',
      { captureAnalytics: true },
    );
    const project = await createPrototypeProject('analytics');
    const created = await startTask('claude', project, 'Commit this stage.');
    const task = await waitForTerminalTask(created.runId);
    expect(task).toMatchObject({ settlementReason: 'text_only', autoRoundCount: 1 });
    const runs = await taskRuns(project.projectId, created.taskExecutionId);
    expect(runs).toHaveLength(2);
    expect(await invocations(invocationsPath)).toHaveLength(2);
    const buildRunId = runs.find((run) => run.id !== created.runId)!.id;

    const planningCreated = await capturedRunEvents(created.runId, 'run_created');
    const planningFinished = await capturedRunEvents(created.runId, 'run_finished');
    const buildFinished = await capturedRunEvents(buildRunId, 'run_finished');
    expect(planningCreated).toHaveLength(1);
    expect(planningFinished).toHaveLength(1);
    expect(buildFinished).toHaveLength(1);

    // The strategy package the task was frozen on, from the task row, on
    // both events of the planning Run. (`task_execution_id` on these events
    // is the client's recovery lineage, not the daemon task id; the build Run
    // inherits it below.)
    const lineage = planningCreated[0]!.properties.task_execution_id;
    expect(lineage).toEqual(expect.any(String));
    expect(planningCreated[0]!.properties).toMatchObject({
      harness: 'od_next',
      od_next_strategy_version: task.strategy.version,
      od_next_strategy_package_hash: task.strategy.packageHash,
      od_next_task_stage: 'request',
    });
    // The planning Run ended with the build round already claimed.
    expect(planningFinished[0]!.properties).toMatchObject({
      result: 'success',
      od_next_strategy_version: task.strategy.version,
      od_next_task_stage: 'request',
      od_next_task_outcome: 'running',
      od_next_auto_round_count: 1,
      od_next_deliverable_written: false,
      od_next_agent_launch: 'started',
    });
    expect(planningFinished[0]!.properties).not.toHaveProperty('od_next_settlement_reason');
    // The build Run carries the settlement.
    expect(buildFinished[0]!.properties).toMatchObject({
      result: 'success',
      task_execution_id: lineage,
      task_run_index: 1,
      od_next_task_stage: 'production',
      od_next_task_outcome: 'completed',
      od_next_settlement_reason: 'text_only',
      od_next_auto_round_count: 1,
      od_next_deliverable_written: false,
      od_next_agent_launch: 'started',
    });
    for (const record of [...planningCreated, ...planningFinished, ...buildFinished]) {
      expect(record.properties).not.toHaveProperty('od_next_reason_codes');
      expect(record.properties).not.toHaveProperty('od_next_blocked_reason_code');
    }
  }, 60_000);

  it('reports none of the task fields on an ordinary-path Run', async () => {
    await installReplayCli(
      'claude',
      [TRACES.claudeTextOnly],
      '2.1.259 (Claude Code)',
      { captureAnalytics: true },
    );
    const project = await createPrototypeProject('ordinary', { ordinaryPath: true });
    const created = await startTask('claude', project, 'Commit this stage.', { expectTask: false });
    expect((await waitForRunTerminal(created.runId)).status).toBe('succeeded');
    const finished = await capturedRunEvents(created.runId, 'run_finished');
    expect(finished).toHaveLength(1);
    expect(finished[0]!.properties.harness).toBe('ordinary');
    expect(Object.keys(finished[0]!.properties).filter((key) => key.startsWith('od_next_'))).toEqual([]);
  }, 60_000);

  it('cannot see a recorded codex round writing through Bash, so the task settles undelivered after its build round', async () => {
    const { invocationsPath } = await installReplayCli('codex', [TRACES.codexBashOnly], 'codex-cli 0.147.0');
    const project = await createPrototypeProject('codex');
    const created = await startTask('codex', project, 'Build the dashboard.');

    const task = await waitForTerminalTask(created.runId);
    expect(task).toMatchObject({
      inputStage: 'production',
      outcome: 'completed',
      settlementReason: 'text_only',
      deliverableWritten: false,
      autoRoundCount: 1,
    });
    expect(await taskRuns(project.projectId, created.taskExecutionId)).toHaveLength(2);
    expect(await invocations(invocationsPath)).toHaveLength(2);
  }, 40_000);
});
