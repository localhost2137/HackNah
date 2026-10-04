/** Vite and vitest load a file's text with `?raw`; tests use it for the example policy files. */
declare module '*?raw' {
  const text: string
  export default text
}
