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
