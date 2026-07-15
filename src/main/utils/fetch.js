let cachedFetch = null;

async function getFetchImplementation() {
  if (typeof fetch === 'function') {
    return fetch.bind(globalThis);
  }

  if (!cachedFetch) {
    const nodeFetch = require('node-fetch');
    cachedFetch = typeof nodeFetch === 'function' ? nodeFetch : nodeFetch.default;
  }

  return cachedFetch;
}

async function fetchCompat(...args) {
  const implementation = await getFetchImplementation();
  return implementation(...args);
}

module.exports = fetchCompat;
