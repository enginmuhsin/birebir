-- Birebir migration 001'in geri alınması. teshis_* tablolarının verisine ve mevcut politikalarına dokunmaz.
-- DİKKAT: bl_ tablolarındaki dersler, öğrenci linkleri ve denetim kayıtları silinir.
-- 'bl-ders' kovasındaki dosyalar SQL ile silinmez; gerekirse Supabase panelinde Storage'dan elle silinir.
begin;

drop policy if exists bl_ders_kanal_dinle  on realtime.messages;
drop policy if exists bl_ders_kanal_gonder on realtime.messages;
drop policy if exists bl_ders_dosya_oku      on storage.objects;
drop policy if exists bl_ders_dosya_ekle     on storage.objects;
drop policy if exists bl_ders_dosya_guncelle on storage.objects;
drop policy if exists bl_ders_dosya_sil      on storage.objects;

do $$
declare t text;
begin
  foreach t in array array['teshis_students', 'teshis_attempts', 'teshis_plans', 'teshis_links'] loop
    execute format('drop policy if exists %I on public.%I', t || '_ogrenci_degil', t);
  end loop;
end $$;

drop table if exists public.bl_dersler, public.bl_ogrenci_erisim, public.bl_denetim, public.bl_ogretmenler cascade;

drop function if exists public.bl_kayit_onayi(uuid, boolean), public.bl_ben(), public.bl_ogrenci_hesap_bagla(uuid, uuid),
  public.bl_ogrenci_dogrula(text, text), public.bl_erisim_durumlari(), public.bl_ogrenci_linki_iptal(uuid),
  public.bl_ogrenci_linki_olustur(uuid), public.bl_dersler_tetik(), public.bl_derse_erisir(uuid),
  public.bl_ders_ogretmeni(uuid), public.bl_ogrencim(), public.bl_ogretmen_mi(), public.bl_uuid(text),
  public.bl_jwt_ogrenci_mi();

commit;
