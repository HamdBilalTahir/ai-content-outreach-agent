/**
 * @jest-environment node
 *
 * The FTC DNC area-code registry endpoints.
 *
 * The validation itself is covered by `serializers.test.ts`; what these assert is the view layer's two
 * surprising choices — `success` tracking what was SAVED rather than whether the request was well-formed,
 * and DELETE answering 400 for a code that was not in the registry.
 */
/* eslint-disable no-undef -- jest globals; the flat config declares no jest environment */

jest.mock('../../services/dncAreaCodes', () => {
  const actual = jest.requireActual('../../services/dncAreaCodes');
  return {
    ...actual,
    listAreaCodes: jest.fn(),
    upsertAreaCodes: jest.fn(),
    deleteAreaCode: jest.fn(),
  };
});

import {
  dncAreaCodeDeleteView,
  dncAreaCodesListView,
  dncAreaCodesUpsertView,
} from '../../http/dncViews';
import {
  deleteAreaCode,
  listAreaCodes,
  upsertAreaCodes,
} from '../../services/dncAreaCodes';
import type { OutboundRequest } from '../../http/types';

function req(
  body: Record<string, unknown> = {},
  query: Record<string, string> = {}
): OutboundRequest {
  return {
    method: 'POST',
    params: {},
    query,
    headers: {},
    body,
    bodyArray: null,
    rawBody: '',
  };
}

beforeEach(() => jest.clearAllMocks());

describe('dncAreaCodesListView', () => {
  it('returns the rows with a count', async () => {
    (listAreaCodes as jest.Mock).mockResolvedValue([
      { area_code: '303', is_active: true },
      { area_code: '770', is_active: false },
    ]);
    const res = await dncAreaCodesListView();
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      success: true,
      area_codes: [
        { area_code: '303', is_active: true },
        { area_code: '770', is_active: false },
      ],
      count: 2,
    });
  });

  it('is success:true with an empty registry — nothing registered is not an error', async () => {
    (listAreaCodes as jest.Mock).mockResolvedValue([]);
    expect((await dncAreaCodesListView()).json).toEqual({
      success: true,
      area_codes: [],
      count: 0,
    });
  });
});

describe('dncAreaCodesUpsertView', () => {
  it('upserts the validated codes with the SAN details', async () => {
    (upsertAreaCodes as jest.Mock).mockResolvedValue({
      saved: ['303', '770'],
      invalid: [],
    });
    const res = await dncAreaCodesUpsertView(
      req({
        area_codes: '303, 770',
        san_id: 'SAN-1',
        org_id: 'ORG-9',
        san_expiry_date: '2026-12-31',
      })
    );
    expect(upsertAreaCodes).toHaveBeenCalledWith(
      ['303', '770'],
      'SAN-1',
      'ORG-9',
      '2026-12-31'
    );
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      success: true,
      saved: ['303', '770'],
      invalid: [],
    });
  });

  it('reports invalid tokens with a 200, having saved the rest', async () => {
    (upsertAreaCodes as jest.Mock).mockResolvedValue({
      saved: ['303'],
      invalid: [],
    });
    const res = await dncAreaCodesUpsertView(req({ area_codes: '303, 1' }));
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      success: true,
      saved: ['303'],
      // From the serializer, not the service — these tokens never reached Firestore.
      invalid: ['1'],
    });
  });

  it('reports success:false when the WRITE saved nothing', async () => {
    // `success` tracks what was saved, not whether the request parsed. A false here means the batch
    // write itself did nothing, which is a Firestore problem rather than a caller problem.
    (upsertAreaCodes as jest.Mock).mockResolvedValue({
      saved: [],
      invalid: [],
    });
    const res = await dncAreaCodesUpsertView(req({ area_code: '303' }));
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ success: false, saved: [] });
  });

  it('400s a body with no valid code, without writing', async () => {
    const res = await dncAreaCodesUpsertView(req({ area_codes: '1, 2' }));
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ success: false });
    expect((res.json as { errors: unknown }).errors).toBeDefined();
    expect(upsertAreaCodes).not.toHaveBeenCalled();
  });

  it('400s a bad expiry, without writing', async () => {
    const res = await dncAreaCodesUpsertView(
      req({ area_codes: ['303'], san_expiry_date: 'soon' })
    );
    expect(res.status).toBe(400);
    expect(upsertAreaCodes).not.toHaveBeenCalled();
  });
});

describe('dncAreaCodeDeleteView', () => {
  it('deletes a registered code', async () => {
    (deleteAreaCode as jest.Mock).mockResolvedValue(true);
    const res = await dncAreaCodeDeleteView(req({ area_code: '303' }));
    expect(deleteAreaCode).toHaveBeenCalledWith('303');
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      success: true,
      area_code: '303',
      deleted: true,
    });
  });

  it('accepts the code from the query string, for clients that cannot send a DELETE body', async () => {
    (deleteAreaCode as jest.Mock).mockResolvedValue(true);
    await dncAreaCodeDeleteView(req({}, { area_code: '770' }));
    expect(deleteAreaCode).toHaveBeenCalledWith('770');
  });

  it('lets the body win over the query string', async () => {
    (deleteAreaCode as jest.Mock).mockResolvedValue(true);
    await dncAreaCodeDeleteView(
      req({ area_code: '303' }, { area_code: '770' })
    );
    expect(deleteAreaCode).toHaveBeenCalledWith('303');
  });

  it('answers 400 — not 200 — when the code was not in the registry', async () => {
    // Unusual for a delete, and preserved: the caller asked to withdraw authorization for a code, and
    // "there was nothing to withdraw" means their model of the registry is wrong.
    (deleteAreaCode as jest.Mock).mockResolvedValue(false);
    const res = await dncAreaCodeDeleteView(req({ area_code: '303' }));
    expect(res.status).toBe(400);
    expect(res.json).toEqual({
      success: false,
      area_code: '303',
      deleted: false,
    });
  });

  it('400s a malformed code without touching Firestore', async () => {
    const res = await dncAreaCodeDeleteView(req({ area_code: '1' }));
    expect(res.status).toBe(400);
    expect(deleteAreaCode).not.toHaveBeenCalled();
  });

  it('400s with no code anywhere', async () => {
    const res = await dncAreaCodeDeleteView(req());
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({
      success: false,
      errors: { area_code: ['This field is required.'] },
    });
  });
});
