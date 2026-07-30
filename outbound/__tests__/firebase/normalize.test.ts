/**
 * @jest-environment node
 *
 * Pure parsing / normalization from `firebase/chat.ts`. No Firestore involved.
 *
 * These matter because the normalizers are the boundary between three LLM providers and the store:
 * a message that leaves here in a non-canonical shape is rejected by Bedrock at request time, and
 * the failure surfaces far from the cause.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

// Mocked even though nothing here touches Firestore: importing chat.ts pulls in the db seam, which
// initializes firebase-admin and throws without credentials. Mocking keeps the suite runnable
// anywhere, including CI with no .env.
jest.mock('../../firebase/db', () =>
  require('../../testSupport/mockFirestore').mockDbModule()
);

import {
  deriveMessageStatus,
  extractInfo,
  getFileTypeFromUrl,
  normalizeBedrockMessage,
  normalizeMessageContent,
  normalizeToolResultContent,
} from '../../firebase/chat';

describe('extractInfo', () => {
  it('parses a JSON dict embedded in surrounding prose', () => {
    const out = extractInfo(
      'Admin says: {"original_date": "2026-03-04", "original_time": "14:30", ' +
        '"timezone": "America/New_York", "notes": "call them back"} thanks'
    );
    expect(out.notes).toBe('call them back');
    expect(out.timezone).toBe('America/New_York');
    expect(out.original_datetime.toISOString()).toBe(
      '2026-03-04T14:30:00.000Z'
    );
  });

  it('parses a Python-style dict with single quotes', () => {
    const out = extractInfo(
      "{'original_date': '2026-03-04', 'original_time': '09:05:07', " +
        "'timezone': 'UTC', 'notes': 'ping'}"
    );
    expect(out.notes).toBe('ping');
    expect(out.original_datetime.toISOString()).toBe(
      '2026-03-04T09:05:07.000Z'
    );
  });

  it('parses Python literals (True/False/None) via the literal_eval fallback', () => {
    const out = extractInfo(
      "{'original_date': '2026-03-04', 'original_time': '10:00', 'timezone': 'UTC', " +
        "'notes': 'x', 'urgent': True, 'assignee': None}"
    );
    expect(out.notes).toBe('x');
  });

  it('throws when there is no dict-like substring', () => {
    expect(() => extractInfo('just a plain admin note')).toThrow(
      /No dictionary-like substring/
    );
  });

  it('throws when a required key is missing', () => {
    expect(() =>
      extractInfo('{"original_date": "2026-03-04", "notes": "x"}')
    ).toThrow(/Missing key/);
  });

  it('throws on an unparseable date/time', () => {
    expect(() =>
      extractInfo(
        '{"original_date": "04/03/2026", "original_time": "14:30", ' +
          '"timezone": "UTC", "notes": "x"}'
      )
    ).toThrow(/Could not parse date\/time/);
  });
});

describe('getFileTypeFromUrl', () => {
  it.each([
    ['https://cdn.example.com/a/b/photo.JPG', 'image'],
    ['https://cdn.example.com/clip.mp4', 'video'],
    ['https://cdn.example.com/note.opus', 'audio'],
    ['https://cdn.example.com/contract.docx', 'doc'],
    ['https://cdn.example.com/archive.7z', 'doc'],
  ])('classifies %s as %s', (url, expected) => {
    expect(getFileTypeFromUrl(url)).toBe(expected);
  });

  it('ignores a query string when reading the extension', () => {
    expect(
      getFileTypeFromUrl('https://cdn.example.com/photo.png?sig=abc&x=1')
    ).toBe('image');
  });

  it('returns unknown for an extensionless path, a bare name, and empty input', () => {
    expect(getFileTypeFromUrl('https://cdn.example.com/download')).toBe(
      'unknown'
    );
    expect(getFileTypeFromUrl('somefile.xyz')).toBe('unknown');
    expect(getFileTypeFromUrl('')).toBe('unknown');
    expect(getFileTypeFromUrl(null)).toBe('unknown');
  });

  it('handles a non-URL path', () => {
    expect(getFileTypeFromUrl('/local/path/file.pdf')).toBe('doc');
  });
});

describe('normalizeToolResultContent', () => {
  it('returns [{json:{}}] for null/undefined rather than an empty array', () => {
    // An empty content array is rejected by the providers, so the floor matters.
    expect(normalizeToolResultContent(null)).toEqual([{ json: {} }]);
    expect(normalizeToolResultContent(undefined)).toEqual([{ json: {} }]);
    expect(normalizeToolResultContent([])).toEqual([{ json: {} }]);
  });

  it('passes through json and text blocks', () => {
    expect(
      normalizeToolResultContent([{ json: { a: 1 } }, { text: 'hi' }])
    ).toEqual([{ json: { a: 1 } }, { text: 'hi' }]);
  });

  it('wraps a bare object as a json block', () => {
    expect(normalizeToolResultContent({ status: 'ok' })).toEqual([
      { json: { status: 'ok' } },
    ]);
  });

  it('stringifies a scalar into a text block', () => {
    expect(normalizeToolResultContent(42)).toEqual([{ text: '42' }]);
  });
});

describe('normalizeMessageContent', () => {
  it('returns [{text:""}] for empty input', () => {
    expect(normalizeMessageContent([])).toEqual([{ text: '' }]);
    expect(normalizeMessageContent(null)).toEqual([{ text: '' }]);
  });

  it('wraps a bare string', () => {
    expect(normalizeMessageContent('hello')).toEqual([{ text: 'hello' }]);
  });

  it('strips extra keys from a toolUse block and defaults a missing input', () => {
    const out = normalizeMessageContent([
      {
        toolUse: {
          toolUseId: 'tu_1',
          name: 'make_phone_call',
          input: null,
          type: 'legacy',
        },
      },
    ]);
    expect(out).toEqual([
      { toolUse: { toolUseId: 'tu_1', name: 'make_phone_call', input: {} } },
    ]);
  });

  it('normalizes a toolResult block', () => {
    const out = normalizeMessageContent([
      {
        toolResult: {
          toolUseId: 'tu_1',
          content: [{ json: { ok: true } }],
          status: 'success',
        },
      },
    ]);
    expect(out).toEqual([
      { toolResult: { toolUseId: 'tu_1', content: [{ json: { ok: true } }] } },
    ]);
  });

  it('promotes a legacy FLAT tool result into a wrapped toolResult', () => {
    // Historical documents stored {toolUseId, content} without the toolResult wrapper.
    const out = normalizeMessageContent([
      { toolUseId: 'tu_9', content: { done: 1 } },
    ]);
    expect(out).toEqual([
      { toolResult: { toolUseId: 'tu_9', content: [{ json: { done: 1 } }] } },
    ]);
  });

  it('synthesizes a toolUseId when one is missing', () => {
    const out = normalizeMessageContent([
      { toolUse: { name: 'x', input: {} } },
    ]) as Array<{
      toolUse: { toolUseId: string };
    }>;
    expect(out[0].toolUse.toolUseId).toMatch(/^tooluse_[0-9a-f]{24}$/);
  });

  it('JSON-stringifies an unrecognized object', () => {
    expect(normalizeMessageContent([{ weird: 1 }])).toEqual([
      { text: '{"weird":1}' },
    ]);
  });
});

describe('normalizeBedrockMessage', () => {
  it('defaults the role to assistant', () => {
    expect(normalizeBedrockMessage({ content: [{ text: 'x' }] })).toEqual({
      role: 'assistant',
      content: [{ text: 'x' }],
    });
  });

  it('wraps a non-object into an assistant text message', () => {
    expect(normalizeBedrockMessage('boom')).toEqual({
      role: 'assistant',
      content: [{ text: 'boom' }],
    });
  });

  it('preserves an explicit user role', () => {
    expect(normalizeBedrockMessage({ role: 'user', content: 'hi' })).toEqual({
      role: 'user',
      content: [{ text: 'hi' }],
    });
  });
});

describe('deriveMessageStatus', () => {
  it('defaults to delivered for empty or non-object results', () => {
    expect(deriveMessageStatus(null)).toBe('delivered');
    expect(deriveMessageStatus({})).toBe('delivered');
    expect(deriveMessageStatus('nope')).toBe('delivered');
  });

  it.each(['error', 'failed', 'undelivered'])(
    'maps the %s status to failed',
    (status) => {
      expect(deriveMessageStatus({ status })).toBe('failed');
    }
  );

  it('treats a numeric HTTP status >= 400 as failed', () => {
    // The Unipile send path returns a bare HTTP code rather than a string status.
    expect(deriveMessageStatus({ status: 401 })).toBe('failed');
    expect(deriveMessageStatus({ status: 500 })).toBe('failed');
  });

  it('treats a numeric status < 400 as delivered', () => {
    expect(deriveMessageStatus({ status: 200 })).toBe('delivered');
  });
});
