import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function collectBuildInfo(root, command, mode) {
  const git = args => execFileSync('git', ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, ...args],
    { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  let revision = 'unknown', dirty = null, files;
  try {
    revision = git(['rev-parse', 'HEAD']);
    dirty = Boolean(git(['status', '--porcelain', '--untracked-files=normal']));
    files = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0');
  } catch { throw Error('Build provenance requires a readable Git checkout; do not emit a misleading source ID.'); }
  const inputs = [...new Set(files)].filter(p => /^(src\/|src-tauri\/|scripts\/|third-party\/)/.test(p) ||
    /^(package(-lock)?\.json|vite\.config\.ts|tsconfig.*\.json|index\.html)$/.test(p)).sort();
  const hash = createHash('sha256');
  for (const path of inputs) {
    let bytes; try { bytes = readFileSync(resolve(root, path)); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      bytes = Buffer.from('<deleted>');
    }
    hash.update(`${path.length}:${path}:${bytes.length}:`); hash.update(bytes);
  }
  const sourceSha256 = hash.digest('hex');
  const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
  const channel = process.env.VITE_NATIVE_TEST === '1' ? 'native-test' : command === 'serve' ? 'development' : 'production';
  return { version, revision, dirty, sourceSha256, channel, mode, builtAt: new Date().toISOString(),
    id: `${version}+${revision.slice(0, 7)}.${sourceSha256.slice(0, 12)}.${channel}` };
}
