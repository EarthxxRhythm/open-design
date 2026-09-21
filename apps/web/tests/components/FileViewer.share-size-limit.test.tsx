// @vitest-environment jsdom

// Exercise the real fetch/provider error parsing, not a synthetic thrown error.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import React, { type ComponentProps } from 'react';
import {
  buildWorkspacePermissions,
  buildWorkspaceSeatSummary,
  type WorkspaceCollabContext,
} from '@open-design/contracts';

import { FileViewer } from '../../src/components/FileViewer';
import {
  CollabProvider,
  type CollabContextValue,
} from '../../src/collab/collab-context';
import type { ProjectFile } from '../../src/types';

const analytics = vi.hoisted(() => ({
  track: vi.fn(),
  newRequestId: vi.fn(() => 'request-publish-1'),
}));

vi.mock('../../src/analytics/provider', () => ({
  useAnalytics: () => ({
    track: analytics.track,
    newRequestId: analytics.newRequestId,
  }),
}));

function teamWorkspaceContext(): WorkspaceCollabContext {
  return {
    workspaceId: 'ws-1',
    workspaceType: 'team',
    teamId: 'team-1',
    workspaceMemberId: 'wm-1',
    role: 'member',
    memberStatus: 'active',
    lifecycleState: 'active',
    billingState: 'active',
    planId: null,
    providerMode: 'platform_credits',
    seatSummary: buildWorkspaceSeatSummary({ seatLimit: 5, usedSeats: 1 }),
    permissions: buildWorkspacePermissions({ role: 'member', lifecycleState: 'active' }),
  };
}

function htmlFile(): ProjectFile {
  return {
    name: 'index.html',
    path: 'index.html',
    type: 'file',
    size: 1024,
    mtime: 1710000000,
    kind: 'html',
    mime: 'text/html',
    artifactManifest: {
      version: 1,
      kind: 'html',
      title: 'Page',
      entry: 'index.html',
      renderer: 'html',
      exports: ['html'],
    },
  };
}

function renderProjectFileViewer(
  context: WorkspaceCollabContext,
  props: ComponentProps<typeof FileViewer>,
) {
  const collab: CollabContextValue = {
    workspaceContext: context,
    workspaceContextLoading: false,
    enabled: true,
    member: null,
    present: [],
    publishedVersion: null,
    syncState: null,
    viewerOnly: false,
    writerAuthority: 'allowed',
    isOwner: true,
    isEffectiveOwner: true,
    isSharedNonOwner: false,
    ownerDisplayName: null,
    ownerRole: null,
    downloadPending: false,
    reportChange: () => {},
    requestPublish: () => {},
    refreshPresence: () => {},
    checkStatusNow: () => {},
  };
  const tree = (next: ComponentProps<typeof FileViewer>, nextContext = context) => (
    <CollabProvider value={{ ...collab, workspaceContext: nextContext }}>
      <FileViewer {...next} />
    </CollabProvider>
  );
  const result = render(tree(props));
  return {
    ...result,
    rerenderWith: (next: ComponentProps<typeof FileViewer>, nextContext = context) => result.rerender(tree(next, nextContext)),
  };
}

function stubFetch(
  options: { publishStatus?: number; publishBody?: unknown; unpublishStatus?: number } = {},
) {
  const { publishStatus = 200, publishBody, unpublishStatus = 200 } = options;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/workspace/context')) {
      return new Response(JSON.stringify({ context: teamWorkspaceContext() }), { status: 200 });
    }
    if (url.includes('publish-public')) {
      if (init?.method === 'POST') {
        const body =
          publishBody ??
          (publishStatus === 200
            ? { url: 'https://open-design.ai/p/slug-1', slug: 'slug-1', fileName: 'index.html' }
            : { error: { message: 'WORKSPACE_IDENTITY_REQUIRED' } });
        return new Response(JSON.stringify(body), { status: publishStatus });
      }
      if (init?.method === 'DELETE') {
        const body =
          unpublishStatus === 200
            ? { ok: true, slug: 'slug-1', fileName: 'index.html' }
            : { error: { message: 'WORKSPACE_IDENTITY_REQUIRED' } };
        return new Response(JSON.stringify(body), { status: unpublishStatus });
      }
      return new Response(JSON.stringify({ publication: null }), { status: 200 });
    }
    return new Response(JSON.stringify({ deployments: [] }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const publication = {
  url: 'https://example.invalid/current-response', slug: 's15', fileName: 'index.html',
};
const props: ComponentProps<typeof FileViewer> = {
  projectKind: 'prototype', projectId: 's15-project', file: htmlFile(),
  liveHtml: '<html><body>S15</body></html>',
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
let write: ReturnType<typeof vi.fn>;
beforeEach(() => {
  analytics.track.mockReset();
  write = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: write } });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
async function setup(options: Parameters<typeof stubFetch>[0] = { publishBody: publication }) {
  const fetch = stubFetch(options);
  const view = renderProjectFileViewer(teamWorkspaceContext(), props);
  fireEvent.click(await screen.findByRole('button', { name: /^share$/i }));
  await screen.findByRole('menuitem', { name: /get a share link/i });
  vi.useFakeTimers();
  return { fetch, view };
}
async function publish() {
  await act(async () => {
    fireEvent.click(screen.getByRole('menuitem', { name: /get a share link/i }));
  });
}
async function tick(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
function posts(fetch: ReturnType<typeof vi.fn>) {
  return fetch.mock.calls.filter(([url, init]) => String(url).includes('publish-public') && init?.method === 'POST');
}
function retry() {
  return screen.getByRole('menuitem', { name: /^retry$/i }) as HTMLButtonElement;
}
const sensitive = 'secret-raw-error-token';
const tooLarge = {
  error: 'too_large', bytes: 20971521, totalBytes: 20971521, limit: 20971520,
  plan: { fileCount: 2, totalBytes: 20971521, exceedsSizeLimit: true, exclusions: [] },
};
const sizeMessage = /exceeds the 20 MiB sharing limit/i;
const genericMessage = /Could not create the share link/i;
it('real 413 too_large ends progress, explains the limit and retries only on demand', async () => {
  const { fetch } = await setup({ publishStatus: 413, publishBody: tooLarge });
  await publish();
  expect(screen.getByText(sizeMessage)).toBeTruthy();
  expect(retry().disabled).toBe(false);
  expect(document.querySelector('progress')).toBeNull();
  expect(document.body.textContent).not.toContain('too_large');
  expect(screen.queryByText(genericMessage)).toBeNull();
  expect(write).not.toHaveBeenCalled();
  await tick(10000);
  expect(posts(fetch)).toHaveLength(1);
  const gate = deferred<Response>();
  fetch.mockImplementationOnce(() => gate.promise);
  await act(async () => fireEvent.click(retry()));
  expect(screen.queryByText(sizeMessage)).toBeNull();
  expect(document.querySelector('progress')!.value).toBe(0);
  await act(async () => gate.resolve(new Response(JSON.stringify(publication), { status: 200 })));
  expect(posts(fetch)).toHaveLength(2);
  expect(posts(fetch)[1]![0]).toBe(posts(fetch)[0]![0]);
  expect(write.mock.calls).toEqual([[publication.url]]);
  expect(screen.queryByText(sizeMessage)).toBeNull();
});
it.each([[413, { error: 'unknown_limit', message: sensitive }], [500, { error: 'too_large' }]])(
  'does not misclassify status %s or an unknown 413', async (publishStatus, publishBody) => {
    await setup({ publishStatus, publishBody });
    await publish();
    expect(screen.queryByText(sizeMessage)).toBeNull();
    expect(screen.getByText(genericMessage)).toBeTruthy();
    expect(retry().disabled).toBe(false);
    expect(document.body.textContent).not.toContain(sensitive);
    expect(write).not.toHaveBeenCalled();
  });
it.each(['file', 'project'] as const)('clears over-limit error when changing %s', async change => {
  const { view, fetch } = await setup({ publishStatus: 413, publishBody: tooLarge });
  await publish();
  expect(screen.getByText(sizeMessage)).toBeTruthy();
  await act(async () => view.rerenderWith({
    ...props,
    ...(change === 'project' ? { projectId: 'next-project' } :
      { file: { ...htmlFile(), name: 'next.html', path: 'next.html' } }),
  }));
  expect(screen.queryByText(sizeMessage)).toBeNull();
  expect(posts(fetch)).toHaveLength(1);
});
