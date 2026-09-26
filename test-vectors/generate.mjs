#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Deterministic test vectors for UCEP pairing (ucep-auth.md, wire revision 2).
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

// DidProof format RAW for an Ed25519 did:key: pure Ed25519 over transcriptHash (ucep-auth.md §9).
function didSignature(transcriptHash) {
  const sig = sign(null, transcriptHash, consumerDid.privateKey);
  assert.ok(verify(null, transcriptHash, createPublicKey(consumerDid.privateKey), sig), 'didSignature must verify');
  assert.deepEqual(sign(null, transcriptHash, consumerDid.privateKey), sig); // Ed25519 is deterministic
  return hex(sig);
}

const keyEntry = (key, peer) => ({
  seedHex: hex(key.seed),
  publicKeyHex: hex(key.publicKey),
  peerId: peer.id,
  peerIdMultihashHex: hex(peer.multihash),
});

const provider = keyFromSeed('ucep test vector provider');
const consumer = keyFromSeed('ucep test vector consumer');
const relay = keyFromSeed('ucep test vector relay');
const consumerDid = keyFromSeed('ucep test vector consumer did');

const providerPeer = peerIdOf(provider.publicKey);
const consumerPeer = peerIdOf(consumer.publicKey);
const relayPeer = peerIdOf(relay.publicKey);
const did = didKeyOf(consumerDid.publicKey);

const extensionId = 'invoice';
const scopes = ['invoice:eigenbeleg:create', 'invoice:document:read'];
const byteOrder = (a, b) => Buffer.compare(utf8(a), utf8(b));
const scopeLine = (s) => [...s].sort(byteOrder).join(',');
const sasOf = (transcriptHash) => String(transcriptHash.readUInt32BE(0) % 1_000_000).padStart(6, '0');

// Browser and mobile providers cannot listen; they are reached through a relay.
const relayBase = `/dns4/relay.example.com/tcp/443/wss/p2p/${relayPeer.id}/p2p-circuit`;
const addrs = [`${relayBase}/webrtc/p2p/${providerPeer.id}`, `${relayBase}/p2p/${providerPeer.id}`];

// --- invitation mode (ucep-auth.md §3, §4, §5.1) ------------------------------------
const invitationId = 'inv_01J00000000000000000000000';
const secret = sha256(utf8('ucep test vector invitation secret'));
const secretB64url = secret.toString('base64url'); // Node emits no padding for base64url
assert.ok(!secretB64url.includes('='));
const expiresAt = 1790000000;

const e = encodeURIComponent;
const invitation =
  `web+ucep:pair` +
  `?v=1` +
  `&peer=${e(providerPeer.id)}` +
  `&ext=${e(extensionId)}` +
  `&inv=${e(invitationId)}` +
  `&s=${e(secretB64url)}` +
  `&exp=${e(String(expiresAt))}` +
  `&scope=${scopes.map(e).join(',')}` +
  addrs.map((a) => `&addr=${e(a)}`).join('');
const link = `https://app.example.com/#ucep=${e(invitation)}`;

function invitationTranscript({ consumerPeerId, requestedScopes, didLine }) {
  return ['ucep-pair-v1', extensionId, invitationId, providerPeer.id, consumerPeerId, scopeLine(requestedScopes), didLine].join('\n');
}

const NOW_VALID = 1789999999;
const NOW_EXPIRED = 1790000001;

function invitationVector({ name, description, consumerPeerIdInTranscript, requestedScopes, withDid = false, now, expected }) {
  const transcript = invitationTranscript({ consumerPeerId: consumerPeerIdInTranscript, requestedScopes, didLine: withDid ? did : '' });
  const bytes = utf8(transcript);
  const transcriptHash = sha256(bytes);
  const v = {
    name,
    description,
    now,
    connectionConsumerPeerId: consumerPeer.id,
    requestedScopes,
    did: withDid ? did : null,
    transcript,
    transcriptHex: hex(bytes),
    proofHex: hex(createHmac('sha256', secret).update(bytes).digest()),
    transcriptHashHex: hex(transcriptHash),
    sas: sasOf(transcriptHash),
  };
  if (withDid) v.didSignatureHex = didSignature(transcriptHash);
  v.expected = expected;
  return v;
}

const invitationVectors = [
  invitationVector({
    name: 'granted',
    description: 'Valid pairing request; provider grants.',
    consumerPeerIdInTranscript: consumerPeer.id,
    requestedScopes: scopes,
    now: NOW_VALID,
    expected: 'GRANTED',
  }),
  invitationVector({
    name: 'granted-with-did',
    description: 'Valid pairing request that binds a DID (line 7) with a RAW Ed25519 DidProof; provider grants.',
    consumerPeerIdInTranscript: consumerPeer.id,
    requestedScopes: scopes,
    withDid: true,
    now: NOW_VALID,
    expected: 'GRANTED',
  }),
  invitationVector({
    name: 'wrong-consumer-peer',
    description:
      "Proof computed with the provider's PeerId in line 5 instead of the consumer's. The provider rebuilds the transcript with the connection's consumer PeerId (connectionConsumerPeerId), so the HMAC does not match.",
    consumerPeerIdInTranscript: providerPeer.id,
    requestedScopes: scopes,
    now: NOW_VALID,
    expected: 'PAIRING_PROOF_INVALID',
  }),
  invitationVector({
    name: 'expired',
    description: 'Same transcript and proof as granted, evaluated after expiresAt.',
    consumerPeerIdInTranscript: consumerPeer.id,
    requestedScopes: scopes,
    now: NOW_EXPIRED,
    expected: 'INVITATION_EXPIRED',
  }),
  invitationVector({
    name: 'expires-now',
    description: 'Evaluated exactly at expiresAt. The rule is now <= expiresAt, so the invitation is still valid.',
    consumerPeerIdInTranscript: consumerPeer.id,
    requestedScopes: scopes,
    now: expiresAt,
    expected: 'GRANTED',
  }),
  invitationVector({
    name: 'scope-not-offered',
    description: 'Requested scopes include invoice:draft:create, which the invitation does not offer. The proof itself is valid.',
    consumerPeerIdInTranscript: consumerPeer.id,
    requestedScopes: [...scopes, 'invoice:draft:create'],
    now: NOW_VALID,
    expected: 'SCOPE_NOT_OFFERED',
  }),
];
assert.equal(invitationVectors[3].proofHex, invitationVectors[0].proofHex); // expired reuses granted
assert.notEqual(invitationVectors[2].proofHex, invitationVectors[0].proofHex);
assert.notEqual(invitationVectors[1].proofHex, invitationVectors[0].proofHex); // DID is covered by the proof

// --- in-band mode (ucep-auth.md §5.2) -----------------------------------------------
const pairingId = 'pair_01J00000000000000000000000';
const nonceC = sha256(utf8('ucep test vector nonceC'));
const nonceP = sha256(utf8('ucep test vector nonceP'));
const commitment = sha256(nonceC);

function inBandVector({ name, description, revealedNonce, withDid = false, expected }) {
  const v = {
    name,
    description,
    pairingId,
    connectionConsumerPeerId: consumerPeer.id,
    requestedScopes: scopes,
    did: withDid ? did : null,
    nonceCHex: hex(nonceC),
    commitmentHex: hex(commitment),
    noncePHex: hex(nonceP),
    revealedNonceHex: hex(revealedNonce),
  };
  if (sha256(revealedNonce).equals(commitment)) {
    const transcript = [
      'ucep-pair-inband-v1',
      extensionId,
      pairingId,
      providerPeer.id,
      consumerPeer.id,
      scopeLine(scopes),
      withDid ? did : '',
      hex(nonceC),
      hex(nonceP),
    ].join('\n');
    const bytes = utf8(transcript);
    const transcriptHash = sha256(bytes);
    Object.assign(v, {
      transcript,
      transcriptHex: hex(bytes),
      transcriptHashHex: hex(transcriptHash),
      sas: sasOf(transcriptHash),
    });
    if (withDid) v.didSignatureHex = didSignature(transcriptHash);
  }
  v.expected = expected;
  return v;
}

const inBandVectors = [
  inBandVector({
    name: 'in-band-sas',
    description: 'Reveal matches the commitment; both sides show this SAS. Granted once the provider\'s human confirms it.',
    revealedNonce: nonceC,
    expected: 'PENDING_THEN_GRANTED',
  }),
  inBandVector({
    name: 'in-band-sas-with-did',
    description: 'As in-band-sas, with a DID bound in step 2 (line 7) and a RAW Ed25519 DidProof.',
    revealedNonce: nonceC,
    withDid: true,
    expected: 'PENDING_THEN_GRANTED',
  }),
  inBandVector({
    name: 'in-band-commitment-mismatch',
    description: 'The revealed nonce does not hash to the commitment from step 1; the provider drops the pairing.',
    revealedNonce: sha256(utf8('ucep test vector other nonce')),
    expected: 'COMMITMENT_MISMATCH',
  }),
];

const out = {
  version: 'ucep-pair-v1',
  keys: {
    provider: keyEntry(provider, providerPeer),
    consumer: keyEntry(consumer, consumerPeer),
    relay: keyEntry(relay, relayPeer),
    consumerDid: { seedHex: hex(consumerDid.seed), publicKeyHex: hex(consumerDid.publicKey), did },
  },
  invitation: {
    providerPeerId: providerPeer.id,
    extensionId,
    invitationId,
    secretHex: hex(secret),
    secretB64url,
    expiresAt,
    scopes,
    addrs,
    invitation,
    link,
  },
  vectors: invitationVectors,
  inBandVectors,
};

const target = join(dirname(fileURLToPath(import.meta.url)), 'pairing-v1.json');
writeFileSync(target, JSON.stringify(out, null, 2) + '\n');
console.log(`wrote ${target}`);
