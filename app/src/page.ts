export type Source = { title: string; uri: string };
export type Result = { title: string; url: string; date?: string; text: string };
export type Msg = { role: "user" | "model"; text: string; sources?: Source[]; images?: string[]; results?: Result[]; followups?: string[]; model?: string };
export type ShareRef = { id: string; created: number };
type Row = { day?: string; user?: string; searches: number; exa: number; gemini: number; cost: number; tokensIn: number; tokensOut: number };

const json = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/\u2028|\u2029/g, "");
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** A streamed instruction to the page: one inline script per event. */
export const call = (fn: string, arg: unknown) => `<script>${fn}(${json(arg)})</script>\n`;

import { LOGO_SVG } from "./icons.ts";

const ICON_LINKS = `<link rel="icon" href="/icon.svg" type="image/svg+xml"><link rel="icon" href="/favicon.ico" sizes="32x32"><link rel="apple-touch-icon" href="/apple-touch-icon.png">`;
const mark = (px: number) => LOGO_SVG.replace("<svg ", `<svg width="${px}" height="${px}" aria-hidden="true" `);
const BRAND = `<div class="brand">${mark(44)}<span>QuickAsk</span></div>`;

/** Chat text size chosen with A−/A+, saved per browser; set before the page draws so there is no flash. */
const TEXT_SIZE = `<script>document.documentElement.style.setProperty('--chat',15*(+localStorage.zoom||1)+'px')</script>`;

/** iOS ignores user-scalable=no for pinch, so cancel WebKit gesture events and two-finger moves. */
const NO_ZOOM = `<script>for(const t of ['gesturestart','gesturechange'])document.addEventListener(t,e=>e.preventDefault());
document.addEventListener('touchmove',e=>{if(e.touches.length>1)e.preventDefault()},{passive:false})</script>`;

const CSS = `
:root{--bg:#fff;--fg:#1d1d1f;--mute:#6e6e73;--soft:#f4f4f5;--line:#e4e4e7;--accent:#2563eb;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#18181b;--fg:#ececee;--mute:#9a9aa1;--soft:#232327;--line:#2f2f34;--accent:#7aa2ff}}
*{box-sizing:border-box}html,body{margin:0;height:100%}html{touch-action:manipulation;-webkit-text-size-adjust:100%}
body{font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif;background:var(--bg);color:var(--fg);display:flex}
/* The conversation and its input use the chosen text size (A−/A+); sizes inside are relative to it. */
#log,main form{font-size:var(--chat,15px)}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
#side{width:260px;flex:none;background:var(--soft);height:100vh;height:100dvh;overflow:hidden;padding:12px 8px;display:flex;flex-direction:column}
/* The chat list shows a thin scrollbar only on hover (its space is always kept, so nothing shifts); the footer
   (cost, user) stays pinned below it. */
#scroll{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:2px;scrollbar-width:thin;scrollbar-color:transparent transparent}
#scroll:hover{scrollbar-color:color-mix(in srgb,var(--mute) 50%,transparent) transparent}
#scroll::-webkit-scrollbar{width:8px}#scroll::-webkit-scrollbar-thumb{background:transparent;border-radius:4px}#scroll:hover::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--mute) 50%,transparent)}
#foot{flex:none;padding-top:4px}
#side .new{display:flex;align-items:center;padding:8px 10px;border-radius:8px;color:var(--fg);font-weight:600;margin-bottom:8px}
#side .top{display:flex;align-items:center;gap:2px;margin-bottom:8px}#side .top .new{flex:1;margin-bottom:0}
#fs{border:0;background:none;color:var(--mute);width:34px;height:34px;border-radius:8px;display:flex;align-items:center;justify-content:center;cursor:pointer;flex:none}#fs:hover{background:var(--line);color:var(--fg)}
#find{display:flex;align-items:center;gap:4px;margin:0 0 8px;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:0 4px 0 10px}#find[hidden]{display:none}
#find input{flex:1;min-width:0;border:0;outline:none;background:none;color:var(--fg);font:inherit;font-size:14px;padding:7px 0}
#find button{border:0;background:none;color:var(--mute);font-size:16px;cursor:pointer;padding:2px 6px}
@media (hover:none){#find input{font-size:16px}}
#side .it small{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;white-space:normal;color:var(--mute);font-size:12px;line-height:1.4;margin-top:2px}
#side .it small b{color:var(--fg);font-weight:600}#side .none{color:var(--mute);font-size:13px;padding:6px 10px}
#side .new kbd{margin-left:auto;font:500 11px/1 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;color:var(--mute);background:var(--bg);border-radius:5px;padding:4px 6px}
@media (hover:none){#side .new kbd{display:none}}
#side .new:hover,#side .it:hover{background:var(--line);text-decoration:none}
#side .it{position:relative;display:flex;align-items:center;border-radius:8px;color:var(--fg);padding:6px 10px;font-size:14px;background:var(--soft);transition:transform .2s ease;touch-action:pan-y}
.row{position:relative;overflow:hidden;border-radius:8px;flex:none}
.row:not(.sw) .del{visibility:hidden}
.row .del{position:absolute;top:0;right:0;bottom:0;width:80px;border:0;background:#dc2626;color:#fff;font:inherit;font-size:14px;font-weight:500}
#side .it span{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#side .it.on{background:var(--line)}
#side .it button{visibility:hidden;border:0;background:none;color:var(--mute);cursor:pointer;font-size:16px;padding:0 0 0 6px}
@media (hover:hover){#side .it:hover button{visibility:visible}}
@media (hover:none){#side .it button{display:none}}
main{flex:1;height:100vh;height:100dvh;overflow-y:auto;display:flex;flex-direction:column}
#log{width:100%;max-width:760px;margin:0 auto;padding:32px 24px 8px;flex:1}
.u{background:var(--soft);border-radius:14px;padding:8px 14px;margin:24px 0 12px auto;width:fit-content;max-width:85%;white-space:pre-wrap}
.m{margin-bottom:8px}.m p{margin:0 0 10px}.m h4{margin:.8em 0 .3em;font-size:1em}.m ul,.m ol{margin:0 0 10px;padding-left:22px}
.m pre{background:var(--soft);padding:10px 12px;border-radius:8px;overflow-x:auto;font-size:.87em}.m code{font:.87em ui-monospace,SFMono-Regular,Menlo,monospace}
.m.wait:empty::after,.m.wait>:last-child::after{content:"";display:inline-block;width:8px;height:8px;margin-left:4px;border-radius:50%;background:var(--mute);animation:p 1s infinite}
@keyframes p{50%{opacity:.25}}
.err{color:#dc2626}
.m sup a{position:relative;text-decoration:none;padding:0 1px}
.m sup a:hover::after{content:attr(data-t);position:absolute;left:50%;bottom:calc(100% + 4px);transform:translateX(-50%);white-space:nowrap;background:var(--fg);color:var(--bg);font-size:12px;font-weight:500;line-height:1;padding:5px 8px;border-radius:6px;pointer-events:none;z-index:2}
form{width:100%;max-width:760px;margin:0 auto;padding:8px 24px 20px;position:sticky;bottom:0;background:var(--bg)}
textarea{width:100%;resize:none;border:1px solid var(--line);border-radius:14px;padding:12px 14px;font:inherit;background:var(--bg);color:var(--fg);outline:none;max-height:300px;overflow-y:hidden;display:block}
textarea:focus{border-color:var(--mute)}
.home{display:flex;flex-direction:column;justify-content:center}.home #log{flex:none;padding:0}.home form{position:static}
#tg{display:none}
#zm{position:fixed;top:10px;left:272px;z-index:3;display:flex;gap:2px}#zm button{border:0;background:var(--soft);color:var(--fg);border-radius:8px;height:30px;padding:0 9px;font:600 13px/1 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;cursor:pointer}#zm button:hover{background:var(--line)}
.brand{display:flex;align-items:center;justify-content:center;gap:12px;margin:0 0 24px}.brand span{font-size:28px;font-weight:700;letter-spacing:-.02em}
#brand{display:none}.home #brand{display:flex}
.sbrand{display:flex;align-items:center;gap:8px;font-weight:600;font-size:15px;max-width:760px;margin:0 auto;padding:20px 24px 0}
#shx{position:fixed;top:10px;right:14px;z-index:1;display:flex;gap:6px}
#shx>button{border:0;background:var(--soft);color:var(--fg);border-radius:8px;padding:6px 12px;font:inherit;font-size:13px;cursor:pointer}#shx>button:hover{background:var(--line)}
#shx>button.on{background:var(--fg);color:var(--bg)}
#sp{position:absolute;top:38px;right:0;min-width:270px;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:4px;box-shadow:0 8px 24px #0002}
.sr{display:flex;align-items:center;gap:4px;padding:4px 8px;font-size:13px}.sr span{flex:1;color:var(--mute)}
.sr button{border:0;background:none;color:var(--accent);cursor:pointer;font:inherit;font-size:13px;padding:2px 6px;border-radius:6px}.sr button:hover{background:var(--soft)}
.sr button[data-d]{color:var(--mute)}.sr button[data-d]:hover{color:#dc2626}
.acts{height:1.8em;margin:-.3em 0 .3em}.acts button{border:0;background:none;color:var(--mute);font-size:1.2em;line-height:1;padding:3px 8px;border-radius:8px;cursor:pointer;opacity:0;transition:opacity .15s}
.m:hover+.acts button,.acts:hover button,.acts button:focus-visible{opacity:1}.acts button:hover{background:var(--soft);color:var(--fg)}
@media (hover:none){.acts button{opacity:.45}}
#menu{position:fixed;z-index:5;min-width:220px;background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:4px;box-shadow:0 8px 24px #0002;display:flex;flex-direction:column}#menu[hidden]{display:none}
#menu button{border:0;background:none;color:var(--fg);font:inherit;font-size:14px;text-align:left;padding:8px 10px;border-radius:6px;cursor:pointer}#menu button:hover:not(:disabled){background:var(--soft)}#menu button:disabled{color:var(--mute);cursor:default}
#sheet{position:fixed;inset:0;z-index:6;background:#0003;display:flex;justify-content:flex-end}#sheet[hidden]{display:none}
.sh-in{width:440px;max-width:100%;height:100%;overflow-y:auto;background:var(--bg);padding:0 20px 20px;box-shadow:-8px 0 24px #0002}
.sh-hd{position:sticky;top:0;background:var(--bg);display:flex;align-items:center;justify-content:space-between;padding:16px 0 8px}.sh-hd button{border:0;background:none;color:var(--mute);font-size:22px;cursor:pointer}
#sheet .r{margin:14px 0 0;font-size:14px}#sheet .r a{font-weight:500}#sheet .r span{display:block;color:var(--mute);font-size:12px}#sheet .r p{margin:2px 0 0;font-size:13px;line-height:1.5}
@media (max-width:720px){#sheet{align-items:flex-end}.sh-in{width:100%;height:75vh;border-radius:16px 16px 0 0}}
#toast{position:fixed;left:50%;bottom:96px;transform:translateX(-50%);background:var(--fg);color:var(--bg);padding:8px 14px;border-radius:10px;font-size:14px;z-index:7}#toast[hidden]{display:none}
.ugn{color:var(--mute);font-size:.8em;margin:0 0 .5em}
.fups{display:flex;flex-direction:column;align-items:flex-start;gap:6px;margin:0 0 18px}
.fu{border:1px solid var(--line);background:var(--bg);color:var(--fg);border-radius:12px;padding:.45em .8em;font:inherit;font-size:.93em;text-align:left;cursor:pointer;max-width:100%}.fu:hover{background:var(--soft)}
.navl{display:flex;flex-direction:column;gap:1px;width:fit-content;max-width:100%;background:var(--soft);border-radius:12px;padding:10px 14px;margin:2px 0 14px}
.navl:hover{background:var(--line);text-decoration:none}.navl b{font-weight:600}.navl span{color:var(--mute);font-size:.87em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gal{display:flex;flex-wrap:wrap;gap:8px;margin:6px 0 14px}
.m img.mi{height:12em;max-width:100%;object-fit:cover;border-radius:10px;display:block;background:var(--soft)}
.m p img.mi{margin:6px 0}
#side .me{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:10px;font-size:13px;color:var(--mute)}
#side .me span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#usage[hidden]{display:none}#usage{display:block;padding:8px 10px 0;font-size:13px;color:var(--mute)}#usage:hover{color:var(--fg);text-decoration:none}#usage:not([hidden])+.me{margin-top:0}
.auth{width:100%;max-width:340px;margin:0 auto;display:flex;flex-direction:column;gap:12px;padding:24px}
.auth h1{font-size:22px;margin:0 0 8px;text-align:center}
.btn{font:inherit;padding:10px 14px;border-radius:12px;border:0;background:var(--fg);color:var(--bg);cursor:pointer;font-weight:600}
.or{text-align:center;color:var(--mute);font-size:13px;margin-top:8px}
#up{display:flex;gap:8px;padding:0;margin:0;position:static;max-width:none}
#up input{flex:1;min-width:0;font:inherit;padding:9px 12px;border-radius:12px;border:1px solid var(--line);background:var(--bg);color:var(--fg);outline:none}
#up button{font:inherit;padding:9px 14px;border-radius:12px;border:1px solid var(--line);background:var(--soft);color:var(--fg);cursor:pointer}
@media (max-width:720px){#side{position:fixed;z-index:2;left:0;top:0;transform:translateX(-100%);transition:transform .2s;box-shadow:0 0 24px #0003;padding-top:52px}
#zm{left:52px;top:12px}body.open #side{transform:none}#tg{display:block;position:fixed;top:10px;left:10px;z-index:3;border:0;background:var(--soft);color:var(--fg);border-radius:8px;width:34px;height:34px;font-size:16px}
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
 .replace(/\\[([^\\]]+)\\]\\((https?:[^()\\s]*(?:\\([^()\\s]*\\)[^()\\s]*)*)\\)/g,'<a href="$2" target="_blank" rel="noopener">$1</a>')
 .replace(/\\[(\\d+(?:,\\s*\\d+)*)\\](?!\\()/g,(m,l)=>SRC.length?'<sup>'+l.split(/,\\s*/).map(n=>SRC[n-1]?'<a href="'+E1(SRC[n-1].uri)+'" target="_blank" rel="noopener" data-t="'+E1(SRC[n-1].title)+'" aria-label="'+E1(SRC[n-1].title)+'">'+n+'</a>':n).join(',')+'</sup>':m)
 .replace(/(?<![\\w"'=\\/@.>-])((?:https?:\\/\\/|www\\.)(?:[^\\s<()]|\\([^\\s<()]*\\))+|(?:[a-z0-9-]+\\.)+(?:com|org|net|io|dev|ai|app|co|gov|edu|me|tv|us|uk|ca|de|fr|jp|info|news)(?![\\w-])(?:\\/(?:[^\\s<()]|\\([^\\s<()]*\\))*)?)/gi,u=>{
  let t='';while(/[.,;:!?'"\\]]$/.test(u)){t=u.slice(-1)+t;u=u.slice(0,-1)}return '<a href="'+(/^https?:/i.test(u)?u:'https://'+u)+'" target="_blank" rel="noopener">'+u+'</a>'+t})
function blk(p){let o='',l=null,pa=[],ga=[];
 const fp=()=>{if(pa.length){o+='<p>'+pa.map(inl).join('<br>')+'</p>';pa=[]}if(l){o+='</'+l+'>';l=null}};
 const fg=()=>{if(ga.length){o+='<div class="gal">'+ga.map(inl).join('')+'</div>';ga=[]}};
 for(const ln of p.split('\\n')){let m;
  if(/^\\s*(!\\[[^\\]]*\\]\\([^)\\s]+\\)\\s*)+$/.test(ln)){fp();ga.push(ln)}
  else if(!ln.trim())fp();
  else{fg();
   if(m=ln.match(/^\\s*\\[([^\\]]+)\\]\\((https?:[^()\\s]*(?:\\([^()\\s]*\\)[^()\\s]*)*)\\)\\s*(?:\\[\\d+(?:,\\s*\\d+)*\\])?\\s*$/)){fp();const u=m[2].replace(/[?#].*$/,'');
    o+='<a class="navl" href="'+E1(u)+'" target="_blank" rel="noopener"><b>'+E1(m[1])+'</b><span>'+E1(u.replace(/^https?:\\/\\/(www\\.)?/,'').replace(/\\/$/,''))+'</span></a>'}
   else if(m=ln.match(/^#{1,4}\\s+(.*)/)){fp();o+='<h4>'+inl(m[1])+'</h4>'}
   else if(m=ln.match(/^\\s*([-*]|\\d+[.)])\\s+(.*)/)){const t=/\\d/.test(m[1])?'ol':'ul';if(pa.length||l!==t){fp();o+='<'+t+'>';l=t}o+='<li>'+inl(m[2])+'</li>'}
   else{if(l){o+='</'+l+'>';l=null}pa.push(ln)}}}
 fp();fg();return o}
const md=(s,im,src)=>{IM=im||[];SRC=src||[];return s.split('\`\`\`').map((p,i)=>i%2?'<pre><code>'+E1(p.replace(/^[^\\n]*\\n/,''))+'</code></pre>':blk(p)).join('')};
function add(c,html){const d=document.createElement('div');d.className=c;d.innerHTML=html;log.append(d);return d}
`;

const JS = `
const ta=$('textarea'),side=$('#list');
let cur=null,raf=0;
function start(el){if(el){el.classList.add('wait');el.innerHTML='';cur={el,buf:'',imgs:[]}}else cur={el:add('m wait',''),buf:'',imgs:[]};cur.model=S.model}
function paint(){raf=0;cur.el.innerHTML=(noSearch(cur.res)?NOSEARCH:'')+md(cutF(cur.buf).replace(/!\\[[^\\]\\n]*(\\]\\([^)\\n]*)?$/,''),cur.imgs,cur.src)}
const main=$('main');let nearEnd=true;main.addEventListener('scroll',()=>{nearEnd=main.scrollHeight-main.scrollTop-main.clientHeight<80});
new ResizeObserver(()=>{if(nearEnd)main.scrollTop=main.scrollHeight}).observe(log);
function T(t){cur.buf+=t;if(!raf)raf=requestAnimationFrame(paint)}
function D(s){cur.src=s;cur.buf=cutF(cur.buf).trim();paint();cur.el.classList.remove('wait');
 const m={role:'model',followups:cur.fups||[],text:cur.buf,sources:s,images:cur.imgs,results:cur.res||[],model:cur.model},at=cur.at;
 if(at!=null)S.msgs[at]=m;else S.msgs.push(m);note(cur.el,m);acts(cur.el,at!=null?at:S.msgs.length-1);cur=null;busy=false;chips()}
function R(r){cur.res=r}
// Label an answer given without search results (search failed, timed out or was rate limited): it is model memory only.
const NOSEARCH='<p class="ugn">Answered without search results – may be out of date or wrong</p>';
const noSearch=r=>Array.isArray(r)&&!r.length;
function note(el,m){if(noSearch(m.results)&&!el.querySelector('.ugn'))el.insertAdjacentHTML('afterbegin',NOSEARCH)}
function F(f){cur.fups=f}
// The model ends with ':::followups' and suggestions; never show that part (also while it is half streamed).
const cutF=s=>s.split(/\\n\\s*:::/)[0].replace(/\\n\\s*:{1,3}[a-z]*$/,'');
// Suggested follow-ups as chips under the latest answer only.
function chips(){log.querySelectorAll('.fups').forEach(e=>e.remove());const last=S.msgs[S.msgs.length-1];
 if(!last||last.role!=='model'||!last.followups||!last.followups.length)return;const a=log.querySelector('.acts[data-i="'+(S.msgs.length-1)+'"]');if(!a)return;
 const d=document.createElement('div');d.className='fups';d.innerHTML=last.followups.map(q=>'<button class="fu">'+E1(q)+'</button>').join('');a.after(d)}
log.addEventListener('click',e=>{const b=e.target.closest('.fu');if(!b||busy)return;ask(b.textContent)});
function I(u){cur.imgs=u}
function E(m){cur.el.classList.remove('wait');cur.el.insertAdjacentHTML('beforeend','<p class="err">'+E1(m)+'</p>');cur=null;busy=false}
// Sidebar: base is the loaded list (newest first, 50 per page, more on scroll). A search shows its own results instead.
let base=[],more=false,findQ='',found=[],findMore=false,loading=false;const PAGE=50,sideEl=$('#scroll');
const row=c=>'<div class="row"><button class="del" data-id="'+c.id+'">Delete</button><a class="it'+(c.id===S.id?' on':'')+'" href="/c/'+c.id+'"><span>'+E1(c.title)
 +(c.snip?'<small>'+E1(c.snip).replace(/\\u0001/g,'<b>').replace(/\\u0002/g,'</b>')+'</small>':'')+'</span><button data-id="'+c.id+'" title="Delete">×</button></a></div>';
function paintList(){const items=findQ?found:base;side.innerHTML=items.length?items.map(row).join(''):(findQ?'<div class="none">No matching chats</div>':'');
 if(sideEl.scrollHeight<=sideEl.clientHeight+200)page()}
// The first page, from the server or a live push. Older pages already loaded stay; anything newer that is gone was deleted.
function L(list){const ids=new Set(list.map(c=>c.id));
 if(list.length<PAGE){base=list;more=false}else{const oldest=list[list.length-1].updated;const older=base.filter(c=>!ids.has(c.id)&&c.updated<oldest);if(!older.length)more=true;base=list.concat(older)}
 if(S.id&&!base.some(c=>c.id===S.id))base.unshift({id:S.id,title:S.title,updated:Date.now()});
 try{localStorage['chats:'+S.uid]=JSON.stringify(base.slice(0,PAGE))}catch{}
 paintList()}
function page(){const q=findQ,items=q?found:base;if(loading||!(q?findMore:more)||!items.length)return;loading=true;
 fetch('/api/chats?before='+items[items.length-1].updated+(q?'&q='+encodeURIComponent(q):'')).then(r=>r.json()).then(p=>{loading=false;if(q!==findQ)return;
  const ids=new Set(items.map(c=>c.id)),add=p.filter(c=>!ids.has(c.id));if(q){found=found.concat(add);findMore=p.length>=PAGE}else{base=base.concat(add);more=p.length>=PAGE}paintList()},()=>{loading=false})}
sideEl.addEventListener('scroll',()=>{if(sideEl.scrollTop+sideEl.clientHeight>sideEl.scrollHeight-200)page()});
// Search chats: keywords match titles and message text; every word must match, as a prefix.
const find=$('#find'),fi=find.querySelector('input');let ft;
function closeFind(){find.hidden=true;fi.value='';findQ='';found=[];paintList()}
$('#fs').onclick=()=>{if(find.hidden){find.hidden=false;fi.focus()}else closeFind()};
find.querySelector('button').onclick=closeFind;
fi.addEventListener('keydown',e=>{if(e.key==='Escape'){e.stopPropagation();closeFind()}});
fi.addEventListener('input',()=>{clearTimeout(ft);ft=setTimeout(()=>{const q=fi.value.trim();findQ=q;if(!q){found=[];paintList();return}
 fetch('/api/chats?q='+encodeURIComponent(q)).then(r=>r.json()).then(p=>{if(q!==findQ)return;found=p;findMore=p.length>=PAGE;sideEl.scrollTop=0;paintList()},()=>{})},150)});
function del(id){fetch('/api/chats/'+id,{method:'DELETE'});base=base.filter(c=>c.id!==id);found=found.filter(c=>c.id!==id);
 const r=side.querySelector('[data-id="'+id+'"]');if(r)r.closest('.row').remove();if(id===S.id)location.href='/'}
// Swipe left on a row (touch): reveal Delete; a long swipe deletes; swipe back or tap to close.
let sw=null,opened=null,swiped=false;const shut=it=>{it.style.transform='';if(opened===it)opened=null;setTimeout(()=>{if(!it.style.transform)it.parentNode.classList.remove('sw')},220)};
side.addEventListener('touchstart',e=>{const it=e.target.closest('.it');if(!it)return;if(opened&&opened!==it)shut(opened);
 const t=e.touches[0];sw={it,x:t.clientX,y:t.clientY,dx:0,dir:null,base:it===opened?-80:0};it.style.transition='none';it.parentNode.classList.add('sw')},{passive:true});
side.addEventListener('touchmove',e=>{if(!sw)return;const t=e.touches[0],dx=t.clientX-sw.x,dy=t.clientY-sw.y;
 if(!sw.dir){if(Math.abs(dx)<8&&Math.abs(dy)<8)return;sw.dir=Math.abs(dx)>Math.abs(dy)?'x':'y'}
 if(sw.dir!=='x'){sw.it.style.transition='';if(opened!==sw.it)sw.it.parentNode.classList.remove('sw');sw=null;return}
 e.preventDefault();sw.dx=Math.min(0,sw.base+dx);sw.it.style.transform='translateX('+sw.dx+'px)'},{passive:false});
side.addEventListener('touchend',()=>{if(!sw)return;const {it,dx,dir}=sw;sw=null;it.style.transition='';if(dir!=='x'){if(opened!==it)it.parentNode.classList.remove('sw');return}
 swiped=true;setTimeout(()=>swiped=false,350);const id=it.querySelector('[data-id]').dataset.id;
 if(-dx>it.offsetWidth*.6){it.style.transform='translateX(-100%)';setTimeout(()=>del(id),200)}
 else if(-dx>40){it.style.transform='translateX(-80px)';opened=it}else shut(it)});
side.addEventListener('click',e=>{const id=e.target.dataset&&e.target.dataset.id;
 if(id){e.preventDefault();del(id);return}
 if(swiped||opened){e.preventDefault();if(opened)shut(opened)}});
try{L(JSON.parse(localStorage['chats:'+S.uid]||'[]'))}catch{}
// Each answer gets a faint ⋯ button below it (index into S.msgs in data-i).
function acts(el,i){let a=el.nextElementSibling;if(!a||!a.classList.contains('acts')){a=document.createElement('div');a.className='acts';a.innerHTML='<button aria-label="More">⋯</button>';el.after(a)}a.dataset.i=i}
function show(msgs){log.innerHTML='';msgs.forEach((m,i)=>{if(m.role==='user')add('u',E1(m.text));else{const el=add('m',md(m.text,m.images,m.sources));note(el,m);acts(el,i)}});chips()}
show(S.msgs);
let busy=false;
if(S.streaming){busy=true;start();history.replaceState(null,'','/c/'+S.id)}
// This page's id, so live updates it caused itself are skipped.
const CID=Math.random().toString(36).slice(2);
async function ask(q){if(busy)return;busy=true;log.querySelectorAll('.fups').forEach(e=>e.remove());S.msgs.push({role:'user',text:q});add('u',E1(q));run()}
// Rerun the last question (after a model switch): drop the old answer and answer again.
function rerun(){if(busy)return;let i=S.msgs.length-1;while(i>=0&&S.msgs[i].role!=='user')i--;if(i<0)return;
 S.msgs=S.msgs.slice(0,i+1);const us=log.querySelectorAll('.u'),lu=us[us.length-1];while(lu&&lu.nextSibling)lu.nextSibling.remove();busy=true;run()}
// o.el/o.at: answer again in place of that answer (o.model for this answer only); otherwise answer the last question.
async function run(o={}){start(o.el);if(o.model)cur.model=o.model;cur.at=o.at;if(!o.el)main.scrollTop=main.scrollHeight;
 const hist=(o.at!=null?S.msgs.slice(0,o.at):S.msgs).map(({role,text})=>({role,text}));
 try{const r=await fetch('/api/chats/'+S.id,{method:'POST',body:JSON.stringify({title:S.title,msgs:hist,model:cur.model,cid:CID,replace:o.at!=null})});
  if(!r.ok)throw new Error('HTTP '+r.status);
  const rd=r.body.pipeThrough(new TextDecoderStream()).getReader();let buf='';
  for(;;){const {value,done}=await rd.read();if(done)break;buf+=value;const parts=buf.split('\\u0000');buf=parts.pop();
   for(const p of parts){const k=p[0],v=p.slice(1);if(k==='T')T(v);else if(k==='I')I(JSON.parse(v));else if(k==='R')R(JSON.parse(v));else if(k==='F')F(JSON.parse(v));else if(k==='D')D(JSON.parse(v));else if(k==='E')E(v)}}
  if(cur)E('Connection closed.')}catch(e){E(String(e.message||e))}}
$('form').addEventListener('submit',e=>{const q=ta.value.trim();if(!S.id)return;e.preventDefault();if(!q||busy)return;ta.value='';fit();if(matchMedia('(hover:none)').matches)ta.blur();ask(q)});
ta.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();$('form').requestSubmit()}});
const fit=()=>{ta.style.height='auto';const h=ta.scrollHeight+ta.offsetHeight-ta.clientHeight;ta.style.height=h+'px';ta.style.overflowY=h>300?'auto':'hidden'};
ta.addEventListener('input',fit);
$('#tg').onclick=()=>document.body.classList.toggle('open');main.addEventListener('click',()=>document.body.classList.remove('open'));
if(!S.streaming)ta.focus();
// Admin only: the server answers 404 to everyone else, and the line stays hidden.
const ug=$('#usage');function cost(m){ug.hidden=false;ug.textContent='$'+m.cost.toFixed(2)+' this month · '+m.searches+' searches'}
function U(){fetch('/api/usage').then(r=>r.ok?r.json():null).then(j=>{if(j&&j.month)cost(j.month)},()=>{})}
U();
// New search in place: no page load. A streaming answer loads the home page instead so it keeps saving.
function fresh(){document.body.classList.remove('open');
 if(!S.id){ta.value='';fit();ta.focus();return}
 if(cur){location.href='/';return}
 S.id=null;S.msgs=[];S.title='QuickAsk';S.model='lite';S.shares=[];log.innerHTML='';main.classList.add('home');
 const x=$('#shx');if(x)x.remove();side.querySelectorAll('.on').forEach(e=>e.classList.remove('on'));
 document.title='QuickAsk';ta.placeholder='Ask anything';ta.value='';fit();history.pushState(null,'','/');ta.focus()}
document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&!e.shiftKey&&!e.altKey&&e.key.toLowerCase()==='k'){e.preventDefault();fresh()}});
$('.new').addEventListener('click',e=>{if(e.metaKey||e.ctrlKey||e.shiftKey||e.button)return;e.preventDefault();fresh()});
addEventListener('popstate',()=>location.reload());
// Text size: steps saved in this browser (localStorage), applied through the --chat CSS variable.
const ZOOMS=[.85,1,1.15,1.3,1.5,1.75,2];
$('#zm').onclick=e=>{const b=e.target.closest('button');if(!b)return;let i=ZOOMS.indexOf(+localStorage.zoom||1);if(i<0)i=1;
 const z=ZOOMS[Math.max(0,Math.min(ZOOMS.length-1,i+ +b.dataset.z))];localStorage.zoom=z;
 document.documentElement.style.setProperty('--chat',15*z+'px');toast('Text '+Math.round(z*100)+'%')};
// Another window added to this chat: load the saved copy and redraw it.
function sync(){const id=S.id;fetch('/api/chats/'+id).then(r=>r.ok?r.json():null).then(c=>{if(!c||S.id!==id||busy)return;
 S.title=c.title;S.model=c.model;ML();show(c.msgs);S.msgs=c.msgs},()=>{})}
// Live sidebar: the server pushes the chat list when any tab or device changes it.
let live=null;function connect(){if(live&&live.readyState<2)return;live=new WebSocket(location.origin.replace(/^http/,'ws')+'/api/live');
 live.onmessage=e=>{try{const m=JSON.parse(e.data);
  if(m.deleted){base=base.filter(c=>c.id!==m.deleted);found=found.filter(c=>c.id!==m.deleted);if(m.deleted===S.id&&!busy)fresh()}
  if(m.list&&!sw)L(m.list);
  if(m.usage)cost(m.usage);
  if(m.changed&&m.changed===S.id&&m.origin!==CID&&!busy)sync()}catch{}};
 live.onclose=()=>{if(document.visibilityState==='visible')setTimeout(connect,3000)}}
if(document.readyState==='complete')connect();else addEventListener('load',connect);
setInterval(()=>{if(live&&live.readyState===1)live.send('ping')},50000);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')connect()});
if(!/Mac|iPhone|iPad/.test(navigator.platform))$('.new kbd').textContent='Ctrl K';
// Model switch: rerun the last answer with Gemini 4 Carbon; follow-ups in this chat then use it. Click again to go back.
const mdl=$('#mdl');function ML(){if(!mdl)return;const c=S.model==='carbon';mdl.classList.toggle('on',c);mdl.textContent=(c?'✓ ':'')+'Gemini 4 Carbon';
 mdl.title=c?'Answering with Gemini 4 Carbon. Click to go back to Flash Lite and rerun.':'Rerun with Gemini 4 Carbon and use it for follow-ups'}
ML();if(mdl)mdl.onclick=()=>{if(busy)return;S.model=S.model==='carbon'?'lite':'carbon';ML();rerun()};
// Make a share link and copy it. body.at shares a single answer.
function copyShare(body,show){const made=fetch('/api/chats/'+S.id+'/share',{method:'POST',body:JSON.stringify(body)}).then(r=>{if(!r.ok)throw new Error('HTTP '+r.status);return r.json()});
 made.then(j=>{S.shares.unshift({id:j.id,created:j.created});SL()},()=>{});
 const link=made.then(j=>j.url),plain=()=>link.then(u=>navigator.clipboard.writeText(u));
 (window.ClipboardItem&&navigator.clipboard.write?navigator.clipboard.write([new ClipboardItem({'text/plain':link.then(u=>new Blob([u],{type:'text/plain'}))})]).catch(plain):plain())
  .then(()=>show('Link copied'),()=>show('Could not copy'))}
function toast(t){let e=$('#toast');if(!e){e=document.createElement('div');e.id='toast';document.body.append(e)}e.textContent=t;e.hidden=false;clearTimeout(e.t);e.t=setTimeout(()=>e.hidden=true,1600)}
// Per-answer ⋯ menu.
const menu=document.createElement('div');menu.id='menu';menu.hidden=true;document.body.append(menu);let menuI=-1;
const sheet=document.createElement('div');sheet.id='sheet';sheet.hidden=true;document.body.append(sheet);
log.addEventListener('click',e=>{const b=e.target.closest('.acts button');if(!b)return;e.stopPropagation();
 const i=+b.parentNode.dataset.i,m=S.msgs[i];if(!m)return;menuI=i;
 menu.innerHTML='<button data-a="res"'+(m.results&&m.results.length?'':' disabled')+'>Search results</button><button data-a="copy">Copy answer</button>'
  +'<button data-a="rerun"'+(busy?' disabled':'')+'>Rerun with '+(m.model==='carbon'?'Flash Lite':'Gemini 4 Carbon')+'</button><button data-a="share">Share this answer</button>';
 menu.hidden=false;const r=b.getBoundingClientRect(),w=menu.offsetWidth,h=menu.offsetHeight;
 menu.style.left=Math.max(8,Math.min(r.left,innerWidth-w-8))+'px';menu.style.top=(r.bottom+h+8>innerHeight?r.top-h-4:r.bottom+4)+'px'});
document.addEventListener('click',e=>{if(!menu.hidden&&!menu.contains(e.target))menu.hidden=true});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){menu.hidden=true;sheet.hidden=true}});
main.addEventListener('scroll',()=>{menu.hidden=true});
menu.onclick=e=>{const a=e.target.dataset&&e.target.dataset.a;if(!a||e.target.disabled)return;menu.hidden=true;const i=menuI,m=S.msgs[i];if(!m)return;
 if(a==='res'){sheet.innerHTML='<div class="sh-in"><div class="sh-hd"><b>Search results</b><button aria-label="Close">×</button></div>'+m.results.map(x=>'<div class="r"><a href="'+E1(x.url)+'" target="_blank" rel="noopener">'
  +E1(x.title||x.url)+'</a><span>'+E1(x.url.split('/')[2].replace(/^www\\./,'')+(x.date?' · '+x.date:''))+'</span><p>'+E1(x.text)+'</p></div>').join('')+'</div>';sheet.hidden=false}
 if(a==='copy')navigator.clipboard.writeText(m.text.replace(/^\\s*!\\[[^\\]]*\\]\\([^)]*\\)\\s*$/gm,'').replace(/\\s*\\[\\d+(?:,\\s*\\d+)*\\]/g,'').replace(/\\n{3,}/g,'\\n\\n').trim()).then(()=>toast('Copied'),()=>toast('Could not copy'));
 if(a==='rerun'&&!busy){const el=log.querySelector('.acts[data-i="'+i+'"]').previousElementSibling;busy=true;run({el,at:i,model:m.model==='carbon'?'lite':'carbon'})}
 if(a==='share')copyShare({n:S.msgs.length,at:i},toast)};
sheet.onclick=e=>{if(e.target===sheet||e.target.closest('.sh-hd button'))sheet.hidden=true};
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
 sh.onclick=()=>{if(busy)return;const label=sh.textContent;copyShare({n:S.msgs.length},t=>{sh.textContent=t;setTimeout(()=>sh.textContent=label,2000)})};
}
`;

export function shell(o: { id: string | null; title: string; msgs: Msg[]; streaming: boolean; user: { u: string; n: string }; shares?: ShareRef[]; model?: string }) {
  const state = { id: o.id, title: o.title, msgs: o.msgs, streaming: o.streaming, uid: o.user.u, shares: o.shares ?? [], model: o.model ?? "lite" };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">${NO_ZOOM}${ICON_LINKS}${TEXT_SIZE}
<title>${esc(o.title)}</title>
<link rel="search" type="application/opensearchdescription+xml" title="QuickAsk" href="/opensearch.xml">
<style>${CSS}</style></head>
<body><button id="tg" aria-label="Chats">☰</button><div id="zm"><button data-z="-1" aria-label="Smaller text" title="Smaller text">A−</button><button data-z="1" aria-label="Larger text" title="Larger text">A+</button></div>
<nav id="side"><div id="scroll"><div class="top"><a class="new" href="/">+ New chat<kbd>⌘K</kbd></a><button id="fs" aria-label="Search chats" title="Search chats"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg></button></div>
<div id="find" hidden><input placeholder="Search chats" autocomplete="off" enterkeyhint="search"><button aria-label="Close search">×</button></div><div id="list"></div>
</div><footer id="foot"><a id="usage" href="/admin" hidden></a>
<div class="me"><span>${esc(o.user.n)}</span><a href="/auth/logout">Sign out</a></div></footer></nav>
<main class="${o.id ? "" : "home"}"><div id="brand" class="brand">${mark(44)}<span>QuickAsk</span></div><div id="log"></div>
<form action="/" method="get"><textarea name="q" rows="1" placeholder="${o.id ? "Ask a follow-up" : "Ask anything"}" autocomplete="off"></textarea></form></main>
${o.id ? '<div id="shx"><button id="sl" hidden></button><button id="mdl"></button><button id="sh">Share</button><div id="sp" hidden></div></div>' : ""}
<script>const S=${json(state)};${RENDER}${JS}</script>
`;
}

/** Changes whenever the share page's code changes, so cached share pages never outlive a deploy. */
export const PAGE_VERSION = [...CSS + RENDER].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261).toString(36);

const usd = (n: number) => "$" + (n < 1 ? n.toFixed(4) : n.toFixed(2));

/** Admin cost page: variable costs from Exa and Gemini, recorded per search. */
export function adminPage(d: { today: Row; month: Row; byUser: Row[]; byDay: Row[]; names: Record<string, string> }) {
  const card = (label: string, r: Row) => `<div class="card"><span>${label}</span><b>${usd(r.cost)}</b><span>${r.searches} searches · ${usd(r.searches ? r.cost / r.searches : 0)} each</span></div>`;
  const table = (head: string, rows: Row[], name: (r: Row) => string) => rows.length ? `<table><tr><th>${head}</th><th>Searches</th><th>Exa</th><th>Gemini</th><th>Total</th></tr>${
    rows.map((r) => `<tr><td>${esc(name(r))}</td><td>${r.searches}</td><td>${usd(r.exa)}</td><td>${usd(r.gemini)}</td><td>${usd(r.cost)}</td></tr>`).join("")}</table>` : "<p>No searches yet.</p>";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">${NO_ZOOM}${ICON_LINKS}
<title>Usage · QuickAsk</title><meta name="robots" content="noindex"><style>${CSS}
main.admin{padding:32px 24px;max-width:760px;margin:0 auto;display:block;height:auto}.admin h1{font-size:20px;margin:0 0 4px}.admin h2{font-size:15px;margin:28px 0 8px}
.admin .note{color:var(--mute);font-size:13px;margin:0 0 16px}.admin .back{font-size:14px}
.cards{display:flex;gap:12px;flex-wrap:wrap}.card{flex:1;min-width:200px;background:var(--soft);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:2px}
.card span{color:var(--mute);font-size:13px}.card b{font-size:24px;font-weight:600}
table{width:100%;border-collapse:collapse;font-size:14px;font-variant-numeric:tabular-nums}th{text-align:left;color:var(--mute);font-weight:500;font-size:13px}
th,td{padding:6px 8px 6px 0}td+td,th+th{text-align:right}tr+tr td{border-top:1px solid var(--line)}
</style></head><body style="display:block;overflow:auto"><main class="admin"><a class="back" href="/">← QuickAsk</a>
<h1>Usage</h1><p class="note">Exa and Gemini charges, recorded per search. Cloudflare's $5/month plan is not included.</p>
<div class="cards">${card("Today", d.today)}${card("This month", d.month)}</div>
<h2>This month by user</h2>${table("User", d.byUser, (r) => d.names[r.user ?? ""] ?? "(deleted)")}
<h2>Last 30 days</h2>${table("Day", d.byDay, (r) => r.day ?? "")}
</main></body></html>`;
}

/** Read-only snapshot of a chat for anyone with the link: no sidebar, no input, no account. */
export function sharePage(s: { title: string; msgs: Msg[] }, url: string) {
  // Previews show the card image only: the title is just the app name and there is no description, so chat apps that
  // print text under the image (Signal, Slack, WhatsApp) do not repeat the question and answer the card already shows.
  const card = esc(`${url}/card.png`), title = esc(s.title);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">${NO_ZOOM}${ICON_LINKS}${TEXT_SIZE}
<title>${esc(s.title)}</title><meta name="robots" content="noindex">
<meta property="og:site_name" content="QuickAsk"><meta property="og:type" content="article"><meta property="og:url" content="${esc(url)}">
<meta property="og:title" content="QuickAsk">
<meta property="og:image" content="${card}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="${title}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="QuickAsk">
<meta name="twitter:image" content="${card}"><meta name="twitter:image:alt" content="${title}">
<style>${CSS}</style></head><body style="display:block;overflow:auto"><main style="height:auto;display:block"><div class="sbrand">${mark(22)}QuickAsk</div><div id="log"></div></main>
<script>const S=${json({ msgs: s.msgs })};${RENDER}function show(msgs){log.innerHTML='';for(const m of msgs){if(m.role==='user')add('u',E1(m.text));else add('m',md(m.text,m.images,m.sources))}}
show(S.msgs);</script></body></html>`;
}

const page = (body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">${NO_ZOOM}${ICON_LINKS}
<title>QuickAsk</title><style>${CSS}</style></head><body><main class="home">${body}</main></body></html>`;

export const keyPage = (bad: boolean) => page(`${BRAND}<div id="log"></div>
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

export const signIn = () => page(`<div class="auth">${BRAND}
<button id="in" class="btn">Sign in with passkey</button>
<div class="or">New here? Create an account</div>
<form id="up"><input name="n" type="email" inputmode="email" placeholder="Email address" autocomplete="email" autocapitalize="off" spellcheck="false"><button>Create</button></form>
<p id="msg" class="err"></p></div><script>${AUTH_JS}</script>`);

export const opensearch = (origin: string) => `<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
<ShortName>QuickAsk</ShortName><Description>Fast answers with web search</Description><InputEncoding>UTF-8</InputEncoding>
<Url type="text/html" method="get" template="${origin}/?q={searchTerms}"/>
</OpenSearchDescription>`;
