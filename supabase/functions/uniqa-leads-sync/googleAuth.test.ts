// Runs under `node --test`. Proves the hand-rolled RS256 assertion is a real,
// verifiable JWT — the part most likely to fail silently in production, where
// Google answers with an opaque `invalid_grant`.

import test from "node:test"
import assert from "node:assert/strict"

import { buildAssertion, normalisePrivateKey } from "./googleAuth.ts"

const ALG = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const

const toPem = (pkcs8: ArrayBuffer): string => {
  const b64 = Buffer.from(pkcs8).toString("base64").replace(/(.{64})/g, "$1\n")
  return `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`
}

const makeKeyPair = async () =>
  crypto.subtle.generateKey(
    { ...ALG, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"],
  ) as Promise<CryptoKeyPair>

const decodeSegment = (seg: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(seg.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString())

test("normalisePrivateKey accepts escaped newlines, CRLF and plain PEM", () => {
  const plain = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----"
  assert.equal(normalisePrivateKey(plain), plain)
  assert.equal(normalisePrivateKey(plain.replace(/\n/g, "\\n")), plain)
  assert.equal(normalisePrivateKey(plain.replace(/\n/g, "\r\n")), plain)
  assert.equal(normalisePrivateKey(`  ${plain}  `), plain)
})

test("the assertion is a three-part JWT Google can verify", async () => {
  const { privateKey, publicKey } = await makeKeyPair()
  const pem = toPem(await crypto.subtle.exportKey("pkcs8", privateKey))

  const jwt = await buildAssertion({ email: "sa@project.iam.gserviceaccount.com", privateKey: pem }, 1_700_000_000)
  const [header, claim, signature] = jwt.split(".")
  assert.equal(jwt.split(".").length, 3)

  const ok = await crypto.subtle.verify(
    ALG,
    publicKey,
    Buffer.from(signature.replace(/-/g, "+").replace(/_/g, "/"), "base64"),
    new TextEncoder().encode(`${header}.${claim}`),
  )
  assert.equal(ok, true, "Google must be able to verify the signature")
})

test("the claim carries the fields Google's token endpoint requires", async () => {
  const { privateKey } = await makeKeyPair()
  const pem = toPem(await crypto.subtle.exportKey("pkcs8", privateKey))

  const jwt = await buildAssertion({ email: "sa@project.iam.gserviceaccount.com", privateKey: pem }, 1_700_000_000)
  const claim = decodeSegment(jwt.split(".")[1])

  assert.equal(claim.iss, "sa@project.iam.gserviceaccount.com")
  assert.equal(claim.aud, "https://oauth2.googleapis.com/token")
  assert.equal(claim.scope, "https://www.googleapis.com/auth/spreadsheets")
  assert.equal(claim.iat, 1_700_000_000)
  // Google rejects an assertion whose lifetime exceeds one hour.
  assert.equal(claim.exp, 1_700_003_600)
  assert.ok((claim.exp as number) - (claim.iat as number) <= 3600)
})

test("the header declares RS256, which is the only alg Google accepts here", async () => {
  const { privateKey } = await makeKeyPair()
  const pem = toPem(await crypto.subtle.exportKey("pkcs8", privateKey))

  const jwt = await buildAssertion({ email: "sa@x.iam.gserviceaccount.com", privateKey: pem }, 1)
  assert.deepEqual(decodeSegment(jwt.split(".")[0]), { alg: "RS256", typ: "JWT" })
})

test("a key pasted with escaped newlines signs just as well", async () => {
  const { privateKey, publicKey } = await makeKeyPair()
  const pem = toPem(await crypto.subtle.exportKey("pkcs8", privateKey))
  const mangled = pem.replace(/\n/g, "\\n")

  const jwt = await buildAssertion({ email: "sa@x.iam.gserviceaccount.com", privateKey: mangled }, 42)
  const [header, claim, signature] = jwt.split(".")
  const ok = await crypto.subtle.verify(
    ALG,
    publicKey,
    Buffer.from(signature.replace(/-/g, "+").replace(/_/g, "/"), "base64"),
    new TextEncoder().encode(`${header}.${claim}`),
  )
  assert.equal(ok, true)
})

test("the assertion is base64url, never plain base64", async () => {
  const { privateKey } = await makeKeyPair()
  const pem = toPem(await crypto.subtle.exportKey("pkcs8", privateKey))
  // 2048-bit signatures are 256 bytes, so padding and + / almost always appear
  // in plain base64. Run a few to make the check meaningful.
  for (let i = 0; i < 5; i += 1) {
    const jwt = await buildAssertion({ email: `sa${i}@x.iam.gserviceaccount.com`, privateKey: pem }, i)
    assert.ok(!/[+/=]/.test(jwt), "base64url must not contain + / or =")
  }
})
