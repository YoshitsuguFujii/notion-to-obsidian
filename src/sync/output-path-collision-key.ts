export function outputPathCollisionKey(path: string): string {
  // NFC absorbs filesystem decomposition differences; a fixed locale keeps case folding deterministic.
  return path.split('\\').join('/').normalize('NFC').toLocaleLowerCase('en-US');
}
