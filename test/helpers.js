// Test doubles for the Worker bindings. Pure in-memory — no network, no Wrangler.
// Mirrors how the sibling punchin-email worker tests handlers with mocked bindings.

export function fakeKV() {
  const store = new Map(); // key -> { value: string, opts }
  return {
    store,
    async get(key, typeOrOpts) {
      const e = store.get(key);
      if (!e) return null;
      const type = typeof typeOrOpts === 'string' ? typeOrOpts : typeOrOpts?.type;
      return type === 'json' ? JSON.parse(e.value) : e.value;
    },
    async put(key, value, opts = {}) {
      store.set(key, { value: typeof value === 'string' ? value : String(value), opts });
    },
    async delete(key) {
      store.delete(key);
    },
    async list({ prefix = '' } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return { keys, list_complete: true, cursor: undefined };
    },
  };
}

export function fakeR2() {
  const store = new Map(); // key -> { value, httpMetadata, customMetadata }
  return {
    store,
    async put(key, value, opts = {}) {
      store.set(key, { value, httpMetadata: opts.httpMetadata, customMetadata: opts.customMetadata });
      return { key };
    },
    async get(key) {
      const o = store.get(key);
      if (!o) return null;
      return {
        body: o.value,
        httpMetadata: o.httpMetadata,
        customMetadata: o.customMetadata,
        httpEtag: `"${key}"`,
        writeHttpMetadata(headers) {
          if (o.httpMetadata?.contentType) headers.set('content-type', o.httpMetadata.contentType);
        },
      };
    },
    async head(key) {
      const o = store.get(key);
      return o ? { key, customMetadata: o.customMetadata } : null;
    },
    async delete(key) {
      if (Array.isArray(key)) key.forEach((k) => store.delete(k));
      else store.delete(key);
    },
    async list({ prefix = '' } = {}) {
      const objects = [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key }));
      return { objects, truncated: false };
    },
  };
}

export function fakeEmail() {
  const sent = [];
  return {
    sent,
    async send(msg) {
      sent.push(msg);
      return { messageId: `test-${sent.length}` };
    },
  };
}

// Build a global-fetch replacement from a { 'METHOD url-substring': (req)=>Response } map.
// Use with vi.stubGlobal('fetch', routeFetch({...})). A missing route throws.
export function routeFetch(routes) {
  return async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = (init.method || (typeof input !== 'string' && input.method) || 'GET').toUpperCase();
    for (const [pattern, handler] of Object.entries(routes)) {
      const [pMethod, pUrl] = pattern.includes(' ') ? pattern.split(' ') : ['GET', pattern];
      if (pMethod.toUpperCase() === method && url.includes(pUrl)) {
        return handler({ url, method, init });
      }
    }
    throw new Error(`routeFetch: no route for ${method} ${url}`);
  };
}

export function makeEnv(overrides = {}) {
  return {
    FEEDBACK: fakeKV(),
    ATTACHMENTS: fakeR2(),
    EMAIL: fakeEmail(),
    REPO_OWNER: 'PunchIn-App',
    REPO_NAME: 'punchin',
    TEMPLATE_REF: 'main',
    APP_URL: 'https://trackmytime.today',
    FROM_ADDRESS: 'feedback@trackmytime.today',
    TURNSTILE_SITEKEY: '',
    ACCENT: '#2D5BF5',
    PROVENANCE_LABEL: 'via-web-form',
    IMG_MAX_BYTES: '5242880',
    IMG_MAX_COUNT: '5',
    GITHUB_APP_ID: '123',
    GITHUB_WEBHOOK_SECRET: 'whsec',
    UNSUB_SECRET: 'unsec',
    TURNSTILE_SECRET: '',
    ...overrides,
  };
}

export const ctx = { waitUntil() {}, passThroughOnException() {} };
