---
name: remove-doctor
description: Batch process emails from b.goslawska@telemedi.com about removing doctors - hide in Supabase, request Google Search Console removal, reply to Beata. Use when user says "remove doctor" or "process doctor removal".
---

# Remove Doctor Command

Batch processes ALL unread emails from b.goslawska@telemedi.com from the last 3 days that contain `telemedi.com/pl/lekarze/` URLs. For each email: hides doctor in Supabase, submits Search Console removal, replies to Beata.

## Configuration

- **Supabase API URL**: `https://prheuenegkpayiskjysx.supabase.co`
- **Supabase Service Role Key**: stored in `.env` as `SUPABASE_SERVICE_ROLE_KEY` — load with `source .env` before running curl commands
- **API Headers** (reuse everywhere, `$SUPABASE_SERVICE_ROLE_KEY` must be set):
  ```
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY"
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY"
  ```

## Step 1: Collect all emails and extract slugs

Run a single Bash script to fetch all unread emails from the last 3 days and extract doctor slugs:

```bash
# List unread messages from Beata in last 3 days
gws gmail users messages list --params '{"userId": "me", "q": "from:b.goslawska@telemedi.com is:unread newer_than:3d"}'
```

Then for EACH message ID, fetch and parse in one script:

```bash
gws gmail users messages get --params '{"userId": "me", "id": "MSG_ID", "format": "full"}' 2>/dev/null | python3 -c "
import json, sys, base64, re
data = json.load(sys.stdin)
msg_id = data['id']
thread_id = data['threadId']
subject = ''
message_id_header = ''
for h in data['payload']['headers']:
    if h['name'] == 'Subject': subject = h['value']
    if h['name'] in ('Message-ID', 'Message-Id'): message_id_header = h['value']

def get_text(payload):
    if 'body' in payload and payload['body'].get('data'):
        return base64.urlsafe_b64decode(payload['body']['data']).decode('utf-8', errors='replace')
    if 'parts' in payload:
        for part in payload['parts']:
            result = get_text(part)
            if result: return result
    return ''

text = get_text(data['payload'])
# Also check HTML parts for URLs
def get_html(payload):
    if payload.get('mimeType') == 'text/html' and payload.get('body', {}).get('data'):
        return base64.urlsafe_b64decode(payload['body']['data']).decode('utf-8', errors='replace')
    for part in payload.get('parts', []):
        result = get_html(part)
        if result: return result
    return ''
html = get_html(data['payload'])
combined = text + ' ' + html

# Extract all doctor slugs from URLs like telemedi.com/pl/lekarze/SLUG
# But skip slugs that are specialization category pages (e.g. lekarz-ogolny/city)
slugs = re.findall(r'telemedi\.com/pl/lekarze/([a-z0-9-]+(?:/[a-z0-9-]+)?)', combined)
# Only keep direct doctor slugs (single segment, no subcategory paths like lekarz-ogolny/city)
doctor_slugs = [s for s in slugs if '/' not in s]
# Deduplicate
doctor_slugs = list(dict.fromkeys(doctor_slugs))

print(json.dumps({'msg_id': msg_id, 'thread_id': thread_id, 'subject': subject, 'message_id_header': message_id_header, 'slugs': doctor_slugs}))
"
```

**IMPORTANT**: Run this for ALL message IDs in parallel to speed things up. Collect a list of `{msg_id, thread_id, subject, message_id_header, slugs[], doctor_names[]}` objects.

### Fallback: extract doctor names when no URL is found

If an email has NO `telemedi.com/pl/lekarze/` URLs, extract the doctor's full name from the **email body text** (the message content written by the person requesting removal). **Do NOT use the sender name from the "Od:"/"From:" header** — the sender may be a different person (e.g. a patient, spouse, or the doctor using a personal email with a nickname like "Kasia" instead of "Katarzyna").

Look for Polish first+last name patterns in the body text. Doctor names are typically capitalized Polish names, may include compound last names (e.g. "Rumianek-Fidziukiewicz", "Dereń-Wagemann"), and may include titles like "lek.", "dr", "dr n. med.". Extract the full professional name as `doctor_names`.

For emails with `doctor_names` but no `slugs`, construct the slug as `firstname-lastname` (lowercase, Polish characters stripped to ASCII equivalents) and search Supabase:

```bash
curl -s "https://prheuenegkpayiskjysx.supabase.co/rest/v1/doctors?slug=eq.CONSTRUCTED-SLUG&select=id,first_name,last_name,slug,is_hidden" \
  -H "apikey: ..." -H "Authorization: Bearer ..."
```

If not found by constructed slug, try searching by last name only using `ilike`:

```bash
curl -s "https://prheuenegkpayiskjysx.supabase.co/rest/v1/doctors?last_name=ilike.LASTNAME&select=id,first_name,last_name,slug,is_hidden" \
  -H "apikey: ..." -H "Authorization: Bearer ..."
```

If multiple results are returned, match against the first name to find the correct doctor. If found, add the slug to the processing list.

Do NOT skip emails just because they lack URLs — only skip if they have neither URLs nor identifiable doctor names.

## Step 2: Hide all doctors in Supabase (batch)

For each unique slug collected, run in parallel:

```bash
# Search by exact slug (fast, uses index)
curl -s "https://prheuenegkpayiskjysx.supabase.co/rest/v1/doctors?slug=eq.SLUG&select=id,first_name,last_name,slug,is_hidden" \
  -H "apikey: ..." -H "Authorization: Bearer ..."
```

Then for each found doctor that has `is_hidden: false`, set hidden:

```bash
curl -s -X PATCH "https://prheuenegkpayiskjysx.supabase.co/rest/v1/doctors?id=eq.DOCTOR_UUID" \
  -H "apikey: ..." -H "Authorization: Bearer ..." \
  -H "Content-Type: application/json" -H "Prefer: return=representation" \
  -d '{"is_hidden": true}'
```

**IMPORTANT**: Always search by `slug=eq.SLUG` (exact match). Do NOT use `ilike` — it times out on this table.

## Step 3: Request URL removals from Google Search Console (batch)

1. Navigate to Search Console removals page ONCE:
   ```
   mcp__chrome-devtools__navigate_page → https://search.google.com/search-console/removals?resource_id=sc-domain%3Atelemedi.com
   ```

2. If there's a notification banner, dismiss it (click "OK" button).

3. For EACH slug, repeat this cycle:
   a. `mcp__chrome-devtools__click` the "NOWA PROŚBA" button (uid for button with text "NOWA PROŚBA")
   b. `mcp__chrome-devtools__take_snapshot` to find the URL textbox in the dialog
   c. `mcp__chrome-devtools__fill` the textbox with `https://telemedi.com/pl/lekarze/{slug}`
   d. "Usuń tylko ten URL" radio is selected by default — leave it
   e. Click NASTĘPNE: `mcp__chrome-devtools__click` the NASTĘPNE button — it works when clicked directly
   f. A confirmation dialog "Usunąć URL?" will appear with "PRZEŚLIJ PROŚBĘ" button. This button does NOT respond to `mcp__chrome-devtools__click` (times out). Use `mcp__chrome-devtools__evaluate_script` with the button's uid instead: `(el) => { el.click(); return 'clicked'; }` with args `["BUTTON_UID"]`
   g. Take snapshot to confirm "Przesłano prośbę" toast appeared and the new entry is in the table
   h. Repeat for next slug

## Step 4: Reply to all emails (batch)

For EACH email that had valid slugs, send a reply. Pick a DIFFERENT random flower emoji for each reply from: 🌸 🌺 🌻 🌹 🌷 💐 🌼 🏵️

```bash
RAW=$(printf "To: b.goslawska@telemedi.com\r\nSubject: Re: ORIGINAL_SUBJECT\r\nIn-Reply-To: ORIGINAL_MESSAGE_ID_HEADER\r\nReferences: ORIGINAL_MESSAGE_ID_HEADER\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nUsunięta FLOWER_EMOJI" | base64 | tr '+/' '-_' | tr -d '\n' | tr -d '=')
gws gmail users messages send --params '{"userId": "me"}' --json "{\"raw\": \"$RAW\", \"threadId\": \"THREAD_ID\"}"
```

## Step 5: Mark as read and archive

After replying, mark each processed email as read and archive it (remove INBOX label):

```bash
gws gmail users messages modify --params '{"userId": "me", "id": "MSG_ID"}' --json '{"removeLabelIds": ["UNREAD", "INBOX"]}'
```

Run this for ALL processed message IDs.

## Completion

Print a summary table:

| Email Subject | Doctor Slug | DB Hidden | Search Console | Reply Sent | Archived |
|---|---|---|---|---|---|
| ... | ... | yes/already/not found | submitted | yes | yes |
