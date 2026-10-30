// RLS ve RPC testleri: geçici PostgreSQL + Supabase taklidi üzerinde migration 001.
// Çalıştırma: node db/test/rls.test.mjs  (PGHOST/PGPORT ortam değişkenleri, veritabanı: bltest)
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const { Client } = createRequire(import.meta.url)('pg');

const dir = new URL('..', import.meta.url).pathname;
const admin = new Client({ host: process.env.PGHOST || '/var/lib/postgresql/bltest', port: Number(process.env.PGPORT || 54329), user: 'postgres', database: 'postgres' });
await admin.connect();
await admin.query('drop database if exists bltest_rls');
await admin.query('create database bltest_rls');
await admin.end();
const db = new Client({ host: process.env.PGHOST || '/var/lib/postgresql/bltest', port: Number(process.env.PGPORT || 54329), user: 'postgres', database: 'bltest_rls' });
await db.connect();
for (const f of ['test/supabase_mock.sql', 'test/teshis_mevcut.sql', '001_birebir.sql']) await db.query(readFileSync(dir + f, 'utf8'));

let pass = 0, fail = 0; const failures = [];
function ok(name, cond, extra = '') { if (cond) { pass++; console.log('✓', name); } else { fail++; failures.push(name); console.log('✗', name, extra); } }

/** Bir kimlikle sorgu çalıştırır. who: {uid, role, ogrenci, anonim} ya da 'anon' / 'service' */
async function as(who, sql, params = [], topic = null) {
  await db.query('begin');
  try {
    if (who === 'anon') { await db.query(`select set_config('request.jwt.claims', '{"role":"anon"}', true)`); await db.query('set local role anon'); }
    else if (who === 'service') { await db.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`); await db.query('set local role service_role'); }
    else {
      const claims = { sub: who.uid, role: 'authenticated', app_metadata: who.ogrenci ? { rol: 'ogrenci' } : {}, ...(who.anonim ? { is_anonymous: true } : {}) };
      await db.query(`select set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
      await db.query('set local role authenticated');
    }
    if (topic) await db.query(`select set_config('realtime.topic', $1, true)`, [topic]);
    const r = await db.query(sql, params);
    await db.query('commit');
    return { rows: r.rows, count: r.rowCount };
  } catch (e) { await db.query('rollback'); return { error: e.message }; }
}
const su = (sql, p = []) => db.query(sql, p);

// ----- kurulum -----
const A0 = randomUUID(), T1 = randomUUID(), T2 = randomUUID(), T3 = randomUUID(), T4 = randomUUID(), U1 = randomUUID(), U2 = randomUUID(), X = randomUUID();
for (const u of [A0, T1, T2, T3, T4, U1, U2, X]) await su('insert into auth.users(id) values ($1)', [u]);
await su('insert into public.yoneticiler values ($1)', [A0]);
const t1 = { uid: T1 }, t2 = { uid: T2 }, t3 = { uid: T3 }, t4 = { uid: T4 }, a0 = { uid: A0 };
const u1 = { uid: U1, ogrenci: true }, u1plain = { uid: U1 }, anonUser = { uid: X, anonim: true };

// ===== 1) Mevcut teşhis akışı bozulmadı =====
let r = await as(t1, `insert into public.teshis_students(name) values ('Ali T.') returning id`);
const s1 = r.rows?.[0]?.id; ok('Teşhis: öğretmen öğrenci ekler', !!s1, r.error);
r = await as(t2, `insert into public.teshis_students(name) values ('Ece K.') returning id`); const s2 = r.rows?.[0]?.id;
r = await as(t3, `insert into public.teshis_students(name) values ('Can') returning id`); const s3t = r.rows?.[0]?.id;
ok('Teşhis: birebir üyesi olmayan öğretmen de teşhisi kullanmaya devam eder', !!s3t, r.error);
r = await as(t1, `insert into public.teshis_links(token, student_id, topic) values ('tok-1', $1, 'TM01')`, [s1]);
ok('Teşhis: öğretmen link oluşturur', !r.error, r.error);
r = await as('anon', `select public.teshis_submit('tok-1', 'TM01', 'Ali', '["A","B",""]'::jsonb, '[10,20,5]'::jsonb, 35) as s`);
ok('Teşhis: hesapsız öğrenci teshis_submit ile gönderir', r.rows?.[0]?.s === 'ok', r.error);
r = await as(t1, `select count(*)::int n from public.teshis_attempts`);
ok('Teşhis: öğretmen sonucu görür', r.rows?.[0]?.n === 1, JSON.stringify(r));
r = await as(t2, `select count(*)::int n from public.teshis_students`);
ok('Teşhis: başka öğretmen bu öğrenciyi görmez', r.rows?.[0]?.n === 1);

// ===== 2) Öğrenci ve anonim oturumlar teşhis tablolarına erişemez =====
r = await as(u1, `insert into public.teshis_students(teacher_id, name) values ($1, 'spam')`, [U1]);
ok('Öğrenci hesabı teshis_students tablosuna yazamaz', !!r.error);
r = await as(anonUser, `insert into public.teshis_students(teacher_id, name) values ($1, 'spam')`, [X]);
ok('Anonim oturum teshis_students tablosuna yazamaz', !!r.error);
await su(`insert into public.teshis_students(id, teacher_id, name) values (gen_random_uuid(), $1, 'kendi')`, [U1]);
r = await as(u1, `select count(*)::int n from public.teshis_students`);
ok('Öğrenci hesabı kendi teacher_id\'li satırı bile okuyamaz', r.rows?.[0]?.n === 0);

// ===== 3) Öğretmen kaydı yalnız yönetici =====
r = await as(t1, `insert into public.bl_ogretmenler(user_id, ad) values ($1, 'Ben')`, [T1]);
ok('Öğretmen kendini birebir öğretmeni yapamaz', !!r.error);
r = await as(a0, `insert into public.bl_ogretmenler(user_id, ad) values ($1, 'Muhsin'), ($2, 'Ayşe'), ($3, 'Askıda')`, [T1, T2, T4]);
ok('Yönetici öğretmen ekler', !r.error, r.error);
r = await as(a0, `update public.bl_ogretmenler set durum = 'askida' where user_id = $1`, [T4]);
r = await as(t1, `select count(*)::int n from public.bl_ogretmenler`);
ok('Öğretmen yalnız kendi satırını görür', r.rows?.[0]?.n === 1);

// ===== 4) Defter linki + PIN =====
r = await as(t1, `select public.bl_ogrenci_linki_olustur($1) as j`, [s1]);
const link1 = r.rows?.[0]?.j; ok('Öğretmen kendi öğrencisine link + PIN üretir', link1?.token?.length === 43 && /^[0-9]{6}$/.test(link1?.pin), r.error);
r = await as(t1, `select public.bl_ogrenci_linki_olustur($1) as j`, [s2]);
ok('Başka öğretmenin öğrencisine link üretilemez', !!r.error);
r = await as(t3, `select public.bl_ogrenci_linki_olustur($1) as j`, [s3t]);
ok('Birebir üyesi olmayan öğretmen link üretemez', !!r.error);
r = await as(t4, `select public.bl_ogrenci_linki_olustur($1) as j`, [s1]);
ok('Askıdaki öğretmen link üretemez', !!r.error);
r = await as(t1, `select * from public.bl_ogrenci_erisim`);
ok('Öğretmen erişim tablosunu (özetleri) doğrudan okuyamaz', !!r.error);
r = await as(t1, `select * from public.bl_erisim_durumlari()`);
ok('Öğretmen erişim durumunu fonksiyonla görür, özet sütunu yok', r.rows?.length === 1 && !('token_hash' in r.rows[0]) && r.rows[0].durum === 'aktif', r.error);

// ===== 5) Doğrulama yalnız sunucuda, PIN kilidi =====
r = await as(t1, `select public.bl_ogrenci_dogrula($1, $2) j`, [link1.token, link1.pin]);
ok('Öğretmen oturumu doğrulama fonksiyonunu çağıramaz', !!r.error);
r = await as('anon', `select public.bl_ogrenci_dogrula($1, $2) j`, [link1.token, link1.pin]);
ok('Anonim istek doğrulama fonksiyonunu çağıramaz', !!r.error);
const wrong = link1.pin === '000000' ? '111111' : '000000';
let last;
for (let i = 1; i <= 4; i++) last = (await as('service', `select public.bl_ogrenci_dogrula($1, $2) j`, [link1.token, wrong])).rows[0].j;
ok('4 hatalı PIN: reddedilir, kalan hak 1', last.ok === false && last.kalan === 1, JSON.stringify(last));
last = (await as('service', `select public.bl_ogrenci_dogrula($1, $2) j`, [link1.token, wrong])).rows[0].j;
last = (await as('service', `select public.bl_ogrenci_dogrula($1, $2) j`, [link1.token, link1.pin])).rows[0].j;
ok('5. hatadan sonra doğru PIN de 15 dk kilitli', last.ok === false && last.bekle_dk >= 14, JSON.stringify(last));
await su(`update public.bl_ogrenci_erisim set kilit_bitis = now() - interval '1 second' where student_id = $1`, [s1]);
last = (await as('service', `select public.bl_ogrenci_dogrula($1, $2) j`, [link1.token, link1.pin])).rows[0].j;
ok('Kilit bitince doğru PIN kabul edilir', last.ok === true && last.student_id === s1 && last.auth_user_id === null, JSON.stringify(last));
last = (await as('service', `select public.bl_ogrenci_dogrula($1, $2) j`, ['yanlis-token', link1.pin])).rows[0].j;
ok('Yanlış token aynı genel hatayı verir', last.ok === false && last.hata === 'Geçersiz link ya da PIN');
r = await as('service', `select public.bl_ogrenci_hesap_bagla($1, $2)`, [s1, U1]);
ok('Sunucu sistem hesabını öğrenciye bağlar', !r.error, r.error);
r = await as('service', `select public.bl_ogrenci_hesap_bagla($1, $2)`, [s1, U2]);
ok('Bağlı öğrenciye ikinci hesap bağlanamaz', !!r.error);

// ===== 6) Öğrenci kimliği =====
r = await as(u1, `select public.bl_ben() j`);
ok('Öğrenci hesabı kendini öğrenci olarak görür', r.rows?.[0]?.j?.rol === 'ogrenci' && r.rows[0].j.student_id === s1, JSON.stringify(r));
r = await as(u1plain, `select public.bl_ben() j`);
ok('Öğrenci rolü JWT\'de yoksa öğrenci sayılmaz', r.rows?.[0]?.j?.rol === null);
r = await as(t1, `select public.bl_ben() j`);
ok('Öğretmen kendini öğretmen olarak görür', r.rows?.[0]?.j?.rol === 'ogretmen');

// ===== 7) Dersler =====
r = await as(t1, `insert into public.bl_dersler(student_id, baslangic) values ($1, now() + interval '1 day') returning id`, [s1]);
const d1 = r.rows?.[0]?.id; ok('Öğretmen kendi öğrencisine ders planlar', !!d1, r.error);
r = await as(t1, `insert into public.bl_dersler(student_id, baslangic) values ($1, now()) returning id`, [s2]);
ok('Başka öğretmenin öğrencisine ders planlanamaz', !!r.error);
r = await as(t3, `insert into public.bl_dersler(student_id, baslangic) values ($1, now()) returning id`, [s3t]);
ok('Birebir üyesi olmayan öğretmen ders planlayamaz', !!r.error);
r = await as(t2, `insert into public.bl_dersler(student_id, baslangic) values ($1, now()) returning id`, [s2]);
const d2 = r.rows?.[0]?.id;
r = await as(t2, `select count(*)::int n from public.bl_dersler`);
ok('Öğretmen başka öğretmenin dersini görmez', r.rows?.[0]?.n === 1);
r = await as(u1, `select id from public.bl_dersler`);
ok('Öğrenci yalnız kendi dersini görür', r.rows?.length === 1 && r.rows[0].id === d1, JSON.stringify(r));
r = await as(u1, `update public.bl_dersler set sure_dk = 15 where id = $1`, [d1]);
ok('Öğrenci dersi değiştiremez', r.count === 0 || !!r.error);
r = await as(u1, `insert into public.bl_dersler(teacher_id, student_id, baslangic) values ($1, $2, now())`, [T1, s1]);
ok('Öğrenci ders ekleyemez', !!r.error);

// ===== 8) Kayıt onayı =====
r = await as(t1, `update public.bl_dersler set kayit_onay = 'verildi' where id = $1`, [d1]);
ok('Öğretmen kayıt onayını kendisi veremez', !!r.error);
r = await as(t1, `insert into public.bl_dersler(student_id, baslangic, kayit_onay) values ($1, now(), 'verildi')`, [s1]);
ok('Ders onaylı olarak oluşturulamaz', !!r.error);
r = await as(u1, `select public.bl_kayit_onayi($1, true)`, [d1]);
r = await as(t1, `select kayit_onay from public.bl_dersler where id = $1`, [d1]);
ok('Öğrenci onay verir, öğretmen görür', r.rows?.[0]?.kayit_onay === 'verildi', JSON.stringify(r));
r = await as(u1, `select public.bl_kayit_onayi($1, true)`, [d2]);
ok('Öğrenci başkasının dersine onay veremez', !!r.error);
r = await as(t1, `update public.bl_dersler set kayit_onay = 'sorulmadi' where id = $1`, [d1]);
ok('Öğretmen onayı sıfırlayabilir (yeniden sorma)', !r.error && r.count === 1, r.error);

// ===== 9) Storage =====
r = await as(t1, `insert into storage.objects(bucket_id, name) values ('bl-ders', $1)`, [`${d1}/sayfa-1.png`]);
ok('Öğretmen kendi dersine dosya yükler', !r.error, r.error);
r = await as(t2, `insert into storage.objects(bucket_id, name) values ('bl-ders', $1)`, [`${d1}/x.png`]);
ok('Başka öğretmen bu derse dosya yükleyemez', !!r.error);
r = await as(u1, `select count(*)::int n from storage.objects where bucket_id = 'bl-ders'`);
ok('Öğrenci dersin dosyasını görür', r.rows?.[0]?.n === 1);
r = await as(u1, `insert into storage.objects(bucket_id, name) values ('bl-ders', $1)`, [`${d1}/y.png`]);
ok('Öğrenci dosya yükleyemez (Aşama 1)', !!r.error);
r = await as(t2, `select count(*)::int n from storage.objects where bucket_id = 'bl-ders'`);
ok('Başka öğretmen dosyayı görmez', r.rows?.[0]?.n === 0);
r = await as(t1, `insert into storage.objects(bucket_id, name) values ('bl-ders', 'gecersiz/yol.png')`);
ok('Geçersiz yol reddedilir', !!r.error);

// ===== 10) Realtime =====
const rt = async (who, topic) => ({
  dinle: (await as(who, `select count(*)::int n from realtime.messages`, [], topic)),
  gonder: (await as(who, `insert into realtime.messages(topic, extension, payload) values ($1, 'broadcast', '{}')`, [topic], topic)),
});
let x = await rt(t1, `ders:${d1}`);
ok('Öğretmen ders kanalına gönderir', !x.gonder.error, x.gonder.error);
x = await rt(u1, `ders:${d1}`);
ok('Öğrenci ders kanalına gönderir ve dinler', !x.gonder.error && x.dinle.rows?.[0]?.n >= 1, JSON.stringify(x));
x = await rt(t2, `ders:${d1}`);
ok('Başka öğretmen kanala gönderemez ve dinleyemez', !!x.gonder.error && x.dinle.rows?.[0]?.n === 0);
x = await rt(t1, 'ders:bozuk');
ok('Bozuk kanal adı reddedilir', !!x.gonder.error);
x = await rt('anon', `ders:${d1}`);
ok('Anonim istek kanala gönderemez', !!x.gonder.error);

// ===== 11) İptal ve yeni link =====
r = await as(t1, `select public.bl_ogrenci_linki_iptal($1)`, [s1]);
r = await as(u1, `select count(*)::int n from public.bl_dersler`);
ok('Link iptal edilince öğrenci dersleri anında göremez', r.rows?.[0]?.n === 0);
x = await rt(u1, `ders:${d1}`);
ok('Link iptal edilince öğrenci kanala gönderemez', !!x.gonder.error);
r = await as(t1, `select public.bl_ogrenci_linki_olustur($1) as j`, [s1]);
const link2 = r.rows?.[0]?.j;
last = (await as('service', `select public.bl_ogrenci_dogrula($1, $2) j`, [link1.token, link1.pin])).rows[0].j;
ok('Yeni link üretilince eski link geçersiz', last.ok === false);
last = (await as('service', `select public.bl_ogrenci_dogrula($1, $2) j`, [link2.token, link2.pin])).rows[0].j;
ok('Yeni link çalışır ve aynı sistem hesabı korunur', last.ok === true && last.auth_user_id === U1, JSON.stringify(last));
r = await as(u1, `select count(*)::int n from public.bl_dersler`);
ok('Yeni linkten sonra öğrenci derslerini yine görür', r.rows?.[0]?.n === 1);

// ===== 12) Ders iptali, sınır, denetim =====
await as(t1, `update public.bl_dersler set durum = 'iptal' where id = $1`, [d1]);
x = await rt(u1, `ders:${d1}`);
ok('İptal edilen dersin kanalı kapanır', !!x.gonder.error);
await as(a0, `update public.bl_ogretmenler set max_ogrenci = 1 where user_id = $1`, [T1]);
r = await as(t1, `insert into public.teshis_students(name) values ('Üçüncü') returning id`);
r = await as(t1, `select public.bl_ogrenci_linki_olustur($1) as j`, [r.rows[0].id]);
ok('Öğrenci sınırı aşılmaz', !!r.error && /sınır/.test(r.error), r.error);
r = await as(t1, `select islem from public.bl_denetim order by id`);
ok('Öğretmen kendi denetim kayıtlarını görür', r.rows?.some(z => z.islem === 'ogrenci_linki_iptal'));
r = await as(t2, `select count(*)::int n from public.bl_denetim`);
ok('Başka öğretmen bu denetim kayıtlarını görmez', r.rows?.[0]?.n === 0);
r = await as(t1, `insert into public.bl_denetim(islem) values ('sahte')`);
ok('Denetim kaydı elle yazılamaz', !!r.error);
r = await as('anon', `select count(*) from public.bl_dersler`);
ok('Anonim istek ders tablosunu okuyamaz', !!r.error || r.rows?.[0]?.count === '0');

// ===== 13) Geri alma betiği ve tekrar uygulama =====
await db.query(readFileSync(dir + '001_birebir_geri.sql', 'utf8'));
r = await su(`select count(*)::int n from pg_tables where schemaname = 'public' and tablename like 'bl\\_%'`);
const pol = await su(`select count(*)::int n from pg_policies where policyname like 'bl\\_%' or policyname like '%ogrenci_degil'`);
const tes = await su(`select count(*)::int n from public.teshis_attempts`);
ok('Geri alma: bl_ tabloları ve politikaları gitti, teşhis verisi duruyor', r.rows[0].n === 0 && pol.rows[0].n === 0 && tes.rows[0].n === 1);
await db.query(readFileSync(dir + '001_birebir.sql', 'utf8'));
r = await as(t1, `select count(*)::int n from public.teshis_students`);
ok('Tekrar uygulama sorunsuz; teşhis erişimi sürüyor', r.rows?.[0]?.n >= 2, JSON.stringify(r));

await db.end();
console.log(`\n${pass} geçti, ${fail} kaldı`);
if (fail) { console.log('Kalanlar:', failures.join(' | ')); process.exit(1); }
