/**
 * Host-side resolution check for the `dsh.client` declaration.
 *
 * Unlike client-bundle-stub.mjs (which fakes the browser), this script exercises the
 * REAL installed host stack from the `web` profile:
 *   1. Node's own resolver through the profile's node_modules symlink — this is the
 *      same lookup `ClientModuleRegistry.locatePkgJson` performs
 *      (`internal.resolveSync(loaderName, baseUrl, {})`),
 *   2. the real `ClientModuleRegistry` service, whose `resolveMeta()` is the code that
 *      validates `dsh.client` and reads `exports["./client"]`,
 *   3. the real `stripClientSuffix` helper used by the browser-side module table.
 *
 * Run: node test/client-bundle-host-resolve.mjs
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROFILE = '/root/.dsh/profiles/web';

const log = [];
const step = (name, detail) => log.push(`  ok  ${name}${detail === undefined ? '' : ` — ${detail}`}`);

/* 1. Node resolution through the profile ---------------------------------- */

const profileRequire = createRequire(join(PROFILE, 'package.json'));
const hostEntry = profileRequire.resolve('dsh-modeltrace');
const clientEntry = profileRequire.resolve('dsh-modeltrace/client');
assert.equal(hostEntry, '/root/dsha-modeltrace/lib/index.js', 'host entry resolution');
assert.equal(clientEntry, '/root/dsha-modeltrace/lib/client.js', 'client entry resolution');
step('node resolution via profile', `dsh-modeltrace → ${hostEntry}; dsh-modeltrace/client → ${clientEntry}`);

const clientStat = statSync(clientEntry);
assert.ok(clientStat.isFile() && clientStat.size > 0, 'client bundle must exist at startup');
step('bundle artifact', `${clientStat.size} bytes, mtime ${clientStat.mtime.toISOString()}`);

/* 2. The real host service: ClientModuleRegistry.resolveMeta() ------------- */

const registryModule = await import('@deepseek-ai/dsh-client-modules');
const cordisModule = await import('@deepseek-ai/cordis');

assert.equal(typeof registryModule.ClientModuleRegistry, 'function', 'ClientModuleRegistry export');

const findings = [];
const root = new cordisModule.Context();
// ClientModuleRegistry statically injects `loader`. `internal: undefined` reproduces a
// production run WITHOUT --expose-internals, which is the branch that resolves the
// package manifest via createRequire(baseUrl).resolve('<pkg>/package.json').
root.provide('loader', { entries: () => [], internal: undefined });
const registry = new registryModule.ClientModuleRegistry(root);
const resolved = registry.resolveMeta('dsh-modeltrace', pathToFileURL(PROFILE + '/').href);
assert.notEqual(resolved, null, 'resolveMeta must not skip dsh-modeltrace (it returns null when the manifest is unreachable)');
assert.equal(resolved.packageName, 'dsh-modeltrace', 'packageName');
assert.equal(resolved.meta.clientPath, '/root/dsha-modeltrace/lib/client.js', 'clientPath');
assert.equal(resolved.meta.immediately, false, 'immediately defaults to false');
assert.ok(Array.isArray(resolved.meta.inject), 'inject must survive parseDshClient as a string array');
step(
    'real ClientModuleRegistry.resolveMeta()',
    `clientPath=${resolved.meta.clientPath}, inject=[${resolved.meta.inject.join(', ')}], external=[${resolved.meta.external.join(', ')}]`
);
findings.push('resolveMeta is the real gate: it returned null until exports["./package.json"] existed.');

/* 3. stripClientSuffix ---------------------------------------------------- */

assert.equal(registryModule.stripClientSuffix('dsh-modeltrace/client'), 'dsh-modeltrace');
assert.equal(registryModule.stripClientSuffix('dsh-modeltrace'), 'dsh-modeltrace');
step('stripClientSuffix', 'the browser-side module table treats "dsh-modeltrace/client" === "dsh-modeltrace"');

/* 4. orderByModuleGraph accepts our declaration --------------------------- */

const ordered = registryModule.orderByModuleGraph([
    { id: 'dsh-modeltrace', external: [], inject: ['@deepseek-ai/dsh-client-ui-settings-plugins'], immediately: false },
    { id: 'dsh-client-ui-settings-plugins', external: [], inject: [], immediately: false }
]);
assert.deepEqual(
    ordered.map((row) => row.id).sort(),
    ['dsh-client-ui-settings-plugins', 'dsh-modeltrace']
);
step('orderByModuleGraph', `accepted ${ordered.length} rows without a cycle`);

console.log(log.join('\n'));
if (findings.length > 0) console.log('\nnotes:\n' + findings.map((line) => `  * ${line}`).join('\n'));
console.log('\nHOST-SIDE RESOLUTION CHECKS PASSED');
