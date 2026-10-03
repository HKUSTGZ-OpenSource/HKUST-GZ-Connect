'use strict';

const args = process.argv.slice(2);
if (![2, 4].includes(args.length) || args[0] !== '--origin') process.exit(2);
if (args.length === 4 && (args[2] !== '--leaf-sha256' || !/^[a-f0-9]{64}$/u.test(args[3]))) process.exit(2);
let origin;
try {
  const parsed = new URL(args[1]);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
      parsed.pathname !== '/' || parsed.search || parsed.hash) process.exit(3);
  origin = parsed.origin;
} catch { process.exit(3); }

process.stdout.write(`${JSON.stringify({
  schema_version: args.length === 2 ? 2 : 1,
  normalized_origin: origin,
  https_identity_valid: args.length !== 2,
  compatibility: 'recognized_candidate',
  candidate_family: 'easyconnect-password-modern-l3-v1',
  reported_version: 'M7.6.8R2',
  http_status: 200,
  ...(args.length === 2 ? { certificate_requires_confirmation: true, leaf_sha256: 'ab'.repeat(32) } : {}),
})}\n`);
