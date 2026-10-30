/**
 * The `album-folders` service, as `mod setup` starts it: the folders follow the albums as they
 * change, without a pass being asked for. A member added, a photo linked from elsewhere and then
 * deleted there, an imported album's `files/`, an album renamed and deleted.
 */

import { ALBUMS_ROOT } from '@archive/paths';
import { assertEquals } from '@std/assert';
import { join } from '@std/path';
import { ADMIN_ACCESS, createTestContext, testCommands } from '@ein/testing';

const fileRoot = await Deno.makeTempDir({ prefix: 'ein-album-folders-watch-' });
const root = join(fileRoot, 'albums');
const testCtx = createTestContext({ modules: ['archive', 'album-folders'], boot: true, fileRoot, env: { CFG_ALBUM_FOLDERS_PATH: root } });

const names = async (folder: string) => {
  const found: string[] = [];
  try {
    for await (const entry of Deno.readDir(folder)) if (!entry.name.startsWith('.')) found.push(entry.name);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
  return found.sort();
};

async function until(folder: string, want: string[] | undefined, what: string, timeoutMs = 20000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const found = await names(folder);
    if (JSON.stringify(found) === JSON.stringify(want)) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(found)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

Deno.test({ name: 'album folders service', sanitizeResources: false, sanitizeOps: false }, async (t) => {
  const { vfs } = await testCtx.setup();
  const client = await testCtx.server.createShellClient();
  const cmd = testCommands(client);

  const mkmedia = async (path: string) => {
    await cmd.shouldSucceed(`echo x > ${path}`);
    await vfs.update(ADMIN_ACCESS, path, { attrs: { mimetype: 'image/jpeg' } });
  };

  try {
    await t.step('mod setup starts the service, which marks the folder', async () => {
      const services = await client.execJson<string[]>('ls /etc/services/enabled');
      assertEquals(services.includes('album-folders'), true, `services: ${services}`);
      await until(root, [], 'the album folders');
    });

    await t.step('an album and its members appear', async () => {
      await cmd.shouldSucceed(`mkdir -p ${ALBUMS_ROOT} /home/admin/pics`);
      await vfs.create(ADMIN_ACCESS, 'album', ALBUMS_ROOT, 'lake', { attrs: { name: 'Lake' } });
      await mkmedia(`${ALBUMS_ROOT}/lake/a.jpg`);
      await until(join(root, 'lake'), ['a.jpg'], 'a member');
    });

    await t.step('a photo linked from elsewhere appears, and goes when it is deleted there', async () => {
      await mkmedia('/home/admin/pics/b.jpg');
      await cmd.shouldSucceed(`album add ${ALBUMS_ROOT}/lake /home/admin/pics/b.jpg`);
      await until(join(root, 'lake'), ['a.jpg', 'b.jpg'], 'the linked photo');
      await cmd.shouldSucceed('rm /home/admin/pics/b.jpg');
      await until(join(root, 'lake'), ['a.jpg'], 'the deleted photo to go');
    });

    await t.step("an imported album's files/ is followed", async () => {
      await vfs.create(ADMIN_ACCESS, 'album', ALBUMS_ROOT, 'rome', { attrs: { name: 'Rome' } });
      await cmd.shouldSucceed(`mkdir -p ${ALBUMS_ROOT}/rome/files`);
      await mkmedia(`${ALBUMS_ROOT}/rome/files/c.jpg`);
      await until(join(root, 'rome'), ['c.jpg'], 'a file in files/');
      await cmd.shouldSucceed(`rm ${ALBUMS_ROOT}/rome/files/c.jpg`);
      await until(join(root, 'rome'), [], 'the file to leave files/');
    });

    await t.step('an album renamed and deleted takes its folder along', async () => {
      await cmd.shouldSucceed(`mv ${ALBUMS_ROOT}/lake ${ALBUMS_ROOT}/sea`);
      await until(join(root, 'sea'), ['a.jpg'], 'the renamed album');
      await until(join(root, 'lake'), undefined, 'the old folder to go');
      await cmd.shouldSucceed(`rm -r ${ALBUMS_ROOT}/sea`);
      await until(join(root, 'sea'), undefined, 'the deleted album');
    });
  } finally {
    await testCtx.teardown();
    await new Deno.Command('chmod', { args: ['-R', 'u+w', fileRoot] }).output().catch(() => {});
    await Deno.remove(fileRoot, { recursive: true }).catch(() => {});
  }
});
