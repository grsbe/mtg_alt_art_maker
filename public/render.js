// Card renderer: draws a proxy onto a <canvas> from a plain "view model".
// All coordinates are in a 745x1040 card space (63x88mm at ~300dpi); the caller
// scales the context for higher-resolution output.
//
// Two ways to draw the frame:
//   * image frames from a pack in frames/ (vm.frameSpec with a loaded frameImg): art goes
//     underneath the frame PNG, text is placed at the pack's layout boxes;
//   * drawn frames (shapes + color palettes) as the fallback when no pack is used/loaded.
// Fonts are the "Card Title" / "Card Text" faces declared in style.css.

const CardRenderer = (() => {
  const W = 745, H = 1040;

  const PALETTES = {
    W:        { frame: "#d9d0b2", bar: "#f5f0de", box: "#f7f2e4" },
    U:        { frame: "#2470b3", bar: "#cddff0", box: "#e1ebf4" },
    B:        { frame: "#3b3534", bar: "#c9c0ba", box: "#ddd7d3" },
    R:        { frame: "#c4432f", bar: "#f1cbb7", box: "#f6e2d6" },
    G:        { frame: "#2f7a46", bar: "#c7ddc6", box: "#dfeade" },
    gold:     { frame: "#c7a24a", bar: "#f2e4b8", box: "#f6edd2" },
    artifact: { frame: "#8e99a2", bar: "#dadfe3", box: "#e8ebed" },
    land:     { frame: "#8a6c4c", bar: "#e4d5c0", box: "#ede3d5" },
  };
  const MANA_FILL = { W: "#f8f6d8", U: "#c1d7e9", B: "#bab1ab", R: "#e49977", G: "#a3c095" };
  const FALLBACK = '"Palatino Linotype", "Book Antiqua", Palatino, Georgia, serif';
  const TITLE = `"Card Title", ${FALLBACK}`; // name, type line, P/T, artist (Beleren on real cards)
  const TEXT = `"Card Text", ${FALLBACK}`; // rules, flavor, subtitle (MPlantin on real cards)
  const TITLE_SC = `"Card Title SC", ${TITLE}`; // P/T, loyalty, level labels, artist (Beleren small caps)
  const INK = "#161412";

  // Drawn-frame layout, in card pixels.
  const DRAWN = {
    frame:   { x: 28, y: 28, w: 689, h: 960 },
    title:   { x: 46, y: 46, w: 653, h: 66 },
    art:     { x: 60, y: 120, w: 625, h: 464 },
    type:    { x: 46, y: 590, w: 653, h: 58 },
    text:    { x: 60, y: 654, w: 625, h: 300 },
    pt:      { x: 572, y: 930, w: 128, h: 54 },
  };

  // Image-frame layout: the modern (M15) frame, as fractions [x, y, w, h] of the card.
  // A pack's frame.json "layout" can override any of these.
  const M15_LAYOUT = {
    art:    [0.0767, 0.1129, 0.8476, 0.4429],
    title:  [0.0854, 0.0522, 0.8292, 0.0543], // name text area; mana cost is right-aligned in it
    type:   [0.0854, 0.5664, 0.8292, 0.0543],
    text:   [0.086, 0.6303, 0.828, 0.2875],
    pt:     [0.7573, 0.8848, 0.188, 0.0733], // P/T box image
    ptText: [0.7928, 0.902, 0.1367, 0.0372],
    crown:  [0.0274, 0.0191, 0.9454, 0.1667], // legendary crown image
    footer: [0.08, 0.958, 0.84, 0.02], // artist credit
    mana: [0, 0.0613, 0.9292, 71 / 2100], // mana cost box: right-aligned to x + w
  };

  const AFTERMATH_CUT = 0.5425; // gap between the aftermath frame's two halves
  const TEXT_PAD = 0.01 * H; // space between rules text and the text box border
  const box = (f) => ({ x: f[0] * W, y: f[1] * H, w: f[2] * W, h: f[3] * H });
  const isRect = (v) => Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === "number");
  /** Layout fractions as they are (needed for rotated boxes and lists of boxes). */
  const packRaw = (spec) => ({ ...M15_LAYOUT, ...(spec.layout || {}) });
  /** Layout with every plain [x, y, w, h] converted to card pixels. */
  const packLayout = (spec) => Object.fromEntries(Object.entries(packRaw(spec)).map(([k, v]) => [k, isRect(v) ? box(v) : v]));
  /** Run fn in a frame rotated by `angle` around the anchor of box f; fn gets the box in that frame. */
  function rotated(ctx, f, angle, fn) {
    ctx.save();
    ctx.translate(f[0] * W, f[1] * H);
    ctx.rotate(angle);
    fn({ x: 0, y: 0, w: f[2] * W, h: f[3] * H });
    ctx.restore();
  }
  // Rotated art window: an unrotated card rect turned into a frame rotated by +90° (aftermath bottom half).
  const art90 = (f) => ({ anchor: [f[0] + f[2], f[1]], box: { x: 0, y: 0, w: f[3] * H, h: f[2] * W } });

  /**
   * The printed card's art for one half as its own upright image (cached), so the default art of split and
   * aftermath halves can be moved, zoomed and rotated like custom art. `toLocal` maps card coordinates into
   * the half's rotated frame, [a, b, c, d, e, f] as in setTransform; `box` is the art box in that frame.
   */
  const regionCache = new WeakMap();
  function regionImage(img, box, toLocal) {
    const key = [box.x, box.y, box.w, box.h, ...toLocal].map((n) => n.toFixed(2)).join();
    let m = regionCache.get(img);
    if (!m) regionCache.set(img, (m = new Map()));
    if (!m.has(key)) {
      const k = Math.max(1, img.naturalWidth / W); // keep the scan's resolution
      const c = document.createElement("canvas");
      c.width = Math.round(box.w * k);
      c.height = Math.round(box.h * k);
      const g = c.getContext("2d");
      g.setTransform(k, 0, 0, k, -box.x * k, -box.y * k);
      g.transform(...toLocal);
      g.drawImage(img, 0, 0, W, H);
      m.set(key, c);
    }
    return m.get(key);
  }

  const PAIR_RE = /^[WUBRG]{2}$/; // a two-color split frame, e.g. "GW" = green left, white right

  function autoColor(colors, typeLine, producedMana, manaCost) {
    colors = colors || [];
    if (colors.length === 2) {
      // Hybrid cards ({G/W} costs, no plain colored symbols) use a split frame, in the cost's color order.
      const hybrid = (manaCost || "").match(/\{([WUBRG])\/([WUBRG])\}/);
      if (hybrid && !/\{[WUBRG]\}/.test(manaCost)) return hybrid[1] + hybrid[2];
      return "gold";
    }
    if (colors.length > 2) return "gold";
    if (colors.length === 1) return colors[0];
    if (/\bLand\b/.test(typeLine || "")) {
      // Lands are colorless; frame them by the mana they make (Island -> blue), like printed cards.
      const produced = (producedMana || []).filter((c) => "WUBRG".includes(c));
      return produced.length === 1 ? produced[0] : produced.length > 1 ? "gold" : "land";
    }
    return "artifact";
  }

  /** The rectangle the art fills (crop offsets are relative to it). */
  function artBox(vm) {
    return artTarget(vm, 0).box;
  }

  /**
   * Where art slot `slot` (0 = main, 1 = aftermath's second half) is drawn: its box in its own drawing frame
   * and how that frame is rotated relative to the card (0, 90 or -90), so drags can be converted.
   */
  function artTarget(vm, slot = 0) {
    const spec = vm.frameSpec;
    if (!spec) return { box: vm.frame === "fullart" ? { x: 0, y: 0, w: W, h: H } : DRAWN.art, rot: 0 };
    if (spec.kind === "battle") {
      const a = packRaw(spec).art;
      return { box: { x: a[0] * H, y: a[1] * W, w: a[2] * H, h: a[3] * W }, rot: -90 };
    }
    if (slot === 1 && spec.kind === "aftermath") return { box: art90(packRaw(spec).art2).box, rot: 90 };
    return { box: spec.fullArt ? { x: 0, y: 0, w: W, h: H } : packLayout(spec).art, rot: 0 };
  }

  // ---------- primitives ----------
  function isLight(color) {
    const m = /^#?([0-9a-f]{6})$/i.exec(color || "");
    if (!m) return false;
    const n = parseInt(m[1], 16);
    return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) > 160;
  }

  /** Set fill color; light text gets a soft dark shadow so it stays readable over art. */
  function ink(ctx, color) {
    ctx.fillStyle = color;
    if (isLight(color)) {
      ctx.shadowColor = "rgba(0,0,0,.85)";
      ctx.shadowBlur = 5;
      ctx.shadowOffsetX = 1;
      ctx.shadowOffsetY = 2;
    }
  }

  // Two-color frames: draw image 2 over image 1, fading in across the middle of the card.
  const blendCache = new Map();
  function drawSplit(ctx, img1, img2, b) {
    ctx.drawImage(img1, b.x, b.y, b.w, b.h);
    if (!img2) return;
    const s = Math.max(1, ctx.getTransform().a);
    const key = `${img2.src}|${b.x}|${b.y}|${b.w}|${b.h}|${s}`;
    let oc = blendCache.get(key);
    if (!oc) {
      oc = document.createElement("canvas");
      oc.width = Math.round(b.w * s);
      oc.height = Math.round(b.h * s);
      const o = oc.getContext("2d");
      o.drawImage(img2, 0, 0, oc.width, oc.height);
      o.globalCompositeOperation = "destination-in";
      const toLocal = (cardX) => ((cardX - b.x) / b.w) * oc.width;
      const g = o.createLinearGradient(toLocal(W * 0.44), 0, toLocal(W * 0.56), 0);
      g.addColorStop(0, "rgba(0,0,0,0)");
      g.addColorStop(1, "rgba(0,0,0,1)");
      o.fillStyle = g;
      o.fillRect(0, 0, oc.width, oc.height);
      if (blendCache.size > 40) blendCache.clear();
      blendCache.set(key, oc);
    }
    ctx.drawImage(oc, b.x, b.y, b.w, b.h);
  }

  function roundRect(ctx, b, r) {
    ctx.beginPath();
    ctx.roundRect(b.x, b.y, b.w, b.h, r);
  }

  function panel(ctx, b, r, fill, alpha = 1) {
    ctx.save();
    ctx.globalAlpha = alpha;
    roundRect(ctx, b, r);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0,0,0,.45)";
    ctx.stroke();
    ctx.restore();
  }

  function symbolKind(sym) {
    const s = sym.toUpperCase();
    for (const c of ["W", "U", "B", "R", "G"]) if (s.split("/").includes(c)) return c;
    return "C";
  }

  // Set per render(): (token like "{W/U}") => loaded <img> of the official Scryfall SVG, or null.
  let symbolImage = () => null;

  function drawSymbol(ctx, sym, cx, cy, r, shadow = false) {
    const img = symbolImage(`{${sym}}`);
    if (img) {
      ctx.save();
      if (shadow) { // printed mana costs have a hard black shadow just below each symbol (CC: -0.1% x, +0.29% y)
        ctx.beginPath();
        ctx.arc(cx - r * 0.0426, cy + r * 0.171, r, 0, Math.PI * 2);
        ctx.fillStyle = "#000";
        ctx.fill();
      }
      ctx.drawImage(img, cx - r, cy - r, r * 2, r * 2);
      ctx.restore();
      return;
    }
    drawFallbackSymbol(ctx, sym, cx, cy, r);
  }

  // Used only until the SVGs have loaded (or if Scryfall is unreachable).
  function drawFallbackSymbol(ctx, sym, cx, cy, r) {
    const kind = symbolKind(sym);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx + r * 0.08, cy + r * 0.12, r, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,.55)";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = MANA_FILL[kind] || "#cbc2bf";
    ctx.fill();
    let label = sym.toUpperCase();
    if (label === "T") label = "⟳";
    else if (label.includes("/")) label = label.replace("/P", "ᵖ").replace("/", "");
    ctx.fillStyle = INK;
    ctx.font = `bold ${Math.round(r * (label.length > 1 ? 1.0 : 1.3))}px ${TITLE}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, cx, cy + r * 0.08);
    ctx.restore();
  }

  function parseCost(cost) {
    return (cost || "").match(/\{[^}]+\}/g)?.map((s) => s.slice(1, -1)) || [];
  }

  /** Largest font size (<= maxSize) at which text fits maxW. style is e.g. "bold" or "italic". */
  function fitFont(ctx, text, style, family, maxSize, minSize, maxW) {
    let size = maxSize;
    for (; size > minSize; size--) {
      ctx.font = `${style} ${size}px ${family}`;
      if (ctx.measureText(text).width <= maxW) break;
    }
    ctx.font = `${style} ${size}px ${family}`;
    return size;
  }

  // ---------- art ----------
  function drawArt(ctx, img, b, crop) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(b.x, b.y, b.w, b.h);
    ctx.clip();
    if (!img) {
      ctx.fillStyle = "#2a2b30";
      ctx.fillRect(b.x, b.y, b.w, b.h);
      ctx.fillStyle = "#777";
      ctx.font = `28px ${TEXT}`;
      ctx.textAlign = "center";
      ctx.fillText("Drop art here", b.x + b.w / 2, b.y + b.h / 2);
    } else {
      const c = crop || { x: 0, y: 0, scale: 1, rot: 0 };
      const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height; // <img> or <canvas>
      const cover = Math.max(b.w / iw, b.h / ih) * (c.scale || 1);
      ctx.translate(b.x + b.w / 2 + c.x * b.w, b.y + b.h / 2 + c.y * b.h);
      ctx.rotate(((c.rot || 0) * Math.PI) / 180);
      const w = iw * cover, h = ih * cover;
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
    }
    ctx.restore();
  }

  // ---------- text pieces shared by both frame styles ----------
  // Text follows Card Conjurer's model (js/creator-23.js), so positions match real cards:
  //   font size is a fraction of the card height; a line is exactly one font size tall; the baseline sits
  //   0.7 x size below the line top; a block is centered as (box height - text height + 0.15 x size) / 2;
  //   mana symbols are 0.78 x size wide with 0.04 x size on each side, centered 0.34 x size below the line top.
  const SIZE = {
    title: 0.0381, type: 0.0324, rules: 0.0362, pt: 0.0372,
    adventure: 0.0353, advTitle: 0.0296, saga: 0.0305, sagaReminder: 0.03, walker: 0.0353,
    classText: 0.0305, leveler: 0.0296, splitType: 0.0286,
  };
  const px = (k) => SIZE[k] * H;
  /** Baseline of a single line of `size` centered in box b, the way Card Conjurer centers it. */
  const baselineIn = (b, size) => b.y + (b.h - size + 0.15 * size) / 2 + 0.7 * size;

  /** Mana cost right-aligned at rightX, symbols of radius r centered on cy; returns where the cost starts. */
  function drawCost(ctx, manaCost, rightX, cy, r) {
    const cost = parseCost(manaCost);
    const gap = 0.04 * (r / 0.39); // 0.04 x font size on each side of a symbol
    let cx = rightX - gap - r;
    for (let i = cost.length - 1; i >= 0; i--) {
      drawSymbol(ctx, cost[i], cx, cy, r, true);
      cx -= 2 * r + 2 * gap;
    }
    return rightX - cost.length * (2 * r + 2 * gap);
  }

  /** Mana cost in a Card Conjurer mana box (font size = box height x 2100/1638); returns where it starts. */
  function drawManaBox(ctx, manaCost, b) {
    const size = (b.h * 2100) / 1638;
    const cy = b.y + (b.h - size + 0.15 * size) / 2 + 0.34 * size;
    return drawCost(ctx, manaCost, b.x + b.w, cy, 0.39 * size);
  }

  /** One line of bold title-font text in box b, shrunk until it fits before rightX. */
  function drawLine(ctx, text, b, rightX, size, color) {
    ctx.save();
    ink(ctx, color);
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    const fitted = fitFont(ctx, text || "", "bold", TITLE, size, 10, rightX - b.x);
    ctx.fillText(text || "", b.x, baselineIn(b, fitted));
    ctx.restore();
  }

  // ---------- rules text with inline mana symbols ----------
  const ROMAN = "(?:VI|IV|V|I{1,3})";
  const CHAPTER_RE = new RegExp(`^(${ROMAN}(?:,\\s*${ROMAN})*)\\s+[—–-]\\s+(.*)$`);
  const LOYALTY_RE = /^([+−–-]?(?:\d+|X)):\s+(.*)$/;

  /** Split oracle + flavor into paragraphs; saga chapters and planeswalker abilities get a badge. */
  function parseParagraphs(oracle, flavor, typeLine) {
    const saga = /\bSaga\b/.test(typeLine || ""), walker = /\bPlaneswalker\b/.test(typeLine || "");
    const out = [];
    for (const line of (oracle || "").split("\n").filter(Boolean)) {
      let m;
      if (saga && (m = line.match(CHAPTER_RE))) out.push({ text: m[2], badge: { kind: "chapter", labels: m[1].split(/,\s*/) } });
      else if (walker && (m = line.match(LOYALTY_RE))) out.push({ text: m[2], badge: { kind: "loyalty", label: m[1].replace(/[-–]/, "−") } });
      else out.push({ text: line, italic: /^\(.*\)$/.test(line.trim()) }); // whole-line reminder text is italic
    }
    (flavor || "").split("\n").filter(Boolean).forEach((p, i) =>
      out.push({ text: p, italic: true, divider: i === 0 && out.length > 0 }));
    return out;
  }

  /**
   * Wrap paragraphs at `size`. Line tops advance by one font size; a new paragraph adds 0.35 x size; flavor
   * text follows an empty line that holds the divider (Card Conjurer's "{lns}{bar}{lns}").
   */
  function layoutRules(ctx, paragraphs, size, maxW) {
    const symD = size * 0.78, symGap = size * 0.04;
    const lines = [], badges = [];
    let y = 0;
    paragraphs.forEach((para, pi) => {
      if (pi > 0) {
        if (para.divider) { y += size; lines.push({ divider: true, y }); y += size; }
        else y += size * 1.28; // paragraph gap measured on printed cards (Card Conjurer uses 0.35)
      }
      const indent = para.badge ? size * 2.4 : 0;
      ctx.font = `${para.italic ? "italic" : ""} ${size}px ${TEXT}`;
      const spaceW = ctx.measureText(" ").width;
      const tokens = para.text.match(/\{[^}]+\}|\s+|[^\s{]+|\{/g) || [];
      const top = y;
      let line = { y, items: [], italic: para.italic };
      let x = indent;
      for (const t of tokens) {
        const isSpace = /^\s+$/.test(t);
        const isSym = /^\{[^}]+\}$/.test(t);
        const w = isSpace ? spaceW : isSym ? symD + 2 * symGap : ctx.measureText(t).width;
        if (isSpace) {
          if (line.items.length) x += w;
          continue;
        }
        if (x + w > maxW && line.items.length) {
          line.w = x;
          lines.push(line);
          y += size;
          line = { y, items: [], italic: para.italic };
          x = indent;
        }
        line.items.push({ x, t, sym: isSym ? t.slice(1, -1) : null });
        x += w;
      }
      line.w = x;
      lines.push(line);
      if (para.badge) badges.push({ ...para.badge, y0: top, y1: y + size });
    });
    return { lines, badges, height: y + size };
  }

  /** Saga chapter hexagon or planeswalker loyalty shield at (x, cy). */
  function drawBadge(ctx, kind, label, x, cy, size) {
    const w = size * 1.9, h = size * 1.25;
    ctx.save();
    ctx.shadowColor = "transparent";
    ctx.beginPath();
    if (kind === "chapter") {
      const t = h * 0.35;
      ctx.moveTo(x + t, cy - h / 2); ctx.lineTo(x + w - t, cy - h / 2); ctx.lineTo(x + w, cy);
      ctx.lineTo(x + w - t, cy + h / 2); ctx.lineTo(x + t, cy + h / 2); ctx.lineTo(x, cy);
    } else {
      // Loyalty: points up for +N, down for −N, flat for 0.
      const up = label.startsWith("+"), down = label.startsWith("−"), p = h * 0.32;
      ctx.moveTo(x, cy - h / 2 + (up ? p : 0)); ctx.lineTo(x + w / 2, cy - h / 2 - (up ? p * 0.4 : 0));
      ctx.lineTo(x + w, cy - h / 2 + (up ? p : 0)); ctx.lineTo(x + w, cy + h / 2 - (down ? p : 0));
      ctx.lineTo(x + w / 2, cy + h / 2 + (down ? p * 0.4 : 0)); ctx.lineTo(x, cy + h / 2 - (down ? p : 0));
    }
    ctx.closePath();
    ctx.fillStyle = "#1d1b19";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(255,255,255,.55)";
    ctx.stroke();
    ctx.fillStyle = "#f4f1ea";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    fitFont(ctx, label, "bold", TITLE, Math.round(size * 0.85), 10, w - 8);
    ctx.fillText(label, x + w / 2, cy + 1);
    ctx.restore();
  }

  /**
   * Rules text in box b (inset by pad), starting at maxSize and shrinking until it fits.
   * opts.padY: extra space above and below. opts.avoid: {x, y} corner (the P/T box) the text must stay out
   * of; the block moves up first and only shrinks further when there is no room left.
   */
  function drawRules(ctx, b, paragraphs, pad, color, maxSize = px("rules"), opts = {}) {
    if (!paragraphs.length) return;
    const padY = pad + (opts.padY || 0);
    const maxW = b.w - pad * 2, maxH = b.h - padY * 2;
    const minTop = b.y + padY;
    let size = maxSize, layout, top;
    for (; size >= 8; size -= 0.5) {
      layout = layoutRules(ctx, paragraphs, size, maxW);
      if (layout.height > maxH) continue;
      top = minTop + (maxH - layout.height) / 2;
      if (!opts.avoid) break;
      // How far the lowest line reaching into the P/T column dips below the box's top edge.
      const overlap = (t) => Math.max(0, ...layout.lines.filter((l) => !l.divider && b.x + pad + (l.w || 0) > opts.avoid.x)
        .map((l) => t + l.y + size * 0.95 - opts.avoid.y));
      const o = overlap(top);
      if (!o) break;
      top = Math.max(minTop, top - o);
      if (!overlap(top)) break;
    }
    if (top == null) top = minTop;
    ctx.save();
    ink(ctx, color);
    ctx.textBaseline = "alphabetic";
    for (const line of layout.lines) {
      if (line.divider) {
        // Flavor bar: a thin line fading out at both ends, 96% of the box wide.
        ctx.save();
        ctx.shadowColor = "transparent";
        const y = top + line.y + 0.5 * size, x0 = b.x + pad + maxW * 0.02, x1 = b.x + pad + maxW * 0.98;
        const g = ctx.createLinearGradient(x0, 0, x1, 0);
        const c = isLight(color) ? "255,255,255" : "0,0,0";
        g.addColorStop(0, `rgba(${c},0)`);
        g.addColorStop(0.15, `rgba(${c},.55)`);
        g.addColorStop(0.85, `rgba(${c},.55)`);
        g.addColorStop(1, `rgba(${c},0)`);
        ctx.fillStyle = g;
        ctx.fillRect(x0, y - 1, x1 - x0, 2);
        ctx.restore();
        continue;
      }
      ctx.font = `${line.italic ? "italic" : ""} ${size}px ${TEXT}`;
      for (const it of line.items) {
        const x = b.x + pad + it.x, lineTop = top + line.y;
        if (it.sym) drawSymbol(ctx, it.sym, x + size * 0.04 + size * 0.39, lineTop + size * 0.34, size * 0.39);
        else ctx.fillText(it.t, x, lineTop + size * 0.7);
      }
    }
    for (const bd of layout.badges) {
      const cy = top + (bd.y0 + bd.y1) / 2;
      const labels = bd.kind === "chapter" ? bd.labels : [bd.label];
      const step = size * 1.4;
      labels.forEach((l, i) => drawBadge(ctx, bd.kind, l, b.x + pad - size * 0.2, cy + (i - (labels.length - 1) / 2) * step, size));
    }
    ctx.restore();
  }

  /** Adventure spell in the left half of the text box: its own name/cost bar, type bar and text. */
  function drawAdventure(ctx, adv, b, pad) {
    const nameH = b.h * 0.12, typeH = b.h * 0.1;
    ctx.save();
    ctx.fillStyle = "rgba(55,52,50,.92)";
    ctx.fillRect(b.x, b.y, b.w, nameH);
    ctx.fillStyle = "rgba(120,116,110,.85)";
    ctx.fillRect(b.x, b.y + nameH, b.w, typeH);
    const r = nameH * 0.32;
    const nameEnd = drawCost(ctx, adv.manaCost, b.x + b.w - 6, b.y + nameH / 2, r);
    drawLine(ctx, adv.title, { x: b.x + 6, y: b.y, w: b.w, h: nameH }, nameEnd - 4, Math.round(nameH * 0.62), "#ffffff");
    drawLine(ctx, adv.typeLine, { x: b.x + 6, y: b.y + nameH, w: b.w, h: typeH }, b.x + b.w - 6, Math.round(typeH * 0.62), "#ffffff");
    ctx.restore();
    const body = { x: b.x, y: b.y + nameH + typeH, w: b.w, h: b.h - nameH - typeH };
    drawRules(ctx, body, parseParagraphs(adv.oracleText, "", adv.typeLine), pad, adv.color, 26);
  }

  function drawTextBox(ctx, vm, b, pad, color, size, opts) {
    if (vm.basicSymbol) {
      // Basic lands show one big mana symbol instead of rules text.
      drawSymbol(ctx, vm.basicSymbol.slice(1, -1), b.x + b.w / 2, b.y + b.h / 2, Math.min(96, b.h * 0.32));
      return;
    }
    const paragraphs = parseParagraphs(vm.oracleText, vm.flavorText, vm.typeLine);
    if (vm.adventure) {
      const half = b.w / 2;
      drawAdventure(ctx, { ...vm.adventure, color }, { x: b.x + 4, y: b.y + 6, w: half - 10, h: b.h - 12 }, 4);
      ctx.save();
      ctx.strokeStyle = isLight(color) ? "rgba(255,255,255,.4)" : "rgba(0,0,0,.3)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(b.x + half, b.y + 10);
      ctx.lineTo(b.x + half, b.y + b.h - 10);
      ctx.stroke();
      ctx.restore();
      drawRules(ctx, { x: b.x + half, y: b.y, w: half, h: b.h }, paragraphs, pad, color, px("adventure"));
      return;
    }
    drawRules(ctx, b, paragraphs, pad, color, size, opts);
  }

  const cornerText = (vm) => (vm.power != null ? `${vm.power}/${vm.toughness}` : vm.loyalty || vm.defense || null);

  /** One centered line in small caps (P/T, loyalty, defense), positioned like Card Conjurer's. */
  function drawCentered(ctx, text, b, size, color) {
    ctx.save();
    ink(ctx, color);
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    const fitted = fitFont(ctx, text, "bold", TITLE_SC, size, 10, b.w);
    ctx.fillText(text, b.x + b.w / 2, baselineIn(b, fitted));
    ctx.restore();
  }

  function drawFooter(ctx, vm, x, y, maxW) {
    if (!vm.artist) return;
    ctx.save();
    ctx.fillStyle = "#f2efe8";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    ctx.font = `bold 17px ${TITLE_SC}`;
    ctx.fillText(`Illus. ${vm.artist}`, x, y, maxW);
    ctx.restore();
  }

  /**
   * Subtitle tab: centered under the title bar, same shape in both frame styles.
   * style "angled" (default): hard bottom corners, sides running diagonally up and out into the bar ( \_/ ).
   * style "rounded": straight sides with rounded bottom corners.
   * fill(ctx, tab) paints the tab's background (a flat color or a slice of the frame image) over tab's box.
   */
  function drawSubtitleTab(ctx, text, barX, barW, barBottom, fill, color, style = "angled", edge = 0) {
    ctx.save();
    ctx.font = `italic 23px ${TEXT}`;
    const tw = Math.min(ctx.measureText(text).width, barW - 140);
    const angled = style !== "rounded";
    const h = 36, slant = angled ? h * 0.75 : 0; // how far each side leans out at the top
    const w = tw + (angled ? 36 : 48); // width along the bottom edge
    // The rounded tab merges into the bar; the angled one hangs just below the bar's dark bottom edge,
    // which stays intact.
    const x = barX + (barW - w) / 2, y = barBottom + (angled ? edge : 0), top = angled ? y : y - 2, bottom = y + h, r = 14;
    // Outline of the sides and bottom; the top stays open and merges into the title bar.
    const outline = (c) => {
      c.moveTo(x - slant, top);
      if (angled) {
        c.lineTo(x, bottom);
        c.lineTo(x + w, bottom);
      } else {
        c.lineTo(x, bottom - r);
        c.arcTo(x, bottom, x + r, bottom, r);
        c.lineTo(x + w - r, bottom);
        c.arcTo(x + w, bottom, x + w, bottom - r, r);
      }
      c.lineTo(x + w + slant, top);
    };
    ctx.beginPath();
    outline(ctx);
    ctx.closePath();
    ctx.save();
    ctx.clip();
    fill(ctx, { x: x - slant, y, w: w + 2 * slant, h });
    ctx.restore();
    ctx.beginPath();
    outline(ctx);
    ctx.lineWidth = 3;
    ctx.lineJoin = "miter";
    ctx.strokeStyle = "rgba(0,0,0,.6)";
    ctx.stroke();
    ink(ctx, color);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, x + w / 2, y + h / 2 + 1, tw);
    ctx.restore();
  }

  // ---------- image frames ----------
  function renderPack(ctx, vm) {
    const spec = vm.frameSpec;
    if (spec.kind === "battle") return renderBattle(ctx, vm, spec);
    const L = packLayout(spec);
    const textInk = spec.textColor || INK;
    const titleInk = spec.titleColor || spec.textColor || INK;
    const typeInk = spec.typeColor || titleInk;

    const R = packRaw(spec);

    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    // Aftermath's top half shows only its own printed art until custom art is added (Scryfall's crop spans both).
    const topArt = spec.kind === "aftermath" && !vm.customArt && vm.cardImg ? regionImage(vm.cardImg, artBox(vm), [1, 0, 0, 1, 0, 0]) : vm.artImg;
    drawArt(ctx, topArt, artBox(vm), vm.crop);
    if (spec.kind === "aftermath" && vm.second) {
      // Second art window, rotated with the bottom half's text; printed art until custom art is added.
      const s = vm.second, t = art90(R.art2);
      const [ax, ay] = [t.anchor[0] * W, t.anchor[1] * H];
      const img = !s.customArt && vm.cardImg ? regionImage(vm.cardImg, t.box, [0, -1, 1, 0, -ay, ax]) : s.artImg;
      rotated(ctx, [...t.anchor, 0, 0], Math.PI / 2, () => drawArt(ctx, img, t.box, s.crop));
    }
    if (spec.kind === "planeswalker") drawWalkerBands(ctx, vm, spec); // bands sit under the frame
    drawSplit(ctx, spec.frameImg, spec.frameImg2, { x: 0, y: 0, w: W, h: H });
    if (spec.kind === "aftermath" && spec.bottomImg) {
      // The aftermath half has its own color: its frame's bottom half over the top half's frame.
      const cut = AFTERMATH_CUT * H;
      ctx.drawImage(spec.bottomImg, 0, cut * spec.bottomImg.naturalHeight / H, spec.bottomImg.naturalWidth,
        (H - cut) * spec.bottomImg.naturalHeight / H, 0, cut, W, H - cut);
    }

    if (spec.crownImg) {
      // Legendary: the crown replaces the top border, so black out the plain border above the title bar first
      // (borderless packs have art there instead, which the crown simply sits on).
      if (!spec.fullArt) {
        ctx.fillStyle = "#000";
        ctx.fillRect(0, 0, W, L.title.y - 0.006 * H);
      }
      drawSplit(ctx, spec.crownImg, spec.crownImg2, L.crown);
    }

    if (vm.subtitle) {
      // Fill the tab with a slice of the frame's own title bar so texture and color match exactly.
      const img = spec.frameImg;
      const sx = img.naturalWidth / W, sy = img.naturalHeight / H;
      const srcTop = (L.title.y + L.title.h * 0.2) * sy, srcH = L.title.h * 0.6 * sy;
      drawSubtitleTab(ctx, vm.subtitle, L.title.x - 0.01 * W, L.title.w + 0.02 * W, L.title.y + L.title.h - 0.002 * H,
        (c, tab) => c.drawImage(img, tab.x * sx, srcTop, tab.w * sx, srcH, tab.x, tab.y - 2, tab.w, tab.h + 2), titleInk, vm.subtitleStyle,
        -0.0007 * H); // start right under the bar's dark edge (M15: ~0.1037H)
    }

    if (spec.iconImg && L.icon) ctx.drawImage(spec.iconImg, L.icon.x, L.icon.y, L.icon.w, L.icon.h); // DFC sun/moon

    const costStart = drawManaBox(ctx, vm.manaCost, L.mana);
    drawLine(ctx, vm.title, L.title, Math.min(L.title.x + L.title.w, costStart - 0.008 * W), px("title"), titleInk);
    // Flip cards print the P/T inside the type bar, so the type line must stop before it.
    const typeEnd = spec.kind === "flip" && vm.power != null ? L.ptText.x - 8 : L.type.x + L.type.w;
    drawLine(ctx, vm.typeLine, L.type, typeEnd, px("type"), typeInk);

    const footer = () => drawFooter(ctx, vm, L.footer.x, L.footer.y + L.footer.h / 2, L.footer.w);
    if (spec.kind === "saga") return drawSagaText(ctx, vm, spec, L, textInk), footer();
    if (spec.kind === "planeswalker") return drawWalkerText(ctx, vm, spec, L), footer();
    if (spec.kind === "flip") return drawFlipText(ctx, vm, spec, L, R, textInk, titleInk), footer();
    if (spec.kind === "class") return drawClassText(ctx, vm, spec, L, R, textInk), footer();
    if (spec.kind === "leveler") return drawLevelerText(ctx, vm, spec, L, R, textInk, titleInk), footer();
    if (spec.kind === "aftermath") {
      drawRules(ctx, L.text, parseParagraphs(vm.oracleText, vm.flavorText, vm.typeLine), 0, textInk, px("rules"), { padY: TEXT_PAD });
      if (vm.second) drawAftermathBottom(ctx, vm.second, R, textInk, titleInk);
      return footer();
    }

    const corner = cornerText(vm);
    // Breathing room from the box border, and keep clear of the P/T box (Card Conjurer's text box has neither).
    const textOpts = { padY: TEXT_PAD, avoid: corner ? { x: L.pt.x + L.pt.w * 0.08, y: L.pt.y + L.pt.h * 0.1 } : null };
    if (vm.adventure && L.advTitle) {
      // Adventure frame: storybook with the adventure on the left page, the creature's text on the right.
      const a = vm.adventure;
      const advMana = L.mana2 || { x: L.advTitle.x, y: L.advTitle.y, w: L.advTitle.w, h: (60 / 2100) * H };
      const end = drawManaBox(ctx, a.manaCost, advMana);
      drawLine(ctx, a.title, L.advTitle, end - 6, px("advTitle"), "#ffffff");
      drawLine(ctx, a.typeLine, L.advType, L.advType.x + L.advType.w, px("advTitle"), "#ffffff");
      drawRules(ctx, L.advText, parseParagraphs(a.oracleText, "", a.typeLine), 0, textInk, px("adventure"), { padY: TEXT_PAD / 2 });
      drawRules(ctx, L.text, parseParagraphs(vm.oracleText, vm.flavorText, vm.typeLine), 0, textInk, px("adventure"), textOpts);
    } else {
      // Same box as Card Conjurer; only the modal DFC tab needs extra room at the bottom.
      let bottom = L.text.y + L.text.h;
      if (L.flipside && vm.flipside) bottom = Math.min(bottom, L.flipside.y - 2);
      drawTextBox(ctx, vm, { ...L.text, h: bottom - L.text.y }, 0, textInk, px("rules"), textOpts);
    }

    if (corner) {
      let ptInk = spec.ptColor || titleInk;
      if (spec.ptImg) ctx.drawImage(spec.ptImg, L.pt.x, L.pt.y, L.pt.w, L.pt.h);
      else { panel(ctx, L.pt, 12, "#e9e6df"); ptInk = INK; }
      drawCentered(ctx, corner, L.ptText, px("pt"), ptInk);
    }
    if (L.flipside && vm.flipside) {
      // Modal DFC: the tab at the bottom left names the other face (its type, and its cost or mana ability).
      const b = L.flipside, f = vm.flipside;
      drawLine(ctx, f.type, { ...b, x: b.x + b.w * 0.05 }, b.x + b.w * 0.55, 0.0234 * H, "#ffffff");
      ctx.save();
      ctx.font = `${0.0258 * H}px ${TEXT}`;
      const tokens = (f.hint || "").match(/\{[^}]+\}|[^{]+/g) || [];
      const r = b.h * 0.27;
      const widths = tokens.map((t) => (t.startsWith("{") ? r * 2.2 : ctx.measureText(t).width));
      let x = b.x + b.w * 0.93 - widths.reduce((a, c) => a + c, 0);
      ink(ctx, "#ffffff");
      ctx.textBaseline = "middle";
      tokens.forEach((t, i) => {
        if (t.startsWith("{")) drawSymbol(ctx, t.slice(1, -1), x + r * 1.1, b.y + b.h / 2, r);
        else ctx.fillText(t, x, b.y + b.h / 2 + 1);
        x += widths[i];
      });
      ctx.restore();
    }
    footer();
  }

  // ---------- flip, aftermath, class, leveler ----------
  function drawFlipText(ctx, vm, spec, L, R, textInk, titleInk) {
    drawRules(ctx, L.text, parseParagraphs(vm.oracleText, "", vm.typeLine), 0, textInk, px("rules"), { padY: TEXT_PAD / 2 });
    const s = vm.second;
    const hasPT = vm.power != null || s?.power != null;
    if (hasPT && spec.ptImg) ctx.drawImage(spec.ptImg, L.pt.x, L.pt.y, L.pt.w, L.pt.h);
    if (vm.power != null) drawCentered(ctx, `${vm.power}/${vm.toughness}`, L.ptText, px("pt"), spec.ptColor || titleInk);
    if (!s) return;
    // The flipped half reads upside down: everything is rotated 180° around its box's anchor.
    rotated(ctx, R.title2, Math.PI, (b) => drawLine(ctx, s.title, b, b.x + b.w, px("title"), titleInk));
    const ptRoom = s.power != null ? (R.ptText2[2] + 0.02) * W : 0;
    rotated(ctx, R.type2, Math.PI, (b) => drawLine(ctx, s.typeLine, b, b.x + b.w - ptRoom, px("type"), titleInk));
    rotated(ctx, R.text2, Math.PI, (b) => drawRules(ctx, b, parseParagraphs(s.oracleText, "", s.typeLine), 0, textInk, px("rules"), { padY: TEXT_PAD / 2 }));
    if (s.power != null) {
      rotated(ctx, R.ptText2, Math.PI, (b) => drawCentered(ctx, `${s.power}/${s.toughness}`, b, px("pt"), spec.ptColor || titleInk));
    }
  }

  function drawAftermathBottom(ctx, s, R, textInk, titleInk) {
    // Rotated 90° clockwise: the box runs down the card, its height runs to the left.
    // The cost has its own anchor; convert where it starts into the title's frame (local x runs down the card).
    const mana = R.mana2 || [R.title2[0] - 0.0126, R.title2[1] - 0.0609, 0.58, 71 / 2100];
    let costStart = Infinity;
    rotated(ctx, mana, Math.PI / 2, (b) => { costStart = drawManaBox(ctx, s.manaCost, b) + (mana[1] - R.title2[1]) * H; });
    rotated(ctx, R.title2, Math.PI / 2, (b) => drawLine(ctx, s.title, b, Math.min(b.x + b.w, costStart - 6), px("title"), titleInk));
    rotated(ctx, R.type2, Math.PI / 2, (b) => drawLine(ctx, s.typeLine, b, b.x + b.w, px("type"), titleInk));
    rotated(ctx, R.text2, Math.PI / 2, (b) => drawRules(ctx, b, parseParagraphs(s.oracleText, s.flavorText, s.typeLine), 0, textInk, px("rules"), { padY: TEXT_PAD }));
  }

  /** Class: "{2}{U}: Level 2" lines start a new level; everything before belongs to level 1. */
  function drawClassText(ctx, vm, spec, L, R, color) {
    const blocks = [{ header: null, lines: [] }];
    for (const line of (vm.oracleText || "").split("\n").filter(Boolean)) {
      const m = line.match(/^(.+?):\s*Level\s+(\d+)$/i);
      if (m) blocks.push({ header: { cost: m[1], level: m[2] }, lines: [] });
      else blocks[blocks.length - 1].lines.push(line);
    }
    const headerH = R.header[3] * H;
    const weights = blocks.map((b) => 1 + b.lines.join(" ").length / 90);
    const free = L.levels.h - headerH * (blocks.length - 1);
    const total = weights.reduce((a, b) => a + b, 0);
    let y = L.levels.y;
    blocks.forEach((b, i) => {
      if (b.header) {
        const hb = { x: R.header[0] * W, y, w: R.header[2] * W, h: headerH };
        if (spec.headerImg) ctx.drawImage(spec.headerImg, hb.x, hb.y, hb.w, hb.h);
        // Cost left-aligned ("{2}{U}:"), level name right-aligned, as printed on Class cards.
        const size = 0.0277 * H, r = 0.39 * size, n = (b.header.cost.match(/\{/g) || []).length;
        const costEnd = L.levels.x + n * (2 * r + 0.08 * size);
        drawCost(ctx, b.header.cost, costEnd, hb.y + hb.h / 2, r);
        drawLine(ctx, ":", { ...hb, x: costEnd + 1 }, costEnd + 20, size, INK);
        ctx.save();
        ink(ctx, INK);
        ctx.textAlign = "right";
        ctx.textBaseline = "alphabetic";
        const fitted = fitFont(ctx, `Level ${b.header.level}`, "bold", TITLE, 0.0281 * H, 10, hb.w * 0.45);
        ctx.fillText(`Level ${b.header.level}`, L.levels.x + 0.3967 * W, baselineIn(hb, fitted));
        ctx.restore();
        y += headerH;
      }
      const h = (free * weights[i]) / total;
      drawRules(ctx, { x: L.levels.x, y, w: L.levels.w, h }, parseParagraphs(b.lines.join("\n"), "", ""), 0, color, px("classText"));
      y += h;
    });
  }

  /** Leveler: "Level up …" text, then "LEVEL 1-4" / "LEVEL 5+" blocks with their own P/T and abilities. */
  function drawLevelerText(ctx, vm, spec, L, R, color, titleInk) {
    const lines = (vm.oracleText || "").split("\n").filter(Boolean);
    const intro = [], levels = [];
    for (const line of lines) {
      const m = line.match(/^LEVEL\s+(\d+\s*[-–]\s*\d+|\d+\+)$/i);
      if (m) levels.push({ range: m[1].replace(/\s/g, ""), pt: null, lines: [] });
      else if (levels.length && !levels[levels.length - 1].pt && /^\d+\/\d+$/.test(line)) levels[levels.length - 1].pt = line;
      else (levels.length ? levels[levels.length - 1].lines : intro).push(line);
    }
    drawRules(ctx, L.text, parseParagraphs(intro.join("\n"), "", ""), 0, color, px("leveler"));
    if (spec.ptImg && vm.power != null) ctx.drawImage(spec.ptImg, L.pt.x, L.pt.y, L.pt.w, L.pt.h);
    const pts = [vm.power != null ? `${vm.power}/${vm.toughness}` : null, ...levels.map((l) => l.pt)];
    pts.slice(0, 3).forEach((pt, i) => { if (pt) drawCentered(ctx, pt, box(R.ptTexts[i]), px("pt"), spec.ptColor || titleInk); });
    levels.slice(0, 2).forEach((l, i) => {
      const lb = box(R.levelLabel[i]);
      drawCentered(ctx, "LEVEL", { ...lb, h: lb.h * 0.45 }, 0.0139 * H, INK);
      drawCentered(ctx, l.range, { ...lb, y: lb.y + lb.h * 0.42, h: lb.h * 0.55 }, 0.0162 * H, INK);
      drawRules(ctx, box(R.levelText[i]), parseParagraphs(l.lines.join("\n"), "", ""), 0, color, px("leveler"));
    });
  }

  // ---------- battle (landscape) ----------
  function renderBattle(ctx, vm, spec) {
    const R = packRaw(spec);
    const LW = H, LH = W; // the card lies on its side
    const lb = (f) => ({ x: f[0] * LW, y: f[1] * LH, w: f[2] * LW, h: f[3] * LH });
    const titleInk = spec.titleColor || INK;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.translate(0, H);
    ctx.rotate(-Math.PI / 2);
    drawArt(ctx, vm.artImg, lb(R.art), vm.crop);
    ctx.drawImage(spec.frameImg, 0, 0, LW, LH);
    const T = lb(R.title), Y = lb(R.type), X = lb(R.text);
    // The battle's own mana box (landscape fractions), not the portrait default.
    const end = drawManaBox(ctx, vm.manaCost, lb(spec.layout?.mana || [0, 100 / 1500, 1957 / 2100, 71 / 1500]));
    drawLine(ctx, vm.title, T, Math.min(T.x + T.w, end - 8), px("title"), titleInk);
    drawLine(ctx, vm.typeLine, Y, Y.x + Y.w, px("type"), spec.typeColor || titleInk);
    const D = lb(R.defense);
    drawRules(ctx, X, parseParagraphs(vm.oracleText, vm.flavorText, vm.typeLine), 0, spec.textColor || INK, px("rules"),
      { padY: TEXT_PAD, avoid: vm.defense ? { x: D.x - D.w * 0.3, y: D.y - D.h * 0.6 } : null });
    if (vm.defense) drawCentered(ctx, String(vm.defense), lb(R.defense), px("pt"), spec.defenseColor || "#ffffff");
    const F = lb(R.footer);
    drawFooter(ctx, vm, F.x, F.y + F.h / 2, F.w);
    ctx.restore();
  }

  // Saga frame: reminder text on top, then one band per chapter with chapter markers on the left.
  function drawSagaText(ctx, vm, spec, L, color) {
    const paras = parseParagraphs(vm.oracleText, "", vm.typeLine);
    const chapters = paras.filter((p) => p.badge);
    const other = paras.filter((p) => !p.badge).map((p) => ({ ...p, italic: true }));
    if (other.length) drawRules(ctx, L.reminder, other, 0, color, px("sagaReminder"));
    if (!chapters.length) return;
    const seg = L.chapters.h / chapters.length;
    chapters.forEach((ch, i) => {
      const y = L.chapters.y + i * seg;
      if (spec.dividerImg) ctx.drawImage(spec.dividerImg, L.divider.x, y - L.divider.h / 2, L.divider.w, L.divider.h);
      drawRules(ctx, { x: L.chapters.x, y, w: L.chapters.w, h: seg }, [{ text: ch.text }], 0, color, px("saga"));
      const n = ch.badge.labels.length, spread = 0.0358 * H;
      ch.badge.labels.forEach((label, j) => {
        const cy = y + seg / 2 + (j - (n - 1) / 2) * spread * (n > 2 ? 1 : 2);
        if (spec.chapterImg) {
          ctx.drawImage(spec.chapterImg, L.chapterIcon.x, cy - L.chapterIcon.h / 2, L.chapterIcon.w, L.chapterIcon.h);
          ctx.save();
          ctx.fillStyle = INK;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.font = `bold ${Math.round(0.0324 * H * 0.9)}px ${TEXT}`;
          ctx.fillText(label, L.chapterIcon.x + L.chapterIcon.w / 2, cy + 1);
          ctx.restore();
        } else {
          drawBadge(ctx, "chapter", label, L.chapterIcon.x, cy, 0.03 * H);
        }
      });
    });
  }

  // Planeswalker frame: alternating translucent bands behind each ability, loyalty icons on the left.
  // All abilities share one font size (the largest at which everything fits, like printed cards); each band
  // is as tall as its text plus an equal share of the spare room.
  // The last ability keeps clear of the loyalty box in the bottom-right corner.
  function walkerSegments(ctx, vm, L) {
    const paras = parseParagraphs(vm.oracleText, "", vm.typeLine).map((p) => ({ ...p, badge: null, src: p }));
    const w = L.abilities.w - 0.022 * W; // keep off the frame's right border
    if (!paras.length) return { segs: [], size: px("walker"), w };
    const gap = TEXT_PAD * 1.6; // minimum space above + below each ability's text
    const lb = L.loyalty || L.ptText;
    const loyaltyTop = lb.y - 0.016 * H, loyaltyX = lb.x - L.abilities.x;
    const bottomReserve = Math.max(0, L.abilities.y + L.abilities.h - loyaltyTop);
    // An ability's band is at least about as tall as its loyalty icon, like printed cards.
    const minBand = Math.min(0.07 * H, (L.abilities.h / paras.length) * 0.92);
    let size = px("walker"), heights, reserve;
    for (; size >= 8; size -= 0.5) {
      const layouts = paras.map((p) => layoutRules(ctx, [p], size, w));
      const last = layouts[layouts.length - 1].lines.at(-1);
      reserve = vm.loyalty && last && last.w > loyaltyX ? bottomReserve : 0;
      heights = layouts.map((l, i) => Math.max(l.height + gap, paras[i].src.badge ? minBand : 0));
      if (heights.reduce((a, b) => a + b, 0) + reserve <= L.abilities.h) break;
    }
    const spare = Math.max(0, L.abilities.h - reserve - heights.reduce((a, b) => a + b, 0)) / paras.length;
    let y = L.abilities.y;
    const segs = paras.map((p, i) => {
      const last = i === paras.length - 1;
      const seg = { para: p.src, y, h: heights[i] + spare + (last ? reserve : 0), textH: heights[i] + spare };
      y += seg.h;
      return seg;
    });
    return { segs, size, w };
  }

  function drawWalkerBands(ctx, vm, spec) {
    const L = packLayout(spec);
    const { segs } = walkerSegments(ctx, vm, L);
    ctx.save();
    segs.forEach((s, i) => {
      const top = i === 0 ? L.type.y + L.type.h / 2 : s.y; // the type bar hides the band's top edge
      const bottom = i === segs.length - 1 ? s.y + s.h + 0.5 * H : s.y + s.h;
      ctx.fillStyle = i % 2 === 0 ? "rgba(255,255,255,.62)" : "rgba(170,170,170,.72)";
      ctx.fillRect(L.abilityBand.x, top, L.abilityBand.w, bottom - top);
    });
    ctx.restore();
  }

  function drawWalkerText(ctx, vm, spec, L) {
    const { segs, size, w } = walkerSegments(ctx, vm, L);
    for (const s of segs) {
      drawRules(ctx, { x: L.abilities.x, y: s.y, w, h: s.textH }, [{ ...s.para, badge: null }], 0, INK, size);
      const label = s.para.badge?.label;
      if (!label) continue;
      const cy = s.y + s.textH / 2;
      // Icon heights and where the number's baseline sits below the icon's top (Card Conjurer's values).
      const [icon, ih, base] = label.startsWith("+") ? [spec.plusImg, 0.0724, 0.043]
        : label.startsWith("−") ? [spec.minusImg, 0.0705, 0.0334] : [spec.neutralImg, 0.061, 0.0344];
      if (icon) {
        const top = cy - (ih * H) / 2;
        ctx.drawImage(icon, L.loyaltyIcon.x, top, L.loyaltyIcon.w, ih * H);
        ctx.save();
        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "center";
        ctx.textBaseline = "alphabetic";
        fitFont(ctx, label, "bold", TITLE_SC, Math.round(0.0286 * H), 12, L.loyaltyIcon.w * 0.62);
        ctx.fillText(label, L.loyaltyIcon.x + 0.0747 * W, top + base * H); // number centered on the shield, not the colon
        ctx.restore();
      } else {
        drawBadge(ctx, "loyalty", label, L.loyaltyIcon.x + 6, cy, 0.03 * H);
      }
    }
    if (vm.loyalty) drawCentered(ctx, String(vm.loyalty), L.loyalty, px("pt"), spec.loyaltyColor || "#ffffff");
  }

  // ---------- drawn frames ----------
  function renderDrawn(ctx, vm) {
    const L = DRAWN;
    const full = vm.frame === "fullart";
    let pal = PALETTES[vm.color] || PALETTES.artifact;
    if (PAIR_RE.test(vm.color)) {
      // Split frame: every surface becomes a left-to-right blend of the two colors.
      const [a, b] = [PALETTES[vm.color[0]], PALETTES[vm.color[1]]];
      const grad = (prop) => {
        const g = ctx.createLinearGradient(W * 0.44, 0, W * 0.56, 0);
        g.addColorStop(0, a[prop]);
        g.addColorStop(1, b[prop]);
        return g;
      };
      pal = { frame: grad("frame"), bar: grad("bar"), box: grad("box") };
    }

    roundRect(ctx, { x: 0, y: 0, w: W, h: H }, 38);
    ctx.fillStyle = "#0d0d0f";
    ctx.fill();

    if (full) {
      drawArt(ctx, vm.artImg, artBox(vm), vm.crop);
    } else {
      panel(ctx, L.frame, 16, pal.frame);
      drawArt(ctx, vm.artImg, L.art, vm.crop);
      ctx.lineWidth = 4;
      ctx.strokeStyle = "rgba(0,0,0,.6)";
      ctx.strokeRect(L.art.x, L.art.y, L.art.w, L.art.h);
    }
    const barAlpha = full ? 0.86 : 1;

    panel(ctx, L.title, 14, pal.bar, barAlpha);
    if (vm.subtitle) {
      drawSubtitleTab(ctx, vm.subtitle, L.title.x, L.title.w, L.title.y + L.title.h, (c, tab) => {
        c.globalAlpha = barAlpha;
        c.fillStyle = pal.bar;
        c.fillRect(tab.x, tab.y - 2, tab.w, tab.h + 2);
        c.globalAlpha = 1;
      }, INK, vm.subtitleStyle);
    }
    const nameEnd = drawCost(ctx, vm.manaCost, L.title.x + L.title.w - 18, L.title.y + L.title.h / 2, 18);
    drawLine(ctx, vm.title, { ...L.title, x: L.title.x + 20 }, nameEnd - 10, 38, INK);

    panel(ctx, L.type, 12, pal.bar, barAlpha);
    drawLine(ctx, vm.typeLine, { ...L.type, x: L.type.x + 20 }, L.type.x + L.type.w - 20, 31, INK);

    panel(ctx, L.text, 6, pal.box, full ? 0.84 : 1);
    const corner = cornerText(vm);
    drawTextBox(ctx, vm, { ...L.text, h: L.text.h - (corner ? 18 : 0) }, 22, INK);

    if (corner) {
      panel(ctx, L.pt, 12, pal.bar);
      drawCentered(ctx, corner, L.pt, 38, INK);
    }
    drawFooter(ctx, vm, 48, 1012, W - 96);
  }

  // ---------- main ----------
  /**
   * vm: { title, subtitle, manaCost, typeLine, oracleText, flavorText, power, toughness, loyalty,
   *       defense, artist, color, frame ("standard"|"fullart"), frameSpec ({layout, fullArt, textColor,
   *       frameImg, ptImg, crownImg} | null), artImg, crop, basicSymbol, symbolImage }
   */
  function render(ctx, vm) {
    symbolImage = vm.symbolImage || (() => null);
    ctx.save();
    ctx.clearRect(0, 0, W, H);
    roundRect(ctx, { x: 0, y: 0, w: W, h: H }, 38); // rounded card corners
    ctx.clip();
    if (vm.frameSpec?.frameImg) renderPack(ctx, vm);
    else renderDrawn(ctx, vm);
    ctx.restore();
  }

  // ---------- split cards ----------
  // The card is turned sideways (landscape H x W) and holds two half-size cards side by side.
  // Reading it: rotate the printed card 90° clockwise.
  const SPLIT = (() => {
    const halfW = H / 2, k = halfW / W, miniH = H * k;
    return { halfW, k, miniH, y: (W - miniH) / 2 };
  })();

  function renderSplit(ctx, vms) {
    const s = Math.max(1, ctx.getTransform().a);
    ctx.save();
    ctx.clearRect(0, 0, W, H);
    roundRect(ctx, { x: 0, y: 0, w: W, h: H }, 38);
    ctx.clip();
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    ctx.translate(0, H);
    ctx.rotate(-Math.PI / 2);
    vms.forEach((vm, i) => {
      const oc = document.createElement("canvas");
      oc.width = Math.round(W * s * SPLIT.k);
      oc.height = Math.round(H * s * SPLIT.k);
      const o = oc.getContext("2d");
      o.scale(s * SPLIT.k, s * SPLIT.k);
      render(o, vm);
      ctx.drawImage(oc, i * SPLIT.halfW, SPLIT.y, SPLIT.halfW, SPLIT.miniH);
    });
    ctx.restore();
  }

  /** Convert a drag on the split card (card coordinates) into a drag inside a half (half-card coordinates). */
  // Halves are drawn rotated by -90°: card x maps to the half's y, card y to the half's -x.
  const splitDelta = (dx, dy, k = SPLIT.k) => ({ dx: -dy / k, dy: dx / k });

  // Split frame from a pack: one full-card image, halves stacked top/bottom, text rotated -90°.
  // Positions are anchors (x, y) plus a width along the rotated text direction (see fetch_frames.py).
  function splitLocal(anchor, f) {
    // Card fractions -> coordinates in the rotated frame of a half whose title anchor is `anchor`.
    return { x: (anchor[1] - f[1]) * H, y: (f[0] - anchor[0]) * W, w: f[2] * W, h: f[3] * H };
  }
  function splitArtLocal(anchor, f) {
    // Art is given unrotated (x, y, w, h); turn it into the half's rotated frame.
    return { x: (anchor[1] - (f[1] + f[3])) * H, y: (f[0] - anchor[0]) * W, w: f[3] * H, h: f[2] * W };
  }
  /** Art rectangle of half i in that half's own (rotated) coordinates — crop offsets are relative to it. */
  const splitArtBox = (spec, i) => splitArtLocal(spec.halves[i].title, spec.halves[i].art);

  function renderSplitPack(ctx, vms, spec) {
    ctx.save();
    ctx.clearRect(0, 0, W, H);
    roundRect(ctx, { x: 0, y: 0, w: W, h: H }, 38);
    ctx.clip();
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    // Arts first (under the frame), each in its half's rotated frame.
    vms.forEach((vm, i) => {
      const h = spec.halves[i];
      const [ax, ay] = [h.title[0] * W, h.title[1] * H];
      const box = splitArtLocal(h.title, h.art);
      // The printed half until custom art is added (still movable).
      const img = !vm.customArt && vm.cardImg ? regionImage(vm.cardImg, box, [0, 1, -1, 0, ay, -ax]) : vm.artImg;
      ctx.save();
      ctx.translate(ax, ay);
      ctx.rotate(-Math.PI / 2);
      drawArt(ctx, img, box, vm.crop);
      ctx.restore();
    });
    // Frame: bottom half (half 0) and top half (half 1) may have different colors.
    for (const [img, top] of [[spec.frameImgs[0], false], [spec.frameImgs[1] || spec.frameImgs[0], true]]) {
      if (!img) continue;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, top ? 0 : H / 2, W, H / 2);
      ctx.clip();
      ctx.drawImage(img, 0, 0, W, H);
      ctx.restore();
    }
    vms.forEach((vm, i) => {
      symbolImage = vm.symbolImage || (() => null);
      const h = spec.halves[i];
      ctx.save();
      ctx.translate(h.title[0] * W, h.title[1] * H);
      ctx.rotate(-Math.PI / 2);
      const T = splitLocal(h.title, h.title), Y = splitLocal(h.title, h.type), X = splitLocal(h.title, h.text);
      const M = splitLocal(h.title, h.mana || [h.title[0] + 0.0127, h.title[1], h.title[2], 71 / 2100]);
      const end = drawManaBox(ctx, vm.manaCost, M);
      drawLine(ctx, vm.title, T, Math.min(T.x + T.w, end - 6), px("title"), INK);
      drawLine(ctx, vm.typeLine, Y, Y.x + Y.w, px("splitType"), INK);
      drawRules(ctx, X, parseParagraphs(vm.oracleText, vm.flavorText, vm.typeLine), 0, INK, px("rules"), { padY: TEXT_PAD });
      ctx.restore();
    });
    ctx.restore();
  }

  /** All symbol tokens ("{2}", "{W/U}", "{T}") a view model needs, so the caller can preload them. */
  function symbolsUsed(vm) {
    const a = vm.adventure || {}, s = vm.second || {}, f = vm.flipside || {};
    const text = [vm.manaCost, vm.oracleText, vm.flavorText, vm.basicSymbol, a.manaCost, a.oracleText,
      s.manaCost, s.oracleText, f.hint].join("");
    return [...new Set(text.match(/\{[^}]+\}/g) || [])];
  }

  return { W, H, render, renderSplit, renderSplitPack, splitDelta, splitArtBox, artBox, artTarget, autoColor, symbolsUsed, PAIR_RE };
})();
