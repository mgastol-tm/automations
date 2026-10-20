// B2C-457 — keep a Google Sheet of UNIQA insurance leads in step with Supabase.
//
// Two entry points, one handler:
//
//   1. A Supabase database webhook POSTs here on every INSERT into
//      `user_requests`. Rows that are not `uniqa_insurance_lead` are ignored
//      and answered 200, because a webhook that 4xx's gets retried forever.
//   2. `POST ?mode=rebuild` clears the tab and writes every lead from scratch.
//      Needed for the first fill, and for recovery after a failed append.
//
// Auth: every request must carry `x-uniqa-webhook-secret`. The rows hold a
// phone number, a postal code and a city, so this function is never public.

import { hasConfirmedPayload, rowsFromWebhook, toSheetRow, HEADER, UNIQA_REQUEST_TYPE, UserRequestRow, WebhookPayload } from "./leadRow.ts"
import { appendRows, clearTab, SheetTarget } from "./sheets.ts"

const env = (name: string): string => Deno.env.get(name) ?? ""

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })

// Length-independent compare. The secret is short and the attacker controls the
// guess, so a plain `===` leaks its length through timing.
const secretMatches = (given: string, expected: string): boolean => {
  if (expected.length === 0) return false
  const a = new TextEncoder().encode(given)
  const b = new TextEncoder().encode(expected)
  let diff = a.length ^ b.length
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  }
  return diff === 0
}

const readTarget = (): SheetTarget => ({
  spreadsheetId: env("UNIQA_SHEETS_SPREADSHEET_ID"),
  tab: env("UNIQA_SHEETS_TAB") || "Leads",
  sa: {
    email: env("GOOGLE_SERVICE_ACCOUNT_EMAIL"),
    privateKey: env("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY"),
  },
})

const missingConfig = (t: SheetTarget): string[] => {
  const missing: string[] = []
  if (!t.spreadsheetId) missing.push("UNIQA_SHEETS_SPREADSHEET_ID")
  if (!t.sa.email) missing.push("GOOGLE_SERVICE_ACCOUNT_EMAIL")
  if (!t.sa.privateKey) missing.push("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY")
  return missing
}

// RLS denies anon SELECT on `user_requests` (patient-dashboard migration
// 20260921113910), so the rebuild reads with the service-role key.
const fetchAllLeads = async (): Promise<UserRequestRow[]> => {
  const base = env("SUPABASE_URL")
  const key = env("SUPABASE_SERVICE_ROLE_KEY")
  const out: UserRequestRow[] = []
  const pageSize = 1000
  for (let offset = 0; ; offset += pageSize) {
    const url = `${base}/rest/v1/user_requests` +
      `?select=created_at,email,request_type,phone,metadata` +
      `&request_type=eq.${UNIQA_REQUEST_TYPE}` +
      // Skip the pre-B2C-457 one-step leads. See hasConfirmedPayload().
      `&metadata->>postal_code=not.is.null` +
      `&order=created_at.asc` +
      `&offset=${offset}&limit=${pageSize}`
    const res = await fetch(url, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    })
    if (!res.ok) {
      throw new Error(`supabase read failed: ${res.status} ${await res.text()}`)
    }
    const page = await res.json() as UserRequestRow[]
    out.push(...page)
    if (page.length < pageSize) return out
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return json(405, { error: "POST only" })
  }
  if (!secretMatches(req.headers.get("x-uniqa-webhook-secret") ?? "", env("UNIQA_WEBHOOK_SECRET"))) {
    return json(401, { error: "bad or missing x-uniqa-webhook-secret" })
  }

  const target = readTarget()
  const missing = missingConfig(target)
  if (missing.length > 0) {
    console.error("[uniqa-leads-sync] missing config", missing)
    return json(500, { error: "function is not configured", missing })
  }

  const mode = new URL(req.url).searchParams.get("mode")

  try {
    if (mode === "rebuild") {
      // Filtered twice on purpose: once in the query, once here. A PostgREST
      // syntax change must not silently start exporting unconfirmed leads.
      const leads = (await fetchAllLeads()).filter(hasConfirmedPayload)
      await clearTab(target)
      await appendRows(target, [HEADER as string[], ...leads.map(toSheetRow)])
      return json(200, { ok: true, mode: "rebuild", rows: leads.length })
    }

    const payload = await req.json().catch(() => null) as WebhookPayload | null
    const rows = rowsFromWebhook(payload)
    if (rows.length === 0) {
      // Not a UNIQA lead, or a lead with no confirmed payload. 200 on purpose:
      // the webhook fires for every `user_requests` insert, and a non-2xx
      // would queue endless retries.
      return json(200, { ok: true, skipped: true })
    }
    await appendRows(target, rows)
    return json(200, { ok: true, appended: rows.length })
  } catch (e) {
    // 500 so the webhook retries. The lead is already safe in Postgres; the
    // sheet is the copy, and `?mode=rebuild` repairs any row this drops.
    console.error("[uniqa-leads-sync]", e)
    return json(500, { error: String(e) })
  }
})
