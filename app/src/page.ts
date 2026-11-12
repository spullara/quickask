export type Source = { title: string; uri: string };
export type Result = { title: string; url: string; date?: string; text: string };
export type Msg = { role: "user" | "model"; text: string; sources?: Source[]; images?: string[]; results?: Result[] };
export type ShareRef = { id: string; created: number };

const json = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028|\u2029/g, "");
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** A streamed instruction to the page: one inline script per event. */
export const call = (fn: string, arg: unknown) => `<script>${fn}(${json(arg)})</script>\n`;

const CSS = `
:root{--bg:#fff;--fg:#1d1d1f;--mute:#6e6e73;--soft:#f4f4f5;--line:#e4e4e7;--accent:#2563eb;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#18181b;--fg:#ececee;--mute:#9a9aa1;--soft:#232327;--line:#2f2f34;--accent:#7aa2ff}}
*{box-sizing:border-box}html,body{margin:0;height:100%}
body{font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif;background:var(--bg);color:var(--fg);display:flex}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
#side{width:260px;flex:none;background:var(--soft);height:100vh;overflow-y:auto;padding:12px 8px;display:flex;flex-direction:column;gap:2px}
#side .new{display:flex;align-items:center;padding:8px 10px;border-radius:8px;color:var(--fg);font-weight:600;margin-bottom:8px}
#side .new kbd{margin-left:auto;font:500 11px/1 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:var(--mute);background:var(--bg);border-radius:5px;padding:4px 6px}
@media (hover:none){#side .new kbd{display:none}}
#side .new:hover,#side .it:hover{background:var(--line);text-decoration:none}
#side .it{display:flex;align-items:center;border-radius:8px;color:var(--fg);padding:6px 10px;font-size:14px}
#side .it span{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#side .it.on{background:var(--line)}
#side .it button{visibility:hidden;border:0;background:none;color:var(--mute);cursor:pointer;font-size:16px;padding:0 0 0 6px}
#side .it:hover button{visibility:visible}
main{flex:1;height:100vh;overflow-y:auto;display:flex;flex-direction:column}
#log{width:100%;max-width:760px;margin:0 auto;padding:32px 24px 8px;flex:1}
.u{background:var(--soft);border-radius:14px;padding:8px 14px;margin:24px 0 12px auto;width:fit-content;max-width:85%;white-space:pre-wrap}
.m{margin-bottom:8px}.m p{margin:0 0 10px}.m h4{margin:16px 0 6px;font-size:15px}.m ul,.m ol{margin:0 0 10px;padding-left:22px}
.m pre{background:var(--soft);padding:10px 12px;border-radius:8px;overflow-x:auto;font-size:13px}.m code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace}
.m.wait:empty::after,.m.wait>:last-child::after{content:"";display:inline-block;width:8px;height:8px;margin-left:4px;border-radius:50%;background:var(--mute);animation:p 1s infinite}
@keyframes p{50%{opacity:.25}}
.src{display:flex;flex-wrap:wrap;gap:6px;margin:4px 0 6px}.src a{font-size:12px;background:var(--soft);color:var(--mute);padding:2px 8px;border-radius:99px}
.t{font-size:12px;color:var(--mute)}.err{color:#dc2626}
form{width:100%;max-width:760px;margin:0 auto;padding:8px 24px 20px;position:sticky;bottom:0;background:var(--bg)}
textarea{width:100%;resize:none;border:1px solid var(--line);border-radius:14px;padding:12px 14px;font:inherit;background:var(--bg);color:var(--fg);outline:none;max-height:200px;overflow-y:hidden;display:block}
textarea:focus{border-color:var(--mute)}
.home{display:flex;flex-direction:column;justify-content:center}.home #log{flex:none;padding:0}.home form{position:static}
#tg{display:none}
#shx{position:fixed;top:10px;right:14px;z-index:1;display:flex;gap:6px}
#shx>button{border:0;background:var(--soft);color:var(--fg);border-radius:8px;padding:6px 12px;font:inherit;font-size:13px;cursor:pointer}#shx>button:hover{background:var(--line)}
#sp{position:absolute;top:38px;right:0;min-width:270px;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:4px;box-shadow:0 8px 24px #0002}
.sr{display:flex;align-items:center;gap:4px;padding:4px 8px;font-size:13px}.sr span{flex:1;color:var(--mute)}
.sr button{border:0;background:none;color:var(--accent);cursor:pointer;font:inherit;font-size:13px;padding:2px 6px;border-radius:6px}.sr button:hover{background:var(--soft)}
.sr button[data-d]{color:var(--mute)}.sr button[data-d]:hover{color:#dc2626}
.res{margin:0 0 10px}.res summary{cursor:pointer;color:var(--mute);font-size:13px;width:fit-content}.res summary:hover{color:var(--fg)}
.res .r{margin:12px 0 0;font-size:14px}.res .r a{font-weight:500}.res .r span{display:block;color:var(--mute);font-size:12px}
.res .r p{margin:2px 0 0;font-size:13px;line-height:1.5}
.gal{display:flex;flex-wrap:wrap;gap:8px;margin:6px 0 14px}
.m img.mi{height:180px;max-width:100%;object-fit:cover;border-radius:10px;display:block;background:var(--soft)}
.m p img.mi{margin:6px 0}
#side .me{margin-top:auto;display:flex;justify-content:space-between;align-items:center;gap:8px;padding:10px;font-size:13px;color:var(--mute)}
#side .me span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.auth{width:100%;max-width:340px;margin:0 auto;display:flex;flex-direction:column;gap:12px;padding:24px}
.auth h1{font-size:22px;margin:0 0 8px;text-align:center}
.btn{font:inherit;padding:10px 14px;border-radius:12px;border:0;background:var(--fg);color:var(--bg);cursor:pointer;font-weight:600}
.or{text-align:center;color:var(--mute);font-size:13px;margin-top:8px}
#up{display:flex;gap:8px;padding:0;margin:0;position:static;max-width:none}
#up input{flex:1;min-width:0;font:inherit;padding:9px 12px;border-radius:12px;border:1px solid var(--line);background:var(--bg);color:var(--fg);outline:none}
#up button{font:inherit;padding:9px 14px;border-radius:12px;border:1px solid var(--line);background:var(--soft);color:var(--fg);cursor:pointer}
@media (max-width:720px){#side{position:fixed;z-index:2;left:0;top:0;transform:translateX(-100%);transition:transform .2s;box-shadow:0 0 24px #0003;padding-top:52px}
body.open #side{transform:none}#tg{display:block;position:fixed;top:10px;left:10px;z-index:3;border:0;background:var(--soft);color:var(--fg);border-radius:8px;width:34px;height:34px;font-size:16px}
#log{padding-top:52px}}
`;

/** Message rendering, shared by the app and the read-only share page. */
const RENDER = `
const $=s=>document.querySelector(s),log=$('#log');
const E1=s=>s.replace(/[&<>"]/g,c=>'&#'+c.charCodeAt(0)+';');
let IM=[],SRC=[];
const pic=(u,alt)=>u?'<a href="'+u+'" target="_blank" rel="noopener"><img class="mi" src="'+u+'" alt="'+alt+'" title="'+alt+'" referrerpolicy="no-referrer" onerror="this.parentNode.remove()" onload="if(this.naturalWidth<120)this.parentNode.remove()"></a>':'';
const inl=s=>E1(s).replace(/\`([^\`]+)\`/g,'<code>$1</code>').replace(/\\*\\*([^*]+)\\*\\*/g,'<b>$1</b>')
 .replace(/!\\[([^\\]]*)\\]\\((?:img:(\\d+)|(https:[^)\\s]+))\\)/g,(_,a,n,u)=>pic(n?E1(IM[n-1]||''):u,a))
 .replace(/\\[([^\\]]+)\\]\\((https?:[^)\\s]+)\\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>')
 .replace(/\\[(\\d+(?:,\\s*\\d+)*)\\](?!\\()/g,(m,l)=>SRC.length?'<sup>'+l.split(/,\\s*/).map(n=>SRC[n-1]?'<a href="'+E1(SRC[n-1].uri)+'" target="_blank" rel="noopener">'+n+'</a>':n).join(',')+'</sup>':m);
function blk(p){let o='',l=null,pa=[],ga=[];
 const fp=()=>{if(pa.length){o+='<p>'+pa.map(inl).join('<br>')+'</p>';pa=[]}if(l){o+='</'+l+'>';l=null}};
 const fg=()=>{if(ga.length){o+='<div class="gal">'+ga.map(inl).join('')+'</div>';ga=[]}};
 for(const ln of p.split('\\n')){let m;
  if(/^\\s*(!\\[[^\\]]*\\]\\([^)\\s]+\\)\\s*)+$/.test(ln)){fp();ga.push(ln)}
  else if(!ln.trim())fp();
  else{fg();
   if(m=ln.match(/^#{1,4}\\s+(.*)/)){fp();o+='<h4>'+inl(m[1])+'</h4>'}
   else if(m=ln.match(/^\\s*([-*]|\\d+[.)])\\s+(.*)/)){const t=/\\d/.test(m[1])?'ol':'ul';if(pa.length||l!==t){fp();o+='<'+t+'>';l=t}o+='<li>'+inl(m[2])+'</li>'}
   else{if(l){o+='</'+l+'>';l=null}pa.push(ln)}}}
 fp();fg();return o}
const md=(s,im,src)=>{IM=im||[];SRC=src||[];return s.split('\`\`\`').map((p,i)=>i%2?'<pre><code>'+E1(p.replace(/^[^\\n]*\\n/,''))+'</code></pre>':blk(p)).join('')};
function add(c,html){const d=document.createElement('div');d.className=c;d.innerHTML=html;log.append(d);return d}
function resl(r,after){if(!r||!r.length)return;const d=document.createElement('details');d.className='res';
 d.innerHTML='<summary>Search results</summary>'+r.map(x=>'<div class="r"><a href="'+E1(x.url)+'" target="_blank" rel="noopener">'+E1(x.title||x.url)+'</a><span>'
  +E1(x.url.split('/')[2].replace(/^www\\./,'')+(x.date?' · '+x.date:''))+'</span><p>'+E1(x.text)+'</p></div>').join('');
 after?after.after(d):log.append(d)}
function srcs(s){s=(s||[]).filter((x,i,a)=>a.findIndex(y=>y.title===x.title)===i);if(s.length)add('src',s.map(x=>'<a href="'+E1(x.uri)+'" target="_blank" rel="noopener">'+E1(x.title)+'</a>').join(''))}`;

const JS = `
const ta=$('textarea'),side=$('#list');
let cur=null,raf=0;
function start(t0){cur={el:add('m wait',''),buf:'',t0,first:0,imgs:[]}}
function paint(){raf=0;cur.el.innerHTML=md(cur.buf.replace(/!\\[[^\\]\\n]*(\\]\\([^)\\n]*)?$/,''),cur.imgs,cur.src)}
const main=$('main');let nearEnd=true;main.addEventListener('scroll',()=>{nearEnd=main.scrollHeight-main.scrollTop-main.clientHeight<80});
new ResizeObserver(()=>{if(nearEnd)main.scrollTop=main.scrollHeight}).observe(log);
function T(t){if(!cur.first)cur.first=performance.now()-cur.t0;cur.buf+=t;if(!raf)raf=requestAnimationFrame(paint)}
function D(s){cur.src=s;paint();cur.el.classList.remove('wait');srcs(s);
 add('t','first token '+(cur.first/1000).toFixed(2)+' s · done '+((performance.now()-cur.t0)/1000).toFixed(2)+' s');
 S.msgs.push({role:'model',text:cur.buf});cur=null;busy=false}
function I(u){cur.imgs=u}
function R(r){resl(r,cur.el)}
function E(m){cur.el.classList.remove('wait');cur.el.insertAdjacentHTML('beforeend','<p class="err">'+E1(m)+'</p>');cur=null;busy=false}
function L(list){if(S.id&&!list.some(c=>c.id===S.id))list.unshift({id:S.id,title:S.title});
 try{localStorage['chats:'+S.uid]=JSON.stringify(list.slice(0,300))}catch{}
 side.innerHTML=list.map(c=>'<a class="it'+(c.id===S.id?' on':'')+'" href="/c/'+c.id+'"><span>'+E1(c.title)+'</span><button data-id="'+c.id+'" title="Delete">×</button></a>').join('')}
side.addEventListener('click',e=>{const id=e.target.dataset&&e.target.dataset.id;if(!id)return;e.preventDefault();
 fetch('/api/chats/'+id,{method:'DELETE'});e.target.closest('a').remove();if(id===S.id)location.href='/'});
try{L(JSON.parse(localStorage['chats:'+S.uid]||'[]'))}catch{}
for(const m of S.msgs){if(m.role==='user')add('u',E1(m.text));else{add('m',md(m.text,m.images,m.sources));resl(m.results);srcs(m.sources)}}
S.msgs=S.msgs.map(({role,text})=>({role,text}));
let busy=false;
if(S.streaming){busy=true;start(0);history.replaceState(null,'','/c/'+S.id)}
async function ask(q){if(busy)return;busy=true;S.msgs.push({role:'user',text:q});add('u',E1(q));start(performance.now());main.scrollTop=main.scrollHeight;
 try{const r=await fetch('/api/chats/'+S.id,{method:'POST',body:JSON.stringify({title:S.title,msgs:S.msgs})});
  if(!r.ok)throw new Error('HTTP '+r.status);
  const rd=r.body.pipeThrough(new TextDecoderStream()).getReader();let buf='';
  for(;;){const {value,done}=await rd.read();if(done)break;buf+=value;const parts=buf.split('\\u0000');buf=parts.pop();
   for(const p of parts){const k=p[0],v=p.slice(1);if(k==='T')T(v);else if(k==='I')I(JSON.parse(v));else if(k==='R')R(JSON.parse(v));else if(k==='D')D(JSON.parse(v));else if(k==='E')E(v)}}
  if(cur)E('Connection closed.')}catch(e){E(String(e.message||e))}}
$('form').addEventListener('submit',e=>{const q=ta.value.trim();if(!S.id)return;e.preventDefault();if(!q||busy)return;ta.value='';fit();ask(q)});
ta.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('form').requestSubmit()}});
const fit=()=>{ta.style.height='auto';const h=ta.scrollHeight+ta.offsetHeight-ta.clientHeight;ta.style.height=h+'px';ta.style.overflowY=h>200?'auto':'hidden'};
ta.addEventListener('input',fit);
$('#tg').onclick=()=>document.body.classList.toggle('open');main.addEventListener('click',()=>document.body.classList.remove('open'));
if(!S.streaming)ta.focus();
// New search in place: no page load. A streaming answer loads the home page instead so it keeps saving.
function fresh(){document.body.classList.remove('open');
 if(!S.id){ta.focus();return}
 if(cur){location.href='/';return}
 S.id=null;S.msgs=[];S.title='Quick';S.shares=[];log.innerHTML='';main.classList.add('home');
 const x=$('#shx');if(x)x.remove();side.querySelectorAll('.on').forEach(e=>e.classList.remove('on'));
 document.title='Quick';ta.placeholder='Ask anything';ta.value='';fit();history.pushState(null,'','/');ta.focus()}
document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&!e.shiftKey&&!e.altKey&&e.key.toLowerCase()==='k'){e.preventDefault();fresh()}});
$('.new').addEventListener('click',e=>{if(e.metaKey||e.ctrlKey||e.shiftKey||e.button)return;e.preventDefault();fresh()});
addEventListener('popstate',()=>location.reload());
if(!/Mac|iPhone|iPad/.test(navigator.platform))$('.new kbd').textContent='Ctrl K';
const shx=$('#shx'),sh=$('#sh'),sl=$('#sl'),sp=$('#sp'),shareUrl=id=>location.origin+'/s/'+id;
const when=t=>new Date(t).toLocaleString([],{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
function SL(){if(!sl)return;const n=S.shares.length;sl.hidden=!n;sl.textContent=n+(n>1?' links':' link');if(!n)sp.hidden=true;
 sp.innerHTML=S.shares.map(x=>'<div class="sr"><span>'+when(x.created)+'</span><button data-c="'+x.id+'">Copy</button><button data-d="'+x.id+'">Delete</button></div>').join('')}
if(sh){SL();
 sl.onclick=()=>{sp.hidden=!sp.hidden};
 document.addEventListener('click',e=>{if(!shx.contains(e.target))sp.hidden=true});
 sp.onclick=e=>{const c=e.target.dataset.c,d=e.target.dataset.d;
  if(c)navigator.clipboard.writeText(shareUrl(c)).then(()=>{e.target.textContent='Copied';setTimeout(()=>e.target.textContent='Copy',1500)});
  if(d){fetch('/api/chats/'+S.id+'/shares/'+d,{method:'DELETE'});S.shares=S.shares.filter(x=>x.id!==d);SL()}};
 sh.onclick=()=>{if(busy)return;const label=sh.textContent;
  const made=fetch('/api/chats/'+S.id+'/share',{method:'POST',body:JSON.stringify({n:S.msgs.length})})
   .then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.json()});
  made.then(j=>{S.shares.unshift({id:j.id,created:j.created});SL()},()=>{});
  const link=made.then(j=>j.url),show=t=>{sh.textContent=t;setTimeout(()=>sh.textContent=label,2000)};
  const plain=()=>link.then(u=>navigator.clipboard.writeText(u));
  (window.ClipboardItem&&navigator.clipboard.write
   ?navigator.clipboard.write([new ClipboardItem({'text/plain':link.then(u=>new Blob([u],{type:'text/plain'}))})]).catch(plain)
   :plain()).then(()=>show('Link copied'),()=>show('Could not copy'))}}
`;

export function shell(o: { id: string | null; title: string; msgs: Msg[]; streaming: boolean; user: { u: string; n: string }; shares?: ShareRef[] }) {
  const state = { id: o.id, title: o.title, msgs: o.msgs, streaming: o.streaming, uid: o.user.u, shares: o.shares ?? [] };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(o.title)}</title>
<link rel="search" type="application/opensearchdescription+xml" title="Quick" href="/opensearch.xml">
<style>${CSS}</style></head>
<body><button id="tg" aria-label="Chats">☰</button>
<nav id="side"><a class="new" href="/">+ New chat<kbd>⌘K</kbd></a><div id="list"></div>
<div class="me"><span>${esc(o.user.n)}</span><a href="/auth/logout">Sign out</a></div></nav>
<main class="${o.id ? "" : "home"}"><div id="log"></div>
<form action="/" method="get"><textarea name="q" rows="1" placeholder="${o.id ? "Ask a follow-up" : "Ask anything"}" autocomplete="off"></textarea></form></main>
${o.id ? '<div id="shx"><button id="sl" hidden></button><button id="sh">Share</button><div id="sp" hidden></div></div>' : ""}
<script>const S=${json(state)};${RENDER}${JS}</script>
`;
}

/** Changes whenever the share page's code changes, so cached share pages never outlive a deploy. */
export const PAGE_VERSION = [...CSS + RENDER].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261).toString(36);

/** Read-only snapshot of a chat for anyone with the link: no sidebar, no input, no account. */
export function sharePage(s: { title: string; msgs: Msg[] }) {
  const answer = s.msgs.find((m) => m.role === "model");
  const summary = (answer?.text ?? "").replace(/!\[[^\]]*\]\([^)]*\)|[*#`>_]/g, "").replace(/\s+/g, " ").trim().slice(0, 200);
  const n = Number(answer?.text.match(/\]\(img:(\d+)\)/)?.[1] ?? 0);
  const image = n ? answer?.images?.[n - 1] : undefined;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(s.title)}</title><meta name="robots" content="noindex">
<meta property="og:site_name" content="Quick"><meta property="og:title" content="${esc(s.title)}"><meta property="og:description" content="${esc(summary)}">
${image ? `<meta property="og:image" content="${esc(image)}"><meta name="twitter:card" content="summary_large_image">` : ""}
<style>${CSS}</style></head><body><main><div id="log"></div></main>
<script>const S=${json({ msgs: s.msgs })};${RENDER}for(const m of S.msgs){if(m.role==='user')add('u',E1(m.text));else{add('m',md(m.text,m.images,m.sources));srcs(m.sources)}}</script></body></html>`;
}

const page = (body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Quick</title><style>${CSS}</style></head><body><main class="home">${body}</main></body></html>`;

export const keyPage = (bad: boolean) => page(`<div id="log"></div>
<form action="/" method="get"><textarea name="k" rows="1" placeholder="${bad ? "Wrong key. Try again" : "Access key"}"></textarea></form>
<script>const t=document.querySelector('textarea');t.focus();t.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();t.form.submit()}}</script>`);

const AUTH_JS = String.raw`
const b2u=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const u2b=s=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-s.length%4)%4)),c=>c.charCodeAt(0));
const post=(p,b)=>fetch(p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b||{})}).then(r=>r.json());
const msg=document.getElementById('msg'),ids=l=>(l||[]).map(x=>({...x,id:u2b(x.id)}));
async function go(f){msg.textContent='';try{const r=await f();if(r.error)msg.textContent=r.error;else location.reload()}
 catch(e){msg.textContent=e.name==='NotAllowedError'?'Cancelled.':e.message}}
document.getElementById('in').onclick=()=>go(async()=>{const o=await post('/auth/login/options');
 const c=await navigator.credentials.get({publicKey:{...o,challenge:u2b(o.challenge),allowCredentials:ids(o.allowCredentials)}});
 const r=c.response;return post('/auth/login/verify',{id:c.id,rawId:b2u(c.rawId),type:c.type,clientExtensionResults:c.getClientExtensionResults(),
  authenticatorAttachment:c.authenticatorAttachment,response:{clientDataJSON:b2u(r.clientDataJSON),authenticatorData:b2u(r.authenticatorData),
  signature:b2u(r.signature),userHandle:r.userHandle?b2u(r.userHandle):undefined}})});
document.getElementById('up').onsubmit=e=>{e.preventDefault();const n=e.target.n.value.trim();if(!n)return;
 go(async()=>{const o=await post('/auth/register/options',{name:n});if(o.error)return o;
  const c=await navigator.credentials.create({publicKey:{...o,challenge:u2b(o.challenge),user:{...o.user,id:u2b(o.user.id)},excludeCredentials:ids(o.excludeCredentials)}});
  const r=c.response;return post('/auth/register/verify',{id:c.id,rawId:b2u(c.rawId),type:c.type,clientExtensionResults:c.getClientExtensionResults(),
   authenticatorAttachment:c.authenticatorAttachment,response:{clientDataJSON:b2u(r.clientDataJSON),attestationObject:b2u(r.attestationObject),
   transports:r.getTransports?r.getTransports():[]}})})};
`;

export const signIn = () => page(`<div class="auth"><h1>Quick</h1>
<button id="in" class="btn">Sign in with passkey</button>
<div class="or">New here? Create an account</div>
<form id="up"><input name="n" placeholder="Your name" autocomplete="username webauthn"><button>Create</button></form>
<p id="msg" class="err"></p></div><script>${AUTH_JS}</script>`);

export const opensearch = (origin: string) => `<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
<ShortName>Quick</ShortName><Description>Fast answers with web search</Description><InputEncoding>UTF-8</InputEncoding>
<Url type="text/html" method="get" template="${origin}/?q={searchTerms}"/>
</OpenSearchDescription>`;
