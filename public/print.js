"use strict";
// Print sheet: exported proxies at real size (63 x 88 mm), 3 x 3 per page, repeated by quantity.

const $ = (sel) => document.querySelector(sel);
const CARD_W = 63, CARD_H = 88; // mm
const PAPER = { A4: [210, 297], Letter: [215.9, 279.4] };
const MARK = 4; // cut mark length outside the grid, mm
const OPTIONS = ["paper", "gap", "missing-mode", "marks", "corners", "basics", "done-only"];

let data = null; // deck payload from the server
const slug = new URLSearchParams(location.hash.slice(1)).get("deck");

const store = {
  get(k, d) { try { return localStorage.getItem(`print.${k}`) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`print.${k}`, v); } catch { /* ignore */ } },
};
const el = (tag, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; return n; };
const fileUrl = (rel) => `/decks/${encodeURIComponent(slug)}/${rel}`;

/** Every printed card image, in deck order: [{src, name, placeholder}] repeated by quantity. */
function collect() {
  const includeBasics = $("#basics").checked, doneOnly = $("#done-only").checked;
  const useOriginal = $("#missing-mode").value === "original";
  const out = [], missing = [];
  for (const entry of data.deck.cards) {
    const card = data.cards[entry.id];
    const isBasic = /\bBasic\b.*\bLand\b/.test(card?.type_line || "");
    if ((isBasic && !includeBasics) || (doneOnly && !entry.done)) continue;
    // Double-faced cards print both faces; everything else is one image.
    const twoFaced = (card?.images || []).length > 1;
    const faces = twoFaced ? [[entry.proxy, card.images[0]], [entry.back?.proxy, card.images[1]]] : [[entry.proxy, card?.images[0]]];
    faces.forEach(([proxy, original], i) => {
      const label = twoFaced ? `${entry.name} (${i ? "back" : "front"})` : entry.name;
      let item = null;
      if (proxy) item = { src: fileUrl(proxy), name: label };
      else {
        missing.push(label);
        if (useOriginal && original) item = { src: original.large, name: label, placeholder: true };
      }
      if (item) for (let n = 0; n < (entry.qty || 1); n++) out.push(item);
    });
  }
  return { items: out, missing };
}

function render() {
  if (!data) return;
  OPTIONS.forEach((id) => { const n = $(`#${id}`); store.set(id, n.type === "checkbox" ? n.checked : n.value); });
  const [pw, ph] = PAPER[$("#paper").value];
  const gap = +$("#gap").value;
  $("#page-size").textContent = `@page { size: ${$("#paper").value}; margin: 0; }`;
  const gridW = 3 * CARD_W + 2 * gap, gridH = 3 * CARD_H + 2 * gap;
  const left = (pw - gridW) / 2, top = (ph - gridH) / 2;

  const { items, missing } = collect();
  const pages = $("#pages");
  pages.replaceChildren();
  for (let p = 0; p < items.length; p += 9) {
    const page = el("div", "page");
    page.classList.toggle("black-corners", $("#corners").checked);
    page.style.width = `${pw}mm`;
    page.style.height = `${ph}mm`;
    const sheet = el("div", "sheet");
    Object.assign(sheet.style, { left: `${left}mm`, top: `${top}mm`, gap: `${gap}mm`, gridTemplateColumns: `repeat(3, ${CARD_W}mm)` });
    for (const item of items.slice(p, p + 9)) {
      const c = el("div", item.placeholder ? "card placeholder-card" : "card");
      const img = el("img");
      img.src = item.src;
      img.alt = item.name;
      img.title = item.name;
      c.append(img);
      sheet.append(c);
    }
    page.append(sheet);
    if ($("#marks").checked) addMarks(page, left, top, gap);
    pages.append(page);
  }

  const sheets = Math.ceil(items.length / 9);
  $("#summary").innerHTML = `<strong>${data.deck.name}</strong><br>${items.length} card${items.length === 1 ? "" : "s"} on ` +
    `<strong>${sheets}</strong> page${sheets === 1 ? "" : "s"}` + (missing.length ? ` · ${missing.length} without proxy` : "");
  $("#missing").innerHTML = missing.length
    ? `<strong>Not exported yet:</strong><br>${missing.map((m) => m.replace(/</g, "&lt;")).join("<br>")}` : "";
  if (!items.length) pages.append(Object.assign(el("p", "hint"), { textContent: "Nothing to print with the current options. Export some proxies first." }));
}

/** Short lines in the margin at every card edge, so the grid can be cut with a ruler. */
function addMarks(page, left, top, gap) {
  const xs = [], ys = [];
  for (let i = 0; i < 3; i++) {
    xs.push(left + i * (CARD_W + gap), left + i * (CARD_W + gap) + CARD_W);
    ys.push(top + i * (CARD_H + gap), top + i * (CARD_H + gap) + CARD_H);
  }
  const right = left + 3 * CARD_W + 2 * gap, bottom = top + 3 * CARD_H + 2 * gap;
  const line = (x, y, w, h) => {
    const m = el("div", "mark");
    Object.assign(m.style, { left: `${x}mm`, top: `${y}mm`, width: `${w}mm`, height: `${h}mm` });
    page.append(m);
  };
  const t = 0.2; // line thickness, mm
  for (const x of new Set(xs)) { line(x - t / 2, top - MARK - 1, t, MARK); line(x - t / 2, bottom + 1, t, MARK); }
  for (const y of new Set(ys)) { line(left - MARK - 1, y - t / 2, MARK, t); line(right + 1, y - t / 2, MARK, t); }
}

(async function boot() {
  OPTIONS.forEach((id) => {
    const n = $(`#${id}`);
    // Saved choice, or one given in the address (#deck=…&missing-mode=original) for a direct link.
    const saved = new URLSearchParams(location.hash.slice(1)).get(id) ?? store.get(id, null);
    if (saved !== null) { if (n.type === "checkbox") n.checked = saved === "true"; else n.value = saved; }
    n.addEventListener("change", render);
  });
  $("#print").addEventListener("click", () => window.print());
  if (!slug) { $("#summary").textContent = "No deck selected. Open this page from the app's Print sheet button."; return; }
  try {
    const res = await fetch(`/api/decks/${encodeURIComponent(slug)}`);
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
    data = await res.json();
    document.title = `Print sheet – ${data.deck.name}`;
    render();
  } catch (e) {
    $("#summary").textContent = `Could not load the deck: ${e.message}`;
  }
})();
