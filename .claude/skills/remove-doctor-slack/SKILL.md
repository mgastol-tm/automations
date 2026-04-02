---
name: remove-doctor-slack
description: Remove doctor from a Slack thread link - reads thread via Chrome DevTools, extracts doctor info, hides in Supabase, refreshes listing pages, submits Search Console removal, replies in Slack. Use when user pastes a Slack thread URL.
---

# Remove Doctor from Slack Thread

User pastes a Slack thread URL. This skill opens it in Chrome, reads the thread content, extracts doctor name/link, performs the full removal flow (hide in DB, refresh listing pages, Search Console removal), then replies in the Slack thread confirming completion.

## Step 1: Read the Slack thread

1. Navigate to the Slack thread URL using Chrome DevTools MCP:
   ```
   mcp__chrome-devtools__navigate_page → SLACK_THREAD_URL
   ```

2. Wait for the page to load, then take a snapshot:
   ```
   mcp__chrome-devtools__take_snapshot
   ```

3. Extract from the thread content:
   - **Doctor profile URLs**: look for `telemedi.com/pl/lekarze/SLUG` patterns
   - **Doctor names**: if no URL, look for Polish first+last name patterns (may include titles like "lek.", "dr", compound last names like "Rumianek-Fidziukiewicz")
   - Note: the thread is typically a forwarded email from Beata about a doctor removal request

## Step 2: Find doctor in Supabase

Load env and search:

```bash
source .env

# If slug was found from URL:
curl -s "https://prheuenegkpayiskjysx.supabase.co/rest/v1/doctors?slug=eq.SLUG&select=id,first_name,last_name,slug,is_hidden" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
```

If only a name was found, construct slug as `firstname-lastname` (lowercase, Polish chars → ASCII) and search by slug. If not found, try `last_name=ilike.LASTNAME` as fallback.

**IMPORTANT**: Always search by `slug=eq.SLUG` (exact match) first. Do NOT use `ilike` on slug — it times out.

## Step 3: Hide doctor in Supabase

```bash
source .env
curl -s -X PATCH "https://prheuenegkpayiskjysx.supabase.co/rest/v1/doctors?id=eq.DOCTOR_UUID" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" -H "Prefer: return=representation" \
  -d '{"is_hidden": true}'
```

If already hidden (`is_hidden: true`), skip and note "already hidden".

### Refresh listing pages

After hiding the doctor, refresh the `doctor_search_view` materialized view so the doctor disappears from listing/category pages (e.g. `/pl/lekarze/lekarz-ogolny/ostaszewo`):

```bash
source .env
curl -s -X POST "https://prheuenegkpayiskjysx.supabase.co/rest/v1/rpc/schedule_doctor_search_view_refresh" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{}'
```

This schedules a pg_cron background job (~8 min to complete). It auto-unschedules after running.

## Step 4: Request URL removal from Google Search Console

1. Navigate to Search Console removals page:
   ```
   mcp__chrome-devtools__navigate_page → https://search.google.com/search-console/removals?resource_id=sc-domain%3Atelemedi.com
   ```

2. If there's a notification banner, dismiss it.

3. Submit removal:
   a. `mcp__chrome-devtools__click` the "NOWA PROŚBA" button
   b. `mcp__chrome-devtools__take_snapshot` to find the textbox
   c. `mcp__chrome-devtools__fill` the textbox with `https://telemedi.com/pl/lekarze/{slug}`
   d. "Usuń tylko ten URL" radio is selected by default — leave it
   e. `mcp__chrome-devtools__click` the NASTĘPNE button
   f. Confirmation dialog "Usunąć URL?" appears — the "PRZEŚLIJ PROŚBĘ" button does NOT respond to `mcp__chrome-devtools__click`. Use `mcp__chrome-devtools__evaluate_script` instead: `(el) => { el.click(); return 'clicked'; }` with args `["BUTTON_UID"]`
   g. Take snapshot to confirm "Przesłano prośbę" toast and new entry in table

## Step 5: Reply in Slack thread

1. Navigate back to the Slack thread URL:
   ```
   mcp__chrome-devtools__navigate_page → SLACK_THREAD_URL
   ```

2. Take snapshot to find the message input field in the thread.

3. Type the reply using `mcp__chrome-devtools__fill` or `mcp__chrome-devtools__type_text` on the message input:
   ```
   Usunięta ✅
   ```

4. Press Enter to send:
   ```
   mcp__chrome-devtools__press_key → Enter
   ```

## Completion

Print a short summary:

| Doctor | Slug | DB Hidden | Listing Pages | Search Console | Slack Reply |
|---|---|---|---|---|---|
| First Last | slug | yes/already | scheduled | submitted | sent |
