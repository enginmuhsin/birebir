-- =====================================================================================
-- Birebir · migration 003: Ders Ölçümü (ön test → son test → kalıcılık testi, veli raporu)
-- Ön koşul: 001_birebir.sql canlıda. teshis_* ve 001'in tablolarına DOKUNMAZ; yalnız yeni tablo ve fonksiyon ekler.
-- Tek işlem: bir hata olursa hiçbir şey uygulanmaz. Geri alma: 003_olcum_geri.sql
--
-- İlkeler
--  * Cevap anahtarı ayrı tabloda (bl_madde_anahtar). Öğrenci ona hiçbir yoldan erişemez.
--  * Öğrenci soruları yalnız kendisine atanmış, açık bir ölçüm üzerinden ve anahtarsız görür.
--  * Puanlamayı sunucu yapar; öğrenci yalnız şıkkını gönderir. Gönderim bir kez yapılır.
--  * Kâğıtla çözülen testin cevaplarını öğretmen girer (kaynak = 'kagit'); aynı puanlama kullanılır.
--  * Kazanım = müfredat kimliği (TM/TG/AM/AG + iki rakam + alt numara, ör. TG02.3; teshis curriculum.json).
--  * Şekiller özel 'bl-sekiller' kovasında (<öğretmen_id>/<dosya>). Öğrenci bir şekli yalnız kendisine
--    açık (henüz gönderilmemiş) bir ölçümde varsa görür; adres imzalı ve kısa ömürlüdür.
-- =====================================================================================
begin;

-- -------------------------------------------------------------------------------------
-- 1) Tablolar
-- -------------------------------------------------------------------------------------

-- Soru bankası (anahtarsız). Bir "aile" aynı kazanımı aynı zorlukta ölçen ikiz sorulardır (A/B/C formları).
create table public.bl_maddeler (
  id          uuid primary key default gen_random_uuid(),
  teacher_id  uuid not null default auth.uid(),
  kod         text not null check (kod ~ '^[A-Za-z0-9._-]{1,40}$'),
  kazanim     text not null check (kazanim ~ '^(TM|TG|AM|AG)[0-9]{2}\.[0-9]{1,2}$'),
  aile        text check (length(aile) <= 60),
  etiket      text not null default '' check (length(etiket) <= 60),
  kok         text not null check (length(kok) between 1 and 2000),
  soru        text not null check (length(soru) between 1 and 500),
  siklar      jsonb not null check (jsonb_typeof(siklar) = 'array' and jsonb_array_length(siklar) = 5),
  sekil       text check (sekil ~ '^[0-9a-f-]{36}/[A-Za-z0-9._-]{1,120}\.(png|svg|jpg|jpeg|webp)$'),  -- 'bl-sekiller' kovasındaki yol
  olusturma   timestamptz not null default now(),
  unique (teacher_id, kod)
);

-- Cevap anahtarı: dogru = 0..4 (A..E). yanilgilar: {"1": "Kenarları çıkardı", ...}
create table public.bl_madde_anahtar (
  madde_id    uuid primary key references public.bl_maddeler(id) on delete cascade,
  dogru       smallint not null check (dogru between 0 and 4),
  yanilgilar  jsonb not null default '{}'::jsonb check (jsonb_typeof(yanilgilar) = 'object'),
  cozum       text not null default '' check (length(cozum) <= 2000)
);

-- Test şablonu: sıralı madde listesi (ör. "D3-ON": Ders 3 ön testi).
create table public.bl_testler (
  id          uuid primary key default gen_random_uuid(),
  teacher_id  uuid not null default auth.uid(),
  kod         text not null check (kod ~ '^[A-Za-z0-9._-]{1,40}$'),
  baslik      text not null check (length(baslik) between 1 and 120),
  ders_kodu   text not null check (length(ders_kodu) between 1 and 20),
  tur         text not null check (tur in ('on', 'son', 'kalicilik', 'odev', 'serbest')),
  sure_dk     int  not null default 12 check (sure_dk between 1 and 180),
  maddeler    uuid[] not null check (cardinality(maddeler) between 1 and 40),
  olusturma   timestamptz not null default now(),
  unique (teacher_id, kod)
);

-- Bir testin bir öğrenciye uygulanması.
create table public.bl_olcumler (
  id          uuid primary key default gen_random_uuid(),
  teacher_id  uuid not null,
  student_id  uuid not null references public.teshis_students(id) on delete cascade,
  test_id     uuid not null references public.bl_testler(id) on delete restrict,
  ders_id     uuid references public.bl_dersler(id) on delete set null,
  durum       text not null default 'acik' check (durum in ('acik', 'gonderildi', 'kapali')),
  kaynak      text check (kaynak in ('ekran', 'kagit')),
  acilis      timestamptz not null default now(),
  baslama     timestamptz,
  gonderim    timestamptz,
  sure_sn     int check (sure_sn between 0 and 36000),
  dogru_sayi  int,
  soru_sayi   int
);
create index bl_olcumler_ogrenci on public.bl_olcumler (student_id, acilis desc);
create index bl_olcumler_ogretmen on public.bl_olcumler (teacher_id, acilis desc);

create table public.bl_olcum_cevaplar (
  olcum_id  uuid not null references public.bl_olcumler(id) on delete cascade,
  sira      int  not null check (sira between 1 and 40),
  madde_id  uuid not null references public.bl_maddeler(id) on delete restrict,
  cevap     smallint check (cevap between 0 and 4),          -- null = boş
  dogru     boolean not null,
  sure_sn   int check (sure_sn between 0 and 36000),
  primary key (olcum_id, sira)
);

-- -------------------------------------------------------------------------------------
-- 2) Tutarlılık: test yalnız öğretmenin kendi, anahtarı girilmiş maddelerinden kurulur
-- -------------------------------------------------------------------------------------
create or replace function public.bl_testler_tetik() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_eksik int;
begin
  if (select count(distinct m) from unnest(new.maddeler) m) <> cardinality(new.maddeler) then
    raise exception 'Bir test aynı soruyu iki kez içeremez';
  end if;
  select count(*) into v_eksik from unnest(new.maddeler) m
   where not exists (select 1 from public.bl_maddeler x join public.bl_madde_anahtar a on a.madde_id = x.id
                      where x.id = m and x.teacher_id = new.teacher_id);
  if v_eksik > 0 then raise exception 'Testteki % soru bulunamadı ya da anahtarı yok', v_eksik; end if;
  return new;
end $$;
create trigger bl_testler_tetik before insert or update on public.bl_testler
  for each row execute function public.bl_testler_tetik();

-- Uygulanmış testin maddeleri sonradan değiştirilemez (raporlar bozulmasın).
create or replace function public.bl_testler_kilit() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.maddeler is distinct from old.maddeler
     and exists (select 1 from public.bl_olcumler o where o.test_id = old.id) then
    raise exception 'Bu test uygulandı; soruları değiştirilemez. Yeni bir test oluşturun.';
  end if;
  return new;
end $$;
create trigger bl_testler_kilit before update on public.bl_testler
  for each row execute function public.bl_testler_kilit();

-- -------------------------------------------------------------------------------------
-- 3) Satır düzeyi güvenlik
-- -------------------------------------------------------------------------------------
alter table public.bl_maddeler       enable row level security;
alter table public.bl_madde_anahtar  enable row level security;
alter table public.bl_testler        enable row level security;
alter table public.bl_olcumler       enable row level security;
alter table public.bl_olcum_cevaplar enable row level security;

create policy bl_maddeler_ogretmen on public.bl_maddeler for all to authenticated
  using (teacher_id = auth.uid() and public.bl_ogretmen_mi())
  with check (teacher_id = auth.uid() and public.bl_ogretmen_mi());

create policy bl_madde_anahtar_ogretmen on public.bl_madde_anahtar for all to authenticated
  using (public.bl_ogretmen_mi() and exists (select 1 from public.bl_maddeler m where m.id = madde_id and m.teacher_id = auth.uid()))
  with check (public.bl_ogretmen_mi() and exists (select 1 from public.bl_maddeler m where m.id = madde_id and m.teacher_id = auth.uid()));

create policy bl_testler_ogretmen on public.bl_testler for all to authenticated
  using (teacher_id = auth.uid() and public.bl_ogretmen_mi())
  with check (teacher_id = auth.uid() and public.bl_ogretmen_mi());

-- Ölçüm ve cevaplar: öğretmen okur; yazma yalnız fonksiyonlarla.
create policy bl_olcumler_ogretmen on public.bl_olcumler for select to authenticated
  using (teacher_id = auth.uid() and public.bl_ogretmen_mi());
create policy bl_olcum_cevaplar_ogretmen on public.bl_olcum_cevaplar for select to authenticated
  using (public.bl_ogretmen_mi() and exists (select 1 from public.bl_olcumler o where o.id = olcum_id and o.teacher_id = auth.uid()));

revoke all on public.bl_maddeler, public.bl_madde_anahtar, public.bl_testler, public.bl_olcumler, public.bl_olcum_cevaplar from anon;
revoke insert, update, delete on public.bl_olcumler, public.bl_olcum_cevaplar from authenticated;

-- -------------------------------------------------------------------------------------
-- 4) Fonksiyonlar
-- -------------------------------------------------------------------------------------

-- İç: cevapları puanlar ve kaydeder. p_cevaplar = [{"sira":1,"cevap":"C","sure":40}, ...]
-- cevap: "A".."E" ya da null/"" (boş). Listede olmayan soru boş sayılır.
create or replace function public.bl_olcum_puanla(p_olcum uuid, p_cevaplar jsonb, p_sure_sn int, p_kaynak text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o public.bl_olcumler; t public.bl_testler; v_dogru int;
begin
  if p_cevaplar is null or jsonb_typeof(p_cevaplar) <> 'array' or jsonb_array_length(p_cevaplar) > 40 then
    raise exception 'Cevap listesi geçersiz';
  end if;
  select * into o from public.bl_olcumler where id = p_olcum for update;
  select * into t from public.bl_testler where id = o.test_id;

  insert into public.bl_olcum_cevaplar (olcum_id, sira, madde_id, cevap, dogru, sure_sn)
  select o.id, s.sira, s.madde,
         c.harf, coalesce(c.harf = a.dogru, false),
         case when c.sure between 0 and 36000 then c.sure end
    from unnest(t.maddeler) with ordinality s(madde, sira)
    join public.bl_madde_anahtar a on a.madde_id = s.madde
    left join lateral (
      select case when upper(coalesce(e ->> 'cevap', '')) in ('A', 'B', 'C', 'D', 'E')
                  then strpos('ABCDE', upper(e ->> 'cevap')) - 1 end as harf,
             case when (e ->> 'sure') ~ '^[0-9]{1,5}$' then (e ->> 'sure')::int end as sure
        from jsonb_array_elements(p_cevaplar) e
       where (e ->> 'sira') ~ '^[0-9]{1,2}$' and (e ->> 'sira')::int = s.sira
       limit 1) c on true;

  select count(*) filter (where dogru) into v_dogru from public.bl_olcum_cevaplar where olcum_id = o.id;
  update public.bl_olcumler
     set durum = 'gonderildi', kaynak = p_kaynak, gonderim = now(),
         sure_sn = case when p_sure_sn between 0 and 36000 then p_sure_sn end,
         dogru_sayi = v_dogru, soru_sayi = cardinality(t.maddeler)
   where id = o.id;
  return jsonb_build_object('dogru', v_dogru, 'soru', cardinality(t.maddeler));
end $$;

-- Öğretmen: kendi öğrencisine bir test açar. İsteğe bağlı olarak bir derse bağlanır.
create or replace function public.bl_olcum_ac(p_student uuid, p_test uuid, p_ders uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not public.bl_ogretmen_mi() then raise exception 'Yetki yok' using errcode = '42501'; end if;
  if not exists (select 1 from public.teshis_students s where s.id = p_student and s.teacher_id = auth.uid()) then
    raise exception 'Öğrenci bulunamadı' using errcode = '42501';
  end if;
  if not exists (select 1 from public.bl_testler t where t.id = p_test and t.teacher_id = auth.uid()) then
    raise exception 'Test bulunamadı' using errcode = '42501';
  end if;
  if p_ders is not null and not exists (select 1 from public.bl_dersler d
                                         where d.id = p_ders and d.teacher_id = auth.uid() and d.student_id = p_student) then
    raise exception 'Ders bulunamadı' using errcode = '42501';
  end if;
  insert into public.bl_olcumler (teacher_id, student_id, test_id, ders_id)
  values (auth.uid(), p_student, p_test, p_ders) returning id into v_id;
  insert into public.bl_denetim (kim, islem, hedef, ayrinti)
  values (auth.uid(), 'olcum_ac', v_id, jsonb_build_object('test', p_test, 'ogrenci', p_student));
  return v_id;
end $$;

-- Öğretmen: açık ölçümü kapatır (öğrenci artık çözemez).
create or replace function public.bl_olcum_kapat(p_olcum uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.bl_ogretmen_mi() then raise exception 'Yetki yok' using errcode = '42501'; end if;
  update public.bl_olcumler set durum = 'kapali' where id = p_olcum and teacher_id = auth.uid() and durum = 'acik';
  if not found then raise exception 'Açık ölçüm bulunamadı' using errcode = '42501'; end if;
end $$;

-- Öğretmen: kâğıtla çözülmüş testin cevaplarını girer.
create or replace function public.bl_olcum_kagit(p_olcum uuid, p_cevaplar jsonb, p_sure_sn int default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  if not public.bl_ogretmen_mi() then raise exception 'Yetki yok' using errcode = '42501'; end if;
  if not exists (select 1 from public.bl_olcumler where id = p_olcum and teacher_id = auth.uid() and durum = 'acik') then
    raise exception 'Açık ölçüm bulunamadı' using errcode = '42501';
  end if;
  v := public.bl_olcum_puanla(p_olcum, p_cevaplar, p_sure_sn, 'kagit');
  insert into public.bl_denetim (kim, islem, hedef) values (auth.uid(), 'olcum_kagit', p_olcum);
  return v;
end $$;

-- Öğrenci: kendisine açılmış ölçümler.
create or replace function public.bl_olcumlerim()
returns table (id uuid, baslik text, tur text, sure_dk int, soru_sayi int, durum text, acilis timestamptz, dogru_sayi int)
language sql stable security definer set search_path = '' as $$
  select o.id, t.baslik, t.tur, t.sure_dk, cardinality(t.maddeler), o.durum, o.acilis,
         case when o.durum = 'gonderildi' then o.dogru_sayi end
    from public.bl_olcumler o join public.bl_testler t on t.id = o.test_id
   where o.student_id = public.bl_ogrencim() and o.durum <> 'kapali'
   order by o.acilis desc
$$;

-- Öğrenci: açık ölçümün soruları (ANAHTARSIZ). İlk açılışta başlama zamanı yazılır.
create or replace function public.bl_olcum_sorulari(p_olcum uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o public.bl_olcumler; t public.bl_testler;
begin
  select * into o from public.bl_olcumler where id = p_olcum;
  if not found or public.bl_ogrencim() is null or o.student_id <> public.bl_ogrencim() or o.durum <> 'acik' then
    raise exception 'Ölçüm bulunamadı' using errcode = '42501';
  end if;
  select * into t from public.bl_testler where id = o.test_id;
  if o.baslama is null then update public.bl_olcumler set baslama = now() where id = o.id; end if;
  return jsonb_build_object(
    'baslik', t.baslik, 'sure_dk', t.sure_dk,
    'sorular', (select jsonb_agg(jsonb_build_object('sira', s.sira, 'etiket', m.etiket, 'kok', m.kok, 'soru', m.soru,
                                                    'siklar', m.siklar, 'sekil', m.sekil) order by s.sira)
                  from unnest(t.maddeler) with ordinality s(madde, sira)
                  join public.bl_maddeler m on m.id = s.madde));
end $$;

-- Öğrenci: cevaplarını bir kez gönderir. Yanıtta yalnız doğru sayısı döner (anahtar dönmez).
create or replace function public.bl_olcum_gonder(p_olcum uuid, p_cevaplar jsonb, p_sure_sn int default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  if public.bl_ogrencim() is null or not exists (
       select 1 from public.bl_olcumler where id = p_olcum and student_id = public.bl_ogrencim() and durum = 'acik') then
    raise exception 'Ölçüm bulunamadı ya da gönderilmiş' using errcode = '42501';
  end if;
  v := public.bl_olcum_puanla(p_olcum, p_cevaplar, p_sure_sn, 'ekran');
  insert into public.bl_denetim (kim, islem, hedef) values (auth.uid(), 'olcum_gonder', p_olcum);
  return v;
end $$;

-- Öğretmen: bir öğrencinin ölçüm raporu. Kazanım × test türü (ön/son/kalıcılık/ödev) ve soru ayrıntısı.
-- p_ders_kodu verilirse yalnız o dersin testleri (ör. 'D3').
create or replace function public.bl_olcum_raporu(p_student uuid, p_ders_kodu text default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.bl_ogretmen_mi() or not exists (
       select 1 from public.teshis_students s where s.id = p_student and s.teacher_id = auth.uid()) then
    raise exception 'Öğrenci bulunamadı' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'ogrenci', (select s.name from public.teshis_students s where s.id = p_student),
    'kazanimlar', coalesce((
      select jsonb_agg(jsonb_build_object('ders_kodu', x.ders_kodu, 'kazanim', x.kazanim, 'tur', x.tur,
                                          'dogru', x.dogru, 'soru', x.soru) order by x.ders_kodu, x.kazanim, x.tur)
        from (select t.ders_kodu, m.kazanim, t.tur, count(*) filter (where c.dogru)::int dogru, count(*)::int soru
                from public.bl_olcumler o
                join public.bl_testler t on t.id = o.test_id
                join public.bl_olcum_cevaplar c on c.olcum_id = o.id
                join public.bl_maddeler m on m.id = c.madde_id
               where o.student_id = p_student and o.teacher_id = auth.uid() and o.durum = 'gonderildi'
                 and (p_ders_kodu is null or t.ders_kodu = p_ders_kodu)
               group by t.ders_kodu, m.kazanim, t.tur) x), '[]'::jsonb),
    'olcumler', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', o.id, 'test', t.kod, 'baslik', t.baslik, 'tur', t.tur, 'ders_kodu', t.ders_kodu,
               'kaynak', o.kaynak, 'gonderim', o.gonderim, 'sure_sn', o.sure_sn,
               'dogru', o.dogru_sayi, 'soru', o.soru_sayi,
               'sorular', (select jsonb_agg(jsonb_build_object(
                                 'sira', c.sira, 'kazanim', m.kazanim, 'cevap', substr('ABCDE', c.cevap + 1, 1),
                                 'anahtar', substr('ABCDE', a.dogru + 1, 1), 'dogru', c.dogru, 'sure_sn', c.sure_sn,
                                 'yanilgi', case when c.cevap is not null and not c.dogru then a.yanilgilar ->> c.cevap::text end)
                                 order by c.sira)
                             from public.bl_olcum_cevaplar c
                             join public.bl_maddeler m on m.id = c.madde_id
                             join public.bl_madde_anahtar a on a.madde_id = c.madde_id
                            where c.olcum_id = o.id))
             order by o.gonderim)
        from public.bl_olcumler o join public.bl_testler t on t.id = o.test_id
       where o.student_id = p_student and o.teacher_id = auth.uid() and o.durum = 'gonderildi'
         and (p_ders_kodu is null or t.ders_kodu = p_ders_kodu)), '[]'::jsonb));
end $$;

-- Öğrenci bu şekli görebilir mi? (kendisine açık ve gönderilmemiş bir ölçümün sorularında geçiyorsa)
create or replace function public.bl_sekil_gorebilir(p_yol text) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.bl_ogrencim() is not null and exists (
    select 1 from public.bl_olcumler o
      join public.bl_testler t on t.id = o.test_id
      join public.bl_maddeler m on m.id = any (t.maddeler)
     where o.student_id = public.bl_ogrencim() and o.durum = 'acik' and m.sekil = p_yol)
$$;

-- -------------------------------------------------------------------------------------
-- 4b) Storage: şekiller için özel kova; yol = <öğretmen_id>/<dosya>
-- -------------------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('bl-sekiller', 'bl-sekiller', false, 2097152, array['image/png', 'image/svg+xml', 'image/jpeg', 'image/webp'])
on conflict (id) do nothing;

create policy bl_sekil_oku on storage.objects for select to authenticated
  using (bucket_id = 'bl-sekiller' and (
         (public.bl_ogretmen_mi() and (storage.foldername(name))[1] = auth.uid()::text)
         or public.bl_sekil_gorebilir(name)));
create policy bl_sekil_ekle on storage.objects for insert to authenticated
  with check (bucket_id = 'bl-sekiller' and public.bl_ogretmen_mi() and (storage.foldername(name))[1] = auth.uid()::text);
create policy bl_sekil_guncelle on storage.objects for update to authenticated
  using (bucket_id = 'bl-sekiller' and public.bl_ogretmen_mi() and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'bl-sekiller' and public.bl_ogretmen_mi() and (storage.foldername(name))[1] = auth.uid()::text);
create policy bl_sekil_sil on storage.objects for delete to authenticated
  using (bucket_id = 'bl-sekiller' and public.bl_ogretmen_mi() and (storage.foldername(name))[1] = auth.uid()::text);

-- -------------------------------------------------------------------------------------
-- 5) Yetkiler
-- -------------------------------------------------------------------------------------
revoke all on function public.bl_olcum_puanla(uuid, jsonb, int, text), public.bl_testler_tetik(), public.bl_testler_kilit(),
  public.bl_olcum_ac(uuid, uuid, uuid), public.bl_olcum_kapat(uuid), public.bl_olcum_kagit(uuid, jsonb, int),
  public.bl_olcumlerim(), public.bl_olcum_sorulari(uuid), public.bl_olcum_gonder(uuid, jsonb, int),
  public.bl_olcum_raporu(uuid, text), public.bl_sekil_gorebilir(text) from public, anon, authenticated;
grant execute on function public.bl_olcum_ac(uuid, uuid, uuid), public.bl_olcum_kapat(uuid), public.bl_olcum_kagit(uuid, jsonb, int),
  public.bl_olcumlerim(), public.bl_olcum_sorulari(uuid), public.bl_olcum_gonder(uuid, jsonb, int),
  public.bl_olcum_raporu(uuid, text), public.bl_sekil_gorebilir(text) to authenticated;
-- bl_olcum_puanla yalnız diğer fonksiyonların içinden çağrılır (doğrudan çağrılamaz).

commit;
