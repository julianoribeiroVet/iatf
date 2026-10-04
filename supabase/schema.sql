-- =============================================================================
-- Calendário IATF JS Rural — banco de dados (Supabase / PostgreSQL)
-- Cole este arquivo inteiro em: Supabase → SQL Editor → New query → Run.
-- Pode ser executado de novo sem problemas (idempotente).
-- =============================================================================

-- 1) Membros autorizados ------------------------------------------------------
-- Só quem estiver nesta lista lê e grava os dados, mesmo que consiga criar conta.
create table if not exists public.membros (
  email       text primary key,
  nome        text,
  criado_em   timestamptz not null default now()
);

-- >>> Troque/adicione os e-mails da equipe aqui (sempre em minúsculas) <<<
insert into public.membros (email, nome) values
  ('juliano.ribeirovet1@gmail.com', 'Juliano')
on conflict (email) do nothing;

-- Função usada pelas regras de acesso e pelo app (rpc 'sou_membro')
create or replace function public.sou_membro()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.membros
    where email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
revoke all on function public.sou_membro() from public;
grant execute on function public.sou_membro() to authenticated;

-- 2) Registros do app ---------------------------------------------------------
-- Tabela única e genérica: colecao = lotes | overrides | config | autorizacoes
create table if not exists public.registros (
  colecao         text        not null check (colecao in ('lotes','overrides','config','autorizacoes')),
  id              text        not null check (char_length(id) between 1 and 200),
  dados           jsonb       not null default '{}'::jsonb,
  atualizado_em   timestamptz not null default now(),
  atualizado_por  uuid        default auth.uid(),
  primary key (colecao, id)
);

-- Data/autor da última alteração sempre preenchidos pelo servidor
create or replace function public.registros_carimbo()
returns trigger language plpgsql as $$
begin
  new.atualizado_em := now();
  new.atualizado_por := auth.uid();
  return new;
end $$;
drop trigger if exists trg_registros_carimbo on public.registros;
create trigger trg_registros_carimbo
  before insert or update on public.registros
  for each row execute function public.registros_carimbo();

-- 3) Segurança (Row Level Security) -------------------------------------------
alter table public.registros enable row level security;
alter table public.membros   enable row level security;

drop policy if exists "membros leem registros"    on public.registros;
drop policy if exists "membros inserem registros" on public.registros;
drop policy if exists "membros alteram registros" on public.registros;
drop policy if exists "membros apagam registros"  on public.registros;
create policy "membros leem registros"    on public.registros for select to authenticated using (public.sou_membro());
create policy "membros inserem registros" on public.registros for insert to authenticated with check (public.sou_membro());
create policy "membros alteram registros" on public.registros for update to authenticated using (public.sou_membro()) with check (public.sou_membro());
create policy "membros apagam registros"  on public.registros for delete to authenticated using (public.sou_membro());

-- A lista de membros só é vista/alterada pelo painel do Supabase (nenhuma policy = sem acesso pelo app)

-- 4) Tempo real ---------------------------------------------------------------
-- Envia o registro completo também nas exclusões (o app precisa de colecao + id)
alter table public.registros replica identity full;
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'registros'
  ) then
    alter publication supabase_realtime add table public.registros;
  end if;
end $$;

-- 5) Histórico de alterações (auditoria simples) ------------------------------
-- Guarda a versão anterior de cada registro alterado/apagado — permite recuperar
-- um lote apagado por engano (consulte a tabela registros_historico no painel).
create table if not exists public.registros_historico (
  hid             bigserial primary key,
  colecao         text not null,
  id              text not null,
  dados_antes     jsonb,
  operacao        text not null,
  feito_por       uuid default auth.uid(),
  feito_em        timestamptz not null default now()
);
alter table public.registros_historico enable row level security;

create or replace function public.registros_auditoria()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.registros_historico (colecao, id, dados_antes, operacao)
  values (old.colecao, old.id, old.dados, tg_op);
  return null;
end $$;
drop trigger if exists trg_registros_auditoria on public.registros;
create trigger trg_registros_auditoria
  after update or delete on public.registros
  for each row execute function public.registros_auditoria();
