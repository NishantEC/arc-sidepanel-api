#!/usr/bin/env node
'use strict';

const { readMessages, sendMessage } = require('./protocol');
const { handleMessage } = require('./router');

readMessages(process.stdin, (message) => {
  const response = handleMessage(message);
  if (response) sendMessage(process.stdout, response);
});
