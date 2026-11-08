// Offline, reproducible attribution inventory. No runtime dependency changes.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');
const metadataPath = process.argv.find(a => a.startsWith('--metadata='))?.slice(11) || 'artifacts/release-audit/cargo-metadata.json';
const read = path => readFileSync(resolve(root, path), 'utf8');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const noticeName = name => /^(?:(?:un)?licen[cs]e|copying|notice|copyright|patents)(?:[._-]|$)/i.test(name);
const write = (path, bytes) => {
  const target = resolve(root, path);
  if (check) {
    if (!existsSync(target) || sha256(readFileSync(target)) !== sha256(bytes)) throw Error(`Attribution out of date: ${path}`);
  } else { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, bytes); }
};
const overrides = {
  format: { file: 'format-MIT.txt', source: 'package Readme.md copyright + standard MIT text; declared licenses[0] is MIT' },
  'remark-math': { file: 'remark-math-MIT.txt', source: 'https://raw.githubusercontent.com/remarkjs/remark-math/main/license' },
  'rehype-katex': { file: 'remark-math-MIT.txt', source: 'https://raw.githubusercontent.com/remarkjs/remark-math/main/license' },
  'alloc-stdlib': { file: 'rust-alloc-BSD.txt', source: 'https://raw.githubusercontent.com/dropbox/rust-alloc-no-stdlib/master/LICENSE' },
  selectors: { file: 'MPL-2.0.txt', source: 'MPL-2.0 standard text; original selectors source archive provided' },
  'tauri-plugin': { file: 'tauri-MIT.txt', source: 'tauri 2.12.5 LICENSE-MIT, same upstream repository (MIT option)' },
  'webview2-com': { file: 'webview2-rs-MIT.txt', source: 'https://raw.githubusercontent.com/wravery/webview2-rs/main/LICENSE' },
  'webview2-com-macros': { file: 'webview2-rs-MIT.txt', source: 'https://raw.githubusercontent.com/wravery/webview2-rs/main/LICENSE' },
  'webview2-com-sys': { file: 'webview2-rs-MIT.txt', source: 'https://raw.githubusercontent.com/wravery/webview2-rs/main/LICENSE' },
};
const mitBody = read('node_modules/katex/LICENSE').slice(read('node_modules/katex/LICENSE').indexOf('Permission is hereby granted'));
write('third-party/license-texts/format-MIT.txt', `MIT License\n\nCopyright 2010 - 2014 Sami Samhuri <sami@samhuri.net>\n\n${mitBody}`);
const components = [], sections = [], resources = [];
const add = (component, directory) => {
  const paths = readdirSync(directory, { withFileTypes: true }).filter(e => e.isFile() && noticeName(e.name)).map(e => e.name).sort();
  let texts = paths.map(name => ({ name, text: readFileSync(join(directory, name), 'utf8') }));
  if (!texts.length && overrides[component.name]) {
    const override = overrides[component.name];
    texts = [{ name: override.file, text: read(`third-party/license-texts/${override.file}`) }];
    component.noticeSource = override.source;
  }
  if (!texts.length) throw Error(`Missing copyright/license notice: ${component.name}@${component.version}`);
  component.notices = texts.map(t => ({ name: t.name, sha256: sha256(t.text) }));
  components.push(component);
  sections.push(`\n${'='.repeat(78)}\n${component.ecosystem}: ${component.name} ${component.version}\nLicense: ${component.license}\nUpstream: ${component.upstream}\n${component.authors ? `Declared authors: ${component.authors}\n` : ''}${component.sourceArchive ? `MPL source: ${component.sourceArchive} (unmodified upstream package)\n` : ''}${component.noticeSource ? `Notice source: ${component.noticeSource}\n` : ''}\n${texts.map(t => `--- ${t.name} ---\n${t.text}`).join('\n')}`);
};
const lock = JSON.parse(read('package-lock.json'));
for (const [path, entry] of Object.entries(lock.packages).sort(([a], [b]) => a.localeCompare(b))) {
  if (!path || entry.dev) continue;
  const pkg = JSON.parse(read(`${path}/package.json`));
  add({ ecosystem: 'npm', name: pkg.name, version: pkg.version,
    license: pkg.license || pkg.licenses?.map(l => l.type).join(' AND '),
    upstream: typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url || pkg.homepage || `https://www.npmjs.com/package/${pkg.name}`,
  }, resolve(root, path));
}
const cargoLock = new Map(read('src-tauri/Cargo.lock').split('[[package]]').slice(1).map(block => {
  const get = field => block.match(new RegExp(`^${field} = "([^"]+)"`, 'm'))?.[1];
  return [`${get('name')}@${get('version')}`, get('checksum')];
}));
const metadata = JSON.parse(read(metadataPath));
for (const pkg of metadata.packages.filter(p => p.source).sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))) {
  const directory = dirname(pkg.manifest_path), component = { ecosystem: 'cargo', name: pkg.name, version: pkg.version,
    license: pkg.license, upstream: pkg.repository || `https://crates.io/crates/${pkg.name}/${pkg.version}`, authors: pkg.authors.join(', ') };
  if (pkg.license === 'MPL-2.0') {
    const archiveName = `${pkg.name}-${pkg.version}.crate`;
    const original = join(resolve(directory, '../../..'), 'cache', basename(dirname(directory)), archiveName);
    const bytes = readFileSync(original), digest = sha256(bytes);
    if (digest !== cargoLock.get(`${pkg.name}@${pkg.version}`)) throw Error(`Original MPL source archive checksum mismatch: ${archiveName}`);
    component.sourceArchive = `sources/${archiveName}`; component.sourceSha256 = digest;
    component.sourceUrl = `https://static.crates.io/crates/${pkg.name}/${archiveName}`;
    write(`third-party/${component.sourceArchive}`, bytes); resources.push(component.sourceArchive);
  }
  add(component, directory);
}
// KaTeX's separately maintained font package carries an additional attribution.
sections.push(`\n${'='.repeat(78)}\nKaTeX font generation and font files\nUpstream: https://github.com/KaTeX/katex-fonts\n\n${read('third-party/license-texts/katex-fonts-MIT.txt')}`);
for (const extra of [
  { name: 'NSIS installer runtime and compression modules', version: '3.13', license: 'Zlib / bzip2 / CPL-1.0; see full COPYING', file: 'NSIS-COPYING.txt',
    upstream: 'https://nsis.sourceforge.io/', sourceUrl: 'https://sourceforge.net/projects/nsis/files/NSIS%203/3.13/nsis-3.13-src.tar.bz2/download' },
  { name: 'nsis-tauri-utils', version: 'bundled with @tauri-apps/cli ' + JSON.parse(read('node_modules/@tauri-apps/cli/package.json')).version,
    license: 'MIT (MIT OR Apache-2.0 option)', file: 'nsis-tauri-utils-MIT.txt', upstream: 'https://github.com/tauri-apps/nsis-tauri-utils' },
]) {
  const text = read(`third-party/license-texts/${extra.file}`);
  components.push({ ecosystem: 'installer', name: extra.name, version: extra.version, license: extra.license, upstream: extra.upstream,
    ...(extra.sourceUrl ? { sourceUrl: extra.sourceUrl } : {}), notices: [{ name: extra.file, sha256: sha256(text) }] });
  sections.push(`\n${'='.repeat(78)}\nInstaller: ${extra.name}\nVersion: ${extra.version}\nUpstream: ${extra.upstream}\n${extra.sourceUrl ? `Unmodified upstream source: ${extra.sourceUrl}\n` : ''}\n${text}`);
}
sections.push('\nRust standard library notices are provided in RUST-LIBRARY-COPYRIGHT.html in this same directory.\n');
const header = `Mintdown — Third-party notices\n\nThis file covers third-party components, not a source license for Mintdown.\nRuntime npm dependencies and target-filtered Cargo dependencies are conservatively included, including some build-time components.\nNo third-party source modifications are made by Mintdown. MPL-2.0 original package archives are supplied in sources/ with Cargo.lock verified SHA-256 checksums; their source remains under MPL-2.0.\nThe standalone Windows WebView2 runtime/bootstrapper is provided by Microsoft under Microsoft's terms: https://developer.microsoft.com/microsoft-edge/webview2/\n\n`;
write('third-party/THIRD_PARTY_NOTICES.txt', header + sections.join('\n'));
write('third-party/COMPONENTS.json', JSON.stringify({ scope: 'Conservative Windows x64 attribution inventory; not all listed build-time packages enter the executable', components }, null, 2) + '\n');
for (const path of ['THIRD_PARTY_NOTICES.txt', 'COMPONENTS.json', 'RUST-LIBRARY-COPYRIGHT.html', ...resources])
  if (!existsSync(resolve(root, 'third-party', path))) throw Error(`Missing distribution resource ${path}`);
console.log(JSON.stringify({ components: components.length, mplSourceArchives: resources.length, check }));
