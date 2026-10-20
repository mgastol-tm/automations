// Google service-account access token, minted with WebCrypto only.
//
// No npm or esm.sh dependency: Deno and Node both ship `crypto.subtle`, so the
// RS256 signature is built by hand. That keeps the edge function's import graph
// empty, which matters because a cold start pays for every remote import.
// B2C-457.

const TOKEN_URL = "https://oauth2.googleapis.com/token"
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets"
const TOKEN_LIFETIME_S = 3600

const b64url = (bytes: Uint8Array): string => {
  let binary = ""
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

const b64urlJson = (value: unknown): string =>
  b64url(new TextEncoder().encode(JSON.stringify(value)))

// Secret managers mangle PEM newlines in three different ways depending on how
// the value was pasted. Accept all of them rather than fail at signing time
// with an opaque DataError.
export const normalisePrivateKey = (raw: string): string =>
  raw.replace(/\\n/g, "\n").replace(/\r\n/g, "\n").trim()

const pemToPkcs8 = (pem: string): Uint8Array => {
  const body = normalisePrivateKey(pem)
    .replace(/-----BEGIN [A-Z ]+-----/, "")
    .replace(/-----END [A-Z ]+-----/, "")
    .replace(/\s+/g, "")
  const binary = atob(body)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i)
  return out
}

export interface ServiceAccount {
  email: string;
  privateKey: string;
}

export const buildAssertion = async (
  sa: ServiceAccount,
  nowSeconds: number,
  scope: string = SHEETS_SCOPE,
): Promise<string> => {
  const header = b64urlJson({ alg: "RS256", typ: "JWT" })
  const claim = b64urlJson({
    iss: sa.email,
    scope,
    aud: TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + TOKEN_LIFETIME_S,
  })
  const signingInput = `${header}.${claim}`
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(sa.privateKey) as unknown as ArrayBuffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  )
  return `${signingInput}.${b64url(new Uint8Array(signature))}`
}

// Cached for the life of the isolate. Google tokens last an hour; a warm
// function that appends one lead per request would otherwise mint one token
// per lead and hit the token endpoint's quota first.
let cached: { token: string; expiresAt: number } | null = null

export const resetTokenCacheForTests = (): void => {
  cached = null
}

export const getAccessToken = async (sa: ServiceAccount): Promise<string> => {
  const now = Math.floor(Date.now() / 1000)
  // 60s of slack so a token never expires mid-flight.
  if (cached && cached.expiresAt > now + 60) return cached.token

  const assertion = await buildAssertion(sa, now)
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  })
  if (!res.ok) {
    throw new Error(`google token request failed: ${res.status} ${await res.text()}`)
  }
  const body = await res.json() as { access_token?: string; expires_in?: number }
  if (!body.access_token) {
    throw new Error("google token response carried no access_token")
  }
  cached = {
    token: body.access_token,
    expiresAt: now + (body.expires_in ?? TOKEN_LIFETIME_S),
  }
  return cached.token
}
