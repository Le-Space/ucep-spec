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
  - [4.1 Catalogue and online status](#41-catalogue-and-online-status)
  - [4.2 Adding a provider by PeerId](#42-adding-a-provider-by-peerid)
- [5. Streams and framing](#5-streams-and-framing)
  - [5.1 Browser, mobile and relayed connections](#51-browser-mobile-and-relayed-connections)
- [6. Manifest](#6-manifest)
- [7. Commands](#7-commands)
- [8. Errors](#8-errors)
- [9. Authorization](#9-authorization)
- [10. Versioning and compatibility](#10-versioning-and-compatibility)
- [11. Limits](#11-limits)
- [12. Security considerations](#12-security-considerations)
- [13. User interface](#13-user-interface)
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
- **Catalogue**: the consumer's local record of every extension and provider it has seen, with their online status ([§4.1](#41-catalogue-and-online-status)).
- **Installing** an extension: the user's decision to use it; the consumer then lists it permanently and watches its providers. Installing grants the provider nothing and the consumer no permission; commands with a scope still need pairing.

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

A provider MUST register a stream handler for each protocol ID it serves. libp2p identify then lists these IDs in the `protocols` field that every connected peer receives, and identify push updates that list whenever the provider adds or removes a handler.

**Discovery is pull, never broadcast.** UCEP defines no publish/subscribe announcements. A peer learns which extensions another peer serves only by connecting to it and running identify, and learns what an extension does only from the manifest it fetches from that peer. Announcing extensions on a pubsub topic is not part of UCEP: a broadcast floods every subscriber in the mesh, says nothing about whether the sender is still online, and can be forged by anyone about anyone. A consumer MAY learn the PeerIds of *candidate* peers from any source — pubsub peer discovery, a relay's peer list, a directory, a PeerId pasted by its user ([§4.2](#42-adding-a-provider-by-peerid)) — but MUST confirm every extension through identify and the manifest of the peer itself.

A consumer:

1. SHOULD listen for identify results (`peer:identify` in js-libp2p, the equivalent event elsewhere) and for identify push updates, and SHOULD also read the protocols of peers that were identified before it started listening (the peer store).
2. SHOULD treat every protocol ID with the prefix `/uc/extension/` as a candidate and parse `{extensionId}` and `{version}` from it; IDs that do not parse MUST be ignored.
3. SHOULD fetch the manifest ([§6](#6-manifest)) once per `(peer, protocol ID)` and keep it in its catalogue ([§4.1](#41-catalogue-and-online-status)).
4. MUST NOT execute anything because of a manifest alone; a manifest is a description, not an instruction.

Several peers MAY provide the same extension ID. A consumer MAY treat them as interchangeable (e.g. replicas of a public spreadsheet) or bind to one specific peer (e.g. the invoicing app it paired with). **Commands that require a scope are always bound to the specific provider peer that issued the grant** ([ucep-auth.md §6](./ucep-auth.md#6-authorizing-commands)).

### 4.1 Catalogue and online status

A consumer keeps a local **catalogue** of what it has seen, so it can answer two different questions: *which extensions have ever been available*, and *which are available right now*.

Per `(provider PeerId, protocol ID)` the catalogue holds the manifest, the time it was fetched, `firstSeen`, `lastSeen` and the current status:

| Status | Condition |
|--------|-----------|
| `online` | The consumer holds an open connection to the provider, and the provider's latest identify (or identify push) lists the protocol ID. |
| `withdrawn` | The provider is connected, but its latest identify no longer lists the protocol ID: it stopped serving the extension. |
| `offline` | No open connection. `lastSeen` is the last time the status was `online`. |
| `unknown` | Known only from a pasted PeerId or an old catalogue entry, not yet checked. |

Rules:

1. The status changes **on events**, not by polling: `peer:identify` and identify push set `online` or `withdrawn`; `peer:disconnect` sets `offline`.
2. **Checking an offline provider.** To find out whether a provider is online now, the consumer dials it (preferring known addresses, then peer routing), waits for identify, and sends a `ManifestRequest` on the protocol ID. A response means `online`; a failed dial or a timeout (RECOMMENDED: 15 seconds, relays included) means `offline`. A consumer SHOULD check only when the status matters — the user opens the extension, is about to call a command, or looks at the list — and MUST NOT check the same provider more often than once per 60 seconds, backing off exponentially after failures.
3. A provider MUST NOT be reported `online` because of a pubsub message, a cached manifest or a previous session.
4. When a re-fetched manifest has a different `version` or content, the consumer SHOULD tell its user before it uses the changed commands.
5. The catalogue is local and private to the consumer. It is not synchronised or published; entries MAY be forgotten after a period without `online` status (RECOMMENDED: 90 days), except for installed extensions ([§13](#13-user-interface)).

A provider SHOULD keep its connections to relays alive and its handlers registered for as long as it is willing to serve, and SHOULD unregister a handler (which triggers identify push) before it stops serving an extension, so that consumers see `withdrawn` instead of timeouts.

### 4.2 Adding a provider by PeerId

A user can add a provider whose PeerId they received from someone — copied from the provider app's share screen, from a chat, from a website. The consumer MUST accept, in one input field:

- a bare PeerId (`12D3KooW…`);
- a multiaddr ending in `/p2p/<PeerId>`, e.g. a `/p2p-circuit/webrtc/` address through a relay;
- a **provider link**: `web+ucep:peer?v=1&peer=<PeerId>&addr=<multiaddr>&addr=…&ext=<extensionId>`, where `addr` and `ext` are optional and repeatable, percent-encoded as in [ucep-auth.md §3](./ucep-auth.md#3-invitation). Like an invitation, it MAY be wrapped as `https://app.example.com/#ucep=<percent-encoded link>`.

A provider link carries **no secret**; it tells where to find a peer, not what it may do. Anyone may share it. (An invitation, `web+ucep:pair?…`, is different: it grants pairing and is covered by [ucep-auth.md](./ucep-auth.md).)

The consumer then:

1. validates the PeerId (it MUST decode to a valid multihash) and rejects the input otherwise;
2. dials the given addresses, or, without addresses, asks peer routing (its relays' peer lists, or a delegated routing service it is configured to use) for addresses; if none are found, it records the provider with status `unknown` and tells the user that the provider is not reachable now;
3. after identify, lists the provider's `/uc/extension/` protocols — only those named in `ext` if the link had any — fetches their manifests, and shows them for installation ([§13](#13-user-interface)).

Nothing is installed or paired automatically.

## 5. Streams and framing

- Each message is a protobuf message from [`messages.proto`](./messages.proto), framed with an **unsigned varint length prefix** ([multiformats unsigned-varint][uvarint]), as produced by `it-protobuf-stream` / `it-length-prefixed`.
- The consumer opens a new stream on the extension's protocol ID and writes exactly **one** `Request`.
- The provider reads exactly one `Request`, writes exactly **one** `Response` whose `payload` case matches the request (`manifest` → `manifest`, `command` → `command`, `pair` → `pair`, `unpair` → `unpair`), and closes the stream.
- A provider MUST always answer. (A 0.1 provider could return no response to "ignore" a command; a 0.2 provider MUST instead answer with `success = false` and an error code.)
- If a request cannot be parsed, the provider SHOULD reset the stream.
- The provider MUST apply a read timeout. RECOMMENDED: 10 seconds to receive the request, and at most 60 seconds to answer. Commands that take longer MUST return promptly with a handle the consumer can poll with a second command (see the `invoice` extension's `status` command for an example).

Streams run over the connection's secure channel: Noise on WebSockets, WebTransport and browser-to-browser WebRTC, or TLS. The provider therefore knows the consumer's **authenticated** PeerId (`connection.remotePeer`); this is the identity every authorization decision uses.

### 5.1 Browser, mobile and relayed connections

This revision is written for peers that run **in browsers and mobile apps**. Such peers cannot accept incoming connections; they reach each other

- **directly**, over WebRTC, with the connection set up (signalled) through a circuit relay v2 relay: multiaddr `…/p2p/<relayId>/p2p-circuit/webrtc/p2p/<peerId>`; or
- **through the relay**, over a relayed connection: `…/p2p/<relayId>/p2p-circuit/p2p/<peerId>`.

Other transports (TCP, QUIC between servers) work unchanged, but nothing in this revision depends on them. Requirements:

1. **Limited connections.** Relayed connections are *limited*: relays cap their duration and the bytes they carry (js-libp2p defaults: 2 minutes, 128 KiB). Providers MUST accept, and consumers MUST be able to open, UCEP streams on limited connections (js-libp2p: `runOnLimitedConnection: true` for `handle` and `dialProtocol`), so that the manifest and pairing work before a direct connection exists.
2. **Prefer direct.** A consumer SHOULD open a direct WebRTC connection (dial the `/p2p-circuit/webrtc/` address) before it calls commands, and MUST do so before a command whose result may exceed 64 KiB. On a limited connection a provider MUST NOT send a response larger than 64 KiB; it answers `TOO_LARGE` instead, and the consumer retries after upgrading.
3. **Relays see metadata.** A relay cannot read UCEP messages, but it learns which peers talk to each other, when, and how much. It also takes part in identify, so it learns which extensions a peer serves.
4. **Peers come and go.** Browser tabs close and mobile apps are suspended in the background; their relay reservations lapse. Consumers MUST expect a provider to be unreachable, SHOULD retry idempotent commands with the same `requestId`, and SHOULD tell their user that the other app must be open. Pairing requires both apps to be open and in the foreground.
5. **Stable identity.** Grants are bound to PeerIds ([ucep-auth.md §6](./ucep-auth.md#6-authorizing-commands)). A browser or mobile app that wants to keep its grants MUST keep its libp2p private key across reloads and restarts ([ucep-auth.md §11](./ucep-auth.md#11-storage)).

## 6. Manifest

A consumer asks for the manifest with `Request { manifest: ManifestRequest }`; the provider answers with `Response { manifest: ManifestResponse }`.

The manifest describes the extension: `id`, `name`, `version`, `description`, `author`, `publicUrl`, `icon`, and the list of `commands`. Since revision 0.2 it also carries:

- `ucepVersion`: the highest UCEP wire revision the provider speaks. `0` (absent) means the 0.1 draft; this document is revision `2`.
- `pairingModes`: the pairing modes the provider accepts (`INVITATION`, `IN_BAND`); empty means no pairing.
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

**Large results.** A result larger than the limits in [§11](#11-limits) SHOULD be returned by reference: a CID with its size and SHA-256, which the consumer fetches from the provider over Bitswap on the same, direct connection. A provider MUST NOT publish the content of a scoped command's result to public IPFS gateways or pinning services; anyone who learned the CID could fetch it there.

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

Pairing, grants, scopes and revocation are specified in [ucep-auth.md](./ucep-auth.md). In short: pairing works either with an **invitation** (QR code or link with an expiry, a one-time secret and offered scopes; the consumer proves it holds the secret with a `PairRequest` bound to both authenticated PeerIds) or **in-band** over libp2p (both apps show a six-digit code derived by commit and reveal, and the provider's human approves if they match). Either way the provider stores a **grant** for the consumer's PeerId; later commands are allowed if the grant holds the command's scope.

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
| Response message | 1 MiB on a direct connection, 64 KiB on a limited (relayed) one |
| `requestId` | 128 bytes |
| Manifest `icon` (`data:` URI) | 32 KiB |
| Concurrent streams per peer and protocol | 8 (providers MAY reject further streams) |

A provider MUST reject a longer length prefix before buffering the message.

## 12. Security considerations

See [SECURITY.md](./SECURITY.md) for the threat model. The essentials:

- **Identity is the PeerId of the secure channel.** Anything a peer writes into a message (a DID, a label, a name) is a claim until verified as in [ucep-auth.md](./ucep-auth.md).
- **Discovery is public.** Identify tells every connected peer — relays included — which extensions a node serves. libp2p registers protocol handlers per node, not per connection, so a node cannot hide an extension from some peers; it serves an extension only while it is willing to be seen offering it.
- **Results are untrusted input.** Consumers MUST validate `data` against the `resultSchema` or their own expectations and MUST NOT execute or render it unescaped.
- **Rate limiting.** Providers SHOULD limit requests per PeerId and pairing attempts per invitation.
- **No trust in broadcasts.** Extension claims from pubsub or any third party are hints; only identify and the manifest from the provider itself count ([§4](#4-discovery)).
- **Online checks.** Dialing a provider reveals the consumer's interest in it to the provider and to relays; consumers check only when needed and within the limits of [§4.1](#41-catalogue-and-online-status).

## 13. User interface

This section describes how a consumer presents extensions to its user. Where it uses RFC 2119 keywords, it states requirements; the layout itself is a recommendation. The Universal Connectivity chat shows the pattern: installed extensions appear as small icons in the app's UI.

### 13.1 Offers

When the catalogue learns of an extension that is neither installed nor dismissed, the consumer MAY show an **offer**: the extension's name, a short description, the provider's PeerId (shortened, e.g. `…T5jie`), and the buttons *Install* and *Dismiss*. It MUST NOT install on its own. Dismissed extension IDs SHOULD be remembered so the offer does not return on every reconnect. Offers SHOULD appear only for providers that are `online`.

### 13.2 Installed extensions

Each installed extension appears as an **icon** (the manifest's `icon`, or a placeholder until the user allows loading remote icons, see [§6](#6-manifest)) with a status marker:

| Marker | Meaning |
|--------|---------|
| online | At least one provider the extension may use is `online` |
| offline | No such provider is online; the tooltip shows `lastSeen` |
| pairing needed | The extension has commands with a scope and no grant yet, or the grant has expired |
| changed | A provider serves a new version or a changed manifest ([§4.1](#41-catalogue-and-online-status)) |

"May use" means: any provider for an extension without scopes; for an extension with scopes, the provider that issued the grant.

Opening an icon shows the extension's **detail view**: the manifest, its commands (with their scopes), and every provider with its PeerId (shortened, full ID copyable), status, `lastSeen`, and — if paired — the granted scopes and a button to unpair. The detail view offers *Check now* (the check of [§4.1](#41-catalogue-and-online-status)), *Pair* and *Uninstall*.

### 13.3 Adding by PeerId

The consumer offers an input — *Add by PeerId or link* — that accepts everything listed in [§4.2](#42-adding-a-provider-by-peerid), and, where a camera is available, a QR scanner for the same content. The result is a list of the extensions the provider serves, with a checkbox each, and *Install*. If the provider is not reachable, the consumer says so and keeps the entry as `unknown`, to be checked later.

### 13.4 Sharing, on the provider side

A provider SHOULD offer a *Share* screen that shows its PeerId and a provider link ([§4.2](#42-adding-a-provider-by-peerid)) with its current relay addresses, as text with a copy button and as a QR code. Sharing reveals nothing but the PeerId and addresses. The *Invite* screen for pairing ([ucep-auth.md §3](./ucep-auth.md#3-invitation)) MUST be separate and clearly different, because an invitation grants access.

### 13.5 Pairing

For an installed extension whose commands need scopes, the consumer offers *Pair*: scan or paste an invitation ([ucep-auth.md §5.1](./ucep-auth.md#51-with-an-invitation)), or pair in-band ([§5.2](./ucep-auth.md#52-in-band-without-an-invitation)) if the provider's manifest lists `IN_BAND`. During in-band pairing, the consumer shows the six-digit code large and prominently, with the instruction to compare it with the provider's screen.

## Appendix A. Differences from the 0.1 draft

The 0.1 draft is the protocol implemented in `NiKrause/js-libp2p-examples` (branch `uc-extensions-service`, `examples/js-libp2p-example-yjs-libp2p`) and in the Universal Connectivity js-peer. Revision 2:

1. adds pairing, grants and scopes (`PairRequest`, `UnpairRequest`, `ExtensionCommand.scope`, `ScopeInfo`);
2. adds `ErrorCode`;
3. adds `argsJson` and optional JSON Schemas for arguments and results;
4. adds `idempotent` and the 24-hour replay rule;
5. adds `ucepVersion` and `pairingModes` to the manifest, and in-band pairing;
6. requires the provider to always answer (no silent "ignore");
7. defines limits and SemVer matching of the protocol ID;
8. states the rules for browser, mobile and relayed connections;
9. adds the catalogue with online status, adding a provider by PeerId or provider link, and the user interface; states that discovery never uses pubsub broadcasts.

All 0.1 field numbers are unchanged.

[lifecycle]: https://github.com/libp2p/specs/blob/master/00-framework-01-spec-lifecycle.md
[identify]: https://github.com/libp2p/specs/blob/master/identify/README.md
[rfc2119]: https://www.rfc-editor.org/rfc/rfc2119
[rfc8174]: https://www.rfc-editor.org/rfc/rfc8174
[semver]: https://semver.org/spec/v2.0.0.html
[uvarint]: https://github.com/multiformats/unsigned-varint
