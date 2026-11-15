export const CONNECTORS_VERSION = "0.0.0";

/**
 * Who is calling. Every connector sends this, so a server (an API, a client's own site) sees
 * "Mycel" in its log instead of an anonymous Node default. No contact details: there is no
 * public page to point at yet.
 */
export const USER_AGENT = `Mycel/${CONNECTORS_VERSION}`;

/**
 * Wraps a fetch so every request carries the User-Agent. Each connector wraps its fetch once, in
 * its constructor: no request can forget the header, and a caller's own User-Agent still wins.
 */
export function withUserAgent(fetchImpl: typeof fetch): typeof fetch {
  return (input, init) => {
    const headers = plain(init?.headers);
    const named = Object.keys(headers).some((k) => k.toLowerCase() === "user-agent");
    return fetchImpl(input, {
      ...init,
      headers: named ? headers : { ...headers, "User-Agent": USER_AGENT },
    });
  };
}

function plain(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return headers;
}
