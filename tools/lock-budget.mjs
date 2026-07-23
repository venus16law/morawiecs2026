#!/usr/bin/env node
/**
 * Encrypt the private Planning/budget section inside index.html.
 *
 * The section used to be plain HTML hidden with `display:none` behind a
 * JavaScript passcode check — meaning anyone could read the vendor costs,
 * payment dates and guest notes straight from the page source. This script
 * replaces that content with AES-256-GCM ciphertext. Without the passphrase
 * the page source contains nothing but random bytes.
 *
 *   Lock:    node tools/lock-budget.mjs
 *   Unlock:  node tools/lock-budget.mjs --unlock     (to edit the content again)
 *
 * You'll be prompted for the passphrase. It is never written to disk or
 * committed — only you and whoever you share it with can open the section.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { webcrypto as crypto } from 'node:crypto';
import { createInterface } from 'node:readline';

const FILE = new URL('../index.html', import.meta.url);
const OPEN_TAG = '<div id="modal-content" style="display:none;">';
const CLOSE_TAG = '</div><!-- /modal-content -->';
const PAYLOAD_RE = /<script type="application\/json" id="budget-payload">([\s\S]*?)<\/script>/;
const ITERATIONS = 310000;

const enc = new TextEncoder();
const dec = new TextDecoder();

const b64 = (buf) => Buffer.from(buf).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

async function deriveKey(passphrase, salt) {
  const material = await crypto.subtle.importKey(
    'raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/* ── input ───────────────────────────────────────────────────────────────
   One shared readline plus a queue of received lines. Piped input can
   deliver several lines in a single chunk, so lines that arrive before the
   next prompt is registered must be buffered rather than dropped.        */
let _rl = null;
const _lines = [];
let _waiter = null;

function initRl() {
  if (_rl) return _rl;
  _rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  _rl.on('line', (line) => {
    if (_waiter) { const w = _waiter; _waiter = null; w(line); }
    else _lines.push(line);
  });
  _rl.on('close', () => { if (_waiter) { const w = _waiter; _waiter = null; w(''); } });
  return _rl;
}

const closeRl = () => { if (_rl) { _rl.close(); _rl = null; } };

function prompt(question, { hidden = false } = {}) {
  initRl();
  process.stdout.write(question);

  const masking = hidden && process.stdin.isTTY;
  let typed = 0;
  const onData = (chunk) => {
    const s = chunk.toString();
    if (s === '\r' || s === '\n') return;
    typed += s.length;
    process.stdout.write('\x1b[2K\x1b[200D' + question + '*'.repeat(typed));
  };
  if (masking) process.stdin.on('data', onData);

  return new Promise((resolve) => {
    if (_lines.length) return resolve(_lines.shift());
    _waiter = resolve;
  }).then((line) => {
    if (masking) { process.stdin.off('data', onData); process.stdout.write('\n'); }
    return line;
  });
}

function fail(msg) {
  console.error('\n' + msg);
  closeRl();
  process.exit(1);
}

function slice(html) {
  const start = html.indexOf(OPEN_TAG);
  const end = html.indexOf(CLOSE_TAG);
  if (start === -1 || end === -1 || end < start) {
    fail('Could not find the budget section markers in index.html.\nExpected:\n  ' + OPEN_TAG + '\n  ' + CLOSE_TAG);
  }
  return {
    before: html.slice(0, start + OPEN_TAG.length),
    inner: html.slice(start + OPEN_TAG.length, end),
    after: html.slice(end),
  };
}

async function lock() {
  const html = readFileSync(FILE, 'utf8');
  const { before, inner, after } = slice(html);

  if (PAYLOAD_RE.test(inner)) fail('Already locked. Run with --unlock first if you want to re-encrypt.');
  if (!inner.trim()) fail('The budget section is empty — nothing to lock.');

  const pass = await prompt('Passphrase: ', { hidden: true });
  const again = await prompt('Confirm:    ', { hidden: true });
  if (!pass || pass !== again) fail('Passphrases did not match.');
  if (pass.length < 12) {
    fail('Use at least 12 characters — the ciphertext is public, so a short passphrase can be cracked offline.');
  }

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pass, salt);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(inner));

  const payload = { v: 1, kdf: 'PBKDF2-SHA256', iters: ITERATIONS, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
  const replacement =
    '\n      <script type="application/json" id="budget-payload">' +
    JSON.stringify(payload) +
    '<\/script>\n    ';

  writeFileSync(FILE, before + replacement + after);
  closeRl();
  console.log(`\n✓ Locked. ${inner.length.toLocaleString()} characters of budget detail replaced with ciphertext.`);
  console.log('  Commit index.html — the plaintext is gone from the file.');
}

async function unlock() {
  const html = readFileSync(FILE, 'utf8');
  const { before, inner, after } = slice(html);

  const match = inner.match(PAYLOAD_RE);
  if (!match) fail('No encrypted payload found — the section may already be unlocked.');

  const payload = JSON.parse(match[1]);
  const pass = await prompt('Passphrase: ', { hidden: true });
  const key = await deriveKey(pass, unb64(payload.salt));

  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(payload.iv) }, key, unb64(payload.ct));
  } catch {
    fail('Wrong passphrase.');
  }

  writeFileSync(FILE, before + dec.decode(plain) + after);
  closeRl();
  console.log('\n✓ Unlocked in place. Edit index.html, then re-run `node tools/lock-budget.mjs` before committing.');
  console.log('  ⚠️  Do not commit while unlocked — the plaintext is back in the file.');
}

const mode = process.argv.includes('--unlock') ? unlock : lock;
mode().catch((e) => { console.error(e); closeRl(); process.exit(1); });
