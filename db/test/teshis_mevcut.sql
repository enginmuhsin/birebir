-- YALNIZ TEST: canlı projedeki teshis_* yapısının kopyası (30.10.2026 yönetici çıktısından).
create table public.teshis_students (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null default auth.uid(),
  name text not null,
  created_at timestamptz not null default now());
create table public.teshis_attempts (
  id uuid primary key default gen_random_uuid(),
  teacher_id uuid not null default auth.uid(),
  student_id uuid not null,
  topic text not null, mode text,
  date timestamptz not null default now(),
  answers jsonb not null default '[]'::jsonb, times jsonb not null default '[]'::jsonb,
  errs jsonb not null default '{}'::jsonb, dur integer not null default 0,
  from_name text, created_at timestamptz not null default now());
create table public.teshis_links (
  token text primary key, teacher_id uuid not null default auth.uid(), student_id uuid not null,
  topic text not null, created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + '30 days'::interval), used_at timestamptz);
create table public.teshis_plans (
  student_id uuid primary key, teacher_id uuid not null default auth.uid(),
  data jsonb not null, updated_at timestamptz not null default now());

alter table public.teshis_students enable row level security;
alter table public.teshis_attempts enable row level security;
alter table public.teshis_links enable row level security;
alter table public.teshis_plans enable row level security;

create policy teshis_students_owner on public.teshis_students for all to authenticated using (teacher_id = auth.uid()) with check (teacher_id = auth.uid());
create policy teshis_attempts_owner on public.teshis_attempts for all to authenticated using (teacher_id = auth.uid()) with check (teacher_id = auth.uid());
create policy teshis_attempts_student_check on public.teshis_attempts for insert to authenticated with check (exists (select 1 from public.teshis_students s where s.id = teshis_attempts.student_id and s.teacher_id = auth.uid()));
create policy teshis_plans_owner on public.teshis_plans for all to authenticated using (teacher_id = auth.uid()) with check (teacher_id = auth.uid());
create policy teshis_plans_student_check on public.teshis_plans for insert to authenticated with check (exists (select 1 from public.teshis_students s where s.id = teshis_plans.student_id and s.teacher_id = auth.uid()));
create policy teshis_links_owner on public.teshis_links for all to authenticated using (teacher_id = auth.uid()) with check (teacher_id = auth.uid());
create policy teshis_links_student_check on public.teshis_links for insert to authenticated with check (exists (select 1 from public.teshis_students s where s.id = teshis_links.student_id and s.teacher_id = auth.uid()));

create or replace function public.teshis_submit(p_token text, p_topic text, p_name text, p_answers jsonb, p_times jsonb, p_dur integer)
 returns text language plpgsql security definer set search_path to 'public' as $function$
declare l public.teshis_links;
begin
  select * into l from public.teshis_links where token = p_token for update;
  if not found then raise exception 'Geçersiz link'; end if;
  if l.used_at is not null then raise exception 'Bu link daha önce kullanıldı'; end if;
  if l.expires_at < now() then raise exception 'Linkin süresi dolmuş'; end if;
  if l.topic <> p_topic then raise exception 'Link bu test için değil'; end if;
  if jsonb_typeof(p_answers) <> 'array' or jsonb_array_length(p_answers) > 30
     or exists (select 1 from jsonb_array_elements_text(p_answers) a where a not in ('A','B','C','D','E','')) then raise exception 'Geçersiz cevap verisi'; end if;
  if jsonb_typeof(p_times) <> 'array' or jsonb_array_length(p_times) > 30 then raise exception 'Geçersiz süre verisi'; end if;
  insert into public.teshis_attempts(teacher_id, student_id, topic, mode, date, answers, times, errs, dur, from_name)
  values (l.teacher_id, l.student_id, l.topic, 'link', now(), p_answers, p_times, '{}'::jsonb, least(greatest(coalesce(p_dur,0),0), 36000), left(coalesce(p_name,''),120));
  update public.teshis_links set used_at = now() where token = p_token;
  return 'ok';
end $function$;
