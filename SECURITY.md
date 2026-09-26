# Security model

This document lists what UCEP protects against, what it does not, and which rule of the spec covers each threat. Report vulnerabilities in the spec or in a reference implementation privately through GitHub security advisories of this repository, not in a public issue.

## Assets

- The provider's data and the actions it performs on behalf of its user (e.g. documents issued in the user's name).
- The consumer's data sent as command arguments.
- Invitation secrets and grants.

## Assumptions

- libp2p's secure channel (Noise or TLS) authenticates the PeerIds at both ends and encrypts the stream. Relays see only encrypted traffic.
- A libp2p private key is only known to its device.
- The human transfers the invitation (QR code, link) over a channel they trust: their own screen, their own messenger.

## Threats

| # | Threat | Mitigation | Spec |
|---|--------|------------|------|
| T1 | An arbitrary peer on the network calls a command that creates or reads data. | Commands with a scope require a grant for the authenticated PeerId. | auth §6 |
| T2 | A peer claims another identity in a message field. | Identity comes only from `connection.remotePeer`. A DID in a message counts only after it is verified, and even then it is attribution only. | auth §6, §9 |
| T3 | An attacker observes or guesses an invitation. | 256-bit secret, short expiry, single use, at most 5 failed attempts. The secret itself is never sent over the network. | auth §3, §5 |
| T4 | A captured `PairRequest` is replayed by another peer. | The proof covers both PeerIds; the provider takes the consumer's PeerId from the connection. | auth §4 |
| T5 | A replayed `PairRequest` asks for broader scopes. | The proof covers the sorted scopes; the provider only grants scopes that the invitation offered. | auth §4, §5 |
| T6 | QR-code swap: the attacker replaces the provider's QR code with their own, so the consumer pairs with the attacker and sends it data. | The consumer shows the provider's label and PeerId; in confirmation mode both sides show the same SAS. The human compares them. | auth §4, §5 |
| T7 | A stolen consumer device keeps using its grant. | The provider lists grants with their last use and can revoke them; grants may expire. | auth §8 |
| T8 | A consumer retries after a dropped stream and a document is created twice. | Idempotent commands with a 24-hour `requestId` replay window. | ucep §7 |
| T9 | A provider returns hostile content (script in `data`, giant icon). | Results and manifests are untrusted: consumers validate, escape and enforce size limits. | ucep §6, §11, §12 |
| T10 | Resource exhaustion through many or large requests. | Length-prefix check before buffering, timeouts, stream and rate limits. | ucep §5, §11 |
| T11 | Identify reveals which extensions a node serves. | Accepted: discovery is public by design. A node that must hide an extension does not advertise it on untrusted connections. | ucep §4 |

## Not covered

- A compromised provider or consumer device.
- A human who pairs with the wrong app despite the label and the SAS.
- Delegating grants to third apps and moving grants to a new device. Planned with capability tokens, see auth §12.
