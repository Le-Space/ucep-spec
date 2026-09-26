# UCEP Authorization: Pairing, Grants and Scopes

| Lifecycle stage | Maturity | Status | Latest revision |
|-----------------|----------|--------|-----------------|
| 1A              | Working Draft | Active | r0, 2026-09-26 |

Authors: Le-Space contributors

Part of the [Universal Connectivity Extension Protocol](./ucep.md), wire revision 2. Messages are defined in [`messages.proto`](./messages.proto); test vectors are in [`test-vectors/`](./test-vectors/).

## Table of contents

- [1. Overview](#1-overview)
- [2. Model](#2-model)
- [3. Invitation](#3-invitation)
- [4. Transcript and proof](#4-transcript-and-proof)
- [5. Pairing exchange](#5-pairing-exchange)
- [6. Authorizing commands](#6-authorizing-commands)
- [7. Errors](#7-errors)
- [8. Revocation and expiry](#8-revocation-and-expiry)
- [9. Binding a DID (optional)](#9-binding-a-did-optional)
- [10. Scope names](#10-scope-names)
- [11. Storage](#11-storage)
- [12. Future work](#12-future-work)

## 1. Overview

The 0.1 draft of UCEP let every connected peer call every command. That is fine for a public spreadsheet and unacceptable for an extension that creates invoices or reads bookkeeping data. Revision 2 adds **pairing**: a one-time, human-initiated step after which the provider remembers which consumer peer may use which commands.

There are two pairing modes. Both end in the same grant:

| Mode | How the consumer finds the provider | What the human does | Spec |
|------|-------------------------------------|---------------------|------|
| **Invitation** | QR code or link from the provider, carrying a one-time secret | Scans or pastes; optionally compares a code | [§3](#3-invitation), [§5.1](#51-with-an-invitation) |
| **In-band** | Entirely over libp2p: the consumer sees the extension through identify and asks to pair | Compares a six-digit code on both screens and approves on the provider | [§5.2](#52-in-band-without-an-invitation) |

Both modes work browser-to-browser and mobile-to-mobile, over a direct WebRTC connection or through a circuit relay ([ucep.md §5.1](./ucep.md#51-browser-mobile-and-relayed-connections)). The invitation mode needs a camera or a way to copy the link; the in-band mode needs neither, but both screens must be visible to the person approving. The diagram shows the invitation mode.

```
 Provider (e.g. invoicing app)                 Consumer (e.g. bookkeeping app)
 ─────────────────────────────                 ───────────────────────────────
 human: "connect an app", picks scopes
 creates invitation ── QR code / link ──────▶  human scans or pastes it
                                               dials /p2p/<providerPeerId>
                                               (Noise authenticates both PeerIds)
                   ◀────── PairRequest ──────  proof = HMAC(secret, transcript)
 verifies invitation, proof, scopes
 [optional] human confirms, compares SAS
 stores grant {consumerPeerId, scopes}
                   ─────── PairResponse ─────▶ GRANTED, grantId, scopes
                                               stores {providerPeerId, grantId}
                   ◀────── CommandRequest ───  scoped command
 grant(remotePeer) has scope? execute
                   ─────── CommandResponse ──▶
```

Properties:

- The invitation secret never travels over the network after it leaves the provider in the QR code or link; the consumer proves knowledge of it.
- The proof is bound to both authenticated PeerIds and to the requested scopes, so it is useless to any other peer and cannot widen the scopes.
- An invitation is single-use and expires.
- Authorization of every later command uses only the PeerId the secure channel authenticated, not anything written in a message.

## 2. Model

A **grant** is a record the provider keeps:

| Field | Meaning |
|-------|---------|
| `grantId` | Random identifier, at least 128 bits, e.g. a ULID. |
| `extensionId` | The extension the grant is for. A grant never covers another extension. |
| `consumerPeerId` | The authenticated PeerId that paired. |
| `scopes` | The granted scopes. |
| `label` | The consumer's label from the `PairRequest`, for display. |
| `did` | The verified DID of the consumer's user, if one was bound ([§9](#9-binding-a-did-optional)). |
| `createdAt`, `expiresAt` | Timestamps; `expiresAt` MAY be absent (no expiry). |
| `lastUsedAt` | RECOMMENDED, so the human can spot and revoke unused grants. |

A consumer keeps the matching record: `providerPeerId`, `extensionId`, `grantId`, `scopes`, `expiresAt`.

## 3. Invitation

The provider's human creates an invitation in the provider's UI and chooses the offered scopes and a lifetime. The provider generates:

| Field | Rule |
|-------|------|
| `invitationId` | Random, at least 128 bits, URL-safe characters. |
| `secret` | 32 random bytes from a CSPRNG. |
| `expiresAt` | Unix time in **seconds**. RECOMMENDED: at most 10 minutes after creation. |
| `scopes` | Offered scopes, each listed in the manifest's `scopes`. |
| `addrs` | Zero or more multiaddrs the consumer can dial, each ending in `/p2p/<providerPeerId>`. A provider in a browser or mobile app cannot be dialed directly; its addresses are circuit-relay addresses through the relays it holds reservations on ([ucep.md §5.1](./ucep.md#51-browser-mobile-and-relayed-connections)). |

The invitation is transferred out of band — as a QR code shown on the provider's screen, or as a link — encoded as a URI:

```
web+ucep:pair?v=1&peer=<providerPeerId>&ext=<extensionId>&inv=<invitationId>&s=<secret>&exp=<expiresAt>&scope=<scope>,<scope>&addr=<multiaddr>&addr=<multiaddr>
```

- `web+ucep` is used because browsers let a web app (PWA) register only schemes with the `web+` prefix (`navigator.registerProtocolHandler`). A consumer app SHOULD register it, so that scanning the QR code with the phone's camera opens the app.
- `peer` is the provider's PeerId in its base58btc string form (`12D3KooW…`).
- `s` is the secret encoded as base64url without padding.
- Each value is percent-encoded with `encodeURIComponent` semantics; the scopes are encoded individually and joined with a literal comma.
- `v` is the invitation format version, `1` for this document.
- `addr` MAY repeat; typically one `/p2p-circuit/webrtc/` address for a direct browser-to-browser connection and one plain `/p2p-circuit/` address as fallback. If absent, the consumer finds the provider through its usual discovery.

Where a custom scheme cannot be opened (the consumer app is not installed as a PWA, or runs on a platform without protocol handlers), the invitation MAY be wrapped into an `https` link to the consumer app, **in the URL fragment**:

```
https://app.example.com/#ucep=<percent-encoded web+ucep:pair?… URI>
```

The fragment is never sent to a web server, so the secret stays on the device. Implementations MUST NOT put the invitation into the path or the query of an `https` URL.

This revision covers two ways to transfer an invitation: a **QR code** scanned from the provider's screen, and **copy and paste** between apps on the same device. Sending an invitation to another person or device by e-mail, messenger or similar — and any authorization based on an e-mail address — is not specified yet ([§12](#12-future-work)). Providers SHOULD NOT offer to send invitations that way.

Anyone who holds the invitation URI can pair until it is used or expires. The provider SHOULD show the QR code only on explicit request, hide it after use, and allow the human to cancel it.

## 4. Transcript and proof

Both sides compute the **transcript**: the UTF-8 encoding of these seven lines, joined with a single `\n` (0x0A), without a trailing newline:

| Line | Content |
|------|---------|
| 1 | The literal string `ucep-pair-v1` |
| 2 | `extensionId` |
| 3 | `invitationId` |
| 4 | Provider PeerId, base58btc string |
| 5 | Consumer PeerId, base58btc string |
| 6 | The requested scopes, sorted ascending by their UTF-8 bytes, joined with `,` |
| 7 | The consumer's DID, or the empty string if none is bound |

Then:

```
proof          = HMAC-SHA256(key = secret, message = transcript)      // 32 bytes
transcriptHash = SHA-256(transcript)                                   // 32 bytes
```

The consumer takes line 4 from the invitation and line 5 from its own identity. The provider takes line 4 from its own identity and line 5 from `connection.remotePeer`, **never** from the message. A proof made by one consumer therefore fails for every other consumer, and a proof made for one provider fails at every other provider.

**Short authentication string (SAS).** When the provider asks its human to confirm ([§5](#5-pairing-exchange), step 6), both sides SHOULD show a six-digit code so the human can check that both screens belong to the same pairing:

```
SAS = (first 4 bytes of transcriptHash as unsigned big-endian integer) mod 1 000 000, zero-padded to 6 digits
```

## 5. Pairing exchange

A provider announces the modes it accepts in the manifest's `pairingModes`. A consumer MUST NOT use a mode that is not listed.

### 5.1 With an invitation

The consumer:

1. Parses the invitation URI and rejects it if `v` is unknown or `exp` has passed.
2. Dials the provider, using `addr` if given, preferring a `/p2p-circuit/webrtc/` address. Because the dial targets `/p2p/<providerPeerId>`, the secure channel guarantees the consumer talks to the peer named in the invitation, even through a relay. The consumer MUST abort if the connection's remote PeerId differs.
3. Fetches the manifest and checks that `ucepVersion ≥ 2` and that `pairingModes` contains `INVITATION`.
4. Sends `Request { pair: PairRequest }` with `extensionId`, `invitationId`, the requested `scopes` (a subset of the offered ones; by default all of them), `proof`, a `label`, and optionally `did` and `didProof` ([§9](#9-binding-a-did-optional)).

The provider MUST perform these checks **in this order** and answer `PairResponse { status: DENIED, errorCode }` at the first failure:

1. The invitation exists and belongs to `extensionId` → else `INVITATION_UNKNOWN`.
2. It has not been used (granted or denied) → else `INVITATION_USED`.
3. `now ≤ expiresAt` → else `INVITATION_EXPIRED`.
4. Every requested scope was offered → else `SCOPE_NOT_OFFERED`.
5. The proof equals the HMAC it computes, compared in constant time → else `PAIRING_PROOF_INVALID`.
6. If `did` is set, `didProof` verifies ([§9](#9-binding-a-did-optional)) → else `DID_SIGNATURE_INVALID`.

Then either:

- **Immediate grant.** Creating the invitation was the human's consent; the provider stores the grant, marks the invitation used, and answers `GRANTED` with `grantId`, `scopes` and `expiresAt`.
- **Confirmation.** The provider shows its human the label, the DID (if any), the scopes and the SAS, and answers `PENDING` with a `retryAfterMs`. The consumer shows the same SAS and repeats the identical `PairRequest` on a new stream after `retryAfterMs`. When the human accepts, the next retry gets `GRANTED`; when they decline, `DENIED` with `PAIRING_DENIED`. While pending, only the PeerId that started the pairing may retry; the invitation is marked used when it is granted or denied.

A provider SHOULD allow at most 5 failed `PairRequest`s per invitation and then invalidate it, and SHOULD rate-limit `PairRequest`s per PeerId.

The consumer stores the returned grant. It MUST NOT keep the invitation secret after pairing.

### 5.2 In-band, without an invitation

In this mode the whole pairing runs over libp2p. The consumer found the provider through identify ([ucep.md §4](./ucep.md#4-discovery)) or its user entered the provider's PeerId; nobody scans or copies anything. Because the two sides share no secret, **the human is the check**: both apps show a six-digit code, and the provider's human approves only if the codes match.

```
 Provider                                          Consumer
 human opens a pairing window ("allow apps to connect")
                ◀── PairRequest {scopes, label, commitment = H(nonceC)} ──
 checks window, limits; picks nonceP
                ─── PairResponse PENDING {pairingId, nonceP} ────────────▶
                ◀── PairRequest {pairingId, nonceC, did?, didProof?} ─────
 checks H(nonceC) = commitment
 shows label, PeerId, scopes, SAS                   shows SAS
                ─── PairResponse PENDING {retryAfterMs} ─────────────────▶
 human compares the codes and approves   ···  consumer repeats the last request
                ─── PairResponse GRANTED {grantId, scopes} ──────────────▶
```

**Pairing window.** A provider MUST accept in-band requests only while its human has explicitly opened a pairing window in the provider's UI. The window SHOULD close after at most 2 minutes and after the first pairing that is granted. Outside the window the provider answers `DENIED` with `PAIRING_DISABLED`. This keeps unsolicited pairing prompts from appearing on the provider.

**Step 1: commitment.** The consumer draws a 32-byte random `nonceC` and sends `PairRequest` with `extensionId`, the requested `scopes`, a `label`, `commitment = SHA-256(nonceC)` and **empty** `invitationId`, `proof`, `pairingId`, `nonce` and `did`.

The provider MUST check, in this order:

1. The pairing window is open → else `PAIRING_DISABLED`.
2. Every requested scope is listed in the manifest's `scopes` → else `SCOPE_NOT_OFFERED`.
3. There is no other pending in-band pairing for `connection.remotePeer`, and fewer than 3 pending in-band pairings in total → else `RATE_LIMITED`.

It then draws a random `pairingId` (at least 128 bits) and a 32-byte random `nonceP`, stores `{pairingId, consumerPeerId = connection.remotePeer, commitment, nonceP, scopes, label}` for at most 2 minutes, and answers `PENDING` with `pairingId` and `nonce = nonceP`.

**Step 2: reveal.** The consumer sends `PairRequest` with `extensionId`, `pairingId`, the same `scopes` and `label` as in step 1, `nonce = nonceC`, and optionally `did` and `didProof` ([§9](#9-binding-a-did-optional)) over the in-band transcript below.

The provider MUST check, in this order, and drop the pending pairing at the first failure:

1. A pending pairing with this `pairingId` exists and belongs to `connection.remotePeer` → else `PAIRING_UNKNOWN`.
2. `SHA-256(nonce)` equals the stored `commitment`, and `scopes` and `label` equal the stored ones → else `COMMITMENT_MISMATCH`.
3. If `did` is set, `didProof` verifies → else `DID_SIGNATURE_INVALID`.

The provider then shows its human the consumer's label, a short form of its PeerId, the DID if any, the requested scopes and the SAS, and answers `PENDING` with `retryAfterMs`. The consumer computes the same SAS and shows it, together with the provider's manifest name and a short form of its PeerId, with the instruction to compare it with the provider's screen.

**Step 3: approval.** The consumer repeats its step-2 request after each `retryAfterMs` until it receives `GRANTED` or `DENIED`, or the pairing expires. The provider's human approves only if both codes match. They MAY grant fewer scopes than requested; the response lists the scopes actually granted. When approved, the provider stores the grant and answers the next retry with `GRANTED`; when declined, with `DENIED` and `PAIRING_DENIED`.

A provider SHOULD make approval depend on the code: RECOMMENDED is to let the human **type** the six digits the consumer shows, rather than click "matches". A provider MUST NOT offer approval without showing the SAS or asking for it.

**In-band transcript.** The UTF-8 encoding of these nine lines, joined with `\n`, without a trailing newline:

| Line | Content |
|------|---------|
| 1 | The literal string `ucep-pair-inband-v1` |
| 2 | `extensionId` |
| 3 | `pairingId` |
| 4 | Provider PeerId, base58btc string |
| 5 | Consumer PeerId, base58btc string |
| 6 | The requested scopes, sorted ascending by their UTF-8 bytes, joined with `,` |
| 7 | The consumer's DID, or the empty string |
| 8 | `nonceC`, lowercase hex |
| 9 | `nonceP`, lowercase hex |

`transcriptHash = SHA-256(transcript)`, and the SAS is derived from it exactly as in [§4](#4-transcript-and-proof).

**Why commit and reveal.** If the code depended only on the two PeerIds, an attacker could generate PeerIds until one produced the same code as a legitimate consumer's. Roughly a million attempts suffice for six digits, and they are cheap. Here the consumer commits to `nonceC` before it learns `nonceP`, and the provider chooses `nonceP` before it learns `nonceC`. Neither side, nor anyone racing them, can steer the code: a code chosen by an attacker matches the legitimate one with probability 10⁻⁶ per attempt, and every attempt costs a visible, rate-limited pairing request.

## 6. Authorizing commands

For every `CommandRequest` the provider:

1. Looks up the manifest entry of `command`. If its `scope` is empty, the command is public: execute it.
2. Otherwise finds the grant for `(extensionId, connection.remotePeer)`.
   - No grant → `PAIRING_REQUIRED`.
   - Grant expired → `GRANT_EXPIRED`.
   - Scope not in the grant → `SCOPE_MISSING`.
3. Executes the command and updates `lastUsedAt`.

The provider MUST NOT take the consumer's identity from any message field. A grant belongs to one PeerId; a consumer whose PeerId changes (new device, lost key) MUST pair again. Consumers that want to keep their grants across restarts therefore MUST persist their libp2p private key.

## 7. Errors

In addition to the command errors in [ucep.md §8](./ucep.md#8-errors):

| Code | When |
|------|------|
| `INVITATION_UNKNOWN` | No such invitation for this extension |
| `INVITATION_EXPIRED` | `now > expiresAt` |
| `INVITATION_USED` | Already granted, denied or invalidated |
| `PAIRING_PROOF_INVALID` | HMAC does not match (wrong secret, wrong PeerIds, altered scopes or DID) |
| `SCOPE_NOT_OFFERED` | A requested scope was not in the invitation (in-band: not in the manifest) |
| `DID_SIGNATURE_INVALID` | `didProof` does not verify |
| `PAIRING_DENIED` | The provider's human declined |
| `PAIRING_DISABLED` | In-band request outside an open pairing window, or the mode is not offered |
| `PAIRING_UNKNOWN` | In-band: no pending pairing with this `pairingId` for this peer (expired or dropped) |
| `COMMITMENT_MISMATCH` | In-band: the revealed nonce, scopes or label do not match step 1 |

Providers SHOULD NOT reveal more than the code; in particular the `error` text MUST NOT contain the expected proof.

## 8. Revocation and expiry

- **By the provider.** The provider's UI MUST list grants (label, DID, scopes, created, last used) and let the human revoke any of them. Revocation takes effect for the next command.
- **By the consumer.** The consumer MAY send `Request { unpair: UnpairRequest { grantId } }`. The provider deletes the grant if it belongs to `connection.remotePeer` and answers `success = true`. A consumer SHOULD unpair when its user removes the integration.
- **Expiry.** A grant MAY carry `expiresAt`. The consumer SHOULD prompt for re-pairing before it expires.

There is no notification of revocation; the consumer learns it from `PAIRING_REQUIRED` on its next call.

## 9. Binding a DID (optional)

A PeerId identifies a device's libp2p key. When both apps also know their human by a DID — for example a WebAuthn passkey `did:key` — the consumer MAY bind it, so the provider can show "Belege, used by did:key:z…" and record it with every document created under the grant.

The consumer sets `did` (which becomes line 7 of the transcript, so the HMAC covers it) and `didProof`:

- **`RAW`**: `signature` is a signature over the 32-byte `transcriptHash` with the DID's key. For `did:key` with an Ed25519 key (multicodec `0xed`): pure Ed25519. For P-256 (multicodec `0x1200`): ECDSA with SHA-256, signature in IEEE P1363 form (64 bytes, `r ‖ s`).
- **`WEBAUTHN`**: for keys that live in a passkey and cannot sign arbitrary bytes. The consumer runs a WebAuthn assertion with `challenge = transcriptHash` and sends `authenticatorData`, `clientDataJSON` and `signature` (ASN.1 DER as returned by the authenticator). The provider verifies that `clientDataJSON.type` is `webauthn.get`, that `clientDataJSON.challenge` is the base64url encoding of `transcriptHash`, that the UP flag is set in `authenticatorData`, and that `signature` verifies over `authenticatorData ‖ SHA-256(clientDataJSON)` with the DID's public key. The provider cannot verify the relying party ID of another app and MUST NOT rely on `origin` or `rpIdHash`.

A bound DID is **attribution, not authentication**: the grant still belongs to the PeerId. Future revisions may use the DID for grants that survive a change of device ([§12](#122-capability-tokens)).

## 10. Scope names

A scope is `<extensionId>:<resource>:<action>`, all parts matching `[a-z0-9-]+`. Examples:

```
invoice:eigenbeleg:create
invoice:document:read
invoice:draft:create
```

Rules:

- A scope always starts with the ID of the extension that defines it; a provider MUST reject a scope of another extension with `SCOPE_NOT_OFFERED`.
- There are no wildcards and no implied hierarchy: `invoice:document:read` does not imply `invoice:document:list`.
- Every scope MUST be listed in the manifest's `scopes` with a description a non-technical person understands. The provider shows these descriptions when creating an invitation and when confirming a pairing.

## 11. Storage

- The provider stores grants durably and, where the platform allows, encrypted at rest.
- The provider stores, for open invitations, the secret or a key derived from it; it MUST delete the secret once the invitation is used, expired or cancelled.
- The consumer stores its libp2p private key and its grants durably and SHOULD encrypt them at rest.
- Pending in-band pairings, with their nonces, are deleted when granted, denied or expired.
- In a browser, "durably" means IndexedDB (or OPFS) of the app's origin; the libp2p private key SHOULD be encrypted there, e.g. with a key derived from a passkey. A consumer that creates a new PeerId on every page load loses all its grants.
- Neither side logs secrets, proofs, nonces or invitation URIs.

## 12. Future work

### 12.1 Remote invitations and e-mail

Revision 2 assumes the person pairing has both apps in front of them. Inviting someone else, or a device that is not at hand, needs a way to deliver the invitation (e-mail, messenger) and possibly to authorize by an e-mail address. Such channels can be read by third parties and delay delivery, so they need their own rules — at least a shorter secret lifetime together with in-band confirmation, or a proof of control over the address. This is left for a later revision; the protobuf messages reserve no fields for it, as it can be added with new ones.

### 12.2 Capability tokens

Revision 2 deliberately keeps authorization as a provider-side allowlist: simple to implement, easy to reason about, revocable in one place. A later revision may add signed, delegable capability tokens (in the style of [UCAN][ucan]), bound to a DID rather than a PeerId, so that

- a user can move a grant to a new device without pairing again,
- a consumer can delegate a narrower scope to a third app,
- a provider can verify a grant without keeping state.

That revision must stay compatible with the allowlist: a provider that does not understand tokens keeps answering `PAIRING_REQUIRED`.

[ucan]: https://github.com/ucan-wg/spec
