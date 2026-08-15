// Response hardening shared by every response this worker generates (pages,
// setup pages, and the R2 attachment stream).
//
// - nosniff: the attachment route streams USER-UPLOADED bytes back with
//   Content-Disposition: inline. The bytes are magic-byte-checked on upload, but
//   content sniffing is the browser's decision, not ours — without nosniff a file
//   that passes an image signature check and also parses as HTML/JS could be
//   rendered as such on our own origin.
// - DENY: nothing here is meant to be framed; the app opens the forms in a tab /
//   in-app overlay, never in an iframe. Blocks clickjacking of the submit button.
// - no-referrer: form URLs carry the reporter's prefilled context (and the setup
//   callback carries a GitHub App conversion code) — none of that should leak to
//   github.com, the Turnstile endpoint, or anywhere else via Referer.
//
// Deliberately NOT here yet: Content-Security-Policy. render.js still ships three
// inline <script> blocks (the AJAX submit, close-window and UA-sniff scripts) and
// an `href="javascript:history.back()"` on the error page; a CSP would have to
// hash the scripts and that href would have to go first, or the pages break.
export const SECURITY_HEADERS = Object.freeze({
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
});

// For responses we build from a plain header object. Caller-supplied entries win,
// so a route can still override (nothing does today).
export const withSecurityHeaders = (headers = {}) => ({ ...SECURITY_HEADERS, ...headers });

// For responses whose headers already exist as a Headers instance (the R2
// attachment stream, whose metadata is copied in by writeHttpMetadata).
export function setSecurityHeaders(headers) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  return headers;
}
