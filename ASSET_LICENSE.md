# License and asset notice

This project started from [QCYTSN/dsh-dafeiyu](https://github.com/QCYTSN/dsh-dafeiyu)
and is maintained independently by seawhilt. The original MIT copyright notice is
kept in `LICENSE` as that license requires.

The source code is MIT-licensed. Every file shipped in the package is covered
by one of the licenses below.

## Whale-tail maid character assets (MIT)

The runtime frames under `assets/pet/` are converted from the animation set of
[PC2005-cloud/dsh-pet](https://github.com/PC2005-cloud/dsh-pet)
(`assets/webm/`, Copyright (c) 2026 PC2005-cloud), which that project
distributes under the MIT license together with its AI-generation prompt
recipes. The source clips are AI-generated green-screen animations matted to
transparent VP9 WebM; this repository re-encodes the selected clips at their native 24 fps as
transparent WebP frame sequences on one shared crop window (see
`scripts/import_dshpet_webm.py`).

The current import is pinned to upstream commit
[`549fff2ea33c2acfb16612c76912c6137da4a758`](https://github.com/PC2005-cloud/dsh-pet/tree/549fff2ea33c2acfb16612c76912c6137da4a758/dsh-pet/assets/webm).
`assets/pet-manifest.json` records each source video's SHA-256 and exact frame
window, plus the common crop and encoding settings. Touch and idle actions
retain the complete source entrance and exit; the dragging / landing clips
split one source into its suspended loop and complete return to rest. Stretch
and yawn frames come from the same upstream set.

They remain subject to the upstream MIT license, bundled verbatim as
`assets/dsh-pet-LICENSE.txt` and shipped in the npm package. No warranty is
given; the "dsh-pet" name and its project identity belong to their respective
owners.

## Sounds and cursors

The notification sounds under `assets/sounds/` are original procedural audio
generated for this repository by `scripts/generate_notification_sounds.py`.
They contain no third-party recordings and are covered by the repository's MIT
license.

The glove status cursors `assets/cursor_grab.cur` (open hand) and
`assets/cursor_grabbing.cur` (closed fist) are **unmodified copies** of the
cursor images shipped by the Chromium project in
`ui/resources/cursors/` (`hand_grab.cur`, `hand_grabbing.cur`, 32x32).
They are licensed under the **BSD 3-Clause license** held by The Chromium
Authors and are **not covered by the MIT code license**; both licenses are
permissive and compatible. The upstream license text and a provenance note
with the upstream URLs and file digests are bundled in `assets/cursors/`
(`LICENSE`, `README.md`), and the digests are pinned by the test suite.

## Disclaimer

This is an unofficial project and is not affiliated with or endorsed by
DeepSeek or Anthropic. Names, marks, and character-related rights belong to
their respective owners.
