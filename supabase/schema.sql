-- ============================================================
-- Учёт деталей: схема Supabase (PostgreSQL) + RLS
-- Запускать целиком в SQL Editor проекта Supabase.
-- Предпологается включённый extension pgcrypto (в Supabase включён по умолчанию).
-- ============================================================

create extension if not exists pgcrypto;

-- ---------- Вспомогальные типы ----------
do $$ begin
  create type user_role as enum ('admin','master','operator');
exception when duplicate_object then null; end $$;

do $$ begin
  create type machine_group as enum ('line','rmu','carousel'); -- СК Линия / РМУ / Карусельный
exception when duplicate_object then null; end $$;

do $$ begin
  create type shift_kind as enum ('day','night');
exception when duplicate_object then null; end $$;

do $$ begin
  create type entry_kind as enum ('counter','changeover','downtime'); -- замер счётчика / переналадка / простой
exception when duplicate_object then null; end $$;

do $$ begin
  create type report_type as enum ('hourly','shift_summary');
exception when duplicate_object then null; end $$;

-- ---------- Профили пользователей ----------
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  role user_role not null default 'operator',
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Функция роли без риска рекурсии RLS
create or replace function current_user_role() returns user_role
language sql stable security definer set search_path = public as $$
  select role from profiles where id = auth.uid();
$$;

create or replace function is_duty_master(p_session_id uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from session_masters
    where session_id = p_session_id and master_id = auth.uid()
  ) or current_user_role() = 'admin';
$$;

-- ---------- Справочники ----------
create table if not exists shifts (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,            -- А, Б, В, Г
  name text not null,                   -- «В»
  created_at timestamptz not null default now()
);

create table if not exists machines (
  id uuid primary key default gen_random_uuid(),
  sort_order int not null default 0,    -- нумерация как в отчёте (0..13)
  model text not null,                  -- «СК 61125», «Neway VNL80HA»…
  vais text,                            -- «ВАИС 003»
  grp machine_group not null default 'line',
  is_active boolean not null default true,
  note text,
  created_at timestamptz not null default now()
);

create table if not exists people (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  is_apprentice boolean not null default false, -- (ученик)
  profile_id uuid references profiles(id) on delete set null, -- если человек работает в системе
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists parts (
  id uuid primary key default gen_random_uuid(),
  article text unique not null,         -- чертёж/артикул
  name text not null,
  vais text,
  norm_hours numeric(8,2),              -- норма выработки (шт/смену или шт/час — задаёт админ)
  is_active boolean not null default true,
  note text,                            -- «Лыска» и т.п.
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- План: деталь + станок + операция -> шт/смена. История правок в part_plan_history.
create table if not exists part_operation_plans (
  id uuid primary key default gen_random_uuid(),
  part_id uuid not null references parts(id),
  machine_id uuid not null references machines(id),
  operation text not null,              -- «Ток 1», «Ток 2», «Доработка»…
  plan_qty int not null,
  valid_from date not null default current_date,
  updated_by uuid references profiles(id),
  unique (part_id, machine_id, operation, valid_from)
);

create table if not exists part_plan_history (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null,
  old_qty int, new_qty int,
  changed_at timestamptz not null default now(),
  changed_by uuid references profiles(id)
);

-- Текущий план (подхватывается автоматически): максимум valid_from <= сегодня
create or replace function current_plan(p_part uuid, p_machine uuid, p_op text)
returns int language sql stable as $$
  select plan_qty from part_operation_plans
  where part_id=p_part and machine_id=p_machine and operation=p_op
    and valid_from <= current_date
  order by valid_from desc limit 1;
$$;

-- ---------- Оперативные данные ----------
create table if not exists shift_sessions (
  id uuid primary key default gen_random_uuid(),
  session_date date not null,
  shift_id uuid not null references shifts(id),
  kind shift_kind not null default 'day',
  starts_at timestamptz not null,
  ends_at timestamptz,
  is_closed boolean not null default false,
  unique (session_date, shift_id, kind)
);

create table if not exists session_masters (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references shift_sessions(id) on delete cascade,
  master_id uuid not null references profiles(id),
  duty_from timestamptz not null default now(),
  duty_to timestamptz,
  unique (session_id, master_id, duty_from)
);

create table if not exists assignments (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references shift_sessions(id) on delete cascade,
  person_id uuid not null references people(id),
  machine_id uuid not null references machines(id),
  is_rvd boolean not null default false,   -- подработка РВД в чужой смене
  from_at timestamptz not null default now(),
  to_at timestamptz
);

-- Замеры мастера: значение счётчика станка на текущий момент.
-- client_uuid генерируется на телефоне -> идемпотентная синхронизация (без дублей).
create table if not exists production_entries (
  client_uuid uuid primary key,
  session_id uuid not null references shift_sessions(id),
  machine_id uuid not null references machines(id),
  operation text not null,
  part_id uuid references parts(id),
  kind entry_kind not null default 'counter',
  counter_value int,                       -- для kind=counter
  reason text,                             -- для downtime: «нет задела», «ожидание ремонта ШВП»
  note text,
  recorded_by uuid not null references profiles(id),
  recorded_at timestamptz not null,        -- время замера (не синхронизации!)
  synced_at timestamptz not null default now()
);
create index if not exists idx_pe_session on production_entries(session_id, machine_id, operation, recorded_at);

create table if not exists changeovers (
  client_uuid uuid primary key,
  session_id uuid not null references shift_sessions(id),
  machine_id uuid not null references machines(id),
  from_part_id uuid references parts(id),
  to_part_id uuid references parts(id),
  at timestamptz not null,
  recorded_by uuid not null references profiles(id),
  note text
);

create table if not exists report_logs (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references shift_sessions(id),
  type report_type not null,
  period_label text not null,             -- «на 11:00» / «итог смены»
  body text not null,                     -- отправленный текст
  generated_at timestamptz not null default now(),
  shared_at timestamptz,
  shared_by uuid references profiles(id)
);

-- ---------- Настройки ----------
create table if not exists settings (
  key text primary key,
  value text not null
);
insert into settings(key,value) values
  ('report_lead_minutes','15'),
  ('report_title_prefix','СК Линия')
on conflict do nothing;

-- ---------- Вычисляемая выработка (вид) ----------
-- «за час / накоплено» по каждому станку+току на момент замера:
create or replace view v_hourly_output as
with d as (
  select e.*,
    lag(counter_value) over w as prev_val,
    date_trunc('hour', recorded_at at time zone 'utc') at time zone 'utc' as hr
  from production_entries e
  where kind='counter'
  window w as (partition by session_id, machine_id, operation
               order by recorded_at, synced_at)
)
select session_id, machine_id, operation, hr,
  sum(greatest(coalesce(counter_value - prev_val, counter_value), 0)) as per_hour,
  max(counter_value) as accumulated
from d group by 1,2,3,4;

-- ---------- RLS ----------
alter table profiles enable row level security;
alter table shifts enable row level security;
alter table machines enable row level security;
alter table people enable row level security;
alter table parts enable row level security;
alter table part_operation_plans enable row level security;
alter table part_plan_history enable row level security;
alter table shift_sessions enable row level security;
alter table session_masters enable row level security;
alter table assignments enable row level security;
alter table production_entries enable row level security;
alter table changeovers enable row level security;
alter table report_logs enable row level security;
alter table settings enable row level security;

-- профили: каждый видит всех, редактирует себя; админ — всех
drop policy if exists prof_read on profiles;
create policy prof_read on profiles for select using (true);
drop policy if exists prof_self_update on profiles;
create policy prof_self_update on profiles for update using (id = auth.uid());
drop policy if exists prof_admin_write on profiles;
create policy prof_admin_write on profiles for all
  using (current_user_role()='admin') with check (current_user_role()='admin');

-- справочники: чтение всем, редактирование admin+master
drop policy if exists dict_read on shifts;      create policy dict_read on shifts      for select using (true);
drop policy if exists dict_rw_adm on machines;  create policy dict_rw_adm on machines
  using (current_user_role() in ('admin','master')) with check (current_user_role() in ('admin','master'));
drop policy if exists dict_read_machines on machines; create policy dict_read_machines on machines for select using (true);
drop policy if exists dict_read_people on people; create policy dict_read_people on people for select using (true);
drop policy if exists dict_rw_people on people;  create policy dict_rw_people on people
  using (current_user_role() in ('admin','master')) with check (current_user_role() in ('admin','master'));
drop policy if exists dict_read_parts on parts;  create policy dict_read_parts on parts for select using (true);
drop policy if exists dict_rw_parts on parts;    create policy dict_rw_parts on parts
  using (current_user_role() in ('admin','master')) with check (current_user_role() in ('admin','master'));
drop policy if exists dict_read_shifts_wr on shifts; create policy dict_read_shifts_wr on shifts
  using (current_user_role() in ('admin','master')) with check (current_user_role() in ('admin','master'));
drop policy if exists plans_read on part_operation_plans; create policy plans_read on part_operation_plans for select using (true);
drop policy if exists plans_rw on part_operation_plans;   create policy plans_rw on part_operation_plans
  using (current_user_role() in ('admin','master')) with check (current_user_role() in ('admin','master'));
drop policy if exists plans_hist on part_plan_history;    create policy plans_hist on part_plan_history
  for all using (current_user_role() in ('admin','master')) with check (current_user_role() in ('admin','master'));

-- смены: читать могут все участники; создавать/править — админ или дежурный мастер
drop policy if exists ss_read on shift_sessions; create policy ss_read on shift_sessions for select using (true);
drop policy if exists ss_write on shift_sessions; create policy ss_write on shift_sessions
  for all using (is_duty_master(id)) with check (current_user_role() in ('admin','master'));
drop policy if exists sm_read on session_masters; create policy sm_read on session_masters for select using (true);
drop policy if exists sm_write on session_masters; create policy sm_write on session_masters
  for all using (is_duty_master(session_id)) with check (is_duty_master(session_id));

-- расстановка: чтение всем; правка дежурным мастером смены или админом
drop policy if exists asg_read on assignments; create policy asg_read on assignments for select using (true);
drop policy if exists asg_write on assignments; create policy asg_write on assignments
  for all using (is_duty_master(session_id)) with check (is_duty_master(session_id));

-- замеры: вставка своим именем в свою дежурную смену; правка/чтение — только своей смены (админ — всё)
drop policy if exists pe_ins on production_entries; create policy pe_ins on production_entries
  for insert with check (recorded_by = auth.uid() and is_duty_master(session_id));
drop policy if exists pe_upd on production_entries; create policy pe_upd on production_entries
  for update using (is_duty_master(session_id)) with check (is_duty_master(session_id));
drop policy if exists pe_del on production_entries; create policy pe_del on production_entries
  for delete using (is_duty_master(session_id));
drop policy if exists pe_read_own on production_entries; create policy pe_read_own on production_entries
  for select using (
    current_user_role() = 'admin'
    or is_duty_master(session_id)
    or recorded_by = auth.uid()
  );

drop policy if exists co_all on changeovers; create policy co_all on changeovers
  for all using (is_duty_master(session_id)) with check (is_duty_master(session_id));
drop policy if exists co_read on changeovers; create policy co_read on changeovers for select using (true);

drop policy if exists rl_read on report_logs; create policy rl_read on report_logs for select using (true);
drop policy if exists rl_write on report_logs; create policy rl_write on report_logs
  for all using (is_duty_master(session_id)) with check (is_duty_master(session_id));

drop policy if exists set_read on settings; create policy set_read on settings for select using (true);
drop policy if exists set_write on settings; create policy set_write on settings
  for all using (current_user_role() in ('admin','master')) with check (current_user_role() in ('admin','master'));

-- ---------- Демо-данные (удалить на боевой базе) ----------
insert into shifts(code,name) values ('А','А'),('Б','Б'),('В','В'),('Г','Г') on conflict do nothing;
insert into machines(sort_order,model,vais,grp) values
 (0,'СК 1680','ВАИС 003','line'),
 (1,'СК 61125','ВАИС 003','line'),
 (2,'Neway VNL80HA','ВАИС 003','line'),
 (4,'V760','ВАИС 003','line'),
 (6,'Vturn-46','ВАИС 003','line'),
 (8,'Wia 800','ВАИС 003','line'),
 (10,'Lunan CK611','ВАИС 305','line'),
 (12,'VL40','ВАИС 304','line'),
 (13,'Фрезер Arix V700','ВАИС 003','line'),
 (20,'Kafo большой','ВАИС 304','rmu'),
 (30,'1Л532Ф3 (Фланец 1400)','ВАИС 304','carousel'),
 (31,'1Л532Ф1 (Фланец 1400)',null,'carousel')
on conflict do nothing;
