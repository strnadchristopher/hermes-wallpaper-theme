// Resolve the three specifiers the Desktop loader provides to local stubs.
const stubs = {
  '@hermes/plugin-sdk': new URL('./sdk-stub.mjs', import.meta.url).href,
  react: new URL('./react-stub.mjs', import.meta.url).href,
  'react/jsx-runtime': new URL('./react-stub.mjs', import.meta.url).href
}

export async function resolve(specifier, context, next) {
  return stubs[specifier] ? { url: stubs[specifier], shortCircuit: true } : next(specifier, context)
}
