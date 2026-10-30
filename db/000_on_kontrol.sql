-- Ön kontrol (yalnız okur, hiçbir şeyi değiştirmez). Migration 001'den ÖNCE çalıştırılır; çıktı ajana verilir.
select json_build_object(
  'fonksiyonlar', (select json_agg(json_build_object('ad', p.proname, 'tanim', pg_get_functiondef(p.oid)))
                     from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('yonetici_mi', 'kitap_yetki')),
  'yoneticiler_sutunlari', (select json_agg(column_name) from information_schema.columns
                             where table_schema = 'public' and table_name = 'yoneticiler'),
  'pgcrypto_semasi', (select extnamespace::regnamespace::text from pg_extension where extname = 'pgcrypto'),
  'realtime_messages_var', to_regclass('realtime.messages') is not null,
  'bl_kovasi_var', exists (select 1 from storage.buckets where id = 'bl-ders'),
  'bl_tablosu_var', exists (select 1 from pg_tables where schemaname = 'public' and tablename like 'bl\_%'),
  'bl_fonksiyonu_var', exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname like 'bl\_%'),
  'tum_tablolar_rls', (select json_agg(json_build_object('t', relname, 'rls', relrowsecurity) order by relname)
                         from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r')
) as on_kontrol;
