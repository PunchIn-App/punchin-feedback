import { describe, it, expect } from 'vitest';
import { parseIssueForm } from '../src/templates.js';
import { bundled } from '../src/bundledTemplates.js';
import { formatIssueBody, buildIssue } from '../src/issueBody.js';

const bug = parseIssueForm(bundled.bug);
const values = {
  title: 'Timer drifts',
  fields: {
    'what-happened': 'The timer is wrong',
    steps: '1. start\n2. wait',
    expected: 'accurate time',
    version: '0.21.0',
    'install-type': 'PWA (installed to home screen)',
    browser: 'Chrome 124',
    os: 'macOS 14.4',
    device: 'desktop',
    context: '', // optional, left blank
  },
};

describe('formatIssueBody (bug template)', () => {
  it('uses ### label + blank line + value, and starts with the first field', () => {
    const body = formatIssueBody(bug, values, {});
    expect(body.startsWith('### What happened\n\nThe timer is wrong')).toBe(true);
    expect(body).toContain('### Steps to reproduce\n\n1. start\n2. wait');
    expect(body).toContain('### Install type\n\nPWA (installed to home screen)');
  });

  it('renders an empty optional field as _No response_', () => {
    expect(formatIssueBody(bug, values, {})).toContain('### Additional context\n\n_No response_');
  });

  it('appends a Screenshots section when images are present', () => {
    const body = formatIssueBody(bug, values, { imageUrls: ['https://feedback.x/a/k1.png', 'https://feedback.x/a/k2.png'] });
    expect(body).toContain('### Screenshots\n\n![screenshot 1](https://feedback.x/a/k1.png)\n![screenshot 2](https://feedback.x/a/k2.png)');
  });
});

describe('buildIssue', () => {
  it('sets title and labels including the provenance label', () => {
    const issue = buildIssue(bug, values, { provenanceLabel: 'via-web-form' });
    expect(issue.title).toBe('Timer drifts');
    expect(issue.labels).toEqual(['bug', 'via-web-form']);
    expect(issue.body).toContain('### App version\n\n0.21.0');
  });
});

// The values below arrive from an anonymous public form and are pasted straight
// into markdown we file under our own GitHub App identity.
describe('untrusted submissions cannot abuse the issue markdown', () => {
  const ZWSP = '\u200B'; // zero-width space, written escaped so it stays visible in source

  it('neutralises @mentions so a submission cannot ping real people', () => {
    const body = formatIssueBody(bug, {
      ...values,
      fields: { ...values.fields, 'what-happened': 'hey @octocat and @PunchIn-App/maintainers, look' },
    }, {});
    expect(body).toContain(`@${ZWSP}octocat`);
    expect(body).toContain(`@${ZWSP}PunchIn-App/maintainers`);
    expect(body).not.toContain('@octocat');
    expect(body).not.toContain('@PunchIn-App');
  });

  it('neutralises @mentions in the title too', () => {
    const issue = buildIssue(bug, { ...values, title: 'ping @everyone' });
    expect(issue.title).toBe(`ping @${ZWSP}everyone`);
  });

  it('neutralises @mentions in dropdown values (the client can send anything)', () => {
    const body = formatIssueBody(bug, {
      ...values,
      fields: { ...values.fields, 'install-type': '@everyone' },
    }, {});
    expect(body).toContain(`### Install type\n\n@${ZWSP}everyone`);
  });

  it('leaves a lone @ (not a mention) alone', () => {
    const body = formatIssueBody(bug, { ...values, fields: { ...values.fields, expected: 'the @ sign' } }, {});
    expect(body).toContain('### Expected behaviour\n\nthe @ sign');
  });

  // GitHub only linkifies an @ at the start of the string or after a non-word
  // character, so an @ preceded by a word character can never be a mention.
  // Neutralising those anyway corrupts ordinary text with invisible characters —
  // and on an account-free reporter, an email address in the description is the
  // normal case, not an edge case.
  it('leaves an email address intact (the @ cannot start a mention)', () => {
    const body = formatIssueBody(bug, { ...values, fields: { ...values.fields, expected: 'reach me at rob@example.com' } }, {});
    expect(body).toContain('reach me at rob@example.com');
    expect(body).not.toContain(ZWSP);
  });

  it('leaves version specifiers and user@host strings intact', () => {
    const body = formatIssueBody(bug, { ...values, fields: { ...values.fields, expected: 'npm pkg@2.1.0 on user@host:/tmp' } }, {});
    expect(body).toContain('npm pkg@2.1.0 on user@host:/tmp');
    expect(body).not.toContain(ZWSP);
  });

  it('still neutralises a mention that follows punctuation or a newline', () => {
    const body = formatIssueBody(bug, { ...values, fields: { ...values.fields, expected: 'cc (@octocat) and\n@defunkt' } }, {});
    expect(body).toContain(`(@${ZWSP}octocat)`);
    expect(body).toContain(`\n@${ZWSP}defunkt`);
  });

  it('picks a fence longer than any backtick run in a rendered textarea', () => {
    const rendered = parseIssueForm(
      ['name: x', 'body:', '  - type: textarea', '    id: code', '    attributes:', '      label: Code', '      render: js'].join('\n')
    );
    const escape = '```\n### Injected heading\n\nnot part of the code block';
    const body = formatIssueBody(rendered, { fields: { code: escape } }, {});
    expect(body).toBe('### Code\n\n````js\n```\n### Injected heading\n\nnot part of the code block\n````');
  });

  it('grows the fence past even longer runs', () => {
    const rendered = parseIssueForm(
      ['name: x', 'body:', '  - type: textarea', '    id: code', '    attributes:', '      label: Code', '      render: text'].join('\n')
    );
    const body = formatIssueBody(rendered, { fields: { code: 'a\n`````\nb' } }, {});
    expect(body).toBe('### Code\n\n``````text\na\n`````\nb\n``````');
  });

  it('keeps fenced code verbatim (GitHub does not linkify inside a code fence)', () => {
    const rendered = parseIssueForm(
      ['name: x', 'body:', '  - type: textarea', '    id: code', '    attributes:', '      label: Code', '      render: js'].join('\n')
    );
    const body = formatIssueBody(rendered, { fields: { code: '@Component({})\nconst a = "b@c";' } }, {});
    expect(body).toContain('```js\n@Component({})\nconst a = "b@c";\n```');
    expect(body).not.toContain(ZWSP);
  });
});

describe('formatIssueBody (other field types — engine future-proofing)', () => {
  const synthetic = parseIssueForm(
    [
      'name: x', 'body:',
      '  - type: markdown', '    attributes:', '      value: intro text',
      '  - type: dropdown', '    id: d', '    attributes:', '      label: Pick', '      multiple: true',
      '      options:', '        - A', '        - B', '        - C',
      '  - type: checkboxes', '    id: c', '    attributes:', '      label: Agree',
      '      options:', '        - { label: One }', '        - { label: Two }',
      '  - type: textarea', '    id: code', '    attributes:', '      label: Code', '      render: js',
      '  - type: dropdown', '    id: e', '    attributes:', '      label: Empty',
      '      options:', '        - X',
    ].join('\n')
  );

  it('handles markdown exclusion, multi-dropdown, checkboxes, render fence, empty dropdown', () => {
    const body = formatIssueBody(synthetic, { fields: { d: ['A', 'C'], c: ['Two'], code: 'doThing()', e: '' } }, {});
    expect(body).not.toContain('intro text'); // markdown is display-only
    expect(body).toContain('### Pick\n\nA, C');
    expect(body).toContain('### Agree\n\n- [ ] One\n- [x] Two');
    expect(body).toContain('### Code\n\n```js\ndoThing()\n```');
    expect(body).toContain('### Empty\n\nNone');
  });
});
