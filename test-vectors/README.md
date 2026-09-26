# UCEP pairing test vectors

Deterministic vectors for the pairing of [`ucep-auth.md`](../ucep-auth.md): the invitation mode (§3, §4, §5.1) and the in-band mode (§5.2), each with and without a bound DID.

```bash
node test-vectors/generate.mjs   # rewrites pairing-v1.json; the output is byte-identical on every run
```

Only Node 22 built-ins are used. All keys, nonces and secrets are derived from fixed labels with SHA-256 and are **for testing only**.

## `pairing-v1.json`

### `keys`

`provider`, `consumer` and `relay` are Ed25519 libp2p keys: `seedHex` (the 32-byte private seed), `publicKeyHex`, `peerId` (base58btc) and `peerIdMultihashHex` (identity multihash of the protobuf `PublicKey`). `consumerDid` is the Ed25519 key of the consumer's `did:key`, used for `DidProof` format `RAW`.

### `invitation`

`providerPeerId`, `extensionId`, `invitationId`, the secret as `secretHex` and `secretB64url`, `expiresAt` (Unix seconds), the offered `scopes`, and `addrs`: a `/p2p-circuit/webrtc/` and a plain `/p2p-circuit/` address through the relay, since a browser provider cannot be dialed directly. `invitation` is the `web+ucep:pair?…` URI; `link` is the same URI wrapped in the fragment of an `https` link.

### `vectors` (invitation mode)

| Field | Meaning |
|-------|---------|
| `now` | Unix seconds at which the provider evaluates the request |
| `connectionConsumerPeerId` | The consumer PeerId the provider sees on the connection and uses for line 5 |
| `requestedScopes` | Scopes as sent, unsorted |
| `did` | Bound DID, or `null` |
| `transcript`, `transcriptHex` | The seven-line transcript as the consumer built it |
| `proofHex` | `HMAC-SHA256(secret, transcript)` |
| `transcriptHashHex` | `SHA-256(transcript)` |
| `sas` | Six-digit short authentication string (§4) |
| `didSignatureHex` | Ed25519 signature by `consumerDid` over the 32-byte `transcriptHash`, if `did` is set |
| `expected` | `GRANTED` or the error code the provider must return |

Cases: `granted`, `granted-with-did`; `wrong-consumer-peer` (proof made with the provider's PeerId in line 5 → `PAIRING_PROOF_INVALID`); `expired` (`now = expiresAt + 1` → `INVITATION_EXPIRED`); `expires-now` (`now = expiresAt`, still valid → `GRANTED`); `scope-not-offered` (valid proof, but a scope the invitation does not offer → `SCOPE_NOT_OFFERED`).

### `inBandVectors`

| Field | Meaning |
|-------|---------|
| `pairingId` | Chosen by the provider in its answer to step 1 |
| `nonceCHex`, `commitmentHex` | Consumer nonce and `SHA-256(nonceC)` sent in step 1 |
| `noncePHex` | Provider nonce, sent in the answer to step 1 |
| `revealedNonceHex` | The nonce the consumer reveals in step 2 |
| `transcript`, `transcriptHex`, `transcriptHashHex`, `sas` | The nine-line in-band transcript and its SAS, present when the reveal is valid |
| `didSignatureHex` | As above, over the in-band `transcriptHash` |
| `expected` | `PENDING_THEN_GRANTED` (the provider answers `PENDING` until its human confirms the SAS) or an error code |

Cases: `in-band-sas`, `in-band-sas-with-did`, `in-band-commitment-mismatch` (the revealed nonce does not hash to the commitment → `COMMITMENT_MISMATCH`).

## Checking an implementation

1. Derive the PeerIds and the DID from `publicKeyHex` and compare.
2. Build the invitation URI from the `invitation` fields and compare it with `invitation`; parse it and get the same fields back.
3. Invitation mode, as the consumer: build the transcript, compare `transcriptHex`, `proofHex`, `transcriptHashHex`, `sas` and `didSignatureHex` (Ed25519 is deterministic, so signatures match byte for byte).
4. Invitation mode, as the provider: rebuild the transcript with `connectionConsumerPeerId`, run the checks of §5.1 in order at time `now`, and compare the outcome with `expected`.
5. In-band mode: check `SHA-256(revealedNonce) = commitment`, then build the transcript and compare `transcriptHashHex` and `sas`.
