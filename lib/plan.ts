/**
 * The planning half of album folders, without the disk or the VFS: which name each member gets,
 * where an album's folder is, and what turns a folder into its album.
 *
 * A folder's files are compared with its album by inode. A file that is a hard link to the
 * member's stored file is in place; anything else under a wanted name is replaced, and a file no
 * member wants is removed. Folders are left to the caller: a folder inside an album's folder is
 * another album's.
 */

import { basename, extname } from '@std/path';
import type { ContainerMember } from '@ein/client';

/** The file marking a folder as the album folders; it holds the last full pass. */
export const MARKER_NAME = '.ein-album-folders';

/** Names the folders' own bookkeeping uses: the marker, and the temporary name a link is made under. */
export const isReservedName = (name: string): boolean => name.startsWith(MARKER_NAME);

/** A temporary name in a folder, renamed over the wanted one once the link is made. */
export const temporaryName = (): string => `${MARKER_NAME}.tmp-${crypto.randomUUID()}`;

/**
 * Each member's file name in its album's folder: the name it has in the album, which for a linked
 * photo is the link's, with the stored file's extension added when that name lacks it. Two members
 * with one name (only a name given an extension can clash) are told apart as `name (2).jpg`.
 */
export const memberNames = (members: Pick<ContainerMember, 'path' | 'memberPath'>[]): string[] => {
  const taken = new Set<string>();
  return members.map((member) => {
    let name = basename(member.memberPath ?? member.path);
    const ext = extname(member.path);
    if (ext && extname(name).toLowerCase() !== ext.toLowerCase()) name += ext;
    if (isReservedName(name)) name = `_${name}`;
    let unique = name;
    for (let n = 2; taken.has(unique); n++) unique = `${name.slice(0, name.length - extname(name).length)} (${n})${extname(name)}`;
    taken.add(unique);
    return unique;
  });
};

/** Where the folder of the EiN path `path`, at or under `albumsRoot`, is under `root`. */
export const folderOf = (root: string, albumsRoot: string, path: string): string => path === albumsRoot ? root : `${root}${path.slice(albumsRoot.length)}`;

/** The EiN path a folder under `root` stands for. */
export const pathOfFolder = (root: string, albumsRoot: string, folder: string): string => folder === root ? albumsRoot : `${albumsRoot}${folder.slice(root.length)}`;

/** Whether `path` is `parent` or lies under it. */
export const isWithin = (path: string, parent: string): boolean => path === parent || path.startsWith(parent === '/' ? '/' : `${parent}/`);

/** The paths of `paths` no other one holds: reconciling those covers all of them. */
export const outermost = (paths: Iterable<string>): string[] => {
  const sorted = [...new Set(paths)].sort();
  const kept: string[] = [];
  for (const path of sorted) if (!kept.some((outer) => isWithin(path, outer))) kept.push(path);
  return kept;
};

/** A member's file as the folder wants it: under `name`, a hard link to `source`. */
export type Wanted = { name: string; source: string; ino: number };

/** An entry found in a folder. */
export type Present = { name: string; kind: 'file' | 'directory' | 'other'; ino: number };

export type FolderPlan = {
  /** Files to link, or to link again because the name holds something else. */
  link: Wanted[];
  /** Names to remove: files no member wants. */
  remove: string[];
  /** How many wanted files are already in place. */
  kept: number;
};

/** What makes the folder holding `present` hold exactly `wanted`, leaving folders and bookkeeping alone. */
export const planFolder = (wanted: Wanted[], present: Present[]): FolderPlan => {
  const found = new Map(present.filter((entry) => !isReservedName(entry.name)).map((entry) => [entry.name, entry]));
  const plan: FolderPlan = { link: [], remove: [], kept: 0 };
  const wantedNames = new Set<string>();

  for (const entry of wanted) {
    wantedNames.add(entry.name);
    const there = found.get(entry.name);
    if (there?.kind === 'file' && there.ino === entry.ino) plan.kept++;
    // A folder under a member's name is another album's; the member waits until it goes.
    else if (there?.kind !== 'directory') plan.link.push(entry);
  }
  for (const [name, entry] of found) {
    if (entry.kind !== 'directory' && !wantedNames.has(name)) plan.remove.push(name);
  }
  return plan;
};
