// Ders Ölçümü (migration 003) güvenlik ve işlev testleri: geçici PostgreSQL + Supabase taklidi.
// Çalıştırma: node db/test/olcum.test.mjs  (PGHOST/PGPORT ortam değişkenleri)
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const { Client } = createRequire(import.meta.url)('pg');

const dir = new URL('..', import.meta.url).pathname;
const baglanti = (database) => new Client({ host: process.env.PGHOST || '/var/lib/postgresql/bltest', port: Number(process.env.PGPORT || 54329), user: 'postgres', database });
const admin = baglanti('postgres'); await admin.connect();
await admin.query('drop database if exists bltest_olcum'); await admin.query('create database bltest_olcum'); await admin.end();
const db = baglanti('bltest_olcum'); await db.connect();
for (const f of ['test/supabase_mock.sql', 'test/teshis_mevcut.sql', '001_birebir.sql', '003_olcum.sql']) await db.query(readFileSync(dir + f, 'utf8'));

let pass = 0, fail = 0; const failures = [];
function ok(name, cond, extra = '') { if (cond) { pass++; console.log('✓', name); } else { fail++; failures.push(name); console.log('✗', name, extra); } }
async function as(who, sql, params = []) {
  await db.query('begin');
  try {
    if (who === 'anon') { await db.query(`select set_config('request.jwt.claims', '{"role":"anon"}', true)`); await db.query('set local role anon'); }
    else {
      const claims = { sub: who.uid, role: 'authenticated', app_metadata: who.ogrenci ? { rol: 'ogrenci' } : {} };
      await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
      await db.query('set local role authenticated');
    }
    const r = await db.query(sql, params); await db.query('commit');
    return { rows: r.rows, count: r.rowCount };
  } catch (e) { await db.query('rollback'); return { error: e.message }; }
}
const su = (sql, p = []) => db.query(sql, p);

// ----- kurulum: 2 öğretmen, öğrencileri, öğrenci hesapları -----
const A0 = randomUUID(), T1 = randomUUID(), T2 = randomUUID(), T3 = randomUUID(), U1 = randomUUID(), U2 = randomUUID();
for (const u of [A0, T1, T2, T3, U1, U2]) await su('insert into auth.users(id) values ($1)', [u]);
await su('insert into public.yoneticiler values ($1)', [A0]);
const t1 = { uid: T1 }, t2 = { uid: T2 }, t3 = { uid: T3 }, u1 = { uid: U1, ogrenci: true }, u2 = { uid: U2, ogrenci: true };
await su(`insert into public.bl_ogretmenler(user_id, ad) values ($1, 'Muhsin'), ($2, 'Ayşe')`, [T1, T2]);
const s1 = (await su(`insert into public.teshis_students(teacher_id, name) values ($1, 'Göknur') returning id`, [T1])).rows[0].id;
const s2 = (await su(`insert into public.teshis_students(teacher_id, name) values ($1, 'Ece') returning id`, [T2])).rows[0].id;
for (const [s, t, u] of [[s1, T1, U1], [s2, T2, U2]])
  await su(`insert into public.bl_ogrenci_erisim(student_id, teacher_id, token_hash, pin_hash, auth_user_id) values ($1, $2, extensions.digest($4, 'sha256'), '\\x00', $3)`, [s, t, u, String(s)]);

// ===== 1) Soru bankası ve anahtar =====
const siklar = JSON.stringify(['16', '20', '22', '24', '28']);
let r = await as(t1, `insert into public.bl_maddeler(kod, kazanim, kok, soru, siklar) values
  ('D3.ON.1', 'K1', 'ABC dik üçgen…', '|BC| = x?', $1), ('D3.ON.2', 'K1', 'kök 2', 'soru 2', $1),
  ('D3.ON.3', 'K2', 'kök 3', 'soru 3', $1), ('D3.SON.1', 'K1', 'kök b1', 'soru b1', $1) returning id, kod`, [siklar]);
ok('Öğretmen soru bankasına madde ekler', r.rows?.length === 4, r.error);
const M = Object.fromEntries((r.rows || []).map(x => [x.kod, x.id]));
r = await as(t1, `insert into public.bl_madde_anahtar(madde_id, dogru, yanilgilar, cozum) values
  ($1, 3, '{"0": "Kenarları çıkardı"}', '5-12-13 × 2'), ($2, 2, '{}', ''), ($3, 1, '{"4": "Kök almadı"}', ''), ($4, 0, '{}', '')`,
  [M['D3.ON.1'], M['D3.ON.2'], M['D3.ON.3'], M['D3.SON.1']]);
ok('Öğretmen anahtar girer', !r.error, r.error);
r = await as(t1, `insert into public.bl_maddeler(kod, kazanim, kok, soru, siklar) values ('X', 'K1', 'k', 's', '["a","b"]')`);
ok('Beş şıktan az olan madde reddedilir', !!r.error);
r = await as(t2, `select count(*)::int n from public.bl_maddeler`);
ok('Başka öğretmen maddeleri görmez', r.rows?.[0]?.n === 0);
r = await as(t2, `select count(*)::int n from public.bl_madde_anahtar`);
ok('Başka öğretmen anahtarları görmez', r.rows?.[0]?.n === 0);
r = await as(t2, `insert into public.bl_madde_anahtar(madde_id, dogru) values ($1, 0)`, [M['D3.ON.1']]);
ok('Başka öğretmen bu maddeye anahtar yazamaz', !!r.error);
r = await as(t3, `insert into public.bl_maddeler(kod, kazanim, kok, soru, siklar) values ('Y', 'K1', 'k', 's', $1)`, [siklar]);
ok('Birebir üyesi olmayan öğretmen madde ekleyemez', !!r.error);

// ===== 2) Test şablonu =====
r = await as(t1, `insert into public.bl_testler(kod, baslik, ders_kodu, tur, maddeler) values ('D3-ON', 'Ders 3 Ön Test', 'D3', 'on', $1) returning id`,
  [[M['D3.ON.1'], M['D3.ON.2'], M['D3.ON.3']]]);
const TON = r.rows?.[0]?.id; ok('Öğretmen test oluşturur', !!TON, r.error);
r = await as(t1, `insert into public.bl_testler(kod, baslik, ders_kodu, tur, maddeler) values ('D3-SON', 'Ders 3 Son Test', 'D3', 'son', $1) returning id`,
  [[M['D3.SON.1']]]);
const TSON = r.rows?.[0]?.id;
r = await as(t1, `insert into public.bl_testler(kod, baslik, ders_kodu, tur, maddeler) values ('ZZ', 'Tekrarlı', 'D3', 'on', $1)`, [[M['D3.ON.1'], M['D3.ON.1']]]);
ok('Aynı soru testte iki kez olamaz', !!r.error);
await su(`insert into public.bl_maddeler(teacher_id, kod, kazanim, kok, soru, siklar) values ($1, 'ANAHTARSIZ', 'K1', 'k', 's', $2)`, [T1, siklar]);
const anahtarsiz = (await su(`select id from public.bl_maddeler where kod = 'ANAHTARSIZ'`)).rows[0].id;
r = await as(t1, `insert into public.bl_testler(kod, baslik, ders_kodu, tur, maddeler) values ('ZZ', 'Eksik', 'D3', 'on', $1)`, [[anahtarsiz]]);
ok('Anahtarı girilmemiş soruyla test kurulamaz', !!r.error);
const yabanci = (await su(`insert into public.bl_maddeler(teacher_id, kod, kazanim, kok, soru, siklar) values ($1, 'Y1', 'K1', 'k', 's', $2) returning id`, [T2, siklar])).rows[0].id;
await su(`insert into public.bl_madde_anahtar(madde_id, dogru) values ($1, 0)`, [yabanci]);
r = await as(t1, `insert into public.bl_testler(kod, baslik, ders_kodu, tur, maddeler) values ('ZZ', 'Yabancı', 'D3', 'on', $1)`, [[yabanci]]);
ok('Başka öğretmenin sorusuyla test kurulamaz', !!r.error);

// ===== 3) Ölçüm açma =====
r = await as(t1, `select public.bl_olcum_ac($1, $2) id`, [s1, TON]);
const O1 = r.rows?.[0]?.id; ok('Öğretmen kendi öğrencisine ön testi açar', !!O1, r.error);
r = await as(t1, `select public.bl_olcum_ac($1, $2) id`, [s2, TON]);
ok('Başka öğretmenin öğrencisine test açılamaz', !!r.error);
r = await as(t2, `select public.bl_olcum_ac($1, $2) id`, [s2, TON]);
ok('Başka öğretmenin testi açılamaz', !!r.error);
r = await as(u1, `select public.bl_olcum_ac($1, $2) id`, [s1, TON]);
ok('Öğrenci kendine test açamaz', !!r.error);
r = await as(t1, `insert into public.bl_olcumler(teacher_id, student_id, test_id) values ($1, $2, $3)`, [T1, s1, TON]);
ok('Ölçüm tabloya doğrudan yazılamaz', !!r.error);

// ===== 4) Öğrenci: soruları anahtarsız görür =====
r = await as(u1, `select * from public.bl_olcumlerim()`);
ok('Öğrenci açık ölçümünü listede görür', r.rows?.length === 1 && r.rows[0].soru_sayi === 3 && r.rows[0].dogru_sayi === null, JSON.stringify(r));
r = await as(u2, `select * from public.bl_olcumlerim()`);
ok('Başka öğrenci bu ölçümü görmez', r.rows?.length === 0, JSON.stringify(r));
r = await as(u1, `select public.bl_olcum_sorulari($1) j`, [O1]);
const j = r.rows?.[0]?.j;
ok('Öğrenci soruları sırayla alır', j?.sorular?.length === 3 && j.sorular[0].kok === 'ABC dik üçgen…', r.error);
ok('Soru paketinde anahtar, çözüm ya da yanılgı yok', !JSON.stringify(j).match(/dogru|cozum|yanilgi|anahtar/));
r = await su(`select baslama from public.bl_olcumler where id = $1`, [O1]);
ok('İlk açılışta başlama zamanı yazılır', !!r.rows[0].baslama);
r = await as(u2, `select public.bl_olcum_sorulari($1) j`, [O1]);
ok('Başka öğrenci bu ölçümün sorularını alamaz', !!r.error);
r = await as(t2, `select public.bl_olcum_sorulari($1) j`, [O1]);
ok('Öğretmen hesabı öğrenci yolundan soru alamaz', !!r.error);
for (const tablo of ['bl_madde_anahtar', 'bl_maddeler', 'bl_testler', 'bl_olcumler', 'bl_olcum_cevaplar']) {
  r = await as(u1, `select count(*)::int n from public.${tablo}`);
  ok(`Öğrenci ${tablo} tablosunu doğrudan okuyamaz`, !!r.error || r.rows?.[0]?.n === 0, JSON.stringify(r));
}
r = await as('anon', `select count(*)::int n from public.bl_madde_anahtar`);
ok('Anonim istek anahtar tablosunu okuyamaz', !!r.error);
r = await as(u1, `select public.bl_olcum_puanla($1, '[]'::jsonb, 0, 'ekran')`, [O1]);
ok('İç puanlama fonksiyonu doğrudan çağrılamaz', !!r.error);

// ===== 5) Gönderim ve sunucuda puanlama =====
r = await as(u1, `select public.bl_olcum_gonder($1, $2::jsonb, 400) j`, [O1, JSON.stringify([
  { sira: 1, cevap: 'D', sure: 120 }, { sira: 2, cevap: 'A', sure: 90 }, { sira: 3, cevap: '' }])]);
ok('Öğrenci gönderir; yanıtta yalnız doğru sayısı', r.rows?.[0]?.j?.dogru === 1 && r.rows[0].j.soru === 3 && Object.keys(r.rows[0].j).length === 2, JSON.stringify(r));
r = await as(u1, `select public.bl_olcum_gonder($1, '[]'::jsonb) j`, [O1]);
ok('İkinci kez gönderilemez', !!r.error);
r = await as(t1, `select sira, cevap, dogru, sure_sn from public.bl_olcum_cevaplar where olcum_id = $1 order by sira`, [O1]);
ok('Puanlama doğru: 1. doğru, 2. yanlış, 3. boş', JSON.stringify(r.rows?.map(x => [x.cevap, x.dogru])) === '[[3,true],[0,false],[null,false]]', JSON.stringify(r));
r = await as(t2, `select count(*)::int n from public.bl_olcum_cevaplar`);
ok('Başka öğretmen cevapları görmez', r.rows?.[0]?.n === 0);
r = await as(u1, `select * from public.bl_olcumlerim()`);
ok('Gönderdikten sonra öğrenci doğru sayısını görür', r.rows?.[0]?.durum === 'gonderildi' && r.rows[0].dogru_sayi === 1);
r = await as(u1, `select public.bl_olcum_gonder($1, $2::jsonb) j`, [O1, JSON.stringify([{ sira: 1, cevap: 'Z' }])]);
ok('Gönderilmiş ölçüme sahte cevap eklenemez', !!r.error);

// Bozuk girdiler
r = await as(t1, `select public.bl_olcum_ac($1, $2) id`, [s1, TON]); const O2 = r.rows[0].id;
r = await as(u1, `select public.bl_olcum_gonder($1, '{"x":1}'::jsonb) j`, [O2]);
ok('Dizi olmayan cevap listesi reddedilir', !!r.error);
r = await as(u1, `select public.bl_olcum_gonder($1, $2::jsonb) j`, [O2, JSON.stringify([{ sira: 1, cevap: 'Q' }, { sira: 99, cevap: 'A' }, { sira: 'x' }])]);
ok('Geçersiz şık ve sıra boş sayılır, hata vermez', r.rows?.[0]?.j?.dogru === 0, JSON.stringify(r));
r = await su(`select count(*) filter (where cevap is null)::int bos from public.bl_olcum_cevaplar where olcum_id = $1`, [O2]);
ok('"Q" gibi geçersiz şık boş olarak kaydedilir', r.rows[0].bos === 3, JSON.stringify(r.rows));
// Boş cevap, anahtarı A olan soruda doğru sayılmamalı (D3.SON.1'in anahtarı A)
r = await as(t1, `select public.bl_olcum_ac($1, $2) id`, [s1, TSON]); const Obos = r.rows[0].id;
r = await as(u1, `select public.bl_olcum_gonder($1, $2::jsonb) j`, [Obos, JSON.stringify([{ sira: 1, cevap: '' }])]);
ok('Boş cevap, anahtarı A olan soruda doğru sayılmaz', r.rows?.[0]?.j?.dogru === 0, JSON.stringify(r));

// ===== 6) Kâğıt cevap, kapatma =====
r = await as(t1, `select public.bl_olcum_ac($1, $2) id`, [s1, TSON]); const O3 = r.rows[0].id;
r = await as(t1, `select public.bl_olcum_kagit($1, $2::jsonb, 600) j`, [O3, JSON.stringify([{ sira: 1, cevap: 'a' }])]);
ok('Öğretmen kâğıt cevabını girer (küçük harf de olur)', r.rows?.[0]?.j?.dogru === 1, JSON.stringify(r));
r = await su(`select kaynak from public.bl_olcumler where id = $1`, [O3]);
ok('Kaynak kâğıt olarak işaretlenir', r.rows[0].kaynak === 'kagit');
r = await as(t2, `select public.bl_olcum_kagit($1, '[]'::jsonb) j`, [O3]);
ok('Başka öğretmen kâğıt cevabı giremez', !!r.error);
r = await as(t1, `select public.bl_olcum_ac($1, $2) id`, [s1, TSON]); const O4 = r.rows[0].id;
r = await as(t1, `select public.bl_olcum_kapat($1)`, [O4]);
r = await as(u1, `select public.bl_olcum_sorulari($1) j`, [O4]);
ok('Kapatılan ölçüm çözülemez', !!r.error);
r = await as(u1, `select count(*)::int n from public.bl_olcumlerim() where id = $1`, [O4]);
ok('Kapatılan ölçüm öğrenci listesinden düşer', r.rows?.[0]?.n === 0);

// ===== 7) Test kilidi =====
r = await as(t1, `update public.bl_testler set maddeler = $1 where id = $2`, [[M['D3.ON.1']], TON]);
ok('Uygulanmış testin soruları değiştirilemez', !!r.error);
r = await as(t1, `update public.bl_testler set baslik = 'Ders 3 · Ön Test' where id = $1`, [TON]);
ok('Uygulanmış testin başlığı değiştirilebilir', !r.error && r.count === 1, r.error);

// ===== 8) Rapor =====
r = await as(t1, `select public.bl_olcum_raporu($1, 'D3') j`, [s1]);
const rp = r.rows?.[0]?.j;
ok('Rapor: öğrenci adı ve gönderilmiş 4 ölçüm', rp?.ogrenci === 'Göknur' && rp.olcumler.length === 4, JSON.stringify(r).slice(0, 300));
const k1on = rp?.kazanimlar?.find(x => x.kazanim === 'K1' && x.tur === 'on');
ok('Rapor: kazanım × tür toplamı (K1 ön: 1/4)', k1on?.dogru === 1 && k1on?.soru === 4, JSON.stringify(rp?.kazanimlar));
const k1son = rp?.kazanimlar?.find(x => x.kazanim === 'K1' && x.tur === 'son');
ok('Rapor: K1 son test 1/2 (kâğıt doğru, ekran boş)', k1son?.dogru === 1 && k1son?.soru === 2, JSON.stringify(k1son));
const s0 = rp?.olcumler?.[0]?.sorular;
ok('Rapor: işaretlenen şık, anahtar ve yanılgı görünür', s0?.[1]?.cevap === 'A' && s0[1].anahtar === 'C' && s0[0].yanilgi === null && s0[0].sure_sn === 120, JSON.stringify(s0));
r = await as(t1, `select public.bl_olcum_raporu($1, 'D3') j`, [s1]);
const yan = (await as(t1, `select public.bl_olcum_raporu($1) j`, [s1])).rows[0].j;
ok('Rapor ders kodu olmadan da çalışır', yan.olcumler.length === 4);
r = await as(t2, `select public.bl_olcum_raporu($1) j`, [s1]);
ok('Başka öğretmen raporu alamaz', !!r.error);
r = await as(u1, `select public.bl_olcum_raporu($1) j`, [s1]);
ok('Öğrenci raporu (anahtarlı) alamaz', !!r.error);

// Yanılgı metni: 1. soruda A işaretlenirse "Kenarları çıkardı"
r = await as(t1, `select public.bl_olcum_ac($1, $2) id`, [s1, TON]); const O5 = r.rows[0].id;
await as(u1, `select public.bl_olcum_gonder($1, $2::jsonb) j`, [O5, JSON.stringify([{ sira: 1, cevap: 'A' }])]);
const rp2 = (await as(t1, `select public.bl_olcum_raporu($1) j`, [s1])).rows[0].j;
ok('Rapor: yanlış şıkkın yanılgısı yazılır', rp2.olcumler.at(-1).sorular[0].yanilgi === 'Kenarları çıkardı', JSON.stringify(rp2.olcumler.at(-1).sorular[0]));

// ===== 9) Link iptali ölçüme erişimi de keser =====
r = await as(t1, `select public.bl_olcum_ac($1, $2) id`, [s1, TSON]); const O6 = r.rows[0].id;
await as(t1, `select public.bl_ogrenci_linki_iptal($1)`, [s1]);
r = await as(u1, `select public.bl_olcum_sorulari($1) j`, [O6]);
ok('Link iptal edilince öğrenci ölçüme erişemez', !!r.error);

// ===== 10) Denetim kaydı =====
r = await su(`select islem from public.bl_denetim where islem like 'olcum%'`);
ok('Ölçüm işlemleri denetime yazılır', ['olcum_ac', 'olcum_gonder', 'olcum_kagit'].every(i => r.rows?.some(x => x.islem === i)), JSON.stringify(r));

// ===== 11) Doğrulama sorgusu, geri alma ve tekrar uygulama =====
const dog = (await su(readFileSync(dir + '004_olcum_dogrulama.sql', 'utf8'))).rows[0].dogrulama;
ok('Doğrulama sorgusu: 5 tablo, RLS açık, 5 politika, 10 fonksiyon, anon anahtarı okuyamaz',
  dog.tablolar.length === 5 && dog.rls_acik && Number(dog.politika_sayisi) === 5 && dog.fonksiyonlar.length === 10 && dog.anon_anahtar_yetkisi === false, JSON.stringify(dog));
const once = (await su(`select count(*)::int n from public.bl_dersler`)).rows[0].n;
await db.query(readFileSync(dir + '003_olcum_geri.sql', 'utf8'));
r = await su(`select count(*)::int n from pg_tables where schemaname = 'public' and tablename in ('bl_maddeler','bl_madde_anahtar','bl_testler','bl_olcumler','bl_olcum_cevaplar')`);
const ogr = await su(`select count(*)::int n from public.teshis_students`);
const ogt = await su(`select count(*)::int n from public.bl_ogretmenler`);
ok('Geri alma: ölçüm tabloları gitti; öğrenciler, öğretmenler, dersler duruyor',
  r.rows[0].n === 0 && ogr.rows[0].n >= 2 && ogt.rows[0].n === 2 && (await su(`select count(*)::int n from public.bl_dersler`)).rows[0].n === once);
await db.query(readFileSync(dir + '003_olcum.sql', 'utf8'));
r = await as(t1, `select count(*)::int n from public.bl_maddeler`);
ok('Tekrar uygulama sorunsuz', r.rows?.[0]?.n === 0, JSON.stringify(r));

await db.end();
console.log(`\n${pass} geçti, ${fail} kaldı`);
if (fail) { console.log('Kalanlar:', failures.join(' | ')); process.exit(1); }
