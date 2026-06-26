create table if not exists public.strongwolf_app_state (
  id text primary key,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.strongwolf_app_state enable row level security;

drop policy if exists "strongwolf_app_state_read" on public.strongwolf_app_state;
drop policy if exists "strongwolf_app_state_write" on public.strongwolf_app_state;
drop policy if exists "strongwolf_app_state_insert" on public.strongwolf_app_state;
drop policy if exists "strongwolf_app_state_update" on public.strongwolf_app_state;

-- Lectura: cualquier usuario anónimo puede leer la fila principal
create policy "strongwolf_app_state_read"
on public.strongwolf_app_state
for select
to anon
using (id = 'strongwolf-main');

-- Inserción: permitir crear la fila si no existe
create policy "strongwolf_app_state_insert"
on public.strongwolf_app_state
for insert
to anon
with check (id = 'strongwolf-main');

-- Actualización: permitir actualizar la fila existente
create policy "strongwolf_app_state_update"
on public.strongwolf_app_state
for update
to anon
using (id = 'strongwolf-main')
with check (id = 'strongwolf-main');
