/**
 * What `album-folders` answers in JSON mode. Import-free, so other modules and pages can import it.
 */

/** Why a member has no file in its album's folder. */
export type SkipReason =
  /** Its stored file is a link to an original kept elsewhere (media imported from the old system). */
  | 'external'
  /** It has no file on disk: its bytes are kept in the database. */
  | 'unstored';

/** What one pass over some albums did, or with `--dry-run` would do. */
export type AlbumFoldersSync = {
  /** The folder the albums are kept in. */
  root: string;
  /** Albums whose folders were compared. */
  albums: number;
  /** Files linked into a folder, or linked again because the stored file changed. */
  linked: number;
  /** Files taken out of a folder: no longer in the album, or the album is gone. */
  removed: number;
  /** Files already in place. */
  kept: number;
  /** Members left out, by reason. */
  skipped: Record<SkipReason, number>;
  /** Albums with more members than are listed; only the listed ones have files. */
  truncated: string[];
  dryRun: boolean;
};

/** `album-folders status`: the folder, and what the last full pass found. */
export type AlbumFoldersStatus = {
  root: string;
  /** Whether the folder exists and is marked as the album folders. */
  ready: boolean;
  /** The last full pass, when there has been one. */
  last?: AlbumFoldersSync & { at: string };
};
