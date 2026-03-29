declare module "picomatch" {
  export interface PicomatchOptions {
    nocase?: boolean;
    dot?: boolean;
    [key: string]: unknown;
  }
  function picomatch(
    glob: string,
    options?: PicomatchOptions,
  ): (input: string) => boolean;
  export default picomatch;
}
