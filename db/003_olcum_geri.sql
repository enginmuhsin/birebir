-- Birebir migration 003 (Ders Ölçümü) geri alma. 001'in tablolarına ve teshis_* verisine dokunmaz.
-- DİKKAT: soru bankası, testler, ölçümler ve cevaplar silinir. Önce yedek alın.
-- 'bl-sekiller' kovasındaki dosyalar SQL ile silinmez; gerekirse Supabase panelinde Storage'dan elle silinir.
begin;

drop policy if exists bl_sekil_oku      on storage.objects;
drop policy if exists bl_sekil_ekle     on storage.objects;
drop policy if exists bl_sekil_guncelle on storage.objects;
drop policy if exists bl_sekil_sil      on storage.objects;

drop table if exists public.bl_olcum_cevaplar, public.bl_olcumler, public.bl_testler,
  public.bl_madde_anahtar, public.bl_maddeler cascade;

drop function if exists public.bl_olcum_raporu(uuid, text), public.bl_olcum_gonder(uuid, jsonb, int),
  public.bl_olcum_sorulari(uuid), public.bl_olcumlerim(), public.bl_olcum_kagit(uuid, jsonb, int),
  public.bl_olcum_kapat(uuid), public.bl_olcum_ac(uuid, uuid, uuid), public.bl_olcum_puanla(uuid, jsonb, int, text),
  public.bl_testler_kilit(), public.bl_testler_tetik(), public.bl_sekil_gorebilir(text);

delete from public.bl_denetim where islem in ('olcum_ac', 'olcum_kagit', 'olcum_gonder');

commit;
