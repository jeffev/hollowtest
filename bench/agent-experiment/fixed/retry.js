/**
 * Call an async function, retrying when it throws.
 * - `retries` is the number of retries after the first attempt, so fn runs at most retries + 1 times.
 * - Waits `delayMs` between attempts.
 * - Resolves with the first successful result; if every attempt fails, rejects with the LAST error.
 */
export async function retry(fn, { retries = 2, delayMs = 0 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (delayMs && attempt < retries) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}
