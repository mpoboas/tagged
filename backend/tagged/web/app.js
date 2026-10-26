// tagged webapp. Photos arrive from the browser extension into a session, the API returns each face's embedding,
// this page matches them against the people kept in IndexedDB, the user reviews, and the originals leave as a zip
// (<session>_0001.jpg…) or go straight to Google Photos. No inline handlers: everything goes through data-act.
'use strict';

const EXT_MIN = '0.7.0';
const COL = { certeza: '#22c55e', rever: '#f59e0b', 'sem match': '#64748b', erro: '#ef4444' };
const TABS = [['certeza', 'Reconhecidas'], ['rever', 'Para confirmar'], ['sem match', 'Outras'], ['unknown', 'Caras novas']];
const HINT = {
  certeza: 'Fotos onde reconheci pelo menos um dos teus amigos. Já estão marcadas para descarregar: tira o visto às que não queiras.',
  rever: 'Não tenho a certeza de quem é. Abre a foto e decide: incluir (P) ou deixar de fora (X).',
  'sem match': 'Fotos onde não reconheci ninguém que conheça. Se estiver alguém que queiras, marca-a à mão.',
  unknown: 'Caras que se repetem nas fotos e que ainda não sei quem são. Diz-me o nome para as passar a reconhecer.',
};
const CFG = { certain: .5, review: .35, minDet: .6, minFace: 20, extension: null, googleClientId: null };
const S = { tab: 'certeza', person: '', view: 'sessions', search: '', onlyUnrev: false, hiddenClusters: new Set() };
let SESS = [], cur = null, LIVE = null, PEOPLE = [], PE = {}, PVER = 0, IVER = 0, CUR = [], LB = null, FOC = null, DL = null, GP = null;
let collecting = false, CT0 = 0, SC = { t0: 0, n: 0 }, lastCollectMsg = 0, MODEL = 'loading', MODEL_ERR = null;
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
const fmtDay = t => new Date(t).toLocaleDateString('pt-PT', { day: 'numeric', month: 'short', year: 'numeric' });
// ' · 1.4 s por foto · faltam cerca de 2 min' for any process that has done n items since t0 (performance.now()) with `left` to go.
const pace = (t0, n, left) => { if (!t0 || n < 1) return ''; const per = (performance.now() - t0) / n / 1000;
  return ` · ${per < 10 ? per.toFixed(1) : Math.round(per)} s por foto` + (n > 1 && left > 0 ? ` · faltam cerca de ${fmtT(per * left)}` : '') };
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
  if (GP) return showProg({ icon: '☁️', title: GP.title, sub: GP.total ? `Foto ${Math.min(GP.n + 1, GP.total)} de ${GP.total}` + pace(GP.t0, GP.n, GP.total - GP.n) : '', pct: GP.total ? 100 * GP.n / GP.total : null });
  if (DL) {
    const n = DL.n, t = DL.total;
    if (DL.finishing) return showProg({ icon: '🗜️', title: 'A preparar as fotos…', sub: 'A juntar as fotos e a escrever a data em cada uma.', pct: 100 });
    return showProg({ icon: '📸', title: DL.stopping ? 'A parar…' : 'A buscar as fotos em boa qualidade', btn: DL.stopping ? null : ['stop', 'Parar'],
      sub: `Foto ${Math.min(n + 1, t)} de ${t}` + pace(DL.t0, n, t - n) + ' · deixa o Chrome aberto', pct: 100 * n / t });
  }
  if (collecting) {
    const n = LIVE ? LIVE.photos.length : 0, x = LIVE && LIVE.expected;
    return showProg({ icon: '📥', title: 'A importar o álbum do Facebook…', btn: ['stop', 'Parar'],
      sub: `${n} fotos encontradas` + (x ? ` de ${x}` : '') + pace(CT0, n, x ? x - n : 0) + ' · o Tagged vai fazendo scroll no álbum por ti', pct: x ? Math.min(100, 100 * n / x) : null });
  }
  if (MODEL === 'error') return showProg({ icon: '⚠️', title: 'O reconhecimento facial não arrancou', sub: MODEL_ERR || '', tone: 'error' });
  const S_ = LIVE || cur;
  const pend = S_ ? S_.photos.filter(p => !p.faces && !p.err).length : 0;
  if (pend && MODEL !== 'ready') return showProg({ icon: '⏳', title: MODEL === 'offline' ? 'Sem ligação ao servidor' : 'A preparar o reconhecimento facial…',
    sub: MODEL === 'offline' ? 'A tentar de novo…' : 'Na primeira vez o Tagged descarrega o que precisa (~280 MB); demora um ou dois minutos.', pct: null });
  if (pend) { const tot = S_.photos.length, k = tot - pend; return showProg({ icon: '🔍', title: 'A reconhecer quem está nas fotos…', sub: `${k} de ${tot} fotos analisadas` + pace(SC.t0, SC.n, pend), pct: 100 * k / tot }) }
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
const rec = (s, p) => ({ sid: s.id, key: p.key, href: p.href || null, idx: p.id, bytes: p.bytes, w: p.w, h: p.h, sel: p.sel, rev: p.rev, err: p.err || null, dup: p.dup || null,
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
  const dot = $('extdot'), txt = $('exttext'), btn = $('ext'); let t, c, tip;
  if (!EXT.ok) { t = 'Ligar ao Facebook'; c = 'bg-warning'; tip = 'Ainda não está ligado ao Facebook. Carrega para ver como se faz.' }
  else if (vcmp(EXT.v, EXT_MIN) < 0) { t = 'Atualizar a ligação'; c = 'bg-error'; tip = `A ligação ao Facebook é antiga (${EXT.v || '?'}). Carrega para a atualizar.` }
  else if (CFG.extension && vcmp(EXT.v, CFG.extension) < 0) { t = 'Facebook ligado · há atualização'; c = 'bg-warning'; tip = `Há uma versão nova (${CFG.extension}). Carrega para a instalar.` }
  else if (EXT.fb) { t = 'Facebook ligado'; c = 'bg-success'; tip = 'Tudo pronto: há um separador do Facebook aberto.' }
  else { t = 'Facebook ligado · abre um álbum'; c = 'bg-info'; tip = 'Abre um álbum do Facebook noutro separador para o poderes importar.' }
  if (txt) txt.textContent = t; if (dot) dot.className = 'inline-block w-2.5 h-2.5 rounded-full ' + c; if (btn) btn.title = tip;
  document.querySelectorAll('[data-act=collect]').forEach(b => { b.disabled = collecting || !!DL });
}
function onExt(m) {
  if (m.t === 'ready') {
    const was = EXT.ok + ':' + EXT.fb; EXT = { ok: true, v: m.v, fb: !!m.fb, fbUrl: m.fbUrl || null, seen: Date.now() }; badge();
    try { localStorage.setItem('tagged.extSeen', '1') } catch (e) { }
    if (S.view === 'setup' && ONB.page !== 'welcome' && was !== EXT.ok + ':' + EXT.fb) renderSetup();   // the wizard reacts as soon as the connection appears
    return
  }
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
setInterval(() => { send({ t: 'hello' }); if (EXT.ok && Date.now() - EXT.seen > 8000) { EXT.ok = false; badge(); if (S.view === 'setup' && ONB.page !== 'welcome') renderSetup() } }, 2500);
send({ t: 'hello' });

/* ---------- sessions: every collection is a new one ---------- */
function collect() {
  if (collecting || DL) return;
  if (!EXT.ok) return popup('Primeiro liga o Tagged ao Facebook', '<p>Para importar um álbum, o Tagged precisa de uma pequena ligação ao Facebook no teu Chrome. Só se faz uma vez e demora um minuto.</p><div class="mt-3"><button type="button" class="btn btn-primary btn-sm" data-act="goto" data-v="extension">Mostrar como se faz</button></div>');
  if (vcmp(EXT.v, EXT_MIN) < 0) return popup('Falta atualizar a ligação ao Facebook', '<p>A ligação que tens instalada é antiga. Atualiza-a e tenta outra vez.</p><div class="mt-3"><button type="button" class="btn btn-primary btn-sm" data-act="goto" data-v="extension">Mostrar como se faz</button></div>');
  if (!EXT.fb) return popup('Abre o álbum no Facebook', '<ol class="list-decimal ml-5 space-y-1"><li>Noutro separador do Chrome, abre o <b>álbum</b> no Facebook (a página com a grelha de fotos).</li><li>Volta aqui e carrega outra vez em <b>Importar álbum</b>.</li></ol><p class="mt-2 text-sm opacity-70">Não precisas de fazer scroll: o Tagged percorre o álbum por ti.</p>');
  const s = { id: Date.now(), name: 'A recolher…', created: Date.now(), expected: null, auto: true, photos: [], map: {}, albumUrl: EXT.fbUrl };
  LIVE = s; collecting = true; CT0 = performance.now(); lastCollectMsg = Date.now(); badge(); openSession(s); note(''); updateProg();
  send({ t: 'collect', reset: true }); persistStorage();
}
setInterval(() => { if (collecting && Date.now() - lastCollectMsg > 20000) collectFailed('O Tagged deixou de receber fotos do Facebook. Recarrega o separador do Facebook (F5) e tenta outra vez.') }, 2000);
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
  if (m.stopped) note(`Importação parada: ${m.count} fotos.`);
  else if (m.expected && m.count < m.expected) popup('Faltam fotos do álbum', `<p>Só consegui importar ${m.count} de ${m.expected} fotos: faltam ${m.expected - m.count}.</p><p class="mt-2 opacity-70">Às vezes o Facebook conta vídeos ou fotos a que não tens acesso. Se faltarem muitas, recarrega o álbum no Facebook e carrega de novo em “Importar álbum” (cria um álbum novo).</p>`);
  else note(`Álbum importado: ${m.count} fotos` + (m.expected ? ` (o álbum tem ${m.expected}).` : '.'));
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
  if (DL && DL.s.id === id) return note('Este álbum está a ser descarregado. Pára primeiro.', true);
  if (!confirm('Eliminar este álbum do Tagged? (Não apaga nada do Facebook.)')) return;
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
  const p = { id: s.photos.length, key: m.key, href: m.href || null, bytes, url: URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' })), faces: null, w: 0, h: 0 };
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
    running++; if (!SC.t0) SC.t0 = performance.now();
    fetch('/api/score?name=' + encodeURIComponent(p.key), { method: 'POST', body: new Blob([p.bytes]) })
      .then(async r => {
        const d = await r.json().catch(() => ({ error: 'HTTP ' + r.status }));
        if (r.status === 503) { queue.unshift({ s, p }); MODEL = d.model || 'loading'; MODEL_ERR = d.error; pollModel(); return }
        if (!r.ok) throw Object.assign(new Error(d.error || 'HTTP ' + r.status), { perm: r.status === 400 || r.status === 413 });
        p.faces = d.faces.map(f => ({ bbox: f.bbox, det: f.det, emb: Float32Array.from(f.emb) })); p.w = d.w; p.h = d.h; p.err = null; p.tries = 0; p._i = null; SC.n++;
      })
      .catch(e => {
        p.tries = (p.tries || 0) + 1;
        if (!e.perm && p.tries < 3) { setTimeout(() => enqueue(s, p), 1500 * 2 ** p.tries); return }
        p.err = String(e.message || e); p.perm = !!e.perm; p._i = null;
      })
      .finally(() => { running--; if (!running && !queue.length) SC = { t0: 0, n: 0 }; touch(s, p); pump(); if (cur === s || LIVE === s) render() });
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
  const m = $('pmsg') || document.createElement('span'); m.className = 'text-sm'; m.textContent = 'A ler ' + files.length + ' ficheiros…'; const found = {}, errs = [];
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
  peopleChanged(); persistStorage();
  if (S.view === 'setup') { W.err = names.length ? '' : 'Nada carregado: ' + (errs[0] || 'não encontrei ficheiros .npy'); if (names.length) { W.step = 'done'; W.how = 'file'; W.count = names.length; localStorage.setItem('tagged.setup', '1') } return renderSetup() }
  viewSettings();
  const mm = $('pmsg'); if (mm) {
    mm.className = 'text-sm ' + (errs.length && !names.length ? 'text-error' : 'text-success');
    mm.textContent = names.length ? `${names.length} pessoas carregadas (${names.reduce((s, n) => s + found[n].k, 0)} caras de referência).` + (errs.length ? ` ${errs.length} ficheiros ignorados: ${errs[0]}` : '') : 'Nada carregado: ' + (errs[0] || 'sem ficheiros .npy');
  }
}
// Faces named in the webapp become extra references for that person (appended at the end, so they can be undone).
async function addRefs(name, embs, initial) {
  name = name.trim(); if (!name || !embs.length) return;
  const old = PE[name], k0 = old ? old.k : 0, a = new Float32Array((k0 + embs.length) * 512);
  if (old) a.set(old.a);
  embs.forEach((e, j) => a.set(unit(e), (k0 + j) * 512));
  PE[name] = { a, k: k0 + embs.length, added: (old && old.added || 0) + (initial ? 0 : embs.length) };
  await idb('people', 'readwrite', st => st.put({ name, ...PE[name] }));
  if (cfg.off.delete(name)) saveCfg();
  peopleChanged(); persistStorage();
  if (initial) return;
  note(`${embs.length === 1 ? 'Guardei esta cara' : 'Guardei ' + embs.length + ' caras'} como exemplo de ${name}. Os álbuns já foram atualizados.`);
}
async function undoAdded(n) {
  const p = PE[n]; if (!p || !p.added) return;
  const k = p.k - p.added;
  if (!k) { await delPerson(n); return }
  PE[n] = { a: p.a.slice(0, k * 512), k, added: 0 };
  await idb('people', 'readwrite', st => st.put({ name: n, ...PE[n] })); peopleChanged(); renderPeople();
}
async function clearPeople() { if (!confirm('Apagar todas as pessoas deste browser? Os álbuns ficam, mas deixam de reconhecer alguém.')) return; await idb('people', 'readwrite', st => st.clear()); PE = {}; peopleChanged(); viewSettings() }
async function delPerson(n) { if (!confirm(`Apagar ${n}? Deixa de ser reconhecida nas fotos.`)) return; await idb('people', 'readwrite', st => st.delete(n)); delete PE[n]; peopleChanged(); renderPeople() }
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
const NAV = [['sessions', 'Álbuns'], ['settings', 'Pessoas'], ['search', 'Procurar'], ['extension', 'Ajuda']];
function setView(v) {
  S.view = v; closeBig(); if (v !== 'search') qRevoke(); if (v !== 'setup' && W.step === 'process') { W.run++; W.step = 'ready' }
  const lit = v === 'session' ? 'sessions' : v, nav = $('nav');
  if (!nav.firstChild) nav.innerHTML = NAV.map(([k, l]) => `<button type="button" class="btn btn-sm shrink-0" data-act="view" data-v="${k}">${l}</button>`).join('');
  nav.querySelectorAll('button').forEach(b => {   // update in place: no flicker, and keyboard focus stays where it was
    const on_ = b.dataset.v === lit; b.classList.toggle('btn-primary', on_); b.classList.toggle('btn-ghost', !on_);
    if (on_) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  window.scrollTo(0, 0);
  if (v === 'sessions') viewSessions(); else if (v === 'session') viewSession(); else if (v === 'extension') viewExtension(); else if (v === 'search') viewSearch(); else if (v === 'setup') renderSetup(); else viewSettings();
}
const seenExt = () => { try { return !!localStorage.getItem('tagged.extSeen') } catch (e) { return false } };
const setupSteps = () => [
  { id: 'people', done: PEOPLE.length > 0, title: 'Diz ao Tagged quem são os teus amigos', hint: 'Escolhe fotos onde eles apareçam, ou carrega um ficheiro que já tenhas.', go: 'Configurar pessoas' },
  { id: 'ext', done: EXT.ok || seenExt(), title: 'Liga o Tagged ao Facebook', hint: 'Uma pequena instalação no Chrome. Só se faz uma vez.', go: 'Ligar ao Facebook' },
  { id: 'album', done: SESS.length > 0, title: 'Importa o teu primeiro álbum', hint: 'Abres um álbum no Facebook e o Tagged trata do resto.', go: 'Importar álbum' },
];
// the people are the one thing nothing works without, so every screen that needs them says so in one friendly line
const noPeople = () => PEOPLE.length ? '' : `<div class="alert alert-warning mb-4 text-sm"><span>O Tagged ainda não conhece os teus amigos, por isso não consegue reconhecer ninguém nas fotos.</span><button type="button" class="btn btn-sm" data-act="onb" data-v="people">Adicionar pessoas</button></div>`;
function checklist() {
  const st = setupSteps(); if (st.every(x => x.done)) return '';
  const n = st.filter(x => x.done).length, next = st.find(x => !x.done);
  return `<section class="card bg-base-100 shadow border border-primary/30 mb-6" aria-labelledby="ck"><div class="card-body gap-3">
   <div class="flex items-center gap-3"><h2 id="ck" class="card-title flex-1">Primeiros passos</h2><span class="text-sm opacity-70">${n} de ${st.length}</span></div>
   <progress class="progress progress-primary w-full" value="${n}" max="${st.length}" aria-label="Progresso dos primeiros passos"></progress>
   <ol class="space-y-2">${st.map((x, i) => `<li class="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg p-2 ${x === next ? 'bg-base-200' : ''}">
     <span class="w-7 h-7 shrink-0 rounded-full flex items-center justify-center text-sm font-bold ${x.done ? 'bg-success text-success-content' : x === next ? 'bg-primary text-primary-content' : 'bg-base-300'}" aria-hidden="true">${x.done ? '✓' : i + 1}</span>
     <div class="flex-1 min-w-[12rem]"><div class="font-medium ${x.done ? 'line-through opacity-60' : ''}">${x.title}</div>${x.done ? '' : `<div class="text-sm opacity-70">${x.hint}</div>`}</div>
     ${x.done ? '<span class="sr-only">feito</span>' : `<button type="button" class="btn btn-sm max-sm:ml-10 ${x === next ? 'btn-primary' : 'btn-ghost'}" data-act="onb" data-v="${x.id}">${x.go}</button>`}</li>`).join('')}</ol></div></section>`;
}
let covers = [];
function viewSessions() {
  covers.forEach(u => URL.revokeObjectURL(u)); covers = [];
  const L = SESS.slice().sort((a, b) => b.created - a.created);
  $('view').innerHTML = `<div class="flex flex-wrap items-end gap-3 mb-6"><div class="flex-1 min-w-[16rem]"><h1 class="text-2xl font-bold">Os meus álbuns</h1>
   <p class="text-sm opacity-70">Importa um álbum do Facebook, vê onde estão os teus amigos e descarrega só essas fotos.</p></div>
   <button type="button" class="btn btn-primary" data-act="collect" ${collecting || DL ? 'disabled' : ''}>＋ Importar álbum do Facebook</button></div>
   ${checklist()}
   ${L.length ? `<div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">${L.map(s => `<article class="card bg-base-100 shadow overflow-hidden transition hover:shadow-lg">
    <button type="button" class="text-left block w-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" data-act="open" data-id="${s.id}" aria-label="Abrir o álbum ${esc(s.name)}">
     <figure class="h-44 bg-base-300">${s.cover ? `<img data-cover="${s.id}" alt="" class="w-full h-full object-cover">` : ''}</figure>
     <div class="card-body p-4 gap-1"><h3 class="card-title text-base leading-snug">${esc(s.name)}</h3>
      <div class="text-xs opacity-60">${fmtDay(s.date || s.created)} · ${nf(s.count, 'foto', 'fotos')}${s.expected && s.expected > s.count ? ` de ${s.expected}` : ''}</div>
      <div class="flex flex-wrap gap-x-3 gap-y-1 text-sm mt-1">${s.certeza ? `<span style="color:${COL.certeza}">● ${nf(s.certeza, 'reconhecida', 'reconhecidas')}</span>` : '<span class="opacity-60">nenhum amigo reconhecido</span>'}${s.sel ? `<span class="opacity-80">${s.sel} para descarregar</span>` : ''}</div></div></button>
    <div class="px-3 pb-2 flex justify-end"><button type="button" class="btn btn-ghost btn-xs" data-act="del" data-id="${s.id}" aria-label="Eliminar o álbum ${esc(s.name)}">Eliminar</button></div></article>`).join('')}</div>`
    : (setupSteps().every(x => x.done) ? `<div class="text-center py-16 opacity-80 space-y-2"><div class="text-4xl" aria-hidden="true">🖼️</div><p class="text-lg">Ainda não importaste nenhum álbum.</p><p class="text-sm">Abre um álbum no Facebook e carrega em “Importar álbum do Facebook”.</p></div>` : '')}`;
  if (db) for (const s of L) if (s.cover) idb('photos', 'readonly', st => st.get([s.id, s.cover])).then(r => {
    const img = document.querySelector(`img[data-cover="${s.id}"]`); if (!r || !img) return;
    const u = URL.createObjectURL(new Blob([r.bytes], { type: 'image/jpeg' })); covers.push(u); img.src = u;
  }).catch(() => { });
}
/* ---------- search: one person across every saved session ---------- */
// Reads the saved faces (embeddings) of every photo once per person, keeps the matches >= 0.30, and the slider then
// filters them in memory. Images are only turned into object URLs for the cards that are on screen.
const Q = { name: '', min: null, hits: null, sig: '', run: 0, sess: null, shown: 60, list: [], urls: [], t: 0, off: new Set() };   // off: photos the user unticked, as "sid|key"
const qid = h => h.sid + '|' + h.key, qPicked = () => Q.list.filter(h => !Q.off.has(qid(h)));
const qLabel = m => m < .4 ? 'mostrar muitas (algumas podem estar erradas)' : m < .5 ? 'equilibrado' : m < .65 ? 'só as mais seguras' : 'só as quase certas';
const qSig = () => PVER + ':' + SESS.map(x => x.id + '.' + x.count).join(',');
const sessOf = sid => SESS.find(x => x.id === sid);
function qRevoke() { Q.urls.forEach(u => URL.revokeObjectURL(u)); Q.urls = []; if (Q.hits) Q.hits.forEach(h => { h.url = null }) }
function scanPerson(name, floor, onProgress, stale) {
  return new Promise((resolve, reject) => {
    const { a, k } = PE[name], hits = []; let n = 0;
    const req = db.transaction('photos', 'readonly').objectStore('photos').openCursor();
    req.onsuccess = ev => {
      const c = ev.target.result;
      if (!c || stale()) return resolve(stale() ? null : hits);
      const r = c.value; n++;
      if (r.faces) {
        let best = -1, at = -1;
        r.faces.forEach((f, i) => {
          let m = -1;
          if (f.emb) for (let q = 0; q < k; q++) { let d = 0; const o = q * 512; for (let j = 0; j < 512; j++) d += a[o + j] * f.emb[j]; if (d > m) m = d }
          else if (f.scores) { const e = f.scores.find(x => x[0] === name); if (e) m = e[1] }   // sessions saved before embeddings were kept
          if (m > best) { best = m; at = i }
        });
        if (best >= floor) hits.push({ sid: r.sid, key: r.key, score: Math.round(best * 1000) / 1000, bbox: r.faces[at].bbox, w: r.w, h: r.h, bytes: r.bytes, href: r.href || null });
      }
      if (n % 150 === 0) onProgress(n);
      c.continue();
    };
    req.onerror = () => reject(req.error);
  });
}
function viewSearch() {
  qRevoke();
  if (Q.min == null) Q.min = Math.max(.3, th().review);
  $('view').innerHTML = noPeople() + `<section class="card bg-base-100 shadow mb-4"><div class="card-body gap-3">
   <h2 class="card-title">Em que fotos aparece…?</h2><p class="text-sm opacity-70 -mt-2">Escolhe uma pessoa e vê todas as fotos dela, de todos os álbuns que importaste.</p>
   <div class="flex flex-wrap items-end gap-4">
    <label class="form-control"><span class="label-text text-sm mb-1">Pessoa</span>
     <input id="qperson" data-combo="only" class="input input-bordered input-sm w-64" placeholder="escreve um nome…" value="${esc(Q.name)}" data-chg="qperson" autocomplete="off" role="combobox" aria-expanded="false" aria-controls="cb-list"></label>
    <label class="form-control flex-1 min-w-[16rem]"><span class="label-text text-sm mb-1">Rigor: <b id="qminv">${qLabel(Q.min)}</b></span>
     <input type="range" min="0.30" max="0.90" step="0.01" value="${Q.min}" class="range range-primary range-xs" data-inp="qmin" aria-label="Rigor da pesquisa" aria-valuetext="${qLabel(Q.min)}"></label></div>
   <div id="qsum" class="text-sm opacity-80" role="status" aria-live="polite"></div><div id="qchips" class="flex flex-wrap gap-2"></div><div id="qact"></div></div></section>
   <div id="qgrid" class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-4"></div><div id="qmore" class="text-center mt-4"></div>`;
  if (Q.name && PE[Q.name] && !(Q.hits && Q.sig === qSig())) runSearch(); else renderSearch();
}
async function runSearch() {
  const name = Q.name, run = ++Q.run;
  Q.hits = null; Q.sess = null; Q.shown = 60; Q.off = new Set(); renderSearch();
  if (!PE[name] || !db) return;
  try {
    await flush();   // photos still being analysed in this session are saved first
    const sig = qSig();
    const hits = await scanPerson(name, .3, n => { const e = $('qsum'); if (e && run === Q.run) e.textContent = `A procurar ${name}… ${nf(n, 'foto verificada', 'fotos verificadas')}` }, () => run !== Q.run);
    if (!hits || run !== Q.run) return;
    Q.hits = hits; Q.sig = sig;
  } catch (e) { note('Não consegui pesquisar: ' + (e && e.message || e), true); return }
  if (S.view === 'search') renderSearch();
}
function renderSearch() {
  const sum = $('qsum'), chips = $('qchips'), grid = $('qgrid'), more = $('qmore'); if (!sum) return;
  const empty = msg => { sum.textContent = msg; chips.innerHTML = grid.innerHTML = more.innerHTML = $('qact').innerHTML = ''; Q.list = [] };
  if (!Q.name) return empty(SESS.length ? 'Escreve o nome de uma pessoa para ver as fotos dela.' : 'Ainda não importaste nenhum álbum.');
  if (!PE[Q.name]) return empty(`“${Q.name}” não está nas pessoas carregadas.`);
  if (!Q.hits) return empty(`A procurar ${Q.name}…`);
  const all = Q.hits.filter(h => h.score >= Q.min), per = new Map();
  all.forEach(h => per.set(h.sid, (per.get(h.sid) || 0) + 1));
  const list = (Q.sess ? all.filter(h => h.sid === Q.sess) : all).sort((a, b) => b.score - a.score);
  Q.list = list;
  sum.textContent = all.length ? `${nf(all.length, 'foto', 'fotos')} de ${Q.name} em ${nf(per.size, 'álbum', 'álbuns')}.`
    : `Não encontrei fotos de ${Q.name}.` + (Q.min > .3 ? ' Diminui o rigor para ver mais.' : '');
  chips.innerHTML = per.size > 1 ? [['', 'Todas', all.length], ...[...per].sort((a, b) => b[1] - a[1]).map(([sid, n]) => [sid, (sessOf(sid) || {}).name || 'Álbum', n])]
    .map(([sid, label, n]) => `<button type="button" class="btn btn-xs ${(Q.sess == null ? '' : String(Q.sess)) === String(sid) ? 'btn-primary' : 'btn-outline'}" data-act="q-sess" data-sid="${sid}">${esc(label)} (${n})</button>`).join('') : '';
  $('qact').innerHTML = list.length ? `<div class="flex flex-wrap items-center gap-2"><button type="button" id="qdl" class="btn btn-success btn-sm" data-act="q-dl" title="Vai buscar as fotos marcadas em boa qualidade, álbum a álbum, e junta-as num .zip"></button>
    <button type="button" class="btn btn-xs" data-act="q-all" data-v="1">Marcar todas</button><button type="button" class="btn btn-xs btn-ghost" data-act="q-all" data-v="0">Desmarcar</button><span id="qpicked" class="text-sm opacity-70"></span></div>` : '';
  qCount();
  grid.innerHTML = list.slice(0, Q.shown).map((h, i) => {
    if (!h.url) { h.url = URL.createObjectURL(new Blob([h.bytes], { type: 'image/jpeg' })); Q.urls.push(h.url) }
    const s = sessOf(h.sid) || {}, c = cls(h.score), [x1, y1, x2, y2] = h.bbox, k = h.w / 220;
    return `<article class="card bg-base-100 shadow-md overflow-hidden"><div class="relative"><label class="absolute top-2 left-2 z-10 bg-base-100/80 rounded p-1 cursor-pointer"><input type="checkbox" class="checkbox checkbox-sm checkbox-success" data-act="q-tog" data-i="${i}" ${Q.off.has(qid(h)) ? '' : 'checked'} aria-label="Marcar para descarregar"></label><button type="button" class="block w-full cursor-zoom-in focus:outline-none" data-act="q-open" data-i="${i}" aria-label="Abrir a foto no álbum ${esc(s.name || '')}">
     <img src="${h.url}" alt="" loading="lazy" decoding="async" class="w-full" width="${h.w}" height="${h.h}"></button>
     <svg viewBox="0 0 ${h.w} ${h.h}" class="absolute inset-0 w-full h-full pointer-events-none" aria-hidden="true"><rect x="${x1}" y="${y1}" width="${x2 - x1}" height="${y2 - y1}" fill="none" stroke="${COL[c]}" stroke-width="${k}"></rect></svg></div>
     <div class="card-body p-3 gap-1"><div class="flex flex-wrap gap-1"><span class="badge" style="border-color:${COL[c]}" title="${Math.round(h.score * 100)}% de semelhança">${c === 'rever' ? 'talvez ' : ''}${esc(Q.name)}</span></div>
     <div class="text-xs opacity-60 truncate" title="${esc(s.name || '')}">${esc(s.name || 'Álbum')} · ${s.date ? fmt(s.date) : s.created ? fmt(s.created) : ''}</div></div></article>`;
  }).join('');
  more.innerHTML = list.length > Q.shown ? `<button type="button" class="btn btn-sm" data-act="q-more">Mostrar mais (${list.length - Q.shown})</button>` : '';
}
function qCount() {
  const b = $('qdl'); if (!b) return;
  const n = qPicked().length, albums = new Set(qPicked().map(h => h.sid)).size;
  b.textContent = n ? `Descarregar ${nf(n, 'foto marcada', 'fotos marcadas')}${albums > 1 ? ` de ${albums} álbuns` : ''}` : 'Descarregar'; b.disabled = !n || !!DL || collecting;
  $('qpicked').textContent = n === Q.list.length ? '' : `${n} de ${Q.list.length} marcadas`;
}
async function openResult(sid, key) {
  await openSessionById(sid);
  const p = cur && cur.id === sid && cur.map[key]; if (!p) return note('Não encontrei essa foto no álbum.', true);
  const i = info(p); S.tab = ['certeza', 'rever', 'sem match'].includes(i.c) ? i.c : 'certeza'; S.person = ''; S.onlyUnrev = false;
  draw(); FOC = p.id; big(p.id);
}

const rigorLabel = c => c < .42 ? 'Muito solto' : c < .48 ? 'Solto' : c < .58 ? 'Equilibrado' : c < .68 ? 'Rigoroso' : 'Muito rigoroso';
function viewSession() {
  if (!cur) return setView('sessions');
  const t = th();
  $('view').innerHTML = noPeople() + `<div class="mb-1"><button type="button" class="btn btn-ghost btn-sm -ml-3" data-act="view" data-v="sessions">← Álbuns</button></div>
  <div class="mb-4">
   <input id="title" aria-label="Nome do álbum" class="input bg-transparent border-transparent hover:border-base-300 focus:border-primary text-2xl font-bold w-full px-2 -mx-2 h-auto py-1" value="${esc(cur.name)}" data-chg="title" title="Clica para mudar o nome do álbum">
   <div class="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm opacity-80 mt-1"><span id="sum"></span>
    <label class="flex items-center gap-2" title="É a data que fica escrita em cada foto descarregada. Por defeito é o dia em que o Facebook recebeu as fotos."><span>Data das fotos:</span><input id="sdate" type="datetime-local" step="1" class="input input-bordered input-xs ${cur.date ? '' : 'input-warning'}" value="${cur.date || ''}" data-chg="date"></label>
    ${cur.albumUrl ? `<button type="button" class="link" data-act="open-album" title="Abre este álbum no separador do Facebook">Ver no Facebook ↗</button>` : ''}</div></div>
  <div id="errs"></div>
  <div id="lowres" class="hidden alert alert-warning text-sm mb-4 py-2" role="status"></div>
  <div role="tablist" class="tabs tabs-boxed overflow-x-auto max-w-full w-fit" id="tabs" aria-label="Grupos de fotos"></div>
  <p id="hint" class="text-sm opacity-70 mt-2 mb-4 max-w-3xl"></p>
  <div id="filters" class="flex flex-wrap gap-3 items-center mb-4"><label class="flex items-center gap-2 text-sm"><span class="opacity-70">Mostrar:</span><select id="person" aria-label="Filtrar por pessoa" class="select select-bordered select-sm" data-chg="person"></select></label>
   <label id="unrevl" class="label cursor-pointer gap-2 text-sm"><input type="checkbox" class="checkbox checkbox-sm" data-chg="unrev" ${S.onlyUnrev ? 'checked' : ''}>só as que ainda não confirmei</label>
   <span id="count" class="text-sm opacity-60"></span></div>
  <div id="grid" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-4"></div>
  <details class="card bg-base-100 shadow mt-8"><summary class="card-body p-4 cursor-pointer font-medium">Ajustar o reconhecimento</summary><div class="px-4 pb-4 space-y-2">
   <p class="text-sm opacity-70">Se o Tagged anda a marcar fotos demais (com pessoas erradas), sobe o rigor. Se está a deixar escapar fotos que são mesmo dos teus amigos, desce.</p>
   <div class="flex items-center gap-3"><span class="text-xs opacity-70 w-24 text-right">Mais fotos, menos seguras</span><input id="rigor" type="range" min=".35" max=".80" step=".01" value="${t.certain}" class="range range-primary range-xs flex-1" data-inp="rigor" aria-label="Rigor do reconhecimento" aria-valuetext="${rigorLabel(t.certain)}"><span class="text-xs opacity-70 w-24">Só as mais seguras</span></div>
   <div class="flex items-center justify-between text-sm"><span>Agora: <b id="rigorv">${rigorLabel(t.certain)}</b></span><button type="button" class="btn btn-ghost btn-xs" data-act="th-reset">Voltar ao normal</button></div></div></details>
  <div class="h-28" aria-hidden="true"></div>
  <div id="bar" class="fixed bottom-0 inset-x-0 z-20 bg-base-100/95 backdrop-blur border-t border-base-300 shadow-[0_-4px_12px_rgba(0,0,0,.25)]"><div class="max-w-[min(100%,110rem)] mx-auto px-4 py-2 sm:py-3 space-y-2 sm:space-y-0 sm:flex sm:items-center sm:gap-4">
   <div class="flex items-center gap-3 sm:flex-1"><span id="barn" class="font-medium text-sm sm:text-base flex-1 min-w-0"></span>
    <span class="flex gap-1 shrink-0"><button type="button" class="btn btn-xs" data-act="bulk" data-v="1" title="Marca todas as fotos que estão a ser mostradas">Marcar todas</button><button type="button" class="btn btn-xs btn-ghost" data-act="bulk" data-v="0" title="Desmarca todas as fotos que estão a ser mostradas">Desmarcar</button></span></div>
   <div class="flex gap-2"><button id="dl" type="button" class="btn btn-success btn-sm flex-1 sm:flex-none" data-act="dl" data-mode="zip" title="Junta as fotos escolhidas num ficheiro .zip, em boa qualidade e com a data certa">Descarregar</button>
   ${CFG.googleClientId ? `<button id="gp" type="button" class="btn btn-info btn-sm flex-1 sm:flex-none" data-act="dl" data-mode="gphotos">Enviar para o Google Fotos</button>` : ''}</div></div></div>`;
  CARDS.clear(); draw();
}
function onRigor(v) {
  const certain = Math.min(.8, Math.max(.35, v)), review = Math.max(.2, +(certain - .15).toFixed(2));
  cfg.certain = certain; cfg.review = review; saveCfg(); IVER++;
  const l = $('rigorv'); if (l) l.textContent = rigorLabel(certain); $('rigor').setAttribute('aria-valuetext', rigorLabel(certain));
  draw(); touch(cur);
}
function draw() {
  const A = cur.photos.map(info), cnt = { certeza: 0, rever: 0, 'sem match': 0, pending: 0, erro: 0 };
  A.forEach(i => cnt[i.c]++); const nsel = A.filter(sel).length, unrev = A.filter(i => i.c === 'rever' && !i.p.rev).length;
  $('sum').textContent = `${nf(A.length, 'foto', 'fotos')}${cur.expected && cur.expected > A.length ? ` de ${cur.expected}` : ''} · ${cnt.pending ? `a analisar ${cnt.pending}…` : cnt.certeza ? `${nf(cnt.certeza, 'reconhecida', 'reconhecidas')}` : 'nenhum amigo reconhecido ainda'}`;
  // Facebook serves smaller thumbnails to screens without zoom/retina; below ~700px faces fall under the minimum size and are missed.
  const sides = A.filter(i => i.p.w).map(i => Math.max(i.p.w, i.p.h)).sort((x, y) => x - y), med = sides[sides.length >> 1];
  const lr = $('lowres'), small = sides.length >= 5 && med < 700;
  lr.classList.toggle('hidden', !small);
  if (small) lr.textContent = 'As fotos que o Facebook mostrou inicialmente são pequenas demais para reconhecer toda a gente com certeza (isto acontece em ecrãs grandes). Faz zoom no Chrome (Ctrl e +, até uns 150–200%) no separador do Facebook, volta a importar o álbum e o reconhecimento melhora.';
  const dots = { certeza: COL.certeza, rever: COL.rever, 'sem match': COL['sem match'] };
  $('tabs').innerHTML = TABS.map(([k, l]) => `<button type="button" role="tab" aria-selected="${S.tab === k}" class="tab h-auto py-2 gap-2 px-3 flex-nowrap shrink-0 whitespace-nowrap ${S.tab === k ? 'tab-active' : ''}" data-act="tab" data-v="${k}">${dots[k] ? `<span style="color:${dots[k]}" aria-hidden="true">●</span>` : '<span aria-hidden="true">🙂</span>'}${l}${k === 'unknown' ? '' : `<span class="badge badge-sm">${cnt[k]}</span>`}</button>`).join('');
  $('hint').textContent = HINT[S.tab] + (S.tab === 'rever' && unrev ? ` Faltam confirmar ${unrev}.` : '');
  const busy = !!DL || collecting;
  $('dl').disabled = busy || !nsel; $('dl').textContent = nsel ? `Descarregar ${nf(nsel, 'foto', 'fotos')}` : 'Descarregar';
  if ($('gp')) { $('gp').disabled = busy || !nsel; $('gp').textContent = nsel ? `Enviar ${nsel} para o Google Fotos` : 'Enviar para o Google Fotos' }
  $('barn').textContent = nsel ? `${nf(nsel, 'foto marcada', 'fotos marcadas')} para descarregar` : 'Nenhuma foto marcada';
  $('filters').classList.toggle('hidden', S.tab === 'unknown'); $('unrevl').classList.toggle('hidden', S.tab !== 'rever');
  if (S.tab === 'unknown') { CUR = []; return drawUnknown(A) }
  const per = {}; A.forEach(i => i.faces.forEach(f => { if (f.c !== 'sem match' && f.name) per[f.name] = (per[f.name] || 0) + 1 }));
  $('person').innerHTML = '<option value="">todas as pessoas</option>' + Object.keys(per).sort((a, b) => a.localeCompare(b, 'pt')).map(n => `<option value="${esc(n)}" ${S.person === n ? 'selected' : ''}>${esc(n)} (${per[n]})</option>`).join('');
  const L = A.filter(i => i.c === S.tab && (!S.person || i.faces.some(f => f.name === S.person && f.c !== 'sem match')) && !(S.tab === 'rever' && S.onlyUnrev && i.p.rev));
  L.sort((a, b) => b.top - a.top); CUR = L;
  $('count').textContent = nf(L.length, 'foto', 'fotos');
  drawGrid(L, A.length);
  if (LB !== null) lb();
}

/* ---------- grid: one element per photo, reused and reordered instead of rebuilding the whole grid ---------- */
const CARDS = new Map();
const faceLabel = f => (f.c === 'rever' ? 'talvez ' : '') + f.name;
/* Face boxes and name labels drawn over a photo (image coordinates). Labels are sized from the face, sit on a dark pill,
   are placed where they overlap neither another label nor another face, and are always kept inside the photo. */
const overlap = (r, list, m = 0) => list.some(o => r[0] < o[2] + m && r[2] > o[0] - m && r[1] < o[3] + m && r[3] > o[1] - m);
function layoutLabels(i) {
  const p = i.p, W = p.w, H = p.h, placed = [], out = [];
  const named = i.faces.filter(f => f.c !== 'sem match' && f.name).sort((a, b) => (b.bbox[2] - b.bbox[0]) - (a.bbox[2] - a.bbox[0]));   // big faces first: they get the best spots
  for (const f of named) {
    const [x1, y1, x2, y2] = f.bbox, cx = (x1 + x2) / 2, others = i.faces.filter(o => o !== f).map(o => o.bbox);
    const fs = Math.max(W / 120, Math.min(W / 46, (x2 - x1) * .3)), th = fs * 1.45, g = fs * .3;
    const full = faceLabel(f), texts = [full];
    if (full.length > 9) texts.push(full.slice(0, 8) + '…'); if (full.length > 4) texts.push(full.slice(0, 3) + '…');
    const tries = (t, avoidFaces) => {
      const tw = t.length * fs * .6 + fs, spots = [];
      for (let k = 0; k < 4; k++) spots.push([cx - tw / 2, y1 - g - (k + 1) * th - k * g, -1], [cx - tw / 2, y2 + g + k * (th + g), 1]);   // above / below, up to 4 rows away
      for (const [sx, sy, side] of spots) {
        const lx = Math.min(Math.max(0, sx), Math.max(0, W - tw)), ly = Math.min(Math.max(0, sy), Math.max(0, H - th)), r = [lx, ly, lx + tw, ly + th];
        if (!overlap(r, placed, 2) && !(avoidFaces && overlap(r, others))) return { t, r, f, fs, tw, side };
      }
      return null;
    };
    let pick = null;
    for (const t of texts) { pick = tries(t, true); if (pick) break }
    if (!pick) pick = tries(texts[texts.length - 1], false);   // crowded: the shortest text may cover a face, but never another label
    if (pick) { placed.push(pick.r); out.push(pick) }          // still no room: the box stays and the name is in the caption
  }
  return out;
}
function svg(i) {
  const p = i.p; if (!p.w) return '';
  const boxes = i.faces.map(f => { const [x1, y1, x2, y2] = f.bbox, sw = Math.max(p.w / 450, Math.min(p.w / 180, (x2 - x1) * .045));
    return `<rect x="${x1}" y="${y1}" width="${x2 - x1}" height="${y2 - y1}" fill="none" stroke="${COL[f.c]}" stroke-width="${sw}"></rect>` }).join('');
  const labels = layoutLabels(i).map(L => {
    const [lx, ly, rx, by] = L.r, col = COL[L.f.c], [x1, y1, x2, y2] = L.f.bbox, cx = (x1 + x2) / 2, sw = Math.max(L.fs * .08, 1);
    const edge = L.side < 0 ? y1 : y2, near = L.side < 0 ? by : ly, link = Math.abs(edge - near) > L.fs * .6
      ? `<line x1="${Math.min(Math.max(cx, lx), rx)}" y1="${near}" x2="${cx}" y2="${edge}" stroke="${col}" stroke-width="${sw}"></line>` : '';
    return `${link}<rect x="${lx}" y="${ly}" width="${rx - lx}" height="${by - ly}" rx="${L.fs * .3}" fill="rgba(0,0,0,.72)" stroke="${col}" stroke-width="${sw}"></rect>
      <text x="${lx + L.fs * .5}" y="${ly + (by - ly) * .72}" fill="${col}" font-size="${L.fs}" font-weight="700" textLength="${rx - lx - L.fs}" lengthAdjust="spacingAndGlyphs">${esc(L.t)}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${p.w} ${p.h}" class="absolute inset-0 w-full h-full pointer-events-none" aria-hidden="true">${boxes}${labels}</svg>`;
}
const badges = (i, big) => i.faces.filter(f => f.c !== 'sem match').map(f => `<span class="badge ${big ? 'badge-lg' : ''}" style="border-color:${COL[f.c]}" title="${Math.round(f.score * 100)}% de semelhança">${esc(faceLabel(f))}</span>`).join('') || '<span class="text-xs opacity-60">ninguém conhecido</span>';
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
      c.el.querySelector('.ov').innerHTML = svg(i) + `<input type="checkbox" class="checkbox checkbox-success checkbox-md absolute top-2 left-2 bg-black/50" ${on_ ? 'checked' : ''} data-act="toggle" data-id="${i.id}" aria-label="Descarregar a foto ${esc(i.p.key)}" title="Descarregar esta foto">`;
      c.el.querySelector('.card-body').innerHTML = `<div class="flex flex-wrap gap-1">${badges(i)}${i.p.dup ? `<span class="badge badge-ghost" title="Esta foto já foi importada noutro álbum, por isso não vem marcada">repetida (já em ${esc(i.p.dup)})</span>` : ''}${i.p.rev && i.c === 'rever' ? '<span class="badge badge-ghost">confirmada</span>' : ''}</div>`;
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
let UNKSIG = '';
function drawUnknown(A) {
  const g = $('grid'), sig = [IVER, PVER, A.filter(i => i.p.faces).length, S.hiddenClusters.size].join();
  if (sig === UNKSIG && g.dataset.unk) return;   // nothing new: keep the crops and whatever is being typed
  UNKSIG = sig; g.dataset.unk = '1'; CARDS.clear(); UNK = clusters(A);
  $('count').textContent = UNK.length ? `Encontrei ${nf(UNK.length, 'pessoa', 'pessoas')} que ainda não conheço` : '';
  if (!UNK.length) { g.innerHTML = `<div class="opacity-60 col-span-full text-center py-16">${A.some(i => i.c === 'pending') ? 'a aguardar a análise…' : 'Não encontrei pessoas novas neste álbum.'}</div>`; return }
  g.innerHTML = UNK.map((c, n) => `<div class="card bg-base-100 shadow p-3 gap-2"><div class="flex flex-wrap gap-1">${c.items.slice(0, 8).map(x => `<canvas width="56" height="56" class="rounded" data-crop="${x.i.id}:${x.f.i}"></canvas>`).join('')}</div>
   <div class="text-xs opacity-70">${nf(c.items.length, 'cara', 'caras')} em ${nf(new Set(c.items.map(x => x.i.id)).size, 'foto', 'fotos')}</div>
   <form class="flex gap-1" data-form="unk" data-n="${n}"><input name="who" data-combo required class="input input-bordered input-sm flex-1 min-w-0" placeholder="Nome" aria-label="Nome desta pessoa"><button class="btn btn-sm btn-primary">Guardar</button></form>
   <button type="button" class="btn btn-xs btn-ghost self-start" data-act="unk-hide" data-n="${n}">Não é um amigo</button></div>`).join('');
  paintCrops(g);
}

/* ---------- onboarding: create the people from a folder of photos (or load a people file) ---------- */
// Photos are shrunk in the browser, sent to /api/score for their faces, grouped by similarity, and the user names each
// group. Naming is staged and only written to IndexedDB at the end, so cancelling leaves the people untouched.
const IMG_RE = /\.(jpe?g|png|webp)$/i, MAX_SETUP_PHOTOS = 400, SEND_SIDE = 1600;
const W = { step: 'choose', files: [], found: 0, skipped: 0, photos: [], faces: [], clusters: [], done: 0, total: 0, bad: 0, run: 0, err: '', how: '', count: 0, minSize: 3, shown: 48 };
function setupReset() { W.run++; Object.assign(W, { step: 'choose', files: [], found: 0, skipped: 0, photos: [], faces: [], clusters: [], done: 0, total: 0, bad: 0, err: '', how: '', count: 0, minSize: 3, shown: 48 }) }
function setupPick(list) {
  const all = Array.from(list), imgs = all.filter(f => IMG_RE.test(f.name) && f.size > 15000);   // tiny files are icons, not photos
  W.skipped = all.length - imgs.length; W.found = imgs.length;
  const k = imgs.length / MAX_SETUP_PHOTOS;
  W.files = imgs.length > MAX_SETUP_PHOTOS ? Array.from({ length: MAX_SETUP_PHOTOS }, (_, i) => imgs[Math.floor(i * k)]) : imgs;   // evenly spaced sample
  W.err = imgs.length ? '' : 'Não encontrei fotos (JPG, PNG ou WebP) nessa escolha.';
  W.step = imgs.length ? 'ready' : 'folder'; renderSetup();
}
async function setupOne(file, run) {
  const bmp = await createImageBitmap(file), k = Math.min(1, SEND_SIDE / Math.max(bmp.width, bmp.height));
  const cv = new OffscreenCanvas(Math.max(1, Math.round(bmp.width * k)), Math.max(1, Math.round(bmp.height * k)));
  cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height); bmp.close();
  const blob = await cv.convertToBlob({ type: 'image/jpeg', quality: .9 });
  let r;
  for (let t = 0; t < 60; t++) {   // the model may still be loading (503)
    if (run !== W.run) return;
    r = await fetch('/api/score?name=' + encodeURIComponent(file.name), { method: 'POST', body: blob });
    if (r.status !== 503) break; await sleep(2000);
  }
  const d = await r.json().catch(() => ({ error: 'HTTP ' + r.status })); if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status);
  if (run !== W.run || !d.faces.length) return;
  const p = { bytes: new Uint8Array(await blob.arrayBuffer()), w: d.w, h: d.h, name: file.name }, pi = W.photos.push(p) - 1;
  for (const f of d.faces) W.faces.push({ p, pi, f: { bbox: f.bbox, det: f.det, emb: Float32Array.from(f.emb) } });
}
async function setupRun() {
  const run = ++W.run; W.step = 'process'; W.photos = []; W.faces = []; W.done = 0; W.bad = 0; W.err = ''; W.total = W.files.length; renderSetup();
  let next = 0;
  const worker = async () => {
    while (run === W.run) {
      const i = next++; if (i >= W.files.length) return;
      try { await setupOne(W.files[i], run) } catch (e) { W.bad++; W.lastErr = String(e.message || e) }
      W.done++; setupProgress();
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  if (run !== W.run) return;
  W.files = [];
  if (!W.faces.length) { W.step = 'folder'; W.err = W.bad === W.total ? `Não consegui analisar as fotos (${W.lastErr || 'erro'}).` : 'Não encontrei nenhuma cara utilizável nestas fotos.'; return renderSetup() }
  W.clusters = clusterFaces(W.faces); W.step = 'name'; renderSetup();
}
function setupProgress() {
  const bar = $('wprog'), t = $('wtxt'); if (!bar || !t) return;
  bar.value = W.done; bar.max = W.total || 1;
  t.textContent = MODEL !== 'ready' && !W.done ? 'A preparar o modelo de reconhecimento (a primeira vez demora um pouco)…'
    : `${W.done} de ${W.total} fotos · ${nf(W.faces.length, 'cara', 'caras')} encontradas${W.bad ? ` · ${nf(W.bad, 'falhou', 'falharam')}` : ''}`;
}
function clusterFaces(faces) {   // leader clustering against each group's running mean
  const cl = [];
  for (const x of faces.slice(0, 4000)) {
    let best = null, bs = .45;
    for (const c of cl) { let d = 0; for (let k = 0; k < 512; k++) d += c.m[k] * x.f.emb[k]; if (d > bs) { bs = d; best = c } }
    if (best) { best.items.push(x); for (let k = 0; k < 512; k++) best.s[k] += x.f.emb[k]; best.m = unit(best.s) }
    else cl.push({ items: [x], s: Float32Array.from(x.f.emb), m: unit(x.f.emb) });
  }
  cl.forEach(c => { c.items.forEach(x => { let d = 0; for (let k = 0; k < 512; k++) d += c.m[k] * x.f.emb[k]; x.d = d }); c.items.sort((a, b) => b.d - a.d) });
  return cl.sort((a, b) => b.items.length - a.items.length);
}
const wVisible = () => W.clusters.map((c, n) => [c, n]).filter(([c]) => !c.skip && (c.staged || c.items.length >= W.minSize));
const wNames = () => [...new Set(W.clusters.filter(c => c.staged).map(c => c.name))];
function wCard(n) {
  const c = W.clusters[n], faces = c.items.length, photos = new Set(c.items.map(x => x.pi)).size;
  if (c.staged) return `<div class="flex items-center gap-2"><span class="text-success" aria-hidden="true">✓</span><b class="flex-1 truncate">${esc(c.name)}</b><span class="text-xs opacity-60">${nf(faces, 'cara', 'caras')}</span><button type="button" class="btn btn-xs btn-ghost" data-act="w-unstage" data-n="${n}">desfazer</button></div>`;
  return `<div class="flex flex-wrap gap-1">${c.items.slice(0, 8).map((x, j) => `<canvas width="56" height="56" class="rounded" data-wcrop="${n}:${j}"></canvas>`).join('')}</div>
   <div class="text-xs opacity-70">${faces} caras em ${nf(photos, 'foto', 'fotos')}</div>
   <form class="flex gap-1" data-form="wname" data-n="${n}"><input name="who" data-combo required class="input input-bordered input-sm flex-1 min-w-0" placeholder="Nome" aria-label="Nome desta pessoa" autocomplete="off"><button class="btn btn-sm btn-primary">Guardar</button></form>
   <button type="button" class="btn btn-xs btn-ghost self-start" data-act="w-ignore" data-n="${n}">Não é um amigo</button>`;
}
function paintWCrops(root) {
  root.querySelectorAll('canvas[data-wcrop]').forEach(cv => {
    const [ci, ii] = cv.dataset.wcrop.split(':').map(Number), x = W.clusters[ci] && W.clusters[ci].items[ii]; if (!x) return;
    crop(x.p, x.f.bbox, cv.width).then(b => { cv.height = b.height; cv.getContext('2d').drawImage(b, 0, 0); b.close() }).catch(() => { });
  });
}
function wSummary() {
  const el = $('wsum'); if (!el) return;
  const names = wNames(), faces = W.clusters.filter(c => c.staged).reduce((a, c) => a + c.items.length, 0);
  el.textContent = names.length ? `${nf(names.length, 'pessoa nomeada', 'pessoas nomeadas')}` : 'Ainda não deste nome a ninguém.';
  const b = $('wcommit'); if (b) b.disabled = !names.length;
}
function stageCluster(n, who) {
  const c = W.clusters[n]; who = (who || '').trim(); if (!c || !who) return;
  c.name = who; c.staged = true;
  const el = $('wc-' + n); if (el) el.innerHTML = wCard(n);
  wSummary(); const next = document.querySelector('#wgrid form[data-form=wname] input'); if (next) next.focus();   // straight on to the next group
}
async function setupCommit() {
  const by = new Map();
  for (const c of W.clusters) if (c.staged) { const a = by.get(c.name) || []; a.push(...c.items.slice(0, 5).map(x => x.f.emb)); by.set(c.name, a) }   // the 5 faces closest to each group's centre
  for (const [name, embs] of by) await addRefs(name, embs.slice(0, 10), true);
  W.count = by.size; W.step = 'done'; W.how = 'folder'; W.photos = []; W.faces = []; W.clusters = [];
  try { localStorage.setItem('tagged.setup', '1') } catch (e) { }
  persistStorage(); renderSetup();
}
const ONB = { page: 'welcome' };
function openOnboarding(page) { ONB.page = page || 'welcome'; setupReset(); if (ONB.page === 'people' && PEOPLE.length) W.step = 'have'; setView('setup') }
function onbNext() { const n = setupSteps().find(x => !x.done); if (!n) { try { localStorage.setItem('tagged.setup', '1') } catch (e) { } return setView('sessions') } openOnboarding(n.id) }
function onbLater() { try { localStorage.setItem('tagged.setup', '1') } catch (e) { } setView('sessions') }
function copyText(t, btn) {
  const ok = () => { if (btn) { const o = btn.textContent; btn.textContent = 'Copiado ✓'; setTimeout(() => { btn.textContent = o }, 1800) } };
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(t).then(ok, () => { });
  else { const x = document.createElement('textarea'); x.value = t; document.body.append(x); x.select(); try { document.execCommand('copy'); ok() } catch (e) { } x.remove() }
}
const browserOk = () => { const u = navigator.userAgent; return !/Mobi|Android|iPhone|iPad/.test(u) && /Chrome|Chromium|Edg\//.test(u) && !/Firefox/.test(u) };
function stepper() {
  const items = [['people', 'Os teus amigos'], ['ext', 'Ligar ao Facebook'], ['album', 'Primeiro álbum']], st = setupSteps(), at = items.findIndex(x => x[0] === ONB.page);
  return `<ol class="steps w-full mb-8" aria-label="Passos">${items.map(([k, l], i) => `<li class="step ${i <= at || st[i].done ? 'step-primary' : ''}" data-content="${st[i].done ? '✓' : i + 1}" ${i === at ? 'aria-current="step"' : ''}>${l}</li>`).join('')}</ol>`;
}
const laterLink = () => `<button type="button" class="link text-sm opacity-70" data-act="onb-later">Fazer isto mais tarde</button>`;
function onbWelcome() {
  return `<section class="max-w-4xl mx-auto text-center pt-6"><div class="text-5xl mb-3" aria-hidden="true"><img src="/favicon.svg" alt="" width="72" height="72" class="inline"></div>
   <h1 class="text-3xl font-bold mb-2">Encontra os teus amigos nas fotos do Facebook</h1>
   <p class="opacity-70 max-w-2xl mx-auto mb-8">O Tagged vê um álbum inteiro, descobre em que fotos estão as pessoas que escolheste e deixa-te descarregar só essas, em boa qualidade e com a data certa.</p>
   <div class="grid sm:grid-cols-3 gap-4 text-left mb-8">${[['1', '📂', 'Importas um álbum', 'Abres um álbum no Facebook e o Tagged traz as fotos para aqui.'], ['2', '🔍', 'Ele reconhece os teus amigos', 'As fotos ficam separadas: onde estão eles e onde não estão.'], ['3', '⬇️', 'Descarregas as que queres', 'Escolhes as fotos e levas tudo num ficheiro, ou para o Google Fotos.']].map(([n, i, t, d]) => `<div class="card bg-base-100 shadow"><div class="card-body p-5 gap-1"><div class="text-2xl" aria-hidden="true">${i}</div><h2 class="font-semibold">${t}</h2><p class="text-sm opacity-70">${d}</p></div></div>`).join('')}</div>
   <p class="text-sm opacity-70 mb-4">Antes de começar, há <b>3 passos rápidos</b> (uns 5 minutos, só desta vez).</p>
   <div class="flex flex-wrap justify-center gap-3 items-center"><button type="button" class="btn btn-primary btn-lg" data-act="onb" data-v="people">Começar</button>${laterLink().replace('Fazer isto mais tarde', 'Já tenho tudo configurado')}</div>
   <p class="text-xs opacity-60 mt-8 max-w-xl mx-auto">As tuas pessoas e os teus álbuns ficam guardados só neste browser. Nada é publicado nem enviado a terceiros.</p></section>`;
}
function onbPeople() {
  if (W.step === 'have') return `<div class="card bg-base-100 shadow border border-success/40"><div class="card-body gap-3"><h2 class="card-title">✅ O Tagged já conhece ${nf(PEOPLE.length, 'pessoa', 'pessoas')}</h2>
    <p class="text-sm opacity-70">${esc(PEOPLE.slice(0, 6).join(', '))}${PEOPLE.length > 6 ? '…' : ''}</p>
    <div class="card-actions"><button type="button" class="btn btn-primary btn-sm" data-act="onb-next">Continuar</button><button type="button" class="btn btn-sm btn-ghost" data-act="w-step" data-v="choose">Adicionar mais pessoas</button></div></div></div>`;
  if (W.step === 'choose') {
    const err = W.err ? `<p class="text-error text-sm mt-2" role="alert">${esc(W.err)}</p>` : '';
    return `<h1 class="text-2xl font-bold mb-1">Como queres ensinar o Tagged a reconhecer os teus amigos?</h1><p class="opacity-70 mb-5">Escolhe a forma mais fácil para ti.</p>
     <div class="grid md:grid-cols-2 gap-4">
      <article class="card bg-base-100 shadow border border-primary/40"><div class="card-body"><div class="flex items-center gap-2"><h2 class="card-title">Criar a partir de fotos</h2><span class="badge badge-primary badge-sm">recomendado</span></div>
       <p class="text-sm opacity-70">Escolhe uma pasta com fotos onde os teus amigos apareçam. O Tagged mostra-te as caras e tu dizes quem é quem. Demora uns 5 minutos.</p>
       <div class="card-actions"><button type="button" class="btn btn-primary btn-sm" data-act="w-step" data-v="folder">Escolher fotos</button></div></div></article>
      <article class="card bg-base-100 shadow"><div class="card-body"><h2 class="card-title">Já tenho um ficheiro de pessoas</h2>
       <p class="text-sm opacity-70">Se já usaste o Tagged noutro sítio e guardaste a cópia (o ficheiro <code>people.npz</code>), carrega-a aqui.</p>
       <div class="card-actions"><label class="btn btn-sm">Escolher ficheiro<input type="file" class="hidden" multiple accept=".npz,.npy,.zip" data-chg="files"></label>
        <label class="btn btn-sm btn-ghost">ou uma pasta<input type="file" class="hidden" webkitdirectory data-chg="files"></label></div>${err}</div></article></div>
     <p class="mt-6 text-center">${laterLink()}</p>`;
  }
  if (W.step === 'folder' || W.step === 'ready') {
    const ready = W.step === 'ready', err = W.err ? `<p class="text-error text-sm mt-2" role="alert">${esc(W.err)}</p>` : '';
    return `<h1 class="text-2xl font-bold mb-3">Escolhe as fotos dos teus amigos</h1>
     <ul class="space-y-2 text-sm opacity-80 mb-5"><li>📁 Uma pasta com fotos onde os teus amigos apareçam. Chegam 50 a 300 fotos (aceito até ${MAX_SETUP_PHOTOS}).</li>
      <li>👥 Cada pessoa deve aparecer em pelo menos <b>3 fotos</b>. Quanto mais variadas (luz, épocas), melhor.</li>
      <li>🔒 As fotos não ficam guardadas: só são usadas agora para encontrar as caras.</li></ul>
     <div class="flex flex-wrap gap-2 items-center"><label class="btn ${ready ? '' : 'btn-primary'} btn-sm">${ready ? 'Escolher outra pasta' : 'Escolher pasta'}<input type="file" class="hidden" webkitdirectory data-chg="wfiles"></label>
      <label class="btn btn-sm">Escolher fotos soltas<input type="file" class="hidden" multiple accept="image/*" data-chg="wfiles"></label>
      <button type="button" class="btn btn-sm btn-ghost" data-act="w-step" data-v="choose">Voltar</button></div>${err}
     ${ready ? `<div class="card bg-base-100 shadow mt-4"><div class="card-body gap-2"><p><b>${nf(W.found, 'foto encontrada', 'fotos encontradas')}</b>${W.found > W.files.length ? ` (vou usar ${W.files.length}, espaçadas)` : ''}${W.skipped ? `. ${nf(W.skipped, 'ficheiro ignorado', 'ficheiros ignorados')} (não eram fotos).` : '.'}</p>
      <div class="card-actions"><button type="button" class="btn btn-primary btn-sm" data-act="w-run">Procurar caras nestas fotos</button></div></div></div>` : ''}`;
  }
  if (W.step === 'process') return `<div class="card bg-base-100 shadow border border-primary/30"><div class="card-body gap-3">
     <div class="flex items-center gap-3"><div class="text-3xl animate-pulse" aria-hidden="true">🔍</div><div class="flex-1"><div class="font-semibold">A procurar caras nas fotos…</div><div id="wtxt" class="text-sm opacity-70" role="status" aria-live="polite"></div></div></div>
     <progress id="wprog" class="progress progress-primary w-full h-3" value="0" max="1"></progress>
     <div class="card-actions"><button type="button" class="btn btn-sm btn-ghost" data-act="w-cancel">Cancelar</button></div></div></div>`;
  if (W.step === 'name') {
    const vis = wVisible(), small = W.clusters.filter(c => !c.skip && !c.staged && c.items.length < W.minSize).length;
    return `<div class="sticky top-14 z-10 bg-base-200/95 backdrop-blur py-2 mb-3 flex flex-wrap items-center gap-3">
      <div class="flex-1 min-w-[14rem]"><h1 class="text-xl font-bold">Quem é cada pessoa?</h1><div class="text-sm opacity-70">Juntei as caras parecidas em grupos. Escreve o nome de cada pessoa (Enter para passar ao grupo seguinte). Se uma pessoa estiver em mais do que um grupo, usa o mesmo nome.</div></div>
      <span id="wsum" class="text-sm" role="status" aria-live="polite"></span>
      <button type="button" class="btn btn-primary btn-sm" id="wcommit" data-act="w-commit" disabled>Guardar pessoas</button>
      <button type="button" class="btn btn-ghost btn-sm" data-act="w-cancel">Cancelar</button></div>
     <div id="wgrid" class="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">${vis.slice(0, W.shown).map(([c, n]) => `<div class="card bg-base-100 shadow p-3 gap-2" id="wc-${n}">${wCard(n)}</div>`).join('') || '<div class="opacity-70 col-span-full py-10 text-center">Não encontrei caras que se repitam. Experimenta fotos em que cada pessoa apareça mais vezes.</div>'}</div>
     <div class="mt-4 flex flex-wrap gap-2 justify-center">${vis.length > W.shown ? `<button type="button" class="btn btn-sm" data-act="w-more">Mostrar mais grupos (${vis.length - W.shown})</button>` : ''}
      ${small ? `<button type="button" class="btn btn-sm btn-ghost" data-act="w-small">${W.minSize > 2 ? `Mostrar também quem só apareceu 2 vezes (${small})` : 'Esconder quem só apareceu 2 vezes'}</button>` : ''}</div>`;
  }
  return `<div class="card bg-base-100 shadow border border-success/40"><div class="card-body gap-3">   <!-- done -->
     <div class="flex items-center gap-3"><div class="text-4xl" aria-hidden="true">✅</div><div><h1 class="text-xl font-bold">${nf(W.count, 'pessoa guardada', 'pessoas guardadas')}</h1>
      <p class="text-sm opacity-70">O Tagged já sabe reconhecê-${W.count === 1 ? 'la' : 'las'} nas fotos dos álbuns.</p></div></div>
     ${W.how === 'folder' ? `<p class="text-sm opacity-80"><b>Dica:</b> guarda uma cópia das tuas pessoas. Se mudares de computador ou de browser, carregas esse ficheiro em vez de repetir isto.</p>` : ''}
     <div class="card-actions"><button type="button" class="btn btn-primary btn-sm" data-act="onb-next">Continuar</button>
      ${W.how === 'folder' ? '<button type="button" class="btn btn-sm" data-act="people-export">Guardar uma cópia</button>' : ''}
      <button type="button" class="btn btn-sm btn-ghost" data-act="w-restart">Adicionar mais pessoas</button></div></div></div>`;
}
function extStatus() {
  const ok = EXT.ok && vcmp(EXT.v, EXT_MIN) >= 0, old = EXT.ok && !ok;
  return ok ? `<div class="alert alert-success text-sm" role="status"><span>✅ <b>Ligado ao Facebook.</b> ${EXT.fb ? 'E há um separador do Facebook aberto.' : 'Falta só abrires um álbum no Facebook quando quiseres importar.'}</span></div>`
    : old ? `<div class="alert alert-warning text-sm" role="status"><span>A ligação instalada é antiga. Descarrega a nova abaixo, substitui a pasta e, na página de extensões do Chrome, carrega no botão de recarregar do Tagged.</span></div>`
    : `<div class="alert text-sm" role="status"><span class="loading loading-spinner loading-sm"></span><span>À espera que instales… Quando estiver feito, isto muda sozinho.</span></div>`;
}
function extSteps() {
  const step = (n, t, d) => `<li class="flex gap-3"><span class="w-7 h-7 shrink-0 rounded-full bg-base-300 flex items-center justify-center text-sm font-bold" aria-hidden="true">${n}</span><div class="flex-1 min-w-0"><div class="font-medium">${t}</div>${d ? `<div class="text-sm opacity-70 mt-1">${d}</div>` : ''}</div></li>`;
  return `<ol class="space-y-4">
    ${step(1, 'Descarrega a extensão', `<a class="btn btn-primary btn-sm mt-1" href="/extension.zip" download>Descarregar extensão</a><div class="mt-2">Depois descomprime o ficheiro: fica uma pasta chamada <code>tagged-extension</code>.</div>`)}
    ${step(2, 'Abre a página de extensões do Chrome', `Copia este endereço, cola-o na barra de endereços do Chrome e carrega em Enter.<div class="mt-1 flex items-center gap-2"><code class="bg-base-300 px-2 py-1 rounded">chrome://extensions</code><button type="button" class="btn btn-xs" data-act="copy" data-t="chrome://extensions">Copiar</button></div>`)}
    ${step(3, 'Liga o “Modo de programador”', 'É o interruptor no canto superior direito dessa página.')}
    ${step(4, 'Carrega em “Carregar sem compactar”', 'E escolhe a pasta <code>tagged-extension</code> que descomprimiste.')}
    ${step(5, 'Volta aqui', 'Esta página deteta a extensão sozinha e mostra “Ligado”.')}</ol>`;
}
function onbExt() {
  const ok = EXT.ok && vcmp(EXT.v, EXT_MIN) >= 0;
  return `<h1 class="text-2xl font-bold mb-1">Liga o Tagged ao Facebook</h1>
   <p class="opacity-70 mb-4">O Tagged precisa de uma pequena <b>extensão do Chrome</b> para ir buscar as fotos ao álbum que abrires. Só se instala uma vez e só mexe no álbum que abrires, não em mais nada.</p>
   ${browserOk() ? '' : `<div class="alert alert-warning text-sm mb-4"><span>Esta parte só funciona no <b>Chrome</b> (ou Edge/Brave) <b>num computador</b>. Abre o Tagged lá para ligar ao Facebook.</span></div>`}
   <div class="mb-4">${extStatus()}</div>
   ${ok ? '' : `<div class="mb-5">${extSteps()}</div>`}
   <div class="flex flex-wrap items-center gap-3"><button type="button" class="btn btn-primary" data-act="onb-next" ${ok ? '' : 'disabled'}>Continuar</button>${laterLink()}</div>`;
}
function onbAlbum() {
  const ready = EXT.ok && vcmp(EXT.v, EXT_MIN) >= 0 && EXT.fb;
  const row = (done, t, d) => `<li class="flex gap-3 items-start"><span class="w-6 h-6 shrink-0 rounded-full flex items-center justify-center text-xs font-bold ${done ? 'bg-success text-success-content' : 'bg-base-300'}" aria-hidden="true">${done ? '✓' : '•'}</span><div><div class="font-medium">${t}</div>${done ? '' : `<div class="text-sm opacity-70">${d}</div>`}</div></li>`;
  return `<h1 class="text-2xl font-bold mb-1">Importa o teu primeiro álbum</h1>
   <p class="opacity-70 mb-4">Abre um álbum no Facebook, volta aqui e carrega no botão. O Tagged percorre o álbum sozinho.</p>
   <ul class="space-y-3 mb-5">${row(EXT.ok && vcmp(EXT.v, EXT_MIN) >= 0, 'Ligado ao Facebook', 'Falta o passo anterior.')}
    ${row(EXT.fb, 'Há um álbum aberto no Facebook', 'Noutro separador do Chrome, abre um álbum de fotos (a página com a grelha). Pode ser o de um evento a que foste.')}</ul>
   <div class="flex flex-wrap items-center gap-3"><button type="button" class="btn btn-primary" data-act="collect" ${ready ? '' : 'disabled'}>＋ Importar álbum do Facebook</button>${laterLink()}</div>
   ${ready ? '' : '<p class="text-sm opacity-60 mt-3">O botão acende quando as duas coisas acima estiverem feitas.</p>'}`;
}
function renderSetup() {
  const v = $('view');
  if (ONB.page === 'welcome') { v.innerHTML = onbWelcome(); return }
  const wide = ONB.page === 'people' && W.step === 'name';
  v.innerHTML = `<section class="${wide ? '' : 'max-w-3xl mx-auto'}">${stepper()}${ONB.page === 'people' ? onbPeople() : ONB.page === 'ext' ? onbExt() : onbAlbum()}</section>`;
  if (ONB.page === 'people') { if (W.step === 'process') setupProgress(); else if (W.step === 'name') { paintWCrops($('wgrid')); wSummary() } }
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
   ${i.p.w && i.p.h
     // Fill the viewport (thumbnails are small, max-* alone never upscales): the box keeps the photo's aspect ratio, as wide as
     // the screen allows and as tall as what is left under the controls, so the face boxes of the svg overlay stay aligned.
     ? `<div class="relative" style="aspect-ratio:${i.p.w}/${i.p.h};width:min(96vw,calc((100dvh - ${face ? 14 : 11}rem) * ${i.p.w / i.p.h}))"><img src="${i.p.url}" alt="" class="block w-full h-full rounded-lg">${svg(i)}</div>`
     : `<div class="relative inline-block"><img src="${i.p.url}" alt="" class="block max-h-[66dvh] max-w-[92vw] rounded-lg">${svg(i)}</div>`}
   <div class="flex flex-wrap items-center justify-center gap-2"><button type="button" class="btn btn-sm" data-act="nav" data-d="-1" ${k <= 0 ? 'disabled' : ''} aria-label="Anterior">←</button>${badges(i, 1)}
    <span class="text-sm opacity-70">${k + 1}/${CUR.length}</span>
    <button type="button" class="btn btn-sm ${on_ ? 'btn-success' : 'btn-outline'}" data-act="toggle" data-id="${i.id}">${on_ ? '✓ Vai ser descarregada' : 'Descarregar esta foto'} <span class="opacity-60">(espaço)</span></button>
    <button type="button" class="btn btn-sm" data-act="nav" data-d="1" ${k < 0 || k >= CUR.length - 1 ? 'disabled' : ''} aria-label="Seguinte">→</button><button type="button" class="btn btn-sm btn-ghost" data-act="lbclose">Fechar</button></div>
   ${i.faces.length ? `<div class="flex flex-wrap items-center justify-center gap-2"><span class="text-xs opacity-70">Quem aparece:</span>${i.faces.map(f => `<button type="button" class="rounded-lg border-2 ${FACE === f.i ? 'border-primary' : 'border-transparent'}" data-act="face" data-i="${f.i}" title="${f.name ? esc(faceLabel(f)) : 'sem nome'} · clica para dizer quem é"><canvas width="48" height="48" class="rounded-md block" data-crop="${i.id}:${f.i}"></canvas></button>`).join('')}</div>` : ''}
   ${face ? `<form class="flex flex-wrap items-center justify-center gap-2" data-form="face"><span class="text-sm">Quem é?</span>
     <input name="who" data-combo required class="input input-bordered input-sm w-56" value="${esc(face.name || '')}" aria-label="Nome da pessoa nesta cara">
     <button class="btn btn-sm btn-primary">Guardar nome</button>
     ${scoresOf(face).slice(0, 3).map(([n, s]) => `<button type="button" class="btn btn-xs btn-ghost" data-act="face-pick" data-n="${esc(n)}">${esc(n)} (${Math.round(s * 100)}%)</button>`).join('')}</form>` : ''}</div>`;
  if (!d.open) d.showModal();
  paintCrops($('lbbody'));
  const who = $('lbbody').querySelector('input[name=who]'); if (who) { who.focus(); who.select() }   // typing replaces the suggested name
}
$('lb').addEventListener('close', () => { if (LB !== null) closeBig() });
$('lb').addEventListener('click', e => { if (e.target === $('lb') || e.target === $('lbbody')) closeBig() });

/* ---------- name autocomplete: a small styled combobox instead of the browser's <datalist> popup ---------- */
// <input data-combo> (free text, e.g. naming a new person) or <input data-combo="only"> (an existing person, e.g. search).
// One shared list element, placed with position:fixed under the input; inside an open <dialog> it lives in the dialog so it
// is not hidden behind it (a modal <dialog> sits in the browser's top layer).
const CB = { el: null, input: null, items: [], active: -1 };
const fold = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const cbNames = () => S.view === 'setup' && W.step === 'name' ? [...new Set([...wNames(), ...PEOPLE])] : PEOPLE;
function cbMatches(q) {
  const names = cbNames(); if (!q) return names.slice(0, 100);
  const a = [], b = [];
  for (const n of names) { const f = fold(n); if (f.startsWith(q)) a.push(n); else if (f.includes(q)) b.push(n) }
  return [...a, ...b].slice(0, 100);
}
function cbClose() {
  if (CB.el) CB.el.classList.add('hidden');
  if (CB.input) { CB.input.setAttribute('aria-expanded', 'false'); CB.input.removeAttribute('aria-activedescendant') }
  CB.input = null; CB.active = -1;
}
function cbPlace() {
  const inp = CB.input, el = CB.el; if (!inp || !el || el.classList.contains('hidden')) return;
  if (!inp.isConnected) return cbClose();
  const r = inp.getBoundingClientRect(), w = Math.max(r.width, 240), left = Math.max(8, Math.min(r.left, innerWidth - w - 8));
  const below = innerHeight - r.bottom - 12, above = r.top - 12, up = below < 170 && above > below, room = Math.max(120, Math.min(288, up ? above : below));
  Object.assign(el.style, { left: left + 'px', width: w + 'px', maxHeight: room + 'px', top: up ? 'auto' : (r.bottom + 4) + 'px', bottom: up ? (innerHeight - r.top + 4) + 'px' : 'auto' });
}
function cbRender() {
  const inp = CB.input; if (!inp || !inp.isConnected) return cbClose();
  const raw = inp.value.trim(), q = fold(raw), only = inp.dataset.combo === 'only';
  CB.items = cbMatches(q);
  const hl = n => { const nn = n.normalize('NFC'), f = fold(nn), k = q ? f.indexOf(q) : -1;
    return k >= 0 && f.length === nn.length ? `${esc(nn.slice(0, k))}<b class="text-primary">${esc(nn.slice(k, k + q.length))}</b>${esc(nn.slice(k + q.length))}` : esc(nn) };
  const exact = CB.items.some(n => fold(n) === q);
  CB.el.innerHTML = CB.items.map((n, i) => `<div role="option" id="cb-${i}" data-i="${i}" aria-selected="${i === CB.active}" class="px-3 py-2 text-sm cursor-pointer flex items-baseline gap-2 ${i === CB.active ? 'bg-primary text-primary-content' : 'hover:bg-base-200'}"><span class="truncate">${hl(n)}</span>${PE[n] ? `<span class="ml-auto text-xs opacity-60 shrink-0">${nf(PE[n].k, 'foto de exemplo', 'fotos de exemplo')}</span>` : ''}</div>`).join('')
    + (!CB.items.length && (only || !raw) ? `<div class="px-3 py-3 text-sm opacity-70">${only ? 'Ninguém com esse nome.' : raw ? '' : 'Ainda não há pessoas.'}</div>` : '')
    + (!only && raw && !exact ? `<div class="px-3 py-2 text-xs opacity-70 border-t border-base-300 sticky bottom-0 bg-base-100">Pessoa nova: <b>${esc(raw)}</b>. Carrega em Enter para guardar.</div>` : '');
  if (CB.active >= 0) inp.setAttribute('aria-activedescendant', 'cb-' + CB.active); else inp.removeAttribute('aria-activedescendant');
  cbPlace();
}
function cbOpen(inp) {
  const host = inp.closest('dialog[open]') || document.body;
  if (!CB.el || CB.el.parentNode !== host) {
    if (CB.el) CB.el.remove();
    const el = document.createElement('div'); el.id = 'cb-list'; el.setAttribute('role', 'listbox');
    el.className = 'fixed z-[2000] overflow-y-auto overscroll-contain rounded-xl border border-base-300 bg-base-100 shadow-2xl py-1 hidden';
    el.addEventListener('mousedown', ev => ev.preventDefault());   // keep the focus in the input while clicking an option
    el.addEventListener('click', ev => { const it = ev.target.closest('[data-i]'); if (it) cbPick(+it.dataset.i) });
    host.append(el); CB.el = el;
  }
  CB.input = inp; CB.active = -1;
  inp.setAttribute('role', 'combobox'); inp.setAttribute('aria-autocomplete', 'list'); inp.setAttribute('aria-controls', 'cb-list'); inp.setAttribute('aria-expanded', 'true'); inp.setAttribute('autocomplete', 'off');
  CB.el.classList.remove('hidden'); cbRender();
}
function cbPick(i) {
  const inp = CB.input, v = CB.items[i]; if (!inp || v == null) return;
  inp.value = v; inp.dispatchEvent(new Event('input', { bubbles: true })); inp.dispatchEvent(new Event('change', { bubbles: true }));
  cbClose(); inp.focus();
}
const isCombo = t => t && t.matches && t.matches('input[data-combo]');
document.addEventListener('focusin', e => { if (isCombo(e.target)) cbOpen(e.target) });
document.addEventListener('click', e => { if (isCombo(e.target) && CB.input !== e.target) cbOpen(e.target) });
document.addEventListener('input', e => { if (isCombo(e.target)) { if (CB.input !== e.target) cbOpen(e.target); else { CB.active = -1; cbRender() } } });
document.addEventListener('change', e => { if (CB.input && e.target === CB.input) cbClose() });
document.addEventListener('focusout', e => { if (CB.input && e.target === CB.input) setTimeout(() => { if (document.activeElement !== CB.input) cbClose() }, 0) });
document.addEventListener('keydown', e => {
  const inp = CB.input; if (!inp || e.target !== inp) return;
  const n = CB.items.length;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault(); if (!n) return;
    CB.active = e.key === 'ArrowDown' ? (CB.active + 1) % n : (CB.active - 1 + n) % n; cbRender();
    const a = $('cb-' + CB.active); if (a) a.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter' && CB.active >= 0) { e.preventDefault(); e.stopPropagation(); cbPick(CB.active) }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cbClose() }   // closes the list only, not the dialog around it
  else if (e.key === 'Tab') cbClose();
}, true);
window.addEventListener('resize', cbPlace); window.addEventListener('scroll', cbPlace, true);

/* ---------- keyboard ---------- */
const HELP = `<table class="table table-sm"><tbody>
 <tr><td><kbd class="kbd kbd-sm">←</kbd> <kbd class="kbd kbd-sm">→</kbd> <kbd class="kbd kbd-sm">↑</kbd> <kbd class="kbd kbd-sm">↓</kbd></td><td>mudar de foto</td></tr>
 <tr><td><kbd class="kbd kbd-sm">Enter</kbd></td><td>ampliar a foto</td></tr>
 <tr><td><kbd class="kbd kbd-sm">espaço</kbd></td><td>marcar / desmarcar para descarregar</td></tr>
 <tr><td><kbd class="kbd kbd-sm">P</kbd></td><td>marcar e passar à seguinte</td></tr>
 <tr><td><kbd class="kbd kbd-sm">X</kbd></td><td>deixar de fora e passar à seguinte</td></tr>
 <tr><td><kbd class="kbd kbd-sm">1</kbd>–<kbd class="kbd kbd-sm">4</kbd></td><td>mudar de grupo (Reconhecidas, Para confirmar, Outras, Caras novas)</td></tr>
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
  if (!EXT.ok) return popup('Falta ligar ao Facebook', '<p>As fotos em boa qualidade vêm do Facebook, e para isso o Tagged precisa da ligação ao Facebook.</p><div class="mt-3"><button type="button" class="btn btn-primary btn-sm" data-act="goto" data-v="extension">Mostrar como se faz</button></div>');
  if (!EXT.fb) return popup('Abre o álbum no Facebook', `<p>As fotos em boa qualidade vêm do álbum aberto no Facebook. Abre-o noutro separador${cur.albumUrl ? ' (botão “Ver no Facebook”)' : ''} e tenta de novo.</p>`);
  if (cur.albumUrl && EXT.fbUrl && albumId(cur.albumUrl) !== albumId(EXT.fbUrl)) {
    if (confirm('O separador do Facebook não está neste álbum. Abrir lá o álbum agora? Quando carregar, carrega outra vez em Descarregar.')) send({ t: 'open', url: cur.albumUrl });
    return;
  }
  if (!cur.date && !confirm('Este álbum não tem data definida: as fotos ficam sem data (o Google Fotos vai usar a de hoje). Continuar mesmo assim?')) return;
  const tokenP = mode === 'gphotos' ? googleToken() : null;   // asked now, inside the click, so the Google popup is not blocked
  const base = slug(cur.name), names = {};
  A.forEach((i, k) => names[i.p.key] = `${base}_${String(k + 1).padStart(4, '0')}.jpg`);
  DL = { mode, tokenP, n: 0, total: A.length, files: {}, kind: {}, names, base, s: cur, order: A.map(i => i.p.key), date: cur.date, t0: performance.now(), ms: [] };
  if (tokenP) tokenP.catch(e => { if (DL && DL.tokenP === tokenP) { send({ t: 'stop' }); DL = null; badge(); render(); note('Google: ' + e.message, true) } });
  send({ t: 'full', keys: DL.order }); badge(); render();
}
/* Search view: download the ticked photos. Each is fetched by its own Facebook link (stored when the album was imported),
   so it does not matter which album, or which Facebook tab, is open. */
function downloadFound() {
  if (DL || collecting || !Q.list || !qPicked().length) return;
  if (!EXT.ok) return popup('Falta ligar ao Facebook', '<p>As fotos em boa qualidade vêm do Facebook, e para isso o Tagged precisa da ligação ao Facebook.</p><div class="mt-3"><button type="button" class="btn btn-primary btn-sm" data-act="goto" data-v="extension">Mostrar como se faz</button></div>');
  if (vcmp(EXT.v, '0.8.0') < 0) return popup('Falta atualizar a ligação ao Facebook', '<p>Para buscar fotos de vários álbuns de uma vez, a ligação ao Facebook tem de estar na versão mais recente. Atualiza-a e tenta outra vez.</p><div class="mt-3"><button type="button" class="btn btn-primary btn-sm" data-act="goto" data-v="extension">Mostrar como se faz</button></div>');
  const base = slug(Q.name), meta = {}, names = {}, order = [], todo = [], seen = new Set(); let undated = 0, nolink = 0;
  const idx = new Map();
  qPicked().sort((a, b) => ((sessOf(a.sid) || {}).date || '').localeCompare((sessOf(b.sid) || {}).date || '')).forEach(h => {
    if (seen.has(h.key)) return; seen.add(h.key);
    const s = sessOf(h.sid) || {}, n = (idx.get(h.sid) || 0) + 1; idx.set(h.sid, n);
    const d = s.date ? new Date(s.date) : null; if (d) d.setSeconds(d.getSeconds() + n - 1); else undated++;
    meta[h.key] = { bytes: h.bytes, date: d, who: `${Q.name} ${h.score.toFixed(2)}` }; names[h.key] = `${base}_${String(order.length + 1).padStart(4, '0')}.jpg`; order.push(h.key);
    if (h.href) todo.push({ key: h.key, href: h.href }); else { nolink++; meta[h.key].skip = 'sem link: importa este álbum outra vez' }
  });
  if (!todo.length) return popup('Falta o link das fotos', '<p>Estes álbuns foram importados antes de o Tagged guardar o link de cada foto, por isso não consigo ir buscar as fotos em boa qualidade. <b>Importa os álbuns outra vez</b> e volta a tentar.</p>');
  if (!confirm(`Vou buscar ${nf(todo.length, 'foto', 'fotos')} de ${Q.name} ao Facebook. Vão abrir-se e fechar-se separadores sozinhos durante uns minutos: deixa o Chrome aberto.` + (nolink ? `\n\n${nf(nolink, 'foto fica', 'fotos ficam')} em miniatura, porque o álbum foi importado antes de guardarmos o link.` : '') + (undated ? `\n\n${nf(undated, 'foto fica', 'fotos ficam')} sem data, porque o álbum não tem data definida.` : '') + '\n\nContinuar?')) return;
  DL = { mode: 'zip', files: {}, kind: {}, n: 0, total: todo.length, names, base, s: { id: 0, name: Q.name, map: {} }, meta, order, date: null, t0: performance.now(), ms: [] };
  order.forEach(k => { if (meta[k].skip) DL.kind[k] = 'miniatura (' + meta[k].skip + ')' });
  badge(); render(); qCount(); send({ t: 'full-pages', items: todo });
}
function stopAll() { send({ t: 'stop' }); if (DL) DL.stopping = true; render() }
function onFull(m) {
  if (!DL) return; const p = DL.meta ? DL.meta[m.key] : DL.s.map[m.key], name = DL.names[m.key];
  if (!p || !name || DL.files[name]) return;
  DL.n++;
  if (m.b64) { DL.files[name] = b64(m.b64); DL.kind[m.key] = `original ${m.w}x${m.h}` }
  else { DL.files[name] = p.bytes; DL.kind[m.key] = 'miniatura (' + (m.error || 'sem original') + ')' }
  if (m.ms) DL.ms.push({ ficheiro: name, ...m.ms });
  render(); tryFinish();
}
function tryFinish() { if (DL && DL.done && DL.n >= DL.processed) finishDL() }
function exifDate(key) {   // (search download: each photo's own album date) album date + the photo's position in the album as seconds, so Google Photos keeps the album order
  if (DL.meta) return DL.meta[key].date;
  if (!DL.date) return null; const d = new Date(DL.date); d.setSeconds(d.getSeconds() + Math.max(0, DL.order.indexOf(key))); return d;
}
async function finishDL() {
  if (!DL || DL.finishing) return;
  const D = DL; D.finishing = true; render(); await sleep(30);
  const files = {}, mt = {}, people = key => D.meta ? D.meta[key].who : info(D.s.map[key]).faces.filter(f => f.c !== 'sem match').map(f => `${f.name} ${f.score.toFixed(2)}`).join('; ');
  const rows = [['ficheiro', 'original_facebook', 'data_exif', 'pessoas', 'tipo']];
  for (const key of D.order) {
    const nm = D.names[key], d = exifDate(key);
    let data = D.files[nm]; if (!data) { data = (D.meta ? D.meta[key] : D.s.map[key]).bytes; D.kind[key] ||= 'miniatura (não obtida)' }
    files[nm] = d ? setExif(data, d) : data; if (d) mt[nm] = d;
    rows.push([nm, key, d ? localISO(d).replace('T', ' ') : '', people(key), D.kind[key]]);
  }
  if (D.ms.length) console.table(D.ms);   // timings per photo, for tuning the extension
  const orig = rows.filter(r => /^original/.test(r[4])).length, thumbs = rows.length - 1 - orig, wall = (performance.now() - D.t0) / 1000;
  const summary = nf(orig, 'original', 'originais') + (thumbs ? ` e ${nf(thumbs, 'miniatura', 'miniaturas')}` : '');
  try {
    if (D.mode === 'gphotos') {
      DL = null; GP = { title: 'A enviar para o Google Fotos…', t0: performance.now(), n: 0, total: D.order.length }; render();
      const r = await uploadGoogle(D, files);
      doneInfo = { title: `${nf(r.ok, 'foto enviada', 'fotos enviadas')} para o Google Fotos`, sub: `álbum “${D.s.name}” · ${summary}` + (r.failed ? ` · ${r.failed} falharam` : '') };
      if (r.failed) note(`${nf(r.failed, 'foto não foi aceite', 'fotos não foram aceites')} pelo Google Fotos: ${r.firstError}`, true);
    } else {
      files['_resumo.csv'] = new TextEncoder().encode(rows.map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\n'));
      const zip = fflate.zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, [v, mt[k] ? { level: 0, mtime: mt[k] } : { level: 0 }]])));
      saveBlob(D.base + '.zip', new Blob([zip], { type: 'application/zip' }));
      doneInfo = { title: `Fotos prontas: ${nf(rows.length - 1, 'foto', 'fotos')}`, sub: `${summary} em ${fmtT(wall)} · está a descarregar um ficheiro .zip: descomprime-o para ver as fotos` };
      if (thumbs) { const why = [...new Set(rows.filter(r => /^miniatura/.test(r[4])).map(r => r[4].replace(/^miniatura \(|\)$/g, '')))].join('; '); note(`${thumbs === 1 ? '1 foto foi' : thumbs + ' fotos foram'} no tamanho da miniatura. Motivo: ${why}. (O _resumo.csv, dentro do zip, diz quais.)`, true) }
    }
    doneUntil = Date.now() + 9000;
  } catch (e) { note((D.mode === 'gphotos' ? 'Google Fotos: ' : '') + (e.message || e), true) }
  finally { if (DL === D) DL = null; GP = null; badge(); if (cur === D.s && S.view === 'session') draw(); if (S.view === 'search') renderSearch(); updateProg() }
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
  GP.title = 'A organizar as fotos no álbum…'; updateProg();
  let ok = 0, failed = 0, firstError = '';
  for (let k = 0; k < items.length; k += 50) {   // the API takes at most 50 per call
    const d = await (await gcall('mediaItems:batchCreate', token, JSON.stringify({ albumId: album.id, newMediaItems: items.slice(k, k + 50) }), json)).json();
    for (const x of d.newMediaItemResults || []) { if (x.mediaItem) ok++; else { failed++; firstError ||= x.status && x.status.message || '' } }
  }
  return { ok, failed, firstError };
}

/* ---------- Ajuda: connection to Facebook, what the colours mean, answers, shortcuts ---------- */
function viewExtension() {
  const dot = c => `<span class="inline-block w-3 h-3 rounded-full align-middle mr-1" style="background:${c}" aria-hidden="true"></span>`;
  const faq = (q, a) => `<div class="collapse collapse-arrow bg-base-100 shadow mb-2"><input type="checkbox" aria-label="${esc(q)}"><div class="collapse-title font-medium">${q}</div><div class="collapse-content text-sm opacity-80 space-y-2">${a}</div></div>`;
  $('view').innerHTML = `<h1 class="text-2xl font-bold mb-1">Ajuda</h1><p class="text-sm opacity-70 mb-6">Tudo o que precisas para usar o Tagged, em poucas palavras.</p>
  <section class="card bg-base-100 shadow mb-6" id="ligar"><div class="card-body gap-4"><h2 class="card-title">Ligação ao Facebook</h2>
   <p class="text-sm opacity-70">É uma pequena extensão do Chrome que o Tagged usa para ir buscar as fotos do álbum que tens aberto. Só se instala uma vez.${EXT.ok ? ` Versão instalada: ${esc(EXT.v)}${CFG.extension ? ` (a mais recente é a ${esc(CFG.extension)})` : ''}.` : ''}</p>
   ${browserOk() ? '' : '<div class="alert alert-warning text-sm"><span>Só funciona no <b>Chrome</b> (ou Edge/Brave) num computador.</span></div>'}
   ${extStatus()}
   <details ${EXT.ok && vcmp(EXT.v, EXT_MIN) >= 0 ? '' : 'open'}><summary class="cursor-pointer text-sm font-medium mb-3">${EXT.ok ? 'Como instalar ou atualizar' : 'Como instalar'}</summary>${extSteps()}</details></div></section>
  <section class="card bg-base-100 shadow mb-6"><div class="card-body gap-3"><h2 class="card-title">O que significam as cores?</h2><ul class="space-y-2 text-sm">
   <li>${dot(COL.certeza)}<b>Reconhecidas</b>: tenho a certeza de quem é. Já vêm marcadas para descarregar.</li>
   <li>${dot(COL['rever'])}<b>Para confirmar</b>: parece-me alguém, mas não tenho a certeza. Tu decides (“talvez Ana”).</li>
   <li>${dot(COL['sem match'])}<b>Outras</b>: não reconheci nenhum dos teus amigos.</li>
   <li>🙂 <b>Caras novas</b>: caras que se repetem e que ainda não sei quem são. Dá-lhes um nome e passo a reconhecê-las.</li></ul></div></section>
  <section class="mb-6"><h2 class="text-lg font-semibold mb-2">Perguntas frequentes</h2>
   ${faq('As minhas fotos ficam guardadas em algum sítio?', '<p>Ficam só neste browser, no teu computador. Quando importas um álbum, cada foto passa pelo servidor do Tagged apenas para encontrar as caras e não é guardada lá.</p>')}
   ${faq('Porque tenho de deixar o Facebook aberto?', '<p>As fotos em boa qualidade só se conseguem a partir do álbum aberto na tua conta. O Tagged abre cada uma por ti, devagar, como se estivesses a ver o álbum. Deixa esse separador do Chrome aberto até acabar.</p>')}
   ${faq('Há algum risco para a minha conta do Facebook?', '<p>O Tagged só trabalha no álbum que abriste, com pausas e ao ritmo de uma pessoa, e nunca guarda a tua palavra-passe. Mesmo assim, o Facebook não gosta de automatismos: usa com moderação e evita importar muitos álbuns seguidos.</p>')}
   ${faq('Reconheceu a pessoa errada. E agora?', '<p>Abre a foto, clica na cara e diz quem é: o Tagged aprende com isso. Se achas que anda a marcar demais ou de menos, usa “Ajustar o reconhecimento” dentro do álbum.</p>')}
   ${faq('Posso usar noutro computador?', '<p>Sim. Em <b>Pessoas</b> carrega em “Guardar cópia” e depois, no outro computador, “Carregar ficheiro”. Os álbuns importados não vão na cópia: importa-os outra vez.</p>')}
   ${faq('Como mudo quem é reconhecido?', '<p>Em <b>Pessoas</b> podes ligar ou desligar cada pessoa, adicionar mais ou remover. Os álbuns já importados atualizam-se sozinhos.</p>')}</section>
  <section class="card bg-base-100 shadow"><div class="card-body gap-2"><h2 class="card-title">Atalhos de teclado</h2><p class="text-sm opacity-70">Dentro de um álbum, para despachar fotos depressa.</p>${HELP}</div></section>`;
}

/* ---------- settings: people, storage ---------- */
function viewSettings() {
  $('view').innerHTML = `<div class="flex flex-wrap items-end gap-3 mb-6" id="drop"><div class="flex-1 min-w-[16rem]"><h1 class="text-2xl font-bold">Pessoas</h1>
   <p class="text-sm opacity-70">Os amigos que o Tagged sabe reconhecer. Ficam guardados só neste browser.</p></div>
   <button type="button" class="btn btn-primary btn-sm" data-act="onb" data-v="people">＋ Adicionar pessoas</button>
   <label class="btn btn-sm" title="Carrega um ficheiro de pessoas (people.npz) que tenhas guardado. Também podes largá-lo aqui.">Carregar ficheiro<input type="file" class="hidden" multiple accept=".npz,.npy,.zip" data-chg="files"></label>
   <button type="button" class="btn btn-sm" data-act="people-export" ${PEOPLE.length ? '' : 'disabled'} title="Guarda as tuas pessoas num ficheiro, para usares noutro computador ou como cópia de segurança">Guardar cópia</button></div>
  <p id="pmsg" class="text-sm mb-3"></p>
  ${PEOPLE.length ? `<section class="card bg-base-100 shadow mb-6"><div class="card-body gap-3">
   <p class="text-sm opacity-70">Só as pessoas com o interruptor ligado são reconhecidas nas fotos. Podes desligar quem não te interessa sem a apagar. Os álbuns atualizam-se sozinhos.</p>
   <div class="flex flex-wrap gap-2 items-center"><input id="psearch" class="input input-bordered input-sm" placeholder="Procurar uma pessoa…" aria-label="Procurar pessoas" data-inp="psearch" value="${esc(S.search)}">
    <button type="button" class="btn btn-sm" data-act="all" data-v="1">Ligar todas</button><button type="button" class="btn btn-sm btn-ghost" data-act="all" data-v="0">Desligar todas</button><span id="pcount" class="text-sm opacity-70"></span></div>
   <div id="plist" class="grid sm:grid-cols-2 lg:grid-cols-3 gap-1"></div></div></section>`
   : `<section class="card bg-base-100 shadow mb-6 border border-warning/50"><div class="card-body items-center text-center gap-2 py-10"><div class="text-4xl" aria-hidden="true">👥</div><h2 class="text-lg font-semibold">Ainda não há pessoas</h2>
    <p class="text-sm opacity-70 max-w-md">Escolhe uma pasta com fotos dos teus amigos e diz quem é quem, ou carrega um ficheiro que já tenhas.</p><button type="button" class="btn btn-primary btn-sm" data-act="onb" data-v="people">Adicionar pessoas</button></div></section>`}
  <details class="card bg-base-100 shadow"><summary class="card-body p-4 cursor-pointer font-medium">Avançado</summary><div class="px-4 pb-4 space-y-3">
   <p id="storage" class="text-sm opacity-70">…</p>
   <button type="button" class="btn btn-sm btn-ghost text-error" data-act="people-clear" ${PEOPLE.length ? '' : 'disabled'}>Apagar todas as pessoas</button></div></details>`;
  const dz = $('drop'); dz.ondragover = e => e.preventDefault(); dz.ondrop = e => { e.preventDefault(); loadPeopleFiles(e.dataTransfer.files) };
  if (PEOPLE.length) renderPeople(); renderStorage();
}
async function renderStorage() {
  const e = $('storage'); if (!e) return;
  try {
    const [est, per] = await Promise.all([navigator.storage.estimate(), navigator.storage.persisted()]);
    e.innerHTML = `Os álbuns e as pessoas ocupam ${(est.usage / 2 ** 20).toFixed(0)} MB neste browser. ` + (per ? 'Estão <b>protegidos</b>: o Chrome não os apaga sozinho.'
      : `Se o disco ficar cheio, o Chrome pode apagá-los. <button type="button" class="btn btn-xs" data-act="persist">Proteger</button>`);
  } catch (err) { e.textContent = 'Sem informação de armazenamento.' }
}
function renderPeople() {
  const q = S.search.toLowerCase(), c = $('pcount'), l = $('plist'); if (!c || !l) return;
  c.textContent = `${PEOPLE.filter(on).length} de ${PEOPLE.length} a ser reconhecidas`;
  const list = PEOPLE.filter(n => n.toLowerCase().includes(q));
  l.innerHTML = list.length ? list.map(n => `<div class="flex items-center gap-1 rounded-lg hover:bg-base-200 px-2 py-1"><label class="flex items-center gap-3 flex-1 min-w-0 cursor-pointer"><input type="checkbox" class="toggle toggle-success toggle-sm" ${on(n) ? 'checked' : ''} data-chg="person-on" data-n="${esc(n)}" aria-label="Reconhecer ${esc(n)}"><span class="truncate"><b class="font-medium">${esc(n)}</b> <span class="opacity-60 text-xs">${nf(PE[n].k, 'foto de exemplo', 'fotos de exemplo')}${PE[n].added ? ` (+${PE[n].added} novas)` : ''}</span></span></label>${PE[n].added ? `<button type="button" class="btn btn-ghost btn-xs" title="desfazer as ${PE[n].added} caras que acrescentaste" aria-label="Desfazer as caras acrescentadas a ${esc(n)}" data-act="people-undo" data-n="${esc(n)}">↶</button>` : ''}<button type="button" class="btn btn-ghost btn-xs" title="Apagar ${esc(n)}" aria-label="Apagar ${esc(n)}" data-act="people-del" data-n="${esc(n)}">✕</button></div>`).join('') : '<div class="opacity-70 text-sm col-span-full">Ninguém com esse nome.</div>';
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
    'q-open': () => { const h = Q.list[+t.dataset.i]; if (h) openResult(h.sid, h.key) }, 'q-sess': () => { Q.sess = t.dataset.sid ? +t.dataset.sid : null; Q.shown = 60; renderSearch() },
    'q-dl': downloadFound,
    'q-tog': () => { const h = Q.list[+t.dataset.i]; if (h) { t.checked ? Q.off.delete(qid(h)) : Q.off.add(qid(h)); qCount() } },
    'q-all': () => { Q.list.forEach(h => t.dataset.v === '1' ? Q.off.delete(qid(h)) : Q.off.add(qid(h))); renderSearch() }, 'q-more': () => { Q.shown += 60; renderSearch() },
    goto: () => { const m = $('modal'); if (m.open) m.close(); setView(t.dataset.v) }, onb: () => openOnboarding(t.dataset.v),
    'w-step': () => { W.err = ''; W.step = t.dataset.v; renderSetup() }, 'w-run': setupRun, 'w-cancel': () => { setupReset(); renderSetup() }, 'w-restart': () => { setupReset(); W.step = 'folder'; renderSetup() },
    'onb-next': onbNext, 'onb-later': onbLater, copy: () => copyText(t.dataset.t, t), 'w-commit': setupCommit,
    'w-ignore': () => { W.clusters[+t.dataset.n].skip = true; const el = $('wc-' + t.dataset.n); if (el) el.remove() },
    'w-unstage': () => { const c = W.clusters[+t.dataset.n]; c.staged = false; c.name = ''; const el = $('wc-' + t.dataset.n); if (el) { el.innerHTML = wCard(+t.dataset.n); paintWCrops(el) } wSummary() },
    'w-more': () => { W.shown += 48; renderSetup() }, 'w-small': () => { W.minSize = W.minSize > 2 ? 2 : 3; W.shown = 48; renderSetup() },
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
  else if (c === 'wfiles') { setupPick(t.files); t.value = '' }
  else if (c === 'qperson') { const v = t.value.trim(), hit = PEOPLE.find(n => n.toLowerCase() === v.toLowerCase()); Q.name = hit || v; if (hit) t.value = hit; runSearch() }
});
document.addEventListener('input', e => {
  const c = e.target.dataset && e.target.dataset.inp; if (!c) return;
  if (c === 'rigor') onRigor(+e.target.value);
  else if (c === 'psearch') { S.search = e.target.value; renderPeople() }
  else if (c === 'qmin') { Q.min = +e.target.value; $('qminv').textContent = qLabel(Q.min); Q.shown = 60; clearTimeout(Q.t); Q.t = setTimeout(renderSearch, 80) }
});
function nameFace(who) {
  const i = info(rawOf(LB)), f = FACE != null && i.faces[FACE]; if (!f || !f.emb) return;
  addRefs(who, [f.emb]).then(() => { FACE = null; lb() });
}
document.addEventListener('submit', e => {
  const f = e.target, kind = f.dataset && f.dataset.form; if (!kind) return;
  e.preventDefault(); const who = f.elements.who.value.trim(); if (!who) return;
  if (kind === 'wname') stageCluster(+f.dataset.n, who);
  else if (kind === 'face') nameFace(who);
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
  } catch (e) { note('Este browser não deixa guardar dados, por isso os álbuns não ficam guardados.', true) }
  let seen = false; try { seen = !!localStorage.getItem('tagged.setup') } catch (e) { }
  setView(!PEOPLE.length && !SESS.length && !seen ? 'setup' : 'sessions');
})();
