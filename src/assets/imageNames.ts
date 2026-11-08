export function archiveNameForFile(name: string, origin: 'paste' | 'drop' | 'insert', now = new Date()): string {
  if (origin !== 'paste' || name && !/^image(?:\.(?:png|jpe?g|gif|webp))?$/i.test(name)) return name || 'image.png';
  const part = (value: number, width: number) => String(value).padStart(width, '0');
  const stamp = `${now.getFullYear()}${part(now.getMonth() + 1, 2)}${part(now.getDate(), 2)}-` +
    `${part(now.getHours(), 2)}${part(now.getMinutes(), 2)}${part(now.getSeconds(), 2)}-${part(now.getMilliseconds(), 3)}`;
  return `image-${stamp}.png`;
}
