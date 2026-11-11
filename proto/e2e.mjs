// Aşama 1 uçtan uca testi ve ölçümü. Çıktı: proto/olcum-asama1.json
// İki tarayıcı: öğretmen (masaüstü) + öğrenci (telefon), sahte kamera/mikrofon, yerel sinyal sunucusu.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');

const PORT = 8790, U = `http://localhost:${PORT}`;
const server = spawn(process.execPath, ['proto/server.mjs'], { env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise(r => server.stdout.once('data', r));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1) : null; };
const stats = a => ({ n: a.length, medyan: pct(a, 0.5), p95: pct(a, 0.95) });
const results = []; const report = { tarih: new Date().toISOString(), not: 'Yerel sunucu ve aynı makinede iki tarayıcı; gerçek ağ ve TURN ile denenmedi.' };
function check(name, ok, detail = '') { results.push({ test: name, sonuc: ok ? 'geçti' : 'KALDI', ayrinti: detail }); console.log(ok ? '✓' : '✗', name, detail); }
async function until(page, fn, arg, timeout = 15000) { try { await page.waitForFunction(fn, arg, { timeout }); return true; } catch { return false; } }
const ev = (p, fn, arg) => p.evaluate(fn, arg);
const syncWait = async (A, B, t = 8000) => until(B, h => window.__board.hash() === h, await ev(A, () => window.__board.hash()), t);

const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
try {
  const t0 = Date.now();
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['camera', 'microphone'] });
  const ctxB = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, permissions: ['camera', 'microphone'] });
  const A = await ctxA.newPage(), B = await ctxB.newPage();
  const errs = [];
  for (const p of [A, B]) p.on('pageerror', e => errs.push(e.message));
  await fetch(`${U}/__delay?ms=50&jitter=15`); // sinyal/yayın kanalına 50 ± 15 ms
  const tc = Date.now();
  await A.goto(`${U}/?author=T&lesson=L-a1&t0=${t0}`);
  await B.goto(`${U}/?author=S&lesson=L-a1&t0=${t0}`);

  // 1) bağlantı
  const dcA = await until(A, () => window.__board.dcOpen(), null, 20000), dcB = await until(B, () => window.__board.dcOpen(), null, 20000);
  report.veri_kanali_acilis_ms = Date.now() - tc;
  check('Veri kanalı iki tarafta açıldı', dcA && dcB, `${report.veri_kanali_acilis_ms} ms (sayfa açılışından)`);

  // 2) medya
  async function mediaFlows(p) {
    for (let i = 0; i < 40; i++) { const s = await ev(p, () => window.__board.rtcStats()); if (s && s.framesDecoded > 10 && s.audioIn > 1000) return s; await sleep(500); }
    return ev(p, () => window.__board.rtcStats());
  }
  report.medya_B = await mediaFlows(B); report.medya_A = await mediaFlows(A);
  const media = report.medya_B.framesDecoded > 10 && report.medya_B.audioIn > 1000, mediaA = report.medya_A.framesDecoded > 10 && report.medya_A.audioIn > 1000;
  check('Ses ve görüntü iki yönde akıyor (sahte cihaz)', media && mediaA, JSON.stringify(report.medya_B));

  // 3) gecikme: veri kanalı vs yayın kanalı
  async function measure(label, forceBc, packets = 300) {
    await ev(A, v => window.__board.forceBc(v), forceBc);
    await ev(B, () => { const m = window.__board.metrics; m.recv.length = 0; m.paint.length = 0; m.received = 0; });
    let seed = forceBc ? 500 : 100;
    while ((await ev(B, () => window.__board.metrics.received)) < packets) await ev(A, s => window.__board.synth(5, s), seed++);
    await sleep(400);
    const m = await ev(B, () => ({ recv: window.__board.metrics.recv, paint: window.__board.metrics.paint }));
    return { yol: label, kalemden_alima_ms: stats(m.recv), kalemden_ekrana_ms: stats(m.paint) };
  }
  report.gecikme = [await measure('veri kanalı (eşten eşe, aynı makine)', false), await measure('yayın kanalı (50 ± 15 ms benzetim)', true)];
  await ev(A, () => window.__board.forceBc(false));
  console.log(JSON.stringify(report.gecikme));
  check('Tahta yayın yedeğinde de eşitlendi', await syncWait(A, B));

  // 4) veri kanalı kopunca yayına düşme ve kanalın geri gelmesi
  const via0 = await ev(A, () => window.__board.via());
  const tr = Date.now();
  await ev(A, () => window.__board.breakDc());
  await until(A, () => !window.__board.dcOpen(), null, 3000);
  await ev(A, () => window.__board.synth(3, 901, 500, 100));
  const via1 = await ev(A, () => window.__board.via());
  const fellBack = via1.bc > via0.bc;
  const synced = await syncWait(A, B);
  const reopened = await until(A, () => window.__board.dcOpen(), null, 20000);
  check('Veri kanalı kopunca yayın kanalına düştü, durum aynı kaldı', fellBack && synced, `yayından giden: ${via1.bc - via0.bc}`);
  check('Veri kanalı kendiliğinden yeniden açıldı', reopened, `koparmadan itibaren ${Date.now() - tr} ms içinde (3 çizgi süren çizim dahil)`);

  // 5) yayın (sinyal) sunucusu koparken veri kanalı tahtayı taşımaya devam eder
  await until(B, () => window.__board.dcOpen(), null, 10000);
  await ev(B, () => window.__board.drop(8000));
  await until(B, () => window.__board.status() !== 'bagli', null, 3000);
  await ev(A, () => window.__board.synth(3, 902, 500, 100));
  check('Sinyal sunucusu kopukken tahta veri kanalından eşitlendi', await syncWait(A, B, 5000), `B durumu: ${await ev(B, () => window.__board.status())}`);
  await until(B, () => window.__board.status() === 'bagli', null, 15000);

  // 6) araçlar
  const cnt = p => ev(p, () => window.__board.strokeCount());
  await ev(A, () => window.__board.setTool('kalem'));
  await ev(A, () => window.__board.synth(1, 11, 400, 50));
  await syncWait(A, B);
  let n = await cnt(B);
  await ev(A, () => window.__board.undo()); await syncWait(A, B);
  const afterUndo = await cnt(B);
  await ev(A, () => window.__board.redo()); await syncWait(A, B);
  check('Geri al / ileri al karşı tarafa yansıdı', afterUndo === n - 1 && (await cnt(B)) === n, `${n} → ${afterUndo} → ${await cnt(B)}`);

  // silgi: öğretmenin son çizgisinin bir noktasına dokun
  const target = await ev(A, () => { const v = window.__board.state.visibleStrokes(window.__board.page()); const s = v.filter(x => x.author === 'T' && x.tool === 'kalem').at(-1); return { id: s.id, p: s.pts[Math.floor(s.pts.length / 2)], dx: s.dx, dy: s.dy }; });
  const px = target.p[0] + target.dx, py = target.p[1] + target.dy;
  // öğrenci öğretmenin çizgisini silemez
  await ev(B, () => window.__board.setTool('silgi'));
  await ev(B, ([x, y]) => { window.__board.fire('pointerdown', x, y); window.__board.fire('pointerup', x, y); }, [px, py]);
  await sleep(500);
  const stillThere = await ev(A, id => !window.__board.state.hidden.get(id)?.value, target.id);
  check('Öğrenci silgisi öğretmen çizgisini silmedi', stillThere);
  n = await cnt(B);
  await ev(A, () => window.__board.setTool('silgi'));
  await ev(A, ([x, y]) => { window.__board.fire('pointerdown', x, y); window.__board.fire('pointerup', x, y); }, [px, py]);
  await syncWait(A, B);
  const erased = await ev(B, id => !!window.__board.state.hidden.get(id)?.value, target.id);
  await ev(A, () => window.__board.undo()); await syncWait(A, B);
  const restored = await ev(B, id => !window.__board.state.hidden.get(id)?.value, target.id);
  check('Silgi çizgiyi sildi, geri al geri getirdi', erased && restored);

  // düz çizgi, çember, vurgu, alan silgisi
  const tools = {};
  for (const t of ['cizgi', 'cember', 'vurgu', 'silgi_alan']) {
    await ev(A, x => window.__board.setTool(x), t);
    await ev(A, () => window.__board.synth(1, 77, 400, 50));
    await syncWait(A, B);
    tools[t] = await ev(B, x => { const s = window.__board.state.visibleStrokes(window.__board.page()).filter(s => s.tool === x).at(-1); return s ? { done: s.done, pts: s.pts.length } : null; }, t);
  }
  check('Düz çizgi, çember, vurgu, alan silgisi karşı tarafa ulaştı', Object.values(tools).every(v => v && v.done), JSON.stringify(tools));
  check('Düz çizgi ve çember yalnız birkaç nokta taşıyor', tools.cizgi.pts <= 12 && tools.cember.pts <= 12, `çizgi ${tools.cizgi.pts}, çember ${tools.cember.pts} nokta`);

  // lazer: kaydedilmez, karşıda görünür
  const h0 = await ev(A, () => window.__board.hash());
  await ev(A, () => window.__board.setTool('lazer'));
  await ev(A, () => { window.__board.fire('pointerdown', 0.5, 0.5); for (let i = 0; i < 5; i++) window.__board.fire('pointermove', 0.5 + i * 0.01, 0.5); });
  const laserSeen = await until(B, () => window.__board.lasers() > 0, null, 3000);
  check('Lazer karşıda görünür, tahta durumuna yazılmaz', laserSeen && h0 === (await ev(A, () => window.__board.hash())));
  await ev(A, () => window.__board.fire('pointerup', 0.55, 0.5));

  // kalem yetkisi
  await ev(A, () => window.__board.setStudentPen(false));
  await until(B, () => window.__board.studentPen() === false, null, 3000);
  await ev(B, () => window.__board.setTool('kalem'));
  const before = await ev(B, () => window.__board.state.vector.S);
  await ev(B, () => window.__board.synth(1, 5, 300, 50));
  const lockedOk = (await ev(B, () => window.__board.state.vector.S)) === before;
  await ev(A, () => window.__board.setStudentPen(true));
  await until(B, () => window.__board.studentPen() === true, null, 3000);
  await ev(B, () => window.__board.synth(1, 6, 300, 50));
  const unlockedOk = (await ev(B, () => window.__board.state.vector.S)) > before;
  check('Kalem yetkisi: kapalıyken öğrenci çizemez, açılınca çizer', lockedOk && unlockedOk);

  // avuç içi reddi: kalem görüldükten sonra dokunma çizmez
  const s1 = await ev(B, () => window.__board.state.vector.S);
  await ev(B, () => window.__board.synth(1, 8, 300, 50, 'touch'));
  check('Avuç içi reddi: kalemden sonra dokunma çizgi üretmedi', (await ev(B, () => window.__board.state.vector.S)) === s1);

  // 7) PDF
  const P = await (await browser.newContext()).newPage();
  await P.setContent(`<style>body{font:20px serif;margin:60px}h1{font-size:32px}</style>
    <h1>TM07 · Örnek föy</h1><p>1) x² − 5x + 6 = 0 denkleminin kökleri toplamı kaçtır?</p><p>A) 2 &nbsp; B) 3 &nbsp; C) 5 &nbsp; D) 6 &nbsp; E) 11</p>
    <div style="page-break-after:always"></div><h1>Sayfa 2</h1><p>2) f(x) = 2x + 3 ise f(4) kaçtır?</p>`);
  await P.pdf({ path: 'proto/ornek.pdf', format: 'A4' });
  const pagesBefore = await ev(A, () => window.__board.pageCount());
  const tp = Date.now();
  await A.setInputFiles('#pdf', 'proto/ornek.pdf');
  const pdfDone = await until(A, () => /PDF sayfası eklendi/.test(window.__board.notice()), null, 30000);
  const pdfMs = Date.now() - tp;
  const pagesAfter = await ev(A, () => window.__board.pageCount());
  await until(B, p => window.__board.page() === p, await ev(A, () => window.__board.page()), 5000);
  await until(B, () => window.__board.imagesReady(), null, 10000);
  await sleep(500);
  const dark = await ev(B, () => { const px = window.__board.pixels(); let d = 0; for (let i = 2; i < px.length; i++) if (px[i] < 128) d++; return d / (px.length - 2); });
  check('PDF 2 sayfa eklendi, öğrenci ilk PDF sayfasında ve metin görünüyor', pdfDone && pagesAfter - pagesBefore === 2 && dark > 0.001, `${pdfMs} ms, koyu piksel oranı ${(dark * 100).toFixed(2)}%`);
  // PDF üzerine çiz
  await ev(A, () => window.__board.setTool('kalem'));
  await ev(A, () => window.__board.synth(2, 33, 500, 50));
  check('PDF sayfası üzerine çizim eşitlendi', await syncWait(A, B));

  // 8) performans: 1.000 çizgi, telefonda 4 kat yavaşlatılmış işlemci
  await ev(A, () => window.__board.goPage(0));
  await until(B, () => window.__board.page() === 0, null, 5000);
  await ev(A, () => window.__board.bulk(1000));
  check('1.000 çizgilik yük eşitlendi', await syncWait(A, B, 30000), `B sayfa 0 çizgi: ${await ev(B, () => window.__board.strokeCount(0))}`);
  const cdp = await ctxB.newCDPSession(B);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  async function renderCost() {
    await ev(B, () => { window.__board.metrics.render.length = 0; });
    await ev(A, () => window.__board.synth(4, 61, 800, 100));
    await sleep(300);
    return stats(await ev(B, () => window.__board.metrics.render));
  }
  const cached = await renderCost();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await B.goto(`${U}/?author=S&lesson=L-a1&t0=${t0}&nocache=1&media=0`);
  await until(B, () => window.__board.status() === 'bagli', null, 10000);
  const resyncOk = await syncWait(A, B, 30000) && await until(B, () => window.__board.synced(), null, 5000);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const naive = await renderCost();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  report.cizim_1000_cizgi_telefon_4x = { onbellekli_ms: cached, onbelleksiz_ms: naive };
  check('Önbellekle kare süresi 16,7 ms (60 fps) altında', cached.p95 !== null && cached.p95 < 16.7, `önbellekli medyan ${cached.medyan} / p95 ${cached.p95} ms; önbelleksiz medyan ${naive.medyan} / p95 ${naive.p95} ms`);
  check('Sayfa yenilenen öğrenci 1.000+ çizgiyi yeniden aldı', resyncOk);
  await B.goto(`${U}/?author=S&lesson=L-a1&t0=${t0}&media=0`);
  await until(B, () => window.__board.status() === 'bagli', null, 10000);

  // 9) geç katılan izleyici: piksel karşılaştırması (PDF sayfasında)
  await ev(A, () => window.__board.goPage(1));
  const C = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await C.goto(`${U}/?author=V&lesson=L-a1&t0=${t0}`);
  const joined = await syncWait(A, C, 20000);
  await until(C, () => window.__board.imagesReady(), null, 10000);
  await until(A, () => window.__board.imagesReady(), null, 10000);
  await sleep(600);
  const [pa, pc] = [await ev(A, () => window.__board.pixels()), await ev(C, () => window.__board.pixels())];
  let diff = 0; for (let i = 2; i < pa.length; i++) if (Math.abs(pa[i] - pc[i]) > 8) diff++;
  check('Geç katılan izleyici aynı durumu ve aynı pikselleri gördü (PDF sayfası)', joined && diff === 0, `farklı piksel ${diff} / ${pa.length - 2}`);

  await A.screenshot({ path: 'proto/a1-ogretmen.png' });
  await B.screenshot({ path: 'proto/a1-ogrenci-telefon.png' });
  check('Sayfa hatası yok', errs.length === 0, errs.slice(0, 3).join(' | '));
  report.toplam_sure_sn = Math.round((Date.now() - t0) / 1000);
} finally {
  await browser.close();
  server.kill();
}
report.testler = results;
report.ozet = `${results.filter(r => r.sonuc === 'geçti').length} / ${results.length} geçti`;
writeFileSync('proto/olcum-asama1.json', JSON.stringify(report, null, 2));
console.log(report.ozet);
