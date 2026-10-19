import { describe, expect, it } from 'vitest';
import { auditDiff } from './audit.ts';

describe('auditDiff', () => {
  const at = new Date('2026-10-20T00:00:00Z');

  it('lists every field on creation, except ids and timestamps', () => {
    expect(auditDiff(null, { id: 'x', name: 'A', createdAt: at, updatedAt: at })).toEqual({
      name: { from: null, to: 'A' },
    });
  });

  it('keeps only changed fields on update, comparing json values', () => {
    const before = { name: 'A', settings: { crossfade: 2 }, tz: 'Europe/Paris' };
    const after = { name: 'B', settings: { crossfade: 2 }, tz: 'Europe/Paris' };
    expect(auditDiff(before, after)).toEqual({ name: { from: 'A', to: 'B' } });
  });

  it('lists every field on deletion and drops omitted secrets', () => {
    expect(auditDiff({ name: 'k', keyHash: 'secret' }, null, ['keyHash'])).toEqual({
      name: { from: 'k', to: null },
    });
  });
});
