import { execFile } from 'node:child_process';
import { open, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathContains } from '@open-design/platform';
import type { ChatRunStatusResponse } from '@open-design/contracts';
import { T } from '../timeouts.ts';
import type { E2eReport } from './report.ts';

export type ThumbnailDiagnosticOwner = {
  namespace: string;
  runtimeRoot: string;
  /** Explicit owned roots for the source tools-dev suite; packaged defaults stay unchanged. */
  dataRoot?: string;
  daemonLogsRoot?: string;
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
    const runRoot = join(input.owner.dataRoot ?? join(runtime, 'data'), 'runs', run.id);
    const expected = join(runRoot, 'events.jsonl');
    if (resolve(run.eventsLogPath) !== resolve(expected)) throw new Error('Observed event path differs from owned run path');
    await input.report.json('thumbnail-binding/run-events-tail.json', await tail(expected, runRoot));
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
    const evidence = await tail(daemon.logPath, input.owner.daemonLogsRoot ?? join(runtime, 'logs', 'daemon'));
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
    // The namespace's inspect response identifies the daemon WORKER, whose
    // argv does not carry the supervisor's stamp. Never require the retired
    // sidecar-proto argv contract, and never query machine-wide CommandLine.
    const roots = new Set(pids);
    if (Number.isSafeInteger(input.owner.daemonPid) && Number(input.owner.daemonPid) > 0) {
      roots.add(Number(input.owner.daemonPid));
    }
    const snapshots = await readOwnedWindowsProcessFacts([...roots]);
    await input.report.json('thumbnail-binding/owned-processes.json', {
      observedAt: new Date().toISOString(), expectedPids: [...pids], daemonPid: input.owner.daemonPid,
      namespace: input.owner.namespace,
      daemonObservation: snapshots.find((entry) => entry.pid === input.owner.daemonPid) ?? null,
      aliveExactPids: snapshots.filter((entry) => pids.has(entry.pid)),
      observedRoots: snapshots.filter((entry) => roots.has(entry.pid)).map((entry) => entry.pid),
      processes: snapshots,
      note: 'Read-only PID facts from trusted namespace inspect and this case receipts; no stamp inference, command lines, or process signals.',
    });
  });
  await input.report.json('thumbnail-binding/diagnostic-errors.json', errors);
}

type OwnedProcessFact = { pid: number; ppid: number; startedAtMs: number | null; executable: string };

/** TEMPORARY diagnostic branch: no CommandLine is requested or returned. */
async function readOwnedWindowsProcessFacts(roots: number[]): Promise<OwnedProcessFact[]> {
  if (process.platform !== 'win32') throw new Error('This diagnostic observes the Windows packaged run only');
  const safeRoots = [...new Set(roots.filter((pid) => Number.isSafeInteger(pid) && pid > 0))];
  if (safeRoots.length === 0) return [];
  const command = [
    "$ErrorActionPreference = 'Stop'",
    '$rows = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate)',
    '$owned = [System.Collections.Generic.HashSet[int]]::new()',
    `@(${safeRoots.join(',')}) | ForEach-Object { [void]$owned.Add([int]$_) }`,
    'do { $changed = $false; foreach ($row in $rows) { if ($owned.Contains([int]$row.ParentProcessId) -and $owned.Add([int]$row.ProcessId)) { $changed = $true } } } while ($changed)',
    '$rows | Where-Object { $owned.Contains([int]$_.ProcessId) } | Select-Object ProcessId,ParentProcessId,Name,@{Name="StartedAtMs";Expression={if ($null -ne $_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { $null }}} | ConvertTo-Json -Compress',
  ].join('; ');
  const stdout = await new Promise<string>((resolveRead, rejectRead) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: T.short, killSignal: 'SIGKILL', windowsHide: true,
    }, (error, output) => {
      // Never serialize execFile's error.command: diagnostics contain only
      // the observer error category, not a full shell invocation.
      if (error) rejectRead(new Error(`Owned process observer failed: code=${String(error.code)} killed=${String(error.killed)}`));
      else resolveRead(output);
    });
  });
  if (!stdout.trim()) return [];
  const parsed: unknown = JSON.parse(stdout);
  return (Array.isArray(parsed) ? parsed : [parsed]).map((record: unknown) => {
    if (!record || typeof record !== 'object') throw new Error('Invalid owned process record');
    const value = record as Record<string, unknown>;
    const pid = Number(value.ProcessId), ppid = Number(value.ParentProcessId);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(ppid) || ppid < 0 || typeof value.Name !== 'string') {
      throw new Error('Invalid owned process identity');
    }
    const startedAtMs = Number(value.StartedAtMs);
    return { pid, ppid, executable: value.Name, startedAtMs: Number.isSafeInteger(startedAtMs) && startedAtMs > 0 ? startedAtMs : null };
  });
}
