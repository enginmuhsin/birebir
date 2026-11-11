// Uygulama uçtan uca testi: yerel Supabase benzeri yığın (gerçek PostgreSQL + migration + PostgREST) üzerinde.
// Çıktı: test/ciktilar/e2e-sonuc.json ve ekran-*.png
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require_ = createRequire(import.meta.url);
const { chromium } = require_('playwright');
const WebSocket = require_('ws');

const U = 'http://localhost:8800';
const stack = spawn('npx', ['tsx', 'db/test/yigin.mts'], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res, rej) => { stack.stdout.on('data', d => { if (/yığın hazır/.test(String(d))) res(); }); setTimeout(() => rej(new Error('yığın açılmadı')), 30000); });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
function check(name, ok, detail = '') { results.push({ test: name, sonuc: ok ? 'geçti' : 'KALDI', ayrinti: String(detail).slice(0, 300) }); console.log(ok ? '✓' : '✗', name, detail); }
async function until(page, fn, arg, timeout = 15000) { try { await page.waitForFunction(fn, arg, { timeout }); return true; } catch { return false; } }
const shot = (p, n) => p.screenshot({ path: `test/ciktilar/ekran-${n}.png` });

const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const errs = [];
try {
  const ctxT = await browser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ['camera', 'microphone', 'clipboard-read', 'clipboard-write'] });
  const ctxS = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, permissions: ['camera', 'microphone'] });
  const T = await ctxT.newPage(), S = await ctxS.newPage();
  for (const p of [T, S]) p.on('pageerror', e => errs.push(e.message));

  // 1) öğretmen girişi
  await T.goto(U + '/');
  await T.fill('input[name=e]', 'ogretmen@test.local');
  await T.fill('input[name=s]', 'yanlis-sifre');
  await T.click('button[type=submit]');
  check('Yanlış şifre reddedilir', await until(T, () => /hatalı/.test(document.querySelector('#m')?.textContent || '')));
  await T.fill('input[name=s]', 'Deneme-12345');
  await T.click('button[type=submit]');
  check('Öğretmen girişi → panel', await until(T, () => /Deneme Öğrenci/.test(document.body.innerText)));
  await shot(T, 'ogretmen-panel');

  // 2) link + PIN
  await T.click('button[data-link]');
  await until(T, () => document.querySelector('#lpin')?.value?.length === 6);
  const link = await T.inputValue('#lurl'), pin = await T.inputValue('#lpin');
  check('Link ve 6 haneli PIN üretildi', /#\/o\/[A-Za-z0-9_-]{43}$/.test(link) && /^\d{6}$/.test(pin), link.replace(/o\/.+/, 'o/…'));
  await shot(T, 'link-penceresi');
  await T.click('#kapat');
  check('Erişim durumu "henüz girmedi"', await until(T, () => /henüz girmedi/.test(document.body.innerText)));

  // 2b) Teşhis Defteri'nden gelen bağlantı öğrenciyi seçili getirir
  const sid = await T.getAttribute('select[name=s] option', 'value');
  await T.goto(`${U}/#/?ogr=${sid}`);
  check('Teşhis bağlantısı (#/?ogr=) öğrenciyi seçili getirir', await until(T, id => document.querySelector('select[name=s]')?.value === id && /seçildi/.test(document.querySelector('#md')?.textContent || '') && location.hash === '#/', sid));

  // 3) ders planla (varsayılan: 10 dk sonra)
  await T.click('#fd button[type=submit]');
  check('Ders planlandı', await until(T, () => document.querySelectorAll('#dersler tr[data-id]').length === 1));
  const dersId = await T.getAttribute('#dersler tr[data-id]', 'data-id');

  // 4) öğrenci linki açar, token adres çubuğundan silinir
  await S.goto(link);
  await until(S, () => !!document.querySelector('input[name=pin]'));
  check('Token adres çubuğundan silindi', !/\/o\//.test(S.url()), S.url());
  await shot(S, 'ogrenci-pin');
  const wrong = pin === '000000' ? '111111' : '000000';
  await S.fill('input[name=pin]', wrong); await S.click('button[type=submit]');
  check('Yanlış PIN: hata ve kalan hak', await until(S, () => /kalan deneme: 4/.test(document.querySelector('#m')?.textContent || '')));
  await S.fill('input[name=pin]', pin); await S.click('button[type=submit]');
  check('Doğru PIN → öğrenci defteri, ders görünür', await until(S, () => /Derslerim/.test(document.body.innerText) && !!document.querySelector('a[href^="#/ders/"]')));
  await shot(S, 'ogrenci-defter');
  const sAuth = await S.evaluate(() => JSON.parse(localStorage.getItem('birebir-oturum') || '{}'));
  check('Öğrenci oturumu: rol ogrenci, e-postası sistem adresi', sAuth?.user?.app_metadata?.rol === 'ogrenci' && /@ogrenci\.ders\.muhsinengin\.com$/.test(sAuth?.user?.email || ''));

  // 5) iki taraf derse girer
  await T.click(`a[href="#/ders/${dersId}"]`);
  await until(T, () => !!window.__board, null, 15000);
  await S.click(`a[href="#/ders/${dersId}"]`);
  check('Öğrenciye kayıt onayı sorulur', await until(S, () => document.querySelector('#onay')?.open === true));
  await shot(S, 'ogrenci-kayit-onayi');
  await S.click('#onay button[data-o="1"]');
  check('Öğretmen onayı görür', await until(T, () => /onayı verildi/.test(document.querySelector('#kayit')?.textContent || ''), null, 15000));
  const dc = await until(T, () => window.__board.dcOpen(), null, 20000) && await until(S, () => window.__board.dcOpen(), null, 20000);
  check('Yetkili kanal üzerinden WebRTC kuruldu (veri kanalı açık)', dc);

  // 6) çizim ve PDF
  await T.evaluate(() => window.__board.synth(3, 7, 500, 80));
  const hashT = await T.evaluate(() => window.__board.hash());
  check('Öğretmen çizimi öğrenciye ulaştı', await until(S, h => window.__board.hash() === h, hashT));
  const P = await (await browser.newContext()).newPage();
  await P.setContent('<h1 style="font:40px serif;margin:80px">Soru 1: 2x + 3 = 11 ise x kaçtır?</h1>');
  await P.pdf({ path: 'test/ciktilar/ornek.pdf', format: 'A4' });
  await T.setInputFiles('#pdf', 'test/ciktilar/ornek.pdf');
  check('PDF yüklendi (özel kovaya)', await until(T, () => /PDF sayfası eklendi/.test(window.__board.notice()), null, 30000), await T.evaluate(() => window.__board.notice()));
  await until(S, p => window.__board.page() === p, await T.evaluate(() => window.__board.page()));
  const imgOk = await until(S, () => window.__board.imagesReady(), null, 15000);
  const dark = await S.evaluate(() => { const px = window.__board.pixels(); let d = 0; for (let i = 2; i < px.length; i++) if (px[i] < 128) d++; return d / (px.length - 2); });
  check('Öğrenci PDF sayfasını imzalı adresle gördü', imgOk && dark > 0.001, `koyu piksel ${(dark * 100).toFixed(2)}%`);
  await S.evaluate(() => { window.__board.setTool('kalem'); });
  await S.evaluate(() => window.__board.synth(2, 9, 400, 80));
  await until(T, h => window.__board.hash() === h, await S.evaluate(() => window.__board.hash()));
  await shot(T, 'ders-ogretmen'); await shot(S, 'ders-ogrenci');

  // 7) kalıcı tahta: öğretmen kaydeder, sayfayı yeniler, durum geri gelir
  await T.evaluate(() => window.__saveBoard());
  const before = await T.evaluate(() => window.__board.hash());
  await T.reload();
  await until(T, () => !!window.__board && window.__board.synced(), null, 20000);
  check('Öğretmen sayfayı yenileyince tahta geri geldi', await until(T, h => window.__board.hash() === h, before, 10000));
  // öğrenci tek başına (öğretmen yokken) yenilerse kayıttan yükler
  await T.goto('about:blank');
  await S.reload();
  await until(S, () => !!window.__board, null, 15000);
  check('Öğrenci tek başınayken yenileyince tahta kayıttan yüklendi', await until(S, h => window.__board.hash() === h, before, 15000));

  // 8) yetkisiz erişim
  const ctxX = await browser.newContext(); const X = await ctxX.newPage();
  await X.goto(U + '/');
  await X.fill('input[name=e]', 'baska@test.local'); await X.fill('input[name=s]', 'Deneme-12345'); await X.click('button[type=submit]');
  await until(X, () => /Dersler/.test(document.body.innerText));
  const xList = await X.evaluate(() => document.body.innerText);
  check('Başka öğretmen bu öğrenciyi ve dersi görmez', !/Deneme Öğrenci/.test(xList));
  await X.goto(`${U}/#/ders/${dersId}`);
  check('Başka öğretmen ders odasını açamaz', await until(X, () => /Ders bulunamadı/.test(document.body.innerText)));
  const xtok = await X.evaluate(() => JSON.parse(localStorage.getItem('birebir-oturum')).access_token);
  const red = await new Promise(res => {
    const ws = new WebSocket(`ws://localhost:8800/ws?token=${xtok}`);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'join', topic: `ders:${dersId}` })));
    ws.on('message', m => res(JSON.parse(m).type));
    setTimeout(() => res('zaman aşımı'), 5000);
  });
  check('Başka öğretmen ders kanalına katılamaz', red === 'error', red);

  // 9) öğretmen erişimi kapatır → öğrenci dersleri göremez
  await T.goto(U + '/'); await until(T, () => !!document.querySelector('button[data-kes]'));
  T.once('dialog', d => d.accept());
  await T.click('button[data-kes]');
  check('Erişim kapatıldı', await until(T, () => /İptal edildi/.test(document.body.innerText)));
  await S.goto(U + '/');
  check('Erişimi kapatılan öğrenci defteri göremez', await until(S, () => /Öğretmen girişi/.test(document.body.innerText)));

  // 10) dersi bitir
  await T.goto(`${U}/#/ders/${dersId}`);
  await until(T, () => !!document.querySelector('#bitir'));
  T.once('dialog', d => d.accept());
  await T.click('#bitir');
  check('Ders bitirildi', await until(T, () => /Bitti/.test(document.body.innerText), null, 10000));
  check('Sayfa hatası yok', errs.length === 0, errs.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  stack.kill();
}
const ozet = `${results.filter(r => r.sonuc === 'geçti').length} / ${results.length} geçti`;
writeFileSync('test/ciktilar/e2e-sonuc.json', JSON.stringify({ tarih: new Date().toISOString(), not: 'Yerel yığın: gerçek PostgreSQL + migration 001 + PostgREST; Auth/Storage/Realtime yerel taklit. Gerçek Supabase ile denenmedi.', ozet, testler: results }, null, 2));
console.log(ozet);
process.exit(0);
