// Vite `?raw` imports (file contents as a string) used by tests.
declare module "*?raw" {
  const source: string;
  export default source;
}
