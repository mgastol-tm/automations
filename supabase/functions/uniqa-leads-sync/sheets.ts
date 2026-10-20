// The two Google Sheets calls this function makes. B2C-457.

import { getAccessToken, ServiceAccount } from "./googleAuth.ts"

const API = "https://sheets.googleapis.com/v4/spreadsheets"

export interface SheetTarget {
  spreadsheetId: string;
  tab: string;
  sa: ServiceAccount;
}

const call = async (
  target: SheetTarget,
  path: string,
  init: RequestInit,
): Promise<unknown> => {
  const token = await getAccessToken(target.sa)
  const res = await fetch(`${API}/${target.spreadsheetId}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  })
  if (!res.ok) {
    throw new Error(`sheets ${path} failed: ${res.status} ${await res.text()}`)
  }
  return res.json()
}

// `USER_ENTERED` would let Sheets reinterpret "44-144" as a date and
// "48501731688" as a float. RAW keeps every cell exactly as written.
export const appendRows = (target: SheetTarget, rows: string[][]): Promise<unknown> =>
  call(
    target,
    `/values/${encodeURIComponent(target.tab)}!A:Z:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { method: "POST", body: JSON.stringify({ values: rows }) },
  )

export const clearTab = (target: SheetTarget): Promise<unknown> =>
  call(target, `/values/${encodeURIComponent(target.tab)}!A:Z:clear`, { method: "POST" })
