/**
 * Kompakt tel biçimi. Olaylar paketlenir; koordinatlar tam sayıya nicemlenir ve çizgi içinde
 * fark (delta) kodlanır. Gönderen, kendi durumuna da nicemlenmiş olayı uygular (quantize):
 * böylece iki taraf birebir aynı sayılarla çalışır.
 */
import { ACTS, PROTOCOL_VERSION, type Author, type BoardEvent, type Point, type Tool } from './types.js';

export const Q = 10000;          // x, y, dx, dy, w/h: 1e-4 sayfa genişliği (2000 px ekranda 0,2 px)
export const QW = 100000;        // kalınlık ve metin boyu: 1e-5
const TOOLS: Tool[] = ['kalem', 'vurgu', 'silgi_alan', 'cizgi', 'cember'];
const KINDS = ['bos', 'kareli', 'cizgili', 'koordinat', 'pdf', 'soru'] as const;

export interface Packet {
  v: 1;
  l: string;      // ders
  a: Author;      // yazar
  e: unknown[][]; // kompakt olaylar
}

const q = (n: number, k = Q) => Math.round(n * k);
const dq = (n: number, k = Q) => n / k;

function packPts(pts: Point[]): number[] {
  const out: number[] = [];
  let px = 0, py = 0, pp = 0;
  for (const [x, y, p] of pts) {
    const ix = q(x), iy = q(y), ip = Math.round(p * 100);
    out.push(ix - px, iy - py, ip - pp);
    px = ix; py = iy; pp = ip;
  }
  return out;
}
function unpackPts(flat: number[]): Point[] {
  const pts: Point[] = [];
  let x = 0, y = 0, p = 0;
  for (let i = 0; i < flat.length; i += 3) {
    x += flat[i]; y += flat[i + 1]; p += flat[i + 2];
    pts.push([dq(x), dq(y), p / 100]);
  }
  return pts;
}

export function encodeEvent(e: BoardEvent): unknown[] {
  const head = [e.seq, e.t, e.page, ACTS.indexOf(e.act)];
  switch (e.act) {
    case 'basla': return [...head, e.stroke, TOOLS.indexOf(e.tool), q(e.w, QW), e.color, packPts(e.pts)];
    case 'ciz':
    case 'bitir': return [...head, e.stroke, packPts(e.pts)];
    case 'sil':
    case 'geri_getir': return [...head, e.target];
    case 'tasi': return [...head, e.target, q(e.dx), q(e.dy)];
    case 'sayfa_ekle': return e.src === undefined ? [...head, KINDS.indexOf(e.kind)] : [...head, KINDS.indexOf(e.kind), e.src];
    case 'sayfa_gec': return head;
    case 'gorsel_ekle': return [...head, e.id, e.src, q(e.x), q(e.y), q(e.w), q(e.h)];
    case 'metin_ekle': return [...head, e.id, e.text, e.latex ? 1 : 0, q(e.x), q(e.y), q(e.size, QW)];
  }
}

export function decodeEvent(c: unknown[], lesson: string, author: Author): BoardEvent {
  const [seq, t, page, ai] = c as number[];
  const act = ACTS[ai];
  const b = { v: PROTOCOL_VERSION, lesson, author, seq, t, page } as const;
  const r = c.slice(4) as any[];
  switch (act) {
    case 'basla': return { ...b, act, stroke: r[0], tool: TOOLS[r[1]], w: dq(r[2], QW), color: r[3], pts: unpackPts(r[4]) };
    case 'ciz':
    case 'bitir': return { ...b, act, stroke: r[0], pts: unpackPts(r[1]) };
    case 'sil':
    case 'geri_getir': return { ...b, act, target: r[0] };
    case 'tasi': return { ...b, act, target: r[0], dx: dq(r[1]), dy: dq(r[2]) };
    case 'sayfa_ekle': return r.length > 1 ? { ...b, act, kind: KINDS[r[0]], src: r[1] } : { ...b, act, kind: KINDS[r[0]] };
    case 'sayfa_gec': return { ...b, act };
    case 'gorsel_ekle': return { ...b, act, id: r[0], src: r[1], x: dq(r[2]), y: dq(r[3]), w: dq(r[4]), h: dq(r[5]) };
    case 'metin_ekle': return { ...b, act, id: r[0], text: r[1], latex: r[2] === 1, x: dq(r[3]), y: dq(r[4]), size: dq(r[5], QW) };
    default: throw new Error('bilinmeyen act kodu: ' + ai);
  }
}

export function encodePacket(events: BoardEvent[]): Packet {
  if (events.length === 0) throw new Error('boş paket');
  const { lesson, author } = events[0];
  for (const e of events) if (e.lesson !== lesson || e.author !== author) throw new Error('paket tek ders ve tek yazar taşır');
  return { v: 1, l: lesson, a: author, e: events.map(encodeEvent) };
}

export function decodePacket(p: Packet): BoardEvent[] {
  if (p.v !== 1) throw new Error('desteklenmeyen sürüm: ' + p.v);
  return p.e.map(c => decodeEvent(c, p.l, p.a));
}

/** Gönderen kendi durumuna bunu uygular; alıcının göreceği sayılarla birebir aynıdır. */
export const quantize = (e: BoardEvent): BoardEvent => decodeEvent(encodeEvent(e), e.lesson, e.author);
