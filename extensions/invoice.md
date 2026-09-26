# Extension `invoice`

| Extension ID | Version | Status | Scopes |
|--------------|---------|--------|--------|
| `invoice` | 0.1.0 | Working Draft | yes |

Protocol ID: `/uc/extension/invoice/0.1.0`

An invoicing app offers this extension so that other apps — typically a bookkeeping app — can ask it to create documents: a **self-issued receipt** (German *Eigenbeleg*) for a payment that has no third-party receipt, or an **invoice draft** the user finishes and issues in the invoicing app. The reference provider is the Invoice PWA (Le-Space); the reference consumer is Belege.

All examples use made-up data.

## Why a self-issued receipt is not an invoice

An invoice is issued by a seller to a buyer and must meet the seller's legal requirements (in Germany §14 UStG: consecutive number, tax details, …). A self-issued receipt documents a payment the business made or received when no receipt from the other party exists — for example fees paid on a blockchain that issues no invoices. It has its own number range, states why no third-party receipt exists, and is signed off by the person who created it. Providers MUST keep the two apart: `create-eigenbeleg` never consumes an invoice number.

## Scopes

| Scope | Description shown to the user |
|-------|-------------------------------|
| `invoice:eigenbeleg:create` | Create self-issued receipts (Eigenbelege) in your name. |
| `invoice:draft:create` | Create invoice drafts. Drafts are only issued when you issue them in the invoicing app. |
| `invoice:document:read` | Read documents this app created, including their PDF. |

A grant for `invoice:document:read` only covers documents created under the **same grant**. It never reveals other documents of the provider.

## Commands

All arguments are passed as `argsJson`. Amounts are decimal **strings**, never floating-point numbers. Timestamps are ISO 8601 with an offset.

### `help` (public)

Returns `{ "commands": [ { "name", "syntax", "description", "scope" } ] }`.

### `create-eigenbeleg` (scope `invoice:eigenbeleg:create`, idempotent)

Arguments:

```json
{
  "date": "2026-09-01",
  "direction": "outgoing",
  "reason": "The network charges fees on-chain and issues no invoice.",
  "description": "Network fee for a lease payment",
  "amount": { "value": "12.34", "currency": "EUR" },
  "crypto": {
    "chain": "cosmos:akashnet-2",
    "asset": "cosmos:akashnet-2/slip44:118",
    "symbol": "AKT",
    "quantity": "4.200000",
    "txRef": "0000000000000000000000000000000000000000000000000000000000000000",
    "explorerUrl": "https://explorer.example.com/tx/0000…",
    "valuation": {
      "rate": "2.938095",
      "rateCurrency": "EUR",
      "source": "coingecko:history",
      "at": "2026-09-01T12:00:00+00:00"
    }
  },
  "counterparty": { "name": "Stromwerk Test AG", "address": "unknown" },
  "reference": { "system": "belege", "id": "01J0000000000000000000000A" }
}
```

| Field | Rule |
|-------|------|
| `date` | Date of the payment. REQUIRED. |
| `direction` | `outgoing` or `incoming`. REQUIRED. |
| `reason` | Why no third-party receipt exists. REQUIRED, non-empty. |
| `description` | What was paid for. REQUIRED. |
| `amount` | Amount in the booking currency. REQUIRED. |
| `crypto` | For crypto payments. `chain` is a [CAIP-2][caip2] chain ID, `asset` a [CAIP-19][caip19] asset ID, `quantity` a decimal string in whole units. `valuation` records the exchange rate used and its source. OPTIONAL. |
| `counterparty` | As far as known. OPTIONAL. |
| `reference` | The consumer's own record ID, printed on the document so it can be matched back. OPTIONAL. |

The provider fills in the issuer (its own company details), assigns the next number in its self-receipt number range, records the grant's label and, if one was bound, its DID as the requesting app and user, renders the PDF, and stores the document.

Result:

```json
{
  "documentId": "01J0000000000000000000000B",
  "number": "EB-2026-0001",
  "state": "created",
  "file": {
    "mime": "application/pdf",
    "cid": "bafy…",
    "size": 48213,
    "sha256": "…"
  }
}
```

If the provider needs its human to sign off first, `state` is `awaiting-approval` and `file` is absent; the consumer polls `status`.

### `create-draft` (scope `invoice:draft:create`, idempotent)

Arguments: `customer` (`{ number?, name, address, vatId? }`), `lines` (`[{ description, quantity, unit, unitPrice: { value, currency }, vatRate, crypto? }]`, where `crypto` has the same shape as above and ties a line to an on-chain payment), `deliveryDate?`, `notes?`, `reference?`.

Result: `{ "documentId", "state": "draft" }`. A draft has no number; the user issues it in the invoicing app. The consumer learns the number through `status`.

### `status` (scope `invoice:document:read`)

Arguments: `{ "documentId": "…" }`.
Result: `{ "documentId", "kind": "eigenbeleg" | "invoice", "state": "draft" | "awaiting-approval" | "created" | "issued" | "cancelled", "number"?, "file"? }`.

### `get-pdf` (scope `invoice:document:read`)

Arguments: `{ "documentId": "…" }`.
Result: `{ "mime", "cid", "size", "sha256" }`, and additionally `base64` if the PDF is smaller than 700 KiB **and** the connection is direct (so the response stays within 1 MiB). On a relayed connection, and for larger files, the consumer fetches the file by CID over Bitswap from the provider ([ucep.md §5.1](../ucep.md#51-browser-mobile-and-relayed-connections), [§7](../ucep.md#7-commands)). The provider never publishes documents to public gateways.

## Errors

Besides the UCEP error codes, `data` MAY carry `{ "field": "…" }` with `INVALID_ARGUMENTS` to point at the offending argument. An unknown `documentId`, or one created under another grant, gives `INVALID_ARGUMENTS` — never a hint that the document exists.

[caip2]: https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md
[caip19]: https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-19.md
