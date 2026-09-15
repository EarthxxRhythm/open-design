// @vitest-environment jsdom
//
// OPEND-3129: a project with nothing to report leads with ONE default glyph in
// both places that list projects — the rail's 最近项目 rows and the project
// switcher above the chat. The two already share `ProjectRunStatusIcon` for a
// project that has a run to report (OPEND-2795); before this, the idle case
// diverged (the rail drew a chat mark, the switcher drew a folder), so one and
// the same project looked like two different things depending on where the
// user found it.

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RailRecentRow } from '../../src/components/entry-nav-rail/RailRecentRow';
import { WorkspaceTabsBar } from '../../src/components/WorkspaceTabsBar';
import { setWorkspaceTabsDock } from '../../src/components/workspaceTabsDock';
import { I18nProvider } from '../../src/i18n';
import type { Route } from '../../src/router';
import type { Project } from '../../src/types';

vi.mock('../../src/router', async () => {
  const actual = await vi.importActual<typeof import('../../src/router')>('../../src/router');
  return { ...actual, navigate: vi.fn() };
});

const project: Project = {
  id: 'project-idle',
  name: 'Project Idle',
  skillId: null,
  designSystemId: null,
  createdAt: 1,
  updatedAt: 1,
};

const projectRoute: Route = {
  kind: 'project',
  projectId: project.id,
  conversationId: null,
  fileName: null,
};

const originalFetch = globalThis.fetch;
const dock = document.createElement('div');

/** The runs feed answers "nothing ever ran here" for every project. */
function stubQuietRunsFeed() {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('/api/runs?projectId=')) {
      return new Response(JSON.stringify({ runs: [], awaitingInputProjectIds: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
}

/** The `data-testid` of the glyph a lead slot holds, or null when it has none. */
function glyphTestIdIn(slot: Element): string | null {
  return slot.firstElementChild?.getAttribute('data-testid') ?? null;
}

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
  document.body.append(dock);
  setWorkspaceTabsDock(dock);
  stubQuietRunsFeed();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  setWorkspaceTabsDock(null);
  dock.remove();
});

describe('idle project glyph (OPEND-3129)', () => {
  it('leads an idle project with the same glyph in the rail row and in the tab switcher', async () => {
    render(
      <I18nProvider initial="en">
        <RailRecentRow project={project} />
        <WorkspaceTabsBar route={{ ...projectRoute }} projects={[project]} />
      </I18nProvider>,
    );

    const railSlot = within(screen.getByTestId('entry-nav-recent-item'))
      .getByText(project.name).previousElementSibling;
    expect(railSlot?.className).toBe('entry-nav-rail__recent-icon');

    fireEvent.click(await screen.findByTestId('workspace-tabs-dropdown-trigger'));
    const listbox = screen.getByRole('listbox');
    const row = within(listbox).getByRole('option', { name: /Project Idle/ });
    // Let the (empty) runs feed settle so the switcher is not still deciding.
    await waitFor(() => {
      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        expect.stringContaining('/api/runs?projectId='),
        expect.anything(),
      );
    });
    const switcherSlot = row.querySelector('.workspace-tabs-dropdown__row-lead');
    expect(switcherSlot).not.toBeNull();

    const railGlyph = glyphTestIdIn(railSlot!);
    const switcherGlyph = glyphTestIdIn(switcherSlot!);
    // Both slots hold the shared idle glyph — one named component, not two
    // drawings that happen to agree today.
    expect(railGlyph).toBe('project-idle-glyph');
    expect(switcherGlyph).toBe('project-idle-glyph');
    expect(railGlyph).toBe(switcherGlyph);
  });
});
