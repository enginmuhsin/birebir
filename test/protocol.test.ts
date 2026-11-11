import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import Ajv from 'ajv';
import {
  BoardState, boardEventSchema, decodePacket, encodePacket, quantize, type BoardEvent,
} from '../src/protocol/index.js';
import { authorStream, interleave, rng } from './gen.js';

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(boardEventSchema);

const T = authorStream('T', 11, 10, 0.4);
const S = authorStream('S', 22, 10, 0.15);

test('üretilen tüm olaylar şemaya uyar', () => {
  for (const e of [...T, ...S]) assert.ok(validate(e), JSON.stringify(validate.errors) + ' ' + JSON.stringify(e));
});

test('şema hatalı olayları reddeder', () => {
  const ok = T[0];
  const bad: unknown[] = [
    { ...ok, v: 2 },
    { ...ok, author: 'X' },
    { ...ok, seq: 0 },
    { ...ok, act: 'patlat' },
    { ...ok, color: 'red' },
    { ...ok, stroke: 'Z-1' },
    { ...ok, extra: 1 },
    { ...ok, pts: [[0.5, 0.5]] },
  ];
  for (const b of bad) assert.equal(validate(b), false, JSON.stringify(b));
});

test('kodlama-çözme: 1e-4 duyarlılıkta geri döner, nicemleme idempotent', () => {
  for (const e of [...T, ...S]) {
    const back = decodePacket(encodePacket([e]))[0];
    assert.deepEqual(back, e, 'nicemlenmiş olay birebir dönmeli');
    assert.deepEqual(quantize(back), back);
  }
  const raw: BoardEvent = { v: 1, lesson: 'L', author: 'T', seq: 1, t: 0, page: 0, act: 'basla', stroke: 'T-1', tool: 'kalem', w: 0.0031234, color: '#000000', pts: [[0.123456, 0.654321, 0.333]] };
  const qd = quantize(raw) as any;
  assert.ok(Math.abs(qd.pts[0][0] - 0.123456) <= 0.5e-4 && Math.abs(qd.pts[0][1] - 0.654321) <= 0.5e-4);
});

test('paket tek yazar taşır', () => {
  assert.throws(() => encodePacket([T[0], S[0]]));
});

function build(events: BoardEvent[]) { const b = new BoardState('L-test'); for (const e of events) b.receive(e); return b; }

test('yazarlar arası farklı sıralar aynı duruma varır (20 rastgele birleştirme)', () => {
  const ref = build([...T, ...S]).hash();
  for (let k = 0; k < 20; k++) assert.equal(build(interleave(T, S, 1000 + k)).hash(), ref);
  assert.equal(build([...S, ...T]).hash(), ref);
});

test('tekrar gelen ve sırası bozuk gelen olaylar aynı duruma varır', () => {
  const ref = build([...T, ...S]).hash();
  const r = rng(7);
  const noisy = interleave(T, S, 5).flatMap(e => (r() < 0.1 ? [e, e] : [e]));
  // %20 olayı 1-30 konum ileri kaydır (yeniden bağlanma sonrası geç gelen olay gibi)
  for (let i = noisy.length - 1; i > 0; i--) if (r() < 0.2) { const j = Math.min(noisy.length - 1, i + 1 + Math.floor(r() * 30)); [noisy[i], noisy[j]] = [noisy[j], noisy[i]]; }
  const b = build(noisy);
  assert.equal(b.hasGap, false);
  assert.equal(b.hash(), ref);
});

test('boşluk kapanana kadar sonraki olaylar bekletilir', () => {
  const b = new BoardState('L-test');
  assert.equal(b.receive(T[2]), 0);
  assert.equal(b.receive(T[1]), 0);
  assert.equal(b.hasGap, true);
  assert.equal(b.receive(T[0]), 3);
  assert.equal(b.vector.T, 3);
});

test('anlık görüntü + sonraki olaylar = baştan kurulum', () => {
  const all = interleave(T, S, 9);
  const full = build(all).hash();
  for (const cut of [1, 50, Math.floor(all.length / 2), all.length - 1]) {
    const a = build(all.slice(0, cut));
    const restored = BoardState.fromSnapshot(JSON.parse(JSON.stringify(a.snapshot())));
    for (const e of all.slice(cut)) restored.receive(e);
    assert.equal(restored.hash(), full, 'kesim ' + cut);
  }
});

test('çakışan sil / geri_getir: büyük (t, yazar, seq) kazanır, sıradan bağımsız', () => {
  const base = { v: 1 as const, lesson: 'L-test', page: 0 };
  const start: BoardEvent = { ...base, author: 'S', seq: 1, t: 100, act: 'basla', stroke: 'S-1', tool: 'kalem', w: 0.003, color: '#000000', pts: [[0.1, 0.1, 0.5]] };
  const del: BoardEvent = { ...base, author: 'T', seq: 1, t: 500, act: 'sil', target: ['S-1'] };
  const res: BoardEvent = { ...base, author: 'S', seq: 2, t: 499, act: 'geri_getir', target: ['S-1'] };
  const x = build([start, del, res]), y = build([start, res, del]);
  assert.equal(x.hash(), y.hash());
  assert.equal(x.visibleStrokes(0).length, 0, 'daha geç olan sil kazanmalı');
});

test('60 dakikalık sentetik ders: sıkıştırılmış tahta verisi < 2 MB', () => {
  const t60 = authorStream('T', 3, 60, 0.4), s60 = authorStream('S', 4, 60, 0.15);
  const packets = [t60, s60].flatMap(st => { const out = []; for (let i = 0; i < st.length; i += 20) out.push(encodePacket(st.slice(i, i + 20))); return out; });
  const compact = Buffer.from(packets.map(p => JSON.stringify(p)).join('\n'));
  const verbose = Buffer.from([...t60, ...s60].map(e => JSON.stringify(e)).join('\n'));
  const gz = gzipSync(compact).length;
  console.log(`  olay: ${t60.length + s60.length}, ayrıntılı JSON: ${(verbose.length / 1e6).toFixed(2)} MB, kompakt: ${(compact.length / 1e6).toFixed(2)} MB, kompakt+gzip: ${(gz / 1e6).toFixed(3)} MB`);
  assert.ok(gz < 2e6);
});

test('günlük: eventsAfter karşı tarafın eksiğini her iki yazardan verir', () => {
  const all = interleave(T, S, 3);
  const full = build(all);
  const half = build([...T.slice(0, 40), ...S.slice(0, 10)]);
  for (const e of full.eventsAfter(half.vector)) half.receive(e);
  assert.equal(half.hash(), full.hash());
  assert.equal(full.eventsAfter(full.vector).length, 0);
});
