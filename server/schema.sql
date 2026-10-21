-- Run once in the Supabase SQL editor.
create extension if not exists pgcrypto;

create table if not exists meeting_messages (
  id uuid primary key default gen_random_uuid(),
  room_id text not null,
  sender_identity text,
  sender_name text not null,
  message text not null check (char_length(message) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists meeting_messages_room_created
  on meeting_messages (room_id, created_at);

create table if not exists meeting_notes (
  room_id text primary key,
  content text not null default '',
  updated_at timestamptz not null default now()
);

-- Only the server (service-role key) touches these tables.
alter table meeting_messages enable row level security;
alter table meeting_notes enable row level security;
