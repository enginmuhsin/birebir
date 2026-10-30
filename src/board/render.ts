/**
 * Üç katmanlı çizim:
 *  - arka plan (ızgara ya da PDF sayfası görseli): yalnız sayfa/boyut/görsel değişince çizilir,
 *  - önbellek (ekranda değil): bitmiş çizgiler bir kez çizilir; sıra değişmedikçe yeniden çizilmez,
 *  - mürekkep (ekranda): önbellek + süren çizgiler + lazer.
 * Alan silgisi yalnız mürekkebi siler (destination-out), arka plan etkilenmez.
 */
import { getStroke } from 'perfect-freehand';
import type { BoardState, StrokeState } from '../../src/protocol/index.js';

export const PAGE_RATIO = 1.414; // A4 dikey

export interface Laser { x: number; y: number; at: number }

export class Renderer {
  W = 0; H = 0; dpr = 1;
  private base = document.createElement('canvas');
  private bctx = this.base.getContext('2d')!;
  private ictx: CanvasRenderingContext2D;
  private gctx: CanvasRenderingContext2D;
  private baked: string[] = [];
  private bakedPage = -1;
  private bgKey = '';
  private images = new Map<string, HTMLImageElement>();
  /** Test için: true ise önbellek kullanılmaz (her karede tüm çizgiler). */
  noCache = false;
  onImageLoad: () => void = () => {};

  constructor(private bg: HTMLCanvasElement, private ink: HTMLCanvasElement) {
    this.ictx = ink.getContext('2d')!;
    this.gctx = bg.getContext('2d')!;
  }

  resize(cssWidth: number) {
    this.dpr = window.devicePixelRatio || 1;
    this.W = cssWidth; this.H = Math.round(cssWidth * PAGE_RATIO);
    for (const c of [this.bg, this.ink, this.base]) {
      c.style.width = this.W + 'px'; c.style.height = this.H + 'px';
      c.width = Math.round(this.W * this.dpr); c.height = Math.round(this.H * this.dpr);
    }
    for (const x of [this.ictx, this.gctx, this.bctx]) x.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.baked = []; this.bgKey = '';
  }

  /** Sayfa kaynağını gösterilebilir adrese çevirir (ör. imzalı Storage adresi). */
  resolveSrc: ((src: string) => Promise<string>) | null = null;
  private pending = new Set<string>();

  private image(src: string): HTMLImageElement | null {
    let im = this.images.get(src);
    if (!im) {
      const img = new Image();
      im = img;
      this.pending.add(src);
      const done = () => { this.pending.delete(src); this.bgKey = ''; this.onImageLoad(); };
      img.onload = done; img.onerror = done;
      this.images.set(src, img);
      if (this.resolveSrc) this.resolveSrc(src).then(u => { img.src = u; }, done);
      else img.src = src;
    }
    return im.complete && im.naturalWidth ? im : null;
  }

  /** Arka plan görselleri yüklendi mi (test kancası). */
  imagesReady(): boolean { return this.pending.size === 0; }

  drawBackground(page: { kind: string; src?: string } | undefined, pageNo: number) {
    const img = page?.src ? this.image(page.src) : null;
    const key = `${pageNo}|${page?.kind}|${page?.src}|${img ? 1 : 0}|${this.W}`;
    if (key === this.bgKey) return;
    this.bgKey = key;
    const g = this.gctx, W = this.W, H = this.H;
    g.globalCompositeOperation = 'source-over';
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
    const kind = page?.kind ?? 'kareli';
    if (img) {
      const s = Math.min(W / img.naturalWidth, H / img.naturalHeight);
      const w = img.naturalWidth * s, h = img.naturalHeight * s;
      g.drawImage(img, (W - w) / 2, 0, w, h);
      return;
    }
    g.strokeStyle = '#e8ecf2'; g.lineWidth = 1;
    const step = W / 20;
    if (kind === 'kareli' || kind === 'koordinat') {
      for (let x = step; x < W; x += step) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
    }
    if (kind !== 'bos') {
      for (let y = step; y < H; y += step) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
    }
    if (kind === 'koordinat') {
      g.strokeStyle = '#94a3b8'; g.lineWidth = 1.5;
      const cx = Math.round(10 * step), cy = Math.round(14 * step);
      g.beginPath(); g.moveTo(0, cy); g.lineTo(W, cy); g.moveTo(cx, 0); g.lineTo(cx, H); g.stroke();
    }
  }

  private drawStroke(c: CanvasRenderingContext2D, s: StrokeState) {
    const W = this.W;
    c.globalCompositeOperation = s.tool === 'silgi_alan' ? 'destination-out' : 'source-over';
    c.globalAlpha = s.tool === 'vurgu' ? 0.35 : 1;
    if (!s.pts.length) return;
    const P = s.pts.map(([x, y, p]) => [(x + s.dx) * W, (y + s.dy) * W, p] as [number, number, number]);
    if (s.tool === 'cizgi' || s.tool === 'cember') {
      const [a, b] = [P[0], P[P.length - 1]];
      c.strokeStyle = s.color; c.lineWidth = s.w * W; c.lineCap = 'round';
      c.beginPath();
      if (s.tool === 'cizgi') { c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); }
      else c.arc(a[0], a[1], Math.hypot(b[0] - a[0], b[1] - a[1]), 0, Math.PI * 2);
      c.stroke();
      return;
    }
    const size = s.tool === 'vurgu' ? s.w * W * 4 : s.tool === 'silgi_alan' ? s.w * W * 6 : s.w * W;
    const outline = getStroke(P, {
      size, thinning: s.tool === 'kalem' ? 0.5 : 0, smoothing: 0.5, streamline: 0.4,
      simulatePressure: false, last: s.done,
    });
    if (!outline.length) return;
    const path = new Path2D();
    path.moveTo(outline[0][0], outline[0][1]);
    for (let i = 1; i < outline.length; i++) {
      const [x0, y0] = outline[i - 1], [x1, y1] = outline[i];
      path.quadraticCurveTo(x0, y0, (x0 + x1) / 2, (y0 + y1) / 2);
    }
    path.closePath();
    c.fillStyle = s.tool === 'silgi_alan' ? '#000' : s.color;
    c.fill(path);
  }

  /** Mürekkep katmanını çizer; yeniden çizilen (önbelleğe eklenen) çizgi sayısını döndürür. */
  render(state: BoardState, page: number, lasers: Laser[]): number {
    const vis = state.visibleStrokes(page);
    let k = 0;
    while (k < vis.length && vis[k].done) k++;
    const sigs = vis.slice(0, k).map(s => `${s.id}|${s.dx}|${s.dy}|${s.pts.length}`);
    let fresh = 0;
    const prefixOk = page === this.bakedPage && this.baked.length <= sigs.length && this.baked.every((s, i) => s === sigs[i]);
    if (this.noCache || !prefixOk) {
      this.bctx.globalCompositeOperation = 'source-over';
      this.bctx.clearRect(0, 0, this.W, this.H);
      this.baked = []; this.bakedPage = page;
    }
    for (let i = this.baked.length; i < k; i++) { this.drawStroke(this.bctx, vis[i]); this.baked.push(sigs[i]); fresh++; }
    const c = this.ictx;
    c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1;
    c.clearRect(0, 0, this.W, this.H);
    c.drawImage(this.base, 0, 0, this.W, this.H);
    for (let i = k; i < vis.length; i++) this.drawStroke(c, vis[i]);
    c.globalCompositeOperation = 'source-over';
    const now = Date.now();
    for (const l of lasers) {
      const a = Math.max(0, 1 - (now - l.at) / 1000);
      if (!a) continue;
      c.globalAlpha = a; c.fillStyle = '#ef4444';
      c.beginPath(); c.arc(l.x * this.W, l.y * this.W, 6, 0, Math.PI * 2); c.fill();
    }
    c.globalAlpha = 1;
    return fresh;
  }

  /** Arka plan + mürekkep birleşik piksel verisi (test için, kırmızı kanal). */
  pixels(): number[] {
    const t = document.createElement('canvas');
    t.width = this.ink.width; t.height = this.ink.height;
    const x = t.getContext('2d')!;
    x.drawImage(this.bg, 0, 0); x.drawImage(this.ink, 0, 0);
    const d = x.getImageData(0, 0, t.width, t.height).data;
    const out = [t.width, t.height];
    for (let i = 0; i < d.length; i += 4) out.push(d[i]);
    return out;
  }
}
