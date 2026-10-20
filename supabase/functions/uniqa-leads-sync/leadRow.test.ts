// Runs under `node --test` (Node strips the types). The module under test
// imports nothing, which is why it can be exercised without a Deno runtime.

import test from "node:test"
import assert from "node:assert/strict"

import { HEADER, hasConfirmedPayload, isUniqaLead, rowsFromWebhook, toSheetRow } from "./leadRow.ts"

const lead = {
  created_at: "2026-10-20T09:27:00+02:00",
  email: "patient@telemedi.com",
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
    first_name: "Anna",
    last_name: "Kowalska",
    gender: "female",
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
    "patient@telemedi.com",
    "Anna",
    "Kowalska",
    "female",
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
  // every column after created_at and phone comes from metadata
  assert.deepEqual(row.slice(2), new Array(HEADER.length - 2).fill(""))
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

test("the header carries email, appended last", () => {
  // Reinstated 2026-10-20: UNIQA keeps the email, and it is a NOT NULL column
  // on user_requests, so no lead can exist without one.
  assert.equal(HEADER.includes("email"), true)
  assert.equal(HEADER.indexOf("email"), HEADER.length - 4)
})

test("the header carries host, because staging and prod share one Supabase project", () => {
  assert.equal(HEADER.includes("host"), true)
  // Appended last on purpose: inserting a column anywhere else shifts every
  // historical row under the wrong header.
  assert.equal(HEADER.indexOf("host"), HEADER.length - 5)
})

test("a pre-B2C-457 lead, written before the confirm step existed, is skipped", () => {
  const old = {
    created_at: "2026-10-12T00:45:13Z",
    request_type: "uniqa_insurance_lead",
    phone: "48884252484",
    metadata: {
      source: "pd_home_popup",
      user_id: "b8245490-132a-4d86-a865-528ebb1d827b",
      flag_key: "pd.uniqa-insurance-offer",
      page_url: "/pl",
    },
  }
  assert.equal(hasConfirmedPayload(old), false)
  assert.deepEqual(rowsFromWebhook({ type: "INSERT", table: "user_requests", record: old }), [])
})

test("a confirmed lead passes", () => {
  assert.equal(hasConfirmedPayload(lead), true)
  assert.equal(rowsFromWebhook({ type: "INSERT", table: "user_requests", record: lead }).length, 1)
})

test("an empty postal code does not count as confirmed", () => {
  const blank = { ...lead, metadata: { ...lead.metadata, postal_code: "" } }
  assert.equal(hasConfirmedPayload(blank), false)
})

test("the header carries the name and the sex, appended last", () => {
  assert.deepEqual(HEADER.slice(-3), ["first_name", "last_name", "gender"])
})

test("a female lead renders 'female', not an empty cell", () => {
  // Gender.female is 0 in the dashboard enum, so the payload sends the word,
  // never the number. A 0 here would round-trip into a blank cell.
  const row = toSheetRow(lead)
  assert.equal(row[HEADER.indexOf("gender")], "female")
})

test("a lead with no PESEL renders an empty sex, and still exports", () => {
  const noPesel = { ...lead, metadata: { ...lead.metadata, gender: null } }
  assert.equal(hasConfirmedPayload(noPesel), true)
  assert.equal(toSheetRow(noPesel)[HEADER.indexOf("gender")], "")
})
