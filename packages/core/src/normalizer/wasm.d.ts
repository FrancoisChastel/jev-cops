/** `import x from "…/file.wasm" with { type: "file" }`: Bun gives the file's path (embedded when compiled). */
declare module "*.wasm" {
  const path: string;
  export default path;
}
