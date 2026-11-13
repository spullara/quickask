// Worker module rules in alchemy.run.ts: .wasm imports are compiled modules, .woff imports are raw bytes.
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
declare module "*.woff" {
  const data: ArrayBuffer;
  export default data;
}
