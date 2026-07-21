// Shared widgets for every example page:
//  - "save" (PNG) + "share" buttons overlaid bottom-right of the rendered map
//  - a "copy" button on the Code section heading
// Included with <script src="example-widgets.js" defer> after the page markup.
(function () {
  "use strict";

  const css = `
    .mj-actions {
      position: absolute; right: 10px; bottom: 10px; z-index: 20;
      display: flex; gap: 6px; line-height: 1.4;
      font-family: 'IBM Plex Mono', monospace;
    }
    .mj-btn {
      font-family: 'IBM Plex Mono', monospace; font-size: 10px; font-weight: 400;
      letter-spacing: 0.14em; text-transform: uppercase;
      background: rgba(250, 250, 250, 0.92); color: var(--ink, #1a1a1a);
      border: 1px solid var(--border, #e5e4df); padding: 5px 10px; cursor: pointer;
    }
    .mj-btn:hover { border-color: var(--ink, #1a1a1a); }
    .mj-share { position: relative; }
    .mj-menu {
      position: absolute; right: 0; bottom: calc(100% + 6px); display: none;
      flex-direction: column; min-width: 140px;
      background: var(--bg, #fafafa); border: 1px solid var(--border, #e5e4df);
      box-shadow: 0 2px 10px rgba(26, 26, 26, 0.12);
    }
    .mj-menu.open { display: flex; }
    .mj-menu a {
      padding: 7px 12px; font-size: 10px; letter-spacing: 0.14em;
      text-transform: uppercase; text-decoration: none; color: var(--ink, #1a1a1a);
    }
    .mj-menu a:hover { background: var(--code-bg, #efeeea); }
    .mj-copy {
      float: right;
    }
    h2.mj-has-copy { overflow: hidden; }
  `;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  const slug = (location.pathname.split("/").pop() || "map").replace(/\.html$/, "") || "map";

  // ---- map overlay: png download + share -------------------------------

  const wrap = document.querySelector(".map-wrap");
  if (wrap) {
    wrap.style.position = "relative";

    const actions = document.createElement("div");
    actions.className = "mj-actions";

    const dl = document.createElement("button");
    dl.className = "mj-btn";
    dl.textContent = "save";
    dl.addEventListener("click", () => {
      downloadPng().catch(() => { dl.textContent = "export failed"; revert(dl, "save"); });
    });

    const share = document.createElement("div");
    share.className = "mj-share";
    const shareBtn = document.createElement("button");
    shareBtn.className = "mj-btn";
    shareBtn.textContent = "share";
    const menu = document.createElement("div");
    menu.className = "mj-menu";
    const u = encodeURIComponent(location.href);
    const t = encodeURIComponent(document.title);
    for (const [name, href] of [
      ["X", `https://twitter.com/intent/tweet?url=${u}&text=${t}`],
      ["Reddit", `https://www.reddit.com/submit?url=${u}&title=${t}`],
      ["Hacker News", `https://news.ycombinator.com/submitlink?u=${u}&t=${t}`],
      ["Facebook", `https://www.facebook.com/sharer/sharer.php?u=${u}`],
    ]) {
      const a = document.createElement("a");
      a.href = href; a.target = "_blank"; a.rel = "noopener";
      a.textContent = name;
      menu.appendChild(a);
    }
    shareBtn.addEventListener("click", (e) => { e.stopPropagation(); menu.classList.toggle("open"); });
    document.addEventListener("click", () => menu.classList.remove("open"));
    share.appendChild(shareBtn);
    share.appendChild(menu);

    actions.appendChild(dl);
    actions.appendChild(share);
    wrap.appendChild(actions);
  }

  function revert(btn, label) { setTimeout(() => (btn.textContent = label), 1800); }

  // Serialize the live SVG (computed presentation styles inlined so CSS- and
  // d3-driven fills survive), rasterize at 2x, save as <page>.png.
  const STYLE_PROPS = [
    "fill", "fill-opacity", "stroke", "stroke-width", "stroke-opacity",
    "stroke-dasharray", "stroke-linejoin", "stroke-linecap", "opacity",
    "mix-blend-mode", "isolation",
    "font-family", "font-size", "font-weight", "font-style",
    "letter-spacing", "text-anchor", "paint-order", "display", "visibility",
  ];

  async function downloadPng() {
    const svg = wrap.querySelector("svg");
    if (!svg) throw new Error("no svg");

    const clone = svg.cloneNode(true);
    const src = svg.querySelectorAll("*");
    const dst = clone.querySelectorAll("*");
    for (let i = 0; i < src.length; i++) {
      if (dst[i].closest && dst[i].closest(".mj-actions")) continue;
      const cs = getComputedStyle(src[i]);
      let inline = "";
      for (const p of STYLE_PROPS) inline += p + ":" + cs.getPropertyValue(p) + ";";
      dst[i].setAttribute("style", inline);
    }

    const vb = svg.viewBox && svg.viewBox.baseVal;
    const w = vb && vb.width ? vb.width : svg.clientWidth || 960;
    const h = vb && vb.height ? vb.height : svg.clientHeight || 500;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
    clone.setAttribute("width", w);
    clone.setAttribute("height", h);

    // mix-blend-mode (e.g. `multiply`) blends each shape against what's BEHIND it. That backdrop
    // is the .map-wrap paper — which lives outside the SVG. Bake it in as a bottom rect so overlapping
    // strokes darken in the export exactly as they do live; without it, multiply has nothing to darken
    // against and the image comes out washed-out and low-contrast.
    const paper = getComputedStyle(wrap).backgroundColor;
    if (paper && paper !== "rgba(0, 0, 0, 0)" && paper !== "transparent") {
      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("x", vb ? vb.x : 0);
      rect.setAttribute("y", vb ? vb.y : 0);
      rect.setAttribute("width", w);
      rect.setAttribute("height", h);
      rect.setAttribute("fill", paper);
      clone.insertBefore(rect, clone.firstChild);
    }

    const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error("svg rasterization failed"));
        im.src = url;
      });
      const scale = 2;
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      const ctx = canvas.getContext("2d");
      const bg = getComputedStyle(wrap).backgroundColor;
      ctx.fillStyle = bg && bg !== "rgba(0, 0, 0, 0)" ? bg : "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      await new Promise((resolve, reject) => canvas.toBlob((b) => {
        if (!b) return reject(new Error("png encoding failed"));
        const a = document.createElement("a");
        a.href = URL.createObjectURL(b);
        a.download = slug + ".png";
        a.click();
        URL.revokeObjectURL(a.href);
        resolve();
      }, "image/png"));
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // ---- copy button on the Code section ----------------------------------

  for (const h2 of document.querySelectorAll("section h2")) {
    if (!h2.textContent.trim().startsWith("Code")) continue;
    const pre = h2.parentElement.querySelector("pre");
    if (!pre) continue;
    h2.classList.add("mj-has-copy");
    const btn = document.createElement("button");
    btn.className = "mj-btn mj-copy";
    btn.textContent = "copy";
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(pre.textContent);
        btn.textContent = "copied ✓";
      } catch {
        btn.textContent = "copy failed";
      }
      revert(btn, "copy");
    });
    h2.appendChild(btn);
  }
})();
