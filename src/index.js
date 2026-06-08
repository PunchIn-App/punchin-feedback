// punchin-feedback — Worker entrypoint.
// Account-free bug-report / feature-request intake. See
// docs/2026-06-07-punchin-feedback-design.md for the full design.
//
// Static assets (/styles.css, /fonts/*) are served by Workers Static Assets
// (asset-first, not_found_handling="none"), so they never reach fetch(); every
// dynamic route below falls through to this handler.

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === '/') return Response.redirect(env.APP_URL, 302);

    // Handlers are wired module-by-module per the implementation plan; until a
    // route is implemented it returns 501 (distinct from a 404 "no such route").
    if (pathname === '/bug') return new Response('not implemented', { status: 501 });
    if (pathname === '/feature') return new Response('not implemented', { status: 501 });
    if (pathname === '/submit') return new Response('not implemented', { status: 501 });
    if (pathname === '/webhook') return new Response('not implemented', { status: 501 });
    if (pathname === '/unsubscribe') return new Response('not implemented', { status: 501 });
    if (pathname === '/setup') return new Response('not implemented', { status: 501 });
    if (pathname === '/setup/callback') return new Response('not implemented', { status: 501 });

    const asset = pathname.match(/^\/a\/([^/]+)$/);
    if (asset) return new Response('not implemented', { status: 501 });

    return new Response('Not found', { status: 404 });
  },

  async scheduled(controller, env, ctx) {
    // Daily retention sweep — wired in plan Task 11.
  },
};
