# UCEP: Universal Connectivity Extension Protocol

UCEP lets a libp2p peer offer **extensions** — small services with named commands — that any other peer can discover and call, with no registry or server in between. Discovery rides on libp2p identify; every call is one request and one response on a short-lived stream; commands that change state or reveal data require a **grant** obtained by pairing.

**Status: Working Draft, wire revision 2.** Expect changes; feedback is welcome as issues and pull requests.

## Documents

| Document | Content |
|----------|---------|
| [ucep.md](./ucep.md) | Core protocol: protocol IDs, discovery, framing, manifest, commands, errors, versioning, limits |
| [ucep-auth.md](./ucep-auth.md) | Pairing, grants, scopes, revocation, optional DID binding |
| [messages.proto](./messages.proto) | Wire messages (proto3), compatible with the 0.1 draft |
| [extensions/](./extensions/) | Specified extensions: [`invoice`](./extensions/invoice.md) |
| [test-vectors/](./test-vectors/) | Deterministic vectors for the pairing proof, with the generator |
| [SECURITY.md](./SECURITY.md) | Threat model |

## Implementations

| Implementation | Role | Revision |
|----------------|------|----------|
| [js-libp2p-examples: yjs-libp2p spreadsheet](https://github.com/NiKrause/js-libp2p-examples/tree/uc-extensions-service/examples/js-libp2p-example-yjs-libp2p) | Provider (`sheet`) | 0.1 |
| [Universal Connectivity js-peer](https://github.com/NiKrause/universal-connectivity) | Consumer | 0.1 |
| Invoice PWA (Le-Space) | Provider (`invoice`) | planned, 0.2 |
| Belege (Le-Space) | Consumer (`invoice`) | planned, 0.2 |

To list an implementation, open a pull request that adds it to this table.

## Building the PDF

```bash
./build/pdf.sh
```

Needs `pandoc` and Google Chrome or Chromium. Writes `build/ucep-spec.pdf`.

## License

To be decided before the first publication.
