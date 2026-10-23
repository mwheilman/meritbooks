/** Header values built from tenant / user text never carry CR / LF into the message headers. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { headerSafe, ResendProvider } from './provider';

afterEach(() => vi.unstubAllGlobals());

describe('headerSafe', () => {
  it('strips CR / LF and other control characters', () => {
    expect(headerSafe('Invoice 1001\r\nBcc: victim@example.com')).toBe('Invoice 1001 Bcc: victim@example.com');
    expect(headerSafe('A\u0000B\tC D')).toBe('A B C D');
    expect(headerSafe('  plain  ')).toBe('plain');
  });
});

describe('ResendProvider', () => {
  it('sends single-line subject, from, reply-to, addresses and filenames', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'msg_1' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await new ResendProvider('re_test').send(
      {
        to: ['a@example.com\r\n'],
        cc: ['b@example.com\n'],
        subject: 'Payment reminder\r\nX-Injected: 1',
        html: '<p>x</p>',
        replyTo: 'r@example.com\r\nBcc: z@example.com',
        attachments: [{ filename: 'inv\r\n"1".pdf', content: new Uint8Array([1]), contentType: 'application/pdf' }],
      },
      'Acme Co\r\n <billing@acme.test>',
    );
    const call = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    const sent = JSON.parse(call[1].body) as Record<string, unknown>;
    const all = JSON.stringify(sent);
    expect(all).not.toMatch(/\\r|\\n/);
    expect(sent.subject).toBe('Payment reminder X-Injected: 1');
    expect(sent.to).toEqual(['a@example.com']);
    expect((sent.attachments as Array<{ filename: string }>)[0].filename).toBe('inv _1_.pdf');
  });
});
