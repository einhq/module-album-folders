/**
 * Which VFS events change an album's folder, and which albums each one names.
 *
 * Membership is the archive's (`members-album`); these only say where to look again. An album
 * announces its own membership changes (`child-attached`, `child-detached` carry the album), and
 * being created, moved or deleted; a recursive delete announces every album inside. An imported
 * album keeps its media in `files/`, a plain directory: what leaves it is that directory's
 * `child-detached`, what arrives is the file's own `created` or `moved`. A directory of albums
 * moving announces itself alone. A file deleted elsewhere leaves a dangling link in each album
 * that linked it and no event on the album, so the albums a file was seen in are looked up by
 * its id.
 *
 * `directory.child-attached` is not bound: it fires for every thumbnail and pipeline node of every
 * file. `file.created` and `file.deleted` are busy too, but rejected on a string test or a map
 * lookup.
 */

import { basename, dirname } from '@std/path';
import { isWithin } from '@album-folders/plan';

export const ALBUM_FOLDERS_ROUTING_KEYS = [
  'system.vfs.album.created',
  'system.vfs.album.deleted',
  'system.vfs.album.moved',
  'system.vfs.album.child-attached',
  'system.vfs.album.child-detached',
  'system.vfs.directory.moved',
  'system.vfs.directory.child-detached',
  'system.vfs.file.created',
  'system.vfs.file.moved',
  'system.vfs.file.deleted',
];

/** A VFS event as a queue delivers it. */
export type FolderEvent = {
  type: string;
  nodeType: string;
  path: string;
  nodeId: string;
  /** Where the node was, on `moved`. */
  fromPath?: string;
};

/** The lone media directory of an imported album. */
const FILES_DIR_NAME = 'files';

/** The album an imported album's `files/` at `dir` belongs to, by name alone. */
const albumOfFilesDir = (dir: string): string | undefined => basename(dir) === FILES_DIR_NAME ? dirname(dir) : undefined;

/**
 * The paths whose folders `event` may have changed, each to be compared again with all it holds.
 * `albumsOf` answers the albums a file id was last seen in. Only paths at or under `albumsRoot`.
 */
export const pathsToCheck = (event: FolderEvent, albumsRoot: string, albumsOf: (id: string) => Iterable<string>): string[] => {
  const paths: (string | undefined)[] = [];
  switch (`${event.nodeType}.${event.type}`) {
    case 'album.created':
    case 'album.deleted':
    case 'album.child-attached':
    case 'album.child-detached':
      paths.push(event.path);
      break;
    case 'album.moved':
    case 'directory.moved':
      paths.push(event.path, event.fromPath);
      break;
    case 'directory.child-detached':
      paths.push(albumOfFilesDir(event.path));
      break;
    case 'file.created':
      paths.push(albumOfFilesDir(dirname(event.path)));
      break;
    case 'file.moved':
      paths.push(albumOfFilesDir(dirname(event.path)), event.fromPath && albumOfFilesDir(dirname(event.fromPath)));
      break;
    case 'file.deleted':
      paths.push(...albumsOf(event.nodeId));
      break;
  }
  return [...new Set(paths.filter((path): path is string => !!path && isWithin(path, albumsRoot)))];
};
