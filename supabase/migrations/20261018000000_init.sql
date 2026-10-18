-- Cadence: accounts, songs, daily limits and audio storage.
-- Users sign in with Supabase Auth. The `api` Edge Function (service role) does all
-- writes except deleting your own songs; the browser reads its own rows through RLS.

-- One profile per user. `approved` is set by the api function once a valid invite code is seen.
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  approved boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.daily_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  day date not null,
  songs integer not null default 0,
  lyrics integer not null default 0,
  primary key (user_id, day)
);

create table public.songs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null,
  tags text not null default '',
  duration integer not null,
  status text not null default 'pending' check (status in ('pending', 'ready', 'failed')),
  audio_path text,
  error text,
  request jsonb not null,
  created_at timestamptz not null default now()
);
create index songs_user_created_idx on public.songs (user_id, created_at desc);

alter table public.profiles enable row level security;
alter table public.daily_usage enable row level security;
alter table public.songs enable row level security;

create policy "read own profile" on public.profiles
  for select to authenticated using ((select auth.uid()) = id);
create policy "read own usage" on public.daily_usage
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "read own songs" on public.songs
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "delete own songs" on public.songs
  for delete to authenticated using ((select auth.uid()) = user_id);

-- Create a profile for every new user.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id) values (new.id);
  return new;
end;
$$;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Atomically take up to p_want units of today's allowance; returns how many were granted.
-- Negative p_want gives units back (used when a generation fails).
create function public.consume_quota(p_user uuid, p_kind text, p_want integer, p_limit integer) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  today date := (now() at time zone 'utc')::date;
  used integer;
  granted integer;
begin
  if p_kind not in ('songs', 'lyrics') then
    raise exception 'unknown quota kind %', p_kind;
  end if;
  insert into public.daily_usage (user_id, day) values (p_user, today) on conflict do nothing;
  select case when p_kind = 'songs' then songs else lyrics end into used
    from public.daily_usage where user_id = p_user and day = today for update;
  if p_want < 0 then
    granted := -least(-p_want, used);
  else
    granted := greatest(0, least(p_want, p_limit - used));
  end if;
  if granted <> 0 then
    if p_kind = 'songs' then
      update public.daily_usage set songs = songs + granted where user_id = p_user and day = today;
    else
      update public.daily_usage set lyrics = lyrics + granted where user_id = p_user and day = today;
    end if;
  end if;
  return granted;
end;
$$;
revoke execute on function public.consume_quota(uuid, text, integer, integer) from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- Public bucket for finished MP3s, stored as <user id>/<song id>.mp3 under unguessable names.
-- No select policy, so the bucket can't be listed; files are fetched by their public URL.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('songs', 'songs', true, 52428800, array['audio/mpeg']);

create policy "delete own song files" on storage.objects
  for delete to authenticated
  using (bucket_id = 'songs' and (storage.foldername(name))[1] = (select auth.uid())::text);
