# Frame packs

This folder is git-ignored (the frames are Wizards of the Coast artwork). Download them once with

```sh
uv run fetch_frames.py            # all packs + the card fonts (~170 MB)
uv run fetch_frames.py --list     # what's available
uv run fetch_frames.py m15 m15_m21
```

The script downloads from [Card Conjurer](https://github.com/Investigamer/cardconjurer) (`img/frames`)
with curl and converts everything into the layout below. Restart the server afterwards.

## Included packs

| Pack                    | Look |
|-------------------------|------|
| `m15`                   | Modern frame, all colors, crowns, P/T boxes, **plus every special layout** (see below) |
| `m15_box_topper`        | Borderless, art fills the card |
| `m15_commander_legends` | Dark Commander Legends frame |
| `m15_devoid`            | See-through frame |
| `m15_showcase`          | Borderless with translucent boxes |
| `m15_invention`         | Kaladesh Invention (no land frame) |
| `m15_m21`               | M21 showcase, mono colors only, big mana symbol on lands |
| `m15_nyx`               | Nyx starfield frame |
| `m15_zendikar`          | Zendikar Rising showcase with its own crowns |

Colors a pack doesn't have (gold in M21, lands in Invention, …) and layouts it doesn't have (sagas,
planeswalkers, …) automatically come from `m15`.

## Folder format

```
frames/<pack>/
  w.png u.png b.png r.png g.png   one blank frame per color, transparent art window
  m.png a.png l.png               gold, artifact, land
  pt_<key>.png                    optional P/T boxes
  crown_<key>.png                 optional legendary crowns
  land_<key>.png                  optional land-specific frames
  frame.json                      name, options, layout (all optional)
  transform_front/ transform_back/ modal_front/ modal_back/ adventure/ saga/ planeswalker/
  split/ flip/ aftermath/ class/ battle/ leveler/
                                  optional layout variants, same file names inside,
                                  plus extra assets (icon.svg, chapter.png, plus.png, header.png, …)
```

`frame.json` options: `name`, `fullArt` (art behind the whole card), `textColor` (rules text; light
colors get a shadow), `titleColor`, `typeColor`, `ptColor`, `loyaltyColor`, `landTextColor`,
`landSymbol` (land frames already show the mana symbol), and `layout`: positions as fractions
`[x, y, w, h]` of the card (keys `art`, `title`, `type`, `text`, `pt`, `ptText`, `crown`, `footer`,
plus layout-specific ones; defaults are the modern-frame positions). Variant options go in
`"variants": {"saga": {...}}`.
