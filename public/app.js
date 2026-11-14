"use strict";

const $ = (sel) => document.querySelector(sel);

const GROUP_ORDER = ["Commander", "Creature", "Planeswalker", "Battle", "Instant", "Sorcery", "Artifact", "Enchantment", "Land", "Other"];
const GROUP_LABEL = {
  Commander: "Commander", Creature: "Creatures", Planeswalker: "Planeswalkers", Battle: "Battles",
  Instant: "Instants", Sorcery: "Sorceries", Artifact: "Artifacts", Enchantment: "Enchantments",
  Land: "Lands", Other: "Other",
};
// Check order matters: "Artifact Creature" is a creature, "Artifact Land" is a land.
const TYPE_CHECK = ["Creature", "Land", "Planeswalker", "Battle", "Instant", "Sorcery", "Artifact", "Enchantment"];
const SAVE_KEYS = ["customName", "subtitle", "hideSubtitle", "subtitleStyle", "frame", "frameColor", "crop", "overrides", "section", "notes", "done", "back"];
const ART_TYPES = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const FRAME_KEYS = ["W", "U", "B", "R", "G", "gold", "artifact", "land"];
const NO_CROP = { x: 0, y: 0, scale: 1, rot: 0 };
const FACE_LABELS = {
  dfc: ["Front", "Back"], split: ["Left half", "Right half"], adventure: ["Card", "Adventure"],
  flip: ["Top", "Flipped"], aftermath: ["Top half", "Aftermath half"],
};
// Frame variants with their own text layout in the renderer; all others are drawn like a regular card.
const SPECIAL_LAYOUTS = new Set(["saga", "planeswalker", "flip", "aftermath", "class", "battle", "leveler"]);

const state = {
  decks: [],
  slug: null,
  deck: null,
  cards: {},
  selectedId: null,
  face: 0, // which face the editor works on (0 = front / left half / the card itself)
  artImgs: [null, null],
  cardImg: null, // the printed card (split / aftermath halves show its art until custom art is added)
  artToken: 0,
  bust: Date.now(),
  mode: "large",
  refreshed: new Set(), // decks whose missing cache we already asked the server to fetch
  symbolMap: {}, // "{W}" -> "/symbols/W.svg"
  frames: [], // frame packs from frames/ (see /api/frames)
};

// ---------------------------------------------------------------- image cache
// Shared by mana symbols and frame images: load once, redraw when it arrives.
const imgCache = new Map();
function cachedImage(url) {
  if (!url) return null;
  let img = imgCache.get(url);
  if (!img) {
    img = new Image();
    img.loaded = new Promise((resolve) => {
      img.onload = () => { resolve(); draw(); };
      img.onerror = resolve;
    });
    img.src = url;
    imgCache.set(url, img);
  }
  return img;
}
const readyImage = (img) => (img && img.complete && img.naturalWidth ? img : null);

// ---------------------------------------------------------------- utils
async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
const jsonOpts = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const deckApi = (suffix = "") => `/api/decks/${encodeURIComponent(state.slug)}${suffix}`;
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode etc. */ } },
};
const deckFileUrl = (rel) => (rel ? `/decks/${encodeURIComponent(state.slug)}/${rel}?v=${state.bust}` : null);

// ---------------------------------------------------------------- cards and faces
const entryById = (id) => state.deck?.cards.find((c) => c.id === id);
const selected = () => entryById(state.selectedId);
const cardOf = (entry) => state.cards[entry.id] || null;

/** How a card is laid out: single, dfc (front/back), split, adventure, flip or aftermath. */
function cardKind(card) {
  if (!card || (card.faces || []).length < 2) return "single";
  if (card.images.length > 1) return "dfc"; // transform and modal double-faced cards
  // Scryfall files aftermath cards under "split"; only the keyword tells them apart.
  if (card.layout === "split" && (card.keywords || []).includes("Aftermath")) return "aftermath";
  if (["split", "adventure", "flip", "aftermath"].includes(card.layout)) return card.layout;
  return "single";
}
const faceCount = (card) => (cardKind(card) === "single" ? 1 : 2);

/** Scryfall data of face i (top-level data for single cards). */
function faceData(card, i) {
  if (!card) return {};
  if ((card.faces || []).length < 2) return card;
  const f = card.faces[i] || card.faces[0];
  // Split/adventure halves carry no colors of their own on Scryfall: derive them from the half's cost.
  const costColors = [...new Set((f.mana_cost || "").match(/[WUBRG]/g) || [])];
  const colors = f.colors ?? (cardKind(card) === "dfc" ? card.colors : costColors.length ? costColors : card.colors);
  return { ...card, ...f, colors, artist: f.artist ?? card.artist };
}
const faceImages = (card, i) => card?.images[i] || card?.images[0] || null;

/** Editable settings of face i: the entry itself for face 0, entry.back for face 1. */
function settings(entry, i, create = false) {
  if (i === 0) return entry;
  if (create) {
    entry.back ||= {};
    entry.back.crop ||= { ...NO_CROP };
    entry.back.overrides ||= {};
    entry.back.frameColor ||= "auto";
    return entry.back;
  }
  return { crop: NO_CROP, overrides: {}, frameColor: "auto", ...(entry.back || {}) }; // read-only view with defaults
}
/** The face the editor's name/text fields work on. */
const editFace = (entry = selected()) => (entry && cardKind(cardOf(entry)) !== "single" ? state.face : 0);
/** The face whose art the art controls move (adventure and flip cards have only one picture). */
const artFace = (entry = selected()) => {
  const kind = entry ? cardKind(cardOf(entry)) : "single";
  return kind === "dfc" || kind === "split" || kind === "aftermath" ? state.face : 0;
};

function autoSubtitle(s, origName) {
  return s.customName && s.customName.trim() !== origName ? origName : "";
}
function effectiveSubtitle(s, origName) {
  if (s.hideSubtitle) return "";
  return s.subtitle ?? autoSubtitle(s, origName);
}
function groupOf(entry, card) {
  if (entry.section === "commander") return "Commander";
  const type = (faceData(card, 0).type_line || "").split("//")[0];
  return TYPE_CHECK.find((t) => type.includes(t)) || "Other";
}

function writeHash() {
  const parts = [];
  if (state.slug) parts.push(`deck=${encodeURIComponent(state.slug)}`);
  if (state.selectedId) parts.push(`card=${state.selectedId}`);
  if (state.selectedId && state.face) parts.push(`face=${state.face}`);
  history.replaceState(null, "", parts.length ? `#${parts.join("&")}` : location.pathname);
}
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  return { deck: p.get("deck"), card: p.get("card"), face: p.get("face") === "1" ? 1 : 0 };
}

// ---------------------------------------------------------------- decks
async function loadDecks() {
  state.decks = (await api("/api/decks")).decks;
  const sel = $("#deck-select");
  sel.replaceChildren(...state.decks.map((d) => {
    const o = el("option", null, d.name);
    o.value = d.slug;
    return o;
  }));
  sel.value = state.slug || "";
  const hasDecks = state.decks.length > 0;
  sel.hidden = !hasDecks;
  $("#rename-deck-btn").hidden = !hasDecks;
  $("#import-btn").disabled = !hasDecks;
  $("#print-btn").disabled = !hasDecks;
}

async function switchDeck(slug, cardId = null) {
  if (saveId) await flushSave();
  state.slug = slug;
  state.selectedId = cardId;
  state.deck = null;
  state.cards = {};
  store.set("lastDeck", slug);
  $("#deck-select").value = slug;
  await loadDeck();
}

async function newDeck() {
  const name = prompt("Name of the new deck:", "");
  if (!name || !name.trim()) return;
  try {
    const { slug } = await api("/api/decks", jsonOpts("POST", { name: name.trim() }));
    await loadDecks();
    await switchDeck(slug);
    $("#import-dialog").showModal();
  } catch (e) { alert(e.message); }
}

async function renameDeck() {
  if (!state.deck) return;
  const name = prompt("Rename deck:", state.deck.name);
  if (!name || !name.trim() || name.trim() === state.deck.name) return;
  try {
    await api(deckApi(), jsonOpts("PATCH", { name: name.trim() }));
    state.deck.name = name.trim();
    await loadDecks();
  } catch (e) { alert(e.message); }
}

async function loadDeck() {
  if (!state.slug) { renderGallery(); showEditor(false); updateProgress(); return; }
  const slug = state.slug;
  const data = await api(deckApi());
  if (slug !== state.slug) return; // user switched decks while loading
  state.deck = data.deck;
  state.cards = data.cards;
  renderGallery();
  updateProgress();
  if (state.selectedId && entryById(state.selectedId)) select(state.selectedId, state.face);
  else { state.selectedId = null; showEditor(false); writeHash(); }

  // Fresh clone or new collaborator: fetch missing card data/images automatically, once per deck.
  if (data.missing.length && !state.refreshed.has(slug)) {
    state.refreshed.add(slug);
    try {
      await api(deckApi("/refresh"), { method: "POST" });
      pollJob();
    } catch (e) { setJobStatus(e.message, true); }
  }
}

function updateProgress() {
  const p = $("#progress");
  const cards = state.deck?.cards || [];
  if (!cards.length) { p.textContent = ""; return; }
  const done = cards.filter((c) => c.done).length;
  p.innerHTML = `<strong>${done}</strong> / ${cards.length} done`;
}

// ---------------------------------------------------------------- jobs
function setJobStatus(text, isError = false, title = "") {
  const s = $("#job-status");
  s.textContent = text;
  s.title = title;
  s.classList.toggle("error", isError);
}

let polling = false;
function pollJob() {
  if (polling) return;
  polling = true;
  pollTick();
}
async function pollTick() {
  let job;
  try { job = await api("/api/job"); } catch (e) { polling = false; return setJobStatus(e.message, true); }
  const progress = job.total ? ` (${job.done}/${job.total})` : "";
  const errs = job.errors.length ? ` · ${job.errors.length} problem${job.errors.length > 1 ? "s" : ""} (hover)` : "";
  setJobStatus(job.message + (job.running ? progress : "") + errs, job.errors.length > 0, job.errors.join("\n"));
  if (job.running) { setTimeout(pollTick, 500); return; }
  polling = false;
  if (job.kind) {
    await loadDecks();
    if (job.deck === state.slug) await loadDeck();
  }
}

// ---------------------------------------------------------------- mana symbols
async function loadSymbolMap() {
  try { state.symbolMap = await api("/api/symbols"); } catch { state.symbolMap = {}; }
}

/** Start loading every image the drawn models need; resolves once all are loaded or failed. */
function ensureImages(models) {
  const urls = [];
  for (const m of models.filter(Boolean)) {
    urls.push(...CardRenderer.symbolsUsed(m).map((tok) => state.symbolMap[tok]));
    if (m.frameSpec) urls.push(...Object.values(m.frameSpec.urls));
    if (m.urls) urls.push(...Object.values(m.urls)); // split spec
  }
  return Promise.all(urls.filter(Boolean).map((u) => cachedImage(u).loaded));
}
const symbolImage = (tok) => readyImage(imgCache.get(state.symbolMap[tok]));

// ---------------------------------------------------------------- frames
async function loadFrames() {
  try { state.frames = (await api("/api/frames")).frames; } catch { state.frames = []; }
}
const packById = (choice) => state.frames.find((p) => `pack:${p.id}` === choice) || null;
/** The first pack with all eight colors: it fills gaps in partial packs and supplies missing layouts. */
const basePack = () => state.frames.find((p) => FRAME_KEYS.every((k) => p.frames[k])) || state.frames[0] || null;
const isPartial = (p) => !FRAME_KEYS.every((k) => p.frames[k]);

/** Resolve a card's frame setting to "standard", "fullart" or "pack:<id>". */
function frameChoice(entry) {
  let c = entry.frame && entry.frame !== "default" ? entry.frame : state.deck?.defaultFrame || "auto";
  if (c === "auto") c = basePack() ? `pack:${basePack().id}` : "standard";
  if (c.startsWith("pack:") && !packById(c)) c = "standard"; // pack folder was removed
  return c;
}

function frameLabel(choice) {
  if (choice === "auto") return `Automatic (${basePack()?.name || "drawn"})`;
  if (choice === "standard") return "Drawn: standard";
  if (choice === "fullart") return "Drawn: full art";
  const p = packById(choice);
  return p ? `${p.name}${isPartial(p) ? " (partial: other colors from " + (basePack()?.name || "M15") + ")" : ""}` : choice;
}

function fillFrameSelects() {
  const deckDefault = state.deck?.defaultFrame || "auto";
  const choices = [...state.frames.map((p) => `pack:${p.id}`), "standard", "fullart"];
  const fill = (sel, values, current) => {
    sel.replaceChildren(...values.map(([v, label]) => { const o = el("option", null, label); o.value = v; return o; }));
    sel.value = current;
  };
  fill($("#deck-frame"), ["auto", ...choices].map((c) => [c, frameLabel(c)]), deckDefault);
  const entry = selected();
  if (entry) {
    fill($("#f-frame"), [["default", `Deck default (${frameLabel(deckDefault)})`], ...choices.map((c) => [c, frameLabel(c)])],
      entry.frame || "default");
    if (!$("#f-frame").value) $("#f-frame").value = "default"; // stored pack no longer exists
  }
  $("#frames-hint").hidden = state.frames.length > 0;
}

const firstValue = (m) => (m ? Object.values(m)[0] || null : null);
/** Image for a color key with fallbacks: this map, the fallback map, the artifact frame, anything. */
const pickColor = (m, key, fb) => (key ? m?.[key] || fb?.[key] || m?.artifact || fb?.artifact || firstValue(m) || null : null);

/**
 * Build the renderer's frameSpec for one face drawn with `pack` in layout `variantName`
 * ("regular", "transform_front", "transform_back", "adventure", "saga", "planeswalker").
 */
function buildFrameSpec(pack, variantName, colors, typeLine, isLandFace, bottomColor) {
  const base = basePack();
  let variant = pack, owner = pack, fallback = base;
  if (variantName !== "regular") {
    if (pack.variants?.[variantName]) variant = pack.variants[variantName];
    else if (base?.variants?.[variantName]) { variant = base.variants[variantName]; owner = base; }
    else variantName = "regular"; // nobody has this layout: regular frame, text drawn the generic way
    fallback = base?.variants?.[variantName] || base;
  }
  const opt = (k) => variant[k] ?? (variant !== owner ? owner[k] : undefined);
  const [left, right] = colors;
  const legendary = /\bLegendary\b/.test(typeLine) && !["saga", "planeswalker"].includes(variantName);
  const landFrame = isLandFace && !right && variant.landFrames?.[left];
  const ptSource = Object.keys(variant.pt || {}).length ? variant.pt : Object.keys(owner.pt || {}).length ? owner.pt
    : state.frames.find((p) => Object.keys(p.pt).length)?.pt;
  const crowns = Object.keys(variant.crowns || {}).length ? variant.crowns : owner.crowns;
  const a = variant.assets || {};
  const urls = {
    frame: landFrame || pickColor(variant.frames, left, fallback?.frames),
    frame2: right ? pickColor(variant.frames, right, fallback?.frames) : null,
    pt: pickColor(ptSource, right || left),
    crown: legendary ? pickColor(crowns, left) : null,
    crown2: legendary && right ? pickColor(crowns, right) : null,
    icon: a.icon, chapter: a.chapter, divider: a.divider, plus: a.plus, minus: a.minus, neutral: a.neutral,
    header: a.header,
    bottom: variantName === "aftermath" && bottomColor && bottomColor !== left ? pickColor(variant.frames, bottomColor, fallback?.frames) : null,
  };
  for (const k of Object.keys(urls)) if (!urls[k]) delete urls[k];
  const img = (k) => readyImage(cachedImage(urls[k]));
  return {
    kind: SPECIAL_LAYOUTS.has(variantName) ? variantName : "regular",
    headerImg: img("header"), defenseColor: opt("defenseColor"),
    layout: { ...(owner.layout || {}), ...(variant !== owner ? variant.layout || {} : {}) },
    fullArt: opt("fullArt"),
    urls,
    textColor: (landFrame && opt("landTextColor")) || opt("textColor"),
    titleColor: opt("titleColor"), typeColor: opt("typeColor"), ptColor: opt("ptColor"), loyaltyColor: opt("loyaltyColor"),
    landSymbolBuiltIn: !!(landFrame && opt("landSymbol")),
    frameImg: img("frame"), frameImg2: img("frame2"), ptImg: img("pt"), crownImg: img("crown"), crownImg2: img("crown2"),
    iconImg: img("icon"), chapterImg: img("chapter"), dividerImg: img("divider"),
    plusImg: img("plus"), minusImg: img("minus"), neutralImg: img("neutral"), bottomImg: img("bottom"),
  };
}

/** The frame color(s) of face i: [left] or [left, right] for split frames. */
function faceColors(entry, i) {
  const f = faceData(cardOf(entry), i);
  const s = settings(entry, i);
  const typeLine = s.overrides?.typeLine || f.type_line || "";
  let color = s.frameColor || "auto";
  if (color === "split") color = (f.colors || []).length === 2 ? f.colors.join("") : "auto";
  if (color === "auto") color = CardRenderer.autoColor(f.colors || [], typeLine, cardOf(entry)?.produced_mana || [], f.mana_cost);
  return { color, pair: CardRenderer.PAIR_RE.test(color) ? [color[0], color[1]] : [color, null] };
}

// ---------------------------------------------------------------- fonts
// Canvas text only uses a web font once it's loaded, so load the card fonts explicitly.
const fontsReady = Promise.all(
  ['bold 30px "Card Title"', '30px "Card Text"', 'italic 30px "Card Text"'].map((f) => document.fonts.load(f))
).catch(() => {}).then(() => draw());

// ---------------------------------------------------------------- gallery
function renderGallery() {
  const g = $("#gallery");
  g.dataset.mode = state.mode;
  if (!state.deck?.cards.length) {
    const empty = el("div", "gallery-empty");
    empty.innerHTML = !state.decks.length
      ? "<p>No decks yet.</p><p>Click <strong>+ New deck</strong> to create one, then paste a decklist.</p>"
      : "<p>This deck is empty.</p><p>Click <strong>Import deck</strong> and paste a decklist (Moxfield, Archidekt, MTGA or plain names).</p>";
    g.replaceChildren(empty);
    return;
  }
  const groups = new Map(GROUP_ORDER.map((k) => [k, []]));
  for (const e of state.deck.cards) groups.get(groupOf(e, cardOf(e))).push(e);
  const frag = document.createDocumentFragment();
  for (const [key, list] of groups) {
    if (!list.length) continue;
    list.sort((a, b) => a.name.localeCompare(b.name));
    const count = list.reduce((n, e) => n + (e.qty || 1), 0);
    const done = list.filter((e) => e.done).length;
    frag.append(el("div", "group-title", `${GROUP_LABEL[key]} (${count})${done ? ` · ${done} done` : ""}`));
    const grid = el("div", "group-grid");
    list.forEach((e) => grid.append(makeTile(e)));
    frag.append(grid);
  }
  g.replaceChildren(frag);
}

function makeTile(entry) {
  const tile = el("button", "tile");
  tile.type = "button";
  tile.dataset.id = entry.id;
  tile.classList.toggle("selected", entry.id === state.selectedId);
  fillTile(tile, entry);
  tile.addEventListener("click", () => select(entry.id));
  // Drop art straight onto a gallery card (goes to the front / left half).
  tile.addEventListener("dragover", (ev) => {
    if ([...ev.dataTransfer.types].includes("Files")) { ev.preventDefault(); tile.classList.add("drag-over"); }
  });
  tile.addEventListener("dragleave", () => tile.classList.remove("drag-over"));
  tile.addEventListener("drop", (ev) => {
    ev.preventDefault();
    tile.classList.remove("drag-over");
    const file = ev.dataTransfer.files[0];
    if (file) uploadArt(entry.id, file, 0);
  });
  return tile;
}

function fillTile(tile, entry) {
  const card = cardOf(entry);
  const img0 = card?.images[0];
  let src = null;
  if (state.mode === "art") src = deckFileUrl(entry.art) || img0?.art;
  else if (state.mode === "proxy") src = deckFileUrl(entry.proxy) || img0?.large;
  else src = img0?.large;

  tile.replaceChildren();
  tile.classList.toggle("is-done", !!entry.done);
  tile.title = entry.done ? `${entry.customName || entry.name} ✓ done` : entry.customName || entry.name;
  if (src) {
    const img = el("img");
    img.loading = "lazy";
    img.alt = entry.name;
    img.src = src;
    tile.append(img);
  } else {
    tile.append(el("div", "placeholder", card ? entry.name : `${entry.name}\n(downloading…)`));
  }
  const corner = el("div", "corner");
  if (entry.done) corner.append(el("span", "done", "✓"));
  if ((entry.qty || 1) > 1) corner.append(el("span", "qty", `×${entry.qty}`));
  tile.append(corner);
  const badges = el("div", "badges");
  if (faceCount(card) > 1) badges.append(el("span", "badge", { dfc: "2 FACES", split: "SPLIT", adventure: "ADV" }[cardKind(card)]));
  if (entry.art || entry.back?.art) badges.append(el("span", "badge", "ART"));
  if (entry.proxy || entry.back?.proxy) badges.append(el("span", "badge", "PNG"));
  tile.append(badges);
  const name = [entry.customName, entry.back?.customName].filter(Boolean).join(" // ");
  if (name || state.mode !== "large") {
    const label = el("div", "label", name || entry.name);
    if (name) label.append(el("span", "orig", entry.name));
    tile.append(label);
  }
}

function updateTile(id) {
  const tile = document.querySelector(`.tile[data-id="${id}"]`);
  const entry = entryById(id);
  if (tile && entry) fillTile(tile, entry);
}

// ---------------------------------------------------------------- editor
const canvas = $("#preview");
const ctx = canvas.getContext("2d");

function showEditor(on) {
  $("#editor-body").hidden = !on;
  $("#editor-empty").hidden = on;
}

function select(id, face = 0) {
  if (saveId && saveId !== id) flushSave();
  state.selectedId = id;
  document.querySelectorAll(".tile.selected").forEach((t) => t.classList.remove("selected"));
  document.querySelector(`.tile[data-id="${id}"]`)?.classList.add("selected");
  const entry = selected();
  const card = cardOf(entry);
  state.face = Math.min(face, faceCount(card) - 1);
  writeHash();
  showEditor(true);

  $("#orig-img").src = faceImages(card, 0)?.large || "";
  $("#orig-name").textContent = entry.name;
  const qty = entry.qty || 1;
  $("#orig-qty").hidden = qty < 2;
  $("#orig-qty").textContent = `×${qty} in the deck: one design applies to all ${qty} copies`;
  $("#orig-meta").textContent = card ? [card.set_name, card.collector_number && `#${card.collector_number}`, card.artist && `art by ${card.artist}`].filter(Boolean).join(" · ") : "Card data not downloaded yet";
  $("#f-done").checked = !!entry.done;
  $("#is-commander").checked = entry.section === "commander";
  $("#f-notes").value = entry.notes || "";
  fillFrameSelects();
  fillFaceForm();
  setSaveStatus("");
  loadArt();
}

/** Face switcher + every field that belongs to the current face. */
function fillFaceForm() {
  const entry = selected();
  const card = cardOf(entry);
  const kind = cardKind(card);
  const i = editFace(entry);
  const s = settings(entry, i);
  const f = faceData(card, i);

  const sw = $("#face-switch");
  sw.hidden = kind === "single";
  if (kind !== "single") {
    sw.replaceChildren(...FACE_LABELS[kind].map((label, n) => {
      const b = el("button", n === state.face ? "active" : "", `${label}: ${faceData(card, n).name}`);
      b.type = "button";
      if (kind === "dfc" && (n === 0 ? entry.proxy : entry.back?.proxy)) b.append(el("span", "tick", "✓"));
      b.addEventListener("click", () => { state.face = n; writeHash(); fillFaceForm(); $("#orig-img").src = faceImages(card, n)?.large || ""; draw(); });
      return b;
    }));
  }
  const hint = { dfc: "Each face is designed and exported separately; the card counts as done once both are exported.",
    split: "Both halves are on one card. The art controls move the selected half's art.",
    aftermath: "Both halves are on one card, each with its own art. The art controls move the selected half's art.",
    flip: i === 1 ? "The flipped half uses its name and text; art and frame belong to the card." : "",
    adventure: i === 1 ? "The adventure part only uses its name and text; art and frame belong to the card." : "" }[kind];
  $("#face-hint").hidden = !hint;
  $("#face-hint").textContent = hint || "";

  $("#f-name").value = s.customName || "";
  $("#f-name").placeholder = f.name || entry.name;
  $("#f-subtitle").value = s.subtitle ?? "";
  $("#f-hide-subtitle").checked = !!s.hideSubtitle;
  $("#f-subtitle-style").value = s.subtitleStyle || "angled";
  updateSubtitlePlaceholder();
  $("#f-color").value = s.frameColor || "auto";
  const o = s.overrides || {};
  setOverride("typeLine", o.typeLine, f.type_line);
  setOverride("oracleText", o.oracleText, f.oracle_text);
  setOverride("flavorText", o.flavorText, f.flavor_text);
  setOverride("artist", o.artist, settings(entry, artFace(entry)).art ? "Artist of your new art" : f.artist);
  syncCropControls();
}

function setOverride(key, value, original) {
  const input = $(`#o-${key}`);
  input.value = value || "";
  input.placeholder = original || "";
}

function updateSubtitlePlaceholder() {
  const entry = selected();
  const i = editFace(entry);
  const auto = autoSubtitle(settings(entry, i), faceData(cardOf(entry), i).name);
  $("#f-subtitle").placeholder = auto ? `${auto}  (automatic)` : "(none — appears automatically when you rename)";
}

function syncCropControls() {
  const c = settings(selected(), artFace()).crop || NO_CROP;
  $("#zoom").value = c.scale;
  $("#rot").value = c.rot;
  $("#rot-out").textContent = `${Math.round(c.rot)}°`;
}

function loadArt() {
  const entry = selected();
  const card = cardOf(entry);
  const token = ++state.artToken;
  state.artImgs = [null, null];
  state.cardImg = null;
  draw();
  if (["split", "aftermath"].includes(cardKind(card)) && faceImages(card, 0)?.large) {
    const big = new Image();
    big.onload = () => { if (token === state.artToken) { state.cardImg = big; draw(); } };
    big.src = faceImages(card, 0).large;
  }
  for (let i = 0; i < faceCount(card); i++) {
    const src = deckFileUrl(settings(entry, i).art) || faceImages(card, i)?.art;
    if (!src) continue;
    const img = new Image();
    img.onload = () => { if (token === state.artToken) { state.artImgs[i] = img; draw(); } };
    img.src = src;
  }
}

/** Everything the renderer needs to draw face i as a standalone card. */
function viewModel(entry, i, variantOverride) {
  const card = cardOf(entry) || {};
  const kind = cardKind(card);
  const f = faceData(card, i);
  const s = settings(entry, i);
  const o = s.overrides || {};
  const typeLine = o.typeLine || f.type_line || "";
  const produced = card.produced_mana || [];
  const isBasic = /\bBasic\b.*\bLand\b/.test(f.type_line || "");
  const { color, pair } = faceColors(entry, i);
  const choice = frameChoice(entry);
  const pack = packById(choice);
  const artIndex = kind === "adventure" ? 0 : i;

  let variant = variantOverride || "regular";
  if (!variantOverride) {
    if (kind === "flip" || kind === "aftermath") variant = kind;
    else if (/\bBattle\b/.test(typeLine)) variant = "battle";
    else if (/\bSaga\b/.test(typeLine)) variant = "saga";
    else if (/\bPlaneswalker\b/.test(typeLine)) variant = "planeswalker";
    else if (/\bClass\b/.test(typeLine)) variant = "class";
    else if (card.layout === "leveler") variant = "leveler";
    else if (kind === "dfc" && card.layout === "modal_dfc") variant = i === 0 ? "modal_front" : "modal_back";
    else if (kind === "dfc") variant = i === 0 ? "transform_front" : "transform_back";
    else if (kind === "adventure") variant = "adventure";
  }
  // Aftermath: the bottom half is framed in its own color (Cut // Ribbons: red top, black bottom).
  const bottomColor = variant === "aftermath" && i === 0 ? faceColors(entry, 1).pair[0] : null;
  const frameSpec = pack ? buildFrameSpec(pack, variant, pair, typeLine, /\bLand\b/.test(typeLine), bottomColor) : null;
  const vm = {
    frameSpec,
    basicSymbol: isBasic && !o.oracleText && produced.length === 1 && !frameSpec?.landSymbolBuiltIn ? `{${produced[0]}}` : null,
    title: s.customName || f.name || entry.name,
    subtitle: effectiveSubtitle(s, f.name || entry.name),
    subtitleStyle: s.subtitleStyle || "angled",
    manaCost: f.mana_cost,
    typeLine,
    oracleText: o.oracleText || f.oracle_text || "",
    flavorText: o.flavorText || f.flavor_text || "",
    power: f.power ?? null,
    toughness: f.toughness ?? null,
    loyalty: f.loyalty ?? null,
    defense: f.defense ?? null,
    artist: o.artist || (settings(entry, artIndex).art ? "" : f.artist || ""),
    color,
    frame: choice === "fullart" ? "fullart" : "standard",
    artImg: state.artImgs[artIndex],
    crop: settings(entry, artIndex).crop || NO_CROP,
    customArt: !!settings(entry, artIndex).art,
    cardImg: state.cardImg,
    symbolImage,
  };
  if ((kind === "flip" || kind === "aftermath") && i === 0 && !variantOverride) {
    // The second half is drawn on the same card (upside down / sideways).
    const b = faceData(card, 1), sb = settings(entry, 1), ob = sb.overrides || {};
    vm.second = {
      title: sb.customName || b.name, manaCost: b.mana_cost,
      typeLine: ob.typeLine || b.type_line || "", oracleText: ob.oracleText || b.oracle_text || "",
      flavorText: ob.flavorText || b.flavor_text || "", power: b.power ?? null, toughness: b.toughness ?? null,
      artImg: state.artImgs[1], crop: sb.crop || NO_CROP, customArt: !!sb.art,
    };
  }
  if (card.layout === "modal_dfc") {
    // Modal DFC tab: the other face's type, plus its mana cost (or its mana ability for lands).
    const other = faceData(card, 1 - i);
    const isLand = /\bLand\b/.test(other.type_line || "");
    const ability = (other.oracle_text || "").split("\n").find((l) => /^\{T\}: Add/.test(l)) || "";
    vm.flipside = { type: (other.type_line || "").split(" — ")[0], hint: isLand ? ability.replace(/\s*\(.*\)$/, "") : other.mana_cost || "" };
  }
  if (kind === "adventure" && i === 0) {
    const a = faceData(card, 1), sa = settings(entry, 1), oa = sa.overrides || {};
    vm.adventure = {
      title: sa.customName || a.name,
      manaCost: a.mana_cost,
      typeLine: oa.typeLine || a.type_line || "",
      oracleText: oa.oracleText || a.oracle_text || "",
    };
  }
  return vm;
}

/** Split-card frame spec (both halves on one image) or null when no pack offers one. */
function splitSpec(entry) {
  const pack = packById(frameChoice(entry));
  if (!pack) return null;
  const variant = pack.variants?.split || basePack()?.variants?.split;
  if (!variant?.layout?.halves) return null;
  const fb = basePack()?.variants?.split?.frames;
  const urls = {};
  [0, 1].forEach((i) => {
    const { pair } = faceColors(entry, i);
    urls[`half${i}`] = pickColor(variant.frames, pair[0], fb);
  });
  return {
    halves: variant.layout.halves,
    urls,
    frameImgs: [readyImage(cachedImage(urls.half0)), readyImage(cachedImage(urls.half1))],
  };
}

/** Draw the current card; returns the models that were drawn (for image preloading). */
function renderNow() {
  const entry = selected();
  if (!entry) return null;
  ctx.setTransform(canvas.width / CardRenderer.W, 0, 0, canvas.height / CardRenderer.H, 0, 0);
  const kind = cardKind(cardOf(entry));
  if (kind === "split") {
    const vms = [viewModel(entry, 0, "regular"), viewModel(entry, 1, "regular")];
    const spec = splitSpec(entry);
    if (spec?.frameImgs[0]) CardRenderer.renderSplitPack(ctx, vms, spec);
    else CardRenderer.renderSplit(ctx, vms);
    return [...vms, spec];
  }
  const vm = viewModel(entry, kind === "dfc" ? state.face : 0);
  CardRenderer.render(ctx, vm);
  return [vm];
}
let drawQueued = false;
function draw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    const models = renderNow();
    if (models) ensureImages(models); // redraws itself as symbols / frame images arrive
  });
}

// ---------------------------------------------------------------- saving
let saveTimer = null;
let saveId = null;
let saveSlug = null;

function setSaveStatus(text) { $("#save-status").textContent = text; }

function changed() {
  draw();
  updateTile(state.selectedId);
  if (saveId && saveId !== state.selectedId) flushSave();
  saveId = state.selectedId;
  saveSlug = state.slug;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 400);
  setSaveStatus("Unsaved changes…");
}

async function flushSave() {
  clearTimeout(saveTimer);
  const id = saveId, slug = saveSlug;
  saveId = null;
  const entry = id && slug === state.slug && entryById(id);
  if (!entry) return;
  const body = Object.fromEntries(SAVE_KEYS.filter((k) => k in entry).map((k) => [k, entry[k]]));
  try {
    await api(`/api/decks/${encodeURIComponent(slug)}/cards/${id}`, jsonOpts("PATCH", body));
    if (id === state.selectedId) setSaveStatus("Saved to deck.json");
  } catch (e) {
    setSaveStatus(`Save failed: ${e.message}`);
  }
}

// ---------------------------------------------------------------- art upload & export
async function uploadArt(id, file, face = artFace(entryById(id))) {
  const ext = ART_TYPES[file.type];
  if (!ext) { alert(`Unsupported image type: ${file.type || file.name}`); return; }
  if (saveId === id) await flushSave();
  const entry = entryById(id);
  try {
    setJobStatus(`Uploading art for ${entry.name}…`);
    const res = await api(deckApi(`/art/${id}?ext=${ext}&face=${face}`), { method: "POST", body: file });
    if (face === 1) entry.back = { ...(entry.back || {}), art: res.entry.back.art, crop: res.entry.back.crop };
    else Object.assign(entry, { art: res.entry.art, crop: res.entry.crop });
    state.bust = Date.now();
    updateTile(id);
    if (id === state.selectedId) select(id, state.face);
    setJobStatus(`Saved ${face === 1 ? res.entry.back.art : res.entry.art}`);
  } catch (e) {
    setJobStatus(`Upload failed: ${e.message}`, true);
  }
}

async function exportProxy() {
  const entry = selected();
  if (!entry) return;
  const kind = cardKind(cardOf(entry));
  const face = kind === "dfc" ? state.face : 0;
  // A double-faced card is done once both faces have been exported.
  const otherDone = kind !== "dfc" || !!(face === 0 ? entry.back?.proxy : entry.proxy);
  await flushSave();
  await fontsReady;
  await ensureImages(renderNow() || []); // make sure symbols and frame images are in the PNG
  renderNow();
  const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
  try {
    const res = await api(deckApi(`/proxy/${entry.id}?face=${face}&done=${otherDone ? 1 : 0}`), { method: "POST", body: blob });
    if (face === 1) entry.back = { ...(entry.back || {}), proxy: res.entry.back.proxy };
    else entry.proxy = res.entry.proxy;
    entry.done = res.entry.done;
    state.bust = Date.now();
    $("#f-done").checked = !!entry.done;
    renderGallery();
    updateProgress();
    fillFaceForm();
    const file = face === 1 ? entry.back.proxy : entry.proxy;
    setSaveStatus(entry.done ? `Exported ${file} · marked done` : `Exported ${file} · export the other face to finish the card`);
  } catch (e) {
    setSaveStatus(`Export failed: ${e.message}`);
  }
}

// ---------------------------------------------------------------- wiring: form
function bind(sel, evt, fn) { $(sel).addEventListener(evt, (e) => { if (selected()) fn(selected(), e.target); }); }
/** Settings object of the face being edited (created on first edit of a back face). */
const cur = (entry) => settings(entry, editFace(entry), true);
const artCur = (entry) => settings(entry, artFace(entry), true);

bind("#f-name", "input", (e, t) => { cur(e).customName = t.value.trim() ? t.value : null; updateSubtitlePlaceholder(); changed(); });
bind("#f-subtitle", "input", (e, t) => { cur(e).subtitle = t.value === "" ? null : t.value; changed(); });
bind("#f-hide-subtitle", "change", (e, t) => { cur(e).hideSubtitle = t.checked; changed(); });
bind("#f-subtitle-style", "change", (e, t) => { cur(e).subtitleStyle = t.value; changed(); });
bind("#f-frame", "change", (e, t) => { e.frame = t.value; changed(); });
$("#deck-frame").addEventListener("change", async (ev) => {
  if (!state.deck) return;
  state.deck.defaultFrame = ev.target.value;
  fillFrameSelects();
  draw();
  try { await api(deckApi(), jsonOpts("PATCH", { defaultFrame: ev.target.value })); }
  catch (e) { setSaveStatus(`Save failed: ${e.message}`); }
});
bind("#f-color", "change", (e, t) => { cur(e).frameColor = t.value; changed(); });
bind("#f-notes", "input", (e, t) => { e.notes = t.value; changed(); });
bind("#f-done", "change", (e, t) => { e.done = t.checked; changed(); renderGallery(); updateProgress(); });
bind("#is-commander", "change", (e, t) => { e.section = t.checked ? "commander" : "main"; changed(); renderGallery(); });
for (const key of ["typeLine", "oracleText", "flavorText", "artist"]) {
  bind(`#o-${key}`, "input", (e, t) => {
    const s = cur(e);
    s.overrides = { ...(s.overrides || {}) };
    if (t.value.trim()) s.overrides[key] = t.value; else delete s.overrides[key];
    changed();
  });
}

// ---------------------------------------------------------------- wiring: art transform
bind("#zoom", "input", (e, t) => { const s = artCur(e); s.crop = { ...s.crop, scale: +t.value }; changed(); });
bind("#rot", "input", (e, t) => { const s = artCur(e); s.crop = { ...s.crop, rot: +t.value }; $("#rot-out").textContent = `${Math.round(t.value)}°`; changed(); });
bind("#reset-crop", "click", (e) => { artCur(e).crop = { ...NO_CROP }; syncCropControls(); changed(); });
bind("#pick-art", "click", () => $("#art-file").click());
$("#art-file").addEventListener("change", (ev) => {
  const file = ev.target.files[0];
  if (file && state.selectedId) uploadArt(state.selectedId, file);
  ev.target.value = "";
});

/** Art box + a converter from screen drags (card units) to that box's units, for the face being moved. */
function dragGeometry(entry) {
  const kind = cardKind(cardOf(entry));
  const i = artFace(entry);
  if (kind === "split") {
    const spec = splitSpec(entry);
    if (spec?.frameImgs[0]) return { box: CardRenderer.splitArtBox(spec, i), map: (dx, dy) => CardRenderer.splitDelta(dx, dy, 1) };
    return { box: CardRenderer.artBox(viewModel(entry, i, "regular")), map: (dx, dy) => CardRenderer.splitDelta(dx, dy) };
  }
  // Rotated art (battle cards, aftermath's bottom half) moves in its own rotated frame.
  const t = CardRenderer.artTarget(viewModel(entry, kind === "dfc" ? i : 0), kind === "aftermath" ? i : 0);
  const map = t.rot === 90 ? (dx, dy) => ({ dx: dy, dy: -dx }) : t.rot === -90 ? (dx, dy) => ({ dx: -dy, dy: dx }) : (dx, dy) => ({ dx, dy });
  return { box: t.box, map };
}

let drag = null;
canvas.addEventListener("pointerdown", (ev) => {
  const entry = selected();
  if (!entry) return;
  drag = { x: ev.clientX, y: ev.clientY, crop: { ...(artCur(entry).crop || NO_CROP) }, geo: dragGeometry(entry) };
  canvas.setPointerCapture(ev.pointerId);
  canvas.classList.add("dragging");
});
canvas.addEventListener("pointermove", (ev) => {
  const entry = selected();
  if (!drag || !entry) return;
  const k = CardRenderer.W / canvas.getBoundingClientRect().width;
  const { dx, dy } = drag.geo.map((ev.clientX - drag.x) * k, (ev.clientY - drag.y) * k);
  const s = artCur(entry);
  s.crop = { ...s.crop, x: drag.crop.x + dx / drag.geo.box.w, y: drag.crop.y + dy / drag.geo.box.h };
  draw();
});
const endDrag = () => {
  if (!drag) return;
  drag = null;
  canvas.classList.remove("dragging");
  changed();
};
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);
canvas.addEventListener("wheel", (ev) => {
  const entry = selected();
  if (!entry) return;
  ev.preventDefault();
  const s = artCur(entry);
  const scale = Math.min(5, Math.max(0.2, (s.crop?.scale || 1) * Math.exp(-ev.deltaY * 0.0015)));
  s.crop = { ...(s.crop || NO_CROP), scale };
  $("#zoom").value = scale;
  changed();
}, { passive: false });

// Drop art anywhere on the editor.
let dragDepth = 0;
const editor = $("#editor");
const dropZone = $("#drop-zone");
const hasFiles = (ev) => [...(ev.dataTransfer?.types || [])].includes("Files");
editor.addEventListener("dragenter", (ev) => { if (hasFiles(ev) && selected()) { dragDepth++; dropZone.classList.add("drag-over"); } });
editor.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; dropZone.classList.remove("drag-over"); } });
editor.addEventListener("dragover", (ev) => { if (hasFiles(ev) && selected()) ev.preventDefault(); });
editor.addEventListener("drop", (ev) => {
  ev.preventDefault();
  dragDepth = 0;
  dropZone.classList.remove("drag-over");
  const file = ev.dataTransfer.files[0];
  if (file && state.selectedId) uploadArt(state.selectedId, file);
});
// Don't let the browser navigate away when a file misses a drop target.
window.addEventListener("dragover", (ev) => ev.preventDefault());
window.addEventListener("drop", (ev) => ev.preventDefault());

document.addEventListener("paste", (ev) => {
  if (!state.selectedId) return;
  const item = [...(ev.clipboardData?.items || [])].find((i) => i.kind === "file" && ART_TYPES[i.type]);
  if (item) { ev.preventDefault(); uploadArt(state.selectedId, item.getAsFile()); }
});

$("#export-btn").addEventListener("click", exportProxy);

// ---------------------------------------------------------------- wiring: top bar
$("#deck-select").addEventListener("change", (ev) => switchDeck(ev.target.value));
$("#new-deck-btn").addEventListener("click", newDeck);
$("#rename-deck-btn").addEventListener("click", renameDeck);
$("#print-btn").addEventListener("click", async () => {
  if (!state.slug) return;
  await flushSave();
  window.open(`print.html#deck=${encodeURIComponent(state.slug)}`, "_blank");
});

$("#gallery-mode").addEventListener("change", (ev) => {
  state.mode = ev.target.value;
  store.set("galleryMode", state.mode);
  renderGallery();
});
$("#gallery-cols").addEventListener("input", (ev) => {
  document.documentElement.style.setProperty("--cols", ev.target.value);
  store.set("galleryCols", ev.target.value);
});

const importDialog = $("#import-dialog");
$("#import-btn").addEventListener("click", () => importDialog.showModal());
$("#import-go").addEventListener("click", async (ev) => {
  ev.preventDefault();
  const text = $("#import-text").value;
  if (!text.trim() || !state.slug) return;
  try {
    await flushSave();
    await api(deckApi("/import"), jsonOpts("POST", { text }));
    importDialog.close();
    $("#import-text").value = "";
    pollJob();
  } catch (e) {
    alert(e.message);
  }
});

window.addEventListener("beforeunload", () => { if (saveId) flushSave(); });

// ---------------------------------------------------------------- boot
(async function boot() {
  state.mode = store.get("galleryMode", "large");
  $("#gallery-mode").value = state.mode;
  const cols = store.get("galleryCols", "2");
  $("#gallery-cols").value = cols;
  document.documentElement.style.setProperty("--cols", cols);
  loadSymbolMap().then(draw);
  try {
    await loadFrames();
    await loadDecks();
    const hash = readHash();
    const known = (s) => s && state.decks.some((d) => d.slug === s);
    const slug = [hash.deck, store.get("lastDeck", null), state.decks[0]?.slug].find(known) || null;
    if (slug === hash.deck) state.face = hash.face;
    if (slug) await switchDeck(slug, slug === hash.deck ? hash.card : null);
    else await loadDeck();
    const job = await api("/api/job");
    if (job.running) pollJob();
  } catch (e) {
    setJobStatus(`Could not reach the server: ${e.message}`, true);
  }
})();
