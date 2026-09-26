#!/usr/bin/env node
// Deterministic test vectors for UCEP pairing (ucep-pair-v1).
// Uses only Node 22 built-ins. Run: node test-vectors/generate.mjs
// Writes test-vectors/pairing-v1.json next to this file.

import { createHash, createHmac, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const sha256 = (data) => createHash('sha256').update(data).digest();
const utf8 = (s) => Buffer.from(s, 'utf8');
const hex = (b) => Buffer.from(b).toString('hex');

// --- base58btc (Bitcoin alphabet) ---------------------------------------------
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58btc(bytes) {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  return '1'.repeat(zeros) + out;
}
function base58btcDecode(str) {
  let n = 0n;
  for (const c of str) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error(`invalid base58 char ${c}`);
    n = n * 58n + BigInt(i);
  }
  const bytes = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  let zeros = 0;
  while (zeros < str.length && str[zeros] === '1') zeros++;
  return Buffer.from([...new Array(zeros).fill(0), ...bytes]);
}

// --- keys ---------------------------------------------------------------------
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
function keyFromSeed(label) {
  const seed = sha256(utf8(label));
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  const publicKey = spki.subarray(spki.length - 32);
  assert.equal(publicKey.length, 32);
  return { seed, privateKey, publicKey };
}

// libp2p PeerId for an Ed25519 key: identity multihash of the protobuf PublicKey.
function peerIdOf(publicKey) {
  const protobuf = Buffer.concat([Buffer.from([0x08, 0x01, 0x12, 0x20]), publicKey]);
  assert.equal(protobuf.length, 36);
  const multihash = Buffer.concat([Buffer.from([0x00, 0x24]), protobuf]);
  const id = base58btc(multihash);
  assert.ok(id.startsWith('12D3KooW'), `unexpected peerId prefix: ${id}`);
  assert.deepEqual(base58btcDecode(id), multihash);
  return { id, multihash };
}

function didKeyOf(publicKey) {
  const did = 'did:key:z' + base58btc(Buffer.concat([Buffer.from([0xed, 0x01]), publicKey]));
  assert.ok(did.startsWith('did:key:z6Mk'), `unexpected did prefix: ${did}`);
  return did;
}

const provider = keyFromSeed('ucep test vector provider');
const consumer = keyFromSeed('ucep test vector consumer');
const consumerDid = keyFromSeed('ucep test vector consumer did');

const providerPeer = peerIdOf(provider.publicKey);
const consumerPeer = peerIdOf(consumer.publicKey);
const did = didKeyOf(consumerDid.publicKey);

// --- invitation -----------------------------------------------------------------
const extensionId = 'invoice';
const invitationId = 'inv_01J00000000000000000000000';
const secret = sha256(utf8('ucep test vector invitation secret'));
const secretB64url = secret.toString('base64url'); // Node emits no padding for base64url
assert.ok(!secretB64url.includes('='));
const expiresAt = 1790000000;
const scopes = ['invoice:eigenbeleg:create', 'invoice:document:read'];
const multiaddr = `/dns4/relay.example.com/tcp/443/wss/p2p/${providerPeer.id}`;

const e = encodeURIComponent;
const uri =
  `ucep-pair:${providerPeer.id}` +
  `?v=1` +
  `&ext=${e(extensionId)}` +
  `&inv=${e(invitationId)}` +
  `&s=${e(secretB64url)}` +
  `&exp=${e(String(expiresAt))}` +
  `&scope=${scopes.map(e).join(',')}` +
  `&addr=${e(multiaddr)}`;

// --- pairing transcript -----------------------------------------------------------
const byteOrder = (a, b) => Buffer.compare(utf8(a), utf8(b));

function transcriptOf({ consumerPeerId, requestedScopes, didLine }) {
  const lines = [
    'ucep-pair-v1',
    extensionId,
    invitationId,
    providerPeer.id,
    consumerPeerId,
    [...requestedScopes].sort(byteOrder).join(','),
    didLine,
  ];
  return lines.join('\n');
}

// Evaluation time for vectors that are expected to be within the validity window.
const NOW_VALID = 1789999999;
const NOW_EXPIRED = 1790000001;

function vector({ name, description, consumerPeerIdInTranscript, requestedScopes, withDid, now, expected }) {
  const transcript = transcriptOf({
    consumerPeerId: consumerPeerIdInTranscript,
    requestedScopes,
    didLine: withDid ? did : '',
  });
  const transcriptBytes = utf8(transcript);
  const proof = createHmac('sha256', secret).update(transcriptBytes).digest();
  const transcriptHash = sha256(transcriptBytes);
  const v = {
    name,
    description,
    now,
    connectionConsumerPeerId: consumerPeer.id,
    requestedScopes,
    did: withDid ? did : null,
    transcript,
    transcriptHex: hex(transcriptBytes),
    proofHex: hex(proof),
    transcriptHashHex: hex(transcriptHash),
    // Short authentication string, ucep-auth.md §4.
    sas: String(transcriptHash.readUInt32BE(0) % 1_000_000).padStart(6, '0'),
  };
  if (withDid) {
    const sig = sign(null, transcriptHash, consumerDid.privateKey);
    assert.ok(verify(null, transcriptHash, createPublicKey(consumerDid.privateKey), sig), 'didSignature must verify');
    // Ed25519 is deterministic: signing again must give the same bytes.
    assert.deepEqual(sign(null, transcriptHash, consumerDid.privateKey), sig);
    v.didSignatureHex = hex(sig);
  }
  v.expected = expected;
  return v;
}

const vectors = [
  vector({
    name: 'with-did',
    description: 'Valid pairing request with a consumer DID; provider grants.',
    consumerPeerIdInTranscript: consumerPeer.id,
    requestedScopes: scopes,
    withDid: true,
    now: NOW_VALID,
    expected: 'GRANTED',
  }),
  vector({
    name: 'without-did',
    description: 'Valid pairing request without a DID (line 7 empty, no didSignature); provider grants.',
    consumerPeerIdInTranscript: consumerPeer.id,
    requestedScopes: scopes,
    withDid: false,
    now: NOW_VALID,
    expected: 'GRANTED',
  }),
  vector({
    name: 'wrong-consumer-peer',
    description:
      "Proof computed with the provider's peerId in line 5 instead of the consumer's. The provider rebuilds the transcript with the connection's consumer peerId (connectionConsumerPeerId), so the HMAC does not match.",
    consumerPeerIdInTranscript: providerPeer.id,
    requestedScopes: scopes,
    withDid: true,
    now: NOW_VALID,
    expected: 'PAIRING_PROOF_INVALID',
  }),
  vector({
    name: 'expired',
    description: 'Same valid transcript and proof as with-did, but evaluated after expiresAt.',
    consumerPeerIdInTranscript: consumerPeer.id,
    requestedScopes: scopes,
    withDid: true,
    now: NOW_EXPIRED,
    expected: 'INVITATION_EXPIRED',
  }),
  vector({
    name: 'expires-now',
    description: 'Evaluated exactly at expiresAt. The rule is now <= expiresAt, so the invitation is still valid.',
    consumerPeerIdInTranscript: consumerPeer.id,
    requestedScopes: scopes,
    withDid: true,
    now: 1790000000,
    expected: 'GRANTED',
  }),
  vector({
    name: 'scope-not-offered',
    description: 'Requested scopes include invoice:draft:create, which the invitation does not offer. The proof itself is valid.',
    consumerPeerIdInTranscript: consumerPeer.id,
    requestedScopes: [...scopes, 'invoice:draft:create'],
    withDid: true,
    now: NOW_VALID,
    expected: 'SCOPE_NOT_OFFERED',
  }),
];

// Sanity: the expired vector reuses the with-did proof.
assert.equal(vectors[3].proofHex, vectors[0].proofHex);
assert.notEqual(vectors[2].proofHex, vectors[0].proofHex);

const out = {
  version: 'ucep-pair-v1',
  keys: {
    provider: {
      seedHex: hex(provider.seed),
      publicKeyHex: hex(provider.publicKey),
      peerId: providerPeer.id,
      peerIdMultihashHex: hex(providerPeer.multihash),
    },
    consumer: {
      seedHex: hex(consumer.seed),
      publicKeyHex: hex(consumer.publicKey),
      peerId: consumerPeer.id,
      peerIdMultihashHex: hex(consumerPeer.multihash),
    },
    consumerDid: {
      seedHex: hex(consumerDid.seed),
      publicKeyHex: hex(consumerDid.publicKey),
      did,
    },
  },
  invitation: {
    providerPeerId: providerPeer.id,
    extensionId,
    invitationId,
    secretHex: hex(secret),
    secretB64url,
    expiresAt,
    scopes,
    multiaddr,
    uri,
  },
  vectors,
};

const target = join(dirname(fileURLToPath(import.meta.url)), 'pairing-v1.json');
writeFileSync(target, JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${target}`);
