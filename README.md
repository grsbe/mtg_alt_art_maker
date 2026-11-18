# MTG Alt Art Maker

A small web app for designing alternative-art / alternative-name proxies for a Commander deck.
Paste a decklist, browse the cards sorted by type, rename them (the original name becomes the subtitle),
drop in your own art, and export print-ready WebPs. Everything is stored in plain files so a group can
collaborate through git.

## Running it

You need [uv](https://docs.astral.sh/uv/). It installs the server's dependencies (FastAPI and uvicorn) on the first run.

```sh
uv run fetch_frames.py   # once: downloads the card frames and fonts (~170 MB, see "Frames")
uv run server.py
```

This opens <http://127.0.0.1:8765> in your browser (or the next free port). Options: `--port 9000`, `--no-browser`,
`--host 0.0.0.0` (listen on all network interfaces), `--access-log` (log every request).

### On a server

Several people can work on the same deck at once; every browser picks up the others' changes within a few
seconds. The app has no login, so put it behind a reverse proxy that handles the password and HTTPS, and run:

```sh
uv run uvicorn server:app --host 127.0.0.1 --port 8765
```

Use a single worker process (uvicorn's default): deck writes are coordinated by locks inside the process.

## Using it

0. **Pick or create a deck** with the dropdown / **+ New deck** in the top bar. Each deck is its own folder.
1. **Import deck**: paste a list from Moxfield, Archidekt, MTGA, or plain card names (one per line).
   Mark the commander with a `Commander` header or `*CMDR*`. Typos are fuzzy-matched via Scryfall.
   Re-importing an updated list keeps your work: removed cards that you'd customized move to `archived`
   in `deck.json`, and come back if you add them again.
2. **Pick a card** in the gallery on the left (grouped Commander → Creatures → … → Lands).
   The view switch shows full cards, art only, or your exported proxies.
3. **Edit** on the right: new name (original becomes the subtitle automatically; its tab is angled
   `\_/` by default or rounded), frame, frame color
   (including two-color split frames), and optional text overrides.
   Cards with two parts get a switch at the top of the editor: double-faced cards (transform and modal;
   front/back, each with its own name, art and WebP), split and aftermath cards (two halves with their own
   art, one WebP), flip cards and adventures (one picture, both names/texts editable).
   Sagas, planeswalkers, classes, levelers and battles use their own frame layouts automatically.
4. **Art**: drop an image onto the editor or straight onto a gallery card, paste with Ctrl+V,
   or use *Choose art…*. Drag to move, scroll to zoom, rotate with the slider.
   The original file is kept untouched; only the position/zoom/rotation is saved.
5. **Export proxy WebP** writes a 1490×2080 image to the deck's `proxies/` and marks the card **done**
   (green check in the gallery, counter in the top bar). You can also tick *Done* by hand in the editor.

6. **Print sheet** (top bar) opens a printable page: the exported proxies at real size (63 × 88 mm),
   3 × 3 per A4 or Letter page, repeated by quantity, both faces of double-faced cards. Options: gap between
   cards, cut marks, black corners, basic lands on/off, only finished cards, and whether cards without a
   proxy are left out or filled in with the original card. Print or save as PDF at 100% / actual size.

Changes save automatically to the deck's `deck.json`.

## Files

| Path                     | In git | What                                                                    |
|--------------------------|--------|-------------------------------------------------------------------------|
| `decks/<deck>/deck.json` | yes    | The deck: card list, custom names, subtitles, frame, art crop, done     |
| `decks/<deck>/art/`      | yes    | Your source art, named after the card (`sol_ring.png`)                  |
| `decks/<deck>/proxies/`  | yes    | Exported proxy WebPs                                                    |
| `cache/`                 | no     | Scryfall card data, images and mana symbols, shared by all decks; re-downloaded automatically after a fresh clone |
| `frames/<pack>/`         | no     | Blank card frames, downloaded by `fetch_frames.py` (see `frames/README.md`) |
| `public/fonts/card/`     | no     | Beleren + MPlantin, downloaded by `fetch_frames.py`                     |
| `fetch_frames.py`        | yes    | Downloads frames and fonts from Card Conjurer and converts them         |
| `server.py`              | yes    | Server, FastAPI (Scryfall import, caching, file storage)                |
| `public/`                | yes    | The web UI (`render.js` draws the card)                                 |

## Frames

Cards use image frames as their base: real textures, P/T boxes, legendary crowns, and dedicated frames
for transform and modal double-faced cards, split, aftermath and flip cards, adventures, sagas,
planeswalkers, classes, levelers and battles. The frames are Wizards of the
Coast artwork, so they're not in git; `uv run fetch_frames.py` downloads them from
[Card Conjurer](https://github.com/Investigamer/cardconjurer). Nine packs are available (modern M15 plus
borderless and showcase styles); each deck has a **Deck default frame** in the editor's Frame section,
single cards can override it, and simple drawn frames remain as a fallback. Details and how to add your
own packs: [`frames/README.md`](frames/README.md).

## Fonts

Real cards use Beleren (names, type line, small caps for P/T and artist) and MPlantin (rules text). They
belong to Wizards of the Coast, so they're not in git: `fetch_frames.py` downloads them into
`public/fonts/card/` (fonts installed on your computer take precedence). Without them the app falls back to
the bundled free lookalikes in `public/fonts/` (Faustina Bold and Crimson Text, SIL Open Font License), so
make sure everyone has run the script, or exports will look slightly different between collaborators.

## Collaborating

Each `deck.json` is pretty-printed and sorted, one card per block, so diffs and merges stay readable.
To avoid merge conflicts, agree on who works on which cards (the *Notes* field is handy for that),
commit often, and pull before starting.

## Status / roadmap

- [x] Decklist import, Scryfall lookup, local cache
- [x] Type-sorted gallery, editor, `deck.json` saving
- [x] Art drop/paste, move/zoom/rotate, basic canvas rendering, WebP export
- [x] Multiple decks (one folder each), done checkmarks, official Scryfall mana symbols
- [x] Card-style fonts (real ones if installed, free lookalikes otherwise)
- [x] Image frame packs (M15 + 8 showcase/borderless packs), legendary crowns, P/T boxes
- [x] Two-color split frames (automatic for hybrid cards, selectable for any card)
- [x] Double-faced cards (transform + modal), split, aftermath, flip, adventure, saga, planeswalker,
      class, leveler, battle layouts
- [x] Frames and real card fonts git-ignored, downloaded by `fetch_frames.py`
- [x] Print sheet (3×3 per page, real size, cut marks, PDF via the browser)
