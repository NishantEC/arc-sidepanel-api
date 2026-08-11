'use strict';

// Chrome's Native Messaging stdio protocol: each message is a 4-byte
// little-endian length prefix followed by that many bytes of UTF-8 JSON.
// https://developer.chrome.com/docs/apps/nativeMessaging/

function readMessages(stdin, onMessage) {
  let buffer = Buffer.alloc(0);
  stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) break;
      const body = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);
      try {
        onMessage(JSON.parse(body.toString('utf8')));
      } catch (err) {
        process.stderr.write(`arc-sidepanel-api host: failed to parse message: ${err.message}\n`);
      }
    }
  });
}

function sendMessage(stdout, message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  stdout.write(Buffer.concat([header, body]));
}

module.exports = { readMessages, sendMessage };
