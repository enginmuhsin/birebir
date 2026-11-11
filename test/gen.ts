/** Deterministik (tohumlu) sentetik ders olayı üreteci: testler ve boyut ölçümü için. */
import { quantize, type Author, type BoardEvent, type Point } from '../src/protocol/index.js';

export function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * Bir yazarın olay dizisi. Kalem 60 Hz örneklenir, 50 ms'lik paketlerle (≈3 nokta) gönderilir.
 * minutes: ders süresi; drawShare: çizimle geçen süre oranı.
 */
export function authorStream(author: Author, seed: number, minutes: number, drawShare: number, lesson = 'L-test'): BoardEvent[] {
  const r = rng(seed);
  const out: BoardEvent[] = [];
  let seq = 0, t = Math.floor(r() * 1000), page = 0, n = 0;
  const mine: string[] = [];
  const base = () => ({ v: 1 as const, lesson, author, seq: ++seq, t, page });
  const end = minutes * 60000;
  while (t < end) {
    const roll = r();
    if (roll < 0.86) {
      // bir çizgi: 0,3–2,5 sn
      const id = `${author}-${String(++n).padStart(6, '0')}`;
      const dur = 300 + Math.floor(r() * 2200);
      let x = 0.1 + r() * 0.8, y = 0.1 + r() * 1.2, p = 0.5;
      const samples: Point[] = [];
      for (let k = 0; k < dur / 16.7; k++) {
        x = Math.min(0.99, Math.max(0.01, x + (r() - 0.5) * 0.01));
        y = Math.min(1.40, Math.max(0.01, y + (r() - 0.5) * 0.01));
        p = Math.min(1, Math.max(0.05, p + (r() - 0.5) * 0.1));
        samples.push([x, y, p]);
      }
      const chunks: Point[][] = [];
      for (let k = 0; k < samples.length; k += 3) chunks.push(samples.slice(k, k + 3));
      chunks.forEach((c, i) => {
        const ev: BoardEvent = i === 0
          ? { ...base(), act: 'basla', stroke: id, tool: r() < 0.9 ? 'kalem' : 'vurgu', w: 0.002 + r() * 0.004, color: author === 'T' ? '#1f2937' : '#1d4ed8', pts: c }
          : { ...base(), act: i === chunks.length - 1 ? 'bitir' : 'ciz', stroke: id, pts: c };
        out.push(quantize(ev));
        t += 50;
      });
      if (chunks.length === 1) out.push(quantize({ ...base(), act: 'bitir', stroke: id, pts: [] }));
      mine.push(id);
      t += Math.floor(((1 - drawShare) / drawShare) * dur * (0.5 + r()));
    } else if (roll < 0.92 && mine.length) {
      const id = mine[Math.floor(r() * mine.length)];
      out.push(quantize({ ...base(), act: r() < 0.7 ? 'sil' : 'geri_getir', target: [id] }));
      t += 200;
    } else if (roll < 0.95 && mine.length) {
      out.push(quantize({ ...base(), act: 'tasi', target: [mine[Math.floor(r() * mine.length)]], dx: (r() - 0.5) * 0.1, dy: (r() - 0.5) * 0.1 }));
      t += 300;
    } else if (roll < 0.97 && author === 'T') {
      page += 1;
      out.push(quantize({ ...base(), act: 'sayfa_ekle', kind: 'kareli' }));
      t += 500;
    } else if (roll < 0.985) {
      out.push(quantize({ ...base(), act: 'metin_ekle', id: `${author}-m${seq}`, text: 'x^2 + 3x = 10', latex: true, x: r(), y: r(), size: 0.03 }));
      t += 400;
    } else {
      t += 1000;
    }
  }
  return out;
}

/** İki yazarın akışlarını, her yazarın kendi sırası korunarak rastgele birleştirir. */
export function interleave(a: BoardEvent[], b: BoardEvent[], seed: number): BoardEvent[] {
  const r = rng(seed); const out: BoardEvent[] = []; let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (j >= b.length || (i < a.length && r() < 0.5)) out.push(a[i++]); else out.push(b[j++]);
  }
  return out;
}
