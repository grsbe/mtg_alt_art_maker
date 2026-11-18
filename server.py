"""MTG Alt Art Maker - server (FastAPI + uvicorn).

Run with:  uv run server.py   (then open the printed URL)
     or:   uv run uvicorn server:app --host 127.0.0.1 --port 8765   (e.g. on a server behind a proxy)

Responsibilities:
  * serve the web UI from ./public
  * import decklists via the Scryfall API; cache card JSON, images and mana symbols in ./cache
  * manage decks, one folder each:  decks/<slug>/deck.json, decks/<slug>/art/, decks/<slug>/proxies/
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import shutil
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from contextlib import asynccontextmanager
from http import HTTPStatus
from pathlib import Path

import uvicorn
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
CACHE = ROOT / "cache"
CACHE_CARDS = CACHE / "cards"
CACHE_IMAGES = CACHE / "images"
CACHE_SYMBOLS = CACHE / "symbols"
DECKS = ROOT / "decks"
FRAMES = ROOT / "frames"

SCRYFALL = "https://api.scryfall.com"
USER_AGENT = "mtg-alt-art-maker/0.2"
MAX_UPLOAD = 64 * 1024 * 1024
ART_EXTS = {"png", "jpg", "jpeg", "webp", "gif"}
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
ID_RE = r"[0-9a-f-]{36}"

# --------------------------------------------------------------------------
# Scryfall access
# --------------------------------------------------------------------------

_rate_lock = threading.Lock()
_last_api_call = 0.0


def _http(url: str, payload: dict | None = None, throttle: bool = True) -> bytes:
    """GET (or POST JSON) a URL. API calls are spaced >=100ms apart as Scryfall asks."""
    global _last_api_call
    if throttle:
        with _rate_lock:
            wait = 0.1 - (time.monotonic() - _last_api_call)
            if wait > 0:
                time.sleep(wait)
            _last_api_call = time.monotonic()
    headers = {"User-Agent": USER_AGENT, "Accept": "application/json;q=0.9,*/*;q=0.8"}
    body = None
    if payload is not None:
        body = json.dumps(payload).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read()


def _api(path: str, payload: dict | None = None) -> dict | None:
    try:
        return json.loads(_http(SCRYFALL + path, payload))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise


def lookup_collection(identifiers: list[dict]) -> list[dict | None]:
    """Resolve identifiers via /cards/collection (75 per request). Returns one card (or None) per identifier."""
    out: list[dict | None] = []
    for start in range(0, len(identifiers), 75):
        chunk = identifiers[start : start + 75]
        resp = _api("/cards/collection", {"identifiers": chunk}) or {}
        not_found = resp.get("not_found", [])
        data = iter(resp.get("data", []))
        # Scryfall returns found cards in request order, skipping the not_found ones.
        for ident in chunk:
            out.append(None if ident in not_found else next(data, None))
    return out


def fuzzy_named(name: str, set_code: str | None = None) -> dict | None:
    q = {"fuzzy": name}
    if set_code:
        q["set"] = set_code
    card = _api("/cards/named?" + urllib.parse.urlencode(q))
    if card is None and set_code:
        card = _api("/cards/named?" + urllib.parse.urlencode({"fuzzy": name}))
    return card


def face_image_uris(card: dict) -> list[dict]:
    if "image_uris" in card:
        return [card["image_uris"]]
    return [f["image_uris"] for f in card.get("card_faces", []) if "image_uris" in f]


def image_path(card_id: str, face: int, kind: str) -> Path:
    return CACHE_IMAGES / f"{card_id}_{face}_{kind}.jpg"


def cache_card(card: dict) -> None:
    """Write card JSON and download the full-card + art-crop image for every face."""
    _write_atomic(CACHE_CARDS / f"{card['id']}.json", json.dumps(card).encode())
    for i, uris in enumerate(face_image_uris(card)):
        for kind, key in (("large", "large"), ("art", "art_crop")):
            dest = image_path(card["id"], i, kind)
            if not dest.exists() and uris.get(key):
                _write_atomic(dest, _http(uris[key], throttle=False))


def load_cached_card(card_id: str) -> dict | None:
    p = CACHE_CARDS / f"{card_id}.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def is_cached(card_id: str) -> bool:
    card = load_cached_card(card_id)
    if not card:
        return False
    return all(image_path(card_id, i, "large").exists() for i in range(len(face_image_uris(card))))


# ---- mana symbols (official Scryfall SVGs, cached on first use) ----

_symbol_lock = threading.Lock()
_symbol_index: dict[str, str] | None = None  # "{W/U}" -> "https://svgs.scryfall.io/card-symbols/WU.svg"


def symbol_index() -> dict[str, str]:
    global _symbol_index
    with _symbol_lock:
        if _symbol_index is None:
            index_file = CACHE_SYMBOLS / "index.json"
            if index_file.exists():
                _symbol_index = json.loads(index_file.read_text(encoding="utf-8"))
            else:
                data = _api("/symbology") or {}
                _symbol_index = {s["symbol"]: s["svg_uri"] for s in data.get("data", []) if s.get("svg_uri")}
                _write_atomic(index_file, json.dumps(_symbol_index, indent=1).encode())
        return _symbol_index


def symbol_file(basename: str) -> Path | None:
    """Return the cached SVG for e.g. 'WU.svg', downloading it on first request."""
    if not re.fullmatch(r"[A-Za-z0-9_.-]+\.svg", basename):
        return None
    dest = CACHE_SYMBOLS / basename
    if dest.exists():
        return dest
    uri = next((u for u in symbol_index().values() if u.rsplit("/", 1)[-1] == basename), None)
    if not uri:
        return None
    try:
        _write_atomic(dest, _sized_svg(_http(uri, throttle=False)))
    except PermissionError:  # Windows: another request is swapping in the same file right now
        if not dest.exists():
            raise
    return dest


def _sized_svg(data: bytes) -> bytes:
    """Give the root <svg> explicit width/height so every browser can draw it onto a canvas."""
    text = data.decode("utf-8")
    m = re.search(r"<svg\b[^>]*>", text)
    if m and "width=" not in m.group(0):
        vb = re.search(r"viewBox=[\"']\s*[\d.-]+[\s,]+[\d.-]+[\s,]+([\d.]+)[\s,]+([\d.]+)", m.group(0))
        w, h = vb.groups() if vb else ("100", "100")
        tag = m.group(0)
        text = text.replace(tag, tag[:-1] + f' width="{w}" height="{h}">', 1)
    return text.encode("utf-8")


# --------------------------------------------------------------------------
# Frame packs: frames/<pack>/ with one blank frame image per color (+ optional frame.json)
# --------------------------------------------------------------------------

FRAME_KEYS = ["W", "U", "B", "R", "G", "gold", "artifact", "land"]
FRAME_AUTO_NAMES = {
    "W": ["w", "white"], "U": ["u", "blue"], "B": ["b", "black"], "R": ["r", "red"], "G": ["g", "green"],
    "gold": ["m", "gold", "multicolor", "multi"], "artifact": ["a", "artifact", "c", "colorless"], "land": ["l", "land"],
}
FRAME_EXTS = (".png", ".webp", ".jpg", ".jpeg")


FRAME_VARIANTS = ["transform_front", "transform_back", "modal_front", "modal_back", "adventure", "saga",
                  "planeswalker", "split", "flip", "aftermath", "class", "battle", "leveler"]
FRAME_OPTIONS = ["textColor", "titleColor", "typeColor", "ptColor", "loyaltyColor", "landTextColor", "landSymbol",
                 "landscape", "defenseColor"]


def _describe_frame_dir(d: Path, cfg: dict) -> dict | None:
    """Frames, P/T boxes, crowns, land frames and extra assets of one pack folder (or variant subfolder)."""
    files = {f.name.lower(): f.name for f in d.iterdir() if f.is_file()}
    base_url = "/frames/" + "/".join(urllib.parse.quote(p) for p in d.relative_to(FRAMES).parts)
    used: set[str] = set()

    def resolve(group: str, prefixes: list[str]) -> dict[str, str]:
        mapping = cfg.get(group) if isinstance(cfg.get(group), dict) else {}
        out = {}
        for key in FRAME_KEYS:
            name = mapping.get(key)
            if not name:
                candidates = [p + n + e for p in prefixes for n in FRAME_AUTO_NAMES[key] for e in FRAME_EXTS]
                name = next((files[c] for c in candidates if c in files), None)
            if name and (d / name).is_file():
                used.add(name.lower())
                out[key] = f"{base_url}/{urllib.parse.quote(name)}"
        return out

    frames = resolve("frames", ["", "frame_", "frame-"])
    if not frames:
        return None
    info = {
        "fullArt": cfg.get("fullArt"),
        "layout": cfg.get("layout") if isinstance(cfg.get("layout"), dict) else {},
        **{k: cfg.get(k) for k in FRAME_OPTIONS},
        "frames": frames,
        "landFrames": resolve("landFrames", ["land_", "land-"]),  # optional land-specific frames per color
        "pt": resolve("pt", ["pt_", "pt-"]),
        "crowns": resolve("crowns", ["crown_", "crown-"]),
    }
    # Anything else (icon.svg, chapter.png, plus.png, …) is an asset the renderer may ask for by name.
    info["assets"] = {
        Path(n).stem: f"{base_url}/{urllib.parse.quote(n)}"
        for low, n in files.items()
        if low not in used and Path(low).suffix in (".png", ".svg", ".webp", ".jpg", ".jpeg")
    }
    return info


def list_frames() -> list[dict]:
    """Describe every usable pack (see frames/README.md). Variants live in subfolders of a pack."""
    packs = []
    if not FRAMES.is_dir():
        return packs
    for d in sorted(p for p in FRAMES.iterdir() if p.is_dir()):
        cfg: dict = {}
        cfg_file = d / "frame.json"
        if cfg_file.is_file():
            try:
                cfg = json.loads(cfg_file.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as e:
                print(f"Ignoring broken {cfg_file}: {e}", flush=True)
        info = _describe_frame_dir(d, cfg)
        if info is None:
            continue
        variant_cfg = cfg.get("variants") if isinstance(cfg.get("variants"), dict) else {}
        variants = {}
        for name in FRAME_VARIANTS:
            if (d / name).is_dir():
                v = _describe_frame_dir(d / name, variant_cfg.get(name) or {})
                if v:
                    variants[name] = v
        packs.append({"id": d.name, "name": cfg.get("name") or d.name, **info, "variants": variants})
    return packs


# --------------------------------------------------------------------------
# Decklist parsing
# --------------------------------------------------------------------------

SECTION_WORDS = {
    "commander": "commander",
    "commanders": "commander",
    "deck": "main",
    "main": "main",
    "mainboard": "main",
    "main deck": "main",
    "companion": "main",
    "sideboard": "skip",
    "maybeboard": "skip",
    "considering": "skip",
    "tokens": "skip",
}
QTY_RE = re.compile(r"^(\d+)\s*[xX]?\s+(.+)$")
SET_RE = re.compile(r"\s+\(([A-Za-z0-9]{2,6})\)(?:\s+(\S+))?\s*$")


def parse_decklist(text: str) -> list[dict]:
    """Parse Moxfield / Archidekt / MTGA / plain-name style lists."""
    section = "main"
    entries: dict[str, dict] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith(("//", "#")):
            key = line.lstrip("/#").strip().rstrip(":").lower()
            section = SECTION_WORDS.get(key, section)
            continue
        m = QTY_RE.match(line)
        if m:
            qty, rest = int(m.group(1)), m.group(2)
        else:
            key = re.sub(r"\s*\(\d+\)$", "", line.rstrip(":")).lower()
            if key in SECTION_WORDS:
                section = SECTION_WORDS[key]
                continue
            if re.search(r"\(\d+\)$", line):  # category header such as "Creatures (30)"
                continue
            qty, rest = 1, line

        is_commander = "*CMDR*" in rest or re.search(r"\[[^\]]*commander", rest, re.I)
        rest = re.sub(r"\[[^\]]*\]", "", rest)  # Archidekt categories
        rest = re.sub(r"\^[^^]*\^", "", rest)  # Archidekt colour tags
        rest = re.sub(r"\*[A-Za-z]+\*", "", rest).strip()  # *F*, *CMDR*, ...
        set_code = number = None
        sm = SET_RE.search(rest)
        if sm:
            set_code, number = sm.group(1).lower(), sm.group(2)
            rest = rest[: sm.start()].strip()
        sec = "commander" if is_commander else section
        if sec == "skip" or not rest:
            continue
        key = rest.lower()
        if key in entries:
            entries[key]["qty"] += qty
            if sec == "commander":
                entries[key]["section"] = "commander"
        else:
            entries[key] = {"qty": qty, "name": rest, "set": set_code, "number": number, "section": sec}
    return list(entries.values())


def identifier_for(entry: dict) -> dict:
    if entry.get("set") and entry.get("number"):
        return {"set": entry["set"], "collector_number": entry["number"]}
    if entry.get("set"):
        return {"name": entry["name"], "set": entry["set"]}
    return {"name": entry["name"]}


# --------------------------------------------------------------------------
# Decks: decks/<slug>/deck.json (+ art/, proxies/)
# --------------------------------------------------------------------------

DECK_LOCK = threading.RLock()
EDITABLE_KEYS = {
    "customName": (str, type(None)),
    "subtitle": (str, type(None)),
    "hideSubtitle": (bool,),
    "subtitleStyle": (str,),
    "frame": (str,),
    "frameColor": (str,),
    "crop": (dict,),
    "overrides": (dict,),
    "section": (str,),
    "notes": (str,),
    "done": (bool,),
    "back": (dict, type(None)),
}
# Settings of a card's second face (double-faced back, right half of a split card, adventure part).
# "art" and "proxy" are managed by the upload endpoints only.
BACK_KEYS = {
    "customName": (str, type(None)),
    "subtitle": (str, type(None)),
    "hideSubtitle": (bool,),
    "subtitleStyle": (str,),
    "frameColor": (str,),
    "crop": (dict,),
    "overrides": (dict,),
}


def merge_back(entry: dict, value: dict | None) -> None:
    if value is None:
        entry.pop("back", None)
        return
    back = entry.get("back") or {}
    for k, v in value.items():
        if k in BACK_KEYS and isinstance(v, BACK_KEYS[k]):
            back[k] = v
    if back.get("customName") is not None and not back["customName"].strip():
        back["customName"] = None
    back["overrides"] = {k: v for k, v in (back.get("overrides") or {}).items() if isinstance(v, str) and v.strip()}
    entry["back"] = back


def slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_")[:60] or "deck"


def deck_dir(slug: str) -> Path | None:
    if not SLUG_RE.fullmatch(slug):
        return None
    d = DECKS / slug
    return d if (d / "deck.json").is_file() else None


def new_entry(card_id: str, name: str) -> dict:
    return {
        "id": card_id,
        "name": name,
        "qty": 1,
        "section": "main",
        "done": False,
        "customName": None,
        "subtitle": None,  # None = automatic (original name when renamed)
        "hideSubtitle": False,
        "frame": "default",  # "default" = the deck's defaultFrame; else "standard", "fullart" or "pack:<id>"
        "frameColor": "auto",
        "art": None,  # relative to the deck folder, e.g. "art/sol_ring.png"
        "crop": {"x": 0, "y": 0, "scale": 1, "rot": 0},
        "overrides": {},
        "proxy": None,  # relative to the deck folder, e.g. "proxies/sol_ring.png"
        "notes": "",
    }


def is_customized(entry: dict) -> bool:
    back = entry.get("back") or {}
    return bool(entry.get("customName") or entry.get("art") or entry.get("overrides") or entry.get("proxy")
                or entry.get("done") or back.get("customName") or back.get("art") or back.get("overrides"))


def load_deck(d: Path) -> dict:
    f = d / "deck.json"
    deck = json.loads(f.read_text(encoding="utf-8")) if f.exists() else {}
    deck.setdefault("version", 1)
    deck.setdefault("name", d.name)
    deck.setdefault("cards", [])
    deck.setdefault("archived", [])
    # "auto" = the first frame pack in frames/, or the drawn frame if there is none.
    deck.setdefault("defaultFrame", "auto")
    if deck["version"] < 2:  # v1 had no deck default; its "standard" simply meant "nothing chosen"
        for c in deck["cards"] + deck["archived"]:
            if c.get("frame") == "standard":
                c["frame"] = "default"
        deck["version"] = 2
    for c in deck["cards"]:
        for k, v in new_entry(c.get("id", ""), c.get("name", "")).items():
            c.setdefault(k, v)
    return deck


def save_deck(d: Path, deck: dict) -> None:
    deck["cards"].sort(key=lambda c: (c.get("section") != "commander", c.get("name", "").lower()))
    deck["archived"].sort(key=lambda c: c.get("name", "").lower())
    text = json.dumps(deck, indent=2, ensure_ascii=False) + "\n"
    _write_atomic(d / "deck.json", text.encode("utf-8"))


def create_deck(name: str) -> str:
    with DECK_LOCK:
        base = slugify(name)
        slug, n = base, 2
        while (DECKS / slug).exists():
            slug, n = f"{base}_{n}", n + 1
        d = DECKS / slug
        for sub in ("art", "proxies"):
            (d / sub).mkdir(parents=True, exist_ok=True)
        save_deck(d, {"version": 2, "name": name, "defaultFrame": "auto", "cards": [], "archived": []})
        return slug


def list_decks() -> list[dict]:
    out = []
    if DECKS.is_dir():
        for d in sorted(DECKS.iterdir()):
            if deck_dir(d.name):
                try:
                    deck = load_deck(d)
                except (OSError, json.JSONDecodeError):
                    continue
                cards = deck["cards"]
                out.append({
                    "slug": d.name,
                    "name": deck["name"],
                    "cards": len(cards),
                    "done": sum(1 for c in cards if c.get("done")),
                })
    out.sort(key=lambda x: x["name"].lower())
    return out


def find_entry(deck: dict, card_id: str) -> dict | None:
    return next((c for c in deck["cards"] if c["id"] == card_id), None)


def merge_import(d: Path, found: list[tuple[dict, dict]]) -> None:
    """Replace the deck's card list with an imported one, keeping customizations by card name.

    Customized cards that are no longer in the list move to "archived" so no work is lost;
    re-importing them later restores everything.
    """
    with DECK_LOCK:
        deck = load_deck(d)
        previous = {c["name"].lower(): c for c in deck["cards"] + deck["archived"]}
        cards: dict[str, dict] = {}
        for entry, card in found:
            prev = previous.pop(card["name"].lower(), None) or previous.pop(entry["name"].lower(), None)
            item = prev or new_entry(card["id"], card["name"])
            item.update(id=card["id"], name=card["name"], qty=entry["qty"], section=entry["section"])
            if card["id"] in cards:
                cards[card["id"]]["qty"] += entry["qty"]
            else:
                cards[card["id"]] = item
        deck["cards"] = list(cards.values())
        deck["archived"] = [c for c in previous.values() if is_customized(c)]
        save_deck(d, deck)


def migrate_legacy_layout() -> None:
    """Move a pre-0.2 single deck (./deck.json, ./art, ./proxies) into decks/<slug>/."""
    legacy = ROOT / "deck.json"
    if not legacy.is_file():
        for sub in ("art", "proxies"):  # drop the empty placeholder folders of the old layout
            p = ROOT / sub
            if p.is_dir() and {f.name for f in p.iterdir()} <= {".gitkeep"}:
                shutil.rmtree(p)
        return
    deck = json.loads(legacy.read_text(encoding="utf-8"))
    name = deck.get("name") or "My deck"
    if name == "Untitled deck":
        commander = next((c["name"] for c in deck.get("cards", []) if c.get("section") == "commander"), None)
        name = commander or "My deck"
        deck["name"] = name
    slug = create_deck(name)
    d = DECKS / slug
    for sub in ("art", "proxies"):
        src = ROOT / sub
        if src.is_dir():
            for f in src.iterdir():
                if f.name != ".gitkeep":
                    shutil.move(str(f), str(d / sub / f.name))
            shutil.rmtree(src)
    save_deck(d, deck)  # paths like "art/x.png" stay valid: they are now relative to the deck folder
    legacy.unlink()
    print(f"Moved your existing deck into decks/{slug}/", flush=True)


# --------------------------------------------------------------------------
# Background jobs (import / cache refresh) with pollable progress
# --------------------------------------------------------------------------


class Job:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.state = {"running": False, "kind": None, "deck": None, "done": 0, "total": 0, "message": "", "errors": []}

    def snapshot(self) -> dict:
        with self.lock:
            return json.loads(json.dumps(self.state))

    def update(self, **kw) -> None:
        with self.lock:
            self.state.update(kw)

    def error(self, msg: str) -> None:
        with self.lock:
            self.state["errors"].append(msg)

    def start(self, kind: str, slug: str, target, *args) -> bool:
        with self.lock:
            if self.state["running"]:
                return False
            self.state = {"running": True, "kind": kind, "deck": slug, "done": 0, "total": 0, "message": "Starting…", "errors": []}

        def runner():
            try:
                target(*args)
            except Exception as e:  # surface anything unexpected in the UI
                self.error(f"{type(e).__name__}: {e}")
                self.update(message="Failed")
            finally:
                self.update(running=False)

        threading.Thread(target=runner, daemon=True).start()
        return True


JOB = Job()


def _download_all(cards: list[dict]) -> None:
    JOB.update(total=len(cards), done=0)
    for i, card in enumerate(cards, 1):
        JOB.update(message=f"Downloading {card['name']}")
        try:
            cache_card(card)
        except Exception as e:
            JOB.error(f"{card['name']}: image download failed ({e})")
        JOB.update(done=i)


def run_import(d: Path, text: str) -> None:
    entries = parse_decklist(text)
    if not entries:
        JOB.update(message="No cards found in that list")
        return
    JOB.update(message=f"Looking up {len(entries)} cards on Scryfall…", total=len(entries))
    # Without an explicit set, keep the printing already in the deck so re-imports don't churn ids.
    with DECK_LOCK:
        deck = load_deck(d)
    known: dict[str, str] = {}
    for c in deck["cards"] + deck["archived"]:
        known[c["name"].lower()] = c["id"]
        known.setdefault(c["name"].split(" // ")[0].lower(), c["id"])
    identifiers = [
        {"id": known[e["name"].lower()]} if not e.get("set") and e["name"].lower() in known else identifier_for(e)
        for e in entries
    ]
    results = lookup_collection(identifiers)
    found: list[tuple[dict, dict]] = []
    for entry, card in zip(entries, results):
        if card is None:
            JOB.update(message=f"Fuzzy-searching {entry['name']}…")
            card = fuzzy_named(entry["name"], entry.get("set"))
        if card is None:
            JOB.error(f"Not found on Scryfall: {entry['name']}")
        else:
            found.append((entry, card))
    _download_all([c for _, c in found])
    merge_import(d, found)
    JOB.update(message=f"Imported {len(found)} cards")


def run_refresh(d: Path) -> None:
    """Fetch cache for deck cards that are missing locally (e.g. right after a fresh git clone)."""
    with DECK_LOCK:
        ids = [c["id"] for c in load_deck(d)["cards"]]
    missing = [i for i in ids if not is_cached(i)]
    if not missing:
        JOB.update(message="Cache is complete")
        return
    JOB.update(message=f"Fetching {len(missing)} cards from Scryfall…", total=len(missing))
    cards = [c for c in lookup_collection([{"id": i} for i in missing]) if c]
    _download_all(cards)
    JOB.update(message=f"Cached {len(cards)} cards")


# --------------------------------------------------------------------------
# Payload for the frontend
# --------------------------------------------------------------------------

CARD_KEYS = [
    "name", "mana_cost", "type_line", "oracle_text", "flavor_text", "power", "toughness",
    "loyalty", "defense", "colors", "color_identity", "artist", "set", "set_name",
    "collector_number", "layout", "cmc", "rarity", "produced_mana", "keywords",
]
FACE_KEYS = ["name", "mana_cost", "type_line", "oracle_text", "flavor_text", "power", "toughness", "loyalty", "defense", "colors", "artist"]


def summarize(card: dict) -> dict:
    s = {k: card.get(k) for k in CARD_KEYS}
    faces = card.get("card_faces") or [card]
    s["faces"] = [{k: f.get(k) for k in FACE_KEYS} for f in faces]
    for k in FACE_KEYS:  # double-faced cards keep these on the faces only
        if s.get(k) is None and k != "name":
            s[k] = s["faces"][0].get(k)
    s["images"] = [
        {"large": f"/cache/images/{card['id']}_{i}_large.jpg", "art": f"/cache/images/{card['id']}_{i}_art.jpg"}
        for i in range(len(face_image_uris(card)))
    ]
    return s


def deck_rev(d: Path) -> str:
    """Changes whenever deck.json is rewritten (every edit, upload and export goes through it).
    Browsers poll this to pick up other people's changes."""
    try:
        st = (d / "deck.json").stat()
    except OSError:
        return ""
    return f"{st.st_mtime_ns}-{st.st_size}"


def deck_file_versions(d: Path, deck: dict) -> dict:
    """Modification time of every art/proxy file the deck references, used as a cache buster:
    re-exporting a proxy keeps its file name, so the name alone can't tell browsers it changed."""
    out = {}
    for entry in deck["cards"]:
        for target in (entry, entry.get("back") or {}):
            for key in ("art", "proxy"):
                if rel := target.get(key):
                    try:
                        out[rel] = (d / rel).stat().st_mtime_ns
                    except OSError:
                        pass
    return out


def deck_payload(d: Path) -> dict:
    with DECK_LOCK:
        rev = deck_rev(d)  # read before loading: a write in between only makes the next poll refetch
        deck = load_deck(d)
    cards, missing = {}, []
    for entry in deck["cards"]:
        card = load_cached_card(entry["id"])
        cards[entry["id"]] = summarize(card) if card else None
        if not is_cached(entry["id"]):
            missing.append(entry["id"])
    return {"slug": d.name, "deck": deck, "cards": cards, "missing": missing,
            "rev": rev, "files": deck_file_versions(d, deck)}


# --------------------------------------------------------------------------
# HTTP (FastAPI + uvicorn)


def _write_atomic(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # A unique temp name per write: two threads writing the same file must not share one temp file.
    tmp = path.with_name(f"{path.name}.{threading.get_ident()}.{time.monotonic_ns()}.tmp")
    try:
        tmp.write_bytes(data)
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("image/webp", ".webp")
mimetypes.add_type("image/svg+xml", ".svg")


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # Runs however the app is started: `uv run server.py` or `uvicorn server:app`.
    for d in (CACHE_CARDS, CACHE_IMAGES, CACHE_SYMBOLS, DECKS, FRAMES):
        d.mkdir(parents=True, exist_ok=True)
    migrate_legacy_layout()
    yield


app = FastAPI(title="MTG Alt Art Maker", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


# Every error goes out as {"error": "..."}: the frontend shows that text to the user.
@app.exception_handler(StarletteHTTPException)
async def http_error(_request: Request, exc: StarletteHTTPException):
    return JSONResponse({"error": str(exc.detail)}, status_code=exc.status_code, headers=exc.headers)


@app.exception_handler(RequestValidationError)
async def validation_error(_request: Request, exc: RequestValidationError):
    return JSONResponse({"error": "Invalid request"}, status_code=HTTPStatus.BAD_REQUEST)


@app.middleware("http")
async def no_cache_by_default(request: Request, call_next):
    """Browsers revalidate everything (cheap thanks to ETags), so edits and new exports show up at once."""
    response = await call_next(request)
    response.headers.setdefault("Cache-Control", "no-cache")
    return response


def fail(status: int, msg: str) -> HTTPException:
    return HTTPException(status_code=status, detail=msg)


async def read_body(request: Request) -> bytes:
    length = request.headers.get("content-length", "")
    if length.isdigit() and int(length) > MAX_UPLOAD:
        raise fail(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "Upload too large")
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_UPLOAD:
            raise fail(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "Upload too large")
        chunks.append(chunk)
    return b"".join(chunks)


async def json_body(request: Request) -> dict:
    body = await read_body(request)
    try:
        data = json.loads(body or b"{}")
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise fail(HTTPStatus.BAD_REQUEST, "Invalid JSON")
    if not isinstance(data, dict):
        raise fail(HTTPStatus.BAD_REQUEST, "Expected a JSON object")
    return data


def deck_or_404(slug: str) -> Path:
    d = deck_dir(slug)
    if d is None:
        raise fail(HTTPStatus.NOT_FOUND, f"No deck named {slug!r}")
    return d


def check_card_id(card_id: str) -> None:
    if not re.fullmatch(ID_RE, card_id):
        raise fail(HTTPStatus.NOT_FOUND, "Not found")


# Plain `def` endpoints run in FastAPI's thread pool, so the threading locks above keep working.

# ---- decks ----

@app.get("/api/decks")
def get_decks():
    return {"decks": list_decks()}


@app.post("/api/decks")
def post_deck(data: dict = Depends(json_body)):
    name = data.get("name")
    if not isinstance(name, str) or not name.strip():
        raise fail(HTTPStatus.BAD_REQUEST, "Deck name is empty")
    return {"slug": create_deck(name.strip())}


@app.get("/api/decks/{slug}")
def get_deck(slug: str):
    return deck_payload(deck_or_404(slug))


@app.get("/api/decks/{slug}/rev")
def get_deck_rev(slug: str):
    return {"rev": deck_rev(deck_or_404(slug))}


@app.patch("/api/decks/{slug}")
def patch_deck(slug: str, data: dict = Depends(json_body)):
    d = deck_or_404(slug)
    with DECK_LOCK:
        deck = load_deck(d)
        if isinstance(data.get("name"), str):
            deck["name"] = data["name"].strip() or d.name
        if isinstance(data.get("defaultFrame"), str) and data["defaultFrame"].strip():
            deck["defaultFrame"] = data["defaultFrame"].strip()
        save_deck(d, deck)
    return {"ok": True}


@app.patch("/api/decks/{slug}/cards/{card_id}")
def patch_card(slug: str, card_id: str, data: dict = Depends(json_body)):
    d = deck_or_404(slug)
    check_card_id(card_id)
    with DECK_LOCK:
        deck = load_deck(d)
        entry = find_entry(deck, card_id)
        if entry is None:
            raise fail(HTTPStatus.NOT_FOUND, "Card is not in the deck")
        for key, value in data.items():
            if key == "back" and isinstance(value, (dict, type(None))):
                merge_back(entry, value)
            elif key in EDITABLE_KEYS and isinstance(value, EDITABLE_KEYS[key]):
                entry[key] = value
        if entry.get("customName") is not None and not entry["customName"].strip():
            entry["customName"] = None
        entry["overrides"] = {k: v for k, v in entry["overrides"].items() if isinstance(v, str) and v.strip()}
        save_deck(d, deck)
    return {"entry": entry}


# ---- background jobs ----

def _start_job(started: bool) -> dict:
    if not started:
        raise fail(HTTPStatus.CONFLICT, "Another job is already running")
    return {"ok": True}


@app.post("/api/decks/{slug}/import")
def post_import(slug: str, data: dict = Depends(json_body)):
    d = deck_or_404(slug)
    text = data.get("text", "")
    if not isinstance(text, str) or not text.strip():
        raise fail(HTTPStatus.BAD_REQUEST, "Decklist is empty")
    return _start_job(JOB.start("import", d.name, run_import, d, text))


@app.post("/api/decks/{slug}/refresh")
def post_refresh(slug: str):
    d = deck_or_404(slug)
    return _start_job(JOB.start("refresh", d.name, run_refresh, d))


@app.get("/api/job")
def get_job():
    return JOB.snapshot()


# ---- uploads: raw image bytes in the body ----

def save_upload(d: Path, kind: str, card_id: str, query: dict, body: bytes) -> dict:
    ext = "png" if kind == "proxy" else (query.get("ext") or "png").lower().lstrip(".")
    if ext not in ART_EXTS:
        raise fail(HTTPStatus.BAD_REQUEST, f"Unsupported image type: {ext}")
    if not body:
        raise fail(HTTPStatus.BAD_REQUEST, "Empty upload")
    face = 1 if query.get("face") == "1" else 0  # 1 = the card's second face (stored in entry["back"])
    with DECK_LOCK:
        deck = load_deck(d)
        entry = find_entry(deck, card_id)
        if entry is None:
            raise fail(HTTPStatus.NOT_FOUND, "Card is not in the deck")
        target = entry.setdefault("back", {}) if face else entry
        sub = "art" if kind == "art" else "proxies"
        folder = d / sub
        rel = f"{sub}/{slugify(entry['name'])}{'_back' if face else ''}.{ext}"
        key = "art" if kind == "art" else "proxy"
        old = target.get(key)
        if old and old != rel:  # replaced with a different extension: remove the stale file
            old_path = (d / old).resolve()
            if old_path.is_relative_to(folder.resolve()) and old_path.is_file():
                old_path.unlink()
        _write_atomic(d / rel, body)
        target[key] = rel
        if kind == "art":
            target["crop"] = {"x": 0, "y": 0, "scale": 1, "rot": 0}
        elif query.get("done", "1") != "0":  # double-faced cards are done once both faces are exported
            entry["done"] = True
        save_deck(d, deck)
    return {"entry": entry}


@app.post("/api/decks/{slug}/{kind}/{card_id}")
async def post_upload(slug: str, kind: str, card_id: str, request: Request):
    if kind not in ("art", "proxy"):
        raise fail(HTTPStatus.NOT_FOUND, "Not found")
    d = deck_or_404(slug)
    check_card_id(card_id)
    body = await read_body(request)
    return await run_in_threadpool(save_upload, d, kind, card_id, dict(request.query_params), body)


# ---- frames and mana symbols ----

@app.get("/api/frames")
def get_frames():
    return {"frames": list_frames()}


@app.get("/api/symbols")
def get_symbols():
    try:
        index = symbol_index()
    except Exception as e:
        raise fail(HTTPStatus.BAD_GATEWAY, f"Could not load mana symbols: {e}")
    return {sym: "/symbols/" + uri.rsplit("/", 1)[-1] for sym, uri in index.items()}


@app.get("/symbols/{name}")
def get_symbol(name: str):
    try:
        f = symbol_file(name)
    except Exception:
        f = None
    if f is None:
        raise fail(HTTPStatus.NOT_FOUND, "Unknown symbol")
    return FileResponse(f, media_type="image/svg+xml", headers={"Cache-Control": "max-age=86400"})


# ---- static files (mounted last: routes above take precedence) ----

class Static(StaticFiles):
    """StaticFiles that never serves deck.json (it goes through the API) or half-written temp files."""

    async def get_response(self, path: str, scope):
        name = Path(path).name
        if name == "deck.json" or name.endswith(".tmp"):
            raise fail(HTTPStatus.NOT_FOUND, "Not found")
        response = await super().get_response(path, scope)
        ctype = response.headers.get("content-type", "")
        if ctype in ("application/javascript", "application/json"):  # Starlette only adds it for text/*
            response.headers["content-type"] = ctype + "; charset=utf-8"
        return response


app.mount("/cache", Static(directory=CACHE, check_dir=False), name="cache")
app.mount("/decks", Static(directory=DECKS, check_dir=False), name="decks")
app.mount("/frames", Static(directory=FRAMES, check_dir=False), name="frames")
app.mount("/", Static(directory=PUBLIC, html=True), name="public")


# --------------------------------------------------------------------------
# Entry point
# --------------------------------------------------------------------------


def bind_socket(host: str, first_port: int) -> socket.socket:
    """Bind the first free port from first_port on, so a busy port doesn't stop the app."""
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    for port in range(first_port, first_port + 20):
        sock = socket.socket(family, socket.SOCK_STREAM)
        # SO_REUSEADDR lets Windows silently share a port with another program; only use it elsewhere.
        if os.name != "nt":
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind((host, port))
            return sock
        except OSError as e:  # in use / reserved by another program (WinError 10013, EADDRINUSE)
            sock.close()
            print(f"Port {port} is not available ({e.strerror or e}); trying {port + 1}…", flush=True)
    raise SystemExit(f"No free port found in {first_port}-{first_port + 19}. Try --port <number>.")


def main() -> None:
    ap = argparse.ArgumentParser(description="MTG Alt Art Maker server")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--no-browser", action="store_true", help="don't open a browser tab")
    ap.add_argument("--access-log", action="store_true", help="log every request, not only errors")
    args = ap.parse_args()

    sock = bind_socket(args.host, args.port)
    port = sock.getsockname()[1]
    host = f"[{args.host}]" if ":" in args.host else args.host
    url = f"http://{host}:{port}/"
    print(f"MTG Alt Art Maker running at {url}  (Ctrl+C to stop)", flush=True)
    if not args.no_browser:
        threading.Timer(0.8, webbrowser.open, (url,)).start()
    config = uvicorn.Config(app, log_level="info" if args.access_log else "warning", access_log=args.access_log)
    uvicorn.Server(config).run(sockets=[sock])
    print("Stopped.")


if __name__ == "__main__":
    main()
