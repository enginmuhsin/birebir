/**
 * Çizgi protokolü v1 — birebir ders platformu ve YKS Teşhis (stroke_recordings) için ORTAK biçim.
 *
 * Koordinatlar sayfa genişliğine oranlanır: x ∈ [0,1], y ∈ [0, sayfa_yüksekliği/sayfa_genişliği].
 * Kalınlık (w) da sayfa genişliği oranıdır. Böylece her ekran aynı çizimi aynı yerde gösterir.
 *
 * Tutarlılık modeli (CRDT gerekmez):
 *  - Her olay (author, seq) çiftiyle tekildir; seq her yazar için 1'den başlayıp birer artar.
 *  - Bir stroke'un tek sahibi vardır; noktaları yalnız sahibi ekler.
 *  - Silme ve geri getirme hedef stroke kimliğiyle yapılır; durum kümeleri "son yazan" değil
 *    olay sırasından bağımsız kurulur (bkz. state.ts), bu yüzden yazarlar arası sıra sonucu değiştirmez.
 *  - Geri al / ileri al istemci kavramıdır: geri_al = kendi son stroke'unu "sil", ileri_al = "geri_getir".
 */

export const PROTOCOL_VERSION = 1 as const;

/** T: öğretmen, S: öğrenci. Teşhis kayıtlarında yalnız T kullanılır. */
export type Author = 'T' | 'S';

export type Tool = 'kalem' | 'vurgu' | 'silgi_alan' | 'cizgi' | 'cember';

/** [x, y, basınç]; basınç 0–1, bilinmiyorsa 0.5. */
export type Point = [number, number, number];

interface Base {
  v: typeof PROTOCOL_VERSION;
  lesson: string;
  author: Author;
  /** Yazar başına ardışık sıra numarası (1, 2, 3, ...). */
  seq: number;
  /** Ders (ya da kayıt) başlangıcından milisaniye. */
  t: number;
  page: number;
}

export interface StrokeStart extends Base {
  act: 'basla';
  /** Yazar önekli tekil kimlik, ör. "T-000412". */
  stroke: string;
  tool: Tool;
  w: number;
  color: string;
  pts: Point[];
}
export interface StrokeMove extends Base {
  act: 'ciz';
  stroke: string;
  pts: Point[];
}
export interface StrokeEnd extends Base {
  act: 'bitir';
  stroke: string;
  pts: Point[];
}
export interface Erase extends Base {
  act: 'sil';
  target: string[];
}
export interface Restore extends Base {
  act: 'geri_getir';
  target: string[];
}
export interface Move extends Base {
  act: 'tasi';
  target: string[];
  dx: number;
  dy: number;
}
export interface PageAdd extends Base {
  act: 'sayfa_ekle';
  /** Eklenen sayfanın numarası (page alanı ile aynı). */
  kind: 'bos' | 'kareli' | 'cizgili' | 'koordinat' | 'pdf' | 'soru';
  src?: string;
}
export interface PageGo extends Base {
  act: 'sayfa_gec';
}
export interface ImageAdd extends Base {
  act: 'gorsel_ekle';
  id: string;
  src: string;
  x: number; y: number; w: number; h: number;
}
export interface TextAdd extends Base {
  act: 'metin_ekle';
  id: string;
  text: string;
  latex: boolean;
  x: number; y: number;
  size: number;
}

export type BoardEvent =
  | StrokeStart | StrokeMove | StrokeEnd
  | Erase | Restore | Move
  | PageAdd | PageGo | ImageAdd | TextAdd;

export type Act = BoardEvent['act'];

export const ACTS: readonly Act[] = [
  'basla', 'ciz', 'bitir', 'sil', 'geri_getir', 'tasi',
  'sayfa_ekle', 'sayfa_gec', 'gorsel_ekle', 'metin_ekle',
] as const;

/** Yazar başına görülen son ardışık seq; yeniden bağlanmada "bundan sonrasını gönder" için. */
export type SeqVector = Record<Author, number>;
