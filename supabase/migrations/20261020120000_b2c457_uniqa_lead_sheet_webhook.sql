-- B2C-457 — push every new UNIQA insurance lead to the Google Sheet.
--
-- Why a hand-written trigger and not a dashboard webhook: a dashboard webhook
-- stores the shared secret inside the trigger definition, which then shows up
-- in `pg_dump` and in every migration diff. This reads the URL and the secret
-- from Vault at call time, so neither value is ever committed or dumped.
--
-- The trigger MUST NOT be able to fail an insert. The lead in `user_requests`
-- is the source of truth and the sheet is a copy, so every failure path here
-- swallows its error and lets the INSERT commit. A lead that misses the sheet
-- is recovered with `POST /uniqa-leads-sync?mode=rebuild`.

create extension if not exists pg_net with schema extensions;

-- Two Vault secrets. Create them once per project:
--   select vault.create_secret('https://<ref>.supabase.co/functions/v1/uniqa-leads-sync',
--                              'uniqa_leads_sync_url');
--   select vault.create_secret('<the same value as the UNIQA_WEBHOOK_SECRET
--                               function secret>', 'uniqa_leads_sync_secret');

create or replace function public.notify_uniqa_lead_sync()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  fn_url text;
  fn_secret text;
begin
  if new.request_type is distinct from 'uniqa_insurance_lead' then
    return new;
  end if;

  select decrypted_secret into fn_url
  from vault.decrypted_secrets where name = 'uniqa_leads_sync_url';

  select decrypted_secret into fn_secret
  from vault.decrypted_secrets where name = 'uniqa_leads_sync_secret';

  if fn_url is null or fn_secret is null then
    raise warning '[uniqa] sheet sync skipped: vault secrets missing';
    return new;
  end if;

  -- pg_net is asynchronous: this queues the request and returns at once, so an
  -- unreachable Google or a cold edge function never slows down the patient's
  -- popup.
  perform net.http_post(
    url := fn_url,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-uniqa-webhook-secret', fn_secret
    ),
    body := jsonb_build_object(
      'type', 'INSERT',
      'table', tg_table_name,
      'schema', tg_table_schema,
      'record', to_jsonb(new)
    ),
    timeout_milliseconds := 5000
  );

  return new;
exception when others then
  -- Never block the write. The sheet is the copy; Postgres is the record.
  raise warning '[uniqa] sheet sync failed: %', sqlerrm;
  return new;
end;
$$;

drop trigger if exists trg_uniqa_lead_sheet_sync on public.user_requests;

create trigger trg_uniqa_lead_sheet_sync
after insert on public.user_requests
for each row
when (new.request_type = 'uniqa_insurance_lead')
execute function public.notify_uniqa_lead_sync();

comment on function public.notify_uniqa_lead_sync() is
  'B2C-457: queues a pg_net POST to the uniqa-leads-sync edge function on every new UNIQA lead. Never raises.';
