// Pure mapping from a `user_requests` row to one Google Sheets row.
//
// Kept free of Deno and of network code so it runs under `node --test`.
// Nothing here throws: a malformed row still produces a full-width row, because
// a lead that reaches the sheet with blanks is better than a lead that is lost.
// B2C-457.

export const UNIQA_REQUEST_TYPE = "uniqa_insurance_lead"

// Column order is the contract with the sheet. Append new columns at the END
// only — anything else silently shifts historical rows under their headers.
export const HEADER: readonly string[] = [
  "created_at",
  "phone",
  "age",
  "postal_code",
  "city",
  "user_id",
  "page_url",
  "source",
  "flag_key",
  "host",
  "email",
  "first_name",
  "last_name",
  "gender",
]

export interface UserRequestRow {
  created_at?: string | null;
  email?: string | null;
  request_type?: string | null;
  phone?: string | null;
  metadata?: Record<string, unknown> | null;
}

export const isUniqaLead = (row: UserRequestRow | null | undefined): boolean =>
  !!row && row.request_type === UNIQA_REQUEST_TYPE

// Only leads from the two-step popup belong in the sheet.
//
// The one-step popup that shipped before B2C-457 wrote a lead on the FIRST
// click, so the patient never saw which data left. Those rows carry no
// `postal_code`, and the export skips them: the sheet is what goes to UNIQA,
// and a patient who never saw the handover screen never agreed to it.
//
// `postal_code` is the marker because the confirm step disables its accept
// button until the profile carries both address fields, so every confirmed
// lead has one and no older lead does.
export const hasConfirmedPayload = (row: UserRequestRow | null | undefined): boolean => {
  const meta = (row?.metadata ?? {}) as Record<string, unknown>
  return typeof meta.postal_code === "string" && meta.postal_code !== ""
}

// Sheets stores every cell this function writes as text. A phone number and a
// postal code both lose meaning as numbers: "48501731688" would render in
// scientific notation and "44-144" would become a date in some locales.
const cell = (value: unknown): string => {
  if (value === null || value === undefined) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return JSON.stringify(value)
}

export const toSheetRow = (row: UserRequestRow): string[] => {
  const meta = (row.metadata ?? {}) as Record<string, unknown>
  return [
    cell(row.created_at),
    cell(row.phone),
    cell(meta.age),
    cell(meta.postal_code),
    cell(meta.city),
    cell(meta.user_id),
    cell(meta.page_url),
    cell(meta.source),
    cell(meta.flag_key),
    // Staging and production write to the SAME Supabase project
    // (prheuenegkpayiskjysx). This column is the only way to tell a staging
    // test lead from a real one. Filter the sheet on it.
    cell(meta.host),
    // `email` is a top-level NOT NULL column on user_requests, not a
    // metadata key. Appended last so historical rows keep their alignment.
    cell(row.email),
    // Appended last so every existing row keeps its alignment.
    cell(meta.first_name),
    cell(meta.last_name),
    cell(meta.gender),
  ]
}

// A Supabase database webhook posts this envelope. `record` is the new row.
export interface WebhookPayload {
  type?: string;
  table?: string;
  schema?: string;
  record?: UserRequestRow | null;
}

export const rowsFromWebhook = (payload: WebhookPayload | null | undefined): string[][] => {
  if (!payload || payload.type !== "INSERT") return []
  if (payload.table !== "user_requests") return []
  if (!isUniqaLead(payload.record)) return []
  if (!hasConfirmedPayload(payload.record)) return []
  return [toSheetRow(payload.record as UserRequestRow)]
}
