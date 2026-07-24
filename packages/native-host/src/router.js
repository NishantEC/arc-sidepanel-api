'use strict';

const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const core = require('@arc-sidebar-api/core');
const { version } = require('../package.json');

const DEFAULT_OUTPUT_ROOT = path.join(os.homedir(), 'Library', 'Application Support', 'arc-sidebar-api', 'patched');

function slugify(name) {
  return name.replace(/[^a-z0-9-]+/gi, '-').replace(/^-+|-+$/g, '') || 'extension';
}

/**
 * Pure message handler: given a parsed request, returns the response to send
 * back (or null for fire-and-forget requests like "reveal"). Kept separate
 * from the stdio transport in index.js so it can be unit tested directly.
 */
function handleMessage(message, { outputRoot = DEFAULT_OUTPUT_ROOT, openInFinder = execFile } = {}) {
  switch (message?.type) {
    case 'ping':
      return { type: 'pong', version };

    case 'list-installed': {
      const extensions = core.listInstalledExtensions().map(({ dir, ...rest }) => rest);
      return { type: 'list-installed-result', extensions };
    }

    case 'patch': {
      try {
        const installed = core.listInstalledExtensions();
        const target = installed.find((ext) => ext.id === message.id);
        if (!target) {
          return { type: 'patch-error', id: message.id, error: `No installed extension found with id ${message.id}` };
        }
        const outputDir = path.join(outputRoot, `${slugify(target.name)}-${target.id}`);
        const result = core.patchExtension({ sourceDir: target.dir, outputDir });
        return { type: 'patch-result', id: message.id, outputDir: result.outputDir };
      } catch (err) {
        return { type: 'patch-error', id: message.id, error: err.message };
      }
    }

    case 'reveal':
      if (message.path) openInFinder('open', ['-R', message.path]);
      return null;

    default:
      return { type: 'error', error: `Unknown message type: ${message?.type}` };
  }
}

module.exports = { handleMessage, DEFAULT_OUTPUT_ROOT };
