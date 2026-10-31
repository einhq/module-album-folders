/**
 * Album folders against EiN: a pass compares the folders under some path with the albums there.
 *
 * Every album at or under the path is listed, its members asked of `members-album` (the archive's
 * rules: the imported `files/` layout, linked photos, the cover left out), and its folder made to
 * hold one hard link per member to the member's stored file. A folder standing for no album there
 * loses its files, and a folder left empty goes unless an album still stands for it.
 *
 * A member whose stored file is itself a link to an original kept elsewhere (media imported from
 * the old system) or has no file on disk is left out: a hard link can only be made to a file on
 * the same mount.
 *
 * Nothing is written to EiN. Only the folders change, and with `dryRun` not even those.
 */

import { join } from '@std/path';
import { type Command, type ContainerListing, NodeNotFoundError, type NodeQueryCursor, shq } from '@ein/client';
import { ALBUMS_ROOT } from '@archive/paths';
import type { AlbumFoldersSync, SkipReason } from '@album-folders/api';
import { applyPlan, countFiles, ensureFolder, foldersUnder, pruneEmpty, readFolder, writeMarker } from '@album-folders/folder';
import { folderOf, memberNames, pathOfFolder, planFolder, type Wanted } from '@album-folders/plan';

/** Rows per page of the album query. */
const ALBUM_PAGE = 500;
/** Albums compared at once. */
const ALBUM_CONCURRENCY = 4;
/** Members of one album whose stored file is looked up at once. */
const STAT_CONCURRENCY = 16;
/** A full pass that would empty more than this share of the files there stops instead. */
const MASS_REMOVAL_SHARE = 0.5;
/** Below this many files, a full pass empties whatever it must. */
const MASS_REMOVAL_FLOOR = 20;

/** Where the album folders are: the setting, else `albums` beside the stored files. */
export const albumFoldersRoot = (cmd: Command): string => {
  const root = cmd.env.CFG_ALBUM_FOLDERS_PATH || (cmd.env.EIN_FILE_ROOT_PATH ? join(cmd.env.EIN_FILE_ROOT_PATH, 'albums') : '');
  if (!root) throw new Error('no location for the album folders: set CFG_ALBUM_FOLDERS_PATH');
  return root.replace(/\/+$/, '');
};

const emptyReport = (root: string, dryRun: boolean): AlbumFoldersSync => ({
  root,
  albums: 0,
  linked: 0,
  removed: 0,
  kept: 0,
  skipped: { external: 0, unstored: 0 },
  truncated: [],
  dryRun,
});

const mapLimit = async <T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> => {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  }));
  return results;
};

export class AlbumFolders {
  /** Which albums each file was last seen in, so a deleted file's albums can be checked. */
  private readonly albumsByFile = new Map<string, Set<string>>();
  private readonly filesByAlbum = new Map<string, Set<string>>();
  /**
   * What each file's stored bytes were found to be, by id. A file's tier is fixed and its bytes
   * are rewritten in place, so the answer holds for as long as the file exists, and a pass after
   * the first looks up only the files it has not seen. A file without bytes on disk is asked again,
   * since that may be a lookup that failed.
   */
  private readonly stored = new Map<string, { source: string; ino: number } | { skip: 'external' }>();

  constructor(
    private readonly cmd: Command,
    readonly root: string,
    private readonly dryRun = false,
    /** Whether to stop: a pass then ends after the albums in hand, and says nothing of the rest. */
    private readonly stopped: () => boolean = () => false,
  ) {}

  /** The albums the file `id` was in when they were last compared. */
  albumsOf(id: string): string[] {
    return [...this.albumsByFile.get(id) ?? []];
  }

  /** Forget what was found of a file's bytes: the file is gone. */
  forgetFile(id: string): void {
    this.stored.delete(id);
  }

  /** Compare the folders at and under `path` with the albums there. */
  async check(path: string): Promise<AlbumFoldersSync> {
    return await this.pass(path, await this.albumsWithin(path));
  }

  /**
   * Compare every folder with every album, and record it in the marker. Stops without a change
   * when it would empty more than half the files there, which is what an archive not yet
   * mounted, or emptied by mistake, would look like; `force` goes ahead.
   */
  async full(force = false): Promise<AlbumFoldersSync> {
    const albums = await this.albumsWithin(ALBUMS_ROOT);
    if (!force) {
      let total = 0;
      let orphaned = 0;
      for (const folder of await foldersUnder(this.root)) {
        const files = await countFiles(folder);
        total += files;
        if (!albums.has(pathOfFolder(this.root, ALBUMS_ROOT, folder))) orphaned += files;
      }
      if (total >= MASS_REMOVAL_FLOOR && orphaned > total * MASS_REMOVAL_SHARE) {
        throw new Error(`${this.root}: ${orphaned} of ${total} files belong to no album; not removing them (--force does)`);
      }
    }
    const report = await this.pass(ALBUMS_ROOT, albums);
    if (!this.dryRun && !this.stopped()) await writeMarker(this.root, { ...report, at: new Date().toISOString() });
    return report;
  }

  private async pass(path: string, albums: Set<string>): Promise<AlbumFoldersSync> {
    const report = emptyReport(this.root, this.dryRun);
    await mapLimit([...albums].sort(), ALBUM_CONCURRENCY, async (album) => {
      if (this.stopped()) return;
      try {
        await this.album(album, report);
        report.albums++;
      } catch (error) {
        if (this.stopped()) return;
        await this.cmd.writeError(`album-folders: ${album}: ${error instanceof Error ? error.message : error}\n`);
      }
    });

    // A pass cut short has not seen every album, so it removes nothing.
    if (this.stopped()) return report;
    // Deepest first, so a folder emptied here is seen empty by its parent.
    for (const folder of await foldersUnder(folderOf(this.root, ALBUMS_ROOT, path))) {
      const album = pathOfFolder(this.root, ALBUMS_ROOT, folder);
      if (albums.has(album)) continue;
      const plan = planFolder([], await readFolder(folder));
      report.removed += plan.remove.length;
      this.forget(album);
      if (this.dryRun) continue;
      await applyPlan(folder, plan);
      await pruneEmpty(this.root, folder, (kept) => this.standsForAlbum(pathOfFolder(this.root, ALBUMS_ROOT, kept)));
    }
    return report;
  }

  /** Make the folder of `album` hold its members. */
  private async album(album: string, report: AlbumFoldersSync): Promise<void> {
    const ran = await this.cmd.execute(`JSON_OUTPUT=1 members-album ${shq(album)}`);
    if (ran.code !== 0) throw new Error(`members-album: ${`${ran.stderr ?? ''}`.trim() || `exit ${ran.code}`}`);
    const listing = JSON.parse(`${ran.stdout ?? ''}`) as ContainerListing;
    if (listing.truncated) report.truncated.push(album);

    const names = memberNames(listing.members);
    const found = await mapLimit(listing.members, STAT_CONCURRENCY, async (member) => await this.storedFile(member.id, member.path));
    const wanted: Wanted[] = [];
    found.forEach((file, index) => {
      if ('skip' in file) report.skipped[file.skip]++;
      else wanted.push({ name: names[index], ...file });
    });

    const folder = folderOf(this.root, ALBUMS_ROOT, album);
    const plan = planFolder(wanted, await readFolder(folder));
    report.linked += plan.link.length;
    report.removed += plan.remove.length;
    report.kept += plan.kept;
    this.remember(album, listing.members.map((member) => member.id));
    if (this.dryRun) return;
    await ensureFolder(this.root, folder);
    await applyPlan(folder, plan);
  }

  /** Where the bytes of the file `id` at `path` are on disk, or why it has no file to link. */
  private async storedFile(id: string, path: string): Promise<{ source: string; ino: number } | { skip: SkipReason }> {
    const known = this.stored.get(id);
    if (known) return known;
    const found = await this.lookUpStored(path);
    if (!('skip' in found) || found.skip === 'external') this.stored.set(id, found as { source: string; ino: number } | { skip: 'external' });
    return found;
  }

  private async lookUpStored(path: string): Promise<{ source: string; ino: number } | { skip: SkipReason }> {
    let source: unknown;
    try {
      source = (await this.cmd.sys.vfs.stat(this.cmd.access, path)).path;
    } catch {
      return { skip: 'unstored' };
    }
    if (typeof source !== 'string' || !source) return { skip: 'unstored' };
    // Bytes on another tier are on another mount, which no hard link reaches.
    const diskRoot = this.cmd.env.EIN_FILE_ROOT_PATH?.replace(/\/+$/, '');
    if (diskRoot && !source.startsWith(`${diskRoot}/`)) return { skip: 'unstored' };
    try {
      const info = await Deno.lstat(source);
      if (info.isSymlink) return { skip: 'external' };
      return info.isFile && info.ino !== null ? { source, ino: info.ino } : { skip: 'unstored' };
    } catch {
      return { skip: 'unstored' };
    }
  }

  /** The albums at and under `path`; none when it is gone. */
  private async albumsWithin(path: string): Promise<Set<string>> {
    const albums = new Set<string>();
    let node;
    try {
      node = await this.cmd.sys.vfs.get(this.cmd.access, path);
    } catch (error) {
      if (error instanceof NodeNotFoundError) return albums;
      throw error;
    }
    if (node.type === 'album') albums.add(path);
    if (node.type !== 'album' && node.type !== 'directory') return albums;

    let after: NodeQueryCursor | undefined;
    for (;;) {
      const rows = await this.cmd.sys.vfs.query(this.cmd.access, { within: path, types: ['album'], after, limit: ALBUM_PAGE });
      for (const row of rows) albums.add(row.absPath);
      if (rows.length < ALBUM_PAGE) return albums;
      after = { value: null, id: rows[rows.length - 1].id };
    }
  }

  /** Whether `path` is an album, or holds one, so its folder stays even when empty. */
  private async standsForAlbum(path: string): Promise<boolean> {
    try {
      const node = await this.cmd.sys.vfs.get(this.cmd.access, path);
      if (node.type === 'album') return true;
      return node.type === 'directory' && (await this.cmd.sys.vfs.query(this.cmd.access, { within: path, types: ['album'], limit: 1 })).length > 0;
    } catch {
      return false;
    }
  }

  private remember(album: string, ids: string[]): void {
    this.forget(album);
    const files = new Set(ids);
    this.filesByAlbum.set(album, files);
    for (const id of files) {
      const albums = this.albumsByFile.get(id) ?? new Set<string>();
      albums.add(album);
      this.albumsByFile.set(id, albums);
    }
  }

  private forget(album: string): void {
    for (const id of this.filesByAlbum.get(album) ?? []) {
      const albums = this.albumsByFile.get(id);
      albums?.delete(album);
      if (albums?.size === 0) this.albumsByFile.delete(id);
    }
    this.filesByAlbum.delete(album);
  }
}
