import { test } from 'node:test';
import assert from 'node:assert/strict';
import { girisYap, type Deps } from '../supabase/functions/bl-ogrenci-giris/giris.js';

function fake(over: Partial<Deps> & { dogrulaSonuc?: any } = {}) {
  const calls: string[] = [];
  const deps: Deps = {
    dogrula: async () => over.dogrulaSonuc ?? { ok: true, student_id: 'S1', auth_user_id: null, ad: 'Ali' },
    hesapBagla: async (s, u) => { calls.push(`bagla:${s}:${u}`); },
    hesapOlustur: async (e, _p, s) => { calls.push(`olustur:${e}:${s}`); return 'U1'; },
    hesapGuncelle: async (u, _p, s) => { calls.push(`guncelle:${u}:${s}`); },
    oturumAc: async (e, p) => { calls.push(`oturum:${e}:${p.length}`); return { access_token: 'AT', refresh_token: 'RT', expires_at: 1 }; },
    rastgele: () => 'x'.repeat(43),
    ...over,
  };
  return { deps, calls };
}

test('biçimsiz PIN sunucuya gitmeden reddedilir', async () => {
  let called = false;
  const { deps } = fake({ dogrula: async () => { called = true; return {}; } });
  for (const pin of ['12345', '1234567', 'abcdef', '']) assert.equal((await girisYap(deps, { token: 't', pin })).status, 400);
  assert.equal((await girisYap(deps, null)).status, 400);
  assert.equal(called, false);
});

test('ilk giriş: sistem hesabı açılır, öğrenciye bağlanır, oturum döner', async () => {
  const { deps, calls } = fake();
  const r = await girisYap(deps, { token: 'tok', pin: '123456' });
  assert.equal(r.status, 200);
  assert.deepEqual(calls, ['olustur:s-S1@ogrenci.ders.muhsinengin.com:S1', 'bagla:S1:U1', 'oturum:s-S1@ogrenci.ders.muhsinengin.com:43']);
  assert.equal(r.body.access_token, 'AT');
  assert.equal(r.body.ad, 'Ali');
  assert.equal('password' in r.body, false);
});

test('sonraki giriş: hesap yeniden kullanılır, yeni şifre atanır', async () => {
  const { deps, calls } = fake({ dogrulaSonuc: { ok: true, student_id: 'S1', auth_user_id: 'U9', ad: 'Ali' } });
  const r = await girisYap(deps, { token: 'tok', pin: '123456' });
  assert.equal(r.status, 200);
  assert.deepEqual(calls.slice(0, 1), ['guncelle:U9:S1']);
  assert.equal(calls.some(c => c.startsWith('olustur')), false);
});

test('hatalı PIN 401 ve kalan hak; kilit 429 ve bekleme süresi', async () => {
  let r = await girisYap(fake({ dogrulaSonuc: { ok: false, hata: 'Geçersiz link ya da PIN', kalan: 2 } }).deps, { token: 't', pin: '000000' });
  assert.equal(r.status, 401); assert.equal(r.body.kalan, 2);
  r = await girisYap(fake({ dogrulaSonuc: { ok: false, hata: 'Çok fazla hatalı deneme.', bekle_dk: 12 } }).deps, { token: 't', pin: '000000' });
  assert.equal(r.status, 429); assert.equal(r.body.bekle_dk, 12);
});
