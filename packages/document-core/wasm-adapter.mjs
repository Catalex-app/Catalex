// The same adapter is usable in a browser or Node. No native transport on edits.
export function createDocumentCore(bytes) {
  const { exports: core } = new WebAssembly.Instance(
    new WebAssembly.Module(bytes),
  );
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const call = (request, method) => {
    const input = encoder.encode(JSON.stringify(request));
    const pointer = core.alloc(input.length);
    let outputPointer;
    let outputLength;
    try {
      new Uint8Array(core.memory.buffer, pointer, input.length).set(input);
      const packed = core[method](pointer, input.length);
      outputPointer = Number(packed >> 32n);
      outputLength = Number(packed & 0xffffffffn);
      return JSON.parse(
        decoder.decode(
          new Uint8Array(core.memory.buffer, outputPointer, outputLength),
        ),
      );
    } finally {
      core.free(pointer, input.length);
      if (outputPointer !== undefined) core.free(outputPointer, outputLength);
    }
  };
  const apply = (request) => call(request, "apply");
  apply.session = (request) => call(request, "session");
  apply.diff = (before, after) => call({ before, after }, "diff");
  return apply;
}
