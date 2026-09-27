import test from 'node:test';
import assert from 'node:assert/strict';
import { app, isValidLogin, parsePage } from '../server.js';

test('isValidLogin accepts well-formed GitHub usernames', () => {
  assert.equal(isValidLogin('a'), true);
  assert.equal(isValidLogin('a-b'), true);
  assert.equal(isValidLogin('torvalds'), true);
  assert.equal(isValidLogin('a'.repeat(39)), true);
});

test('isValidLogin rejects malformed usernames', () => {
  assert.equal(isValidLogin('-a'), false); // leading hyphen
  assert.equal(isValidLogin('a-'), false); // trailing hyphen
  assert.equal(isValidLogin('a--b'), false); // consecutive hyphens
  assert.equal(isValidLogin('a'.repeat(40)), false); // too long
  assert.equal(isValidLogin('a_b'), false); // underscore not allowed
  assert.equal(isValidLogin('../etc'), false); // path traversal attempt
  assert.equal(isValidLogin(''), false);
});

test('parsePage accepts 1-10 and defaults to 1', () => {
  assert.equal(parsePage(undefined), 1);
  assert.equal(parsePage('1'), 1);
  assert.equal(parsePage('10'), 10);
});

test('parsePage rejects out-of-range or non-numeric values', () => {
  assert.equal(parsePage('0'), null);
  assert.equal(parsePage('11'), null);
  assert.equal(parsePage('abc'), null);
  assert.equal(parsePage('1.5'), null);
});

test('server rejects an invalid username with 400 before contacting GitHub', async () => {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://localhost:${port}/api/user/bad--name`);
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});
