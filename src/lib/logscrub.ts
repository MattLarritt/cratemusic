/**
 * Keeping credentials out of the log.
 *
 * The Subsonic API carries credentials in the query string — there is no header form of
 * it — so `/rest` URLs routinely contain a working secret. `p` is the password itself
 * (plain, or `enc:<hex>`, which is hex encoding and not encryption). `t` and `s` are a
 * token and salt: the token is an MD5 of password+salt, so the pair can be replayed as
 * it stands for as long as the password does.
 *
 * Fastify's default request serialiser logs the whole URL, which puts all of that into
 * the container log, and from there into wherever logs are shipped, kept and searched.
 * Nobody reading a log expects to find live credentials in it, which is exactly why
 * logs are a poor place to leave them.
 *
 * Its own module rather than a helper inside main.ts so it can be tested without
 * starting a server.
 */

/** Query parameters whose VALUES must never be written to a log. */
const SECRET_QUERY_PARAMS = ['p', 't', 's', 'password', 'token', 'salt', 'apiKey', 'api_key'];

/**
 * The same URL with any secret parameter's value replaced.
 *
 * Masked rather than stripped: knowing a parameter was present is genuinely useful when
 * working out what a client sent, and its value never is. A URL carrying no secrets is
 * returned untouched, so ordinary request logs keep their exact original form.
 */
export function scrubUrl(url: string): string {
  const q = url.indexOf('?');
  if (q === -1) return url;
  const params = new URLSearchParams(url.slice(q + 1));
  let touched = false;
  for (const key of SECRET_QUERY_PARAMS) {
    if (params.has(key)) {
      params.set(key, '[redacted]');
      touched = true;
    }
  }
  return touched ? `${url.slice(0, q)}?${params.toString()}` : url;
}
