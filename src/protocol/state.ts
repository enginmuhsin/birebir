/**
 * Tahta durumu. Kurallar:
 *  1. Bir yazarın olayları yalnız seq sırasıyla uygulanır; boşluk varsa olay bekletilir, tekrar gelen yok sayılır.
 *  2. Yazarlar arası sıra sonucu değiştirmez:
 *     - stroke noktaları yalnız sahibinden gelir (yazar içi sıra yeter),
 *     - görünürlük (sil / geri_getir), sayfa türü, görsel ve metin: en büyük (t, author, seq) kazanır,
 *     - taşıma ötelemeleri toplanır (toplama sıradan bağımsızdır),
 *     - çizim sırası (silgi dahil) stroke başlangıcının (t, author, seq) anahtarıyla belirlenir.
 *  Bu yüzden iki taraf aynı olay kümesini hangi sırada alırsa alsın aynı duruma varır.
 */
import type { Author, BoardEvent, Point, SeqVector, Tool } from './types.js';
import { Q } from './codec.js';

type Stamp = [number, Author, number]; // (t, author, seq)
const later = (a: Stamp, b: Stamp) =>
  a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];

export interface StrokeState {
  id: string; author: Author; page: number; tool: Tool; w: number; color: string;
  pts: Point[]; done: boolean; order: Stamp;
  dx: number; dy: number;
}
interface Lww<T> { value: T; at: Stamp }

export interface Snapshot {
  v: 1;
  lesson: string;
  vector: SeqVector;
  strokes: StrokeState[];
  hidden: Record<string, Lww<boolean>>;
  pages: Record<string, Lww<{ kind: string; src?: string }>>;
  items: Record<string, Lww<Record<string, unknown>>>;
  moves: Record<string, { dx: number; dy: number }>; // Q biriminde tam sayı
  cursor: Record<Author, number>;
}

export class BoardState {
  readonly lesson: string;
  vector: SeqVector = { T: 0, S: 0 };
  strokes = new Map<string, StrokeState>();
  private pendingPts = new Map<string, Point[]>(); // basla gelmeden gelen noktalar (yazar içi sırada olmaz; savunma)
  hidden = new Map<string, Lww<boolean>>();
  pages = new Map<number, Lww<{ kind: string; src?: string }>>();
  items = new Map<string, Lww<Record<string, unknown>>>();
  moves = new Map<string, { dx: number; dy: number }>();
  cursor: Record<Author, number> = { T: 0, S: 0 };
  private buffer: Record<Author, Map<number, BoardEvent>> = { T: new Map(), S: new Map() };
  /** Uygulanan olaylar, yazar başına seq sırasıyla (log[a][seq-1]). Eşitleme yanıtları buradan verilir. */
  readonly log: Record<Author, BoardEvent[]> = { T: [], S: [] };

  constructor(lesson: string, private keepLog = true) { this.lesson = lesson; }

  /** Karşı tarafın vektöründen sonraki tüm olaylar (her iki yazarın), yazar içi sırayla. */
  eventsAfter(v: SeqVector): BoardEvent[] {
    if (!this.keepLog) throw new Error('günlük tutulmuyor');
    return [...this.log.T.slice(Math.max(0, v.T)), ...this.log.S.slice(Math.max(0, v.S))];
  }

  /** Olayı uygular ya da bekletir. Uygulanan olay sayısını döndürür (bekleyenler zincirlenebilir). */
  receive(e: BoardEvent): number {
    if (e.lesson !== this.lesson) return 0;
    if (e.seq <= this.vector[e.author]) return 0;            // tekrar
    this.buffer[e.author].set(e.seq, e);
    let n = 0;
    for (;;) {
      const next = this.buffer[e.author].get(this.vector[e.author] + 1);
      if (!next) break;
      this.buffer[e.author].delete(next.seq);
      this.applyOrdered(next);
      this.vector[e.author] = next.seq;
      if (this.keepLog) this.log[e.author].push(next);
      n++;
    }
    return n;
  }

  /** Bekleyen (boşluk yüzünden uygulanamayan) olay var mı? */
  get hasGap(): boolean { return this.buffer.T.size + this.buffer.S.size > 0; }

  private applyOrdered(e: BoardEvent) {
    const at: Stamp = [e.t, e.author, e.seq];
    switch (e.act) {
      case 'basla': {
        const pre = this.pendingPts.get(e.stroke) ?? [];
        this.pendingPts.delete(e.stroke);
        this.strokes.set(e.stroke, {
          id: e.stroke, author: e.author, page: e.page, tool: e.tool, w: e.w, color: e.color,
          pts: [...e.pts, ...pre], done: false, order: at, dx: 0, dy: 0,
        });
        break;
      }
      case 'ciz':
      case 'bitir': {
        const s = this.strokes.get(e.stroke);
        if (s && s.author === e.author) { s.pts.push(...e.pts); if (e.act === 'bitir') s.done = true; }
        break;
      }
      case 'sil':
      case 'geri_getir':
        for (const id of e.target) {
          const cur = this.hidden.get(id);
          if (!cur || later(at, cur.at)) this.hidden.set(id, { value: e.act === 'sil', at });
        }
        break;
      case 'tasi':
        for (const id of e.target) {
          const m = this.moves.get(id) ?? { dx: 0, dy: 0 };
          // tam sayı birimde topla: kayan nokta toplamı sıraya bağlı olabilir
          m.dx += Math.round(e.dx * Q); m.dy += Math.round(e.dy * Q);
          this.moves.set(id, m);
        }
        break;
      case 'sayfa_ekle': {
        const cur = this.pages.get(e.page);
        if (!cur || later(at, cur.at)) this.pages.set(e.page, { value: e.src === undefined ? { kind: e.kind } : { kind: e.kind, src: e.src }, at });
        break;
      }
      case 'sayfa_gec':
        this.cursor[e.author] = e.page;
        break;
      case 'gorsel_ekle':
      case 'metin_ekle': {
        const { v, lesson, author, seq, t, ...rest } = e;
        const cur = this.items.get(e.id);
        if (!cur || later(at, cur.at)) this.items.set(e.id, { value: rest, at });
        break;
      }
    }
  }

  /** Bir sayfanın görünür stroke'ları, deterministik çizim sırasıyla. Taşıma ötelemesi uygulanmış. */
  visibleStrokes(page: number): StrokeState[] {
    const out: StrokeState[] = [];
    for (const s of this.strokes.values()) {
      if (s.page !== page || this.hidden.get(s.id)?.value) continue;
      const m = this.moves.get(s.id);
      out.push(m ? { ...s, dx: m.dx / Q, dy: m.dy / Q } : s);
    }
    return out.sort((a, b) => (later(a.order, b.order) ? 1 : -1));
  }

  snapshot(): Snapshot {
    const obj = <K extends string | number, V>(m: Map<K, V>) =>
      Object.fromEntries([...m.entries()].sort(([a], [b]) => (String(a) < String(b) ? -1 : 1)).map(([k, v]) => [String(k), v]));
    return JSON.parse(JSON.stringify({
      v: 1, lesson: this.lesson, vector: this.vector,
      strokes: [...this.strokes.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
      hidden: obj(this.hidden), pages: obj(this.pages), items: obj(this.items), moves: obj(this.moves),
      cursor: this.cursor,
    }));
  }

  static fromSnapshot(s: Snapshot): BoardState {
    const b = new BoardState(s.lesson, false); // anlık görüntüden kurulan durum eski olayları tutmaz
    b.vector = { ...s.vector };
    for (const st of s.strokes) b.strokes.set(st.id, structuredClone(st));
    for (const [k, v] of Object.entries(s.hidden)) b.hidden.set(k, structuredClone(v));
    for (const [k, v] of Object.entries(s.pages)) b.pages.set(Number(k), structuredClone(v));
    for (const [k, v] of Object.entries(s.items)) b.items.set(k, structuredClone(v));
    for (const [k, v] of Object.entries(s.moves)) b.moves.set(k, { ...v });
    b.cursor = { ...s.cursor };
    return b;
  }

  /** İki tarafın aynı durumda olduğunu karşılaştırmak için kararlı özet (FNV-1a 32 bit). */
  hash(): string {
    const s = JSON.stringify(this.snapshot());
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(16).padStart(8, '0');
  }
}
