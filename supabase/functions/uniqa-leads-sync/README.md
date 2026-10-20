# `uniqa-leads-sync`

Keeps a Google Sheet in step with the UNIQA insurance leads in Supabase. B2C-457.

A patient accepts the second UNIQA popup in the patient dashboard. The dashboard
inserts one row into `public.user_requests` with `request_type =
'uniqa_insurance_lead'`. A trigger queues a `pg_net` POST to this function, and
this function appends one row to the sheet. The sheet is therefore current
within a second of the lead, with no scheduled job.

## Two modes

| Call | What it does |
|---|---|
| `POST /uniqa-leads-sync` with a webhook body | Appends the one new lead. |
| `POST /uniqa-leads-sync?mode=rebuild` | Clears the tab, writes the header, writes every lead from the start. |

Use `rebuild` for the first fill and to repair the sheet after any failed
append. The function is safe to rebuild at any time: Postgres holds the record,
the sheet is only a copy.

**The function is never public.** Every request must carry
`x-uniqa-webhook-secret`. The rows hold a phone number, a postal code and a
city.

## Sheet columns

```
created_at | phone | age | postal_code | city | user_id | page_url | source | flag_key | host
```

Every cell is written as text with `valueInputOption=RAW`. As a number,
`48501731688` renders in scientific notation and `44-144` turns into a date.

Append new columns at the **end** only. Any other position silently shifts
every historical row under the wrong header.

## Staging and production share one Supabase project

Verified from the deployed bundles on 2026-10-20, not assumed:

```
staging-dashboard.tmdi04.com  → prheuenegkpayiskjysx.supabase.co
panel.telemedi.com            → prheuenegkpayiskjysx.supabase.co
```

The org also holds `mceuejcqvsoujywccflz` ("Telemedi B2C (Staging)"), which the
patient dashboard does not use. `VITE_SUPABASE_URL` is one repo-level GitHub
secret, consumed by a single Build step with no `environment:` key, so the
master, preprod and production builds all bake in the same URL.

**Consequence: every staging test lead lands in the same table as the real
ones, and therefore in the same sheet.** The `host` column is the only field
that separates them. Filter on `host = panel.telemedi.com` before sending
anything to UNIQA.

## Setup

### 1. The Google service account

1. Create a service account in the Google Cloud project.
2. Enable the Google Sheets API on that project.
3. Create a JSON key and keep `client_email` and `private_key`.
4. Create the spreadsheet.
5. Share the spreadsheet with the service account's `client_email`, as **Editor**.
   The function cannot create or find a sheet it was not given.
6. Name the tab `Leads`, or set `UNIQA_SHEETS_TAB`.

The service account needs no domain-wide delegation. It acts as itself, and the
sheet is shared with it like with any other user.

### 2. Function secrets

```bash
supabase secrets set \
  UNIQA_SHEETS_SPREADSHEET_ID=<id from the sheet URL> \
  UNIQA_SHEETS_TAB=Leads \
  GOOGLE_SERVICE_ACCOUNT_EMAIL=<client_email> \
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY="$(cat key.json | jq -r .private_key)" \
  UNIQA_WEBHOOK_SECRET=<a fresh random string>
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected by the platform. The
rebuild mode reads with the service-role key because RLS denies anon `SELECT`
on `user_requests` (patient-dashboard migration `20260921113910`).

### 3. Deploy

```bash
supabase functions deploy uniqa-leads-sync --no-verify-jwt
```

`--no-verify-jwt` is required: the caller is Postgres, which presents the shared
secret header rather than a user JWT.

### 4. Vault secrets for the trigger

Run once in the SQL editor, with the same secret as above:

```sql
select vault.create_secret(
  'https://<project-ref>.supabase.co/functions/v1/uniqa-leads-sync',
  'uniqa_leads_sync_url');
select vault.create_secret('<UNIQA_WEBHOOK_SECRET>', 'uniqa_leads_sync_secret');
```

Then apply `supabase/migrations/20261020120000_b2c457_uniqa_lead_sheet_webhook.sql`.

The trigger reads both from Vault at call time, so neither value is committed to
this repo nor captured by `pg_dump`.

### 5. First fill

```bash
curl -X POST "https://<project-ref>.supabase.co/functions/v1/uniqa-leads-sync?mode=rebuild" \
  -H "x-uniqa-webhook-secret: <UNIQA_WEBHOOK_SECRET>"
```

## Tests

```bash
node --test "supabase/functions/uniqa-leads-sync/*.test.ts"
```

`leadRow.ts` and `googleAuth.ts` import nothing, so both run under Node's type
stripping without a Deno runtime. The auth test generates a real RSA key pair
and verifies the signed assertion, which is the part that otherwise fails in
production with an opaque `invalid_grant`.

`index.ts` and `sheets.ts` are not covered: they need `Deno.serve` and a live
Google endpoint.

## Failure behaviour

| Failure | Result |
|---|---|
| Google is down | The function returns 500, the lead stays in Postgres, `rebuild` repairs the sheet. |
| Vault secrets missing | The trigger raises a warning and the INSERT still commits. |
| A row that is not a UNIQA lead | 200 with `skipped: true`. `user_requests` is shared with `review`, `doctor_recruitment_lead`, `medical_packages_lead` and `availability_notify`; a non-2xx would queue endless retries for all of them. |
| Wrong or missing secret | 401. |
