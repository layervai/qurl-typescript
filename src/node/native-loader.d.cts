export declare function loadNativeStateFS(): NativeStateFS;

export interface NativeStateFS {
  open(directory: string, name: string): object;
  check(handle: object): void;
  tryLock(handle: object): boolean;
  unlock(handle: object): void;
  read(handle: object): Buffer | null;
  write(handle: object, bytes: Buffer, temporaryName: string): void;
  close(handle: object): void;
}
