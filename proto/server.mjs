// Yerel sahte yayın sunucusu: Supabase Realtime Broadcast davranışını taklit eder
// (konuya katıl, yayınla, gönderen kendi mesajını almaz, geçmiş tutulmaz).
// Ayrıca proto/ klasörünü statik olarak sunar.
// Ortam: PORT (8787), DELAY_MS (aktarımda eklenen tek yönlü gecikme), JITTER_MS (± rastgele sapma).
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT || 8787);
let DELAY = Number(process.env.DELAY_MS || 0);
let JITTER = Number(process.env.JITTER_MS || 0);
const root = fileURLToPath(new URL('.', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.map': 'application/json', '.png': 'image/png' };

const http = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/__delay') { // test kancası: gecikmeyi çalışırken değiştir
    DELAY = Number(url.searchParams.get('ms') || 0); JITTER = Number(url.searchParams.get('jitter') || 0);
    res.end(JSON.stringify({ DELAY, JITTER })); return;
  }
  if (url.pathname === '/upload' && req.method === 'POST') { // prototip: üretimde Supabase Storage özel kova
    const name = (url.searchParams.get('name') || 'x.png').replace(/[^A-Za-z0-9._-]/g, '_');
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > 10e6) { res.statusCode = 413; res.end(); return; } chunks.push(c); }
    await mkdir(join(root, 'uploads'), { recursive: true });
    await writeFile(join(root, 'uploads', name), Buffer.concat(chunks));
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ url: '/uploads/' + name })); return;
  }
  const p = normalize(join(root, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!p.startsWith(root)) { res.statusCode = 403; res.end(); return; }
  try { const body = await readFile(p); res.setHeader('content-type', types[extname(p)] || 'application/octet-stream'); res.end(body); }
  catch { res.statusCode = 404; res.end('yok'); }
});

const wss = new WebSocketServer({ server: http });
const topics = new Map(); // topic -> Set<ws>
let lastSend = new WeakMap(); // ws -> son teslim zamanı (FIFO sırasını korumak için)

wss.on('connection', ws => {
  ws.topics = new Set();
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'join') {
      if (!topics.has(m.topic)) topics.set(m.topic, new Set());
      topics.get(m.topic).add(ws); ws.topics.add(m.topic);
      ws.send(JSON.stringify({ type: 'joined', topic: m.topic }));
    } else if (m.type === 'broadcast') {
      const out = JSON.stringify({ type: 'broadcast', topic: m.topic, event: m.event, payload: m.payload });
      for (const peer of topics.get(m.topic) || []) {
        if (peer === ws || peer.readyState !== 1) continue;
        const d = Math.max(0, DELAY + (Math.random() * 2 - 1) * JITTER);
        // TCP/WebSocket sırayı korur; gecikmeli teslimde de sırayı koru
        const at = Math.max(Date.now() + d, (lastSend.get(peer) || 0));
        lastSend.set(peer, at);
        setTimeout(() => peer.readyState === 1 && peer.send(out), at - Date.now());
      }
    }
  });
  ws.on('close', () => { for (const t of ws.topics) topics.get(t)?.delete(ws); });
});

http.listen(PORT, () => console.log(`hazır http://localhost:${PORT} gecikme=${DELAY}ms ±${JITTER}`));
