/**
 * The disk half of album folders: the root and its marker, and changing a folder while keeping
 * every folder read-only.
 *
 * Folders are `r-x` for everyone, the root included, so a file manager browsing them can neither
 * add, rename nor remove anything. A change makes the one folder it touches writable for its
 * duration. The files keep the stored files' own mode: a hard link is the same file, so changing
 * its mode would change the stored file's.
 */

import { dirname, join } from '@std/path';
import type { AlbumFoldersStatus } from '@album-folders/api';
import { type FolderPlan, isReservedName, MARKER_NAME, type Present, temporaryName } from '@album-folders/plan';

const FOLDER_MODE = 0o555;
const WRITABLE_MODE = 0o755;

const exists = async (path: string): Promise<boolean> => {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
};

/** Run `fn` with `dir` writable, then make it read-only again. */
const withWritable = async <T>(dir: string, fn: () => Promise<T>): Promise<T> => {
  await Deno.chmod(dir, WRITABLE_MODE);
  try {
    return await fn();
  } finally {
    await Deno.chmod(dir, FOLDER_MODE).catch(() => {});
  }
};

/**
 * Make `root` the album folders, or check that it is: a new or empty folder gets the marker, a
 * marked one is taken as it is, and anything else is refused, since a pass removes every file
 * there that no album wants.
 */
export const openRoot = async (root: string): Promise<void> => {
  if (!root.startsWith('/')) throw new Error(`${root}: the album folders location must be an absolute path`);
  if (!(await exists(root))) await Deno.mkdir(root, { recursive: true });
  if (await exists(join(root, MARKER_NAME))) return;

  for await (const _ of Deno.readDir(root)) {
    throw new Error(`${root}: holds files but no ${MARKER_NAME}; not taken as the album folders`);
  }
  await withWritable(root, () => Deno.writeTextFile(join(root, MARKER_NAME), '{}\n'));
};

/** What the marker records of the last full pass. */
export const readMarker = async (root: string): Promise<AlbumFoldersStatus['last'] | undefined> => {
  try {
    const last = JSON.parse(await Deno.readTextFile(join(root, MARKER_NAME)));
    return last && typeof last === 'object' && 'at' in last ? last : undefined;
  } catch {
    return undefined;
  }
};

/** Record a full pass in the marker, written in place: the folder stays read-only. */
export const writeMarker = async (root: string, last: NonNullable<AlbumFoldersStatus['last']>): Promise<void> => {
  await Deno.writeTextFile(join(root, MARKER_NAME), `${JSON.stringify(last)}\n`);
};

/** Whether `root` is marked as the album folders. */
export const isMarked = (root: string): Promise<boolean> => exists(join(root, MARKER_NAME));

/** Create `folder` under `root` and every folder between, each read-only. */
export const ensureFolder = async (root: string, folder: string): Promise<void> => {
  if (folder === root || (await exists(folder))) return;
  const parent = dirname(folder);
  await ensureFolder(root, parent);
  await withWritable(parent, async () => {
    await Deno.mkdir(folder);
    await Deno.chmod(folder, FOLDER_MODE);
  });
};

/** The entries of `folder`, none when it does not exist. */
export const readFolder = async (folder: string): Promise<Present[]> => {
  const entries: Present[] = [];
  try {
    for await (const entry of Deno.readDir(folder)) {
      const info = await Deno.lstat(join(folder, entry.name));
      entries.push({ name: entry.name, kind: info.isFile ? 'file' : info.isDirectory ? 'directory' : 'other', ino: info.ino ?? -1 });
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
  return entries;
};

/** A link across mounts, which no hard link can be. */
const isCrossDevice = (error: unknown): boolean => error instanceof Error && /os error 18\b|cross-device/i.test(error.message);

/**
 * Carry out `plan` in `folder`. A file is linked under a temporary name and renamed over the
 * wanted one, so a reader sees the old file or the new, never neither.
 */
export const applyPlan = async (folder: string, plan: FolderPlan): Promise<void> => {
  if (plan.link.length === 0 && plan.remove.length === 0) return;
  await withWritable(folder, async () => {
    for (const entry of plan.link) {
      const temporary = join(folder, temporaryName());
      try {
        await Deno.link(entry.source, temporary);
      } catch (error) {
        if (isCrossDevice(error)) throw new Error(`${folder}: not on the same mount as the stored files (${entry.source}); a hard link cannot cross mounts`);
        // The stored file went between reading the album and linking it: the next pass settles it.
        if (error instanceof Deno.errors.NotFound) continue;
        throw error;
      }
      await Deno.rename(temporary, join(folder, entry.name));
    }
    for (const name of plan.remove) {
      await Deno.remove(join(folder, name)).catch((error) => {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      });
    }
  });
};

/** Every folder under `folder`, `folder` included, the deepest first. */
export const foldersUnder = async (folder: string): Promise<string[]> => {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readFolder(dir)) if (entry.kind === 'directory') await walk(join(dir, entry.name));
    found.push(dir);
  };
  if (await exists(folder)) await walk(folder);
  return found;
};

/** How many files `folder` holds, its own bookkeeping aside. */
export const countFiles = async (folder: string): Promise<number> =>
  (await readFolder(folder)).filter((entry) => entry.kind !== 'directory' && !isReservedName(entry.name)).length;

/**
 * Remove `folder` if it is empty, and each folder above it up to `root` that this leaves empty,
 * stopping at one `keep` says stays: an empty album still has its folder.
 */
export const pruneEmpty = async (root: string, folder: string, keep: (folder: string) => Promise<boolean>): Promise<void> => {
  for (let dir = folder; dir !== root && dir.startsWith(`${root}/`); dir = dirname(dir)) {
    if (!(await exists(dir))) continue;
    if ((await readFolder(dir)).length > 0 || (await keep(dir))) return;
    await withWritable(dirname(dir), () => Deno.remove(dir));
  }
};
