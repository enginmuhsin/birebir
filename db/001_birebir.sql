-- =====================================================================================
-- Birebir Ders Platformu · migration 001 (Aşama 1)
-- Supabase projesi: teşhis ile ORTAK. teshis_* tablolarının yapısı ve verisi DEĞİŞMEZ;
-- yalnız onlara "öğrenci hesabı ve anonim oturum yazamaz/okuyamaz" kısıtlayıcı politikası eklenir.
-- Tek işlem (transaction) içinde çalışır: bir hata olursa hiçbir şey uygulanmaz.
-- Geri alma: 001_birebir_geri.sql
-- =====================================================================================
begin;

create extension if not exists pgcrypto with schema extensions;

-- -------------------------------------------------------------------------------------
-- 1) Kimlik yardımcıları
--    Öğrenciler e-postasız "sistem hesabı" ile oturum açar (Edge Function bl-ogrenci-giris).
--    Bu hesapların JWT'sinde app_metadata.rol = 'ogrenci' bulunur; app_metadata'yı kullanıcı değiştiremez.
-- -------------------------------------------------------------------------------------
create or replace function public.bl_jwt_ogrenci_mi() returns boolean
language sql stable set search_path = '' as $$
  select coalesce(auth.jwt() -> 'app_metadata' ->> 'rol', '') = 'ogrenci'
      or coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false)
$$;

create or replace function public.bl_uuid(p text) returns uuid
language plpgsql immutable set search_path = '' as $$
begin
  return p::uuid;
exception when others then
  return null;
end $$;

-- -------------------------------------------------------------------------------------
-- 2) teshis_* tablolarına kısıtlayıcı politika: öğrenci/anonim oturumlar bu tablolara erişemez.
--    Öğretmenlerin mevcut erişimi aynen sürer (kısıtlayıcı politika yalnız ek koşuldur).
-- -------------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['teshis_students', 'teshis_attempts', 'teshis_plans', 'teshis_links'] loop
    execute format('drop policy if exists %I on public.%I', t || '_ogrenci_degil', t);
    execute format('create policy %I on public.%I as restrictive for all to authenticated '
                   'using (not public.bl_jwt_ogrenci_mi()) with check (not public.bl_jwt_ogrenci_mi())',
                   t || '_ogrenci_degil', t);
  end loop;
end $$;

-- -------------------------------------------------------------------------------------
-- 3) Tablolar
-- -------------------------------------------------------------------------------------
create table public.bl_ogretmenler (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  ad           text not null check (length(ad) between 1 and 80),
  durum        text not null default 'aktif' check (durum in ('aktif', 'askida')),
  max_ogrenci  int  not null default 30 check (max_ogrenci between 1 and 500),
  olusturma    timestamptz not null default now()
);

create table public.bl_ogrenci_erisim (
  student_id     uuid primary key references public.teshis_students(id) on delete cascade,
  teacher_id     uuid not null,
  token_hash     bytea not null unique,
  pin_hash       bytea not null,
  auth_user_id   uuid unique references auth.users(id) on delete set null,
  durum          text not null default 'aktif' check (durum in ('aktif', 'iptal')),
  hatali_deneme  int  not null default 0,
  kilit_bitis    timestamptz,
  olusturma      timestamptz not null default now(),
  son_giris      timestamptz
);

create table public.bl_dersler (
  id          uuid primary key default gen_random_uuid(),
  teacher_id  uuid not null default auth.uid(),
  student_id  uuid not null references public.teshis_students(id) on delete cascade,
  baslangic   timestamptz not null,
  sure_dk     int  not null default 60 check (sure_dk between 15 and 180),
  durum       text not null default 'planli' check (durum in ('planli', 'suruyor', 'bitti', 'iptal')),
  plan        jsonb not null default '{}'::jsonb check (pg_column_size(plan) < 200000),
  kayit_onay  text not null default 'sorulmadi' check (kayit_onay in ('sorulmadi', 'verildi', 'reddedildi')),
  olusturma   timestamptz not null default now(),
  guncelleme  timestamptz not null default now()
);
create index bl_dersler_ogretmen_zaman on public.bl_dersler (teacher_id, baslangic);
create index bl_dersler_ogrenci_zaman on public.bl_dersler (student_id, baslangic);

create table public.bl_denetim (
  id      bigint generated always as identity primary key,
  zaman   timestamptz not null default now(),
  kim     uuid,
  islem   text not null,
  hedef   uuid,
  ayrinti jsonb not null default '{}'::jsonb
);
create index bl_denetim_kim_zaman on public.bl_denetim (kim, zaman desc);

-- -------------------------------------------------------------------------------------
-- 4) Yetki yardımcıları (SECURITY DEFINER: RLS döngüsüne girmeden kontrol eder)
-- -------------------------------------------------------------------------------------
create or replace function public.bl_ogretmen_mi() returns boolean
language sql stable security definer set search_path = '' as $$
  select not public.bl_jwt_ogrenci_mi()
     and exists (select 1 from public.bl_ogretmenler o where o.user_id = auth.uid() and o.durum = 'aktif')
$$;

create or replace function public.bl_ogrencim() returns uuid
language sql stable security definer set search_path = '' as $$
  select e.student_id from public.bl_ogrenci_erisim e
   where public.bl_jwt_ogrenci_mi() and e.auth_user_id = auth.uid() and e.durum = 'aktif'
   limit 1
$$;

create or replace function public.bl_ders_ogretmeni(p_ders uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.bl_ogretmen_mi() and exists (
    select 1 from public.bl_dersler d where d.id = p_ders and d.teacher_id = auth.uid())
$$;

create or replace function public.bl_derse_erisir(p_ders uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.bl_dersler d
     where d.id = p_ders and d.durum <> 'iptal'
       and ((d.teacher_id = auth.uid() and public.bl_ogretmen_mi())
            or (d.student_id = public.bl_ogrencim())))
$$;

-- -------------------------------------------------------------------------------------
-- 5) Satır düzeyi güvenlik
-- -------------------------------------------------------------------------------------
alter table public.bl_ogretmenler    enable row level security;
alter table public.bl_ogrenci_erisim enable row level security;  -- politika yok: yalnız fonksiyonlarla
alter table public.bl_dersler        enable row level security;
alter table public.bl_denetim        enable row level security;

create policy bl_ogretmenler_yonetici on public.bl_ogretmenler for all to authenticated
  using (public.yonetici_mi() and not public.bl_jwt_ogrenci_mi())
  with check (public.yonetici_mi() and not public.bl_jwt_ogrenci_mi());
create policy bl_ogretmenler_kendi on public.bl_ogretmenler for select to authenticated
  using (user_id = auth.uid());

create policy bl_dersler_ogretmen on public.bl_dersler for all to authenticated
  using (teacher_id = auth.uid() and public.bl_ogretmen_mi())
  with check (teacher_id = auth.uid() and public.bl_ogretmen_mi()
              and exists (select 1 from public.teshis_students s where s.id = student_id and s.teacher_id = auth.uid()));
create policy bl_dersler_ogrenci on public.bl_dersler for select to authenticated
  using (student_id = public.bl_ogrencim());

create policy bl_denetim_okur on public.bl_denetim for select to authenticated
  using ((kim = auth.uid() and public.bl_ogretmen_mi()) or (public.yonetici_mi() and not public.bl_jwt_ogrenci_mi()));

-- Kayıt onayı yalnız öğrenci fonksiyonuyla "verildi" olabilir; öğretmen kendisi işaretleyemez.
create or replace function public.bl_dersler_tetik() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.guncelleme := now();
  if tg_op = 'INSERT' then
    if new.kayit_onay <> 'sorulmadi' then raise exception 'Kayıt onayı yalnız öğrenci tarafından verilir'; end if;
  elsif new.kayit_onay is distinct from old.kayit_onay
        and new.kayit_onay <> 'sorulmadi'
        and coalesce(current_setting('bl.onay_fonksiyonu', true), '') <> 'evet' then
    raise exception 'Kayıt onayı yalnız öğrenci tarafından verilir';
  end if;
  return new;
end $$;
create trigger bl_dersler_tetik before insert or update on public.bl_dersler
  for each row execute function public.bl_dersler_tetik();

-- -------------------------------------------------------------------------------------
-- 6) Fonksiyonlar (RPC)
-- -------------------------------------------------------------------------------------

-- Öğretmen: öğrenciye yeni defter linki + PIN üretir. Eski link ve PIN geçersiz olur.
-- Token ve PIN yalnız bu yanıtta görünür; veritabanında yalnız özetleri (SHA-256) tutulur.
create or replace function public.bl_ogrenci_linki_olustur(p_student uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_token text; v_pin text; v_th bytea; v_aktif int; v_max int;
begin
  if not public.bl_ogretmen_mi() then raise exception 'Yetki yok' using errcode = '42501'; end if;
  if not exists (select 1 from public.teshis_students s where s.id = p_student and s.teacher_id = auth.uid()) then
    raise exception 'Öğrenci bulunamadı' using errcode = '42501';
  end if;
  select count(*) into v_aktif from public.bl_ogrenci_erisim e
   where e.teacher_id = auth.uid() and e.durum = 'aktif' and e.student_id <> p_student;
  select o.max_ogrenci into v_max from public.bl_ogretmenler o where o.user_id = auth.uid();
  if v_aktif >= v_max then raise exception 'Aktif öğrenci sınırına ulaşıldı (%)', v_max; end if;

  v_token := translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/=', '-_');
  v_pin   := lpad(((('x' || encode(extensions.gen_random_bytes(6), 'hex'))::bit(48)::bigint) % 1000000)::text, 6, '0');
  v_th    := extensions.digest(v_token, 'sha256');

  insert into public.bl_ogrenci_erisim as e (student_id, teacher_id, token_hash, pin_hash, durum, hatali_deneme, kilit_bitis, olusturma)
  values (p_student, auth.uid(), v_th, extensions.digest(v_pin || encode(v_th, 'hex'), 'sha256'), 'aktif', 0, null, now())
  on conflict (student_id) do update
    set teacher_id = excluded.teacher_id, token_hash = excluded.token_hash, pin_hash = excluded.pin_hash,
        durum = 'aktif', hatali_deneme = 0, kilit_bitis = null, olusturma = now();

  insert into public.bl_denetim (kim, islem, hedef) values (auth.uid(), 'ogrenci_linki_olustur', p_student);
  return jsonb_build_object('token', v_token, 'pin', v_pin);
end $$;

-- Öğretmen: öğrencinin linkini iptal eder. Öğrencinin açık oturumu varsa veriye erişimi hemen kesilir.
create or replace function public.bl_ogrenci_linki_iptal(p_student uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.bl_ogretmen_mi() then raise exception 'Yetki yok' using errcode = '42501'; end if;
  update public.bl_ogrenci_erisim set durum = 'iptal'
   where student_id = p_student and teacher_id = auth.uid();
  if not found then raise exception 'Öğrenci bulunamadı' using errcode = '42501'; end if;
  insert into public.bl_denetim (kim, islem, hedef) values (auth.uid(), 'ogrenci_linki_iptal', p_student);
end $$;

-- Öğretmen: kendi öğrencilerinin erişim durumu (özetler gösterilmez).
create or replace function public.bl_erisim_durumlari()
returns table (student_id uuid, durum text, olusturma timestamptz, son_giris timestamptz, kilitli boolean)
language sql stable security definer set search_path = '' as $$
  select e.student_id, e.durum, e.olusturma, e.son_giris, coalesce(e.kilit_bitis > now(), false)
    from public.bl_ogrenci_erisim e
   where public.bl_ogretmen_mi() and e.teacher_id = auth.uid()
$$;

-- YALNIZ SUNUCU (Edge Function, service_role): link + PIN doğrulama.
-- Hata durumunda istisna FIRLATMAZ; sonuç döndürür. Böylece hatalı deneme sayacı geri alınmaz.
create or replace function public.bl_ogrenci_dogrula(p_token text, p_pin text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare e public.bl_ogrenci_erisim; v_ad text; v_hata int;
begin
  if p_token is null or length(p_token) > 100 or p_pin is null or p_pin !~ '^[0-9]{6}$' then
    return jsonb_build_object('ok', false, 'hata', 'Geçersiz link ya da PIN');
  end if;
  select * into e from public.bl_ogrenci_erisim where token_hash = extensions.digest(p_token, 'sha256') for update;
  if not found or e.durum <> 'aktif' then
    return jsonb_build_object('ok', false, 'hata', 'Geçersiz link ya da PIN');
  end if;
  if e.kilit_bitis is not null and e.kilit_bitis > now() then
    return jsonb_build_object('ok', false, 'hata', 'Çok fazla hatalı deneme. Biraz sonra tekrar deneyin.',
                              'bekle_dk', ceil(extract(epoch from (e.kilit_bitis - now())) / 60));
  end if;
  if e.pin_hash <> extensions.digest(p_pin || encode(e.token_hash, 'hex'), 'sha256') then
    v_hata := e.hatali_deneme + 1;
    update public.bl_ogrenci_erisim
       set hatali_deneme = case when v_hata >= 5 then 0 else v_hata end,
           kilit_bitis   = case when v_hata >= 5 then now() + interval '15 minutes' else kilit_bitis end
     where student_id = e.student_id;
    insert into public.bl_denetim (islem, hedef, ayrinti) values ('ogrenci_pin_hatali', e.student_id, jsonb_build_object('deneme', v_hata));
    return jsonb_build_object('ok', false, 'hata', 'Geçersiz link ya da PIN', 'kalan', greatest(0, 5 - v_hata));
  end if;
  update public.bl_ogrenci_erisim set hatali_deneme = 0, kilit_bitis = null, son_giris = now() where student_id = e.student_id;
  select s.name into v_ad from public.teshis_students s where s.id = e.student_id;
  insert into public.bl_denetim (islem, hedef) values ('ogrenci_giris', e.student_id);
  return jsonb_build_object('ok', true, 'student_id', e.student_id, 'auth_user_id', e.auth_user_id, 'ad', v_ad);
end $$;

-- YALNIZ SUNUCU: ilk girişte oluşturulan sistem hesabını öğrenciye bağlar.
create or replace function public.bl_ogrenci_hesap_bagla(p_student uuid, p_auth_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update public.bl_ogrenci_erisim set auth_user_id = p_auth_user
   where student_id = p_student and durum = 'aktif' and (auth_user_id is null or auth_user_id = p_auth_user);
  if not found then raise exception 'Bağlanamadı'; end if;
end $$;

-- Öğrenci: kendi bilgisi (uygulama açılışında).
create or replace function public.bl_ben() returns jsonb
language sql stable security definer set search_path = '' as $$
  select case
    when public.bl_ogretmen_mi() then jsonb_build_object('rol', 'ogretmen', 'ad', (select ad from public.bl_ogretmenler where user_id = auth.uid()))
    when public.bl_ogrencim() is not null then jsonb_build_object('rol', 'ogrenci', 'student_id', public.bl_ogrencim(),
           'ad', (select s.name from public.teshis_students s where s.id = public.bl_ogrencim()))
    else jsonb_build_object('rol', null) end
$$;

-- Öğrenci: dersin ses kaydına onay verir ya da reddeder.
create or replace function public.bl_kayit_onayi(p_ders uuid, p_onay boolean) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if public.bl_ogrencim() is null then raise exception 'Yetki yok' using errcode = '42501'; end if;
  perform set_config('bl.onay_fonksiyonu', 'evet', true);
  update public.bl_dersler set kayit_onay = case when p_onay then 'verildi' else 'reddedildi' end
   where id = p_ders and student_id = public.bl_ogrencim() and durum <> 'iptal';
  if not found then raise exception 'Ders bulunamadı' using errcode = '42501'; end if;
  perform set_config('bl.onay_fonksiyonu', '', true);
  insert into public.bl_denetim (kim, islem, hedef, ayrinti) values (auth.uid(), 'kayit_onayi', p_ders, jsonb_build_object('onay', p_onay));
end $$;

-- Yetkiler: varsayılan "herkese çalıştırma" kaldırılır, yalnız gereken role verilir.
revoke all on function public.bl_jwt_ogrenci_mi(), public.bl_uuid(text), public.bl_ogretmen_mi(), public.bl_ogrencim(),
  public.bl_ders_ogretmeni(uuid), public.bl_derse_erisir(uuid), public.bl_ogrenci_linki_olustur(uuid),
  public.bl_ogrenci_linki_iptal(uuid), public.bl_erisim_durumlari(), public.bl_ogrenci_dogrula(text, text),
  public.bl_ogrenci_hesap_bagla(uuid, uuid), public.bl_ben(), public.bl_kayit_onayi(uuid, boolean),
  public.bl_dersler_tetik() from public, anon, authenticated;
grant execute on function public.bl_jwt_ogrenci_mi(), public.bl_uuid(text), public.bl_ogretmen_mi(), public.bl_ogrencim(),
  public.bl_ders_ogretmeni(uuid), public.bl_derse_erisir(uuid), public.bl_ogrenci_linki_olustur(uuid),
  public.bl_ogrenci_linki_iptal(uuid), public.bl_erisim_durumlari(), public.bl_ben(), public.bl_kayit_onayi(uuid, boolean)
  to authenticated;
grant execute on function public.bl_ogrenci_dogrula(text, text), public.bl_ogrenci_hesap_bagla(uuid, uuid) to service_role;
-- teshis_* politikalarındaki yardımcı herkesçe çağrılabilmeli (anon dahil, aksi halde politika hata verir)
grant execute on function public.bl_jwt_ogrenci_mi() to anon;
-- anon: bl_ tablolarına hiçbir yetki yok
revoke all on public.bl_ogretmenler, public.bl_ogrenci_erisim, public.bl_dersler, public.bl_denetim from anon;
revoke insert, update, delete on public.bl_denetim from authenticated;
revoke all on public.bl_ogrenci_erisim from authenticated;

-- -------------------------------------------------------------------------------------
-- 7) Storage: özel kova; yol = <ders_id>/<dosya>. Öğretmen yazar, dersin iki tarafı okur.
-- -------------------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('bl-ders', 'bl-ders', false, 10485760, array['image/png', 'image/jpeg', 'application/pdf', 'application/gzip', 'application/octet-stream'])
on conflict (id) do nothing;

create policy bl_ders_dosya_oku on storage.objects for select to authenticated
  using (bucket_id = 'bl-ders' and public.bl_derse_erisir(public.bl_uuid((storage.foldername(name))[1])));
create policy bl_ders_dosya_ekle on storage.objects for insert to authenticated
  with check (bucket_id = 'bl-ders' and public.bl_ders_ogretmeni(public.bl_uuid((storage.foldername(name))[1])));
create policy bl_ders_dosya_guncelle on storage.objects for update to authenticated
  using (bucket_id = 'bl-ders' and public.bl_ders_ogretmeni(public.bl_uuid((storage.foldername(name))[1])))
  with check (bucket_id = 'bl-ders' and public.bl_ders_ogretmeni(public.bl_uuid((storage.foldername(name))[1])));
create policy bl_ders_dosya_sil on storage.objects for delete to authenticated
  using (bucket_id = 'bl-ders' and public.bl_ders_ogretmeni(public.bl_uuid((storage.foldername(name))[1])));

-- -------------------------------------------------------------------------------------
-- 8) Realtime yetkisi: özel kanal adı "ders:<ders_id>"; yalnız dersin öğretmeni ve öğrencisi
--    dinler ve gönderir (sinyalleşme + yedek tahta kanalı).
-- -------------------------------------------------------------------------------------
create policy bl_ders_kanal_dinle on realtime.messages for select to authenticated
  using (realtime.topic() like 'ders:%' and public.bl_derse_erisir(public.bl_uuid(substr(realtime.topic(), 6))));
create policy bl_ders_kanal_gonder on realtime.messages for insert to authenticated
  with check (realtime.topic() like 'ders:%' and public.bl_derse_erisir(public.bl_uuid(substr(realtime.topic(), 6))));

commit;
