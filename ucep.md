# Universal Connectivity Extension Protocol (UCEP)

| Lifecycle stage | Maturity | Status | Latest revision |
|-----------------|----------|--------|-----------------|
| 1A              | Working Draft | Active | r0, 2026-09-26 |

Authors: Le-Space contributors

Interest group: Universal Connectivity implementers

See the [lifecycle document][lifecycle] for context about the maturity level and spec status.

## Table of contents

- [1. Introduction](#1-introduction)
- [2. Terminology](#2-terminology)
- [3. Protocol ID](#3-protocol-id)
- [4. Discovery](#4-discovery)
- [5. Streams and framing](#5-streams-and-framing)
- [6. Manifest](#6-manifest)
- [7. Commands](#7-commands)
- [8. Errors](#8-errors)
- [9. Authorization](#9-authorization)
- [10. Versioning and compatibility](#10-versioning-and-compatibility)
- [11. Limits](#11-limits)
- [12. Security considerations](#12-security-considerations)
- [Appendix A. Differences from the 0.1 draft](#appendix-a-differences-from-the-01-draft)

## 1. Introduction

UCEP lets one libp2p peer offer an **extension** — a small service with named commands — and lets any other peer discover it and call its commands, with no registry or server in between. A chat client can offer `/sheet-show demo A1` to its user because a spreadsheet peer on the network advertises the `sheet` extension; a bookkeeping app can ask an invoicing app to produce a document because the invoicing app advertises the `invoice` extension.

Design goals:

1. **No central registry.** Discovery rides on libp2p [identify][identify].
2. **One request, one response.** Every call is a short-lived stream, like the libp2p ping or identify protocols, so any transport and any language with libp2p can implement it.
3. **Authorization is part of the protocol.** Public commands stay public; commands that change state or reveal data require a grant obtained through [pairing](./ucep-auth.md).
4. **Wire compatibility with the 0.1 draft** used by the first implementations (see [Appendix A](#appendix-a-differences-from-the-01-draft)).

Out of scope: how an extension renders a UI, how commands are typed by a human (the `/ext-command` chat syntax is a convention of chat clients, not of the protocol), and how peers find each other's addresses (any libp2p discovery works).

## 2. Terminology

The key words "MUST", "MUST NOT", "REQUIRED", "SHOULD", "SHOULD NOT", "RECOMMENDED", "MAY" and "OPTIONAL" are to be interpreted as described in [RFC 2119][rfc2119] and [RFC 8174][rfc8174] when, and only when, they appear in all capitals.

- **Provider**: the peer that offers an extension and executes its commands.
- **Consumer**: the peer that discovers an extension and calls its commands.
- **Extension**: a named, versioned set of commands described by a manifest.
- **Scope**: a named permission a command may require, e.g. `invoice:eigenbeleg:create`.
- **Grant**: the provider's record that a consumer peer holds a set of scopes (see [ucep-auth.md](./ucep-auth.md)).

A peer MAY be provider and consumer at the same time, and MAY provide several extensions.

## 3. Protocol ID

Each extension is served on its own protocol ID:

```
/uc/extension/{extensionId}/{version}
```

- `{extensionId}` MUST match `[a-z0-9-]{1,64}` and MUST equal the manifest's `id`.
- `{version}` MUST be a [SemVer 2.0.0][semver] version without build metadata and MUST equal the manifest's `version`.

Examples:

```
/uc/extension/sheet/1.0.0
/uc/extension/invoice/0.1.0
```

Because multistream-select matches protocol IDs exactly, a consumer that knows only `/uc/extension/invoice/1.2.0` cannot open `/uc/extension/invoice/1.3.0`. Consumers therefore SHOULD NOT hard-code a full version; they SHOULD pick one from the peer's identify protocol list ([§4](#4-discovery)) and check compatibility by SemVer: the major version MUST match what the consumer supports, and the minor version SHOULD be at least the one it needs. A provider that changes the major version of an extension SHOULD keep serving the previous major version for a transition period by registering both protocol IDs.

## 4. Discovery

A provider MUST register a stream handler for each protocol ID it serves. libp2p identify then lists these IDs in the `protocols` field that every connected peer receives.

A consumer:

1. SHOULD listen for identify results (`peer:identify` in js-libp2p, the equivalent event elsewhere) and for identify push updates.
2. SHOULD treat every protocol ID with the prefix `/uc/extension/` as a candidate and parse `{extensionId}` and `{version}` from it; IDs that do not parse MUST be ignored.
3. SHOULD fetch the manifest ([§6](#6-manifest)) once per `(peer, protocol ID)` and cache it for the life of the connection.
4. MUST NOT execute anything because of a manifest alone; a manifest is a description, not an instruction.

Several peers MAY provide the same extension ID. A consumer MAY treat them as interchangeable (e.g. replicas of a public spreadsheet) or bind to one specific peer (e.g. the invoicing app it paired with). **Commands that require a scope are always bound to the specific provider peer that issued the grant** ([ucep-auth.md §6](./ucep-auth.md#6-authorizing-commands)).

## 5. Streams and framing

- Each message is a protobuf message from [`messages.proto`](./messages.proto), framed with an **unsigned varint length prefix** ([multiformats unsigned-varint][uvarint]), as produced by `it-protobuf-stream` / `it-length-prefixed`.
- The consumer opens a new stream on the extension's protocol ID and writes exactly **one** `Request`.
- The provider reads exactly one `Request`, writes exactly **one** `Response` whose `payload` case matches the request (`manifest` → `manifest`, `command` → `command`, `pair` → `pair`, `unpair` → `unpair`), and closes the stream.
- A provider MUST always answer. (A 0.1 provider could return no response to "ignore" a command; a 0.2 provider MUST instead answer with `success = false` and an error code.)
- If a request cannot be parsed, the provider SHOULD reset the stream.
- The provider MUST apply a read timeout. RECOMMENDED: 10 seconds to receive the request, and at most 60 seconds to answer. Commands that take longer MUST return promptly with a handle the consumer can poll with a second command (see the `invoice` extension's `status` command for an example).

Streams run over the connection's secure channel (Noise or TLS). The provider therefore knows the consumer's **authenticated** PeerId (`connection.remotePeer`); this is the identity every authorization decision uses.

## 6. Manifest

A consumer asks for the manifest with `Request { manifest: ManifestRequest }`; the provider answers with `Response { manifest: ManifestResponse }`.

The manifest describes the extension: `id`, `name`, `version`, `description`, `author`, `publicUrl`, `icon`, and the list of `commands`. Since revision 0.2 it also carries:

- `ucepVersion`: the highest UCEP wire revision the provider speaks. `0` (absent) means the 0.1 draft; this document is revision `2`.
- `pairingSupported`: whether the provider accepts `PairRequest`.
- `scopes`: every scope any command may require, with a human description.
- per command: `scope` (empty means public), `argsSchema` and `resultSchema` (JSON Schema 2020-12, optional), and `idempotent`.

Rules:

- The manifest request is **public**. A provider MUST answer it for any peer, and MUST NOT put anything into it that an unpaired peer may not see.
- `icon` MUST be an `https:` URL or a `data:` URI of at most 32 KiB. Consumers MUST NOT load `icon` or `publicUrl` automatically without the user's consent if doing so would reveal the user's IP address to a third party.
- Text fields are untrusted input; consumers MUST escape them before rendering.

## 7. Commands

A consumer calls a command with `Request { command: CommandRequest }`:

| Field | Rule |
|-------|------|
| `requestId` | MUST be unique per consumer and at most 128 bytes. ULID or UUIDv7 RECOMMENDED. |
| `extensionId` | MUST equal the extension the stream was opened for; otherwise the provider answers `UNKNOWN_EXTENSION`. |
| `command` | A command name from the manifest; otherwise `UNKNOWN_COMMAND`. |
| `args` | Positional string arguments (0.1 style). |
| `argsJson` | A JSON object (since 0.2). If set, `args` MUST be empty. A provider that publishes an `argsSchema` MUST validate against it and answer `INVALID_ARGUMENTS` on mismatch. |
| `timestamp` | Milliseconds since the Unix epoch. Informational. |

The provider answers with `Response { command: CommandResponse }`, repeating the `requestId`. On success, `success = true` and `data` holds the JSON-encoded result. On failure, `success = false`, `errorCode` is set, and `error` MAY hold a human-readable message.

**Idempotency.** A command marked `idempotent` in the manifest MUST return the result of the first execution when the same consumer repeats a `requestId` within 24 hours, without executing again. Commands that create something (a document, a payment request) SHOULD be idempotent, so a consumer can safely retry after a dropped stream.

**Authorization.** Before executing a command whose manifest entry has a non-empty `scope`, the provider MUST check the grant of the authenticated remote PeerId as defined in [ucep-auth.md §6](./ucep-auth.md#6-authorizing-commands). A command with an empty `scope` is public.

**Large results.** A result larger than the limits in [§11](#11-limits) SHOULD be returned by reference: a CID the consumer can fetch over Bitswap or HTTP gateway, together with its size and SHA-256.

## 8. Errors

`ErrorCode` in [`messages.proto`](./messages.proto) is the machine-readable reason for a failure. Consumers MUST handle unknown values as `INTERNAL`. A 0.1 provider sends no code (`ERROR_UNSPECIFIED`); consumers MUST then rely on `success` and `error` only.

| Code | Meaning | Consumer SHOULD |
|------|---------|-----------------|
| `UNKNOWN_EXTENSION`, `UNKNOWN_COMMAND` | Not served here | refresh the manifest |
| `INVALID_ARGUMENTS` | Arguments do not match the schema | not retry unchanged |
| `PAIRING_REQUIRED` | Command needs a scope; no grant | start pairing |
| `SCOPE_MISSING` | Grant exists, scope missing | ask the user to pair again with the scope |
| `GRANT_EXPIRED` | Grant expired | pair again |
| `RATE_LIMITED` | Too many requests | back off |
| `TOO_LARGE` | Request or result exceeds limits | use references |
| `UNAVAILABLE` | Temporarily unable (e.g. app locked) | retry later |
| `INTERNAL` | Anything else | report |

Pairing error codes are listed in [ucep-auth.md §7](./ucep-auth.md#7-errors).

## 9. Authorization

Pairing, grants, scopes and revocation are specified in [ucep-auth.md](./ucep-auth.md). In short: a provider's human creates an **invitation** (QR code or link) with an expiry, a one-time secret and a set of offered scopes; the consumer proves it holds the secret with a `PairRequest` bound to both authenticated PeerIds; the provider stores a **grant** for the consumer's PeerId; later commands are allowed if the grant holds the command's scope.

## 10. Versioning and compatibility

Two versions are involved:

1. **Extension version**, in the protocol ID and the manifest. Governed by SemVer, per extension ([§3](#3-protocol-id)).
2. **UCEP wire revision**, in `manifest.ucepVersion`. This document is revision 2. New revisions MAY only add fields and enum values; they MUST NOT renumber or change the meaning of existing fields.

A consumer speaking revision 2 with a revision-1 (0.1) provider:

- MUST NOT send `pair` or `unpair` requests (the provider cannot parse them),
- MUST send `args`, not `argsJson`,
- MUST treat every command as public (0.1 has no scopes) and SHOULD warn its user that the provider performs no authorization.

A revision-2 provider receiving a revision-1 consumer's request answers normally; commands that require a scope fail with `PAIRING_REQUIRED`, which a 0.1 consumer shows as a plain error.

## 11. Limits

Unless an extension documents otherwise:

| Item | Limit |
|------|-------|
| Request message | 64 KiB |
| Response message | 1 MiB |
| `requestId` | 128 bytes |
| Manifest `icon` (`data:` URI) | 32 KiB |
| Concurrent streams per peer and protocol | 8 (providers MAY reject further streams) |

A provider MUST reject a longer length prefix before buffering the message.

## 12. Security considerations

See [SECURITY.md](./SECURITY.md) for the threat model. The essentials:

- **Identity is the PeerId of the secure channel.** Anything a peer writes into a message (a DID, a label, a name) is a claim until verified as in [ucep-auth.md](./ucep-auth.md).
- **Discovery is public.** Identify tells every connected peer which extensions a node serves. A node that wants to hide an extension MUST NOT register its protocol ID on connections it does not trust.
- **Results are untrusted input.** Consumers MUST validate `data` against the `resultSchema` or their own expectations and MUST NOT execute or render it unescaped.
- **Rate limiting.** Providers SHOULD limit requests per PeerId and pairing attempts per invitation.

## Appendix A. Differences from the 0.1 draft

The 0.1 draft is the protocol implemented in `NiKrause/js-libp2p-examples` (branch `uc-extensions-service`, `examples/js-libp2p-example-yjs-libp2p`) and in the Universal Connectivity js-peer. Revision 2:

1. adds pairing, grants and scopes (`PairRequest`, `UnpairRequest`, `ExtensionCommand.scope`, `ScopeInfo`);
2. adds `ErrorCode`;
3. adds `argsJson` and optional JSON Schemas for arguments and results;
4. adds `idempotent` and the 24-hour replay rule;
5. adds `ucepVersion` and `pairingSupported` to the manifest;
6. requires the provider to always answer (no silent "ignore");
7. defines limits and SemVer matching of the protocol ID.

All 0.1 field numbers are unchanged.

[lifecycle]: https://github.com/libp2p/specs/blob/master/00-framework-01-spec-lifecycle.md
[identify]: https://github.com/libp2p/specs/blob/master/identify/README.md
[rfc2119]: https://www.rfc-editor.org/rfc/rfc2119
[rfc8174]: https://www.rfc-editor.org/rfc/rfc8174
[semver]: https://semver.org/spec/v2.0.0.html
[uvarint]: https://github.com/multiformats/unsigned-varint
