/**
 * `album-folders sync` against a file store on disk: each album a read-only folder, each member a
 * hard link to its stored file, following members added, removed and deleted and albums moved;
 * media whose stored file is a link to an original elsewhere, or whose bytes are not on the disk
 * tier, left out; a folder that is not the album folders, and a pass that would empty most of
 * them, refused.
 */

import { ALBUMS_ROOT } from '@archive/paths';
import { assert, assertEquals, assertRejects } from '@std/assert';
import { join } from '@std/path';
import type { AlbumFoldersStatus, AlbumFoldersSync } from '@album-folders/api';
import { ADMIN_ACCESS, createTestContext, testCommands } from '@ein/testing';

const fileRoot = await Deno.makeTempDir({ prefix: 'ein-album-folders-' });
const root = join(fileRoot, 'albums');
const testCtx = createTestContext({ modules: ['archive', 'album-folders'], fileRoot });

const inode = async (path: string) => (await Deno.lstat(path)).ino;
const names = async (folder: string) => {
  const found: string[] = [];
  for await (const entry of Deno.readDir(folder)) found.push(entry.name);
  return found.sort();
};
const exists = (path: string) => Deno.lstat(path).then(() => true, () => false);

Deno.test({ name: 'album folders', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  const sync = (args = '') => client.execJson<AlbumFoldersSync>(`CFG_ALBUM_FOLDERS_PATH=${root} album-folders sync ${args}`);
  const stored = async (path: string) => (await vfs.stat(ADMIN_ACCESS, path)).path as string;
  const mkmedia = async (path: string) => {
    await cmd.shouldSucceed(`echo x > ${path}`);
    await vfs.update(ADMIN_ACCESS, path, { attrs: { mimetype: 'image/jpeg' } });
  };
  const mklink = (parent: string, name: string, target: string) =>
    vfs.create(ADMIN_ACCESS, 'softlink', parent, name, { props: { uid: 0, gid: 0, mode: 0o777, softlink: target } });

  try {
    await cmd.shouldSucceed(`mkdir -p ${ALBUMS_ROOT}/travel /home/admin/pics`);
    await vfs.create(ADMIN_ACCESS, 'album', ALBUMS_ROOT, 'lake', { attrs: { name: 'Lake' } });
    await mkmedia(`${ALBUMS_ROOT}/lake/a.jpg`);
    await mkmedia('/home/admin/pics/b.jpg');
    await mklink(`${ALBUMS_ROOT}/lake`, 'b.jpg', '/home/admin/pics/b.jpg');
    await mklink(`${ALBUMS_ROOT}/lake`, 'coverPhoto', `${ALBUMS_ROOT}/lake/a.jpg`);
    // An imported album, its media in files/, inside a directory of albums.
    await vfs.create(ADMIN_ACCESS, 'album', `${ALBUMS_ROOT}/travel`, 'rome', { attrs: { name: 'Rome' } });
    await cmd.shouldSucceed(`mkdir -p ${ALBUMS_ROOT}/travel/rome/files`);
    await mkmedia(`${ALBUMS_ROOT}/travel/rome/files/c.jpg`);
    await vfs.create(ADMIN_ACCESS, 'album', ALBUMS_ROOT, 'empty', { attrs: { name: 'Empty' } });

    await t.step('a pass makes a folder per album and a hard link per member', async () => {
      const report = await sync();
      assertEquals([report.albums, report.linked, report.removed], [3, 3, 0]);
      assertEquals(await names(root), ['.ein-album-folders', 'empty', 'lake', 'travel']);
      assertEquals(await names(join(root, 'lake')), ['a.jpg', 'b.jpg']);
      assertEquals(await names(join(root, 'travel/rome')), ['c.jpg']);
      assertEquals(await inode(join(root, 'lake/a.jpg')), await inode(await stored(`${ALBUMS_ROOT}/lake/a.jpg`)));
      assertEquals(await inode(join(root, 'lake/b.jpg')), await inode(await stored('/home/admin/pics/b.jpg')));
      assertEquals(await inode(join(root, 'travel/rome/c.jpg')), await inode(await stored(`${ALBUMS_ROOT}/travel/rome/files/c.jpg`)));
    });

    await t.step('a second pass changes nothing, and status tells the last full pass', async () => {
      const report = await sync();
      assertEquals([report.linked, report.removed, report.kept], [0, 0, 3]);
      const status = await client.execJson<AlbumFoldersStatus>(`CFG_ALBUM_FOLDERS_PATH=${root} album-folders status`);
      assertEquals([status.ready, status.last?.kept], [true, 3]);
    });

    await t.step('the folders are read-only', async () => {
      if (Deno.uid() === 0) return;
      await assertRejects(() => Deno.writeTextFile(join(root, 'lake/new.txt'), 'x'), Deno.errors.PermissionDenied);
      await assertRejects(() => Deno.remove(join(root, 'lake/a.jpg')), Deno.errors.PermissionDenied);
      await assertRejects(() => Deno.mkdir(join(root, 'mine')), Deno.errors.PermissionDenied);
    });

    await t.step('a member taken out of the album leaves its folder', async () => {
      await cmd.shouldSucceed(`rm ${ALBUMS_ROOT}/lake/b.jpg`);
      const report = await sync(`${ALBUMS_ROOT}/lake`);
      assertEquals([report.albums, report.removed], [1, 1]);
      assertEquals(await names(join(root, 'lake')), ['a.jpg']);
    });

    await t.step('an album moved takes its folder along', async () => {
      await cmd.shouldSucceed(`mv ${ALBUMS_ROOT}/lake ${ALBUMS_ROOT}/travel/sea`);
      await sync();
      assert(!(await exists(join(root, 'lake'))));
      assertEquals(await names(join(root, 'travel/sea')), ['a.jpg']);
    });

    await t.step('a deleted file leaves its folder, freeing its bytes', async () => {
      const bytes = await stored(`${ALBUMS_ROOT}/travel/sea/a.jpg`);
      await cmd.shouldSucceed(`rm ${ALBUMS_ROOT}/travel/sea/a.jpg`);
      assert(!(await exists(bytes)));
      assertEquals((await Deno.lstat(join(root, 'travel/sea/a.jpg'))).nlink, 1, 'only the folder holds the bytes');
      await sync(`${ALBUMS_ROOT}/travel`);
      assertEquals(await names(join(root, 'travel/sea')), []);
      assertEquals((await Deno.lstat(join(root, 'travel/rome/c.jpg'))).nlink, 2);
    });

    await t.step('media whose stored file links to an original elsewhere are left out', async () => {
      await mkmedia(`${ALBUMS_ROOT}/travel/rome/files/d.jpg`);
      const bytes = await stored(`${ALBUMS_ROOT}/travel/rome/files/d.jpg`);
      const original = join(await Deno.makeTempDir({ prefix: 'ein-album-folders-old-' }), 'd.jpg');
      await Deno.writeTextFile(original, 'x\n');
      await Deno.remove(bytes);
      await Deno.symlink(original, bytes);
      const report = await sync();
      assertEquals(report.skipped.external, 1);
      assertEquals(await names(join(root, 'travel/rome')), ['c.jpg']);
    });

    await t.step('media whose bytes are not on the disk tier are left out', async () => {
      await cmd.shouldSucceed(`mknode -t file ${ALBUMS_ROOT}/travel/rome/files/e.jpg --as mimetype=image/jpeg --tier db`);
      assertEquals((await sync()).skipped.unstored, 1);
      assertEquals(await names(join(root, 'travel/rome')), ['c.jpg']);
      // A stored file outside the disk tier's root is on another mount, as the volatile tier is.
      const elsewhere = await client.execJson<AlbumFoldersSync>(`EIN_FILE_ROOT_PATH=${fileRoot}-other CFG_ALBUM_FOLDERS_PATH=${root} album-folders sync --dry-run`);
      assertEquals([elsewhere.linked, elsewhere.kept, elsewhere.skipped.unstored], [0, 0, 3]);
      await cmd.shouldSucceed(`rm ${ALBUMS_ROOT}/travel/rome/files/e.jpg`);
    });

    await t.step('a pass that would empty most of the folders stops unless forced', async () => {
      const ghost = join(root, 'ghost');
      await Deno.chmod(root, 0o755);
      await Deno.mkdir(ghost);
      await Deno.chmod(root, 0o555);
      for (let i = 0; i < 25; i++) await Deno.writeTextFile(join(ghost, `${i}.jpg`), 'x');
      assertEquals((await client.exec(`CFG_ALBUM_FOLDERS_PATH=${root} album-folders sync`)).success, false);
      assert(await exists(ghost));
      const report = await sync('--force');
      assertEquals(report.removed, 25);
      assert(!(await exists(ghost)));
      // The empty album keeps its folder.
      assert(await exists(join(root, 'empty')));
    });

    await t.step('a folder holding files but no marker is not taken', async () => {
      const other = join(fileRoot, 'other');
      await Deno.mkdir(other);
      await Deno.writeTextFile(join(other, 'notes.txt'), 'x');
      const ran = await client.exec(`CFG_ALBUM_FOLDERS_PATH=${other} album-folders sync`);
      assertEquals(ran.success, false);
      assertEquals(await names(other), ['notes.txt']);
    });
  } finally {
    await testCtx.teardown();
    for (const folder of [root, fileRoot]) {
      // The folders are read-only; make them removable.
      await new Deno.Command('chmod', { args: ['-R', 'u+w', folder] }).output().catch(() => {});
    }
    await Deno.remove(fileRoot, { recursive: true }).catch(() => {});
  }
});
