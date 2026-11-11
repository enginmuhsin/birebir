// Aşama 0 ölçümü: iki (ve üç) tarayıcılı tahta testi. Çıktı: proto/olcum.json
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const PORT = 8787, URL0 = `http://localhost:${PORT}`;
const server = spawn(process.execPath, ['proto/server.mjs'], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(r => server.stdout.once('data', r));

const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
const stats = a => ({ n: a.length, medyan: pct(a, 0.5), p95: pct(a, 0.95), maks: Math.max(...a) });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { tarih: new Date().toISOString(), not: 'Yerel sahte yayın sunucusu; gerçek Supabase ile denenmedi.', senaryolar: [] };

const browser = await chromium.launch();
try {
  const t0 = Date.now();
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const ctxB = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const A = await ctxA.newPage(), B = await ctxB.newPage();
  for (const p of [A, B]) p.on('pageerror', e => console.error('sayfa hatası:', e.message));
  await A.goto(`${URL0}/?author=T&lesson=L-olcum&t0=${t0}`);
  await B.goto(`${URL0}/?author=S&lesson=L-olcum&t0=${t0}`);
  await A.waitForFunction(() => window.__board.status() === 'bagli');
  await B.waitForFunction(() => window.__board.status() === 'bagli');

  // 1) Gecikme: A çizer, B ölçer. Her senaryoda en az 1000 paket.
  const scenarios = [
    { ad: 'yerel (ağ gecikmesi yok)', ms: 0, jitter: 0 },
    { ad: 'benzetilmiş 50 ms ± 15 ms ağ', ms: 50, jitter: 15 },
    { ad: 'benzetilmiş 120 ms ± 40 ms (zayıf mobil)', ms: 120, jitter: 40 },
  ];
  let seed = 1;
  for (const sc of scenarios) {
    await fetch(`${URL0}/__delay?ms=${sc.ms}&jitter=${sc.jitter}`);
    await B.evaluate(() => { const m = window.__board.metrics; m.recv.length = 0; m.paint.length = 0; m.received = 0; });
    const tStart = Date.now();
    while ((await B.evaluate(() => window.__board.metrics.received)) < 1000) await A.evaluate(s => window.__board.synth(10, s), seed++);
    await sleep(sc.ms + 3 * sc.jitter + 300);
    const m = await B.evaluate(() => ({ ...window.__board.metrics }));
    const sentRate = (await A.evaluate(() => window.__board.metrics.sent)) ;
    report.senaryolar.push({
      senaryo: sc.ad,
      alinan_paket: m.received,
      kalemden_alima_ms: stats(m.recv),
      kalemden_ekrana_ms: stats(m.paint),
      sure_sn: Math.round((Date.now() - tStart) / 1000),
    });
    console.log(sc.ad, JSON.stringify(report.senaryolar.at(-1)));
  }
  const rB = await B.evaluate(() => window.__board.metrics.render);
  const rA = await A.evaluate(() => window.__board.metrics.render);
  report.cizim_suresi_ms = { masaustu_A: stats(rA), telefon_B: stats(rB) };
  report.gonderilen_paket_A = await A.evaluate(() => window.__board.metrics.sent);

  // 2) Kopma: B 20 sn çevrim dışı; bu sırada ikisi de çizer.
  await fetch(`${URL0}/__delay?ms=50&jitter=15`);
  await B.evaluate(() => window.__board.drop(20000));
  await B.waitForFunction(() => window.__board.status() !== 'bagli');
  const offStart = Date.now();
  const drawing = Promise.all([A.evaluate(() => window.__board.synth(14, 777)), B.evaluate(() => window.__board.synth(6, 888, 600, 1000))]);
  await sleep(12000); // ikisi de çizerken, B hâlâ çevrim dışıyken durumları karşılaştır
  const hashesDuring = { A: await A.evaluate(() => window.__board.hash()), B: await B.evaluate(() => window.__board.hash()), B_durum: await B.evaluate(() => window.__board.status()) };
  await drawing;
  const drawEnd = Date.now() - offStart;
  await B.waitForFunction(() => window.__board.status() === 'bagli', null, { timeout: 30000 });
  const reconnectedAfter = Date.now() - offStart;
  let converged = null;
  const tc = Date.now();
  for (let i = 0; i < 100; i++) {
    const [ha, hb] = [await A.evaluate(() => window.__board.hash()), await B.evaluate(() => window.__board.hash())];
    if (ha === hb) { converged = Date.now() - tc; break; }
    await sleep(100);
  }
  report.kopma_testi = {
    cevrimdisi_sn: 20,
    kopukken_farkli_mi: hashesDuring.A !== hashesDuring.B,
    kopukken_B_durumu: hashesDuring.B_durum,
    cizim_bitis_ms_kopustan_itibaren: drawEnd,
    yeniden_baglanma_ms_kopustan_itibaren: reconnectedAfter,
    baglandiktan_sonra_esitlenme_ms: converged,
    sonuc_ayni_durum: converged !== null,
    cizgi_sayisi: { A: await A.evaluate(() => window.__board.strokeCount()), B: await B.evaluate(() => window.__board.strokeCount()) },
    ozet: { A: await A.evaluate(() => window.__board.hash()), B: await B.evaluate(() => window.__board.hash()) },
  };
  console.log('kopma', JSON.stringify(report.kopma_testi));

  // 3) Geç katılan izleyici C (A ile aynı ekran boyutu): durumu ve pikselleri karşılaştır.
  const ctxC = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const C = await ctxC.newPage();
  await C.goto(`${URL0}/?author=V&lesson=L-olcum&t0=${t0}`);
  await C.waitForFunction(() => window.__board.status() === 'bagli');
  const tj = Date.now();
  await C.waitForFunction(h => window.__board.hash() === h, await A.evaluate(() => window.__board.hash()), { timeout: 15000 });
  const joinMs = Date.now() - tj;
  await sleep(300);
  const [pa, pc] = [await A.evaluate(() => window.__board.pixels()), await C.evaluate(() => window.__board.pixels())];
  let diff = 0; for (let i = 2; i < pa.length; i++) if (Math.abs(pa[i] - pc[i]) > 8) diff++;
  report.gec_katilim = {
    esitlenme_ms: joinMs,
    piksel_boyutu: `${pa[0]}x${pa[1]}`,
    farkli_piksel: diff,
    farkli_piksel_orani: diff / (pa.length - 2),
  };
  await A.screenshot({ path: 'proto/ekran-A.png' });
  await B.screenshot({ path: 'proto/ekran-B-telefon.png', fullPage: false });
  console.log('gec katilim', JSON.stringify(report.gec_katilim));
} finally {
  await browser.close();
  server.kill();
}
writeFileSync('proto/olcum.json', JSON.stringify(report, null, 2));
console.log('yazıldı: proto/olcum.json');
