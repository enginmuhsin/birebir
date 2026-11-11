-- Migration 003'ten sonra (yalnız okur): beklenen 5 tablo, 5 politika, 10 fonksiyon; öğrenci rolü anahtar tablosunu okuyamaz.
select json_build_object(
  'tablolar', (select json_agg(tablename order by tablename) from pg_tables
                where schemaname = 'public' and tablename in ('bl_maddeler', 'bl_madde_anahtar', 'bl_testler', 'bl_olcumler', 'bl_olcum_cevaplar')),
  'rls_acik', (select bool_and(relrowsecurity) from pg_class
                where relnamespace = 'public'::regnamespace and relname in ('bl_maddeler', 'bl_madde_anahtar', 'bl_testler', 'bl_olcumler', 'bl_olcum_cevaplar')),
  'politika_sayisi', (select count(*) from pg_policies where tablename in ('bl_maddeler', 'bl_madde_anahtar', 'bl_testler', 'bl_olcumler', 'bl_olcum_cevaplar')),
  'fonksiyonlar', (select json_agg(proname order by proname) from pg_proc
                    where pronamespace = 'public'::regnamespace and (proname like 'bl\_olcum%' or proname like 'bl\_testler\_%')),
  'anon_anahtar_yetkisi', has_table_privilege('anon', 'public.bl_madde_anahtar', 'select')
) as dogrulama;
