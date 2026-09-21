import type { WorkspaceCollabContext } from '@open-design/contracts';
import type { ProjectPublicFilePublicationStore } from './public-file-publication-store.js';
import type { LocalProjectCommentWorkspaceBinding } from './project-comment-workspace-context.js';

export interface CommentRelayScope {
  workspaceId: string;
  teamId: string;
  ownerMemberId: string;
  relayScope: 'team' | 'personal';
}

/**
 * The relay eligibility channel is deliberately separate from team-directory
 * identity. A personal project may relay only when its persisted creator owns
 * an active publication for the comment's exact file; no commenter identity
 * and no member-directory lookup can widen that scope.
 */
export function commentRelayScope(input: {
  binding: LocalProjectCommentWorkspaceBinding | undefined;
  context: WorkspaceCollabContext | null;
  projectId: string;
  filePath: string;
  publications: ProjectPublicFilePublicationStore;
}): CommentRelayScope | null {
  const { binding, context } = input;
  const workspaceId = binding?.workspaceId?.trim() ?? '';
  const ownerMemberId = binding?.createdByWorkspaceMemberId?.trim() ?? '';
  if (!context || !workspaceId || !ownerMemberId || binding?.resourceState === 'deleted') return null;
  if (context.workspaceId !== workspaceId || context.memberStatus !== 'active' || context.lifecycleState === 'deleted') return null;
  if (binding?.visibility === 'team' && context.workspaceType === 'team') {
    return { workspaceId, teamId: context.teamId?.trim() || workspaceId, ownerMemberId, relayScope: 'team' };
  }
  if (binding?.visibility !== 'personal' || context.workspaceType !== 'personal' || context.workspaceMemberId !== ownerMemberId) return null;
  const publications = input.publications.listByProject({ resourceTeamId: workspaceId, ownerMemberId, projectId: input.projectId });
  return publications.some((publication) => publication.filePath === input.filePath)
    ? { workspaceId, teamId: workspaceId, ownerMemberId, relayScope: 'personal' }
    : null;
}
