/**
 * `PUT /api/projects/:id/entry-file`: the entry file as a project attribute.
 *
 * The UI's "set as entry" control and `od project entry` both call this
 * route, so its contract is what both surfaces rely on: a project-relative
 * file that exists becomes the recorded entry the preview opens, `null`
 * clears the record so inference takes over again, and anything else is
 * refused with a named error instead of being stored.
 */
import type http from 'node:http';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServer } from '../../src/server.js';

const execFileP = promisify(execFile);
const DAEMON_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO_ROOT = path.resolve(DAEMON_ROOT, '..', '..');
const CLI_SRC = path.resolve(DAEMON_ROOT, 'src/cli.ts');
const TSX_CLI = path.resolve(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs');

describe('PUT /api/projects/:id/entry-file', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    const started = (await startServer({ port: 0, returnServer: true })) as {
      url: string;
      server: http.Server;
    };
    baseUrl = started.url;
    server = started.server;
  });

  afterAll(() => {
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function createProjectWithFiles(label: string, files: Record<string, string>) {
    const projectId = `proj-entry-${label}-${Date.now()}`;
    const createResp = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: projectId,
        name: 'Entry file fixture',
        metadata: { kind: 'prototype' },
        skillId: null,
        designSystemId: null,
      }),
    });
    expect(createResp.status).toBe(200);
    for (const [name, content] of Object.entries(files)) {
      const writeResp = await fetch(`${baseUrl}/api/projects/${projectId}/files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, content }),
      });
      expect(writeResp.status).toBe(200);
    }
    return projectId;
  }

  async function putEntry(projectId: string, entryFile: unknown) {
    const response = await fetch(`${baseUrl}/api/projects/${projectId}/entry-file`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entryFile }),
    });
    return { status: response.status, body: await response.json() as Record<string, any> };
  }

  async function readEntry(projectId: string): Promise<string | undefined> {
    const response = await fetch(`${baseUrl}/api/projects/${projectId}`);
    expect(response.status).toBe(200);
    const body = await response.json() as { project: { metadata?: { entryFile?: string } } };
    return body.project.metadata?.entryFile;
  }

  it('records an existing file as the entry and reads it back on the project', async () => {
    const projectId = await createProjectWithFiles('set', {
      'screens/home.html': '<!doctype html><title>Home</title>',
      'screens/about.html': '<!doctype html><title>About</title>',
    });
    expect(await readEntry(projectId)).toBeUndefined();

    const set = await putEntry(projectId, 'screens/home.html');
    expect(set.status, JSON.stringify(set.body)).toBe(200);
    expect(set.body).toMatchObject({
      entryFile: 'screens/home.html',
      project: { id: projectId, metadata: { kind: 'prototype', entryFile: 'screens/home.html' } },
    });
    expect(await readEntry(projectId)).toBe('screens/home.html');

    // The preview resolves to the recorded entry when no file is named.
    const preview = await fetch(`${baseUrl}/api/projects/${projectId}/preview-url`);
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ file: 'screens/home.html' });
  });

  it('accepts a leading ./ and switches the entry to another file', async () => {
    const projectId = await createProjectWithFiles('switch', {
      'a.html': '<!doctype html><title>A</title>',
      'b.html': '<!doctype html><title>B</title>',
    });
    expect((await putEntry(projectId, './a.html')).body.entryFile).toBe('a.html');
    expect((await putEntry(projectId, 'b.html')).body.entryFile).toBe('b.html');
    expect(await readEntry(projectId)).toBe('b.html');
  });

  it('clears the record with null so inference takes over again', async () => {
    const projectId = await createProjectWithFiles('clear', {
      'index.html': '<!doctype html><title>Index</title>',
      'other.html': '<!doctype html><title>Other</title>',
    });
    expect((await putEntry(projectId, 'other.html')).status).toBe(200);
    const cleared = await putEntry(projectId, null);
    expect(cleared.status).toBe(200);
    expect(cleared.body.entryFile).toBeNull();
    expect(await readEntry(projectId)).toBeUndefined();
    // Back on inference: the root index.html is what the preview opens.
    const preview = await fetch(`${baseUrl}/api/projects/${projectId}/preview-url`);
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ file: 'index.html' });
  });

  it('refuses a file that is not in the project, a directory, and an unsafe path', async () => {
    const projectId = await createProjectWithFiles('refuse', {
      'screens/home.html': '<!doctype html><title>Home</title>',
    });
    const missing = await putEntry(projectId, 'nope.html');
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ error: { code: 'FILE_NOT_FOUND' } });

    const directory = await putEntry(projectId, 'screens');
    expect(directory.status).toBe(404);

    for (const unsafe of ['../outside.html', '/etc/passwd', '', 42]) {
      const refused = await putEntry(projectId, unsafe);
      expect(refused.status, String(unsafe)).toBe(400);
      expect(refused.body).toMatchObject({ error: { code: 'BAD_REQUEST' } });
    }
    expect(await readEntry(projectId)).toBeUndefined();
  });

  it('sets, prints, and clears the entry through od project entry', async () => {
    const projectId = await createProjectWithFiles('cli', {
      'screens/home.html': '<!doctype html><title>Home</title>',
    });
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const run = (args: string[]) => execFileP(process.execPath, [TSX_CLI, CLI_SRC, ...args], {
      cwd: DAEMON_ROOT,
      env,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });

    const set = await run(['project', 'entry', projectId, '--file', 'screens/home.html', '--daemon-url', baseUrl, '--json']);
    expect(set.stderr).toBe('');
    expect(JSON.parse(set.stdout)).toMatchObject({ entryFile: 'screens/home.html', project: { id: projectId } });
    expect(await readEntry(projectId)).toBe('screens/home.html');

    const read = await run(['project', 'entry', projectId, '--daemon-url', baseUrl, '--json']);
    expect(JSON.parse(read.stdout)).toEqual({ projectId, entryFile: 'screens/home.html' });

    const cleared = await run(['project', 'entry', projectId, '--clear', '--daemon-url', baseUrl, '--json']);
    expect(JSON.parse(cleared.stdout)).toMatchObject({ entryFile: null });
    expect(await readEntry(projectId)).toBeUndefined();

    await expect(run(['project', 'entry', projectId, '--file', 'missing.html', '--daemon-url', baseUrl, '--json']))
      .rejects.toMatchObject({ code: expect.any(Number) });
  }, 60_000);

  it('returns 404 for an unknown project', async () => {
    const response = await putEntry('proj-does-not-exist', 'index.html');
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: { code: 'PROJECT_NOT_FOUND' } });
  });
});
