export interface FileSystem {
  read(path: string): Promise<Uint8Array>;
  writeAtomic(path: string, content: Uint8Array): Promise<void>;
  move(from: string, to: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  isSymbolicLink(path: string): Promise<boolean>;
}
