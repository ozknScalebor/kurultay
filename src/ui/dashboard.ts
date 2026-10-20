import { createServer, type Server } from 'node:http';
import type { Router } from '../llm/router.js';
import type { EventBus, KEvent } from '../util/events.js';

/**
 * Local, dependency-free live dashboard (http://127.0.0.1:<port>).
 * Shows every model's load and every worker's activity side by side.
 * Works fully offline: no CDN, no external fonts.
 */
export function startDashboard(bus: EventBus, router: Router, port = 7420): Promise<{ server: Server; url: string }> {
  const clients = new Set<import('node:http').ServerResponse>();
  const onEvent = (e: KEvent) => {
    if (e.type === 'worker.token') return; // too chatty for the wire
    const data = `data: ${JSON.stringify(e)}\n\n`;
    for (const c of clients) c.write(data);
  };
  bus.on('event', onEvent);
  const server = createServer((req, res) => {
    if (req.url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      for (const e of bus.history) if (e.type !== 'worker.token') res.write(`data: ${JSON.stringify(e)}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.url === '/stats') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(router.stats()));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  server.on('close', () => {
    bus.off('event', onEvent);
    for (const c of clients) c.end();
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actual = typeof addr === 'object' && addr ? addr.port : port;
      resolve({ server, url: `http://127.0.0.1:${actual}` });
    });
  });
}

const PAGE = `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kurultay</title>
<style>
:root{--bg:#0f1115;--panel:#171a21;--line:#262b36;--text:#e6e8ee;--dim:#8b93a7;--ok:#3fb97f;--warn:#e0a83a;--err:#e35d5d;--acc:#6ea8fe}
@media (prefers-color-scheme: light){:root{--bg:#f6f7f9;--panel:#fff;--line:#e3e6ec;--text:#1b1f27;--dim:#5d6578;--acc:#2f6fdf}}
*{box-sizing:border-box}body{margin:0;font:13px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--bg);color:var(--text)}
header{display:flex;gap:16px;align-items:baseline;padding:14px 18px;border-bottom:1px solid var(--line)}
h1{font-size:16px;margin:0;letter-spacing:.04em}#status{color:var(--dim)}
main{display:grid;grid-template-columns:320px 1fr;gap:14px;padding:14px 18px}
@media (max-width:820px){main{grid-template-columns:1fr}}
section{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px 12px;min-width:0}
h2{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);margin:2px 0 10px}
.model{margin-bottom:10px}.bar{height:6px;background:var(--line);border-radius:3px;overflow:hidden;margin-top:3px}
.bar>i{display:block;height:100%;background:var(--acc)}.meta{color:var(--dim);font-size:11px}
#workers{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px}
.w{border:1px solid var(--line);border-radius:6px;padding:8px;max-height:260px;overflow:auto}
.w b{display:block;margin-bottom:4px}.w .st{float:right;font-size:11px}
.ok{color:var(--ok)}.warn{color:var(--warn)}.err{color:var(--err)}.dim{color:var(--dim)}
#log{max-height:300px;overflow:auto;white-space:pre-wrap;word-break:break-word}
</style></head><body>
<header><h1>KURULTAY</h1><span id="status">bağlanıyor…</span></header>
<main>
<section><h2>Modeller</h2><div id="models"></div></section>
<section><h2>Çalışanlar</h2><div id="workers"></div><h2 style="margin-top:14px">Olaylar</h2><div id="log"></div></section>
</main>
<script>
const workers = new Map();
const $ = (id) => document.getElementById(id);
function esc(s){return String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
function worker(id){
  if(!workers.has(id)){const el=document.createElement('div');el.className='w';el.innerHTML='<b>'+esc(id)+'<span class="st dim">…</span></b><div class="body"></div>';$('workers').prepend(el);workers.set(id,el)}
  return workers.get(id)}
function line(cls,text){const d=document.createElement('div');d.className=cls;d.textContent=new Date().toTimeString().slice(0,8)+' '+text;$('log').prepend(d);while($('log').childElementCount>400)$('log').lastChild.remove()}
const es=new EventSource('/events');
es.onopen=()=>$('status').textContent='canlı';
es.onerror=()=>$('status').textContent='bağlantı koptu – yeniden deneniyor';
es.onmessage=(m)=>{const e=JSON.parse(m.data);const d=e.data||{};
  if(e.type==='worker.start'){const w=worker(e.source);w.querySelector('.st').textContent=d.model}
  else if(e.type==='worker.tool'){const w=worker(e.source).querySelector('.body');const r=document.createElement('div');r.className='dim';r.textContent=d.tool+' '+JSON.stringify(d.args).slice(0,90);w.prepend(r)}
  else if(e.type==='worker.end'){const s=worker(e.source).querySelector('.st');s.textContent=d.status+' · '+d.files+' dosya';s.className='st '+(d.status==='done'?'ok':'warn')}
  else if(e.type.startsWith('log.')){line(e.type==='log.error'?'err':e.type==='log.warn'?'warn':'', (e.source?e.source+': ':'')+e.message)}
  else if(e.type==='subtask.winner'){line('ok','🏆 '+e.source+' → '+d.worker)}
  else if(e.type==='run.plan'){line('', 'Plan ('+d.mode+'): '+(d.subtasks||[]).join(' | '))}
  else if(e.type==='run.end'){line('ok','Bitti: '+d.status+' · '+d.files+' dosya');$('status').textContent='tamamlandı: '+d.status}
  else if(e.type==='llm.error'){line('warn',e.source+' ['+d.kind+'] '+(e.message||'').slice(0,140))}
};
async function stats(){try{const s=await (await fetch('/stats')).json();$('models').innerHTML=s.map(m=>{const pct=Math.min(100,100*m.active/Math.max(1,m.limit));return '<div class="model"><div>'+esc(m.key)+(m.circuitOpen?' <span class="err">devre açık</span>':'')+'</div><div class="bar"><i style="width:'+pct+'%"></i></div><div class="meta">aktif '+m.active+'/'+m.limit+' · kuyruk '+m.queued+' · ✓'+m.successes+' ✗'+m.failures+'</div></div>'}).join('')}catch{}}
setInterval(stats,1500);stats();
</script></body></html>`;
