# module-album-folders

The albums as folders of real files on disk, for browsing outside EiN.

Each album under `/archive/albums` is a folder under `files/albums` in the data folder, and each of
its photos, videos and recordings a hard link there to the stored original: the same bytes, no copy.
A service follows the albums as they change and compares every folder again on a timer. The folders
are read-only, and nothing done to them reaches EiN. [Album folders](https://einhq.eu/docs/album-folders/)
in the documentation covers using it.

An [EiN](https://github.com/einhq) module. It is developed and tested inside a checkout of EiN core,
as `modules/album-folders`, and a deployment chooses whether to run it. `mod.json` is its manifest:
the core it needs (`coreApi`), the modules it depends on (the archive, whose `members-album` says who
is in an album), and what it exports.

- `bin/album-folders`: `status`, `sync` and `watch`, the service's loop.
- `lib/plan.ts`: member names and what turns a folder into its album, without the disk.
- `lib/folder.ts`: the folders on disk, kept read-only.
- `lib/sync.ts`: a pass over some albums.
- `lib/events.ts`: which VFS events change a folder.
