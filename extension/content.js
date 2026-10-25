// Facebook side. Does nothing until the webapp asks. Scrolls the album the user has open and collects thumbnails,
// and later opens accepted photos in the viewer (no page load) to read the 2048px version.
(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (a, b) => a + Math.random() * (b - a);
  const out = (m) => chrome.runtime.sendMessage(m);
  const keyOf = (src) => src.split("?")[0].split("/").pop();
  const base = (u) => u.split("?")[0].split("/").pop().replace(/\.\w+$/, "");

  const items = new Map();   // key -> {key, url, href}
  const sent = new Set();
  let stopFlag = false;

  const pill = document.createElement("div");
  pill.style.cssText = "position:fixed;bottom:12px;left:12px;z-index:2147483647;background:#111827;color:#e5e7eb;font:12px system-ui;padding:6px 10px;border-radius:999px;display:none";
  document.documentElement.appendChild(pill);
  const say = (t) => { pill.textContent = "tagged · " + t; pill.style.display = t ? "block" : "none"; out({ t: "status", text: t }); };

  // Index every album thumbnail currently in the DOM; with emit=true also hand the new ones to the webapp.
  function index(emit) {
    let fresh = 0;
    for (const img of document.images) {
      if (!/fbcdn|scontent/.test(img.src) || img.naturalWidth < 150) continue;
      const key = keyOf(img.src);
      if (!items.has(key)) {
        const a = img.closest("a[href]");
        items.set(key, { key, url: img.src, href: a ? a.href : null });
      }
      if (emit && !sent.has(key)) { sent.add(key); out({ t: "thumb", key, url: items.get(key).url }); fresh++; }
    }
    return fresh;
  }
  const scan = () => index(true);

  // Album name: the header line right above "1 post · 86 items"; falls back to the tab title.
  function albumTitle() {
    const lines = (document.body.innerText || "").split("\n").map((x) => x.trim()).filter(Boolean).slice(0, 250);
    const i = lines.findIndex((l) => /\d[\d.,\u00a0 ]*\s*(?:items?|itens|elementos)\b/i.test(l));
    for (let j = i - 1; i > 0 && j >= Math.max(0, i - 3); j--) {
      if (/^\d+\s*(post|publica)/i.test(lines[j]) || lines[j].length > 120) continue;
      return lines[j];
    }
    const t = document.title.replace(/^\(\d+\+?\)\s*/, "").replace(/\s*[|·-]\s*Facebook$/, "").trim();
    return t && t !== "Facebook" ? t : "Álbum";
  }

  // The album header says how many items it has ("86 items"); used to warn when not everything was loaded.
  function albumTotal() {
    const t = (document.body.innerText || "").slice(0, 4000);
    const m = t.match(/(\d[\d.,\u00a0 ]*)\s*(?:items?|itens|elementos|fotos?|photos?)\b/i);
    return m ? parseInt(m[1].replace(/\D/g, ""), 10) : null;
  }

  // Collects only what is already loaded on the page: the user scrolls the album first.
  async function collect(reset) {
    if (reset) sent.clear();
    const title = albumTitle(), expected = albumTotal();
    out({ t: "meta", title, expected, v: chrome.runtime.getManifest().version });
    scan();
    say("a ler a data do álbum…");
    out({ t: "collect-done", count: sent.size, expected, title });
  }

  // The album is a long virtualised list: photos far from the viewport are not in the DOM. Scroll towards the target
  // (the items map keeps album order) instead of blindly down then up.
  const findAnchor = async (href) => {
    const get = () => [...document.querySelectorAll("a[href]")].find((a) => a.href === href && a.querySelector("img"));
    let a = get();
    if (a) return a;
    const keys = [...items.keys()];
    const target = keys.findIndex((k) => items.get(k).href === href);
    let here = -1;
    for (const im of document.images) {
      if (/fbcdn|scontent/.test(im.src) && im.closest("a[href]")) { here = keys.indexOf(keyOf(im.src)); if (here >= 0) break; }
    }
    const dir = here < 0 || target < 0 || target >= here ? 1 : -1;
    for (const d of [dir, -dir]) {
      for (let i = 0; !a && i < 60; i++) { window.scrollBy({ top: d * innerHeight * 0.8 }); await sleep(250); a = get(); }
    }
    return a;
  };

  // Same thing a person does: open the photo in the viewer (no page load; the viewer's own request brings the 2048px
  // version), read the big <img>, go back. Typically 0.2-0.5 s per photo.
  async function viewerFull(it) {
    const T = { find: 0, view: 0, back: 0 };
    let t = performance.now();
    const lap = (k) => { const n = performance.now(); T[k] = Math.round(n - t); t = n; };
    const a = it.href && await findAnchor(it.href);
    lap("find");
    if (!a) return null;
    a.scrollIntoView({ block: "center" });
    const b = base(it.url);
    t = performance.now();
    a.click();
    let best = null;
    for (let i = 0; i < 40; i++) {
      await sleep(150);
      for (const im of document.images) {
        if (!/fbcdn|scontent/.test(im.src) || !im.complete || base(im.src) !== b) continue;
        if (!best || im.naturalWidth > best.w) best = { w: im.naturalWidth, h: im.naturalHeight, url: im.src };
      }
      if (best && best.w >= 1200) break;
    }
    lap("view");
    history.back();
    for (let i = 0; i < 30 && /^\/photo/.test(location.pathname); i++) await sleep(100);
    const p = jitter(250, 600);
    await sleep(p);
    lap("back");
    return best && best.w >= 1200 ? { ...best, ms: T } : null;
  }

  async function full(keys) {
    stopFlag = false;
    index(false);   // rebuild the key -> link map from the page, so this also works after a reload or for an older session
    for (const [i, key] of keys.entries()) {
      if (stopFlag) break;
      say(`a obter originais ${i + 1}/${keys.length}`);
      const it = items.get(key);
      const t0 = performance.now();
      const f = it ? await viewerFull(it) : null;
      if (f) out({ t: "full-url", key, url: f.url, w: f.w, h: f.h, ms: { ...f.ms, total: Math.round(performance.now() - t0) } });
      else out({ t: "full-item", key, error: it ? "original indisponível" : "foto já não está na página" });
      const gap = jitter(300, 800);
      await sleep(gap);
    }
    say("");
    out({ t: "full-done" });
  }

  chrome.runtime.onMessage.addListener((m) => {
    if (m.t === "collect") collect(m.reset);
    else if (m.t === "stop") stopFlag = true;
    else if (m.t === "full") full(m.keys);
  });
})();
