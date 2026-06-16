// tests/unit/httpServer_oidc_token_expiry.test.js
//
// Regression test for the third OIDC token-expiry fix. Two earlier commits
// (2fe4b8d, 9caa5fa) stopped the server from re-validating established
// sessions and from crashing on an unhandled rejection, but the client-visible
// symptom persisted: the customJwtVerify catch block rethrew the RAW jose
// error (JWTExpired etc.). mcp-auth's own handleBearerAuth only emits a
// proper 401 + `WWW-Authenticate: ... resource_metadata=...` response (the
// signal an OAuth client needs to refresh/re-authenticate) when the thrown
// error is an `instanceof MCPAuthTokenVerificationError`. A raw jose error
// fails that check, falls through to a re-throw inside an async Express
// handler, and previously reached the client as a bare 500 with no re-auth
// hint, so the client kept retrying with the same stale token forever.
//
// We (1) source-assert customJwtVerify wraps the caught error before
// rethrowing, and (2) behaviorally prove, using mcp-auth's real
// handleBearerAuth, that the wrapped error produces a clean 401 response
// while the old raw-throw behavior escapes the handler instead.
//
// Run: node tests/unit/httpServer_oidc_token_expiry.test.js

import assert from 'assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { handleBearerAuth } from 'mcp-auth';
import { MCPAuthTokenVerificationError } from 'mcp-auth';

let passed = 0, failed = 0;
async function check(label, fn) {
  try { await fn(); console.log(`  ok: ${label}`); passed++; }
  catch (err) { console.error(`  FAIL: ${label} -> ${err.message}`); failed++; }
}

console.log('\n[oidc-token-expiry] wiring');

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(resolve(here, '../../src/server/httpServer.ts'), 'utf8');

await check('customJwtVerify wraps the caught error in MCPAuthTokenVerificationError before rethrowing', () => {
  assert.match(src, /throw new MCPAuthTokenVerificationError\('invalid_token', err\)/);
});
await check('customJwtVerify no longer rethrows the raw jose error directly', () => {
  // The only bare "throw err;" that existed here pre-fix is gone from this catch block.
  const catchBlock = src.slice(src.indexOf('JWT token has expired'), src.indexOf('JWT token has expired') + 600);
  assert.doesNotMatch(catchBlock, /\n\s*throw err;\s*\n/);
});

console.log('\n[oidc-token-expiry] behavior via mcp-auth\'s real handleBearerAuth');

function fakeReqRes(token) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const state = { statusCode: undefined, body: undefined, headers: {} };
  const res = {
    set(name, value) { state.headers[name] = value; return res; },
    status(code) { state.statusCode = code; return res; },
    json(body) { state.body = body; return res; },
  };
  return { req: { headers }, res, state };
}

await check('POSITIVE: a wrapped MCPAuthTokenVerificationError yields a clean 401 with WWW-Authenticate (no throw)', async () => {
  const verifyAccessToken = async () => {
    throw new MCPAuthTokenVerificationError('invalid_token', new Error('"exp" claim timestamp check failed'));
  };
  const middleware = handleBearerAuth({
    verifyAccessToken,
    issuer: 'https://issuer.example',
    resource: 'https://actual-mcp.example',
  });
  const { req, res, state } = fakeReqRes('expired-token');
  let nextCalled = false;
  // Must resolve cleanly (no throw/rejection) and never call next() with an error.
  await middleware(req, res, () => { nextCalled = true; });
  assert.strictEqual(state.statusCode, 401);
  assert.ok(state.headers['WWW-Authenticate'], 'expected a WWW-Authenticate header');
  assert.match(state.headers['WWW-Authenticate'], /resource_metadata=/);
  assert.strictEqual(nextCalled, false);
});

await check('CONTRAST: a raw (unwrapped) jose-style error escapes handleBearerAuth instead of producing a 401', async () => {
  class FakeJoseJWTExpired extends Error {} // mirrors jose's error shape: not an mcp-auth error class
  const verifyAccessToken = async () => {
    throw new FakeJoseJWTExpired('"exp" claim timestamp check failed');
  };
  const middleware = handleBearerAuth({
    verifyAccessToken,
    issuer: 'https://issuer.example',
    resource: 'https://actual-mcp.example',
  });
  const { req, res } = fakeReqRes('expired-token');
  // This is exactly the old bug: the middleware rejects instead of responding,
  // which is why httpServer.ts needed Promise.resolve(...).catch(next) as a
  // backstop AND why that backstop alone was not sufficient (no custom Express
  // error handler exists to turn the forwarded error into a proper 401).
  await assert.rejects(() => middleware(req, res, () => {}), FakeJoseJWTExpired);
});

console.log(`\n[oidc-token-expiry] Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
