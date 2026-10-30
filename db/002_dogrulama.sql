-- Migration 001'den sonra (yalnız okur): beklenen sonuç 4 tablo, 15 politika, kova var, öğretmen listesinde sen.
select json_build_object(
  'tablolar', (select json_agg(tablename order by tablename) from pg_tables where schemaname = 'public' and tablename like 'bl\_%'),
  'politika_sayisi', (select count(*) from pg_policies where policyname like 'bl\_%' or policyname like '%\_ogrenci\_degil'),
  'kova', exists (select 1 from storage.buckets where id = 'bl-ders'),
  'fonksiyon_sayisi', (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'bl\_%'),
  'ogretmenler', (select json_agg(ad) from public.bl_ogretmenler)
) as dogrulama;
