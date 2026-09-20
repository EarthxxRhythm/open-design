import type Database from 'better-sqlite3';

type SqliteDb = Database.Database;

export interface PublicFilePublicationScope {
  resourceTeamId: string;
  ownerMemberId: string;
  projectId: string;
  filePath: string;
}

export interface PublicFilePublication {
  url: string;
  slug: string;
  fileName: string;
}

export interface PublicFilePublicationStore {
  get(scope: PublicFilePublicationScope): PublicFilePublication | null;
  set(
    scope: PublicFilePublicationScope,
    publication: PublicFilePublication,
  ): void;
  delete(scope: PublicFilePublicationScope): void;
}

/** Full store capability for consumers that enumerate project publications. */
export interface ProjectPublicFilePublicationStore extends PublicFilePublicationStore {
  /** Lists this principal's project with the most recent successful publish time in epoch ms. */
  listByProject(scope: {
    resourceTeamId: string;
    ownerMemberId: string;
    projectId: string;
  }): ReadonlyArray<{
    filePath: string;
    slug: string;
    publishedAt: number;
  }>;
}

export function migratePublicFilePublications(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS public_file_publications (
      resource_team_id TEXT NOT NULL,
      owner_member_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      url TEXT NOT NULL,
      slug TEXT NOT NULL,
      file_name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (resource_team_id, owner_member_id, project_id, file_path)
    );
  `);
}

function scopeKey(scope: PublicFilePublicationScope): string {
  return JSON.stringify([
    scope.resourceTeamId,
    scope.ownerMemberId,
    scope.projectId,
    scope.filePath,
  ]);
}

// Use the same locale-independent ordering for both backends, including Unicode paths.
function comparePublicationFilePaths(a: { filePath: string }, b: { filePath: string }): number {
  if (a.filePath === b.filePath) return 0;
  return a.filePath < b.filePath ? -1 : 1;
}

export function createInMemoryPublicFilePublicationStore(): ProjectPublicFilePublicationStore {
  const publications = new Map<string, {
    scope: PublicFilePublicationScope;
    publication: PublicFilePublication;
    publishedAt: number;
  }>();
  return {
    get: (scope) => publications.get(scopeKey(scope))?.publication ?? null,
    listByProject: (scope) => [...publications.values()]
      .filter((entry) => entry.scope.resourceTeamId === scope.resourceTeamId
        && entry.scope.ownerMemberId === scope.ownerMemberId
        && entry.scope.projectId === scope.projectId)
      .map((entry) => ({
        filePath: entry.scope.filePath,
        slug: entry.publication.slug,
        publishedAt: entry.publishedAt,
      }))
      .sort(comparePublicationFilePaths),
    set: (scope, publication) => {
      publications.set(scopeKey(scope), {
        scope: { ...scope },
        publication,
        publishedAt: Date.now(),
      });
    },
    delete: (scope) => {
      publications.delete(scopeKey(scope));
    },
  };
}

/**
 * Persist public snapshot identities under the exact resource-hub principal
 * that created them. There is deliberately no project foreign key: deleting a
 * local project must not erase the slug needed to redact its still-public
 * remote snapshot.
 */
export function createSqlitePublicFilePublicationStore(
  db: SqliteDb,
  now: () => number = Date.now,
): ProjectPublicFilePublicationStore {
  const selectRow = db.prepare(`
    SELECT url, slug, file_name AS fileName
      FROM public_file_publications
     WHERE resource_team_id = ?
       AND owner_member_id = ?
       AND project_id = ?
       AND file_path = ?
  `);
  const selectProjectRows = db.prepare(`
    SELECT file_path AS filePath, slug, updated_at AS publishedAt
      FROM public_file_publications
     WHERE resource_team_id = ?
       AND owner_member_id = ?
       AND project_id = ?
  `);
  const upsertRow = db.prepare(`
    INSERT INTO public_file_publications
      (resource_team_id, owner_member_id, project_id, file_path,
       url, slug, file_name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(resource_team_id, owner_member_id, project_id, file_path)
    DO UPDATE SET
      url = excluded.url,
      slug = excluded.slug,
      file_name = excluded.file_name,
      updated_at = excluded.updated_at
  `);
  const deleteRow = db.prepare(`
    DELETE FROM public_file_publications
     WHERE resource_team_id = ?
       AND owner_member_id = ?
       AND project_id = ?
       AND file_path = ?
  `);

  return {
    get(scope) {
      const row = selectRow.get(
        scope.resourceTeamId,
        scope.ownerMemberId,
        scope.projectId,
        scope.filePath,
      ) as { url?: unknown; slug?: unknown; fileName?: unknown } | undefined;
      if (
        !row
        || typeof row.url !== 'string'
        || typeof row.slug !== 'string'
        || typeof row.fileName !== 'string'
      ) {
        return null;
      }
      return { url: row.url, slug: row.slug, fileName: row.fileName };
    },
    listByProject(scope) {
      const rows = selectProjectRows.all(
        scope.resourceTeamId,
        scope.ownerMemberId,
        scope.projectId,
      ) as Array<{ filePath: string; slug: string; publishedAt: number }>;
      return rows.map((row) => ({
        filePath: row.filePath,
        slug: row.slug,
        publishedAt: row.publishedAt,
      })).sort(comparePublicationFilePaths);
    },
    set(scope, publication) {
      const timestamp = now();
      upsertRow.run(
        scope.resourceTeamId,
        scope.ownerMemberId,
        scope.projectId,
        scope.filePath,
        publication.url,
        publication.slug,
        publication.fileName,
        timestamp,
        timestamp,
      );
    },
    delete(scope) {
      deleteRow.run(
        scope.resourceTeamId,
        scope.ownerMemberId,
        scope.projectId,
        scope.filePath,
      );
    },
  };
}
