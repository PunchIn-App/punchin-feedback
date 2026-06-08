import { describe, it, expect } from 'vitest';
import { buildCopyEmail, buildClosedEmail, buildReopenEmail, buildCommentEmail, sendEmail } from '../src/email.js';
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

describe('buildCommentEmail', () => {
  const m = buildCommentEmail({ issue, title: 'T', kind: 'bug', author: 'maintainer', commentBody: 'Which browser?', commentUrl: 'https://github.com/x/7#c1', unsubUrl, replyTo: 'comment+abc@trackmytime.today', appUrl });
  it('includes author, comment, link, reply hint; unsubscribe at top; replyTo set', () => {
    expect(m.subject).toContain('New comment on #7');
    expect(m.text).toContain('maintainer commented');
    expect(m.text).toContain('Which browser?');
    expect(m.text).toContain('Reply to this email to respond');
    expect(m.text.startsWith(`Unsubscribe: ${unsubUrl}`)).toBe(true);
    expect(m.replyTo).toBe('comment+abc@trackmytime.today');
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

  it('forwards replyTo when present', async () => {
    const env = makeEnv();
    await sendEmail(env, 'r@example.com', buildCommentEmail({ issue, title: 'T', kind: 'bug', author: 'm', commentBody: 'hi', commentUrl: 'u', unsubUrl, replyTo: 'comment+x@trackmytime.today', appUrl }));
    expect(env.EMAIL.sent[0].replyTo).toBe('comment+x@trackmytime.today');
  });
});
