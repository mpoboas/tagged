"""The webapp: photos arrive from the browser extension into a session, get scored by the API, are reviewed here,
and leave as a zip named <session>_XXXX.jpg."""

PAGE = r"""<!doctype html><html data-theme=dark><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>tagged</title>
<link href="https://cdn.jsdelivr.net/npm/daisyui@4.12.14/dist/full.min.css" rel=stylesheet>
<script src="https://cdn.tailwindcss.com/3.4.16"></script>
<script src="https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js"></script>
<body class="bg-base-200 min-h-screen">
<div class="max-w-7xl mx-auto p-4">
 <div class="navbar bg-base-100 rounded-box shadow mb-4 flex-wrap gap-2">
  <div class="flex-1 text-xl font-bold px-2">tagged <span id=ext class="badge badge-warning ml-2 h-auto whitespace-nowrap">extensão não detetada</span></div>
  <div role=tablist class="tabs tabs-boxed" id=nav></div>
  <button id=go class="btn btn-primary btn-sm" onclick="collect()">Obter fotos do Facebook</button>
 </div>
 <div id=msg class="alert mb-4 text-sm hidden"></div>
 <div id=view></div>
</div>
<dialog id=modal class="modal"><div class="modal-box"><h3 class="font-bold text-lg" id=mtitle></h3><p class="py-4" id=mtext></p>
 <div class="modal-action"><form method=dialog><button class="btn btn-primary">Percebido</button></form></div></div><form method=dialog class="modal-backdrop"><button>fechar</button></form></dialog>
<div id=lb class="fixed inset-0 z-50 bg-black/90 hidden items-center justify-center p-4" onclick="if(event.target===this)closeBig()"></div>
<script>
const EXT_MIN='0.6.0';
const COL={certeza:'#22c55e',rever:'#f59e0b','sem match':'#64748b'};
const S={certain:.5,review:.35,tab:'certeza',person:'',view:'sessions',search:''};
let SESS=[],cur=null,LIVE=null,PEOPLE=[],CUR=[],LB=null,DL=null,collecting=false;
const cfg=(()=>{try{return JSON.parse(localStorage.getItem('tagged.cfg')||'{}')}catch(e){return{}}})();cfg.off=new Set(cfg.off||[]);
const saveCfg=()=>localStorage.setItem('tagged.cfg',JSON.stringify({off:[...cfg.off]}));
const on=n=>!cfg.off.has(n);
const send=m=>window.postMessage({src:'tagged-web',...m},location.origin);
const $=id=>document.getElementById(id);
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const b64=s=>{const b=atob(s),a=new Uint8Array(b.length);for(let i=0;i<b.length;i++)a[i]=b.charCodeAt(i);return a};
const slug=s=>s.normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^A-Za-z0-9]+/g,'_').replace(/^_+|_+$/g,'')||'album';
const fmt=t=>new Date(t).toLocaleString('pt-PT',{dateStyle:'short',timeStyle:'short'});
let rq=0;const render=()=>{cancelAnimationFrame(rq);rq=requestAnimationFrame(()=>{if(S.view==='session'&&cur)draw()})};

/* ---------- storage: IndexedDB (sessions survive reloads) ---------- */
let db;
const dbOpen=()=>new Promise((res,rej)=>{const r=indexedDB.open('tagged',1);r.onupgradeneeded=()=>{r.result.createObjectStore('meta',{keyPath:'id'});r.result.createObjectStore('data',{keyPath:'id'})};r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});
const idb=(st,mode,fn)=>new Promise((res,rej)=>{const t=db.transaction(st,mode),r=fn(t.objectStore(st));t.oncomplete=()=>res(r&&r.result);t.onerror=()=>rej(t.error)});
const timers={};
function saveSoon(s){clearTimeout(timers[s.id]);timers[s.id]=setTimeout(()=>saveNow(s),700)}
async function saveNow(s){if(!db)return;const A=s.photos.map(info);
 const meta={id:s.id,name:s.name,created:s.created,expected:s.expected,auto:s.auto,date:s.date||null,dateManual:!!s.dateManual,lmMin:s.lmMin??null,count:s.photos.length,certeza:A.filter(p=>p.c==='certeza').length,sel:A.filter(sel).length};
 const i=SESS.findIndex(x=>x.id===s.id);if(i<0)SESS.unshift(meta);else SESS[i]=meta;
 await idb('meta','readwrite',st=>st.put(meta));
 await idb('data','readwrite',st=>st.put({id:s.id,photos:s.photos.map(p=>({key:p.key,bytes:p.bytes,faces:p.faces,w:p.w,h:p.h,sel:p.sel}))}))}

/* ---------- EXIF: Facebook strips it, so write the album date into every JPEG ---------- */
function setExif(src, dt) {            // dt: "YYYY:MM:DD HH:MM:SS"
  if (!(src[0] === 0xFF && src[1] === 0xD8)) return src;
  const str = new TextEncoder().encode(dt + "\0");   // 20 bytes
  const tiff = new Uint8Array(128), v = new DataView(tiff.buffer);
  tiff.set([0x49, 0x49, 0x2A, 0x00]); v.setUint32(4, 8, true);
  const ent = (o, tag, type, cnt, val) => { v.setUint16(o, tag, true); v.setUint16(o + 2, type, true); v.setUint32(o + 4, cnt, true); v.setUint32(o + 8, val, true); };
  v.setUint16(8, 2, true); ent(10, 0x0132, 2, 20, 38); ent(22, 0x8769, 4, 1, 58); v.setUint32(34, 0, true);   // IFD0: DateTime, ExifIFD
  tiff.set(str, 38);
  v.setUint16(58, 2, true); ent(60, 0x9003, 2, 20, 88); ent(72, 0x9004, 2, 20, 108); v.setUint32(84, 0, true); // Exif: DateTimeOriginal, DateTimeDigitized
  tiff.set(str, 88); tiff.set(str, 108);
  const len = 2 + 6 + tiff.length, app = new Uint8Array(2 + len);
  app.set([0xFF, 0xE1, len >> 8, len & 255, 0x45, 0x78, 0x69, 0x66, 0, 0]); app.set(tiff, 10);
  const parts = [src.subarray(0, 2), app]; let i = 2;
  while (i + 4 <= src.length && src[i] === 0xFF && src[i + 1] !== 0xDA && src[i + 1] !== 0xD9) {   // keep other segments, drop any old Exif
    const l = (src[i + 2] << 8) | src[i + 3];
    if (!(src[i + 1] === 0xE1 && src[i + 4] === 0x45 && src[i + 5] === 0x78)) parts.push(src.subarray(i, i + 2 + l));
    i += 2 + l;
  }
  parts.push(src.subarray(i));
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/* ---------- extension bridge ---------- */
window.addEventListener('message',e=>{const m=e.data;if(e.source!==window||!m||m.src!=='tagged-ext')return;onExt(m)});
function onExt(m){
 if(m.t==='bridge'||m.t==='ready'){const x=$('ext');const old=!m.v||m.v<EXT_MIN;x.textContent=old?`extensão desatualizada (${m.v||'?'}) · recarrega-a`:(m.fb?'extensão ligada · Facebook aberto':'extensão ligada · abre um álbum do Facebook');x.className='badge ml-2 h-auto whitespace-nowrap '+(old?'badge-error':m.fb?'badge-success':'badge-info')}
 else if(m.t==='meta'&&LIVE){LIVE.gotMeta=true;if(LIVE.auto&&m.title){LIVE.name=m.title;const t=$('title');if(t&&cur===LIVE)t.value=m.title}LIVE.expected=m.expected||null}
 else if(m.t==='thumb'&&LIVE)addThumb(LIVE,m);
 else if(m.t==='collect-done'){collecting=false;$('go').disabled=false;
  if(LIVE){if(LIVE.auto&&m.title)LIVE.name=m.title;if(LIVE.auto&&LIVE.name==='A recolher…'){const d=new Date(LIVE.created),z=n=>String(n).padStart(2,'0');LIVE.name=`Álbum ${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())} ${z(d.getHours())}h${z(d.getMinutes())}`}LIVE.expected=m.expected||LIVE.expected;saveSoon(LIVE);if(cur===LIVE&&$('title'))$('title').value=LIVE.name}
  if(LIVE&&!LIVE.gotMeta)note('A extensão que está a correr é uma versão antiga (não enviou o nome do álbum nem os tempos). Em chrome://extensions carrega em recarregar na extensão e faz F5 no separador do Facebook. Podes mudar o nome da sessão à mão.',true);
  else if(m.expected&&m.count<m.expected){popup('Faltam fotos do álbum',`Só recolhi ${m.count} de ${m.expected} fotos: faltam ${m.expected-m.count}. Faz scroll no álbum do Facebook até ao fim para carregar todas as miniaturas e carrega de novo em “Obter fotos” (cria uma sessão nova).`);note(`Só recolhi ${m.count} de ${m.expected} fotos do álbum: faltam ${m.expected-m.count}. Faz scroll até ao fim no Facebook, espera que carreguem e carrega de novo em “Obter fotos” (cria uma sessão nova).`,true)}
  else note(`Recolha terminada: ${m.count} fotos`+(m.expected?` (o álbum tem ${m.expected}).`:'.'));
}
 else if(m.t==='status')note(m.text);
 else if(m.t==='error'){collecting=false;$('go').disabled=false;DL=null;note(m.text,true);render()}
 else if(m.t==='full-item')onFull(m);
 else if(m.t==='full-done'){if(DL){DL.done=true;tryFinish();setTimeout(()=>{if(DL&&DL.done)finishZip()},30000)}}
}
function popup(title,text){$('mtitle').textContent=title;$('mtext').textContent=text;const d=$('modal');if(!d.open)d.showModal()}
function note(t,err){const e=$('msg');if(!t){e.className='hidden';return}e.textContent=t;e.className='alert mb-4 text-sm '+(err?'alert-error':'')}
setInterval(()=>send({t:'hello'}),2500);send({t:'hello'});

/* ---------- sessions: every collection is a new one ---------- */
function collect(){const s={id:Date.now(),name:'A recolher…',created:Date.now(),expected:null,auto:true,photos:[],map:{}};
 LIVE=s;collecting=true;$('go').disabled=true;openSession(s);note('A recolher…');send({t:'collect',reset:true})}
async function openSessionById(id){const d=await idb('data','readonly',st=>st.get(id)),m=SESS.find(x=>x.id===id);if(!d||!m)return;
 const s={...m,photos:[],map:{}};d.photos.forEach(p=>{const blob=new Blob([p.bytes],{type:'image/jpeg'});const q={...p,id:s.photos.length,url:URL.createObjectURL(blob)};s.photos.push(q);s.map[q.key]=q});openSession(s)}
function openSession(s){if(cur&&cur!==s&&cur!==LIVE)cur.photos.forEach(p=>URL.revokeObjectURL(p.url));cur=s;setView('session')}
async function delSession(id){if(!confirm('Eliminar esta sessão?'))return;await idb('meta','readwrite',st=>st.delete(id));await idb('data','readwrite',st=>st.delete(id));SESS=SESS.filter(x=>x.id!==id);if(cur&&cur.id===id)cur=null;setView('sessions')}
const pad=n=>String(n).padStart(2,'0');
const localISO=t=>{const d=new Date(t);return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`};
function autoDate(s){if(s.dateManual||s.lmMin==null)return;s.date=localISO(s.lmMin);const d=$('sdate');if(d&&cur===s){d.value=s.date;d.classList.remove('input-warning')}}
function addThumb(s,m){if(s.map[m.key])return;
 if(m.lm){const t=Date.parse(m.lm);if(!isNaN(t)){s.lmMin=s.lmMin==null?t:Math.min(s.lmMin,t);autoDate(s)}}const bytes=b64(m.b64),blob=new Blob([bytes],{type:'image/jpeg'});
 const p={id:s.photos.length,key:m.key,bytes,url:URL.createObjectURL(blob),faces:null,w:0,h:0};s.map[m.key]=p;s.photos.push(p);queue.push({s,p});pump();if(cur===s)render()}
const queue=[];let running=0;
function pump(){while(running<3&&queue.length){const {s,p}=queue.shift();running++;
 fetch('/api/score?name='+encodeURIComponent(p.key),{method:'POST',body:new Blob([p.bytes])}).then(r=>r.json()).then(d=>{if(d.error)throw d.error;p.faces=d.faces;p.w=d.w;p.h=d.h})
  .catch(e=>{p.faces=[];p.err=String(e)}).finally(()=>{running--;saveSoon(s);pump();if(cur===s)render()})}}

/* ---------- triage (uses only the people enabled in settings) ---------- */
const cls=s=>s>=S.certain?'certeza':s>=S.review?'rever':'sem match';
function info(p){if(!p.faces)return{...p,faces:[],c:'pending',top:0};let top=0;
 const faces=p.faces.map(f=>{const sc=f.scores.filter(x=>on(x[0])),s=sc[0]||['',0];if(s[1]>top)top=s[1];return{...f,name:s[0],score:s[1],c:cls(s[1])}});
 return{...p,faces,c:cls(top),top}}
const sel=p=>p.sel===undefined?p.c==='certeza':p.sel;
const pscore=p=>{const m={};(p.faces||[]).forEach(f=>f.scores.forEach(([n,s])=>{if(on(n)&&!(m[n]>=s))m[n]=s}));return m};
const rawOf=id=>cur.photos[id];

/* ---------- views ---------- */
function setView(v){S.view=v;closeBig();
 $('nav').innerHTML=[['sessions','Sessões'],['session','Sessão atual'],['settings','Definições']].map(([k,l])=>`<a role=tab class="tab ${v===k?'tab-active':''} ${k==='session'&&!cur?'tab-disabled':''}" onclick="${k==='session'&&!cur?'':`setView('${k}')`}">${l}</a>`).join('');
 if(v==='sessions')viewSessions();else if(v==='session')viewSession();else viewSettings()}
function viewSessions(){const L=SESS.slice().sort((a,b)=>b.created-a.created);
 $('view').innerHTML=L.length?`<div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">${L.map(s=>`<div class="card bg-base-100 shadow"><div class="card-body p-4 gap-1">
  <h3 class="card-title text-base">${esc(s.name)}</h3><div class="text-xs opacity-60">${fmt(s.created)} · ${s.count} fotos${s.expected?` de ${s.expected}`:''}</div>
  <div class="flex gap-2 text-sm"><span style="color:${COL.certeza}">${s.certeza} certeza</span><span class="opacity-60">${s.sel} selecionadas</span></div>
  <div class="card-actions justify-end"><button class="btn btn-sm btn-primary" onclick="openSessionById(${s.id})">Abrir</button><button class="btn btn-sm btn-ghost" onclick="delSession(${s.id})">Eliminar</button></div></div></div>`).join('')}</div>`
  :`<div class="opacity-60 text-center py-20">Ainda não há sessões. Abre um álbum no Facebook, faz scroll até ao fim e carrega em “Obter fotos do Facebook”.</div>`}
function viewSession(){if(!cur)return setView('sessions');
 $('view').innerHTML=`<div class="flex flex-wrap items-center gap-3 mb-3"><input id=title class="input input-bordered font-bold text-lg flex-1 min-w-[16rem]" value="${esc(cur.name)}" onchange="renameSession(this.value)">
  <label class="flex items-center gap-2 text-sm" title="Data escrita no EXIF das fotos. Por defeito é a data em que o Facebook recebeu as fotos (upload); podes mudá-la."><span class="opacity-70">data das fotos</span><input id=sdate type=datetime-local step=1 class="input input-bordered input-sm ${cur.date?'':'input-warning'}" value="${cur.date||''}" onchange="setDate(this.value)"></label>
  <span class="text-sm opacity-60">${cur.expected?`álbum com ${cur.expected} fotos`:''}</span>
  <button id=stop class="btn btn-sm" onclick="send({t:'stop'})" style="display:none">Parar</button>
  <button id=dl class="btn btn-success btn-sm" onclick="download()">Descarregar zip</button></div>
 <div class="grid md:grid-cols-4 gap-3 mb-4"><div class="stats shadow md:col-span-2 bg-base-100" id=stats></div>
  <div class="card bg-base-100 shadow p-3 md:col-span-2 gap-1">
   <label class="text-sm">certeza ≥ <b id=lc>${S.certain.toFixed(2)}</b></label><input id=rc type=range min=.3 max=.9 step=.01 value=${S.certain} class="range range-success range-xs">
   <label class="text-sm">rever ≥ <b id=lr>${S.review.toFixed(2)}</b></label><input id=rr type=range min=.2 max=.8 step=.01 value=${S.review} class="range range-warning range-xs"></div></div>
 <div class="flex flex-wrap gap-3 items-center mb-4"><div role=tablist class="tabs tabs-boxed" id=tabs></div><select id=person class="select select-bordered select-sm" onchange="S.person=this.value;render()"></select>
  <button class="btn btn-xs" onclick="bulk(true)">selecionar visíveis</button><button class="btn btn-xs btn-ghost" onclick="bulk(false)">limpar visíveis</button><span id=count class="text-sm opacity-60"></span></div>
 <div id=grid class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4"></div>`;
 $('rc').oninput=e=>{S.certain=+e.target.value;if(S.review>S.certain){S.review=S.certain;$('rr').value=S.review}sync()};
 $('rr').oninput=e=>{S.review=+e.target.value;if(S.review>S.certain){S.certain=S.review;$('rc').value=S.certain}sync()};draw()}
function sync(){$('lc').textContent=S.certain.toFixed(2);$('lr').textContent=S.review.toFixed(2);draw();saveSoon(cur)}
function setDate(v){cur.date=v||null;cur.dateManual=!!v;if(!v)autoDate(cur);$('sdate').classList.toggle('input-warning',!cur.date);saveNow(cur)}
function renameSession(v){cur.name=v.trim()||'Sessão';cur.auto=false;saveNow(cur)}
function draw(){const A=cur.photos.map(info);const cnt={certeza:0,rever:0,'sem match':0,pending:0};A.forEach(p=>cnt[p.c]++);const nsel=A.filter(sel).length;
 $('stats').innerHTML=['certeza','rever','sem match'].map(k=>`<div class=stat><div class=stat-title>${k}</div><div class=stat-value style="color:${COL[k]}">${cnt[k]}</div></div>`).join('')
  +`<div class=stat><div class=stat-title>fotos</div><div class=stat-value>${A.length}</div><div class=stat-desc>${cnt.pending?cnt.pending+' a analisar…':nsel+' selecionadas'}</div></div>`;
 $('tabs').innerHTML=['certeza','rever','sem match'].map(k=>`<a role=tab class="tab ${S.tab===k?'tab-active':''}" onclick="S.tab='${k}';render()">${k} (${cnt[k]})</a>`).join('');
 const people=[...new Set(A.flatMap(p=>p.faces.filter(f=>f.c!=='sem match').map(f=>f.name)))].sort();
 $('person').innerHTML='<option value="">todas as pessoas</option>'+people.map(n=>`<option ${S.person===n?'selected':''}>${esc(n)}</option>`).join('');
 let L=A.filter(p=>p.c===S.tab&&(!S.person||p.faces.some(f=>f.name===S.person&&f.c!=='sem match')));L.sort((a,b)=>b.top-a.top);CUR=L;
 $('count').textContent=L.length+' fotos';
 $('grid').innerHTML=L.map(card).join('')||`<div class="opacity-60 col-span-full text-center py-16">${A.length?'nenhuma foto neste grupo':'a aguardar fotos…'}</div>`;
 $('dl').disabled=!!DL||!nsel;$('dl').textContent=DL?`A obter originais ${DL.n}/${DL.total}…`:`Descarregar zip (${nsel})`;$('stop').style.display=DL?'':'none';
 if(LB!==null)lb()}
function svg(p){return`<svg viewBox="0 0 ${p.w} ${p.h}" class="absolute inset-0 w-full h-full pointer-events-none">${p.faces.map(f=>{const[x1,y1,x2,y2]=f.bbox,k=p.w/220;
 return`<rect x=${x1} y=${y1} width=${x2-x1} height=${y2-y1} fill=none stroke="${COL[f.c]}" stroke-width="${k}"></rect>${f.c!=='sem match'?`<text x=${x1} y=${y1-k*2} fill="${COL[f.c]}" font-size=${k*8} font-weight=700 stroke=#000 stroke-width=${k*1.2} paint-order=stroke>${esc(f.name)} ${f.score.toFixed(2)}</text>`:''}`}).join('')}</svg>`}
const badges=(p,big)=>p.faces.filter(f=>f.c!=='sem match').map(f=>`<span class="badge ${big?'badge-lg':''}" style="border-color:${COL[f.c]}">${esc(f.name)} ${f.score.toFixed(2)}</span>`).join('')||'<span class="text-xs opacity-50">sem caras reconhecidas</span>';
function card(p){const on_=sel(p);return`<div class="card bg-base-100 shadow-md overflow-hidden ${on_?'ring-2 ring-success':''}"><figure class="relative cursor-zoom-in" onclick="big(${p.id})"><img src="${p.url}" class="w-full">${svg(p)}
 <input type=checkbox class="checkbox checkbox-success checkbox-md absolute top-2 left-2 bg-black/50" ${on_?'checked':''} onclick="event.stopPropagation();toggle(${p.id})" title="incluir no download"></figure>
 <div class="card-body p-3 gap-1"><div class="flex flex-wrap gap-1">${badges(p)}</div><div class="text-xs opacity-50 truncate">${esc(p.key)} · ${p.faces.length} caras</div></div></div>`}
function toggle(id){const p=info(rawOf(id));rawOf(id).sel=!sel(p);saveSoon(cur);draw()}
function bulk(v){CUR.forEach(p=>{rawOf(p.id).sel=v});saveSoon(cur);draw()}

/* ---------- lightbox ---------- */
function big(id){LB=id;lb()}function closeBig(){LB=null;lb()}
function nav(d){const i=CUR.findIndex(p=>p.id===LB),n=CUR[i+d];if(n){LB=n.id;lb()}}
function lb(){const el=$('lb');if(LB===null){el.classList.add('hidden');el.classList.remove('flex');return}
 const i=CUR.findIndex(p=>p.id===LB),p=CUR[i]||info(rawOf(LB));el.classList.remove('hidden');el.classList.add('flex');
 el.innerHTML=`<div class="flex flex-col items-center gap-3 max-h-full max-w-full"><div class="relative inline-block"><img src="${p.url}" class="block max-h-[78vh] max-w-[92vw] rounded-lg">${svg(p)}</div>
 <div class="flex flex-wrap items-center justify-center gap-2"><button class="btn btn-sm" onclick="nav(-1)" ${i<=0?'disabled':''}>←</button>${badges(p,1)}
 <span class="text-sm opacity-60">${esc(p.key.slice(0,24))} · ${i+1}/${CUR.length}</span>
 <button class="btn btn-sm ${sel(p)?'btn-success':'btn-outline'}" onclick="toggle(${p.id})">${sel(p)?'✓ incluída':'incluir'} (espaço)</button>
 <button class="btn btn-sm" onclick="nav(1)" ${i<0||i>=CUR.length-1?'disabled':''}>→</button><button class="btn btn-sm btn-ghost" onclick="closeBig()">fechar (Esc)</button></div></div>`}
document.addEventListener('keydown',e=>{if(LB===null||['INPUT','SELECT','TEXTAREA'].includes(e.target.tagName))return;
 if(e.key==='Escape')closeBig();if(e.key==='ArrowLeft')nav(-1);if(e.key==='ArrowRight')nav(1);if(e.key===' '){e.preventDefault();toggle(LB)}});

/* ---------- download: originals via the extension, zipped in the browser as <session>_0001.jpg ---------- */
function download(){if(!cur||DL)return;const A=cur.photos.map(info).filter(sel);if(!A.length)return;
 if(!cur.date&&!confirm('Esta sessão não tem data definida: as fotos ficam sem data no EXIF (o Google Fotos vai usar a data de hoje). Continuar mesmo assim?'))return;
 const base=slug(cur.name),names={};A.forEach((p,i)=>names[p.key]=`${base}_${String(i+1).padStart(4,'0')}.jpg`);
 DL={n:0,total:A.length,files:{},names,base,s:cur,order:A.map(p=>p.key),date:cur.date,t0:performance.now(),ms:[],rows:[['ficheiro','original_facebook','data_exif','pessoas','tipo','kb','ms_encontrar','ms_visualizador_e_voltar','ms_descarga','ms_codificar','ms_total_extensao']]};
 send({t:'full',keys:A.map(p=>p.key)});draw()}
function tryFinish(){if(DL&&DL.done&&DL.n>=DL.total)finishZip()}
function onFull(m){if(!DL)return;const p=DL.s.map[m.key];if(!p)return;DL.n++;let data,kind;
 if(m.b64){data=b64(m.b64);kind=`original ${m.w}x${m.h}`}else{data=p.bytes;kind='miniatura ('+(m.error||'sem original')+')'}
 const name=DL.names[p.key];DL.files[name]=data;const ps=pscore(p),t=m.ms||{};if(m.ms)DL.ms.push(t);
 DL.rows.push([name,p.key,exifDate(p.key)?.str.replace(/^(\d+):(\d+):(\d+)/,'$1-$2-$3')||'',Object.keys(ps).filter(n=>ps[n]>=S.review).map(n=>`${n} ${ps[n].toFixed(2)}`).join('; '),kind,t.kb??'',t.find??'',t.view!=null?t.view+(t.back||0):'',t.download??'',t.encode??'',t.total??'']);
 if(cur===DL.s)draw();tryFinish()}
// album date + the photo's position in the album as seconds, so Google Photos keeps the album order
function exifDate(key){if(!DL||!DL.date)return null;const i=DL.order.indexOf(key),d=new Date(DL.date);d.setSeconds(d.getSeconds()+Math.max(0,i));
 const z=n=>String(n).padStart(2,'0');return{d,str:`${d.getFullYear()}:${z(d.getMonth()+1)}:${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`}}
function finishZip(){if(!DL)return;const files={...DL.files},mt={};
 for(const key of DL.order){const nm=DL.names[key],x=exifDate(key);if(x&&files[nm]){files[nm]=setExif(files[nm],x.str);mt[nm]=x.d}}
 files['_resumo.csv']=new TextEncoder().encode(DL.rows.map(r=>r.map(c=>'"'+String(c).replace(/"/g,'""')+'"').join(',')).join('\n'));
 const zip=fflate.zipSync(Object.fromEntries(Object.entries(files).map(([k,v])=>[k,[v,mt[k]?{level:0,mtime:mt[k]}:{level:0}]])));
 const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([zip],{type:'application/zip'}));a.download=DL.base+'.zip';a.click();
 const orig=DL.rows.filter(r=>/^original/.test(r[4])).length,wall=(performance.now()-DL.t0)/1000,avg=k=>DL.ms.length?Math.round(DL.ms.reduce((x,y)=>x+(y[k]||0),0)/DL.ms.length):0;
 console.table(DL.rows.slice(1).map(r=>Object.fromEntries(DL.rows[0].map((h,i)=>[h,r[i]]))));
 note(`Zip descarregado (${DL.base}.zip): ${orig} originais, ${DL.rows.length-1-orig} miniaturas. ${wall.toFixed(0)} s no total (${(wall/Math.max(1,DL.rows.length-1)).toFixed(1)} s/foto). Média por foto: encontrar ${avg('find')} ms, visualizador+voltar ${avg('view')+avg('back')} ms, descarga ${avg('download')} ms (${avg('kb')} KB), codificar ${avg('encode')} ms.`);
 const s=DL.s;DL=null;if(cur===s)draw()}

/* ---------- settings: which people to match ---------- */
function viewSettings(){$('view').innerHTML=`<div class="card bg-base-100 shadow"><div class="card-body gap-3"><h2 class="card-title">Pessoas a reconhecer</h2>
 <p class="text-sm opacity-70">Só as pessoas ativas contam para <b>certeza</b> e <b>rever</b>. As outras são ignoradas (não precisas de voltar a recolher: muda aqui e as sessões atualizam-se).</p>
 <div class="flex flex-wrap gap-2 items-center"><input id=psearch class="input input-bordered input-sm" placeholder="procurar…" oninput="S.search=this.value;renderPeople()" value="${esc(S.search)}">
  <button class="btn btn-sm" onclick="setAll(true)">todas</button><button class="btn btn-sm" onclick="setAll(false)">nenhuma</button><span id=pcount class="text-sm opacity-60"></span></div>
 <div id=plist class="grid sm:grid-cols-2 lg:grid-cols-4 gap-1"></div></div></div>`;renderPeople()}
function renderPeople(){const q=S.search.toLowerCase();
 $('pcount').textContent=`${PEOPLE.filter(on).length} de ${PEOPLE.length} ativas`;
 $('plist').innerHTML=PEOPLE.filter(n=>n.toLowerCase().includes(q)).map(n=>`<label class="label cursor-pointer justify-start gap-3 rounded-lg hover:bg-base-200 px-2"><input type=checkbox class="toggle toggle-success toggle-sm" ${on(n)?'checked':''} onchange="setPerson(this.dataset.n,this.checked)" data-n="${esc(n)}"><span class="label-text">${esc(n)}</span></label>`).join('')}
function setPerson(n,v){v?cfg.off.delete(n):cfg.off.add(n);saveCfg();renderPeople()}
function setAll(v){const q=S.search.toLowerCase();PEOPLE.filter(n=>n.toLowerCase().includes(q)).forEach(n=>v?cfg.off.delete(n):cfg.off.add(n));saveCfg();renderPeople()}

/* ---------- start ---------- */
(async()=>{try{PEOPLE=await (await fetch('/api/people')).json()}catch(e){}
 try{db=await dbOpen();SESS=await idb('meta','readonly',st=>st.getAll())||[]}catch(e){note('Sem armazenamento local: as sessões não serão guardadas.',true)}
 setView('sessions')})();
</script></html>"""
