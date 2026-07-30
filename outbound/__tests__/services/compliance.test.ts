/**
 * @jest-environment node
 *
 * DNC area-code registry, the phone-consent ask cadence, email formatting, and skills resolution.
 *
 * The registry gate is the one with teeth: the scrub provider returns "clean" for an area code we are
 * NOT subscribed to, so an un-registered code must read as NOT allowed. That is why `isAreaCodeAllowed`
 * fails closed and why an expired SAN stops being allowed with no manual flag to flip.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

jest.mock('../../firebase/db', () =>
  require('../../testSupport/mockFirestore').mockDbModule()
);

import { store } from '../../testSupport/mockFirestore';
import {
  annotateAreaCode,
  areaCodeOf,
  effectiveAllowed,
  getAllowedAreaCodes,
  isAreaCodeAllowed,
  isValidAreaCode,
  listAreaCodes,
  normalizeExpiry,
  phonePasses,
  splitValid,
  upsertAreaCodes,
} from '../../services/dncAreaCodes';
import { buildPhoneConsentAskLine } from '../../services/callScope';
import { toHtml, toText } from '../../services/emailFormat';
import {
  applySkillsToPrompt,
  replaceTemplateVariables,
  restoreWipedInjections,
  scopeActionsToEnabledTools,
} from '../../services/skillsResolver';
import type { Skill } from '../../firebase/skills';

beforeEach(() => {
  store.reset();
});

const future = '2099-12-31';
const past = '2000-01-01';

describe('isValidAreaCode', () => {
  it('accepts a NANP code (3 digits, first 2-9)', () => {
    expect(isValidAreaCode('303')).toBe(true);
    expect(isValidAreaCode('999')).toBe(true);
  });

  it('rejects a leading 0 or 1, and wrong lengths', () => {
    expect(isValidAreaCode('012')).toBe(false);
    expect(isValidAreaCode('123')).toBe(false);
    expect(isValidAreaCode('30')).toBe(false);
    expect(isValidAreaCode('3033')).toBe(false);
    expect(isValidAreaCode('')).toBe(false);
    expect(isValidAreaCode(null)).toBe(false);
  });
});

describe('areaCodeOf', () => {
  it.each([
    ['+1 (303) 555-0123', '303'],
    ['3035550123', '303'],
    ['13035550123', '303'],
  ])('extracts %s -> %s', (phone, expected) => {
    expect(areaCodeOf(phone)).toBe(expected);
  });

  it('returns empty for a too-short or absent number', () => {
    expect(areaCodeOf('555-0123')).toBe('');
    expect(areaCodeOf('')).toBe('');
    expect(areaCodeOf(null)).toBe('');
  });
});

describe('normalizeExpiry', () => {
  it.each([
    ['2026-06-30', '2026-06-30'],
    ['6/30/2026', '2026-06-30'],
    ['06/30/2026', '2026-06-30'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeExpiry(input)).toBe(expected);
  });

  it('handles a Date', () => {
    expect(normalizeExpiry(new Date('2026-06-30T00:00:00Z'))).toBe(
      '2026-06-30'
    );
  });

  it('applies the two-digit-year pivot at 69, matching Python %y', () => {
    expect(normalizeExpiry('6/30/26')).toBe('2026-06-30');
    expect(normalizeExpiry('6/30/70')).toBe('1970-06-30');
  });

  it('returns null for empty or unparseable input', () => {
    expect(normalizeExpiry('')).toBeNull();
    expect(normalizeExpiry(null)).toBeNull();
    expect(normalizeExpiry('30-06-2026')).toBeNull();
    expect(normalizeExpiry('next tuesday')).toBeNull();
  });
});

describe('splitValid', () => {
  it('dedupes valid codes preserving order, and reports invalid ones', () => {
    // Invalid codes are reported rather than silently dropped, so the admin form can show them.
    expect(splitValid(['303', '770', '303', '12', 'abc', ''])).toEqual([
      ['303', '770'],
      ['12', 'abc'],
    ]);
  });

  it('handles empty input', () => {
    expect(splitValid([])).toEqual([[], []]);
    expect(splitValid(null)).toEqual([[], []]);
  });
});

describe('isAreaCodeAllowed', () => {
  it('is true for a registered, unexpired code', async () => {
    store.set('dnc_ftc_area_codes/303', {
      area_code: '303',
      san_expiry_date: future,
    });
    expect(await isAreaCodeAllowed('303')).toBe(true);
  });

  it('is true when there is no expiry at all', async () => {
    store.set('dnc_ftc_area_codes/303', { area_code: '303' });
    expect(await isAreaCodeAllowed('303')).toBe(true);
  });

  it('is FALSE once the SAN has expired — active is derived, no flag to forget', async () => {
    store.set('dnc_ftc_area_codes/303', {
      area_code: '303',
      san_expiry_date: past,
    });
    expect(await isAreaCodeAllowed('303')).toBe(false);
  });

  it('is FALSE for an unregistered code — the whole point of the registry', async () => {
    // The scrub provider would return "clean" for this code, which is a false negative.
    expect(await isAreaCodeAllowed('303')).toBe(false);
  });

  it('is FALSE for an invalid code', async () => {
    expect(await isAreaCodeAllowed('12')).toBe(false);
  });
});

describe('getAllowedAreaCodes', () => {
  it('includes unexpired and excludes expired', async () => {
    store.set('dnc_ftc_area_codes/303', {
      area_code: '303',
      san_expiry_date: future,
    });
    store.set('dnc_ftc_area_codes/770', {
      area_code: '770',
      san_expiry_date: past,
    });
    store.set('dnc_ftc_area_codes/212', { area_code: '212' });

    const allowed = await getAllowedAreaCodes();
    expect([...allowed].sort()).toEqual(['212', '303']);
  });
});

describe('upsertAreaCodes', () => {
  it('writes one document per code and reports invalid ones', async () => {
    const result = await upsertAreaCodes(
      ['303', '770', 'bad'],
      'SAN1',
      'ORG1',
      '6/30/2026'
    );
    expect(result.saved.sort()).toEqual(['303', '770']);
    expect(result.invalid).toEqual(['bad']);

    const doc = store.get('dnc_ftc_area_codes/303')!;
    expect(doc.area_code).toBe('303');
    expect(doc.san_id).toBe('SAN1');
    expect(doc.san_expiry_date).toBe('2026-06-30');
    expect(doc.created_at).toBeInstanceOf(Date);
  });

  it('does not reset created_at on an existing document', async () => {
    const originalCreated = new Date('2020-01-01T00:00:00Z');
    store.set('dnc_ftc_area_codes/303', {
      area_code: '303',
      created_at: originalCreated,
    });
    await upsertAreaCodes(['303'], 'SAN2');
    const doc = store.get('dnc_ftc_area_codes/303')!;
    expect((doc.created_at as Date).getTime()).toBe(originalCreated.getTime());
    expect(doc.san_id).toBe('SAN2');
  });

  it('omits SAN fields that were not supplied, so a merge keeps existing values', async () => {
    store.set('dnc_ftc_area_codes/303', { area_code: '303', san_id: 'KEEP' });
    await upsertAreaCodes(['303'], undefined, undefined, undefined);
    expect(store.get('dnc_ftc_area_codes/303')!.san_id).toBe('KEEP');
  });

  it('returns early with no writes when nothing is valid', async () => {
    expect(await upsertAreaCodes(['bad', '12'])).toEqual({
      saved: [],
      invalid: ['bad', '12'],
    });
  });
});

describe('listAreaCodes', () => {
  it('annotates is_expired / is_active and sorts by code', async () => {
    store.set('dnc_ftc_area_codes/770', {
      area_code: '770',
      san_expiry_date: past,
    });
    store.set('dnc_ftc_area_codes/303', {
      area_code: '303',
      san_expiry_date: future,
    });

    const rows = await listAreaCodes();
    expect(rows.map((r) => r.area_code)).toEqual(['303', '770']);
    expect(rows[0]).toMatchObject({ is_expired: false, is_active: true });
    expect(rows[1]).toMatchObject({ is_expired: true, is_active: false });
  });
});

describe('effectiveAllowed / phonePasses', () => {
  beforeEach(() => {
    store.set('dnc_ftc_area_codes/303', {
      area_code: '303',
      san_expiry_date: future,
    });
    store.set('dnc_ftc_area_codes/770', {
      area_code: '770',
      san_expiry_date: past,
    });
  });

  it('an empty selection means NO filter (null), which is different from an empty set', async () => {
    expect(await effectiveAllowed([])).toBeNull();
    expect(await effectiveAllowed(null)).toBeNull();
  });

  it('intersects the selection with the registered-unexpired registry', async () => {
    const allowed = await effectiveAllowed(['303', '770', '212', 'bad']);
    expect([...allowed!]).toEqual(['303']);
  });

  it('can resolve to an EMPTY set, which passes no phone-bearing record', async () => {
    const allowed = await effectiveAllowed(['770']); // registered but expired
    expect(allowed).toEqual(new Set());
    expect(phonePasses('3035550123', allowed)).toBe(false);
    // ...but an email-only contact is still kept.
    expect(phonePasses('', allowed)).toBe(true);
  });

  it('phonePasses is always true when the filter is off', () => {
    expect(phonePasses('9995550123', null)).toBe(true);
  });

  it('phonePasses honours keepNoPhone', () => {
    expect(phonePasses('', new Set(['303']), true)).toBe(true);
    expect(phonePasses('', new Set(['303']), false)).toBe(false);
  });
});

describe('annotateAreaCode', () => {
  it('reads the phone from any of the payload shapes', () => {
    expect(
      annotateAreaCode({ contact_information: { phone_number: '3035550123' } })
        .area_code
    ).toBe('303');
    expect(
      annotateAreaCode({ input_data: { phone_number: '2125550123' } }).area_code
    ).toBe('212');
    expect(annotateAreaCode({ phone_number: '3105550123' }).area_code).toBe(
      '310'
    );
    expect(annotateAreaCode({}).area_code).toBe('');
  });
});

describe('buildPhoneConsentAskLine — the <=2 ask cadence', () => {
  const base = { customer_email: 'a@b.c', phone_opt_out: 'Y' as const };

  it('returns null when the phone channel is OPEN — nothing to ask for', () => {
    expect(
      buildPhoneConsentAskLine(
        { customer_email: 'a@b.c', phone_number: '3035550123' },
        'admin',
        ''
      )
    ).toBeNull();
  });

  it('returns null when email is closed — there is no way to ask', () => {
    expect(
      buildPhoneConsentAskLine({ ...base, _email_opt_out: true }, 'admin', '')
    ).toBeNull();
  });

  it('returns null when there is no email address at all', () => {
    expect(
      buildPhoneConsentAskLine({ phone_opt_out: 'Y' }, 'admin', '')
    ).toBeNull();
  });

  it('returns null for a business_only campaign — business numbers need no PEWC consent', () => {
    expect(
      buildPhoneConsentAskLine({ ...base, business_only: true }, 'admin', '')
    ).toBeNull();
  });

  it('ASK #1 on the cold outreach turn', () => {
    const line = buildPhoneConsentAskLine(base, 'admin', '');
    expect(line).toContain('ASK #1');
  });

  it('ASK #2 on the reply that contained no number', () => {
    const line = buildPhoneConsentAskLine(
      { ...base, _phone_ask_count: 1 },
      'customer',
      'no thanks'
    );
    expect(line).toContain('ASK #2');
  });

  it('STOPS asking after two — the hard cap', () => {
    expect(
      buildPhoneConsentAskLine(
        { ...base, _phone_ask_count: 2 },
        'customer',
        'still nothing'
      )
    ).toBeNull();
  });

  it('detects a number in the reply and switches to "we will call"', () => {
    const line = buildPhoneConsentAskLine(
      { ...base, _phone_ask_count: 1 },
      'customer',
      'sure, reach me at (303) 555-0123'
    );
    expect(line).toContain('Do NOT ask again');
  });

  it('detects a number even on the first reply, before any ask was counted', () => {
    const line = buildPhoneConsentAskLine(
      base,
      'customer',
      'my cell is 303-555-0123'
    );
    expect(line).toContain('Do NOT ask again');
  });

  it('also fires when the phone is simply MISSING rather than opted out', () => {
    const line = buildPhoneConsentAskLine(
      { customer_email: 'a@b.c' },
      'admin',
      ''
    );
    expect(line).toContain('ASK #1');
  });
});

describe('emailFormat.toText', () => {
  it('strips bold and renders a markdown link as "text (url)"', () => {
    expect(toText('Hi **there**, see [our demo](https://x.co/d) today')).toBe(
      'Hi there, see our demo (https://x.co/d) today'
    );
  });

  it('leaves a bare URL intact', () => {
    expect(toText('visit https://x.co/demo now')).toBe(
      'visit https://x.co/demo now'
    );
  });

  it('collapses 3+ blank lines to two and trims', () => {
    expect(toText('a\n\n\n\nb')).toBe('a\n\nb');
  });

  it('handles empty input', () => {
    expect(toText('')).toBe('');
  });
});

describe('emailFormat.toHtml', () => {
  it('renders a markdown link as a real anchor', () => {
    expect(toHtml('see [our demo](https://x.co/d)')).toContain(
      '<a href="https://x.co/d">our demo</a>'
    );
  });

  it('does NOT swallow a trailing ** into the href — the Gmail auto-linker bug this exists to fix', () => {
    const html = toHtml('go to **https://x.co/demo**');
    expect(html).toContain('<a href="https://x.co/demo">https://x.co/demo</a>');
    expect(html).not.toContain('href="https://x.co/demo*');
  });

  it('keeps trailing punctuation outside the anchor', () => {
    const html = toHtml('see https://x.co/demo.');
    expect(html).toContain(
      '<a href="https://x.co/demo">https://x.co/demo</a>.'
    );
  });

  it('renders bold as <strong>', () => {
    expect(toHtml('**bold** and __also bold__')).toContain(
      '<strong>bold</strong>'
    );
  });

  it('renders a bullet list as a <ul>', () => {
    const html = toHtml('- one\n- two');
    expect(html).toContain('<ul');
    expect(html).toContain('<li style="margin:0 0 4px;">one</li>');
  });

  it('escapes HTML in the body so a prospect name cannot inject markup', () => {
    expect(toHtml('hello <script>alert(1)</script>')).toContain(
      '&lt;script&gt;'
    );
  });

  it('uses inline styles only — email clients strip <style> blocks', () => {
    const html = toHtml('hi');
    expect(html).toContain('style="font-family');
    expect(html).not.toContain('<style');
  });

  it('handles empty input without throwing', () => {
    expect(toHtml('')).toContain('<div style=');
  });
});

describe('skillsResolver.applySkillsToPrompt', () => {
  const skill = (over: Partial<Skill>): Skill =>
    ({
      id: 'x',
      name: 'x',
      status: 'active',
      type: 'outbound',
      ...over,
    }) as Skill;

  it('WIPES the base prompt for outbound — outbound is skills-only', () => {
    const [prompt] = applySkillsToPrompt('BASE PROMPT', [], []);
    expect(prompt).toBe('');
  });

  it('keeps the base prompt for a non-outbound chat', () => {
    const [prompt] = applySkillsToPrompt('BASE PROMPT', [], [], 'web');
    expect(prompt).toBe('BASE PROMPT');
  });

  it('concatenates skill instructions', () => {
    const [prompt] = applySkillsToPrompt(
      'BASE',
      [skill({ instructions: 'first' }), skill({ instructions: 'second' })],
      []
    );
    expect(prompt).toBe('first\n\nsecond');
  });

  it('EXCLUDES voice skills from the text prompt and toolset', () => {
    // A voice skill in the text prompt would have the agent narrate call scripting over email.
    const [prompt, tools] = applySkillsToPrompt(
      'BASE',
      [
        skill({
          instructions: 'CALL SCRIPT',
          voice_skill: true,
          tools_to_enable: ['x'],
        }),
      ],
      []
    );
    expect(prompt).toBe('');
    expect(tools.size).toBe(0);
  });

  it('accepts type "both" but not untyped or inbound skills', () => {
    const [prompt] = applySkillsToPrompt(
      'BASE',
      [
        skill({ instructions: 'shared', type: 'both' }),
        skill({ instructions: 'inbound only', type: 'inbound' }),
        skill({ instructions: 'untyped', type: undefined }),
      ],
      []
    );
    expect(prompt).toBe('shared');
  });

  it('mutates enabledFunctions in place, adding then removing', () => {
    const enabled: string[] = ['email'];
    const [, tools] = applySkillsToPrompt(
      'BASE',
      [
        skill({
          tools_to_enable: ['make_phone_call'],
          tools_to_disable: ['email'],
        }),
      ],
      enabled
    );
    expect(enabled).toEqual(['make_phone_call']);
    expect([...tools]).toEqual(['make_phone_call']);
  });

  it('lets a later skill disable a tool an earlier one enabled', () => {
    const enabled: string[] = [];
    applySkillsToPrompt(
      'BASE',
      [
        skill({ tools_to_enable: ['email'] }),
        skill({ tools_to_disable: ['email'] }),
      ],
      enabled
    );
    expect(enabled).toEqual([]);
  });
});

describe('skillsResolver.restoreWipedInjections', () => {
  it('puts the recent block at the very top, then the host fact', () => {
    // The recent conversation is most salient for a "read the inbound email and reply" turn.
    expect(restoreWipedInjections('SKILLS', 'HOST', 'RECENT')).toBe(
      'RECENT\n\nHOST\n\nSKILLS'
    );
  });

  it('is a no-op for empty inputs', () => {
    expect(restoreWipedInjections('SKILLS')).toBe('SKILLS');
  });
});

describe('skillsResolver.scopeActionsToEnabledTools', () => {
  it('keeps only actions supplying an enabled tool', () => {
    const actions = [
      { functions: ['make_phone_call'] },
      { functions: ['unused_tool'] },
      { functions: [] },
    ];
    expect(scopeActionsToEnabledTools(actions, ['make_phone_call'])).toEqual([
      { functions: ['make_phone_call'] },
    ]);
  });

  it('handles empty inputs', () => {
    expect(scopeActionsToEnabledTools(null, ['x'])).toEqual([]);
    expect(scopeActionsToEnabledTools([{ functions: ['x'] }], null)).toEqual(
      []
    );
  });
});

describe('skillsResolver.replaceTemplateVariables', () => {
  it('replaces all three placeholder forms', () => {
    const memory = { first_name: 'Dana' };
    expect(replaceTemplateVariables('Hi {{first_name}}', memory)).toBe(
      'Hi Dana'
    );
    expect(replaceTemplateVariables('Hi {first_name}', memory)).toBe('Hi Dana');
    expect(replaceTemplateVariables('Hi {{first\\_name}}', memory)).toBe(
      'Hi Dana'
    );
  });

  it('SKIPS internal keys so code-owned markers never leak into a prompt', () => {
    expect(
      replaceTemplateVariables('x {{_outreach_lane}}', {
        _outreach_lane: 'phone',
      })
    ).toBe('x {{_outreach_lane}}');
  });

  it('stringifies non-string values and skips nulls', () => {
    expect(replaceTemplateVariables('n={{count}}', { count: 3 })).toBe('n=3');
    expect(replaceTemplateVariables('n={{count}}', { count: null })).toBe(
      'n={{count}}'
    );
  });

  it('handles empty inputs', () => {
    expect(replaceTemplateVariables('', { a: 'b' })).toBe('');
    expect(replaceTemplateVariables('x', null)).toBe('x');
  });
});
