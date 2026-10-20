// Runs under `node --test` (Node strips the types). The module under test
// imports nothing, which is why it can be exercised without a Deno runtime.

import test from "node:test"
import assert from "node:assert/strict"

import { HEADER, isUniqaLead, rowsFromWebhook, toSheetRow } from "./leadRow.ts"

const lead = {
  created_at: "2026-10-20T09:27:00+02:00",
  request_type: "uniqa_insurance_lead",
  phone: "48501731688",
  metadata: {
    age: 100,
    postal_code: "44-144",
    city: "Gliwice",
    user_id: "4285e44f-8025-41b0-ab5a-c1ee65706444",
    page_url: "/pl",
    source: "pd_home_popup",
    flag_key: "pd.uniqa-insurance-offer",
    host: "panel.telemedi.com",
  },
}

test("the row matches the header, column for column", () => {
  const row = toSheetRow(lead)
  assert.equal(row.length, HEADER.length)
  assert.deepEqual(row, [
    "2026-10-20T09:27:00+02:00",
    "48501731688",
    "100",
    "44-144",
    "Gliwice",
    "4285e44f-8025-41b0-ab5a-c1ee65706444",
    "/pl",
    "pd_home_popup",
    "pd.uniqa-insurance-offer",
    "panel.telemedi.com",
  ])
})

test("every cell is a string, so Sheets cannot reinterpret a phone or a postal code", () => {
  for (const cell of toSheetRow(lead)) {
    assert.equal(typeof cell, "string")
  }
})

test("a missing metadata block still produces a full-width row", () => {
  const row = toSheetRow({ created_at: "x", request_type: "uniqa_insurance_lead", phone: "1" })
  assert.equal(row.length, HEADER.length)
  assert.deepEqual(row.slice(2), ["", "", "", "", "", "", "", ""])
})

test("a null age renders empty, not the text 'null'", () => {
  const row = toSheetRow({ ...lead, metadata: { ...lead.metadata, age: null } })
  assert.equal(row[HEADER.indexOf("age")], "")
})

test("age 0 renders as 0, not as empty", () => {
  const row = toSheetRow({ ...lead, metadata: { ...lead.metadata, age: 0 } })
  assert.equal(row[HEADER.indexOf("age")], "0")
})

test("isUniqaLead only accepts the uniqa request type", () => {
  assert.equal(isUniqaLead(lead), true)
  assert.equal(isUniqaLead({ ...lead, request_type: "review" }), false)
  assert.equal(isUniqaLead(null), false)
})

test("the webhook maps an INSERT of a uniqa lead to one row", () => {
  const rows = rowsFromWebhook({ type: "INSERT", table: "user_requests", record: lead })
  assert.equal(rows.length, 1)
  assert.equal(rows[0][1], "48501731688")
})

test("the webhook ignores another feature's row on the shared table", () => {
  // user_requests also carries review, doctor_recruitment_lead,
  // medical_packages_lead and availability_notify.
  const rows = rowsFromWebhook({
    type: "INSERT",
    table: "user_requests",
    record: { ...lead, request_type: "medical_packages_lead" },
  })
  assert.deepEqual(rows, [])
})

test("the webhook ignores UPDATE and DELETE", () => {
  assert.deepEqual(rowsFromWebhook({ type: "UPDATE", table: "user_requests", record: lead }), [])
  assert.deepEqual(rowsFromWebhook({ type: "DELETE", table: "user_requests", record: lead }), [])
})

test("the webhook ignores another table", () => {
  assert.deepEqual(
    rowsFromWebhook({ type: "INSERT", table: "pd_popup_dismissals", record: lead }),
    [],
  )
})

test("the webhook survives an empty body", () => {
  assert.deepEqual(rowsFromWebhook(null), [])
  assert.deepEqual(rowsFromWebhook({}), [])
})

test("the header never carries a region column", () => {
  // B2C-457 dropped the derived voivodeship: the 2-digit postal prefix table
  // was wrong at every voivodeship border.
  assert.equal(HEADER.includes("voivodeship"), false)
  assert.equal(HEADER.includes("postal_code"), true)
  assert.equal(HEADER.includes("city"), true)
})

test("the header never carries an email column", () => {
  assert.equal(HEADER.includes("email"), false)
})

test("the header carries host, because staging and prod share one Supabase project", () => {
  assert.equal(HEADER.includes("host"), true)
  // Appended last on purpose: inserting a column anywhere else shifts every
  // historical row under the wrong header.
  assert.equal(HEADER[HEADER.length - 1], "host")
})
