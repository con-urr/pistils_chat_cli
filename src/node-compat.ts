type BlobWithBytes = Blob & {
  bytes?: () => Promise<Uint8Array>;
};

const blobPrototype = globalThis.Blob?.prototype as BlobWithBytes | undefined;

if (blobPrototype && typeof blobPrototype.bytes !== 'function') {
  Object.defineProperty(blobPrototype, 'bytes', {
    configurable: true,
    writable: true,
    value: async function bytes(this: Blob) {
      return new Uint8Array(await this.arrayBuffer());
    },
  });
}
