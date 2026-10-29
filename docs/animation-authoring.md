# Making animation packs for more characters

The desktop pet keeps its current JS/Python player. Rigging happens in an art
tool, then transparent PNG or WebP frame sequences are imported as per-character
clips. This avoids adding a live animation SDK to the installed app.

## Recommended authoring tool

Use [Spine 2D](https://esotericsoftware.com/spine-skins) for the first rig. It
supports reusable animation across skins and can export transparent PNG
sequences. [Rive](https://rive.app/docs) is another option if the app later needs
live state-machine animation, but that would require embedding its runtime.

The current `llm-pet` files are sprite atlases, not layered art. A rig needs
separate attachments for the head, hair, torso, arms, skirt, tail, wings, and
accessories. Reconstruct or separate those layers before rigging. Use separate
rig families for humanoid characters and whale-like characters.

## Pilot action list

Start with `chatgpt-chibi` and five clips: `idle`, `thinking`, `wave`, `jump`,
and `run_right_once`. Export every clip with transparent background and the same
canvas size as the character's source pack (192 x 208 for Codex sprite sheets).
In Spine's PNG export, enable maximum bounds so every frame keeps the same
canvas and the character does not jump around between frames.

Arrange the export as one folder per clip:

```text
spine-export/
  idle/000.png
  idle/001.png
  thinking/000.png
  thinking/001.png
  wave/000.png
  jump/000.png
  run_right_once/000.png
```

Import the exported frames into the character pack:

```bash
node scripts/import-animation-frames.mjs \
  assets/llm-pet/pets/chatgpt-chibi \
  /path/to/spine-export \
  42
```

The importer writes `animations.json` and `animations/<clip>/` inside the
character pack. The app merges those clips over the pack's built-in actions;
missing clips keep using the original sprite sheet. `frameMs` is milliseconds
per exported frame. Keep the source Spine project so motions can be edited and
re-exported later.

## Reusing actions

Characters with similar proportions can share one skeleton and motion set, with
each character supplying its own skin attachments. Significantly different
shapes need a separate rig family. The existing whale-tail maid remains a
reference for action timing and motion style; its rendered frames cannot be
reused as another character's artwork.
