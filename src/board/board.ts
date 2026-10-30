/**
 * Ortak tahta: runBoard(kök, ayarlar). Prototip (proto/src/entry.ts) ve uygulama (app) aynı kodu kullanır.
 * Rol V = yalnız izleyici (geç katılım testi).
 */
import {
  BoardState, decodePacket, encodePacket, quantize,
  type Author, type BoardEvent, type Packet, type Point, type Tool,
} from '../../src/protocol/index.js';
import type { Status, Transport } from './transport.js';
import { BOARD_HTML, injectStyle } from './markup.js';
import { HybridTransport, RtcLink } from './rtc.js';
import { Renderer, type Laser } from './render.js';
import { pdfToPages } from './pdf.js';

export interface BoardConfig {
  role: Author | 'V';
  lesson: string;
  t0: number;
  /** Sinyal + yedek tahta kanalı (yerel WebSocket ya da Supabase özel kanalı). */
  signal: Transport;
  media?: boolean;
  iceServers?: RTCIceServer[];
  net?: 'auto' | 'bc';
  nocache?: boolean;
  batchMs?: number;
  /** PDF sayfa görselini yükler, sayfa kaynağını (src) döndürür. */
  uploadPage?: (png: Blob, index: number) => Promise<string>;
  /** Sayfa kaynağını gösterilebilir adrese çevirir (ör. imzalı Storage adresi). */
  resolveSrc?: (src: string) => Promise<string>;
  /** Kalıcı tahta günlüğü: açılışta okunur, öğretmen tarafında düzenli yazılır. */
  loadLog?: () => Promise<Packet[] | null>;
  saveLog?: (packets: Packet[]) => Promise<void>;
  onLeave?: () => void;
}

export function runBoard(root: HTMLElement, cfg: BoardConfig) {
injectStyle();
root.innerHTML = BOARD_HTML;
const role = cfg.role;
const isT = role === 'T', isV = role === 'V';
const lesson = cfg.lesson;
const BATCH_MS = cfg.batchMs ?? 50;
const t0 = cfg.t0;

const state = new BoardState(lesson);
let seq = 0;
const metrics = { recv: [] as number[], paint: [] as number[], render: [] as number[], baked: 0, sent: 0, received: 0 };

// ---------- ağ ----------
const bc = cfg.signal;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const remoteVideo = $<HTMLVideoElement>('remote');
const localVideo = $<HTMLVideoElement>('local');
const rtcStateEl = $('rtc');
let rtc: RtcLink | null = null;
const net = new HybridTransport(bc, null, cfg.net ?? 'auto');

async function startRtc() {
  if (isV) return;
  let media: MediaStream | null = null;
  if (cfg.media !== false) {
    try {
      media = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 15, max: 20 } },
      });
    } catch {
      try { media = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { media = null; }
    }
  }
  if (media) { localVideo.srcObject = media; localVideo.muted = true; }
  rtc = new RtcLink(bc, {
    role: role as 'T' | 'S',
    iceServers: cfg.iceServers ?? [],
    media,
    onRemoteStream: s => { if (remoteVideo.srcObject !== s) remoteVideo.srcObject = s; },
    onState: s => { rtcStateEl.textContent = s; rtcStateEl.dataset.s = s; },
    onVideoSuspended: off => { $('notice').textContent = off ? 'Bağlantı zayıf: görüntü kapatıldı, ses sürüyor' : ''; },
  });
  (net as any).rtc = rtc;
  for (const [ev, cb] of handlers) rtc.on(ev, cb);
  rtc.on('__open', () => net.send('sync_req', { vector: state.vector, reply: false }));
  if (bcUp) rtc.signalUp();
}

// yayın + veri kanalı için ortak dinleyiciler (rtc sonradan kurulduğu için listede tutulur)
const handlers: [string, (p: any) => void][] = [];
const listen = (ev: string, cb: (p: any) => void) => { handlers.push([ev, cb]); bc.on(ev, cb); };

// ---------- çizim ----------
const bgCanvas = $<HTMLCanvasElement>('bg');
const inkCanvas = $<HTMLCanvasElement>('ink');
const renderer = new Renderer(bgCanvas, inkCanvas);
renderer.noCache = !!cfg.nocache;
if (cfg.resolveSrc) renderer.resolveSrc = cfg.resolveSrc;
let dirty = true;
renderer.onImageLoad = () => { dirty = true; };
const resize = () => { renderer.resize(inkCanvas.parentElement!.clientWidth); dirty = true; };
window.addEventListener('resize', resize);
resize();

const lasers: Laser[] = [];
const pendingPaint: number[] = [];
const page = () => state.cursor.T;

function frame() {
  if (lasers.length) { while (lasers.length && Date.now() - lasers[0].at > 1000) lasers.shift(); dirty = true; }
  if (dirty) {
    const t = performance.now();
    renderer.drawBackground(state.pages.get(page())?.value, page());
    metrics.baked += renderer.render(state, page(), lasers);
    dirty = false;
    metrics.render.push(performance.now() - t);
    const now = Date.now();
    for (const ts of pendingPaint.splice(0)) metrics.paint.push(now - ts);
    updatePageLabel();
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------- olay üretimi ----------
function emit(e: BoardEvent, firstSampleAt = Date.now()) {
  const q = quantize(e);
  state.receive(q); dirty = true;
  if (net.send('pk', { p: encodePacket([q]), ts: firstSampleAt })) metrics.sent++;
}
const base = () => ({ v: 1 as const, lesson, author: role as Author, seq: ++seq, t: Date.now() - t0, page: page() });

// ---------- araçlar ----------
type UiTool = Tool | 'silgi' | 'lazer';
let tool: UiTool = 'kalem';
let color = isT ? '#1f2937' : '#1d4ed8';
let studentPen = true;
const WIDTH: Record<string, number> = { kalem: 0.003, vurgu: 0.003, silgi_alan: 0.004, cizgi: 0.003, cember: 0.003 };

// geri al / ileri al: yalnız kendi eylemlerim
type Action = { kind: 'draw' | 'erase'; ids: string[] };
const undoStack: Action[] = [], redoStack: Action[] = [];
function undo() {
  const a = undoStack.pop(); if (!a) return;
  emit({ ...base(), act: a.kind === 'draw' ? 'sil' : 'geri_getir', target: a.ids });
  redoStack.push(a);
}
function redo() {
  const a = redoStack.pop(); if (!a) return;
  emit({ ...base(), act: a.kind === 'draw' ? 'geri_getir' : 'sil', target: a.ids });
  undoStack.push(a);
}

let active: { id: string; started: boolean; buf: Point[]; firstAt: number; tool: Tool } | null = null;
let erasing: string[] | null = null;
let strokeN = 0;
let penSeen = false;
const toPt = (ev: PointerEvent): Point => {
  const r = inkCanvas.getBoundingClientRect();
  return [(ev.clientX - r.left) / renderer.W, (ev.clientY - r.top) / renderer.W, ev.pressure > 0 ? ev.pressure : 0.5];
};
const canDraw = () => !isV && synced && (isT || studentPen);

function flush(final: boolean) {
  if (!active) return;
  const { id, buf } = active;
  if (!active.firstAt) active.firstAt = Date.now();
  if (!active.started) {
    emit({ ...base(), act: 'basla', stroke: id, tool: active.tool, w: WIDTH[active.tool], color, pts: buf.splice(0) }, active.firstAt);
    active.started = true;
    if (final) emit({ ...base(), act: 'bitir', stroke: id, pts: [] });
  } else if (buf.length || final) {
    // düz çizgi ve çemberde yalnız son nokta gerekir
    const pts = active.tool === 'cizgi' || active.tool === 'cember' ? buf.splice(0).slice(-1) : buf.splice(0);
    emit({ ...base(), act: final ? 'bitir' : 'ciz', stroke: id, pts }, active.firstAt);
  }
  active.firstAt = 0;
}

function hitTest(x: number, y: number): string[] {
  const r = 0.012;
  const out: string[] = [];
  for (const s of state.visibleStrokes(page())) {
    if (s.tool === 'silgi_alan') continue;
    if (!isT && s.author !== role) continue; // öğrenci yalnız kendi çizgisini siler
    const rr = r + s.w / 2;
    if (s.tool === 'cizgi' || s.tool === 'cember') {
      const [a, b] = [s.pts[0], s.pts[s.pts.length - 1]];
      const ax = a[0] + s.dx, ay = a[1] + s.dy, bx = b[0] + s.dx, by = b[1] + s.dy;
      let d: number;
      if (s.tool === 'cember') d = Math.abs(Math.hypot(x - ax, y - ay) - Math.hypot(bx - ax, by - ay));
      else { const L = (bx - ax) ** 2 + (by - ay) ** 2; const t = L ? Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / L)) : 0; d = Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay)); }
      if (d < rr) out.push(s.id);
      continue;
    }
    if (s.pts.some(([px, py]) => Math.hypot(px + s.dx - x, py + s.dy - y) < rr)) out.push(s.id);
  }
  return out;
}

function sendLaser(p: Point) {
  const l = { x: p[0], y: p[1], at: Date.now() };
  lasers.push(l); dirty = true;
  net.send('lz', { x: l.x, y: l.y }, true);
}

inkCanvas.addEventListener('pointerdown', ev => {
  if (ev.pointerType === 'pen') penSeen = true;
  if (ev.pointerType === 'touch' && penSeen) return; // avuç içi reddi
  if (tool === 'lazer') { if (!isV) sendLaser(toPt(ev)); return; }
  if (!canDraw()) return;
  try { inkCanvas.setPointerCapture(ev.pointerId); } catch { /* sentetik olay */ }
  const p = toPt(ev);
  if (tool === 'silgi') { erasing = []; const hit = hitTest(p[0], p[1]); if (hit.length) { erasing.push(...hit); emit({ ...base(), act: 'sil', target: hit }); } return; }
  active = { id: `${role}-${String(++strokeN).padStart(6, '0')}`, started: false, buf: [p], firstAt: Date.now(), tool };
});
inkCanvas.addEventListener('pointermove', ev => {
  if (ev.pointerType === 'touch' && penSeen) return;
  const p = toPt(ev);
  if (tool === 'lazer' && ev.buttons) { sendLaser(p); return; }
  if (erasing) { const hit = hitTest(p[0], p[1]).filter(id => !erasing!.includes(id)); if (hit.length) { erasing.push(...hit); emit({ ...base(), act: 'sil', target: hit }); } return; }
  if (!active) return;
  if (!active.firstAt) active.firstAt = Date.now();
  active.buf.push(p);
});
const up = () => {
  if (erasing) { if (erasing.length) { undoStack.push({ kind: 'erase', ids: erasing }); redoStack.length = 0; } erasing = null; }
  if (active) { flush(true); undoStack.push({ kind: 'draw', ids: [active.id] }); redoStack.length = 0; active = null; }
};
inkCanvas.addEventListener('pointerup', up);
inkCanvas.addEventListener('pointercancel', up);
setInterval(() => { if (active && active.buf.length) flush(false); }, BATCH_MS);

// ---------- sayfalar ----------
function maxPage() { return Math.max(0, ...state.pages.keys()); }
function goPage(n: number) { if (!isT) return; emit({ ...base(), page: n, act: 'sayfa_gec' }); }
function addPage(kind: 'bos' | 'kareli' | 'cizgili' | 'koordinat' | 'pdf', src?: string, go = true) {
  const n = maxPage() + 1;
  emit(src ? { ...base(), page: n, act: 'sayfa_ekle', kind, src } : { ...base(), page: n, act: 'sayfa_ekle', kind });
  if (go) goPage(n);
  return n;
}
function updatePageLabel() { $('pageno').textContent = `${page() + 1} / ${maxPage() + 1}`; }

async function uploadPdf(file: File) {
  $('notice').textContent = 'PDF hazırlanıyor…';
  const urls = await pdfToPages(file, cfg.uploadPage ?? (async (blob, i) => {
    const r = await fetch(`/upload?name=${encodeURIComponent(lesson)}-${Date.now()}-${i}.png`, { method: 'POST', body: blob });
    if (!r.ok) throw new Error('yükleme başarısız');
    return (await r.json()).url as string;
  }));
  let first = -1;
  for (const u of urls) { const n = addPage('pdf', u, false); if (first < 0) first = n; }
  if (first >= 0) goPage(first);
  $('notice').textContent = `${urls.length} PDF sayfası eklendi`;
}

// ---------- alma ve eşitleme ----------
listen('pk', ({ p, ts }: { p: Packet; ts: number }) => {
  let applied = 0;
  for (const e of decodePacket(p)) applied += state.receive(e);
  afterRemote();
  if (!applied) return; // iki yoldan gelen tekrar
  metrics.received++;
  metrics.recv.push(Date.now() - ts); pendingPaint.push(ts);
  dirty = true;
});
listen('lz', ({ x, y }) => { lasers.push({ x, y, at: Date.now() }); dirty = true; });
listen('ctl', ({ studentPen: sp }) => { if (!isT) { studentPen = sp; refreshToolbar(); } });
/** Karşı tarafın eksiği: HER İKİ yazarın olayları (yenilenen öğrenci kendi eski çizgilerini de geri alır). */
function sendMissing(vector: Record<Author, number>) {
  if (isV) return;
  for (const a of ['T', 'S'] as Author[]) {
    const missing = state.log[a].slice(Math.max(0, vector[a]));
    for (let i = 0; i < missing.length; i += 50) net.send('sync_res', { p: encodePacket(missing.slice(i, i + 50)) });
  }
  net.send('sync_done', { vector: state.vector });
}
listen('sync_req', ({ vector, reply }) => {
  sendMissing(vector);
  if (isT) net.send('ctl', { studentPen });
  if (!reply) net.send('sync_req', { vector: state.vector, reply: true });
});
listen('sync_res', ({ p }: { p: Packet }) => { for (const e of decodePacket(p)) state.receive(e); afterRemote(); dirty = true; });
listen('sync_done', ({ vector }) => { syncTarget = vector; afterRemote(); });

// Eşitleme kapısı: sayfa yenilenen kişi, eski olaylarını geri almadan çizemez (seq çakışmasını önler).
let synced = isV;
let syncTarget: Record<Author, number> | null = null;
function afterRemote() {
  if (!isV) seq = Math.max(seq, state.vector[role as Author]);
  if (!synced && logReady && syncTarget && state.vector.T >= syncTarget.T && state.vector.S >= syncTarget.S) { synced = true; refreshToolbar(); }
}
// Karşı taraf yoksa (odada yalnız) 3 sn sonra kapıyı aç. BİLİNEN SINIR: bu durumda seq 0'dan başlar ve
// karşı tarafta eski olaylar varsa çakışır. Üretimde sunucu tarafı anlık görüntü + günlük (bl_board_snapshots)
// yeniden bağlananın vektörünü verir; bu boşluk Aşama 1 veritabanı işiyle kapanır.
let logReady = !cfg.loadLog;
const gateTimer = setTimeout(() => { if (!synced && logReady) { synced = true; refreshToolbar(); } }, 3000);
void gateTimer;
if (cfg.loadLog) {
  cfg.loadLog().then(packets => {
    for (const p of packets ?? []) for (const e of decodePacket(p)) state.receive(e);
    dirty = true;
  }).catch(e => { $('notice').textContent = 'Kayıtlı tahta okunamadı: ' + e.message; })
    .finally(() => {
      logReady = true; afterRemote();
      setTimeout(() => { if (!synced) { synced = true; refreshToolbar(); } }, 1500);
    });
}
if (cfg.saveLog && isT) {
  let savedVec = '';
  const save = async () => {
    const v = JSON.stringify(state.vector);
    if (v === savedVec) return;
    const packets: Packet[] = [];
    for (const a of ['T', 'S'] as Author[]) for (let i = 0; i < state.log[a].length; i += 200) packets.push(encodePacket(state.log[a].slice(i, i + 200)));
    try { await cfg.saveLog!(packets); savedVec = v; } catch (e: any) { $('notice').textContent = 'Tahta kaydedilemedi: ' + e.message; }
  };
  setInterval(save, 15000);
  window.addEventListener('pagehide', () => { void save(); });
  (window as any).__saveBoard = save;
}

let bcUp = false;
bc.onStatus((s: Status) => {
  const el = $('status');
  el.textContent = s === 'bagli' ? 'bağlı' : s === 'kopuk' ? 'bağlantı yok, yeniden deneniyor' : 'bağlanıyor';
  el.dataset.s = s;
  bcUp = s === 'bagli';
  if (bcUp) { net.send('sync_req', { vector: state.vector, reply: false }); rtc?.signalUp(); }
});
bc.connect();
startRtc();

// ---------- araç çubuğu ----------
$('who').textContent = isT ? 'Öğretmen' : role === 'S' ? 'Öğrenci' : 'İzleyici';
const bar = $('toolbar');
function refreshToolbar() {
  bar.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach(b => {
    b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
    b.disabled = isV || (!canDraw() && b.dataset.tool !== 'lazer');
  });
  bar.querySelectorAll<HTMLButtonElement>('[data-color]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.color === color)));
  bar.querySelectorAll<HTMLElement>('.t-only').forEach(el => { el.hidden = !isT; });
  const pen = $<HTMLButtonElement>('pen');
  pen.textContent = studentPen ? 'Öğrenci kalemi: açık' : 'Öğrenci kalemi: kapalı';
  $('locked').hidden = isT || isV || studentPen;
}
bar.addEventListener('click', ev => {
  const b = (ev.target as HTMLElement).closest('button'); if (!b) return;
  if (b.dataset.tool) tool = b.dataset.tool as UiTool;
  else if (b.dataset.color) color = b.dataset.color;
  else if (b.id === 'undo') undo();
  else if (b.id === 'redo') redo();
  else if (b.id === 'prev') goPage(Math.max(0, page() - 1));
  else if (b.id === 'next') goPage(Math.min(maxPage(), page() + 1));
  else if (b.id === 'add') addPage('kareli');
  else if (b.id === 'pen') { studentPen = !studentPen; net.send('ctl', { studentPen }); }
  else if (b.id === 'pdfbtn') $<HTMLInputElement>('pdf').click();
  else if (b.id === 'leave') cfg.onLeave?.();
  refreshToolbar();
});
$<HTMLInputElement>('pdf').addEventListener('change', ev => {
  const f = (ev.target as HTMLInputElement).files?.[0];
  if (f) uploadPdf(f).catch(e => { $('notice').textContent = 'PDF eklenemedi: ' + e.message; });
});
window.addEventListener('keydown', ev => {
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') { ev.preventDefault(); ev.shiftKey ? redo() : undo(); }
  else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'y') { ev.preventDefault(); redo(); }
});
refreshToolbar();

// ---------- test kancaları ----------
/** Sentetik kalem: 60 Hz gerçek PointerEvent üretir. */
function synth(strokes: number, seed = 1, strokeMs = 800, gapMs = 150, pointerType = 'pen'): Promise<void> {
  let s = seed >>> 0;
  const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  return new Promise(resolve => {
    let i = 0;
    const one = () => {
      if (i++ >= strokes) { resolve(); return; }
      let x = 0.1 + r() * 0.8, y = 0.1 + r() * 0.5, k = 0;
      const n = Math.round(strokeMs / 16.7);
      fire('pointerdown', x, y, pointerType);
      const tm = setInterval(() => {
        x = Math.min(0.98, Math.max(0.02, x + (r() - 0.5) * 0.02)); y = Math.min(1.3, Math.max(0.02, y + (r() - 0.5) * 0.02));
        fire('pointermove', x, y, pointerType);
        if (++k >= n) { clearInterval(tm); fire('pointerup', x, y, pointerType); setTimeout(one, gapMs); }
      }, 16.7);
    };
    one();
  });
}
function fire(type: string, x: number, y: number, pointerType = 'pen') {
  const rect = inkCanvas.getBoundingClientRect();
  inkCanvas.dispatchEvent(new PointerEvent(type, { clientX: rect.left + x * renderer.W, clientY: rect.top + y * renderer.W, pressure: 0.5, pointerId: 1, bubbles: true, pointerType, buttons: type === 'pointerup' ? 0 : 1 }));
}
/** Hızlı yük: n bitmiş çizgi (her biri ~40 nokta) doğrudan olay olarak üretir. */
function bulk(n: number, seed = 9) {
  let s = seed >>> 0;
  const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  for (let i = 0; i < n; i++) {
    const id = `${role}-${String(++strokeN).padStart(6, '0')}`;
    let x = 0.05 + r() * 0.9, y = 0.05 + r() * 1.3;
    const pts: Point[] = [];
    for (let k = 0; k < 40; k++) { x += (r() - 0.5) * 0.01; y += (r() - 0.5) * 0.01; pts.push([x, y, 0.5]); }
    emit({ ...base(), act: 'basla', stroke: id, tool: 'kalem', w: 0.003, color, pts: pts.slice(0, 20) });
    emit({ ...base(), act: 'bitir', stroke: id, pts: pts.slice(20) });
  }
}
(window as any).__board = {
  state, metrics, synth, fire, bulk, undo, redo,
  setTool: (t: UiTool) => { tool = t; refreshToolbar(); },
  setStudentPen: (v: boolean) => { studentPen = v; net.send('ctl', { studentPen }); refreshToolbar(); },
  studentPen: () => studentPen,
  addPage, goPage, uploadPdf,
  pixels: () => renderer.pixels(),
  imagesReady: () => renderer.imagesReady() && !dirty,
  hash: () => state.hash(),
  strokeCount: (p?: number) => state.visibleStrokes(p ?? page()).length,
  page,
  drop: (ms: number) => bc.drop?.(ms),
  breakDc: () => rtc?.breakChannel(),
  forceBc: (v: boolean) => { net.force = v ? 'bc' : 'auto'; },
  pageCount: () => maxPage() + 1,
  notice: () => $('notice').textContent,
  dcOpen: () => !!rtc?.open,
  via: () => ({ dc: net.viaDc, bc: net.viaBc }),
  rtcStats: () => rtc?.stats(),
  reconnects: () => rtc?.reconnects ?? 0,
  lasers: () => lasers.length,
  status: () => $('status').dataset.s,
  synced: () => synced,
};
return (window as any).__board;
}
