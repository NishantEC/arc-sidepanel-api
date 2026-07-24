#!/usr/bin/env node
'use strict';

// Generates a fresh RSA keypair for packages/extension/manifest.json's "key"
// field, and derives the Chrome/Arc extension ID that key produces. Pinning
// a key keeps the extension's ID stable across reinstalls, so the native
// host's allowed_origins can hardcode it. Only the public key is ever used -
// the private key is discarded on purpose, since nothing is ever signed with
// it; any keypair that hashes to the checked-in ID would work identically.
//
// Usage: node scripts/generate-extension-key.js

const crypto = require('node:crypto');

const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const der = publicKey.export({ type: 'spki', format: 'der' });
const keyBase64 = der.toString('base64');

const hash = crypto.createHash('sha256').update(der).digest();
let extensionId = '';
for (let i = 0; i < 16; i++) {
  extensionId += String.fromCharCode(97 + (hash[i] >> 4));
  extensionId += String.fromCharCode(97 + (hash[i] & 0x0f));
}

console.log(`manifest.json "key": ${keyBase64}`);
console.log(`Resulting extension ID: ${extensionId}`);
