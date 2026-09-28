# Recent-console acquisition audit — 2026-09-27

## Implemented contract

ROMarrNG exposes explicit platforms for PS4 (`ps4`), PS5 (`ps5`), Vita
(`psvita`), Xbox One (`xboxone`) and Xbox Series X/S (`series-x-s`). SeerrNG
uses the returned aliases to match IGDB platforms, applies administrator
Retro/Modern assignments before catalog pagination, and retains the existing
request, approval, retry, ownership and provider-status contracts.

| Target | Imported form | Folder metadata |
| --- | --- | --- |
| PS3 | Existing disc/package formats and full dumps | PS3_GAME/USRDIR/EBOOT.BIN + PS3_GAME/PARAM.SFO |
| PS4 | PKG or full dump | eboot.bin + sce_sys/param.sfo |
| PS5 | PKG or full dump | eboot.bin + sce_sys/param.json |
| Vita | VPK or full dump | eboot.bin + sce_sys/param.sfo |
| Xbox One | XVC package | No directory layout inferred |
| Xbox Series X/S | XVC package | No directory layout inferred |

Recent-console release scoring requires an explicit console label and rejects
foreign generations and PC releases. Extensions identify accepted containers;
they do not prove the package's authenticity, decryption state or runtime
compatibility. Firmware selection, keys, emulator installation and launching
remain outside SeerrNG's acquisition contract.

## Shared gaps closed

- `/api/platforms` now returns aliases, directory layouts and the explicit-label
  requirement. Previously SeerrNG's alias matcher had no aliases to consume.
- Folder and ZIP/7z imports preserve complete game trees, including icons and
  duplicated basenames in separate asset directories. Staging prevents failed
  copies from publishing partial trees or replacing an existing game.
- ZIP sets use one archive handle; solid 7z/RAR sets use one extraction pass.
  Checksums for disk files and large archive members use bounded reads.
- Folder library scans recognize complete dumps as one title in flat and nested
  layouts, skip symlinks and staging, and stop at bounded traversal limits.
- Successful imports persist their exact destinations against the request
  identity. Delivery survives restarts and catalog/download filename differences.
- Directory downloads are request-scoped TAR streams with complete relative
  paths. They replace the previous truncated list of 100 loose files. No
  temporary archive or complete-game memory buffer is created.

## Verification boundary

Regression coverage includes exact console matching, catalog generation
filtering, nested and flat imports, ZIP and real libarchive 7z handling, atomic
copy failures, checksum memory bounds, restart recovery, and authenticated
request-scoped HTTP TAR delivery with more than 100 files.

Live indexer acquisition and game runtime compatibility have not been verified
for these new targets. Catalog metadata alone cannot establish either. The
implementation has no Switch 2 acquisition definition; its container and
import contract still needs verified format evidence. Existing Switch,
Wii U, PS3, original Xbox and Xbox 360 definitions remain available.

TAR bundles do not support byte ranges. Individual package files retain range
support. Trees beyond 10,000 files or bounded traversal are not offered as
partial bundles; availability and deliverability remain separate.

## Sources checked

- [RomM canonical platform folders](https://docs.romm.app/4.5.0/Platforms-and-Players/Supported-Platforms/)
- [shadPS4 folder import contract](https://github.com/shadps4-emu/shadPS4/wiki/I.-Quick-start-%5BUsers%5D)
- [PS5 package and dump tooling](https://github.com/SvenGDK/LibProsperoPKG)
- [Microsoft XVC console versus MSIXVC PC packages](https://learn.microsoft.com/en-us/gaming/game-publishing/tutorial-xbox-managed/how-to-create-a-package)
- [LaunchBox PS5 metadata name](https://gamesdb.launchbox-app.com/platforms/games/219-sony-playstation-5)
- [LaunchBox Xbox Series metadata name](https://gamesdb.launchbox-app.com/platforms/games/222-microsoft-xbox-series-xs)
