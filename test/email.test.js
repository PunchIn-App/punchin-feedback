import { describe, it, expect } from 'vitest';
import { buildCopyEmail, buildClosedEmail, buildReopenEmail, sendEmail } from '../src/email.js';
import { makeEnv } from './helpers.js';

const issue = { number: 7, html_url: 'https://github.com/PunchIn-App/punchin/issues/7' };
const unsubUrl = 'https://feedback.trackmytime.today/unsubscribe?token=abc';
const appUrl = 'https://trackmytime.today';

describe('buildCopyEmail', () => {
  const m = buildCopyEmail({ issue, title: 'Timer drifts', kind: 'bug', bodyMarkdown: '### What happened\n\nx', unsubUrl, appUrl });

  it('puts unsubscribe at the very top of the body', () => {
    expect(m.text.startsWith(`Unsubscribe: ${unsubUrl}`)).toBe(true);
    expect(m.html.indexOf('Unsubscribe')).toBeLessThan(m.html.indexOf('What happened'));
  });
  it('includes the issue number/link and a copy of the submission', () => {
    expect(m.subject).toContain('#7');
    expect(m.text).toContain(issue.html_url);
    expect(m.text).toContain('What happened');
  });
  it('sets https-only List-Unsubscribe headers + One-Click', () => {
    expect(m.headers['List-Unsubscribe']).toBe(`<${unsubUrl}>`);
    expect(m.headers['List-Unsubscribe']).toContain('https://');
    expect(m.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });
  it('discloses why the email was received', () => {
    expect(m.text).toContain("You're receiving this because");
  });
});

describe('close / reopen emails', () => {
  it('close email includes the state reason', () => {
    const m = buildClosedEmail({ issue, title: 'T', kind: 'bug', stateReason: 'completed', unsubUrl, appUrl });
    expect(m.subject).toContain('Closed');
    expect(m.text).toContain('completed');
  });
  it('reopen email mentions reopened + link', () => {
    const m = buildReopenEmail({ issue, title: 'T', kind: 'bug', unsubUrl, appUrl });
    expect(m.subject).toContain('Reopened');
    expect(m.text).toContain(issue.html_url);
  });
});

describe('sendEmail', () => {
  it('uses the binding shape (from.email) and forwards headers', async () => {
    const env = makeEnv();
    await sendEmail(env, 'r@example.com', buildReopenEmail({ issue, title: 'T', kind: 'bug', unsubUrl, appUrl }));
    expect(env.EMAIL.sent).toHaveLength(1);
    expect(env.EMAIL.sent[0].from.email).toBe('feedback@trackmytime.today');
    expect(env.EMAIL.sent[0].to).toBe('r@example.com');
    expect(env.EMAIL.sent[0].headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });
});
