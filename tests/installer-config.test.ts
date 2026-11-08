import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (name: string) => readFileSync(resolve(root, name), 'utf8');
const config = JSON.parse(read('src-tauri/tauri.conf.json'));

describe('Windows installer safety contract', () => {
  it('keeps stable release identity, distinct development and verification identities', () => {
    const dev = JSON.parse(read('src-tauri/tauri.dev.conf.json'));
    const test = JSON.parse(read('src-tauri/tauri.installer-test.conf.json'));
    expect(config.identifier).toBe('com.markdowneditor.kit');
    expect(new Set([config.identifier, dev.identifier, test.identifier]).size).toBe(3);
    expect(config.productName).toBe('Mintdown');
    expect(config.mainBinaryName).toBe('Mintdown');
    expect(test.bundle.fileAssociations[0].ext).not.toContain('md');
    expect(dev.bundle.active).toBe(false);
  });
  it('ships per-user NSIS with WebView2 support and only explicit application icons', () => {
    expect(config.bundle.targets).toEqual(['nsis']);
    expect(config.bundle.windows.nsis.installMode).toBe('currentUser');
    expect(config.bundle.windows.webviewInstallMode.type).toBe('embedBootstrapper');
    expect(config.bundle.fileAssociations[0].ext).toEqual(['md']);
    const resources = config.bundle.resources;
    expect(Object.keys(resources)).toHaveLength(8);
    for (const [source, target] of Object.entries(resources)) {
      expect(source).toBe(`../${target}`);
      expect(target).toMatch(/^third-party\/(?:THIRD_PARTY_NOTICES\.txt|COMPONENTS\.json|RUST-LIBRARY-COPYRIGHT\.html|sources\/(?:cssparser-0\.37\.0|cssparser-macros-0\.7\.1|dtoa-short-0\.3\.5|option-ext-0\.2\.0|selectors-0\.38\.0)\.crate)$/);
    }
    expect(config.bundle.externalBin).toBeUndefined();
  });
  it('registers Open With without writing an extension default or UserChoice', () => {
    const hook = read('src-tauri/installer/file-associations.nsh');
    const writes = hook.split('\n').filter(line => /^\s*(?:WriteReg|DeleteReg)/.test(line));
    expect(writes.some(line => line.includes('OpenWithProgids'))).toBe(true);
    expect(writes.some(line => line.includes('RegisteredApplications'))).toBe(true);
    expect(writes.some(line => line.includes('UserChoice'))).toBe(false);
    expect(writes.some(line => /Classes\\\.\$\{EXT\}"\s+""/.test(line))).toBe(false);
    expect(writes.some(line => /^\s*DeleteRegKey\s+SHELL_CONTEXT\s+"Software\\Classes\\\.\$\{EXT\}"/.test(line))).toBe(false);
  });
});
