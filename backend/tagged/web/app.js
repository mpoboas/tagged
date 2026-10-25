// tagged webapp. Photos arrive from the browser extension into a session, the API returns each face's embedding,
// this page matches them against the people kept in IndexedDB, the user reviews, and the originals leave as a zip
// (<session>_0001.jpg…) or go straight to Google Photos. No inline handlers: everything goes through data-act.
'use strict';

const EXT_MIN = '0.7.0';
const COL = { certeza: '#22c55e', rever: '#f59e0b', 'sem match': '#64748b', erro: '#ef4444' };
const TABS = [['certeza', 'certeza'], ['rever', 'rever'], ['sem match', 'sem match'], ['unknown', 'caras por nomear']];
const CFG = { certain: .5, review: .35, minDet: .6, minFace: 20, extension: null, googleClientId: null };
const S = { tab: 'certeza', person: '', view: 'sessions', search: '', onlyUnrev: false, hiddenClusters: new Set() };
let SESS = [], cur = null, LIVE = null, PEOPLE = [], PE = {}, PVER = 0, IVER = 0, CUR = [], LB = null, FOC = null, DL = null, GP = null;
let collecting = false, lastCollectMsg = 0, MODEL = 'loading', MODEL_ERR = null;
let EXT = { ok: false, v: null, fb: false, fbUrl: null, seen: 0 };

const cfg = (() => { try { return JSON.parse(localStorage.getItem('tagged.cfg') || '{}') } catch (e) { return {} } })();
cfg.off = new Set(cfg.off || []);
const saveCfg = () => { try { localStorage.setItem('tagged.cfg', JSON.stringify({ off: [...cfg.off], certain: cfg.certain, review: cfg.review })) } catch (e) { } };
const on = n => !cfg.off.has(n);
const th = () => ({ certain: cfg.certain ?? CFG.certain, review: cfg.review ?? CFG.review });

const send = m => window.postMessage({ src: 'tagged-web', ...m }, location.origin);
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const b64 = s => { const b = atob(s), a = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a };
const slug = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'album';
const fmt = t => new Date(t).toLocaleString('pt-PT', { dateStyle: 'short', timeStyle: 'short' });
const pad = n => String(n).padStart(2, '0');
const fmtT = sec => sec < 60 ? `${Math.max(1, Math.round(sec))} s` : `${Math.floor(sec / 60)} min ${pad(Math.round(sec % 60))} s`;
const vcmp = (a, b) => { const x = String(a || '0').split('.').map(Number), y = String(b || '0').split('.').map(Number); for (let i = 0; i < 3; i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d } return 0 };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const nf = (n, one, many) => `${n} ${n === 1 ? one : many}`;
let rq = 0;
const render = () => { cancelAnimationFrame(rq); rq = requestAnimationFrame(() => { if (S.view === 'session' && cur) draw(); updateProg() }) };

function saveBlob(name, blob) {
  const a = document.createElement('a'), url = URL.createObjectURL(blob);
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
async function persistStorage() {   // best-effort storage can be evicted; people and sessions only live here
  try { if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist() } catch (e) { }
}

/* ---------- progress card: model, collecting, analysing, originals, Google upload ---------- */
let doneUntil = 0, doneInfo = null, progTimer = 0;
function showProg(o) {
  const e = $('prog'); if (!o) { e.className = 'hidden'; e.innerHTML = ''; return }
  const done = o.tone === 'done', bad = o.tone === 'error'; e.className = 'mb-4';
  e.innerHTML = `<div class="card bg-base-100 shadow border ${done ? 'border-success/40' : bad ? 'border-error/50' : 'border-primary/30'}"><div class="card-body p-4 gap-3">
  <div class="flex items-center gap-3"><div class="text-3xl leading-none ${o.pct == null && !done && !bad ? 'animate-pulse' : ''}" aria-hidden="true">${o.icon}</div>
   <div class="flex-1 min-w-0"><div class="font-semibold">${esc(o.title)}</div><div class="text-sm opacity-70">${esc(o.sub || '')}</div></div>
   ${o.pct == null ? '' : `<div class="text-2xl font-bold tabular-nums ${done ? 'text-success' : 'text-primary'}">${Math.round(o.pct)}%</div>`}
   ${o.btn ? `<button type="button" class="btn btn-sm" data-act="${o.btn[0]}">${o.btn[1]}</button>` : ''}</div>
  ${bad ? '' : `<progress class="progress ${done ? 'progress-success' : 'progress-primary'} w-full h-3" ${o.pct == null ? '' : `value="${o.pct}" max="100"`}></progress>`}</div></div>`;
}
function updateProg() {
  clearTimeout(progTimer);
  if (GP) return showProg({ icon: '☁️', title: GP.title, sub: GP.total ? `Foto ${Math.min(GP.n + 1, GP.total)} de ${GP.total}` : '', pct: GP.total ? 100 * GP.n / GP.total : null });
  if (DL) {
    const n = DL.n, t = DL.total;
    if (DL.finishing) return showProg({ icon: '🗜️', title: 'A preparar as fotos…', sub: 'A juntar as fotos e a escrever a data em cada uma.', pct: 100 });
    const el = (performance.now() - DL.t0) / 1000, eta = n > 1 ? el / n * (t - n) : null;
    return showProg({ icon: '📸', title: DL.stopping ? 'A parar…' : 'A obter os originais do Facebook', btn: DL.stopping ? null : ['stop', 'Parar'],
      sub: `Foto ${Math.min(n + 1, t)} de ${t}` + (eta != null ? ` · faltam cerca de ${fmtT(eta)}` : '') + ' · deixa o separador do Facebook aberto', pct: 100 * n / t });
  }
  if (collecting) {
    const n = LIVE ? LIVE.photos.length : 0, x = LIVE && LIVE.expected;
    return showProg({ icon: '📥', title: 'A percorrer o álbum no Facebook…', btn: ['stop', 'Parar'],
      sub: `${n} fotos encontradas` + (x ? ` de ${x}` : '') + ' · a extensão faz scroll sozinha', pct: x ? Math.min(100, 100 * n / x) : null });
  }
  if (MODEL === 'error') return showProg({ icon: '⚠️', title: 'O reconhecimento facial não arrancou', sub: MODEL_ERR || '', tone: 'error' });
  const S_ = LIVE || cur;
  const pend = S_ ? S_.photos.filter(p => !p.faces && !p.err).length : 0;
  if (pend && MODEL !== 'ready') return showProg({ icon: '⏳', title: MODEL === 'offline' ? 'Sem ligação ao servidor' : 'A preparar o reconhecimento facial…',
    sub: MODEL === 'offline' ? 'A tentar de novo…' : 'Na primeira vez o servidor descarrega os modelos (~280 MB); demora um ou dois minutos.', pct: null });
  if (pend) { const tot = S_.photos.length, k = tot - pend; return showProg({ icon: '🔍', title: 'A reconhecer quem está nas fotos…', sub: `${k} de ${tot} fotos analisadas`, pct: 100 * k / tot }) }
  if (doneInfo && Date.now() < doneUntil) { progTimer = setTimeout(updateProg, Math.max(50, doneUntil - Date.now())); return showProg({ icon: '✅', title: doneInfo.title, sub: doneInfo.sub, pct: 100, tone: 'done' }) }
  showProg(null);
}

/* ---------- storage: IndexedDB, one record per photo so a click never rewrites the whole session ---------- */
let db;
const dbOpen = () => new Promise((res, rej) => {
  const r = indexedDB.open('tagged', 3);
  r.onupgradeneeded = () => {
    const d = r.result, tx = r.transaction;
    if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'id' });
    if (!d.objectStoreNames.contains('people')) d.createObjectStore('people', { keyPath: 'name' });
    if (!d.objectStoreNames.contains('photos')) { const st = d.createObjectStore('photos', { keyPath: ['sid', 'key'] }); st.createIndex('sid', 'sid'); st.createIndex('key', 'key') }
    if (d.objectStoreNames.contains('data')) {   // v2 kept a whole session in one record: split it
      const ph = tx.objectStore('photos');
      tx.objectStore('data').openCursor().onsuccess = ev => {
        const c = ev.target.result; if (!c) { d.deleteObjectStore('data'); return }
        c.value.photos.forEach((p, i) => ph.put({ sid: c.value.id, key: p.key, idx: i, bytes: p.bytes, faces: p.faces, w: p.w, h: p.h, sel: p.sel }));
        c.continue();
      };
    }
  };
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
const idb = (st, mode, fn) => new Promise((res, rej) => { const t = db.transaction(st, mode), r = fn(t.objectStore(st)); t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error) });
const sessRange = id => IDBKeyRange.bound([id, ''], [id, '￿']);
const dirty = new Map(), metaDirty = new Set(); let saveT = 0;
function touch(s, p) { if (s.deleted) return; if (p) dirty.set(p, s); metaDirty.add(s); clearTimeout(saveT); saveT = setTimeout(flush, 500) }
const rec = (s, p) => ({ sid: s.id, key: p.key, idx: p.id, bytes: p.bytes, w: p.w, h: p.h, sel: p.sel, rev: p.rev, err: p.err || null, dup: p.dup || null,
  faces: p.faces && p.faces.map(f => ({ bbox: f.bbox, det: f.det, emb: f.emb, scores: f.emb ? undefined : f.scores })) });
async function flush() {
  const ps = [...dirty], ss = [...metaDirty]; dirty.clear(); metaDirty.clear();
  if (!db) return;
  try {
    if (ps.length) await idb('photos', 'readwrite', st => { for (const [p, s] of ps) if (!s.deleted) st.put(rec(s, p)) });
    for (const s of ss) if (!s.deleted && s.photos.length) await saveMeta(s);
  } catch (e) { note('Não consegui guardar no browser: ' + (e && e.message || e), true) }
}
async function saveMeta(s) {
  const A = s.photos.map(info), best = A.reduce((b, i) => i.top > (b ? b.top : -1) ? i : b, null);
  const meta = { id: s.id, name: s.name, created: s.created, expected: s.expected, auto: s.auto, date: s.date || null, dateManual: !!s.dateManual, lmMin: s.lmMin ?? null,
    albumUrl: s.albumUrl || null, count: s.photos.length, certeza: A.filter(i => i.c === 'certeza').length, sel: A.filter(sel).length, cover: best ? best.p.key : null };
  const i = SESS.findIndex(x => x.id === s.id); if (i < 0) SESS.unshift(meta); else SESS[i] = meta;
  await idb('meta', 'readwrite', st => st.put(meta));
}

/* ---------- EXIF: Facebook strips it, so write the album date (and its UTC offset) into every JPEG ---------- */
function setExif(src, d) {
  if (!(src[0] === 0xFF && src[1] === 0xD8)) return src;
  const dt = `${d.getFullYear()}:${pad(d.getMonth() + 1)}:${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const off = -d.getTimezoneOffset(), tz = (off < 0 ? '-' : '+') + pad(Math.floor(Math.abs(off) / 60)) + ':' + pad(Math.abs(off) % 60);
  // TIFF header (8) | IFD0 at 8: DateTime, ExifIFD (30) | Exif IFD at 38: DateTimeOriginal, DateTimeDigitized,
  // OffsetTime, OffsetTimeOriginal, OffsetTimeDigitized (66) | date string at 104 (20) | offset string at 124 (7+1)
  const tiff = new Uint8Array(132), v = new DataView(tiff.buffer), enc = new TextEncoder();
  const ent = (o, tag, type, cnt, val) => { v.setUint16(o, tag, true); v.setUint16(o + 2, type, true); v.setUint32(o + 4, cnt, true); v.setUint32(o + 8, val, true) };
  tiff.set([0x49, 0x49, 0x2A, 0x00]); v.setUint32(4, 8, true);
  v.setUint16(8, 2, true); ent(10, 0x0132, 2, 20, 104); ent(22, 0x8769, 4, 1, 38); v.setUint32(34, 0, true);
  v.setUint16(38, 5, true); ent(40, 0x9003, 2, 20, 104); ent(52, 0x9004, 2, 20, 104); ent(64, 0x9010, 2, 7, 124); ent(76, 0x9011, 2, 7, 124); ent(88, 0x9012, 2, 7, 124); v.setUint32(100, 0, true);
  tiff.set(enc.encode(dt + '\0'), 104); tiff.set(enc.encode(tz + '\0'), 124);
  const len = 2 + 6 + tiff.length, app1 = new Uint8Array(2 + len);
  app1.set([0xFF, 0xE1, len >> 8, len & 255, 0x45, 0x78, 0x69, 0x66, 0, 0]); app1.set(tiff, 10);
  const head = [src.subarray(0, 2)], rest = []; let i = 2;
  while (i + 4 <= src.length && src[i] === 0xFF && src[i + 1] !== 0xDA && src[i + 1] !== 0xD9) {   // keep other segments, drop any old Exif
    const l = (src[i + 2] << 8) | src[i + 3], seg = src.subarray(i, i + 2 + l);
    if (src[i + 1] === 0xE0 && !rest.length) head.push(seg);   // JFIF APP0 stays first, as exiftool does
    else if (!(src[i + 1] === 0xE1 && src[i + 4] === 0x45 && src[i + 5] === 0x78)) rest.push(seg);
    i += 2 + l;
  }
  const parts = [...head, app1, ...rest, src.subarray(i)];
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length }
  return out;
}

/* ---------- extension bridge ---------- */
window.addEventListener('message', e => { const m = e.data; if (e.source !== window || !m || m.src !== 'tagged-ext') return; onExt(m) });
function badge() {
  const x = $('ext'); let t, c;
  if (!EXT.ok) { t = 'extensão não detetada'; c = 'badge-warning' }
  else if (vcmp(EXT.v, EXT_MIN) < 0) { t = `extensão desatualizada (${EXT.v || '?'}) · atualiza-a`; c = 'badge-error' }
  else if (CFG.extension && vcmp(EXT.v, CFG.extension) < 0) { t = `nova versão da extensão (${CFG.extension})`; c = 'badge-warning' }
  else if (EXT.fb) { t = 'extensão ligada · Facebook aberto'; c = 'badge-success' }
  else { t = 'extensão ligada · abre um álbum do Facebook'; c = 'badge-info' }
  x.textContent = t; x.className = 'badge ml-2 h-auto whitespace-nowrap ' + c;
  const go = $('go'), old = EXT.ok && vcmp(EXT.v, EXT_MIN) < 0;
  go.disabled = !EXT.ok || old || collecting || !!DL;
  go.title = !EXT.ok ? 'Instala a extensão (separador Extensão)' : old ? 'Atualiza a extensão' : !EXT.fb ? 'Abre um álbum do Facebook noutro separador' : '';
}
function onExt(m) {
  if (m.t === 'ready') { EXT = { ok: true, v: m.v, fb: !!m.fb, fbUrl: m.fbUrl || null, seen: Date.now() }; badge(); return }
  if (m.t === 'bridge') return;
  if (['meta', 'thumb', 'collect-progress', 'collect-done'].includes(m.t)) lastCollectMsg = Date.now();
  if (m.t === 'meta' && LIVE) { LIVE.gotMeta = true; if (LIVE.auto && m.title) { LIVE.name = m.title; if (cur === LIVE && $('title')) $('title').value = m.title } LIVE.expected = m.expected || null; if (m.url) LIVE.albumUrl = m.url; render() }
  else if (m.t === 'thumb' && LIVE) addThumb(LIVE, m);
  else if (m.t === 'collect-progress' && LIVE) { if (m.expected) LIVE.expected = m.expected; render() }
  else if (m.t === 'collect-done') collectDone(m);
  else if (m.t === 'error') {
    if (collecting) collectFailed(m.text);
    if (DL) { DL = null; badge(); render() }
    note(m.text, true);
  }
  else if (m.t === 'full-item') onFull(m);
  else if (m.t === 'full-done') { if (DL) { DL.done = true; DL.processed = m.processed ?? DL.total; const d = DL; tryFinish(); setTimeout(() => { if (DL === d) finishDL() }, 30000) } }
}
function popup(title, html) { $('mtitle').textContent = title; $('mtext').innerHTML = html; const d = $('modal'); if (!d.open) d.showModal() }
function note(t, err) {
  const e = $('msg'); if (!t) { e.className = 'hidden'; e.innerHTML = ''; return }
  e.className = 'alert mb-4 text-sm flex ' + (err ? 'alert-error' : '');
  e.innerHTML = `<span class="flex-1">${esc(t)}</span><button type="button" class="btn btn-ghost btn-xs" data-act="note-close" aria-label="fechar">✕</button>`;
}
setInterval(() => { send({ t: 'hello' }); if (EXT.ok && Date.now() - EXT.seen > 8000) { EXT.ok = false; badge() } }, 2500);
send({ t: 'hello' });

/* ---------- sessions: every collection is a new one ---------- */
function collect() {
  if (collecting || DL || !EXT.ok) return;
  const s = { id: Date.now(), name: 'A recolher…', created: Date.now(), expected: null, auto: true, photos: [], map: {}, albumUrl: EXT.fbUrl };
  LIVE = s; collecting = true; lastCollectMsg = Date.now(); badge(); openSession(s); note(''); updateProg();
  send({ t: 'collect', reset: true }); persistStorage();
}
setInterval(() => { if (collecting && Date.now() - lastCollectMsg > 20000) collectFailed('A extensão deixou de responder durante a recolha. Recarrega o separador do Facebook (F5) e tenta de novo.') }, 2000);
function collectFailed(text) {
  collecting = false; badge();
  if (LIVE && !LIVE.photos.length) dropLive(); else if (LIVE) touch(LIVE);
  note(text, true); render();
}
function dropLive() { const s = LIVE; LIVE = null; s.deleted = true; if (cur === s) { cur = null; setView('sessions') } }
function collectDone(m) {
  collecting = false; badge(); updateProg();
  if (!LIVE) return;
  if (!m.count) { dropLive(); return popup('Não encontrei fotos', 'O separador do Facebook não tinha nenhum álbum com fotos. Abre o álbum (a grelha de fotos) e tenta de novo.') }
  if (LIVE.auto && m.title) LIVE.name = m.title;
  if (LIVE.auto && LIVE.name === 'A recolher…') { const d = new Date(LIVE.created); LIVE.name = `Álbum ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}h${pad(d.getMinutes())}` }
  LIVE.expected = m.expected || LIVE.expected; if (m.url) LIVE.albumUrl = m.url;
  touch(LIVE); if (cur === LIVE && $('title')) $('title').value = LIVE.name;
  if (m.stopped) note(`Recolha parada: ${m.count} fotos.`);
  else if (m.expected && m.count < m.expected) popup('Faltam fotos do álbum', `<p>Recolhi ${m.count} de ${m.expected} fotos: faltam ${m.expected - m.count}.</p><p class="mt-2 opacity-70">Às vezes o Facebook conta vídeos ou fotos a que não tens acesso. Se faltarem muitas, recarrega o álbum no Facebook e carrega de novo em “Obter fotos” (cria uma sessão nova).</p>`);
  else note(`Recolha terminada: ${m.count} fotos` + (m.expected ? ` (o álbum tem ${m.expected}).` : '.'));
  render();
}
async function openSessionById(id) {
  if (LIVE && LIVE.id === id) return openSession(LIVE);   // still collecting: keep the live object
  const m = SESS.find(x => x.id === id); if (!m) return;
  const rows = (await idb('photos', 'readonly', st => st.index('sid').getAll(id)) || []).sort((a, b) => a.idx - b.idx);
  const s = { ...m, photos: [], map: {} };
  for (const r of rows) {
    const q = { ...r, id: s.photos.length, url: URL.createObjectURL(new Blob([r.bytes], { type: 'image/jpeg' })) };
    delete q.sid; delete q.idx; s.photos.push(q); s.map[q.key] = q;
    if (!q.faces) { q.err = null; enqueue(s, q) }   // left mid-analysis or failed: try again
  }
  openSession(s);
}
function openSession(s) {
  if (cur && cur !== s && cur !== LIVE && (!DL || DL.s !== cur)) cur.photos.forEach(p => URL.revokeObjectURL(p.url));
  if (cur !== s) { CARDS.clear(); FOC = null; S.hiddenClusters.clear() }
  cur = s; setView('session');
}
async function delSession(id) {
  if (DL && DL.s.id === id) return note('Esta sessão está a descarregar. Para primeiro.', true);
  if (!confirm('Eliminar esta sessão?')) return;
  await idb('meta', 'readwrite', st => st.delete(id)); await idb('photos', 'readwrite', st => st.delete(sessRange(id)));
  SESS = SESS.filter(x => x.id !== id);
  for (const s of [cur, LIVE]) if (s && s.id === id) s.deleted = true;
  if (LIVE && LIVE.id === id) { LIVE = null; if (collecting) { collecting = false; send({ t: 'stop' }); badge() } }
  if (cur && cur.id === id) cur = null;
  setView('sessions');
}
const localISO = t => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` };
function autoDate(s) { if (s.dateManual || s.lmMin == null) return; s.date = localISO(s.lmMin); const d = $('sdate'); if (d && cur === s) { d.value = s.date; d.classList.remove('input-warning') } }
function addThumb(s, m) {
  if (s.map[m.key]) return;
  if (m.lm) { const t = Date.parse(m.lm); if (!isNaN(t)) { s.lmMin = s.lmMin == null ? t : Math.min(s.lmMin, t); autoDate(s) } }
  const bytes = b64(m.b64);
  const p = { id: s.photos.length, key: m.key, bytes, url: URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' })), faces: null, w: 0, h: 0 };
  s.map[m.key] = p; s.photos.push(p); enqueue(s, p); touch(s, p);
  // the same photo already in another session (album collected twice): flag it and leave it out by default
  if (db) idb('photos', 'readonly', st => st.index('key').getAll(m.key)).then(rs => {
    const o = (rs || []).find(r => r.sid !== s.id); if (!o) return;
    p.dup = (SESS.find(x => x.id === o.sid) || {}).name || 'outra sessão'; p._i = null; touch(s, p); if (cur === s) render();
  }).catch(() => { });
  if (cur === s) render();
}

/* ---------- scoring queue: 3 at a time, waits for the model, retries transient failures ---------- */
const queue = []; let running = 0, pollT = 0;
function enqueue(s, p) { queue.push({ s, p }); pump() }
function pump() {
  if (MODEL !== 'ready') return;
  while (running < 3 && queue.length) {
    const { s, p } = queue.shift(); if (s.deleted || p.faces) continue;
    running++;
    fetch('/api/score?name=' + encodeURIComponent(p.key), { method: 'POST', body: new Blob([p.bytes]) })
      .then(async r => {
        const d = await r.json().catch(() => ({ error: 'HTTP ' + r.status }));
        if (r.status === 503) { queue.unshift({ s, p }); MODEL = d.model || 'loading'; MODEL_ERR = d.error; pollModel(); return }
        if (!r.ok) throw Object.assign(new Error(d.error || 'HTTP ' + r.status), { perm: r.status === 400 || r.status === 413 });
        p.faces = d.faces.map(f => ({ bbox: f.bbox, det: f.det, emb: Float32Array.from(f.emb) })); p.w = d.w; p.h = d.h; p.err = null; p.tries = 0; p._i = null;
      })
      .catch(e => {
        p.tries = (p.tries || 0) + 1;
        if (!e.perm && p.tries < 3) { setTimeout(() => enqueue(s, p), 1500 * 2 ** p.tries); return }
        p.err = String(e.message || e); p.perm = !!e.perm; p._i = null;
      })
      .finally(() => { running--; touch(s, p); pump(); if (cur === s || LIVE === s) render() });
  }
}
function retryErrors() { if (!cur) return; for (const p of cur.photos) if (p.err) { p.err = null; p.perm = false; p.tries = 0; p._i = null; enqueue(cur, p) } render() }
async function pollModel() {
  clearTimeout(pollT);
  try { const d = await (await fetch('/api/ping', { cache: 'no-store' })).json(); MODEL = d.model || 'ready'; MODEL_ERR = d.error } catch (e) { MODEL = 'offline' }
  updateProg();
  if (MODEL === 'ready') pump(); else pollT = setTimeout(pollModel, MODEL === 'error' ? 15000 : 2000);
}

/* ---------- people: the browser holds them (IndexedDB) and compares each face's embedding with them ---------- */
function scoresOf(f) {
  if (!f.emb) return f.scores || [];
  if (f._v === PVER) return f._s;
  const e = f.emb, out = [];
  for (const n in PE) {
    const { a, k } = PE[n]; let best = -1;
    for (let r = 0; r < k; r++) { let d = 0; const o = r * 512; for (let i = 0; i < 512; i++) d += a[o + i] * e[i]; if (d > best) best = d }
    if (best >= .2) out.push([n, Math.round(best * 1000) / 1000]);
  }
  out.sort((x, y) => y[1] - x[1]); f._s = out; f._v = PVER; return out;
}
const unit = e => { let t = 0; for (let i = 0; i < 512; i++) t += e[i] * e[i]; t = Math.sqrt(t) || 1; return Float32Array.from(e, x => x / t) };
function parseNpy(u8) {
  if (u8[0] !== 0x93 || String.fromCharCode(...u8.subarray(1, 6)) !== 'NUMPY') throw new Error('não é um ficheiro .npy');
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), v = u8[6]; let hl, off;
  if (v === 1) { hl = dv.getUint16(8, true); off = 10 } else { hl = dv.getUint32(8, true); off = 12 }
  const h = new TextDecoder().decode(u8.subarray(off, off + hl)), descr = (/'descr':\s*'([^']+)'/.exec(h) || [])[1];
  const shape = ((/'shape':\s*\(([^)]*)\)/.exec(h) || [])[1] || '').split(',').map(x => x.trim()).filter(Boolean).map(Number);
  if (/True/.test((/'fortran_order':\s*(\w+)/.exec(h) || [])[1] || '')) throw new Error('formato fortran não suportado');
  const n = shape.reduce((a, b) => a * b, 1), body = u8.subarray(off + hl); let a;
  if (descr === '<f4') a = new Float32Array(body.slice(0, n * 4).buffer);
  else if (descr === '<f8') a = Float32Array.from(new Float64Array(body.slice(0, n * 8).buffer));
  else throw new Error('tipo ' + descr + ' não suportado');
  if (shape[shape.length - 1] !== 512) throw new Error('esperava vetores de 512 valores, veio ' + shape[shape.length - 1]);
  for (let r = 0; r < n / 512; r++) a.set(unit(a.subarray(r * 512, r * 512 + 512)), r * 512);
  return { a, k: n / 512 };
}
function npy(a, k) {   // .npy v1.0, '<f4', shape (k, 512); header padded to 64 bytes like numpy does
  let h = `{'descr': '<f4', 'fortran_order': False, 'shape': (${k}, 512), }`;
  h += ' '.repeat((64 - (10 + h.length + 1) % 64) % 64) + '\n';
  const u = new Uint8Array(10 + h.length + a.byteLength);
  u.set([0x93, 78, 85, 77, 80, 89, 1, 0, h.length & 255, h.length >> 8]); u.set(new TextEncoder().encode(h), 10);
  u.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), 10 + h.length); return u;
}
function personName(path) { const parts = path.split('/').filter(Boolean); let b = (parts.pop() || '').replace(/\.npy$/i, ''); if (b === 'embeddings') b = parts.pop() || ''; return b }
const peopleChanged = () => { PVER++; IVER++; PEOPLE = Object.keys(PE).sort((a, b) => a.localeCompare(b, 'pt')); render(); if (cur) touch(cur) };
async function loadPeopleFiles(list) {
  const files = Array.from(list);   // copy first: a file input's FileList is live and is emptied when the input is reset
  const m = $('pmsg'); m.className = 'text-sm'; m.textContent = 'A ler ' + files.length + ' ficheiros…'; const found = {}, errs = [];
  const add = (path, u8) => { try { const name = personName(path); if (!name) throw new Error('sem nome (usa o ficheiro people.npz ou a pasta data/refs)'); found[name] = parseNpy(u8) } catch (e) { errs.push(`${path}: ${e.message}`) } };
  try {
    for (const f of files) {
      const isZip = /\.(npz|zip)$/i.test(f.name), isNpy = /\.npy$/i.test(f.name);
      if (!isZip && !isNpy) { if (!f.webkitRelativePath) errs.push(f.name + ': tipo não suportado'); continue }   // a folder also holds the .jpg crops: skip them
      const u8 = new Uint8Array(await f.arrayBuffer());
      if (isZip) { const z = fflate.unzipSync(u8); for (const k in z) if (/\.npy$/i.test(k)) add(k, z[k]) }
      else add(f.webkitRelativePath || f.name, u8);
    }
  } catch (e) { errs.push(String(e.message || e)) }
  const names = Object.keys(found);
  await idb('people', 'readwrite', st => { for (const n of names) { PE[n] = { ...found[n], added: 0 }; st.put({ name: n, a: found[n].a, k: found[n].k, added: 0 }) } });
  peopleChanged(); persistStorage(); viewSettings();
  const mm = $('pmsg'); if (mm) {
    mm.className = 'text-sm ' + (errs.length && !names.length ? 'text-error' : 'text-success');
    mm.textContent = names.length ? `${names.length} pessoas carregadas (${names.reduce((s, n) => s + found[n].k, 0)} caras de referência).` + (errs.length ? ` ${errs.length} ficheiros ignorados: ${errs[0]}` : '') : 'Nada carregado: ' + (errs[0] || 'sem ficheiros .npy');
  }
}
// Faces named in the webapp become extra references for that person (appended at the end, so they can be undone).
async function addRefs(name, embs) {
  name = name.trim(); if (!name || !embs.length) return;
  const old = PE[name], k0 = old ? old.k : 0, a = new Float32Array((k0 + embs.length) * 512);
  if (old) a.set(old.a);
  embs.forEach((e, j) => a.set(unit(e), (k0 + j) * 512));
  PE[name] = { a, k: k0 + embs.length, added: (old && old.added || 0) + embs.length };
  await idb('people', 'readwrite', st => st.put({ name, ...PE[name] }));
  if (cfg.off.delete(name)) saveCfg();
  peopleChanged(); persistStorage();
  note(`${embs.length === 1 ? 'Cara adicionada' : embs.length + ' caras adicionadas'} a ${name} (${PE[name].k} referências). As fotos foram reavaliadas.`);
}
async function undoAdded(n) {
  const p = PE[n]; if (!p || !p.added) return;
  const k = p.k - p.added;
  if (!k) { await delPerson(n); return }
  PE[n] = { a: p.a.slice(0, k * 512), k, added: 0 };
  await idb('people', 'readwrite', st => st.put({ name: n, ...PE[n] })); peopleChanged(); renderPeople();
}
async function clearPeople() { if (!confirm('Remover todas as pessoas deste browser?')) return; await idb('people', 'readwrite', st => st.clear()); PE = {}; peopleChanged(); viewSettings() }
async function delPerson(n) { if (!confirm(`Remover ${n}?`)) return; await idb('people', 'readwrite', st => st.delete(n)); delete PE[n]; peopleChanged(); renderPeople() }
function exportPeople() {
  if (!PEOPLE.length) return;
  const files = {}; for (const n of PEOPLE) files[n + '.npy'] = [npy(PE[n].a, PE[n].k), { level: 0 }];
  saveBlob('people.npz', new Blob([fflate.zipSync(files)], { type: 'application/zip' }));
}

/* ---------- triage: each face gets its best person, each person at most one face per photo ---------- */
const cls = s => { const t = th(); return s >= t.certain ? 'certeza' : s >= t.review ? 'rever' : 'sem match' };
function info(p) {
  if (p._i && p._iv === IVER) return p._i;
  let r;
  if (!p.faces) r = { id: p.id, p, faces: [], c: p.err ? 'erro' : 'pending', top: 0 };
  else {
    const pairs = [];
    p.faces.forEach((f, i) => scoresOf(f).forEach(([n, s]) => { if (on(n)) pairs.push([s, i, n]) }));
    pairs.sort((a, b) => b[0] - a[0]);
    const got = new Array(p.faces.length), used = new Set();
    for (const [s, i, n] of pairs) if (!got[i] && !used.has(n)) { got[i] = [n, s]; used.add(n) }
    let top = 0;
    const faces = p.faces.map((f, i) => { const [n, s] = got[i] || ['', 0]; if (s > top) top = s; return { ...f, i, name: n, score: s, c: cls(s) } });
    r = { id: p.id, p, faces, c: cls(top), top };
  }
  p._i = r; p._iv = IVER; return r;
}
const sel = i => i.p.sel === undefined ? i.c === 'certeza' && !i.p.dup : i.p.sel;
const rawOf = id => cur.photos[id];

/* ---------- views ---------- */
function setView(v) {
  S.view = v; closeBig();
  $('nav').innerHTML = [['sessions', 'Sessões'], ['session', 'Sessão atual'], ['settings', 'Definições'], ['extension', 'Extensão']].map(([k, l]) =>
    `<button type="button" role="tab" aria-selected="${v === k}" class="tab whitespace-nowrap ${v === k ? 'tab-active' : ''} ${k === 'session' && !cur ? 'tab-disabled' : ''}" ${k === 'session' && !cur ? 'disabled' : ''} data-act="view" data-v="${k}">${l}</button>`).join('');
  if (v === 'sessions') viewSessions(); else if (v === 'session') viewSession(); else if (v === 'extension') viewExtension(); else viewSettings();
}
const noPeople = () => PEOPLE.length ? '' : `<div class="alert alert-warning mb-4 text-sm"><span>Ainda não carregaste as pessoas a reconhecer. Sem elas, nenhuma foto é reconhecida.</span><button type="button" class="btn btn-sm" data-act="view" data-v="settings">Carregar pessoas</button></div>`;
let covers = [];
function viewSessions() {
  covers.forEach(u => URL.revokeObjectURL(u)); covers = [];
  const L = SESS.slice().sort((a, b) => b.created - a.created);
  $('view').innerHTML = noPeople() + (L.length ? `<div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">${L.map(s => `<article class="card bg-base-100 shadow overflow-hidden">
   ${s.cover ? `<figure class="h-40 bg-base-300"><img data-cover="${s.id}" alt="" class="w-full h-full object-cover"></figure>` : ''}
   <div class="card-body p-4 gap-1"><h3 class="card-title text-base">${esc(s.name)}</h3>
   <div class="text-xs opacity-60">${fmt(s.created)} · ${s.count} fotos${s.expected ? ` de ${s.expected}` : ''}</div>
   <div class="flex gap-2 text-sm"><span style="color:${COL.certeza}">${s.certeza} certeza</span><span class="opacity-60">${nf(s.sel, 'selecionada', 'selecionadas')}</span></div>
   <div class="card-actions justify-end"><button type="button" class="btn btn-sm btn-primary" data-act="open" data-id="${s.id}">Abrir</button><button type="button" class="btn btn-sm btn-ghost" data-act="del" data-id="${s.id}">Eliminar</button></div></div></article>`).join('')}</div>`
    : `<div class="opacity-70 text-center py-20 space-y-2"><p class="text-lg">Ainda não há sessões.</p><p>Abre um álbum no Facebook noutro separador e carrega em “Obter fotos do Facebook”: a extensão percorre o álbum sozinha.</p></div>`);
  if (db) for (const s of L) if (s.cover) idb('photos', 'readonly', st => st.get([s.id, s.cover])).then(r => {
    const img = document.querySelector(`img[data-cover="${s.id}"]`); if (!r || !img) return;
    const u = URL.createObjectURL(new Blob([r.bytes], { type: 'image/jpeg' })); covers.push(u); img.src = u;
  }).catch(() => { });
}
function viewSession() {
  if (!cur) return setView('sessions');
  const t = th();
  $('view').innerHTML = noPeople() + `<div class="flex flex-wrap items-center gap-3 mb-3">
   <input id="title" aria-label="Nome da sessão" class="input input-bordered font-bold text-lg flex-1 min-w-[16rem]" value="${esc(cur.name)}" data-chg="title">
   <label class="flex items-center gap-2 text-sm" title="Data escrita no EXIF das fotos. Por defeito é a data em que o Facebook recebeu as fotos (upload); podes mudá-la."><span class="opacity-70">data das fotos</span><input id="sdate" type="datetime-local" step="1" class="input input-bordered input-sm ${cur.date ? '' : 'input-warning'}" value="${cur.date || ''}" data-chg="date"></label>
   <span class="text-sm opacity-60">${cur.expected ? `álbum com ${cur.expected} fotos` : ''}</span>
   ${cur.albumUrl ? `<button type="button" class="btn btn-sm btn-ghost" data-act="open-album" title="Abre este álbum no separador do Facebook">álbum no Facebook ↗</button>` : ''}
   <button id="dl" type="button" class="btn btn-success btn-sm" data-act="dl" data-mode="zip">Descarregar zip</button>
   ${CFG.googleClientId ? `<button id="gp" type="button" class="btn btn-info btn-sm" data-act="dl" data-mode="gphotos">Enviar para o Google Photos</button>` : ''}</div>
  <div id="errs"></div>
  <div class="grid md:grid-cols-4 gap-3 mb-4"><div class="stats shadow md:col-span-2 bg-base-100 max-sm:grid-flow-row max-sm:grid-cols-2" id="stats"></div>
   <div class="card bg-base-100 shadow p-3 md:col-span-2 gap-1">
    <div class="flex justify-between items-center"><label for="rc" class="text-sm">certeza ≥ <b id="lc">${t.certain.toFixed(2)}</b></label><button type="button" class="btn btn-ghost btn-xs" data-act="th-reset" title="Voltar aos valores por defeito">repor</button></div>
    <input id="rc" type="range" min=".3" max=".9" step=".01" value="${t.certain}" class="range range-success range-xs" data-inp="certain">
    <label for="rr" class="text-sm">rever ≥ <b id="lr">${t.review.toFixed(2)}</b></label><input id="rr" type="range" min=".2" max=".8" step=".01" value="${t.review}" class="range range-warning range-xs" data-inp="review">
    <div id="hist" class="mt-1" title="Distribuição do melhor score de cada foto"></div></div></div>
  <div class="flex flex-wrap gap-3 items-center mb-4"><div role="tablist" class="tabs tabs-boxed overflow-x-auto max-w-full" id="tabs" aria-label="Grupos"></div>
   <span id="filters" class="flex flex-wrap gap-3 items-center"><select id="person" aria-label="Filtrar por pessoa" class="select select-bordered select-sm" data-chg="person"></select>
   <label id="unrevl" class="label cursor-pointer gap-2 text-sm"><input type="checkbox" class="checkbox checkbox-sm" data-chg="unrev" ${S.onlyUnrev ? 'checked' : ''}>só por rever</label>
   <button type="button" class="btn btn-xs" data-act="bulk" data-v="1">selecionar visíveis</button><button type="button" class="btn btn-xs btn-ghost" data-act="bulk" data-v="0">limpar visíveis</button></span>
   <span id="count" class="text-sm opacity-60"></span><button type="button" class="btn btn-xs btn-ghost ml-auto" data-act="help">atalhos de teclado (?)</button></div>
  <div id="grid" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4"></div>`;
  CARDS.clear(); draw();
}
function onThreshold(which, v) {
  const t = th(); t[which] = v;
  if (t.review > t.certain) { if (which === 'certain') t.review = t.certain; else t.certain = t.review }
  cfg.certain = t.certain; cfg.review = t.review; saveCfg(); IVER++;
  $('rc').value = t.certain; $('rr').value = t.review; $('lc').textContent = t.certain.toFixed(2); $('lr').textContent = t.review.toFixed(2);
  draw(); touch(cur);
}
function hist(A) {
  const lo = .2, hi = 1, nb = 40, b = new Array(nb).fill(0);
  for (const i of A) if (i.p.faces && i.top >= lo) b[Math.min(nb - 1, Math.floor((i.top - lo) / (hi - lo) * nb))]++;
  const mx = Math.max(1, ...b), w = 100 / nb;
  return `<svg viewBox="0 0 100 24" preserveAspectRatio="none" class="w-full h-8" role="img" aria-label="Histograma dos scores">${b.map((n, k) =>
    `<rect x="${k * w + .1}" y="${24 - 24 * n / mx}" width="${w - .2}" height="${24 * n / mx}" fill="${COL[cls(lo + (k + .5) * (hi - lo) / nb)]}"></rect>`).join('')}</svg>`;
}
function draw() {
  const A = cur.photos.map(info), cnt = { certeza: 0, rever: 0, 'sem match': 0, pending: 0, erro: 0 };
  A.forEach(i => cnt[i.c]++); const nsel = A.filter(sel).length, unrev = A.filter(i => i.c === 'rever' && !i.p.rev).length;
  $('stats').innerHTML = ['certeza', 'rever', 'sem match'].map(k => `<div class="stat"><div class="stat-title">${k}</div><div class="stat-value" style="color:${COL[k]}">${cnt[k]}</div>${k === 'rever' && cnt.rever ? `<div class="stat-desc">${cnt.rever - unrev} de ${cnt.rever} revistas</div>` : ''}</div>`).join('')
    + `<div class="stat"><div class="stat-title">fotos</div><div class="stat-value">${A.length}</div><div class="stat-desc">${cnt.pending ? cnt.pending + ' a analisar…' : nf(nsel, 'selecionada', 'selecionadas')}</div></div>`;
  $('errs').innerHTML = cnt.erro ? `<div class="alert alert-error mb-4 text-sm"><span>${cnt.erro} ${cnt.erro === 1 ? 'foto não foi analisada' : 'fotos não foram analisadas'} (${esc(A.find(i => i.c === 'erro').p.err)}).</span><button type="button" class="btn btn-sm" data-act="retry">Tentar de novo</button></div>` : '';
  $('hist').innerHTML = hist(A);
  $('tabs').innerHTML = TABS.map(([k, l]) => `<button type="button" role="tab" aria-selected="${S.tab === k}" class="tab whitespace-nowrap ${S.tab === k ? 'tab-active' : ''}" data-act="tab" data-v="${k}">${l}${k === 'unknown' ? '' : ` (${cnt[k]})`}</button>`).join('');
  const busy = !!DL || collecting;
  $('dl').disabled = busy || !nsel; $('dl').textContent = `Descarregar zip (${nsel})`;
  if ($('gp')) { $('gp').disabled = busy || !nsel; $('gp').textContent = `Enviar para o Google Photos (${nsel})` }
  $('filters').classList.toggle('hidden', S.tab === 'unknown'); $('unrevl').classList.toggle('hidden', S.tab !== 'rever');
  if (S.tab === 'unknown') { CUR = []; return drawUnknown(A) }
  const per = {}; A.forEach(i => i.faces.forEach(f => { if (f.c !== 'sem match' && f.name) per[f.name] = (per[f.name] || 0) + 1 }));
  $('person').innerHTML = '<option value="">todas as pessoas</option>' + Object.keys(per).sort((a, b) => a.localeCompare(b, 'pt')).map(n => `<option value="${esc(n)}" ${S.person === n ? 'selected' : ''}>${esc(n)} (${per[n]})</option>`).join('');
  const L = A.filter(i => i.c === S.tab && (!S.person || i.faces.some(f => f.name === S.person && f.c !== 'sem match')) && !(S.tab === 'rever' && S.onlyUnrev && i.p.rev));
  L.sort((a, b) => b.top - a.top); CUR = L;
  $('count').textContent = L.length + ' fotos';
  drawGrid(L, A.length);
  if (LB !== null) lb();
}

/* ---------- grid: one element per photo, reused and reordered instead of rebuilding the whole grid ---------- */
const CARDS = new Map();
function svg(i) {
  const p = i.p; if (!p.w) return '';
  return `<svg viewBox="0 0 ${p.w} ${p.h}" class="absolute inset-0 w-full h-full pointer-events-none" aria-hidden="true">${i.faces.map(f => {
    const [x1, y1, x2, y2] = f.bbox, k = p.w / 220;
    return `<rect x="${x1}" y="${y1}" width="${x2 - x1}" height="${y2 - y1}" fill="none" stroke="${COL[f.c]}" stroke-width="${k}"></rect>${f.c !== 'sem match' ? `<text x="${x1}" y="${y1 - k * 2}" fill="${COL[f.c]}" font-size="${k * 8}" font-weight="700" stroke="#000" stroke-width="${k * 1.2}" paint-order="stroke">${esc(f.name)} ${f.score.toFixed(2)}</text>` : ''}`;
  }).join('')}</svg>`;
}
const badges = (i, big) => i.faces.filter(f => f.c !== 'sem match').map(f => `<span class="badge ${big ? 'badge-lg' : ''}" style="border-color:${COL[f.c]}">${esc(f.name)} ${f.score.toFixed(2)}</span>`).join('') || '<span class="text-xs opacity-60">sem caras reconhecidas</span>';
function drawGrid(L, total) {
  const g = $('grid');
  delete g.dataset.unk;
  if (!L.length) { g.innerHTML = `<div class="opacity-60 col-span-full text-center py-16">${total ? 'nenhuma foto neste grupo' : 'a aguardar fotos…'}</div>`; return }
  if (g.firstElementChild && !g.firstElementChild.dataset.id) g.innerHTML = '';
  let prev = null;
  for (const i of L) {
    let c = CARDS.get(i.id);
    if (!c) {
      const el = document.createElement('div'); el.dataset.id = i.id;
      el.innerHTML = `<figure class="relative"><button type="button" class="block w-full cursor-zoom-in focus:outline-none" data-act="big" data-id="${i.id}" aria-label="Ampliar ${esc(i.p.key)}"><img src="${i.p.url}" alt="" loading="lazy" decoding="async" class="w-full" ${i.p.w ? `width="${i.p.w}" height="${i.p.h}"` : ''}></button><div class="ov"></div></figure><div class="card-body p-3 gap-1"></div>`;
      c = { el, sig: '' }; CARDS.set(i.id, c);
    }
    const on_ = sel(i), sig = [on_, i.p.rev, i.p.dup, FOC === i.id, i.p.w, i.faces.map(f => f.name + f.c + f.score).join()].join('|');
    if (c.sig !== sig) {
      c.sig = sig;
      c.el.className = `card bg-base-100 shadow-md overflow-hidden ${on_ ? 'ring-2 ring-success' : ''} ${FOC === i.id ? 'outline outline-2 outline-offset-2 outline-primary' : ''}`;
      const img = c.el.querySelector('img'); if (i.p.w && !img.getAttribute('width')) { img.setAttribute('width', i.p.w); img.setAttribute('height', i.p.h) }
      c.el.querySelector('.ov').innerHTML = svg(i) + `<input type="checkbox" class="checkbox checkbox-success checkbox-md absolute top-2 left-2 bg-black/50" ${on_ ? 'checked' : ''} data-act="toggle" data-id="${i.id}" aria-label="Incluir ${esc(i.p.key)} no download">`;
      c.el.querySelector('.card-body').innerHTML = `<div class="flex flex-wrap gap-1">${badges(i)}${i.p.dup ? `<span class="badge badge-ghost" title="Esta foto já foi recolhida noutra sessão">já em: ${esc(i.p.dup)}</span>` : ''}${i.p.rev && i.c === 'rever' ? '<span class="badge badge-ghost">revista</span>' : ''}</div><div class="text-xs opacity-60 truncate">${esc(i.p.key)} · ${i.faces.length} caras</div>`;
    }
    const want = prev ? prev.nextSibling : g.firstChild;
    if (want !== c.el) g.insertBefore(c.el, want);
    prev = c.el;
  }
  while (prev.nextSibling) prev.nextSibling.remove();
}
function setSel(id, v) { const p = rawOf(id); p.sel = v; p.rev = true; p._i = null; touch(cur, p) }
function toggle(id) { setSel(id, !sel(info(rawOf(id)))); draw() }
function bulk(v) { CUR.forEach(i => setSel(i.id, v)); draw() }
// P / X (as in Lightroom): include or leave out, then move on; works in the grid and in the lightbox.
function decide(id, v) {
  const k = CUR.findIndex(i => i.id === id); setSel(id, v); draw();
  const j = CUR.findIndex(i => i.id === id), next = j >= 0 ? CUR[j + 1] : CUR[k];
  if (LB !== null) { if (next) { LB = next.id; lb() } else closeBig() }
  else focusCard(next ? next.id : null);
}
function focusCard(id) {
  FOC = id; draw();
  const c = id != null && CARDS.get(id); if (c) { c.el.querySelector('button[data-act="big"]').focus({ preventScroll: true }); c.el.scrollIntoView({ block: 'nearest' }) }
}
function moveFocus(dx, dy) {
  if (!CUR.length) return;
  const k = CUR.findIndex(i => i.id === FOC);
  if (k < 0) return focusCard(CUR[0].id);
  const els = [...$('grid').children], top0 = els[0].offsetTop, cols = Math.max(1, els.filter(e => e.offsetTop === top0).length);
  const n = Math.max(0, Math.min(CUR.length - 1, k + dx + dy * cols)); focusCard(CUR[n].id);
}

/* ---------- unnamed faces: group the faces nobody matched, so a new person can be named in one go ---------- */
let UNK = null;
function clusters(A) {
  const faces = [];
  for (const i of A) for (const f of i.faces) {
    const [x1, y1, x2, y2] = f.bbox;
    if (f.emb && f.c === 'sem match' && Math.min(x2 - x1, y2 - y1) >= 30 && (f.det ?? 1) >= .7) faces.push({ i, f, size: (x2 - x1) * (y2 - y1) });
  }
  faces.sort((a, b) => b.size - a.size);
  const cl = [];
  for (const x of faces.slice(0, 3000)) {   // leader clustering against each group's running mean
    let best = null, bs = .45;
    for (const c of cl) { let d = 0; for (let k = 0; k < 512; k++) d += c.m[k] * x.f.emb[k]; if (d > bs) { bs = d; best = c } }
    if (best) { best.items.push(x); for (let k = 0; k < 512; k++) best.s[k] += x.f.emb[k]; best.m = unit(best.s) }
    else cl.push({ items: [x], s: Float32Array.from(x.f.emb), m: unit(x.f.emb) });
  }
  return cl.filter(c => c.items.length >= 2).sort((a, b) => b.items.length - a.items.length).map((c, n) => {
    c.items.forEach(x => { let d = 0; for (let k = 0; k < 512; k++) d += c.m[k] * x.f.emb[k]; x.d = d });
    c.items.sort((a, b) => b.d - a.d); c.id = c.items[0].i.p.key + ':' + c.items[0].f.i; return c;
  }).filter(c => !S.hiddenClusters.has(c.id)).slice(0, 40);
}
async function crop(p, bbox, size = 72) {
  const [x1, y1, x2, y2] = bbox, w = x2 - x1, h = y2 - y1, m = .25;
  const sx = Math.max(0, x1 - w * m), sy = Math.max(0, y1 - h * m), sw = Math.min(p.w - sx, w * (1 + 2 * m)), sh = Math.min(p.h - sy, h * (1 + 2 * m));
  return createImageBitmap(new Blob([p.bytes]), Math.round(sx), Math.round(sy), Math.max(1, Math.round(sw)), Math.max(1, Math.round(sh)), { resizeWidth: size, resizeHeight: Math.round(size * sh / sw), resizeQuality: 'high' });
}
function paintCrops(root) {
  root.querySelectorAll('canvas[data-crop]').forEach(cv => {
    const [pid, fi] = cv.dataset.crop.split(':').map(Number), p = cur.photos[pid], f = p && p.faces && p.faces[fi]; if (!f) return;
    crop(p, f.bbox, cv.width).then(b => { cv.height = b.height; cv.getContext('2d').drawImage(b, 0, 0); b.close() }).catch(() => { });
  });
}
const datalist = () => `<datalist id="people-dl">${PEOPLE.map(n => `<option value="${esc(n)}">`).join('')}</datalist>`;
let UNKSIG = '';
function drawUnknown(A) {
  const g = $('grid'), sig = [IVER, PVER, A.filter(i => i.p.faces).length, S.hiddenClusters.size].join();
  if (sig === UNKSIG && g.dataset.unk) return;   // nothing new: keep the crops and whatever is being typed
  UNKSIG = sig; g.dataset.unk = '1'; CARDS.clear(); UNK = clusters(A);
  $('count').textContent = UNK.length ? `${UNK.length} grupos de caras sem nome` : '';
  if (!UNK.length) { g.innerHTML = `<div class="opacity-60 col-span-full text-center py-16">${A.some(i => i.c === 'pending') ? 'a aguardar a análise…' : 'Não há caras repetidas por nomear nesta sessão.'}</div>`; return }
  g.innerHTML = datalist() + UNK.map((c, n) => `<div class="card bg-base-100 shadow p-3 gap-2"><div class="flex flex-wrap gap-1">${c.items.slice(0, 8).map(x => `<canvas width="56" height="56" class="rounded" data-crop="${x.i.id}:${x.f.i}"></canvas>`).join('')}</div>
   <div class="text-xs opacity-70">${c.items.length} caras em ${new Set(c.items.map(x => x.i.id)).size} fotos</div>
   <form class="flex gap-1" data-form="unk" data-n="${n}"><input name="who" list="people-dl" required class="input input-bordered input-sm flex-1 min-w-0" placeholder="quem é?" aria-label="Nome desta pessoa"><button class="btn btn-sm btn-primary">Guardar</button></form>
   <button type="button" class="btn btn-xs btn-ghost self-start" data-act="unk-hide" data-n="${n}">ignorar</button></div>`).join('');
  paintCrops(g);
}

/* ---------- lightbox (a <dialog>: focus stays inside, Esc closes) and naming a face ---------- */
let FACE = null, LBSIG = '';
function big(id) { LB = id; FACE = null; lb() }
function closeBig() {
  const was = LB !== null; LB = null; FACE = null; LBSIG = '';
  const d = $('lb'); if (d.open) d.close();
  if (was && S.view === 'session' && cur && FOC != null) focusCard(FOC);
}
function nav(d) { const i = CUR.findIndex(x => x.id === LB), n = CUR[i + d]; if (n) { LB = n.id; FOC = n.id; FACE = null; lb() } }
function lb() {
  const d = $('lb'); if (LB === null) { if (d.open) d.close(); return }
  const k = CUR.findIndex(x => x.id === LB), i = CUR[k] || info(rawOf(LB)), on_ = sel(i);
  const face = FACE != null && i.faces[FACE];
  const sig = [LB, FACE, on_, k, CUR.length, PVER, IVER, i.faces.map(f => f.name + f.score).join()].join('|');
  if (d.open && sig === LBSIG) return;   // a score arriving elsewhere must not wipe what is being typed here
  LBSIG = sig;
  $('lbbody').innerHTML = `<div class="flex flex-col items-center gap-3 max-h-full max-w-full">
   <div class="relative inline-block"><img src="${i.p.url}" alt="" class="block max-h-[66vh] max-w-[92vw] rounded-lg">${svg(i)}</div>
   <div class="flex flex-wrap items-center justify-center gap-2"><button type="button" class="btn btn-sm" data-act="nav" data-d="-1" ${k <= 0 ? 'disabled' : ''} aria-label="Anterior">←</button>${badges(i, 1)}
    <span class="text-sm opacity-70">${k + 1}/${CUR.length}</span>
    <button type="button" class="btn btn-sm ${on_ ? 'btn-success' : 'btn-outline'}" data-act="toggle" data-id="${i.id}">${on_ ? '✓ incluída' : 'incluir'} (espaço)</button>
    <button type="button" class="btn btn-sm" data-act="nav" data-d="1" ${k < 0 || k >= CUR.length - 1 ? 'disabled' : ''} aria-label="Seguinte">→</button><button type="button" class="btn btn-sm btn-ghost" data-act="lbclose">fechar (Esc)</button></div>
   ${i.faces.length ? `<div class="flex flex-wrap items-center justify-center gap-2"><span class="text-xs opacity-70">caras:</span>${i.faces.map(f => `<button type="button" class="rounded-lg border-2 ${FACE === f.i ? 'border-primary' : 'border-transparent'}" data-act="face" data-i="${f.i}" title="${f.name ? esc(f.name) + ' ' + f.score.toFixed(2) : 'sem nome'} · clica para dizer quem é"><canvas width="48" height="48" class="rounded-md block" data-crop="${i.id}:${f.i}"></canvas></button>`).join('')}</div>` : ''}
   ${face ? `<form class="flex flex-wrap items-center justify-center gap-2" data-form="face">${datalist()}<span class="text-sm">Quem é?</span>
     <input name="who" list="people-dl" required class="input input-bordered input-sm w-56" value="${esc(face.name || '')}" aria-label="Nome da pessoa nesta cara">
     <button class="btn btn-sm btn-primary">Guardar como referência</button>
     ${scoresOf(face).slice(0, 3).map(([n, s]) => `<button type="button" class="btn btn-xs btn-ghost" data-act="face-pick" data-n="${esc(n)}">${esc(n)} ${s.toFixed(2)}</button>`).join('')}</form>` : ''}</div>`;
  if (!d.open) d.showModal();
  paintCrops($('lbbody'));
  const who = $('lbbody').querySelector('input[name=who]'); if (who) { who.focus(); who.select() }   // typing replaces the suggested name
}
$('lb').addEventListener('close', () => { if (LB !== null) closeBig() });
$('lb').addEventListener('click', e => { if (e.target === $('lb') || e.target === $('lbbody')) closeBig() });

/* ---------- keyboard ---------- */
const HELP = `<table class="table table-sm"><tbody>
 <tr><td><kbd class="kbd kbd-sm">←</kbd> <kbd class="kbd kbd-sm">→</kbd> <kbd class="kbd kbd-sm">↑</kbd> <kbd class="kbd kbd-sm">↓</kbd></td><td>mudar de foto</td></tr>
 <tr><td><kbd class="kbd kbd-sm">Enter</kbd></td><td>ampliar a foto</td></tr>
 <tr><td><kbd class="kbd kbd-sm">espaço</kbd></td><td>incluir / tirar do download</td></tr>
 <tr><td><kbd class="kbd kbd-sm">P</kbd></td><td>incluir e passar à seguinte</td></tr>
 <tr><td><kbd class="kbd kbd-sm">X</kbd></td><td>deixar de fora e passar à seguinte</td></tr>
 <tr><td><kbd class="kbd kbd-sm">1</kbd>–<kbd class="kbd kbd-sm">4</kbd></td><td>certeza, rever, sem match, caras por nomear</td></tr>
 <tr><td><kbd class="kbd kbd-sm">Esc</kbd></td><td>fechar</td></tr></tbody></table>`;
document.addEventListener('keydown', e => {
  if (e.target.closest && e.target.closest('input,select,textarea') || e.metaKey || e.ctrlKey || e.altKey || $('modal').open) return;
  if (S.view !== 'session' || !cur) return;
  const k = e.key, inLb = LB !== null, id = inLb ? LB : FOC;
  if (k === '?') { popup('Atalhos de teclado', HELP); return }
  if (!inLb && /^[1-4]$/.test(k)) { S.tab = TABS[+k - 1][0]; FOC = null; draw(); return }
  if (S.tab === 'unknown') return;
  const hit = { ArrowLeft: () => inLb ? nav(-1) : moveFocus(-1, 0), ArrowRight: () => inLb ? nav(1) : moveFocus(1, 0), ArrowUp: () => !inLb && moveFocus(0, -1), ArrowDown: () => !inLb && moveFocus(0, 1),
    Enter: () => !inLb && id != null && big(id), ' ': () => id != null && toggle(id), p: () => id != null && decide(id, true), x: () => id != null && decide(id, false) }[k.length === 1 ? k.toLowerCase() : k];
  if (hit) { e.preventDefault(); hit() }
});

/* ---------- download: originals via the extension, then a zip or Google Photos ---------- */
const albumId = u => { try { const x = new URL(u); return x.searchParams.get('set') || x.pathname.replace(/\/$/, '') } catch (e) { return u } };
function download(mode) {
  if (!cur || DL || collecting) return;
  const A = cur.photos.map(info).filter(sel); if (!A.length) return;
  if (!EXT.ok) return popup('Extensão não detetada', 'Os originais vêm do Facebook através da extensão. Instala-a no separador <b>Extensão</b>.');
  if (!EXT.fb) return popup('Abre o álbum no Facebook', `Os originais vêm do álbum aberto no Facebook. Abre-o noutro separador${cur.albumUrl ? ' (botão “álbum no Facebook”)' : ''} e tenta de novo.`);
  if (cur.albumUrl && EXT.fbUrl && albumId(cur.albumUrl) !== albumId(EXT.fbUrl)) {
    if (confirm('O separador do Facebook não está no álbum desta sessão. Abrir lá o álbum agora? Quando carregar, carrega outra vez em descarregar.')) send({ t: 'open', url: cur.albumUrl });
    return;
  }
  if (!cur.date && !confirm('Esta sessão não tem data definida: as fotos ficam sem data no EXIF (o Google Fotos vai usar a data de hoje). Continuar mesmo assim?')) return;
  const tokenP = mode === 'gphotos' ? googleToken() : null;   // asked now, inside the click, so the Google popup is not blocked
  const base = slug(cur.name), names = {};
  A.forEach((i, k) => names[i.p.key] = `${base}_${String(k + 1).padStart(4, '0')}.jpg`);
  DL = { mode, tokenP, n: 0, total: A.length, files: {}, kind: {}, names, base, s: cur, order: A.map(i => i.p.key), date: cur.date, t0: performance.now(), ms: [] };
  if (tokenP) tokenP.catch(e => { if (DL && DL.tokenP === tokenP) { send({ t: 'stop' }); DL = null; badge(); render(); note('Google: ' + e.message, true) } });
  send({ t: 'full', keys: DL.order }); badge(); render();
}
function stopAll() { send({ t: 'stop' }); if (DL) DL.stopping = true; render() }
function onFull(m) {
  if (!DL) return; const p = DL.s.map[m.key], name = DL.names[m.key];
  if (!p || !name || DL.files[name]) return;
  DL.n++;
  if (m.b64) { DL.files[name] = b64(m.b64); DL.kind[m.key] = `original ${m.w}x${m.h}` }
  else { DL.files[name] = p.bytes; DL.kind[m.key] = 'miniatura (' + (m.error || 'sem original') + ')' }
  if (m.ms) DL.ms.push({ ficheiro: name, ...m.ms });
  render(); tryFinish();
}
function tryFinish() { if (DL && DL.done && DL.n >= DL.processed) finishDL() }
function exifDate(key) {   // album date + the photo's position in the album as seconds, so Google Photos keeps the album order
  if (!DL.date) return null; const d = new Date(DL.date); d.setSeconds(d.getSeconds() + Math.max(0, DL.order.indexOf(key))); return d;
}
async function finishDL() {
  if (!DL || DL.finishing) return;
  const D = DL; D.finishing = true; render(); await sleep(30);
  const files = {}, mt = {}, people = key => info(D.s.map[key]).faces.filter(f => f.c !== 'sem match').map(f => `${f.name} ${f.score.toFixed(2)}`).join('; ');
  const rows = [['ficheiro', 'original_facebook', 'data_exif', 'pessoas', 'tipo']];
  for (const key of D.order) {
    const nm = D.names[key], d = exifDate(key);
    let data = D.files[nm]; if (!data) { data = D.s.map[key].bytes; D.kind[key] = 'miniatura (não obtida)' }
    files[nm] = d ? setExif(data, d) : data; if (d) mt[nm] = d;
    rows.push([nm, key, d ? localISO(d).replace('T', ' ') : '', people(key), D.kind[key]]);
  }
  if (D.ms.length) console.table(D.ms);   // timings per photo, for tuning the extension
  const orig = rows.filter(r => /^original/.test(r[4])).length, thumbs = rows.length - 1 - orig, wall = (performance.now() - D.t0) / 1000;
  const summary = nf(orig, 'original', 'originais') + (thumbs ? ` e ${nf(thumbs, 'miniatura', 'miniaturas')}` : '');
  try {
    if (D.mode === 'gphotos') {
      DL = null; GP = { title: 'A enviar para o Google Photos…', n: 0, total: D.order.length }; render();
      const r = await uploadGoogle(D, files);
      doneInfo = { title: `${nf(r.ok, 'foto enviada', 'fotos enviadas')} para o Google Photos`, sub: `álbum “${D.s.name}” · ${summary}` + (r.failed ? ` · ${r.failed} falharam` : '') };
      if (r.failed) note(`${nf(r.failed, 'foto não foi aceite', 'fotos não foram aceites')} pelo Google Photos: ${r.firstError}`, true);
    } else {
      files['_resumo.csv'] = new TextEncoder().encode(rows.map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\n'));
      const zip = fflate.zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, [v, mt[k] ? { level: 0, mtime: mt[k] } : { level: 0 }]])));
      saveBlob(D.base + '.zip', new Blob([zip], { type: 'application/zip' }));
      doneInfo = { title: `Zip pronto: ${nf(rows.length - 1, 'foto', 'fotos')}`, sub: `${summary} em ${fmtT(wall)} · o download começou` };
      if (thumbs) note(`${thumbs === 1 ? '1 foto foi' : thumbs + ' fotos foram'} no tamanho da miniatura porque o original não foi obtido (vê a coluna “tipo” em _resumo.csv).`, true);
    }
    doneUntil = Date.now() + 9000;
  } catch (e) { note((D.mode === 'gphotos' ? 'Google Photos: ' : '') + (e.message || e), true) }
  finally { if (DL === D) DL = null; GP = null; badge(); if (cur === D.s && S.view === 'session') draw(); updateProg() }
}

/* ---------- Google Photos (optional: TAGGED_GOOGLE_CLIENT_ID): GIS token in the browser, calls proxied by the server ---------- */
let gtoken = null;
function loadGsi() { if (!CFG.googleClientId || $('gsi')) return; const s = document.createElement('script'); s.id = 'gsi'; s.src = 'https://accounts.google.com/gsi/client'; s.async = true; document.head.append(s) }
function googleToken() {
  if (gtoken && gtoken.exp > Date.now() + 120000) return Promise.resolve(gtoken.t);
  return new Promise((res, rej) => {
    if (!window.google?.accounts?.oauth2) return rej(new Error('o script da Google ainda não carregou; tenta outra vez dentro de uns segundos'));
    google.accounts.oauth2.initTokenClient({
      client_id: CFG.googleClientId, scope: 'https://www.googleapis.com/auth/photoslibrary.appendonly',
      callback: r => r.error ? rej(new Error(r.error_description || r.error)) : (gtoken = { t: r.access_token, exp: Date.now() + r.expires_in * 1000 }, res(r.access_token)),
      error_callback: e => rej(new Error(e.type === 'popup_closed' ? 'janela da Google fechada' : e.message || e.type)),
    }).requestAccessToken();
  });
}
async function gcall(path, token, body, headers) {
  const r = await fetch('/api/gphotos/' + path, { method: 'POST', headers: { 'X-Google-Token': token, ...headers }, body });
  if (!r.ok) { const t = await r.text(); let m = t; try { m = JSON.parse(t).error.message || t } catch (e) { } throw new Error(`${r.status} ${m}`.slice(0, 300)) }
  return r;
}
async function uploadGoogle(D, files) {
  const token = await D.tokenP, json = { 'Content-Type': 'application/json' };
  const album = await (await gcall('albums', token, JSON.stringify({ album: { title: D.s.name } }), json)).json();
  const items = [];
  for (const key of D.order) {
    const nm = D.names[key];
    const r = await gcall('uploads', token, files[nm], { 'Content-Type': 'application/octet-stream', 'X-Goog-Upload-Content-Type': 'image/jpeg', 'X-Goog-Upload-Protocol': 'raw' });
    items.push({ simpleMediaItem: { uploadToken: await r.text(), fileName: nm } }); GP.n++; updateProg();
  }
  GP.title = 'A juntar as fotos ao álbum…'; updateProg();
  let ok = 0, failed = 0, firstError = '';
  for (let k = 0; k < items.length; k += 50) {   // the API takes at most 50 per call
    const d = await (await gcall('mediaItems:batchCreate', token, JSON.stringify({ albumId: album.id, newMediaItems: items.slice(k, k + 50) }), json)).json();
    for (const x of d.newMediaItemResults || []) { if (x.mediaItem) ok++; else { failed++; firstError ||= x.status && x.status.message || '' } }
  }
  return { ok, failed, firstError };
}

/* ---------- extension: download + install steps ---------- */
function viewExtension() {
  const o = location.origin;
  $('view').innerHTML = `<div class="card bg-base-100 shadow"><div class="card-body gap-3"><h2 class="card-title">Extensão para Chrome</h2>
  <p class="text-sm opacity-70">A extensão é a ponte entre o álbum do Facebook e esta webapp. Já vem configurada para <b>${esc(o)}</b>: descarrega-a daqui, não de outro sítio.</p>
  <div><a class="btn btn-primary" href="/extension.zip" download>Descarregar extensão (zip)</a> <span class="text-sm opacity-70 ml-2">versão ${esc(CFG.extension || '?')}${EXT.ok ? ` · instalada: ${esc(EXT.v)}` : ''}</span></div>
  <ol class="list-decimal ml-6 space-y-1 text-sm"><li>Descomprime o zip. Fica uma pasta <code>tagged-extension</code>.</li>
   <li>No Chrome abre <code>chrome://extensions</code> e liga o <b>Modo de programador</b> (canto superior direito).</li>
   <li>Carrega em <b>Carregar sem compactar</b> e escolhe a pasta <code>tagged-extension</code>.</li>
   <li>Volta a esta página e recarrega-a (F5): o selo no topo passa a “extensão ligada”.</li>
   <li>Quando houver uma versão nova (o selo avisa), descarrega-a outra vez, substitui a pasta e carrega no botão de recarregar da extensão em <code>chrome://extensions</code>.</li></ol>
  <p class="text-xs opacity-70">Só funciona no Chrome (ou Edge/Brave) no computador, porque o telemóvel não suporta extensões desta forma.</p></div></div>`;
}

/* ---------- settings: people, storage ---------- */
function viewSettings() {
  $('view').innerHTML = `<div class="card bg-base-100 shadow mb-4" id="drop"><div class="card-body gap-3"><h2 class="card-title">Carregar pessoas</h2>
  <p class="text-sm opacity-70">Escolhe o ficheiro com as pessoas (<code>people.npz</code>, gerado com <code>tagged people-pack</code> ou pelo botão Export do rotulador). Fica guardado só neste browser: o servidor nunca o recebe, e não precisas de o voltar a carregar. Também aceito um <code>.zip</code> da pasta <code>data/refs</code>, vários <code>.npy</code> (um por pessoa, com o nome da pessoa) ou a própria pasta <code>refs</code>. Podes largar os ficheiros aqui.</p>
  <div class="flex flex-wrap gap-2 items-center"><label class="btn btn-primary btn-sm">Escolher ficheiro(s)<input type="file" class="hidden" multiple accept=".npz,.npy,.zip" data-chg="files"></label>
   <label class="btn btn-sm">Escolher pasta refs<input type="file" class="hidden" webkitdirectory data-chg="files"></label>
   <button type="button" class="btn btn-sm" data-act="people-export" ${PEOPLE.length ? '' : 'disabled'} title="Guarda as pessoas (incluindo as caras que nomeaste aqui) num people.npz, para usar noutro browser">exportar people.npz</button>
   <button type="button" class="btn btn-sm btn-ghost" data-act="people-clear" ${PEOPLE.length ? '' : 'disabled'}>remover todas</button><span id="pmsg" class="text-sm"></span></div></div></div>
  <div class="card bg-base-100 shadow mb-4"><div class="card-body gap-3"><h2 class="card-title">Pessoas a reconhecer</h2>
  <p class="text-sm opacity-70">Só as pessoas ativas contam para <b>certeza</b> e <b>rever</b>. As outras são ignoradas (não precisas de voltar a recolher: muda aqui e as sessões atualizam-se). O número é o de caras de referência; as que nomeaste na webapp podem ser desfeitas.</p>
  <div class="flex flex-wrap gap-2 items-center"><input id="psearch" class="input input-bordered input-sm" placeholder="procurar…" aria-label="Procurar pessoas" data-inp="psearch" value="${esc(S.search)}">
   <button type="button" class="btn btn-sm" data-act="all" data-v="1">todas</button><button type="button" class="btn btn-sm" data-act="all" data-v="0">nenhuma</button><span id="pcount" class="text-sm opacity-70"></span></div>
  <div id="plist" class="grid sm:grid-cols-2 lg:grid-cols-4 gap-1"></div></div></div>
  <div class="card bg-base-100 shadow"><div class="card-body gap-2"><h2 class="card-title">Armazenamento</h2><p id="storage" class="text-sm opacity-70">…</p></div></div>`;
  const dz = $('drop'); dz.addEventListener('dragover', e => e.preventDefault()); dz.addEventListener('drop', e => { e.preventDefault(); loadPeopleFiles(e.dataTransfer.files) });
  renderPeople(); renderStorage();
}
async function renderStorage() {
  const e = $('storage'); if (!e) return;
  try {
    const [est, per] = await Promise.all([navigator.storage.estimate(), navigator.storage.persisted()]);
    e.innerHTML = `As sessões e as pessoas ocupam ${(est.usage / 2 ** 20).toFixed(0)} MB neste browser. ` + (per ? 'Armazenamento <b>persistente</b>: o Chrome não o apaga sozinho.'
      : `O Chrome pode apagá-lo se o disco ficar cheio. <button type="button" class="btn btn-xs" data-act="persist">Pedir armazenamento persistente</button>`);
  } catch (err) { e.textContent = 'Sem informação de armazenamento.' }
}
function renderPeople() {
  const q = S.search.toLowerCase();
  $('pcount').textContent = `${PEOPLE.filter(on).length} de ${PEOPLE.length} ativas`;
  $('plist').innerHTML = PEOPLE.length ? PEOPLE.filter(n => n.toLowerCase().includes(q)).map(n => `<div class="flex items-center gap-1 rounded-lg hover:bg-base-200 px-2"><label class="label cursor-pointer justify-start gap-3 flex-1"><input type="checkbox" class="toggle toggle-success toggle-sm" ${on(n) ? 'checked' : ''} data-chg="person-on" data-n="${esc(n)}"><span class="label-text">${esc(n)} <span class="opacity-60 text-xs">${PE[n].k}${PE[n].added ? ` (+${PE[n].added} aqui)` : ''}</span></span></label>${PE[n].added ? `<button type="button" class="btn btn-ghost btn-xs" title="desfazer as ${PE[n].added} caras adicionadas aqui" data-act="people-undo" data-n="${esc(n)}">↶</button>` : ''}<button type="button" class="btn btn-ghost btn-xs" title="remover" aria-label="remover ${esc(n)}" data-act="people-del" data-n="${esc(n)}">✕</button></div>`).join('') : '<div class="opacity-70 text-sm col-span-full">Ainda não há pessoas carregadas.</div>';
}
const offChanged = () => { saveCfg(); IVER++; if (cur) touch(cur); renderPeople() };
function setPerson(n, v) { v ? cfg.off.delete(n) : cfg.off.add(n); offChanged() }
function setAll(v) { const q = S.search.toLowerCase(); PEOPLE.filter(n => n.toLowerCase().includes(q)).forEach(n => v ? cfg.off.delete(n) : cfg.off.add(n)); offChanged() }

/* ---------- events: one delegated listener per kind ---------- */
document.addEventListener('click', e => {
  const t = e.target.closest('[data-act]'); if (!t || t.disabled) return;
  const id = t.dataset.id != null ? +t.dataset.id : null, a = t.dataset.act;
  if (a === 'toggle') e.preventDefault();
  ({
    view: () => setView(t.dataset.v), collect, open: () => openSessionById(id), del: () => delSession(id), dl: () => download(t.dataset.mode), stop: stopAll,
    tab: () => { S.tab = t.dataset.v; FOC = null; draw() }, bulk: () => bulk(t.dataset.v === '1'), toggle: () => toggle(id), big: () => { FOC = id; big(id) },
    nav: () => nav(+t.dataset.d), lbclose: closeBig, face: () => { FACE = +t.dataset.i; lb() }, 'face-pick': () => nameFace(t.dataset.n),
    retry: retryErrors, help: () => popup('Atalhos de teclado', HELP), 'note-close': () => note(''), 'th-reset': () => { delete cfg.certain; delete cfg.review; saveCfg(); IVER++; viewSession(); touch(cur) },
    'open-album': () => EXT.ok ? send({ t: 'open', url: cur.albumUrl }) : window.open(cur.albumUrl, '_blank', 'noopener'),
    'unk-hide': () => { S.hiddenClusters.add(UNK[+t.dataset.n].id); draw() },
    'people-clear': clearPeople, 'people-del': () => delPerson(t.dataset.n), 'people-undo': () => undoAdded(t.dataset.n), 'people-export': exportPeople,
    all: () => setAll(t.dataset.v === '1'), persist: async () => { await persistStorage(); renderStorage() },
  }[a] || (() => { }))();
});
document.addEventListener('change', e => {
  const t = e.target, c = t.dataset && t.dataset.chg; if (!c) return;
  if (c === 'title') { cur.name = t.value.trim() || 'Sessão'; cur.auto = false; touch(cur) }
  else if (c === 'date') { cur.date = t.value || null; cur.dateManual = !!t.value; if (!t.value) autoDate(cur); t.classList.toggle('input-warning', !cur.date); touch(cur) }
  else if (c === 'person') { S.person = t.value; draw() }
  else if (c === 'unrev') { S.onlyUnrev = t.checked; draw() }
  else if (c === 'files') { loadPeopleFiles(t.files); t.value = '' }
  else if (c === 'person-on') setPerson(t.dataset.n, t.checked);
});
document.addEventListener('input', e => {
  const c = e.target.dataset && e.target.dataset.inp; if (!c) return;
  if (c === 'certain' || c === 'review') onThreshold(c, +e.target.value);
  else if (c === 'psearch') { S.search = e.target.value; renderPeople() }
});
function nameFace(who) {
  const i = info(rawOf(LB)), f = FACE != null && i.faces[FACE]; if (!f || !f.emb) return;
  addRefs(who, [f.emb]).then(() => { FACE = null; lb() });
}
document.addEventListener('submit', e => {
  const f = e.target, kind = f.dataset && f.dataset.form; if (!kind) return;
  e.preventDefault(); const who = f.elements.who.value.trim(); if (!who) return;
  if (kind === 'face') nameFace(who);
  else if (kind === 'unk') { const c = UNK[+f.dataset.n]; addRefs(who, c.items.slice(0, 5).map(x => x.f.emb)) }   // the 5 faces closest to the group's centre
});

/* ---------- start ---------- */
(async () => {
  try { Object.assign(CFG, await (await fetch('/api/config')).json()) } catch (e) { }
  loadGsi(); badge(); pollModel();
  try {
    db = await dbOpen(); SESS = await idb('meta', 'readonly', st => st.getAll()) || [];
    for (const p of await idb('people', 'readonly', st => st.getAll()) || []) PE[p.name] = { a: p.a, k: p.k, added: p.added || 0 };
    PEOPLE = Object.keys(PE).sort((a, b) => a.localeCompare(b, 'pt')); PVER++;
  } catch (e) { note('Sem armazenamento local: as sessões não serão guardadas.', true) }
  setView('sessions');
})();
