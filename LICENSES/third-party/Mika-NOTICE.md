# Mika

- Project: https://github.com/wangzan101/Mika
- Upstream revision: `5f630d9` (imported 2026-11)
- License: Apache-2.0 (text: `LICENSES/Apache-2.0.txt`)
- Upstream NOTICE:

```
Mika
Copyright 2026 wangzan101
```

Nova reuses, with modifications, parts of Mika's Android phone-control stack (wireless-debugging pairing and ADB client,
shell helper handoff, virtual display, numbered accessibility snapshots and relocation), its provider preset catalog,
model-listing logic and some interface copy. Every derived source file carries a header naming Mika, the upstream
revision and a one-line description of Nova's changes. Apache-2.0 material is combined into Nova under
GPL-3.0-or-later; the Apache-2.0 attribution and NOTICE obligations above continue to apply to that material.
Mika's name, logo, images and release binaries are not redistributed.

## scrcpy (via Mika)

- Project: https://github.com/Genymobile/scrcpy — Apache-2.0, Copyright (C) Genymobile / Romain Vimont.
- Mika's shell-context technique (system Context obtained as the shell user) follows scrcpy; the derived Nova file keeps
  that attribution in its header.
