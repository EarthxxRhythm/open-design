// TEMPORARY OPEND-2809 Windows diagnostic branch only; not a product regression claim.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ChatRunStatusResponse } from '@open-design/contracts';
import { resolveLogFilePath, resolveNamespaceRoot } from '@open-design/sidecar';
import { OPEN_DESIGN_SIDECAR_CONTRACT } from '@open-design/sidecar-proto';
import { expect, test } from 'vitest';
import { createFakeAgentRuntimes } from '@/fake-agents';
import { T } from '@/timeouts';
import { saveThumbnailFailureDiagnostics } from '@/vitest/packaged-thumbnail-diagnostics';
import { createSmokeSuite, e2eWorkspaceRoot } from '@/vitest/suite';
import {
  PACKAGED_THUMBNAIL_HTML,
  PACKAGED_THUMBNAIL_PNG_A_BASE64,
  PACKAGED_THUMBNAIL_PNG_B_BASE64,
} from '../../resources/packaged-thumbnail.ts';

// The same app-server input as the packaged smoke, without a desktop renderer.
// A pass proves natural source-daemon completion, never PNG/thumbnail correctness.
test.skipIf(process.platform !== 'win32')('thumbnail app-server source daemon reaches natural terminal', async () => {
  const suite = await createSmokeSuite('dialog-thumbnail');
  const fixtureRoot = join(suite.scratchDir, 'fake-agents');
  const resources = join(fixtureRoot, 'input');
  await mkdir(resources, { recursive: true });
  const imageA = Buffer.from(PACKAGED_THUMBNAIL_PNG_A_BASE64, 'base64');
  const imageB = Buffer.from(PACKAGED_THUMBNAIL_PNG_B_BASE64, 'base64');
  await Promise.all([
    writeFile(join(resources, 'index.html'), PACKAGED_THUMBNAIL_HTML),
    writeFile(join(resources, 'a.png'), imageA),
    writeFile(join(resources, 'b.png'), imageB),
  ]);
  const fake = await createFakeAgentRuntimes({ root: fixtureRoot, runtimeIds: ['codex'], recordInvocations: true });
  const invocation = fake.codex.invocation;
  if (!invocation) throw new Error('Required nonce-bound CLI receipt missing');
  const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
  await suite.report.json('source-input.json', {
    githubSha: process.env.GITHUB_SHA ?? null,
    serverSha256: sha(await readFile(join(e2eWorkspaceRoot(), 'apps/daemon/src/server.ts'))),
    htmlSha256: sha(PACKAGED_THUMBNAIL_HTML), imageASha256: sha(imageA), imageBSha256: sha(imageB),
    transport: 'app-server', namespace: suite.namespace,
    scope: 'Source HTTP lifecycle only; no Electron or PNG rendering witness',
  });
  let lastRun: ChatRunStatusResponse | null = null;
  let phase = 'start-runtime';
  const journal: Array<{ path: string; method: string; status: number }> = [];
  await suite.with.toolsDev(async ({ webUrl, status, logs }) => {
    const runtimeRoot = resolveNamespaceRoot({
      base: suite.toolsDevRoot, namespace: suite.namespace, contract: OPEN_DESIGN_SIDECAR_CONTRACT,
    });
    const collect = async () => {
      await suite.report.json('source-state.json', { phase, run: lastRun, journal });
      await saveThumbnailFailureDiagnostics({
        owner: {
          namespace: suite.namespace, runtimeRoot, dataRoot: suite.dataDir,
          daemonLogsRoot: dirname(resolveLogFilePath({
            runtimeRoot, app: 'daemon', contract: OPEN_DESIGN_SIDECAR_CONTRACT,
          })),
          daemonPid: status.apps?.daemon?.pid ?? null,
          readLogs: async () => ({ namespace: suite.namespace, logs: await logs() }),
        },
        run: lastRun, invocationPath: invocation.path, invocationNonce: invocation.nonce,
        fixtureRoot, report: suite.report,
      });
    };
    async function request<V>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<V> {
      const response = await fetch(new URL(path, webUrl), {
        method, cache: 'no-store', signal: AbortSignal.timeout(T.short),
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      });
      journal.push({ path, method, status: response.status });
      const text = await response.text();
      if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status} ${text.slice(0, 500)}`);
      return JSON.parse(text) as V;
    }
    try {
      phase = 'configure';
      await request('/api/app-config', {
        mode: 'daemon', agentId: 'codex', onboardingCompleted: true,
        odNextStrategyMode: 'off', skillId: null, designSystemId: null,
        agentModels: { codex: { model: 'default', reasoning: 'default' } },
        agentCliEnv: { codex: fake.codex.env },
      }, 'PUT');
      phase = 'create-project';
      const project = await request<{ project: { id: string }; conversationId: string }>('/api/projects', {
        id: `thumbnail-${randomUUID()}`, name: 'Source thumbnail lifecycle', metadata: { kind: 'prototype' },
      });
      phase = 'create-run';
      const prompt = 'Create the packaged thumbnail filter SVG fixture';
      const created = await request<{ runId: string }>('/api/runs', {
        projectId: project.project.id, conversationId: project.conversationId,
        clientRequestId: randomUUID(), agentId: 'codex', model: 'default', reasoning: 'default',
        message: prompt, currentPrompt: prompt, sessionMode: 'chat', skillId: null, designSystemId: null,
      });
      phase = 'wait-natural-terminal';
      await expect.poll(async () => {
        lastRun = await request<ChatRunStatusResponse>(`/api/runs/${created.runId}`);
        return lastRun.status === 'failed' || lastRun.status === 'canceled'
          || (lastRun.status === 'succeeded' && lastRun.childExited === true);
      }, { timeout: T.xlong, message: 'same app-server child must naturally terminalize in the source daemon' }).toBe(true);
      const terminal = await request<ChatRunStatusResponse>(`/api/runs/${created.runId}`);
      lastRun = terminal;
      expect(terminal, JSON.stringify(terminal)).toMatchObject({
        id: created.runId, status: 'succeeded', childExited: true, exitCode: 0,
        agentId: 'codex', projectId: project.project.id, conversationId: project.conversationId,
      });
      expect(terminal.strategyTask).toBeUndefined();
      expect(terminal.assistantMessageId).toEqual(expect.any(String));
      phase = 'verify-app-server-qualification';
      const receipts = (await readFile(invocation.path, 'utf8')).split(/\r?\n/).filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((record) => record.nonce === invocation.nonce && record.mode === 'app-server');
      const writes = receipts.filter((record) => record.event === 'thumbnail-written');
      expect(writes).toHaveLength(1);
      const childReceipts = receipts.filter((record) => record.pid === writes[0]?.pid);
      expect(childReceipts).toEqual(expect.arrayContaining([
        expect.objectContaining({ event: 'request', method: 'initialize' }),
        expect.objectContaining({ event: 'request', method: 'turn/start' }),
        expect.objectContaining({ event: 'completed', failed: false }),
        expect.objectContaining({ event: 'process-exit', code: 0 }),
      ]));
      phase = 'verify-fixture-output';
      const html = await fetch(new URL(`/api/projects/${project.project.id}/raw/index.html`, webUrl), { signal: AbortSignal.timeout(T.short) });
      expect(html.status).toBe(200);
      expect(await html.text()).toBe(PACKAGED_THUMBNAIL_HTML);
      const png = await fetch(new URL(`/api/projects/${project.project.id}/raw/assets/a.png`, webUrl), { signal: AbortSignal.timeout(T.short) });
      expect(png.status).toBe(200);
      expect(sha(Buffer.from(await png.arrayBuffer()))).toBe(sha(imageA));
      phase = 'natural-terminal-qualified';
    } catch (error) {
      // Preserve the primary business failure even when a diagnostic source is unavailable.
      await collect().catch(async (diagnosticError: unknown) => {
        await suite.report.json('diagnostic-collection-error.json', { error: String(diagnosticError) }).catch(() => {});
      });
      throw error;
    }
    await collect();
  }, { env: { OD_CODEX_TRANSPORT: 'app-server', OD_NEXT_STRATEGY_ROLLOUT: 'off' } });
}, 180_000);
