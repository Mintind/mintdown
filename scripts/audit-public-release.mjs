// Explicit source-snapshot audit. This module never pushes or executes tests.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const manifestPath = 'scripts/public-source-files.json';
const forbidden = /(^|\/)(?:\.env(?:\..*)?|\.codex|\.agents|\.aws|\.cargo|node_modules|dist|target|gen|artifacts|coverage|\.layout-evidence|\.native-[^/]*|releases|screenshots)(?:\/|$)|(?:\.pem|\.key|\.pfx|\.p12|\.tsbuildinfo|\.log)$/i;
const secrets = [/github_pat_[A-Za-z0-9_]{24,}/, /gh[pousr]_[A-Za-z0-9]{30,}/, /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, /AKIA[0-9A-Z]{16}/];
export function auditPublicDirectory(directory) {
  const root = resolve(directory), files = [];
  const manifest = JSON.parse(readFileSync(join(root, manifestPath), 'utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) throw Error('Invalid source publication manifest');
  const allowed = new Set(manifest.files);
  if (allowed.size !== manifest.files.length) throw Error('Duplicate source publication path');
  for (const name of allowed) {
    if (typeof name !== 'string' || name.startsWith('/') || name.includes('\\') || name.split('/').some(p => !p || p === '.' || p === '..') || forbidden.test(name))
      throw Error(`Unsafe publication manifest path: ${name}`);
  }
  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (current === root && entry.name === '.git') continue;
      const path = join(current, entry.name), name = relative(root, path).replaceAll('\\', '/');
      if (lstatSync(path).isSymbolicLink()) throw Error(`Symlink is not allowed in publication: ${name}`);
      if (entry.isDirectory()) { if (![...allowed].some(p => p.startsWith(name + '/'))) throw Error(`Unexpected public directory: ${name}`); walk(path); }
      else {
        if (!allowed.has(name)) throw Error(`Unexpected public file: ${name}`);
        const bytes = readFileSync(path);
        if (!/\.(?:png|ico|crate)$/.test(name)) {
          const text = bytes.toString('utf8');
          if (secrets.some(pattern => pattern.test(text))) throw Error(`Potential secret in ${name}`);
          if (/[A-Z]:[\\/]+Default[\\/]+Desktop|[A-Z]:[\\/]+Users[\\/]+Anthon|[A-Z]:[\\/]+Anthon[\\/]|AppData[\\/]+Local[\\/]+Temp/i.test(text)) throw Error(`Private local path in ${name}`);
        }
        files.push({ path: name, bytes: bytes.length, sha256: sha256(bytes) });
      }
    }
  };
  walk(root);
  for (const name of allowed) if (!files.some(f => f.path === name)) throw Error(`Missing declared publication file ${name}`);
  for (const required of ['README.md', 'COPYRIGHT.md', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'index.html', 'src/main.tsx', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/tauri.conf.json', 'src-tauri/src/main.rs', 'scripts/build-info.mjs', manifestPath, 'third-party/THIRD_PARTY_NOTICES.txt', 'third-party/COMPONENTS.json'])
    if (!existsSync(join(root, required))) throw Error(`Missing publication file ${required}`);
  const inventory = JSON.parse(readFileSync(join(root, 'third-party/COMPONENTS.json'), 'utf8'));
  for (const c of inventory.components.filter(c => c.sourceArchive)) {
    const path = `third-party/${c.sourceArchive}`;
    if (files.find(f => f.path === path)?.sha256 !== c.sourceSha256) throw Error(`Third-party source archive mismatch: ${path}`);
  }
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const config = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  if (pkg.version !== config.version || !readFileSync(join(root, 'src-tauri/Cargo.toml'), 'utf8').includes(`version = "${pkg.version}"`)) throw Error('Application version mismatch');
  return { files: files.sort((a, b) => a.path.localeCompare(b.path)), applicationSourceIncluded: true, allowListPassed: true };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw Error('Use node scripts/audit-public-release.mjs <independent-public-directory>');
  const result = auditPublicDirectory(process.argv[2]);
  console.log(JSON.stringify(result, null, 2));
}
