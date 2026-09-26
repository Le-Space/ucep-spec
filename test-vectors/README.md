# UCEP pairing test vectors (`ucep-pair-v1`)

`pairing-v1.json` holds deterministic test vectors for invitation encoding and the pairing proof.
It is produced by `generate.mjs`, which uses only Node 22 built-ins:

```sh
node test-vectors/generate.mjs
```

Running it again must produce a byte-identical file. All keys are derived from fixed seeds; they are test keys, never use them for anything else.

## Fields

### `keys`

| Field | Meaning |
|---|---|
| `provider`, `consumer`, `consumerDid` `.seedHex` | 32-byte Ed25519 seed = SHA-256 of the UTF-8 label `ucep test vector provider` / `… consumer` / `… consumer did` |
| `.publicKeyHex` | Raw 32-byte Ed25519 public key |
| `.peerId` | libp2p PeerId: base58btc (Bitcoin alphabet, no multibase prefix) of the identity multihash; starts with `12D3KooW` |
| `.peerIdMultihashHex` | `00 24` ‖ `08 01 12 20` ‖ public key (identity multihash of the protobuf `PublicKey`) |
| `consumerDid.did` | `did:key:z` + base58btc(`ed 01` ‖ public key); starts with `did:key:z6Mk` |

### `invitation`

`providerPeerId`, `extensionId`, `invitationId`, `secretHex` (32 bytes = SHA-256 of `ucep test vector invitation secret`), `secretB64url` (base64url, no padding), `expiresAt` (Unix seconds), `scopes` (offered), `multiaddr`, and `uri`, the complete `ucep-pair:` URI. Every query value is encoded with `encodeURIComponent`; the scopes are encoded one by one and joined with a literal `,`.

### `vectors[]`

| Field | Meaning |
|---|---|
| `name`, `description` | What the case tests |
| `now` | Unix time at which the provider evaluates the request |
| `connectionConsumerPeerId` | The consumer's peerId as the provider sees it on the connection |
| `requestedScopes` | Scopes the consumer asks for (unsorted, as sent) |
| `did` | Consumer DID, or `null` |
| `transcript` / `transcriptHex` | Seven lines joined with `\n`, no trailing newline: `ucep-pair-v1`, extensionId, invitationId, provider peerId, consumer peerId, requested scopes sorted by byte order and joined with `,`, DID (empty string if none) |
| `proofHex` | HMAC-SHA256(key = invitation secret, message = transcript bytes) |
| `transcriptHashHex` | SHA-256(transcript bytes) |
| `didSignatureHex` | Present when `did` is set: pure Ed25519 signature by the DID key over the 32 raw bytes of `transcriptHash` |
| `expected` | `GRANTED` or the error code the provider MUST return |

Cases: `with-did` and `without-did` are granted. `wrong-consumer-peer` has the provider's peerId in line 5, so a provider that rebuilds the transcript with `connectionConsumerPeerId` gets a different HMAC → `PAIRING_PROOF_INVALID`. `expired` reuses the `with-did` proof at `now` = `expiresAt` + 1 → `INVITATION_EXPIRED`. `expires-now` evaluates the same proof at exactly `now` = `expiresAt`, which is still valid (`now ≤ expiresAt`) → `GRANTED`. `scope-not-offered` requests `invoice:draft:create` in addition (its proof is valid) → `SCOPE_NOT_OFFERED`.

## How to verify an implementation

1. Derive each key from `seedHex` and compare `publicKeyHex`, `peerId`, `peerIdMultihashHex` and `did`.
2. Build the invitation URI from the `invitation` fields and compare it with `uri`; parse `uri` and get the same fields back.
3. For each vector, as the consumer: build the transcript from the invitation, `requestedScopes`, the consumer peerId and `did`; compare `transcriptHex`, `proofHex`, `transcriptHashHex` and, if present, `didSignatureHex` (Ed25519 is deterministic, so signatures must match byte for byte).
4. For each vector, as the provider: rebuild the transcript with `connectionConsumerPeerId`, check the received `proofHex` with a constant-time comparison, check `now` against `expiresAt`, check `requestedScopes` against the offered scopes, verify `didSignatureHex` against the DID's key, and compare the result with `expected`.

Each vector also carries `sas`, the six-digit short authentication string of `ucep-auth.md` §4: the first four bytes of `transcriptHash` as an unsigned big-endian integer, modulo 1 000 000, zero-padded.
