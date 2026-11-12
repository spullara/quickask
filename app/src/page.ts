export type Source = { title: string; uri: string };
export type Msg = { role: "user" | "model"; text: string; sources?: Source[]; images?: string[] };

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
#side .new{display:block;padding:8px 10px;border-radius:8px;color:var(--fg);font-weight:600;margin-bottom:8px}
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
textarea{width:100%;resize:none;border:1px solid var(--line);border-radius:14px;padding:12px 14px;font:inherit;background:var(--bg);color:var(--fg);outline:none;max-height:200px}
textarea:focus{border-color:var(--mute)}
.home{display:flex;flex-direction:column;justify-content:center}.home #log{flex:none;padding:0}.home form{position:static}
#tg{display:none}
.imgs{display:flex;gap:8px;overflow-x:auto;margin:4px 0 12px;scrollbar-width:none}.imgs:empty{display:none}
.imgs a{flex:none}.imgs img{height:120px;border-radius:10px;display:block;background:var(--soft)}
.m img.mi{max-width:100%;max-height:320px;border-radius:10px;display:block;margin:8px 0}
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

const JS = `
const $=s=>document.querySelector(s),log=$('#log'),ta=$('textarea'),side=$('#list');
const E1=s=>s.replace(/[&<>"]/g,c=>'&#'+c.charCodeAt(0)+';');
const inl=s=>E1(s).replace(/\`([^\`]+)\`/g,'<code>$1</code>').replace(/\\*\\*([^*]+)\\*\\*/g,'<b>$1</b>')
 .replace(/!\\[([^\\]]*)\\]\\((https:[^)\\s]+)\\)/g,'<img class="mi" src="$2" alt="$1" referrerpolicy="no-referrer" onerror="this.remove()">')
 .replace(/\\[([^\\]]+)\\]\\((https?:[^)\\s]+)\\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>');
function blk(p){let o='',l=null,pa=[];const fl=()=>{if(pa.length){o+='<p>'+pa.map(inl).join('<br>')+'</p>';pa=[]}if(l){o+='</'+l+'>';l=null}};
 for(const ln of p.split('\\n')){let m;
  if(m=ln.match(/^#{1,4}\\s+(.*)/)){fl();o+='<h4>'+inl(m[1])+'</h4>'}
  else if(m=ln.match(/^\\s*([-*]|\\d+[.)])\\s+(.*)/)){const t=/\\d/.test(m[1])?'ol':'ul';if(pa.length||l!==t){fl();o+='<'+t+'>';l=t}o+='<li>'+inl(m[2])+'</li>'}
  else if(!ln.trim())fl();else{if(l){o+='</'+l+'>';l=null}pa.push(ln)}}
 fl();return o}
const md=s=>s.split('\`\`\`').map((p,i)=>i%2?'<pre><code>'+E1(p.replace(/^[^\\n]*\\n/,''))+'</code></pre>':blk(p)).join('');
function add(c,html){const d=document.createElement('div');d.className=c;d.innerHTML=html;log.append(d);return d}
function srcs(s){if(s&&s.length)add('src',s.map(x=>'<a href="'+E1(x.uri)+'" target="_blank" rel="noopener">'+E1(x.title)+'</a>').join(''))}
function pics(u,before){if(!u||!u.length)return;const d=document.createElement('div');d.className='imgs';
 d.innerHTML=u.map(x=>'<a href="'+E1(x)+'" target="_blank" rel="noopener"><img src="'+E1(x)+'" alt="" referrerpolicy="no-referrer" onerror="this.parentNode.remove()" onload="const w=this.naturalWidth,h=this.naturalHeight;if(w<200||h<120||w/h>2.4||h/w>2)this.parentNode.remove()"></a>').join('');
 before?before.before(d):log.append(d)}
let cur=null,raf=0;
function start(t0){cur={el:add('m wait',''),buf:'',t0,first:0}}
function paint(){raf=0;cur.el.innerHTML=md(cur.buf);if(nearEnd)main.scrollTop=main.scrollHeight}
const main=$('main');let nearEnd=true;main.addEventListener('scroll',()=>{nearEnd=main.scrollHeight-main.scrollTop-main.clientHeight<80});
function T(t){if(!cur.first)cur.first=performance.now()-cur.t0;cur.buf+=t;if(!raf)raf=requestAnimationFrame(paint)}
function D(s){paint();cur.el.classList.remove('wait');srcs(s);
 add('t','first token '+(cur.first/1000).toFixed(2)+' s · done '+((performance.now()-cur.t0)/1000).toFixed(2)+' s');
 S.msgs.push({role:'model',text:cur.buf});cur=null;busy=false}
function I(u){pics(u,cur.buf?null:cur.el)}
function E(m){cur.el.classList.remove('wait');cur.el.insertAdjacentHTML('beforeend','<p class="err">'+E1(m)+'</p>');cur=null;busy=false}
function L(list){if(S.id&&!list.some(c=>c.id===S.id))list.unshift({id:S.id,title:S.title});
 try{localStorage['chats:'+S.uid]=JSON.stringify(list.slice(0,300))}catch{}
 side.innerHTML=list.map(c=>'<a class="it'+(c.id===S.id?' on':'')+'" href="/c/'+c.id+'"><span>'+E1(c.title)+'</span><button data-id="'+c.id+'" title="Delete">×</button></a>').join('')}
side.addEventListener('click',e=>{const id=e.target.dataset&&e.target.dataset.id;if(!id)return;e.preventDefault();
 fetch('/api/chats/'+id,{method:'DELETE'});e.target.closest('a').remove();if(id===S.id)location.href='/'});
try{L(JSON.parse(localStorage['chats:'+S.uid]||'[]'))}catch{}
for(const m of S.msgs){if(m.role==='user')add('u',E1(m.text));else{pics(m.images);add('m',md(m.text));srcs(m.sources)}}
S.msgs=S.msgs.map(({role,text})=>({role,text}));
let busy=false;
if(S.streaming){busy=true;start(0);history.replaceState(null,'','/c/'+S.id)}
async function ask(q){if(busy)return;busy=true;S.msgs.push({role:'user',text:q});add('u',E1(q));start(performance.now());main.scrollTop=main.scrollHeight;
 try{const r=await fetch('/api/chats/'+S.id,{method:'POST',body:JSON.stringify({title:S.title,msgs:S.msgs})});
  if(!r.ok)throw new Error('HTTP '+r.status);
  const rd=r.body.pipeThrough(new TextDecoderStream()).getReader();let buf='';
  for(;;){const {value,done}=await rd.read();if(done)break;buf+=value;const parts=buf.split('\\u0000');buf=parts.pop();
   for(const p of parts){const k=p[0],v=p.slice(1);if(k==='T')T(v);else if(k==='I')I(JSON.parse(v));else if(k==='D')D(JSON.parse(v));else if(k==='E')E(v)}}
  if(cur)E('Connection closed.')}catch(e){E(String(e.message||e))}}
$('form').addEventListener('submit',e=>{const q=ta.value.trim();if(!S.id)return;e.preventDefault();if(!q||busy)return;ta.value='';ask(q)});
ta.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('form').requestSubmit()}});
ta.addEventListener('input',()=>{ta.style.height='auto';ta.style.height=ta.scrollHeight+'px'});
$('#tg').onclick=()=>document.body.classList.toggle('open');main.addEventListener('click',()=>document.body.classList.remove('open'));
if(!S.streaming)ta.focus();
`;

export function shell(o: { id: string | null; title: string; msgs: Msg[]; streaming: boolean; user: { u: string; n: string } }) {
  const state = { id: o.id, title: o.title, msgs: o.msgs, streaming: o.streaming, uid: o.user.u };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(o.title)}</title>
<link rel="search" type="application/opensearchdescription+xml" title="Quick" href="/opensearch.xml">
<style>${CSS}</style></head>
<body><button id="tg" aria-label="Chats">☰</button>
<nav id="side"><a class="new" href="/">+ New chat</a><div id="list"></div>
<div class="me"><span>${esc(o.user.n)}</span><a href="/auth/logout">Sign out</a></div></nav>
<main class="${o.id ? "" : "home"}"><div id="log"></div>
<form action="/" method="get"><textarea name="q" rows="1" placeholder="${o.id ? "Ask a follow-up" : "Ask anything"}" autocomplete="off"></textarea></form></main>
<script>const S=${json(state)};${JS}</script>
`;
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
