import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseIssueForm, loadTemplate } from '../src/templates.js';
import { bundled } from '../src/bundledTemplates.js';
import { makeEnv, routeFetch } from './helpers.js';

const read = (p) => readFileSync(fileURLToPath(new URL(`../templates/${p}`, import.meta.url)), 'utf8');

describe('parseIssueForm', () => {
  it('parses the bug template', () => {
    const s = parseIssueForm(bundled.bug);
    expect(s.labels).toEqual(['bug']);
    expect(s.fields.map((f) => f.id)).toEqual([
      'what-happened', 'steps', 'expected', 'version', 'install-type', 'browser', 'os', 'device', 'context',
    ]);
    const installType = s.fields.find((f) => f.id === 'install-type');
    expect(installType.type).toBe('dropdown');
    expect(installType.options).toEqual(['PWA (installed to home screen)', 'Browser tab']);
    expect(s.fields.find((f) => f.id === 'context').required).toBe(false);
    expect(s.fields.find((f) => f.id === 'what-happened').required).toBe(true);
  });

  it('parses the feature template', () => {
    const s = parseIssueForm(bundled.feature);
    expect(s.labels).toEqual(['enhancement']);
    expect(s.fields.map((f) => f.id)).toEqual(['problem', 'solution', 'alternatives', 'scope']);
  });

  it('bundled strings match the on-disk templates (no drift)', () => {
    expect(parseIssueForm(bundled.bug)).toEqual(parseIssueForm(read('bug_report.yml')));
    expect(parseIssueForm(bundled.feature)).toEqual(parseIssueForm(read('feature_request.yml')));
  });

  it('retains markdown blocks in the field list', () => {
    const s = parseIssueForm(
      'name: x\nbody:\n  - type: markdown\n    attributes:\n      value: hello\n  - type: input\n    id: a\n    attributes:\n      label: A'
    );
    expect(s.fields[0].type).toBe('markdown');
    expect(s.fields.map((f) => f.type)).toContain('input');
  });
});

describe('loadTemplate', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('fetches live, parses, and caches', async () => {
    const env = makeEnv();
    vi.stubGlobal('fetch', routeFetch({ 'GET raw.githubusercontent.com': () => new Response(bundled.bug) }));
    const s = await loadTemplate(env, 'bug');
    expect(s.labels).toEqual(['bug']);
    expect(await env.FEEDBACK.get('tpl:bug')).toBeTruthy();
  });

  it('falls back to bundled when fetch fails and cache is empty', async () => {
    const env = makeEnv();
    vi.stubGlobal('fetch', routeFetch({})); // any fetch throws
    const s = await loadTemplate(env, 'feature');
    expect(s.labels).toEqual(['enhancement']);
  });

  it('uses the KV cache when fetch fails', async () => {
    const env = makeEnv();
    await env.FEEDBACK.put('tpl:bug', JSON.stringify({ labels: ['cached'], fields: [] }));
    vi.stubGlobal('fetch', routeFetch({}));
    const s = await loadTemplate(env, 'bug');
    expect(s.labels).toEqual(['cached']);
  });
});
