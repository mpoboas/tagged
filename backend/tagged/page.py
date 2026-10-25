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
  <div class="flex-1 text-xl font-bold px-2">tagged <span id=ext class="badge badge-warning ml-2 h-auto whitespace-nowrap cursor-pointer" onclick="setView('extension')">extensão não detetada</span></div>
  <div role=tablist class="tabs tabs-boxed" id=nav></div>
  <button id=go class="btn btn-primary btn-sm" onclick="collect()">Obter fotos do Facebook</button>
 </div>
 <div id=prog class="hidden"></div>
 <div id=msg class="alert mb-4 text-sm hidden"></div>
 <div id=view></div>
</div>
<dialog id=modal class="modal"><div class="modal-box"><h3 class="font-bold text-lg" id=mtitle></h3><p class="py-4" id=mtext></p>
 <div class="modal-action"><form method=dialog><button class="btn btn-primary">Percebido</button></form></div></div><form method=dialog class="modal-backdrop"><button>fechar</button></form></dialog>
<div id=lb class="fixed inset-0 z-50 bg-black/90 hidden items-center justify-center p-4" onclick="if(event.target===this)closeBig()"></div>
<script>
const EXT_MIN='0.6.1';
const COL={certeza:'#22c55e',rever:'#f59e0b','sem match':'#64748b'};
const S={certain:.5,review:.35,tab:'certeza',person:'',view:'sessions',search:''};
let SESS=[],cur=null,LIVE=null,PEOPLE=[],PE={},PVER=0,CUR=[],LB=null,DL=null,collecting=false;
const cfg=(()=>{try{return JSON.parse(localStorage.getItem('tagged.cfg')||'{}')}catch(e){return{}}})();cfg.off=new Set(cfg.off||[]);
const saveCfg=()=>localStorage.setItem('tagged.cfg',JSON.stringify({off:[...cfg.off]}));
const on=n=>!cfg.off.has(n);
const send=m=>window.postMessage({src:'tagged-web',...m},location.origin);
const $=id=>document.getElementById(id);
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const b64=s=>{const b=atob(s),a=new Uint8Array(b.length);for(let i=0;i<b.length;i++)a[i]=b.charCodeAt(i);return a};
const slug=s=>s.normalize('NFD').replace(/[̀-ͯ]/g,'').replace(/[^A-Za-z0-9]+/g,'_').replace(/^_+|_+$/g,'')||'album';
const fmt=t=>new Date(t).toLocaleString('pt-PT',{dateStyle:'short',timeStyle:'short'});
let rq=0;const render=()=>{cancelAnimationFrame(rq);rq=requestAnimationFrame(()=>{if(S.view==='session'&&cur)draw();updateProg()})};

/* ---------- progress card: one place for collecting, analysing and fetching originals ---------- */
let doneUntil=0,doneInfo=null,progTimer=0;
const fmtT=sec=>sec<60?`${Math.max(1,Math.round(sec))} s`:`${Math.floor(sec/60)} min ${String(Math.round(sec%60)).padStart(2,'0')} s`;
function showProg(o){const e=$('prog');if(!o){e.className='hidden';e.innerHTML='';return}
 const done=o.tone==='done';e.className='mb-4';
 e.innerHTML=`<div class="card bg-base-100 shadow border ${done?'border-success/40':'border-primary/30'}"><div class="card-body p-4 gap-3">
  <div class="flex items-center gap-3"><div class="text-3xl leading-none ${o.pct==null&&!done?'animate-pulse':''}">${o.icon}</div>
   <div class="flex-1 min-w-0"><div class="font-semibold">${o.title}</div><div class="text-sm opacity-70 truncate">${o.sub||''}</div></div>
   ${o.pct==null?'':`<div class="text-2xl font-bold tabular-nums ${done?'text-success':'text-primary'}">${Math.round(o.pct)}%</div>`}</div>
  <progress class="progress ${done?'progress-success':'progress-primary'} w-full h-3" ${o.pct==null?'':`value="${o.pct}" max="100"`}></progress></div></div>`}
function updateProg(){clearTimeout(progTimer);
 if(DL){const n=DL.n,t=DL.total,pct=DL.done&&n>=t?100:100*n/t;
  if(DL.done&&n>=t)return showProg({icon:'🗜️',title:'A montar o zip…',sub:'Quase pronto: a juntar as fotos e a escrever a data em cada uma.',pct:100});
  const el=(performance.now()-DL.t0)/1000,eta=n>1?el/n*(t-n):null;
  const title=n===0?'A abrir a primeira foto no Facebook…':pct<30?'A ir buscar os originais em alta qualidade':pct<65?'Vai bem encaminhado, continua assim':pct<90?'Mais de metade já está':'Quase lá, só mais umas fotos';
  return showProg({icon:'📸',title,sub:`Foto ${Math.min(n+1,t)} de ${t}`+(eta!=null?` · faltam cerca de ${fmtT(eta)}`:'')+(n>1?` · ~${(el/n).toFixed(1)} s por foto`:''),pct})}
 if(collecting)return showProg({icon:'📥',title:'A recolher as fotos do álbum…',sub:(LIVE?LIVE.photos.length:0)+' fotos encontradas até agora',pct:null});
 const S_=LIVE||cur;const pend=S_?S_.photos.filter(p=>!p.faces).length:0;
 if(pend){const tot=S_.photos.length,k=tot-pend;return showProg({icon:'🔍',title:'A reconhecer quem está nas fotos…',sub:`${k} de ${tot} fotos analisadas`,pct:100*k/tot})}
 if(doneInfo&&Date.now()<doneUntil){progTimer=setTimeout(updateProg,Math.max(50,doneUntil-Date.now()));return showProg({icon:'✅',title:doneInfo.title,sub:doneInfo.sub,pct:100,tone:'done'})}
 showProg(null)}

/* ---------- storage: IndexedDB (sessions survive reloads) ---------- */
let db;
const dbOpen=()=>new Promise((res,rej)=>{const r=indexedDB.open('tagged',2);r.onupgradeneeded=()=>{const d=r.result;for(const n of ['meta','data'])if(!d.objectStoreNames.contains(n))d.createObjectStore(n,{keyPath:'id'});if(!d.objectStoreNames.contains('people'))d.createObjectStore('people',{keyPath:'name'})};r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});
const idb=(st,mode,fn)=>new Promise((res,rej)=>{const t=db.transaction(st,mode),r=fn(t.objectStore(st));t.oncomplete=()=>res(r&&r.result);t.onerror=()=>rej(t.error)});
const timers={};
function saveSoon(s){clearTimeout(timers[s.id]);timers[s.id]=setTimeout(()=>saveNow(s),700)}
async function saveNow(s){if(!db)return;const A=s.photos.map(info);
 const meta={id:s.id,name:s.name,created:s.created,expected:s.expected,auto:s.auto,date:s.date||null,dateManual:!!s.dateManual,lmMin:s.lmMin??null,count:s.photos.length,certeza:A.filter(p=>p.c==='certeza').length,sel:A.filter(sel).length};
 const i=SESS.findIndex(x=>x.id===s.id);if(i<0)SESS.unshift(meta);else SESS[i]=meta;
 await idb('meta','readwrite',st=>st.put(meta));
 await idb('data','readwrite',st=>st.put({id:s.id,photos:s.photos.map(p=>({key:p.key,bytes:p.bytes,faces:p.faces&&p.faces.map(f=>({bbox:f.bbox,emb:f.emb,scores:f.emb?undefined:f.scores})),w:p.w,h:p.h,sel:p.sel}))}))}

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
 if(m.t==='bridge'||m.t==='ready'){const x=$('ext');const old=!m.v||m.v<EXT_MIN;x.textContent=old?`extensão desatualizada (${m.v||'?'}) · recarrega-a`:(m.fb?'extensão ligada · Facebook aberto':'extensão ligada · abre um álbum do Facebook');x.className='badge ml-2 h-auto whitespace-nowrap cursor-pointer '+(old?'badge-error':m.fb?'badge-success':'badge-info')}
 else if(m.t==='meta'&&LIVE){LIVE.gotMeta=true;if(LIVE.auto&&m.title){LIVE.name=m.title;const t=$('title');if(t&&cur===LIVE)t.value=m.title}LIVE.expected=m.expected||null}
 else if(m.t==='thumb'&&LIVE)addThumb(LIVE,m);
 else if(m.t==='collect-done'){collecting=false;$('go').disabled=false;updateProg();
  if(LIVE){if(LIVE.auto&&m.title)LIVE.name=m.title;if(LIVE.auto&&LIVE.name==='A recolher…'){const d=new Date(LIVE.created),z=n=>String(n).padStart(2,'0');LIVE.name=`Álbum ${d.getFullYear()}-${z(d.getMonth()+1)}-${z(d.getDate())} ${z(d.getHours())}h${z(d.getMinutes())}`}LIVE.expected=m.expected||LIVE.expected;saveSoon(LIVE);if(cur===LIVE&&$('title'))$('title').value=LIVE.name}
  if(LIVE&&!LIVE.gotMeta)note('A extensão que está a correr é uma versão antiga (não enviou o nome do álbum nem os tempos). Em chrome://extensions carrega em recarregar na extensão e faz F5 no separador do Facebook. Podes mudar o nome da sessão à mão.',true);
  else if(m.expected&&m.count<m.expected){popup('Faltam fotos do álbum',`Só recolhi ${m.count} de ${m.expected} fotos: faltam ${m.expected-m.count}. Faz scroll no álbum do Facebook até ao fim para carregar todas as miniaturas e carrega de novo em “Obter fotos” (cria uma sessão nova).`);note(`Só recolhi ${m.count} de ${m.expected} fotos do álbum: faltam ${m.expected-m.count}. Faz scroll até ao fim no Facebook, espera que carreguem e carrega de novo em “Obter fotos” (cria uma sessão nova).`,true)}
  else note(`Recolha terminada: ${m.count} fotos`+(m.expected?` (o álbum tem ${m.expected}).`:'.'));
}
 else if(m.t==='status'){}   // the progress card below replaces the extension's raw status text
 else if(m.t==='error'){collecting=false;$('go').disabled=false;DL=null;doneInfo=null;note(m.text,true);render()}
 else if(m.t==='full-item')onFull(m);
 else if(m.t==='full-done'){if(DL){DL.done=true;tryFinish();setTimeout(()=>{if(DL&&DL.done)finishZip()},30000)}}
}
function popup(title,text){$('mtitle').textContent=title;$('mtext').textContent=text;const d=$('modal');if(!d.open)d.showModal()}
function note(t,err){const e=$('msg');if(!t){e.className='hidden';return}e.textContent=t;e.className='alert mb-4 text-sm '+(err?'alert-error':'')}
setInterval(()=>send({t:'hello'}),2500);send({t:'hello'});

/* ---------- sessions: every collection is a new one ---------- */
function collect(){const s={id:Date.now(),name:'A recolher…',created:Date.now(),expected:null,auto:true,photos:[],map:{}};
 LIVE=s;collecting=true;$('go').disabled=true;openSession(s);note('');updateProg();send({t:'collect',reset:true})}
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
 fetch('/api/score?name='+encodeURIComponent(p.key),{method:'POST',body:new Blob([p.bytes])}).then(r=>r.json()).then(d=>{if(d.error)throw d.error;p.faces=d.faces.map(f=>({bbox:f.bbox,emb:Float32Array.from(f.emb)}));p.w=d.w;p.h=d.h})
  .catch(e=>{p.faces=[];p.err=String(e)}).finally(()=>{running--;saveSoon(s);pump();if(cur===s)render()})}}

/* ---------- matching: the browser holds the people (IndexedDB) and compares each face's embedding with them ---------- */
function scoresOf(f){if(!f.emb)return f.scores||[];if(f._v===PVER)return f._s;const e=f.emb,out=[];
 for(const n in PE){const {a,k}=PE[n];let best=-1;for(let r=0;r<k;r++){let d=0;const o=r*512;for(let i=0;i<512;i++)d+=a[o+i]*e[i];if(d>best)best=d}
  if(best>=.2)out.push([n,Math.round(best*1000)/1000])}
 out.sort((x,y)=>y[1]-x[1]);f._s=out;f._v=PVER;return out}
function parseNpy(u8){if(u8[0]!==0x93||String.fromCharCode(...u8.subarray(1,6))!=='NUMPY')throw new Error('não é um ficheiro .npy');
 const dv=new DataView(u8.buffer,u8.byteOffset,u8.byteLength),v=u8[6];let hl,off;if(v===1){hl=dv.getUint16(8,true);off=10}else{hl=dv.getUint32(8,true);off=12}
 const h=new TextDecoder().decode(u8.subarray(off,off+hl)),descr=(/'descr':\s*'([^']+)'/.exec(h)||[])[1],shape=((/'shape':\s*\(([^)]*)\)/.exec(h)||[])[1]||'').split(',').map(x=>x.trim()).filter(Boolean).map(Number);
 if(/True/.test((/'fortran_order':\s*(\w+)/.exec(h)||[])[1]||''))throw new Error('formato fortran não suportado');
 const n=shape.reduce((a,b)=>a*b,1),body=u8.subarray(off+hl);let a;
 if(descr==='<f4')a=new Float32Array(body.slice(0,n*4).buffer);else if(descr==='<f8')a=Float32Array.from(new Float64Array(body.slice(0,n*8).buffer));else throw new Error('tipo '+descr+' não suportado');
 if(shape[shape.length-1]!==512)throw new Error('esperava vetores de 512 valores, veio '+shape[shape.length-1]);
 for(let r=0;r<n/512;r++){let t=0;for(let i=0;i<512;i++)t+=a[r*512+i]**2;t=Math.sqrt(t)||1;for(let i=0;i<512;i++)a[r*512+i]/=t}
 return{a,k:n/512}}
function personName(path){const parts=path.split('/').filter(Boolean);let b=(parts.pop()||'').replace(/\.npy$/i,'');if(b==='embeddings')b=parts.pop()||'';return b}
async function loadPeopleFiles(list){const files=Array.from(list);   // copy first: a file input's FileList is live and is emptied when the input is reset
 const m=$('pmsg');m.className='text-sm';m.textContent='A ler '+files.length+' ficheiros…';const found={},errs=[];
 const add=(path,u8)=>{try{const name=personName(path);if(!name)throw new Error('sem nome (usa o ficheiro people.npz ou a pasta data/refs)');found[name]=parseNpy(u8)}catch(e){errs.push(`${path}: ${e.message}`)}};
 try{for(const f of files){
  const isZip=/\.(npz|zip)$/i.test(f.name),isNpy=/\.npy$/i.test(f.name);
  if(!isZip&&!isNpy){if(!f.webkitRelativePath)errs.push(f.name+': tipo não suportado');continue}   // a folder also holds the .jpg crops: skip them without reading
  const u8=new Uint8Array(await f.arrayBuffer());
  if(isZip){const z=fflate.unzipSync(u8);for(const k in z)if(/\.npy$/i.test(k))add(k,z[k])}
  else add(f.webkitRelativePath||f.name,u8)}}
 catch(e){errs.push(String(e.message||e))}
 const names=Object.keys(found);for(const n of names){PE[n]=found[n];await idb('people','readwrite',st=>st.put({name:n,a:found[n].a,k:found[n].k}))}
 PVER++;PEOPLE=Object.keys(PE).sort();render();if(S.view==='settings')viewSettings();else if(S.view==='sessions')viewSessions();
 const mm=$('pmsg');if(mm){mm.className='text-sm '+(errs.length&&!names.length?'text-error':'text-success');
  mm.textContent=names.length?`${names.length} pessoas carregadas (${names.reduce((s,n)=>s+found[n].k,0)} caras de referência).`+(errs.length?` ${errs.length} ficheiros ignorados: ${errs[0]}`:''):'Nada carregado: '+(errs[0]||'sem ficheiros .npy')}}
async function clearPeople(){if(!confirm('Remover todas as pessoas deste browser?'))return;await idb('people','readwrite',st=>st.clear());PE={};PVER++;PEOPLE=[];render();viewSettings()}
async function delPerson(n){await idb('people','readwrite',st=>st.delete(n));delete PE[n];PVER++;PEOPLE=Object.keys(PE).sort();render();renderPeople()}

/* ---------- triage (uses only the people enabled in settings) ---------- */
const cls=s=>s>=S.certain?'certeza':s>=S.review?'rever':'sem match';
function info(p){if(!p.faces)return{...p,faces:[],c:'pending',top:0};let top=0;
 const faces=p.faces.map(f=>{const sc=scoresOf(f).filter(x=>on(x[0])),s=sc[0]||['',0];if(s[1]>top)top=s[1];return{...f,name:s[0],score:s[1],c:cls(s[1])}});
 return{...p,faces,c:cls(top),top}}
const sel=p=>p.sel===undefined?p.c==='certeza':p.sel;
const pscore=p=>{const m={};(p.faces||[]).forEach(f=>scoresOf(f).forEach(([n,s])=>{if(on(n)&&!(m[n]>=s))m[n]=s}));return m};
const rawOf=id=>cur.photos[id];

/* ---------- views ---------- */
function setView(v){S.view=v;closeBig();
 $('nav').innerHTML=[['sessions','Sessões'],['session','Sessão atual'],['settings','Definições'],['extension','Extensão']].map(([k,l])=>`<a role=tab class="tab ${v===k?'tab-active':''} ${k==='session'&&!cur?'tab-disabled':''}" onclick="${k==='session'&&!cur?'':`setView('${k}')`}">${l}</a>`).join('');
 if(v==='sessions')viewSessions();else if(v==='session')viewSession();else if(v==='extension')viewExtension();else viewSettings()}
const noPeople=()=>PEOPLE.length?'':`<div class="alert alert-warning mb-4 text-sm"><span>Ainda não carregaste as pessoas a reconhecer. Sem elas, nenhuma foto é reconhecida.</span><button class="btn btn-sm" onclick="setView('settings')">Carregar pessoas</button></div>`;
function viewSessions(){const L=SESS.slice().sort((a,b)=>b.created-a.created);
 $('view').innerHTML=noPeople()+(L.length?`<div class="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">${L.map(s=>`<div class="card bg-base-100 shadow"><div class="card-body p-4 gap-1">
  <h3 class="card-title text-base">${esc(s.name)}</h3><div class="text-xs opacity-60">${fmt(s.created)} · ${s.count} fotos${s.expected?` de ${s.expected}`:''}</div>
  <div class="flex gap-2 text-sm"><span style="color:${COL.certeza}">${s.certeza} certeza</span><span class="opacity-60">${s.sel} selecionadas</span></div>
  <div class="card-actions justify-end"><button class="btn btn-sm btn-primary" onclick="openSessionById(${s.id})">Abrir</button><button class="btn btn-sm btn-ghost" onclick="delSession(${s.id})">Eliminar</button></div></div></div>`).join('')}</div>`
  :`<div class="opacity-60 text-center py-20">Ainda não há sessões. Abre um álbum no Facebook, faz scroll até ao fim e carrega em “Obter fotos do Facebook”.</div>`)}
function viewSession(){if(!cur)return setView('sessions');
 $('view').innerHTML=noPeople()+`<div class="flex flex-wrap items-center gap-3 mb-3"><input id=title class="input input-bordered font-bold text-lg flex-1 min-w-[16rem]" value="${esc(cur.name)}" onchange="renameSession(this.value)">
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
 $('dl').disabled=!!DL||!nsel;$('dl').innerHTML=DL?'<span class="loading loading-spinner loading-xs"></span> A descarregar…':`Descarregar zip (${nsel})`;$('stop').style.display=DL?'':'none';
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
 send({t:'full',keys:A.map(p=>p.key)});draw();updateProg()}
function tryFinish(){if(DL&&DL.done&&DL.n>=DL.total)finishZip()}
function onFull(m){if(!DL)return;const p=DL.s.map[m.key];if(!p)return;DL.n++;let data,kind;
 if(m.b64){data=b64(m.b64);kind=`original ${m.w}x${m.h}`}else{data=p.bytes;kind='miniatura ('+(m.error||'sem original')+')'}
 const name=DL.names[p.key];DL.files[name]=data;const ps=pscore(p),t=m.ms||{};if(m.ms)DL.ms.push(t);
 DL.rows.push([name,p.key,exifDate(p.key)?.str.replace(/^(\d+):(\d+):(\d+)/,'$1-$2-$3')||'',Object.keys(ps).filter(n=>ps[n]>=S.review).map(n=>`${n} ${ps[n].toFixed(2)}`).join('; '),kind,t.kb??'',t.find??'',t.view!=null?t.view+(t.back||0):'',t.download??'',t.encode??'',t.total??'']);
 if(cur===DL.s)draw();updateProg();tryFinish()}
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
 const s=DL.s;doneInfo={title:`Zip pronto: ${DL.rows.length-1} fotos`,sub:`${orig} originais${DL.rows.length-1-orig?` e ${DL.rows.length-1-orig} miniaturas`:''} em ${fmtT(wall)} · o download começou`};doneUntil=Date.now()+9000;DL=null;if(cur===s)draw();updateProg()}

/* ---------- extension: download + install steps ---------- */
function viewExtension(){const o=location.origin;
 $('view').innerHTML=`<div class="card bg-base-100 shadow"><div class="card-body gap-3"><h2 class="card-title">Extensão para Chrome</h2>
 <p class="text-sm opacity-70">A extensão é a ponte entre o álbum do Facebook e esta webapp. Já vem configurada para <b>${esc(o)}</b>: descarrega-a daqui, não de outro sítio.</p>
 <div><a class="btn btn-primary" href="/extension.zip" download>Descarregar extensão (zip)</a> <span id=extver class="text-sm opacity-60 ml-2"></span></div>
 <ol class="list-decimal ml-6 space-y-1 text-sm"><li>Descomprime o zip. Fica uma pasta <code>tagged-extension</code>.</li>
  <li>No Chrome abre <code>chrome://extensions</code> e liga o <b>Modo de programador</b> (canto superior direito).</li>
  <li>Carrega em <b>Carregar sem compactar</b> e escolhe a pasta <code>tagged-extension</code>.</li>
  <li>Volta a esta página e recarrega-a (F5): o selo no topo passa a “extensão ligada”.</li>
  <li>Quando houver uma versão nova, descarrega-a outra vez, substitui a pasta e carrega no botão de recarregar da extensão em <code>chrome://extensions</code>.</li></ol>
 <p class="text-xs opacity-60">Só funciona no Chrome (ou Edge/Brave) no computador, porque o telemóvel não suporta extensões desta forma.</p></div></div>`;
 fetch('/api/version').then(r=>r.json()).then(d=>{const e=$('extver');if(e)e.textContent='versão '+d.extension}).catch(()=>{})}

/* ---------- settings: which people to match ---------- */
function viewSettings(){$('view').innerHTML=`<div class="card bg-base-100 shadow mb-4" ondragover="event.preventDefault()" ondrop="event.preventDefault();loadPeopleFiles(event.dataTransfer.files)"><div class="card-body gap-3"><h2 class="card-title">Carregar pessoas</h2>
 <p class="text-sm opacity-70">Escolhe o ficheiro com as pessoas (<code>people.npz</code>, gerado com <code>tagged people-pack</code> ou pelo botão Export do rotulador). Fica guardado só neste browser: o servidor nunca o recebe, e não precisas de o voltar a carregar. Também aceito um <code>.zip</code> da pasta <code>data/refs</code>, vários <code>.npy</code> (um por pessoa, com o nome da pessoa) ou a própria pasta <code>refs</code>. Podes largar os ficheiros aqui.</p>
 <div class="flex flex-wrap gap-2 items-center"><label class="btn btn-primary btn-sm">Escolher ficheiro(s)<input type=file class=hidden multiple accept=".npz,.npy,.zip" onchange="loadPeopleFiles(this.files);this.value=''"></label>
  <label class="btn btn-sm">Escolher pasta refs<input type=file class=hidden webkitdirectory onchange="loadPeopleFiles(this.files);this.value=''"></label>
  <button class="btn btn-sm btn-ghost" onclick="clearPeople()" ${PEOPLE.length?'':'disabled'}>remover todas</button><span id=pmsg class="text-sm"></span></div></div></div>
 <div class="card bg-base-100 shadow"><div class="card-body gap-3"><h2 class="card-title">Pessoas a reconhecer</h2>
 <p class="text-sm opacity-70">Só as pessoas ativas contam para <b>certeza</b> e <b>rever</b>. As outras são ignoradas (não precisas de voltar a recolher: muda aqui e as sessões atualizam-se).</p>
 <div class="flex flex-wrap gap-2 items-center"><input id=psearch class="input input-bordered input-sm" placeholder="procurar…" oninput="S.search=this.value;renderPeople()" value="${esc(S.search)}">
  <button class="btn btn-sm" onclick="setAll(true)">todas</button><button class="btn btn-sm" onclick="setAll(false)">nenhuma</button><span id=pcount class="text-sm opacity-60"></span></div>
 <div id=plist class="grid sm:grid-cols-2 lg:grid-cols-4 gap-1"></div></div></div>`;renderPeople()}
function renderPeople(){const q=S.search.toLowerCase();
 $('pcount').textContent=`${PEOPLE.filter(on).length} de ${PEOPLE.length} ativas`;
 $('plist').innerHTML=PEOPLE.length?PEOPLE.filter(n=>n.toLowerCase().includes(q)).map(n=>`<div class="flex items-center gap-1 rounded-lg hover:bg-base-200 px-2"><label class="label cursor-pointer justify-start gap-3 flex-1"><input type=checkbox class="toggle toggle-success toggle-sm" ${on(n)?'checked':''} onchange="setPerson(this.dataset.n,this.checked)" data-n="${esc(n)}"><span class="label-text">${esc(n)} <span class="opacity-40 text-xs">${PE[n].k}</span></span></label><button class="btn btn-ghost btn-xs" title="remover" onclick="delPerson(this.dataset.n)" data-n="${esc(n)}">✕</button></div>`).join(''):'<div class="opacity-60 text-sm col-span-full">Ainda não há pessoas carregadas.</div>'}
function setPerson(n,v){v?cfg.off.delete(n):cfg.off.add(n);saveCfg();renderPeople()}
function setAll(v){const q=S.search.toLowerCase();PEOPLE.filter(n=>n.toLowerCase().includes(q)).forEach(n=>v?cfg.off.delete(n):cfg.off.add(n));saveCfg();renderPeople()}

/* ---------- start ---------- */
(async()=>{
 try{db=await dbOpen();SESS=await idb('meta','readonly',st=>st.getAll())||[];
  for(const p of await idb('people','readonly',st=>st.getAll())||[])PE[p.name]={a:p.a,k:p.k};PEOPLE=Object.keys(PE).sort();PVER++}catch(e){note('Sem armazenamento local: as sessões não serão guardadas.',true)}
 setView('sessions')})();
</script></html>"""
