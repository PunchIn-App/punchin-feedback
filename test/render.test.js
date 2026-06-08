import { describe, it, expect } from 'vitest';
import { parseIssueForm } from '../src/templates.js';
import { bundled } from '../src/bundledTemplates.js';
import { renderForm, renderSuccess, renderError } from '../src/render.js';

const bug = parseIssueForm(bundled.bug);

describe('renderForm', () => {
  const html = renderForm(bug, { kind: 'bug', turnstileSitekey: 'sk-123', accent: '#112233' });

  it('renders every field with a wired label and a control named f.<id>', () => {
    for (const f of bug.fields) {
      expect(html).toContain(`for="field-${f.id}"`); // <label for> wired to the control
      expect(html).toContain(`name="f.${f.id}"`);
    }
    expect(html).toContain('<select id="field-install-type"'); // dropdown
    expect(html).toContain('Browser &amp; version'); // labels are HTML-escaped
  });

  it('includes a required Title field, honeypot, and multipart form', () => {
    expect(html).toContain('name="title"');
    expect(html).toContain('name="_hp"');
    expect(html).toContain('action="/submit"');
    expect(html).toContain('enctype="multipart/form-data"');
  });

  it('includes the optional email + three notification checkboxes (copy pre-checked)', () => {
    expect(html).toContain('name="reporter-email"');
    expect(html).toMatch(/name="notify-copy"\s+checked/);
    expect(html).toContain('name="notify-closed"');
    expect(html).toContain('name="notify-reopened"');
  });

  it('includes the screenshot upload + the Cloudflare R2 + email disclosures', () => {
    expect(html).toContain('name="screenshots"');
    expect(html).toContain('Cloudflare R2');
    expect(html).toContain('Deleted 1 year after upload');
    expect(html).toContain('Deleted 3 months after the issue is closed');
  });

  it('shows the Turnstile widget when a sitekey is given, and the sniff script', () => {
    expect(html).toContain('class="cf-turnstile" data-sitekey="sk-123"');
    expect(html).toContain('challenges.cloudflare.com/turnstile/v0/api.js');
    expect(html).toContain("set('field-browser'"); // inline UA-sniff script
  });

  it('omits Turnstile when no sitekey is configured', () => {
    const noTs = renderForm(bug, { kind: 'bug', turnstileSitekey: '' });
    expect(noTs).not.toContain('cf-turnstile');
    expect(noTs).not.toContain('turnstile/v0/api.js');
  });

  it('prefills values from query params', () => {
    const html2 = renderForm(bug, { kind: 'bug', prefill: { version: '0.21.0', 'install-type': 'Browser tab', title: 'Crash' } });
    expect(html2).toContain('value="0.21.0"');
    expect(html2).toContain('<option value="Browser tab" selected>');
    expect(html2).toContain('value="Crash"');
  });

  it('shows an error banner when given one', () => {
    expect(renderForm(bug, { kind: 'bug', error: 'Please fix the form' })).toContain('Please fix the form');
  });
});

describe('renderSuccess / renderError', () => {
  it('success shows the issue number, link, and emailed note', () => {
    const html = renderSuccess({ number: 7, html_url: 'https://github.com/x/7', emailed: true });
    expect(html).toContain('#7');
    expect(html).toContain('https://github.com/x/7');
    expect(html).toContain('emailed you a copy');
  });
  it('error page shows the message', () => {
    expect(renderError('Could not file the issue')).toContain('Could not file the issue');
  });
});
