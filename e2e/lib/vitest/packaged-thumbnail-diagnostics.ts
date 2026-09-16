import { open, realpath } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { captureProcessSnapshot, collectProcessTreePids, pathContains, readProcessStampFromCommand } from '@open-design/platform';
import { OPEN_DESIGN_SIDECAR_CONTRACT } from '@open-design/sidecar-proto';
import type { ChatRunStatusResponse } from '@open-design/contracts';
import { T } from '../timeouts.ts';
import type { E2eReport } from './report.ts';

export type ThumbnailDiagnosticOwner = {
  namespace: string;
  runtimeRoot: string;
  daemonPid: number | null;
  readLogs: () => Promise<{ namespace: string; logs: Record<string, { logPath: string; lines: string[] }> }>;
};

/** Bounded files from one isolated runtime; no database/config/profile reads. */
export async function saveThumbnailFailureDiagnostics(input: {
  owner: ThumbnailDiagnosticOwner;
  run: ChatRunStatusResponse | null;
  invocationPath: string;
  invocationNonce: string;
  fixtureRoot: string;
  report: E2eReport;
}): Promise<void> {
  const errors: Array<{ step: string; error: string }> = [];
  async function attempt(step: string, action: () => Promise<void>): Promise<void> {
    try { await action(); } catch (error) { errors.push({ step, error: String(error) }); }
  }
  const runtime = await realpath(input.owner.runtimeRoot);
  async function tail(path: string, allowedRoot: string): Promise<{ path: string; size: number; truncated: boolean; text: string }> {
    const [actual, allowed] = await Promise.all([realpath(path), realpath(allowedRoot)]);
    if (!pathContains(allowed, actual)) throw new Error('Diagnostic file escaped its owned root');
    const handle = await open(actual, 'r');
    try {
      const { size } = await handle.stat();
      const count = Math.min(size, 256 * 1024);
      const buffer = Buffer.alloc(count);
      const { bytesRead } = await handle.read(buffer, 0, count, size - count);
      return { path: actual, size, truncated: size > count, text: buffer.subarray(0, bytesRead).toString('utf8') };
    } finally { await handle.close(); }
  }
  const run = input.run;
  await attempt('run event tail', async () => {
    if (!run || !/^[a-zA-Z0-9-]+$/.test(run.id) || !run.eventsLogPath) throw new Error('No exact run event path observed');
    const expected = join(runtime, 'data', 'runs', run.id, 'events.jsonl');
    if (resolve(run.eventsLogPath) !== resolve(expected)) throw new Error('Observed event path differs from owned run path');
    await input.report.json('thumbnail-binding/run-events-tail.json', await tail(expected, join(runtime, 'data', 'runs', run.id)));
  });
  const pids = new Set<number>();
  if (Number.isSafeInteger(run?.childPid) && Number(run?.childPid) > 0) pids.add(Number(run?.childPid));
  await attempt('CLI lifecycle', async () => {
    const evidence = await tail(input.invocationPath, input.fixtureRoot);
    const records = evidence.text.split(/\r?\n/).filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
    }).filter((record) => record.nonce === input.invocationNonce);
    for (const record of records) if (Number.isSafeInteger(record.pid) && Number(record.pid) > 0) pids.add(Number(record.pid));
    await input.report.json('thumbnail-binding/cli-lifecycle.json', { truncated: evidence.truncated, records });
  });
  await attempt('daemon close diagnostics', async () => {
    const logs = await input.owner.readLogs();
    if (logs.namespace !== input.owner.namespace) throw new Error('Logs came from another namespace');
    const daemon = logs.logs.daemon;
    if (!daemon) throw new Error('Missing daemon log path');
    const evidence = await tail(daemon.logPath, join(runtime, 'logs', 'daemon'));
    const lines = evidence.text.split(/\r?\n/);
    const selected = new Set<number>();
    const identity = [run?.id, run?.projectId, ...[...pids].map(String)].filter((value): value is string => Boolean(value));
    for (const [index, line] of lines.entries()) {
      if (identity.some((value) => line.includes(value)) || /unhandled|termination_failed|run terminal capture failed|syntax.*failed/i.test(line)) {
        for (let n = Math.max(0, index - 2); n <= Math.min(lines.length - 1, index + 8); n++) selected.add(n);
      }
    }
    await input.report.json('thumbnail-binding/daemon-close-log.json', {
      path: evidence.path, size: evidence.size, truncated: evidence.truncated,
      lines: [...selected].sort((a, b) => a - b).slice(-160).map((index) => ({ index, text: lines[index] })),
      note: 'Scoped daemon log only; no matching lines is missing evidence, not proof of successful close.',
    });
  });
  await attempt('owned process snapshot', async () => {
    // The platform API owns Windows CIM invocation and kills its observer on timeout.
    // Persist only this fixture/daemon ownership tree, never the machine process table.
    const snapshots = await captureProcessSnapshot({ timeoutMs: T.short });
    const ownedRoots = snapshots.filter((entry) => pids.has(entry.pid)
      && entry.command.includes(input.fixtureRoot)).map((entry) => entry.pid);
    const daemon = snapshots.find((entry) => {
      if (entry.pid !== input.owner.daemonPid) return false;
      const stamp = readProcessStampFromCommand(entry.command, OPEN_DESIGN_SIDECAR_CONTRACT);
      return stamp?.namespace === input.owner.namespace && stamp.app === 'daemon';
    });
    if (daemon) ownedRoots.push(daemon.pid);
    const owned = new Set(collectProcessTreePids(snapshots, ownedRoots));
    await input.report.json('thumbnail-binding/owned-processes.json', {
      observedAt: new Date().toISOString(), expectedPids: [...pids], daemonPid: input.owner.daemonPid,
      aliveExactPids: snapshots.filter((entry) => pids.has(entry.pid)).map((entry) => ({ pid: entry.pid, ppid: entry.ppid, startedAtMs: entry.startedAtMs })),
      ownershipVerifiedRoots: ownedRoots,
      processes: snapshots.filter((entry) => owned.has(entry.pid)).map((entry) => ({
        pid: entry.pid, ppid: entry.ppid, startedAtMs: entry.startedAtMs,
        executable: basename(entry.command.match(/^"([^"]+)"|^(\S+)/)?.slice(1).find(Boolean) ?? 'unknown'),
        role: /Get-CimInstance.*Win32_Process/.test(entry.command) ? 'process-enumeration' : 'owned-process',
      })),
    });
  });
  await input.report.json('thumbnail-binding/diagnostic-errors.json', errors);
}
