import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCommandInvocation, stopProcesses } from '@open-design/platform';
import { T } from '@/timeouts';
import { PACKAGED_THUMBNAIL_HTML, PACKAGED_THUMBNAIL_PNG_A_BASE64 } from '../../resources/packaged-thumbnail.ts';
import { describe, expect, it } from 'vitest';
import { createFakeAgentRuntimes } from '@/fake-agents';
import {
  codexAppServerInvocationsCompleted,
  PACKAGED_HOME_FIRST_RUN_OUTPUT,
  PACKAGED_HOME_FIRST_RUN_PROMPT,
} from '@/vitest/packaged-home-first-run';
import { attachCodexAppServerSession } from '../../../apps/daemon/src/agent-protocol/codex-app-server/session.js';
import {
  resolveDaemonOwnedOdNextExecutionPreflight,
  runExecutionPreflight,
} from '../../../apps/daemon/src/strategies/od-next/resolver.js';

describe('packaged Codex fixture transport', () => {
  it.each([null, 'resumed-smoke-thread'])(
    '[P0] delivers the Home prompt through the production app-server session (resume=%s)',
    async (resumeSessionId) => {
      const root = await mkdtemp(join(tmpdir(), 'od-codex-fixture-'));
      const { codex } = await createFakeAgentRuntimes({ root, runtimeIds: ['codex'], recordInvocations: true });
      const probe = spawn(process.execPath, [join(root, 'codex-e2e.cjs'), 'exec', '--help']);
      probe.stdin.end();
      expect(await once(probe, 'close')).toEqual([0, null]);
      const child = spawn(process.execPath, [join(root, 'codex-e2e.cjs'), 'app-server'], { stdio: 'pipe' });
      const closed = once(child, 'close');
      const events: Record<string, unknown>[] = [];
      const milestones: string[] = [];
      const session = attachCodexAppServerSession({
        child, cwd: root, prompt: PACKAGED_HOME_FIRST_RUN_PROMPT,
        sandboxMode: 'workspace-write', resumeSessionId,
        onAgentEvent: (event) => events.push(event),
        onSessionReady: () => milestones.push('session'),
        onPromptSendStart: () => milestones.push('prompt'),
        onTurnComplete: () => milestones.push('complete'),
      });
      try {
        expect(await closed).toEqual([0, null]);
        expect(milestones).toEqual(['session', 'prompt', 'complete']);
        expect(session.completedSuccessfully()).toBe(true);
        expect(session.getDurableSessionId()).toBe(resumeSessionId ?? 'fake-codex-session');
        expect(JSON.stringify(events)).toContain(PACKAGED_HOME_FIRST_RUN_OUTPUT);
        expect(session.stats()).toEqual({ unknownNotifications: 0, unknownItems: 0 });
        const receipts = (await readFile(codex.invocation!.path, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        expect(receipts.some((entry) => entry.pid === probe.pid && entry.mode === 'exec-json')).toBe(true);
        expect(receipts.filter((entry) => entry.mode === 'app-server').every((entry) => entry.pid === child.pid)).toBe(true);
        expect(codexAppServerInvocationsCompleted(receipts, codex.invocation!.nonce)).toBe(true);
        expect(codexAppServerInvocationsCompleted(receipts, 'another-smoke')).toBe(false);
        expect(codexAppServerInvocationsCompleted(receipts.filter((entry) => entry.mode !== 'app-server'), codex.invocation!.nonce)).toBe(false);
        expect(codexAppServerInvocationsCompleted(receipts.filter((entry) => entry.event !== 'completed'), codex.invocation!.nonce)).toBe(false);
        expect(codexAppServerInvocationsCompleted(receipts.map((entry) => entry.event === 'completed' ? { ...entry, pid: -1 } : entry), codex.invocation!.nonce)).toBe(false);
        expect(receipts.filter((entry) => entry.event === 'request').map((entry) => entry.method))
          .toEqual(['initialize', 'initialized', resumeSessionId ? 'thread/resume' : 'thread/start', 'turn/start']);
        expect(JSON.stringify(receipts)).not.toContain(PACKAGED_HOME_FIRST_RUN_PROMPT);
      } finally {
        if (child.exitCode == null && child.signalCode == null) child.kill();
        await closed;
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    ['Return an intentional daemon smoke failure', false],
    ['Return an empty daemon smoke response', true],
  ] as const)('[P0] preserves the %s scenario without hanging', async (prompt, completedSuccessfully) => {
    const root = await mkdtemp(join(tmpdir(), 'od-codex-fixture-'));
    await createFakeAgentRuntimes({ root, runtimeIds: ['codex'] });
    const child = spawn(process.execPath, [join(root, 'codex-e2e.cjs'), 'app-server']);
    const closed = once(child, 'close');
    const events: Record<string, unknown>[] = [];
    const session = attachCodexAppServerSession({
      child, cwd: root, prompt, sandboxMode: 'workspace-write', onAgentEvent: (event) => events.push(event),
    });
    try {
      expect(await closed).toEqual([0, null]);
      expect(session.completedSuccessfully()).toBe(completedSuccessfully);
      expect(events.filter((event) => event.type === 'text_delta')).toEqual([]);
      if (!completedSuccessfully) expect(JSON.stringify(events)).toContain('intentional fake codex failure');
      // Empty completion remains empty: the daemon's existing empty-output
      // guard, rather than a fake success message, owns its failed Run status.
    } finally {
      if (child.exitCode == null && child.signalCode == null) child.kill();
      await closed;
      await rm(root, { recursive: true, force: true });
    }
  });

  it('[P0] carries the Home scenario through OD Next planning and native continuation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'od-codex-fixture-'));
    await createFakeAgentRuntimes({ root, runtimeIds: ['codex'] });
    // Match the identity envelope the production prompt composer supplies;
    // capability admission remains the daemon's responsibility, not this fake's.
    const prompts = [
      `${PACKAGED_HOME_FIRST_RUN_PROMPT}\n<recipe_identity strategy_version="2.0.0" applied_snapshot="smoke-snapshot" task_profile_version="2.0.0" />\n"packageHash": "${'a'.repeat(64)}"`,
      '# OD Next native continuation — production',
    ];
    try {
      for (const [index, prompt] of prompts.entries()) {
        const child = spawn(process.execPath, [join(root, 'codex-e2e.cjs'), 'app-server']);
        const closed = once(child, 'close');
        const events: Record<string, unknown>[] = [];
        const session = attachCodexAppServerSession({
          child, cwd: root, prompt, sandboxMode: 'workspace-write',
          resumeSessionId: index === 0 ? null : 'fake-codex-session',
          onAgentEvent: (event) => events.push(event),
        });
        try {
          expect(await closed).toEqual([0, null]);
          expect(session.completedSuccessfully()).toBe(true);
          const text = events.filter((event) => event.type === 'text_delta').map((event) => event.delta).join('');
          if (index === 0) {
            const contract = text.match(/<open-design-plan-contract>\s*([\s\S]*?)\s*<\/open-design-plan-contract>/)?.[1];
            expect(contract).toBeTruthy();
            // The packaged daemon admits the built-in request input. A fake
            // plan must pass that real gate before its native continuation.
            expect(runExecutionPreflight(resolveDaemonOwnedOdNextExecutionPreflight(JSON.parse(contract!))))
              .toEqual({ status: 'passed', reasonCodes: [] });
          } else {
            expect(text).toContain(PACKAGED_HOME_FIRST_RUN_OUTPUT);
            expect(text).toContain('"outcome":"completed"');
            expect(await readFile(join(root, 'od-next-active-canary.html'), 'utf8')).toContain('Delayed Daemon Smoke');
          }
        } finally {
          if (child.exitCode == null && child.signalCode == null) child.kill();
          await closed;
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('[P0] keeps exec-json compatibility and rejects an app-server turn before initialization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'od-codex-fixture-'));
    await createFakeAgentRuntimes({ root, runtimeIds: ['codex'] });
    try {
      for (const mode of ['exec-json', 'app-server']) {
        const child = spawn(process.execPath, [join(root, 'codex-e2e.cjs'), ...(
          mode === 'app-server' ? ['app-server'] : ['exec', '--json', '-']
        )]);
        const closed = once(child, 'close');
        let stdout = '';
        child.stdout.on('data', (chunk) => { stdout += String(chunk); });
        child.stdin.end(mode === 'app-server'
          ? JSON.stringify({ id: 19, method: 'turn/start', params: { input: [] } }) + '\n'
          : PACKAGED_HOME_FIRST_RUN_PROMPT);
        try {
          expect(await closed).toEqual([0, null]);
          if (mode === 'app-server') {
            expect(JSON.parse(stdout)).toMatchObject({ id: 19, error: { code: -32601 } });
            expect(stdout).not.toContain(PACKAGED_HOME_FIRST_RUN_OUTPUT);
          } else {
            expect(stdout).toContain(PACKAGED_HOME_FIRST_RUN_OUTPUT);
            expect(stdout.trim().split('\n').map((line) => JSON.parse(line).type))
              .toEqual(['thread.started', 'turn.started', 'item.completed', 'turn.completed']);
          }
        } finally {
          if (child.exitCode == null && child.signalCode == null) child.kill();
          await closed;
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});


describe.skipIf(process.platform !== 'win32')('Windows thumbnail wrapper qualification', () => {
  it('[P0] closes the real generated cmd wrapper after the production Codex adapter completes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'od-thumbnail-cmd-'));
    const lifecycle: Array<Record<string, unknown>> = [];
    let passed = false;
    try {
      await mkdir(join(root, 'input'));
      const project = join(root, 'project');
      await mkdir(project);
      const image = Buffer.from(PACKAGED_THUMBNAIL_PNG_A_BASE64, 'base64');
      await Promise.all([
        writeFile(join(root, 'input', 'index.html'), PACKAGED_THUMBNAIL_HTML),
        writeFile(join(root, 'input', 'a.png'), image),
      ]);
      const { codex } = await createFakeAgentRuntimes({ root, runtimeIds: ['codex'], recordInvocations: true });
      expect(codex.bin).toMatch(/\.cmd$/i);
      const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, ...codex.env };
      const invocation = createCommandInvocation({ command: codex.bin, args: ['app-server'], env });
      expect(invocation.command).toMatch(/cmd\.exe$/i);
      expect(invocation.windowsVerbatimArguments).toBe(true);
      const child = spawn(invocation.command, invocation.args, {
        cwd: project, env, stdio: 'pipe', windowsVerbatimArguments: invocation.windowsVerbatimArguments === true,
      });
      const closed = once(child, 'close');
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-16000); });
      child.on('exit', (code, signal) => lifecycle.push({ event: 'wrapper-exit', pid: child.pid, code, signal }));
      child.on('close', (code, signal) => lifecycle.push({ event: 'wrapper-close', pid: child.pid, code, signal }));
      const session = attachCodexAppServerSession({
        child, cwd: project, prompt: 'Create the packaged thumbnail filter SVG fixture',
        sandboxMode: 'workspace-write', manageThreadVisibility: true,
        onAgentEvent: () => {},
        onTurnComplete: () => lifecycle.push({ event: 'adapter-turn-completed' }),
      });
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          closed,
          new Promise<never>((_, reject) => {
            deadline = setTimeout(() => reject(new Error('Windows wrapper did not close after real turn completion: ' + JSON.stringify({ lifecycle, stderr }))), T.medium);
          }),
        ]);
        expect(result, JSON.stringify({ lifecycle, stderr })).toEqual([0, null]);
        expect(session.completedSuccessfully()).toBe(true);
        expect(lifecycle.map((entry) => entry.event)).toEqual(['adapter-turn-completed', 'wrapper-exit', 'wrapper-close']);
        expect(await readFile(join(project, 'index.html'), 'utf8')).toBe(PACKAGED_THUMBNAIL_HTML);
        expect(await readFile(join(project, 'assets', 'a.png'))).toEqual(image);
        if (!codex.invocation) throw new Error('Missing CLI recorder');
        const records = (await readFile(codex.invocation.path, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        const completed = records.find((entry) => entry.event === 'completed');
        expect(completed).toMatchObject({ nonce: codex.invocation.nonce, failed: false });
        expect(completed?.pid).not.toBe(child.pid);
        expect(records.filter((entry) => ['completed', 'stdin-end', 'process-exit'].includes(entry.event)).map((entry) => entry.event))
          .toEqual(['completed', 'stdin-end', 'process-exit']);
        expect(records.find((entry) => entry.event === 'process-exit')).toMatchObject({ code: 0, pid: completed?.pid });
        passed = true;
      } finally {
        clearTimeout(deadline);
        let records: Array<Record<string, unknown>> = [];
        try {
          records = codex.invocation ? (await readFile(codex.invocation.path, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
        } catch (error) { console.error('Could not read owned wrapper receipts', error); }
        if (!passed) console.error('Windows thumbnail wrapper qualification failed', { lifecycle, stderr, records });
        // Exact case nonce and the direct child own every PID eligible for cleanup.
        const pids = [...new Set([
          child.pid,
          ...records.filter((entry) => entry.nonce === codex.invocation?.nonce).map((entry) => entry.pid),
        ].filter((pid): pid is number => typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0))];
        if (!passed) {
          try {
            const stopped = await stopProcesses(pids, { termGraceMs: T.short, killGraceMs: T.short });
            console.error('Owned wrapper failure cleanup', stopped);
          } catch (error) { console.error('Owned wrapper failure cleanup failed', error); }
        }
      }
    } finally {
      if (passed) await rm(root, { recursive: true, force: true });
      else console.error('Preserved owned wrapper qualification scratch', root);
    }
  }, T.long);
});
