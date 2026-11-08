// Static inspection only: never executes setup/uninstall or writes associations.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { collectBuildInfo } from '../scripts/build-info.mjs';

const root = resolve('.'), folder = resolve(process.argv[2] || 'artifacts/windows/0.4.1');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(readFileSync(join(folder, 'SHA256.json'), 'utf8').replace(/^\ufeff/, ''));
const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
assert.equal(manifest.verification, false); assert.equal(manifest.identifier, 'com.markdowneditor.kit');
assert.equal(manifest.version, config.version); assert.equal(manifest.buildSource.version, config.version);
assert.equal(manifest.buildSource.channel, 'production'); assert.equal(manifest.buildSource.dirty, false);
assert.equal(manifest.buildSource.revision, collectBuildInfo(root, 'build', 'production').revision);
assert.equal(manifest.buildSource.sourceSha256, collectBuildInfo(root, 'build', 'production').sourceSha256);
for (const f of manifest.files) {
  const bytes = readFileSync(join(folder, f.name)); assert.equal(bytes.length, f.bytes); assert.equal(hash(bytes), f.sha256);
}
const binary = readFileSync(join(folder, 'Mintdown.exe')), pe = binary.readUInt32LE(0x3c);
assert.equal(binary.toString('ascii', pe, pe + 4), 'PE\0\0'); assert.equal(binary.readUInt16LE(pe + 4), 0x8664);
assert.equal(binary.readUInt16LE(pe + 24 + 68), 2, 'Windows GUI executable');
assert.equal(binary.includes(Buffer.from('window.__MINTDOWN_TEST_DIALOGS__=')), false);
const suspicious = /github_pat_[A-Za-z0-9_]{24,}|gh[pousr]_[A-Za-z0-9]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}/;
assert.equal(suspicious.test(binary.toString('utf8')), false, 'Possible credentials in release executable');
for (const name of readdirSync('dist/assets')) {
  assert.equal(name.endsWith('.map'), false, 'Development source map in frontend');
  if (name.endsWith('.js')) {
    const js = readFileSync(join('dist/assets', name), 'utf8');
    assert.equal(/__MINTDOWN_TEST_DIALOGS__|__MINTDOWN_RENDER_EXPORT__|__MINTDOWN_LAST_EXPORT__/.test(js), false, `Native test hook in production: ${name}`);
    assert.equal(suspicious.test(js), false, `Potential secret in ${name}`);
  }
}
const target = process.env.CARGO_TARGET_DIR || 'src-tauri/target/d2';
const nsi = readFileSync(join(target, 'release/nsis/x64/installer.nsi'), 'utf8');
for (const definition of ['PRODUCTNAME "Mintdown"', `VERSION "${config.version}"`, 'BUNDLEID "com.markdowneditor.kit"', 'MAINBINARYNAME "Mintdown"', 'INSTALLMODE "currentUser"', 'ARCH "x64"', 'INSTALLWEBVIEW2MODE "embedBootstrapper"'])
  assert.ok(nsi.includes(`!define ${definition}`), `Missing installer metadata ${definition}`);
assert.ok(nsi.includes('CreateShortcut "$SMPROGRAMS\\$StartMenuFolder\\${MAINBINARYNAME}.lnk"') || /CreateShortcut[^\n]+MAINBINARYNAME/.test(nsi), 'Start menu shortcut uses product binary name');
const resources = Object.keys(config.bundle.resources).map(p => resolve(root, 'src-tauri', p).toLowerCase());
const payloads = nsi.split(/\r?\n/).filter(line => /^\s*File\s/.test(line));
for (const line of payloads) {
  if (/\$\{(?:MAINBINARYSRCPATH|WEBVIEW2BOOTSTRAPPERPATH|WEBVIEW2INSTALLERPATH)\}/.test(line)) continue;
  const quoted = [...line.matchAll(/"([^"]+)"/g)].map(m => m[1]), source = quoted.at(-1);
  assert.ok(source && resources.includes(resolve(source).toLowerCase()), `Unexpected installer payload: ${line}`);
}
const inventory = JSON.parse(readFileSync('third-party/COMPONENTS.json', 'utf8'));
for (const c of inventory.components.filter(c => c.sourceArchive))
  assert.equal(hash(readFileSync(join('third-party', c.sourceArchive))), c.sourceSha256);
const result = { version: config.version, identifier: config.identifier, productName: config.productName, buildSource: manifest.buildSource,
  files: manifest.files, resources: Object.entries(config.bundle.resources).map(([source, destination]) => ({ destination, bytes: statSync(resolve('src-tauri', source)).size, sha256: hash(readFileSync(resolve('src-tauri', source))) })),
  x64Gui: true, formalHooksAbsent: true, credentialPatternScanPassed: true, sourceMapsAbsent: true, nsisPayloadWhitelistPassed: true,
  payloadCount: payloads.length, installerExecuted: false, installedUpgradeUninstall: 'NOT VERIFIED' };
writeFileSync('artifacts/release-audit/installer-inspection.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify({ version: result.version, files: result.files, payloads: result.payloadCount, installerExecuted: false }));
