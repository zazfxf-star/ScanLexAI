declare module "unzipper" {
  type Entry = {
    type: string;
    path: string;
    buffer(): Promise<Buffer>;
  };

  type Directory = {
    files: Entry[];
  };

  export function Open(): never;
  export namespace Open {
    function buffer(buffer: Buffer): Promise<Directory>;
  }
}