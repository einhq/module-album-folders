/**
 * The planning half of album folders: member names, where folders are, and what turns a folder
 * into its album.
 */

import { assertEquals } from '@std/assert';
import { folderOf, MARKER_NAME, memberNames, outermost, pathOfFolder, planFolder, type Present } from '@album-folders/plan';
import { pathsToCheck } from '@album-folders/events';

const ALBUMS = '/archive/albums';

Deno.test("a member is named as in its album, with the stored file's extension when the name lacks it", () => {
  assertEquals(
    memberNames([
      { path: `${ALBUMS}/lake/files/IMG_0001.jpg` },
      { path: '/home/anna/IMG_0002.JPG', memberPath: `${ALBUMS}/lake/IMG_0002.JPG` },
      { path: '/home/anna/IMG_0003.jpg', memberPath: `${ALBUMS}/lake/m1` },
      { path: '/home/anna/other/m1.jpg', memberPath: `${ALBUMS}/lake/m1.jpg` },
      { path: `${ALBUMS}/lake/${MARKER_NAME}` },
    ]),
    ['IMG_0001.jpg', 'IMG_0002.JPG', 'm1.jpg', 'm1 (2).jpg', `_${MARKER_NAME}`],
  );
});

Deno.test('folders stand for the paths under the albums root', () => {
  assertEquals(folderOf('/files/albums', ALBUMS, ALBUMS), '/files/albums');
  assertEquals(folderOf('/files/albums', ALBUMS, `${ALBUMS}/travel/rome`), '/files/albums/travel/rome');
  assertEquals(pathOfFolder('/files/albums', ALBUMS, '/files/albums/travel/rome'), `${ALBUMS}/travel/rome`);
  assertEquals(pathOfFolder('/files/albums', ALBUMS, '/files/albums'), ALBUMS);
});

Deno.test('a folder is planned by inode, leaving folders and bookkeeping alone', () => {
  const present: Present[] = [
    { name: 'kept.jpg', kind: 'file', ino: 1 },
    { name: 'changed.jpg', kind: 'file', ino: 2 },
    { name: 'gone.jpg', kind: 'file', ino: 3 },
    { name: 'stray-link', kind: 'other', ino: 4 },
    { name: 'nested-album', kind: 'directory', ino: 5 },
    { name: MARKER_NAME, kind: 'file', ino: 6 },
  ];
  const plan = planFolder([
    { name: 'kept.jpg', source: '/files/aa/a', ino: 1 },
    { name: 'changed.jpg', source: '/files/bb/b', ino: 20 },
    { name: 'new.jpg', source: '/files/cc/c', ino: 30 },
    { name: 'nested-album', source: '/files/dd/d', ino: 40 },
  ], present);
  assertEquals(plan.kept, 1);
  assertEquals(plan.link.map((entry) => entry.name), ['changed.jpg', 'new.jpg']);
  assertEquals(plan.remove.sort(), ['gone.jpg', 'stray-link']);
});

Deno.test('only the outermost of nested paths is compared', () => {
  assertEquals(outermost([`${ALBUMS}/a/b`, `${ALBUMS}/a`, `${ALBUMS}/ab`, `${ALBUMS}/a`]), [`${ALBUMS}/a`, `${ALBUMS}/ab`]);
});

Deno.test('each event names the albums whose folders it may change', () => {
  const event = (nodeType: string, type: string, path: string, extra: { fromPath?: string; nodeId?: string } = {}) => ({
    nodeType,
    type,
    path,
    nodeId: extra.nodeId ?? 'n',
    ...extra,
  });
  const none = () => [];
  const check = (e: ReturnType<typeof event>, albumsOf: (id: string) => string[] = none) => pathsToCheck(e, ALBUMS, albumsOf);

  assertEquals(check(event('album', 'child-attached', `${ALBUMS}/lake`)), [`${ALBUMS}/lake`]);
  assertEquals(check(event('album', 'moved', `${ALBUMS}/sea`, { fromPath: `${ALBUMS}/lake` })), [`${ALBUMS}/sea`, `${ALBUMS}/lake`]);
  assertEquals(check(event('album', 'moved', '/home/anna/staging/albums/x', { fromPath: `${ALBUMS}/lake` })), [`${ALBUMS}/lake`]);
  assertEquals(check(event('directory', 'moved', `${ALBUMS}/2020`, { fromPath: `${ALBUMS}/old` })), [`${ALBUMS}/2020`, `${ALBUMS}/old`]);
  // An imported album's files/: what leaves it, and what arrives.
  assertEquals(check(event('directory', 'child-detached', `${ALBUMS}/lake/files`)), [`${ALBUMS}/lake`]);
  assertEquals(check(event('directory', 'child-detached', `${ALBUMS}/lake/thumbnails`)), []);
  assertEquals(check(event('file', 'created', `${ALBUMS}/lake/files/a.jpg`)), [`${ALBUMS}/lake`]);
  assertEquals(check(event('file', 'created', `${ALBUMS}/lake/a.jpg`)), []);
  assertEquals(check(event('file', 'moved', '/home/anna/a.jpg', { fromPath: `${ALBUMS}/lake/files/a.jpg` })), [`${ALBUMS}/lake`]);
  // A file deleted elsewhere: the albums it was seen in.
  assertEquals(check(event('file', 'deleted', '/home/anna/a.jpg', { nodeId: 'f1' }), (id) => id === 'f1' ? [`${ALBUMS}/lake`, `${ALBUMS}/sea`] : []), [
    `${ALBUMS}/lake`,
    `${ALBUMS}/sea`,
  ]);
  assertEquals(check(event('file', 'updated', `${ALBUMS}/lake/files/a.jpg`)), []);
});
