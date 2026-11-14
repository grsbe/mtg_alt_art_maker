"""Download card frame packs and the card fonts from Card Conjurer, converted into this app's format.

    uv run fetch_frames.py              # all packs + fonts
    uv run fetch_frames.py m15 m15_m21  # only some packs (fonts are always included)
    uv run fetch_frames.py --list       # show available packs
    uv run fetch_frames.py --force      # re-download files that already exist

Everything comes from https://github.com/Investigamer/cardconjurer (img/frames, fonts). Frames and fonts
are Wizards of the Coast property, which is why frames/ and public/fonts/card/ are git-ignored: every
collaborator runs this script once.

Output, per pack:
    frames/<pack>/w.png u.png b.png r.png g.png m.png (gold) a.png (artifact) l.png (land)
                  pt_<key>.png crown_<key>.png land_<key>.png (optional extras)
                  <variant>/...        layout variants: transform_front/back, modal_front/back,
                                       adventure, saga, planeswalker, split, flip, aftermath,
                                       class, battle, leveler
                  frame.json           name, colors, layout positions (fractions of the card)
    public/fonts/card/                 beleren-b, beleren-bsc, mplantin, mplantin-i
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = "https://raw.githubusercontent.com/Investigamer/cardconjurer/master/"
IMG = "img/frames/"
OLD = "data/images/cardImages/m15/"  # older asset folder; only used where img/ lacks a frame
FRAMES = Path(__file__).resolve().parent / "frames"
KEYS = "wubrgmal"  # w u b r g, m = gold, a = artifact, l = land
WHITE = "#ffffff"


def group(prefix: str, pattern: str, keys: str = KEYS, rename: dict | None = None, lower: bool = False) -> dict:
    """{'<prefix><key>.png': source path}; '{}' in pattern becomes the source's letter for that key."""
    rename = rename or {}
    out = {}
    for k in keys:
        letter = rename.get(k, k if lower else k.upper())
        out[f"{prefix}{k}.png"] = pattern.format(letter)
    return out


def same(prefix: str, path: str, keys: str = KEYS) -> dict:
    """The same source file for every key (e.g. a pack with a single P/T box)."""
    return {f"{prefix}{k}.png": path for k in keys}


M15_PT = group("pt_", IMG + "m15/regular/m15PT{}.png", rename={"l": "C"})

# Layout variants shared by every pack (packs fall back to these when they have none of their own).
M15_VARIANTS = {
    "transform_front": {
        "files": {**group("", IMG + "m15/transform/regular/front{}.png"), "icon.svg": IMG + "m15/transform/icons/sun.svg"},
        "options": {"layout": {"title": [0.16, 0.0522, 0.7547, 0.0543], "icon": [0.0594, 0.0505, 0.0734, 0.0524]}},
    },
    "transform_back": {
        "files": {
            **group("", IMG + "m15/transform/regular/back{}.png"),
            **group("pt_", IMG + "m15/transform/regular/pt{}.png", rename={"l": "A"}),
            "icon.svg": IMG + "m15/transform/icons/moon.svg",
        },
        "options": {"titleColor": WHITE, "typeColor": WHITE, "ptColor": WHITE,
                    "layout": {"title": [0.16, 0.0522, 0.7547, 0.0543], "icon": [0.0594, 0.0505, 0.0734, 0.0524]}},
    },
    "adventure": {
        "files": group("", IMG + "adventure/regular/{}.png", lower=True),
        "options": {"layout": {
            "text": [0.5267, 0.65, 0.3867, 0.2358],
            "advTitle": [0.0814, 0.6391, 0.4, 0.0296], "mana2": [0.0814, 0.6391, 0.4, 0.0286],
            "advType": [0.0814, 0.6839, 0.4, 0.0296],
            "advText": [0.0854, 0.7358, 0.3947, 0.15],
        }},
    },
    "saga": {
        "files": {**group("", IMG + "saga/regular/sagaFrame{}.png", keys="wubrgma"), "l.png": IMG + "saga/regular/l.png",
                  "chapter.png": IMG + "saga/sagaChapter.png", "divider.png": IMG + "saga/sagaDivider.png"},
        "options": {"layout": {
            "art": [0.5, 0.1124, 0.4247, 0.7253],
            "type": [0.0854, 0.8481, 0.8292, 0.0543],
            "reminder": [0.0867, 0.1129, 0.404, 0.1772],
            "chapters": [0.1334, 0.2896, 0.35, 0.5358],
            "chapterIcon": [0.0386, 0, 0.0787, 0.0629],
            "divider": [0.1, 0, 0.3947, 0.0029],
        }},
    },
    "planeswalker": {
        "files": {**group("", IMG + "planeswalker/regular/planeswalkerFrame{}.png", keys="wubrgma"),
                  "plus.png": IMG + "planeswalker/planeswalkerPlus.png",
                  "minus.png": IMG + "planeswalker/planeswalkerMinus.png",
                  "neutral.png": IMG + "planeswalker/planeswalkerNeutral.png"},
        "options": {"loyaltyColor": WHITE, "layout": {
            "art": [0.068, 0.101, 0.864, 0.8143],
            "title": [0.0867, 0.0372, 0.8267, 0.0548],
            "type": [0.0867, 0.5625, 0.8267, 0.0548],
            "abilities": [0.18, 0.6239, 0.7467, 0.2911], "mana": [0, 0.0481, 0.9292, 0.0338],
            "abilityBand": [0.1167, 0, 0.8094, 0],
            "loyaltyIcon": [0.028, 0, 0.1414, 0.0705],
            "loyalty": [0.806, 0.902, 0.14, 0.0372],
        }},
    },
    "modal_front": {  # modal double-faced cards (MDFC): triangle tab, flipside hint at the bottom
        "files": group("", IMG + "modal/regular/{}.png", lower=True),
        "options": {"layout": {"title": [0.1614, 0.0522, 0.7534, 0.0543], "flipside": [0.068, 0.892, 0.364, 0.0391]}},
    },
    "modal_back": {
        "files": group("", IMG + "modal/regular/{}b.png", lower=True),
        "options": {"layout": {"title": [0.1614, 0.0522, 0.7534, 0.0543], "flipside": [0.068, 0.892, 0.364, 0.0391]}},
    },
    "flip": {  # Kamigawa flip cards: second half upside down at the bottom
        "files": {**group("", IMG + "m15/flip/{}.png", lower=True), **group("pt_", IMG + "m15/flip/{}pt.png", lower=True)},
        "options": {"layout": {
            "title": [0.0854, 0.0386, 0.8292, 0.0543], "type": [0.0854, 0.2353, 0.8292, 0.0543], "mana": [0, 0.0477, 0.9292, 0.0338],
            "text": [0.086, 0.102, 0.828, 0.12], "ptText": [0.8267, 0.2448, 0.0967, 0.0372],
            "art": [0.0754, 0.2962, 0.8494, 0.3315], "pt": [0.0374, 0.2277, 0.9067, 0.4762],
            # Rotated 180°: anchor (x, y) is the box's far corner, width/height run left/up from it.
            "title2": [0.9147, 0.8848, 0.8292, 0.0543], "type2": [0.9147, 0.6886, 0.8292, 0.0543],
            "text2": [0.914, 0.821, 0.828, 0.12], "ptText2": [0.1734, 0.6791, 0.0967, 0.0372],
        }},
    },
    "aftermath": {  # top half normal, bottom half rotated 90°
        "files": group("", IMG + "m15/aftermath/{}.png", lower=True),
        "options": {"layout": {
            "art": [0.076, 0.1124, 0.848, 0.2234], "type": [0.0854, 0.3467, 0.8292, 0.0543],
            "text": [0.086, 0.4139, 0.828, 0.12],
            # Rotated 90° clockwise: anchor (x, y); width (x card width) runs down, height (x card height)
            # runs left. One-line text is centered in its box, as in Card Conjurer.
            "title2": [0.92, 0.5648, 0.48, 0.0543], "type2": [0.7247, 0.5648, 0.48, 0.3239],
            "text2": [0.4494, 0.57, 0.47, 0.2715], "mana2": [0.9074, 0.5039, 0.58, 0.0338],
            "art2": [0.552, 0.5629, 0.2813, 0.3495],  # the bottom half's own art window (unrotated card rect)
        }},
    },
    "class": {
        "files": {**group("", IMG + "class/{}.png", lower=True), "header.png": IMG + "class/header.png"},
        "options": {"layout": {
            "art": [0.0753, 0.1124, 0.4247, 0.7253], "type": [0.0854, 0.8481, 0.8292, 0.0543],
            "levels": [0.5093, 0.1129, 0.404, 0.7239], "header": [0.5014, 0, 0.422, 0.0481],
        }},
    },
    "battle": {  # landscape card; positions are fractions of the landscape card (2100 x 1500)
        "files": group("", IMG + "m15/battle/{}.png", lower=True),
        "options": {"landscape": True, "defenseColor": WHITE, "layout": {
            "art": [0.0795, 0.04, 0.8919, 0.914], "title": [0.1843, 0.054, 0.7367, 0.076],
            "type": [0.1276, 0.582, 0.7938, 0.076], "text": [0.1295, 0.672, 0.791, 0.276],
            "defense": [0.9143, 0.88, 0.041, 0.082], "mana": [0, 0.0667, 0.9319, 0.0473], "footer": [0.06, 0.965, 0.6, 0.025],
        }},
    },
    "leveler": {
        "files": {**group("", IMG + "levelers/regular/{}.png", lower=True, rename={"l": "a"}),
                  **group("pt_", IMG + "levelers/regular/pt/{}.png", lower=True, rename={"l": "a"})},
        "options": {"layout": {
            "text": [0.086, 0.6303, 0.6834, 0.0905], "pt": [0.7574, 0.6415, 0.188, 0.2667],
            "levelText": [[0.2067, 0.7229, 0.5627, 0.0953], [0.2067, 0.8220, 0.5627, 0.0953]],
            "levelLabel": [[0.0727, 0.7420, 0.08, 0.0572], [0.0727, 0.8448, 0.08, 0.0572]],
            "ptTexts": [[0.7928, 0.6591, 0.1367, 0.0372], [0.7928, 0.7524, 0.1367, 0.0372], [0.7928, 0.8515, 0.1367, 0.0372]],
        }},
    },
    "split": {
        "files": group("", IMG + "m15/split/{}.png", lower=True),
        # Text boxes are rotated -90°; positions are the anchors Card Conjurer uses (card fractions).
        "options": {"layout": {
            "halves": [
                {"title": [0.072, 0.8943, 0.5367, 0.0543], "type": [0.55, 0.8943, 0.5367, 0.0286],
                 "text": [0.6087, 0.8896, 0.5174, 0.2443], "art": [0.158, 0.5096, 0.3734, 0.3886],
                 "mana": [0.0847, 0.8943, 0.5367, 0.0338]},
                {"title": [0.072, 0.4381, 0.5367, 0.0543], "type": [0.55, 0.4381, 0.5367, 0.0286],
                 "text": [0.6087, 0.4334, 0.5174, 0.2443], "art": [0.158, 0.0534, 0.3734, 0.3886],
                 "mana": [0.0847, 0.4381, 0.5367, 0.0338]},
            ],
        }},
    },
}

PACKS: dict[str, dict] = {
    "m15": {
        "options": {"name": "M15 (modern frame)"},
        "files": {**group("", IMG + "m15/regular/m15Frame{}.png"), **M15_PT,
                  **group("crown_", IMG + "m15/crowns/m15Crown{}.png")},
        "variants": M15_VARIANTS,
    },
    "m15_box_topper": {
        "options": {"name": "Borderless (box topper)", "fullArt": True, "typeColor": WHITE},
        "files": {**group("", IMG + "m15/boxTopper/m15BoxTopperFrame{}.png"),
                  **group("land_", IMG + "m15/boxTopper/m15BoxTopperFrame{}L.png", keys="wubrgm")},
    },
    "m15_commander_legends": {
        "options": {"name": "Commander Legends", "titleColor": WHITE, "textColor": WHITE},
        "files": {**group("", IMG + "m15/commanderLegends/frame{}.png", rename={"l": "C"}),
                  **group("pt_", IMG + "m15/commanderLegends/pt{}.png", rename={"l": "C"})},
    },
    "m15_devoid": {
        "options": {"name": "Devoid (see-through)", "fullArt": True},
        "files": {**group("", IMG + "m15/devoid/m15DevoidFrame{}.png"), **same("pt_", IMG + "m15/devoid/m15DevoidPT.png")},
    },
    "m15_showcase": {
        "options": {"name": "Showcase (borderless, translucent)", "fullArt": True, "titleColor": WHITE, "textColor": WHITE},
        "files": group("", IMG + "m15/borderless/m15GenericShowcaseFrame{}.png"),
    },
    "m15_invention": {
        "options": {"name": "Kaladesh Invention"},
        "files": group("", OLD + "inventionClassic/m15Frame{}InventionClassic.png", keys="wubrgma"),
    },
    "m15_m21": {
        # Its land frames have the big mana symbol printed in the text box already.
        "options": {"name": "M21 Showcase", "titleColor": WHITE, "landTextColor": WHITE, "landSymbol": True},
        "files": {**group("", IMG + "m15/m21/m15M21Frame{}.png", keys="wubrg"),
                  **group("land_", IMG + "m15/m21/m15M21Frame{}L.png", keys="wubrg"),
                  **group("pt_", IMG + "m15/m21/m15M21PT{}.png", keys="wubrg")},
    },
    "m15_nyx": {
        "options": {"name": "Nyx (starfield)"},
        "files": group("", IMG + "m15/nyx/m15Frame{}Nyx.png", keys="wubrgma"),
    },
    "m15_zendikar": {
        "options": {"name": "Zendikar Rising Showcase", "fullArt": True, "titleColor": WHITE, "textColor": WHITE,
                    "layout": {"crown": [0.0293, 0.0172, 0.9413, 0.1167]}},
        "files": {**group("", IMG + "m15/zendikarRising/m15ZendikarRisingFrame{}.png"),
                  **group("crown_", IMG + "m15/zendikarRising/m15ZendikarRisingCrown{}.png"),
                  **group("pt_", IMG + "m15/zendikarRising/m15ZendikarRisingPT{}.png",
                          rename={"u": "C", "r": "C", "g": "C", "a": "C", "l": "C"})},
    },
}


# The real card fonts (Beleren, MPlantin) — also Wizards' property, so they live in a git-ignored folder.
FONTS_DIR = Path(__file__).resolve().parent / "public" / "fonts" / "card"
FONTS = {
    "beleren-b.ttf": "fonts/beleren-b.ttf",  # names, type lines
    "beleren-bsc.ttf": "fonts/beleren-bsc.ttf",  # small caps: P/T, loyalty, artist line
    "mplantin.ttf": "fonts/mplantin.ttf",  # rules text
    "mplantin-i.ttf": "fonts/mplantin-i.ttf",  # italic: flavor and reminder text
}


def plan(names: list[str]) -> tuple[list[tuple[str, Path]], dict[Path, dict]]:
    """All (source, destination) downloads and the frame.json files to write."""
    downloads, configs = [], {}
    for name in names:
        pack = PACKS[name]
        root = FRAMES / name
        options = dict(pack["options"])
        options["source"] = "https://github.com/Investigamer/cardconjurer"
        for dest, src in pack["files"].items():
            downloads.append((src, root / dest))
        variants = {}
        for vname, variant in pack.get("variants", {}).items():
            for dest, src in variant["files"].items():
                downloads.append((src, root / vname / dest))
            variants[vname] = variant["options"]
        if variants:
            options["variants"] = variants
        configs[root / "frame.json"] = options
    return downloads, configs


def looks_valid(path: Path) -> bool:
    head = path.read_bytes()[:256]
    font = head[:4] in (b"\x00\x01\x00\x00", b"OTTO", b"true")
    return font or head.startswith(b"\x89PNG\r\n\x1a\n") or b"<svg" in head or head.lstrip().startswith(b"<?xml")


def curl_download(jobs: list[tuple[str, Path]]) -> None:
    """Download every distinct source once with one parallel curl run, then copy to each destination."""
    curl = shutil.which("curl")
    if not curl:
        sys.exit("curl was not found. It ships with Windows 10+, macOS and most Linux distributions.")
    by_source: dict[str, list[Path]] = {}
    for src, dest in jobs:
        by_source.setdefault(src, []).append(dest)
    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = Path(tmp)
        config = tmpdir / "curl.cfg"
        targets = {src: tmpdir / f"{i}{Path(src).suffix}" for i, src in enumerate(by_source)}
        config.write_text("".join(f'url = "{REPO}{src}"\noutput = "{out.as_posix()}"\n' for src, out in targets.items()),
                          encoding="utf-8")
        base = [curl, "--fail", "--silent", "--show-error", "--location", "--retry", "2", "--config", str(config)]
        result = subprocess.run(base[:1] + ["--parallel", "--parallel-max", "8"] + base[1:])
        if result.returncode != 0:  # older curl without --parallel, or a transient error: retry one by one
            subprocess.run(base)
        failed = []
        for src, tmpfile in targets.items():
            if not tmpfile.is_file() or not looks_valid(tmpfile):
                failed.append(src)
                continue
            for dest in by_source[src]:
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(tmpfile, dest)
        if failed:
            print(f"\n{len(failed)} file(s) could not be downloaded:", *failed, sep="\n  ")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("packs", nargs="*", help="pack names (default: all)")
    ap.add_argument("--list", action="store_true", help="list available packs")
    ap.add_argument("--force", action="store_true", help="re-download existing files")
    args = ap.parse_args()

    if args.list:
        for name, pack in PACKS.items():
            print(f"{name:24} {pack['options']['name']}")
        return
    unknown = [p for p in args.packs if p not in PACKS]
    if unknown:
        sys.exit(f"Unknown pack(s): {', '.join(unknown)}. Use --list to see the options.")
    names = args.packs or list(PACKS)

    downloads, configs = plan(names)
    downloads += [(src, FONTS_DIR / dest) for dest, src in FONTS.items()]
    todo = [(s, d) for s, d in downloads if args.force or not d.exists()]
    print(f"{len(names)} pack(s), {len(downloads)} files, {len(todo)} to download...", flush=True)
    if todo:
        curl_download(todo)
    for path, options in configs.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(options, indent=2) + "\n", encoding="utf-8")
    missing = [d for _, d in downloads if not d.exists()]
    print(f"Done: {len(downloads) - len(missing)}/{len(downloads)} files in {FRAMES}.")
    if missing:
        sys.exit(1)


if __name__ == "__main__":
    main()
