# Reproducible document rootfs

The immutable minirootfs SHA-256 plus `locks/{ios,android}.json` lock every added
APK (including Python 3.12 and py3-pip's transitive closure). APKs were checked
against the checksum in Alpine's signed APKINDEX and verified with `apk verify`.
The signed index archive hashes are provenance, not mutable build inputs.
Individual APK signatures and SHA-256 are checked again during builds. Old APK
URLs may disappear from Alpine; retain a copy of locked inputs in an isolated
cache for rebuilds. Never silently substitute a newer version.

Repository investigation (aarch64, signed indexes, 2026-11-04):

| Package | v3.21 (iOS base 3.21.0) | v3.22 (Android base 3.22.2) |
| --- | --- | --- |
| python3 | 3.12.16-r0 | 3.12.16-r0 |
| py3-openpyxl | 3.1.5-r0 | 3.1.5-r0 |
| py3-pypdf | 3.17.4-r1 | 5.3.1-r0 |
| py3-reportlab | 3.6.13-r2 | 3.6.13-r2 |
| py3-pillow | 11.0.0-r0 | 11.2.1-r0 |
| py3-charset-normalizer | 3.4.0-r0 | 3.4.2-r0 |
| py3-pip | 24.3.1-r0 | 25.1.1-r0 |

Selection: native Alpine Python + pip, then the previously device-validated
wheel versions in `locks/wheels.json`. Alpine's pypdf/reportlab do not match the
required versions. Exception approved for openpyxl: although its version matches,
the Alpine package pulls in pandas/numpy/openblas/lxml and about 60 packages;
the upstream wheel only needs et_xmlfile. Pillow and charset-normalizer use the
validated CPython 3.12 musllinux aarch64 wheels, not host macOS wheels. fontTools
is a build-only pure Python wheel, never installed in the shipped rootfs.
DOCX support includes python-docx 1.2.0 plus typing_extensions 4.15.0 and
the CPython 3.12 musllinux aarch64 wheel of lxml 6.1.3. The offline smoke
extracts Chinese PDF text, saves it with a heading and table in DOCX, then
reopens the file and checks its paragraph/table contents.
All pip installs use `--require-hashes --only-binary=:all: --no-deps`; the whole
closure is explicit. No network package resolution occurs during installation.

The rootfs baker now runs two independent offline installations when requested:

```sh
docker pull --platform linux/arm64 alpine:3.21.0@sha256:21dc6063fd678b478f57c0e13f47560d0ea4eeba26dfc947b2a4f81f686b9f45
docker pull --platform linux/arm64 alpine:3.22.2@sha256:4b7ce07002c69e8f3d704a9c5d6fd3053be500b7f1c69fc0d80990c2ad8dd412
python3 clients/flutter/tool/linux/documents/bake_rootfs.py --platform ios \
  --output-root "$NOVA_SESSION_ROOT/documents-ios" --verify-reproducible
# Repeat with --platform android and a separate documents-android directory.
```

Docker's daemon must be running and its VM storage must be on internal storage.
The builder requires the pinned image to be present (`docker image inspect`);
it does not silently pull a tag. Network is used only for SHA-verified input
fetching. APK signature verification, signed-index control checksums, offline
APK install, hash-required binary-only pip install, font generation, `pip check`
and smoke all run under `docker run --platform linux/arm64 --network=none`.
If Docker cannot start, use the same script/locks on an ARM64 Linux Docker
host with isolated internal output storage; macOS cannot execute target Alpine
binaries natively. This is not a device-installed rootfs snapshot.

`attempt-{1,2}` retain smoke JSON, APK/Python package lists and canonical file
manifests. Both list hashes, file-manifest hashes and archive hashes must match.
Bytecode is removed after smoke (`PYTHONDONTWRITEBYTECODE=1`); tar order,
user/group name strings, tar/gzip timestamps are normalized. POSIX uid/gid,
modes and symlinks are preserved. py3-pip and the complete Python stdlib remain
available for later optional installs. Unavailable old locked APK URLs fail
closed; a durable internal content-addressed mirror/cache is a release concern.

The owner approved the exact **Nova Document Sans SC Regular** static-400 subset
on 2026-11-04 (see `docs/ASSET_PUBLICATION.md`). It is now bundled by default;
`--without-font` is only for size comparisons (CJK smoke then uses a temporary
copy, explicitly not a bundled-font result). No unapproved-font flag is needed.
The default smoke uses the actual bundled path. OFL/copyright are retained.

Known CI gap: the current iOS macOS Actions workflow has no Docker daemon or
pinned image setup and **will fail on that missing dependency**. This task does
not modify the workflow or claim a CI pass. Follow-up options are a runner with
working Docker, or a separate lock-driven prebuilt rootfs artifact/cache stage;
do not silently substitute the bare minirootfs. Nested virtualization on hosted
macOS ARM64 runners must not be assumed available.

## ReportLab default CJK fonts

The baker queries target Alpine Python's `sysconfig.get_path('purelib')` and
`sys.path` (currently `/usr/lib/python3.12/site-packages`), refuses any existing
`sitecustomize`, then installs `nova_sitecustomize.py` as system `sitecustomize.py`.
Its SHA-256 is recorded in `document-base.json`/`manifest.json` and its bytes in
the canonical file manifest, covered by both independent reproducibility builds.
No font bytes, character set, weight or approved asset hashes change.

The hook imports no ReportLab at startup. It intercepts only pdfmetrics loading,
then registers the bundled TTFont under Helvetica, Helvetica-Bold,
Helvetica-Oblique and Helvetica-BoldOblique at the first font lookup (avoiding
canvas/platypus circular imports). `reportlab.platypus.paragraph` imports `getFont`
by name, keeping the first wrapper reachable, so registration is guarded to run
exactly once (smoke asserts four `TTFont` constructions across 30 paragraphs;
repeated registration cost >60 s on iSH). Missing font: no-op. Hook/registration failure:
one generic stderr warning, no stdout, normal user script continues. An explicit
later registration can override these names. `NOVA_DOCUMENT_FONT` can override
the path for diagnostics; normal images use the fixed bundled path.

Bold/italic aliases use the same Regular weight, not synthetic bold or italics.
Characters outside the approved subset (including emoji) remain unsupported;
pypdf readback and rendered inspection are still required. Existing device
rootfs installations are not migrated; only newly baked/installed images gain
the hook. System sitecustomize loads with `PYTHONNOUSERSITE=1`, `-s` and `-I`,
not with `-S` (or a venv excluding system site-packages).

Smoke runs three fresh target-rootfs Python processes, with canvas, platypus and
pdfmetrics imported first respectively. Naive Paragraph, Helvetica-Bold table
headers and all four canvas aliases must round-trip five Chinese cities and use
embedded TrueType fonts. `--without-font` explicitly skips these default-font
checks (the original explicit temporary-font smoke remains); it is not a bundled
font pass. Host-only hook failure/deferred-import tests require no dependencies:
`python3 -m unittest discover -s clients/flutter/tool/linux/documents -v`.
