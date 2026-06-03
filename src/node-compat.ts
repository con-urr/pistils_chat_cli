type BlobWithBytes = Blob & {
  bytes?: () => Promise<Uint8Array>;
};

type PromiseWithResolvers = PromiseConstructor & {
  withResolvers?: <T>() => {
    promise: Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
  };
};

const blobPrototype = globalThis.Blob?.prototype as BlobWithBytes | undefined;
const promiseConstructor = Promise as PromiseWithResolvers;

if (blobPrototype && typeof blobPrototype.bytes !== 'function') {
  Object.defineProperty(blobPrototype, 'bytes', {
    configurable: true,
    writable: true,
    value: async function bytes(this: Blob) {
      return new Uint8Array(await this.arrayBuffer());
    },
  });
}

if (typeof promiseConstructor.withResolvers !== 'function') {
  Object.defineProperty(promiseConstructor, 'withResolvers', {
    configurable: true,
    writable: true,
    value: function withResolvers<T>() {
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (reason?: unknown) => void;
      const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      return { promise, resolve, reject };
    },
  });
}
