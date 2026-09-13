import express from 'express';
import type http from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { sendApiError } from '../../src/http/api-errors.js';
import { registerRunRoutes, type RegisterRunRoutesDeps } from '../../src/routes/runs.js';
import { createChatRunService } from '../../src/runtimes/runs.js';

const { readRunRequestLedger } = vi.hoisted(() => ({ readRunRequestLedger: vi.fn() }));
vi.mock('../../src/integrations/vela-request-ledger.js', () => ({ readRunRequestLedger }));

describe('individual Run request ledger route', () => {
  it('adds ledger to the existing CLI status response and respects project authorization', async () => {
    const runs = createChatRunService({
      createSseResponse: () => ({ send: vi.fn(), end: vi.fn(), cleanup: vi.fn() }),
      createSseErrorPayload: (code: string, message: string) => ({ error: { code, message } }),
    });
    const run = runs.create({ projectId: 'project-a', agentId: 'amr' });
    runs.setDeliverableValidation(run, { valid: true, validation: 'valid' });
    runs.finish(run, 'succeeded', 0, null);
    const ledger = { schemaVersion: 'generation-request-ledger-v1', sourceRunId: run.id, complete: false, incompleteReasons: ['provider_usage_incomplete'] };
    readRunRequestLedger.mockReset().mockResolvedValue(ledger);
    const app = express();
    registerRunRoutes(app, {
      db: { prepare: () => ({ get: () => undefined }) },
      design: { runs }, http: { sendApiError, createSseResponse: vi.fn() },
      paths: { BUNDLED_PLUGINS_DIR: '/plugins', PROJECTS_DIR: '/projects', RUNTIME_DATA_DIR: '/isolated-data' },
      agents: {}, chat: {}, plugins: {}, telemetry: {}, messages: {}, internalRuns: {},
      authorizeProjectRequest: async (_req: unknown, res: express.Response) => { res.status(403).json({ error: 'forbidden' }); return false; },
    } as unknown as RegisterRunRoutesDeps);
    const server = await new Promise<http.Server>(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('missing test server address');
      const url = `http://127.0.0.1:${address.port}/api/runs/${run.id}`;
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ id: run.id, status: 'succeeded', requestLedger: ledger });
      expect(readRunRequestLedger).toHaveBeenCalledWith(run, '/isolated-data');
      readRunRequestLedger.mockClear();
      const denied = await fetch(url, { headers: { 'x-od-workspace-id': 'foreign-workspace', 'x-od-workspace-member-id': 'foreign-member' } });
      expect(denied.status).toBe(403);
      expect(readRunRequestLedger).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
