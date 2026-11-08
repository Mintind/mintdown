import { expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { auditPublicDirectory, sha256 } from '../scripts/audit-public-release.mjs';

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'mintdown-public-audit-'));
  for (const name of ['third-party', 'scripts', 'src', 'src-tauri/src']) mkdirSync(join(root, name), { recursive: true });
  for (const name of ['README.md', 'COPYRIGHT.md', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'index.html', 'src/main.tsx', 'src-tauri/Cargo.lock', 'src-tauri/src/main.rs', 'scripts/build-info.mjs']) writeFileSync(join(root, name), 'source fixture');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.4.2' }));
  writeFileSync(join(root, 'src-tauri/Cargo.toml'), 'version = "0.4.2"');
  writeFileSync(join(root, 'src-tauri/tauri.conf.json'), JSON.stringify({ version: '0.4.2' }));
  writeFileSync(join(root, 'third-party/THIRD_PARTY_NOTICES.txt'), 'Third-party notices');
  writeFileSync(join(root, 'third-party/COMPONENTS.json'), JSON.stringify({ components: [] }));
  const files = ['README.md', 'COPYRIGHT.md', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'index.html', 'src/main.tsx', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/tauri.conf.json', 'src-tauri/src/main.rs', 'scripts/build-info.mjs', 'scripts/public-source-files.json', 'third-party/THIRD_PARTY_NOTICES.txt', 'third-party/COMPONENTS.json', 'third-party/sources/option-ext-0.2.0.crate'];
  mkdirSync(join(root, 'third-party/sources'));
  writeFileSync(join(root, 'third-party/sources/option-ext-0.2.0.crate'), 'original test fixture');
  writeFileSync(join(root, 'scripts/public-source-files.json'), JSON.stringify({ schemaVersion: 1, files }));
  return root;
};
it('allows explicitly declared buildable source but refuses local state and undeclared files', () => {
  expect(auditPublicDirectory(fixture()).applicationSourceIncluded).toBe(true);
  for (const name of ['artifacts', '.codex', '.layout-evidence']) {
    const root = fixture(); mkdirSync(join(root, name));
    expect(() => auditPublicDirectory(root)).toThrow(/Unexpected public directory/);
  }
  const root = fixture(); writeFileSync(join(root, '.env'), 'do not publish');
  expect(() => auditPublicDirectory(root)).toThrow(/Unexpected public file/);
});
it('blocks private keys and personal build paths even in otherwise permitted documents', () => {
  for (const text of ['-----BEGIN ' + 'PRIVATE KEY-----', 'D:' + '\\Default\\Desktop\\private.md']) {
    const root = fixture(); writeFileSync(join(root, 'README.md'), text);
    expect(() => auditPublicDirectory(root)).toThrow(/Potential secret|Private local path/);
  }
});
it('checks covered third-party archives against their immutable source hashes', () => {
  const root = fixture(), path = 'sources/option-ext-0.2.0.crate';
  writeFileSync(join(root, 'third-party', path), 'original test fixture');
  writeFileSync(join(root, 'third-party/COMPONENTS.json'), JSON.stringify({ components: [{ sourceArchive: path, sourceSha256: sha256(Buffer.from('original test fixture')) }] }));
  expect(auditPublicDirectory(root).allowListPassed).toBe(true);
  writeFileSync(join(root, 'third-party', path), 'changed');
  expect(() => auditPublicDirectory(root)).toThrow(/archive mismatch/);
});
it('rejects traversal and generated state even when added to the manifest', () => {
  for (const path of ['../secret.txt', 'src-tauri/target/cache.txt', '.env.local', 'releases/v0.4.2.md']) {
    const root = fixture(), file = join(root, 'scripts/public-source-files.json');
    const manifest = JSON.parse(readFileSync(file, 'utf8')); manifest.files.push(path);
    writeFileSync(file, JSON.stringify(manifest));
    expect(() => auditPublicDirectory(root)).toThrow(/Unsafe publication/);
  }
});
it('rejects mismatched application versions', () => {
  const root = fixture(); writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.4.3' }));
  expect(() => auditPublicDirectory(root)).toThrow(/version mismatch/);
});
it('keeps product versions and the original stable application identity consistent', () => {
  const p = JSON.parse(readFileSync('package.json', 'utf8')), config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
  expect(config.version).toBe(p.version);
  expect(readFileSync('src-tauri/Cargo.toml', 'utf8')).toContain(`version = "${p.version}"`);
  expect(config.productName).toBe('Mintdown'); expect(config.mainBinaryName).toBe('Mintdown');
  expect(config.identifier).toBe('com.markdowneditor.kit');
});
