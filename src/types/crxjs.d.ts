// Ambient module declarations for crxjs virtual module queries.
// The ?script suffix is handled by crxjs's resolveId hook at build time:
// it bundles the referenced file as a standalone IIFE and replaces the import
// with the resolved output file path string.
declare module '*?script' {
  const scriptPath: string;
  export default scriptPath;
}

declare module '*?iife' {
  const scriptPath: string;
  export default scriptPath;
}
