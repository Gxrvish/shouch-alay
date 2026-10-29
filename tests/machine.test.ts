import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertCompanyAccount, NotCompanyAccount } from '@/lib/auth';
import { canTransition, STATUSES } from '@/lib/queue';

// The state machine from the spec, written out independently of TRANSITIONS.
const SPEC = new Set([
  'NEW>WAITING',
  'NEW>ACTIVE',
  'WAITING>NOTIFIED',
  'WAITING>CANCELLED',
  'NOTIFIED>ACTIVE',
  'NOTIFIED>EXPIRED',
  'NOTIFIED>CANCELLED',
  'ACTIVE>DONE',
  'ACTIVE>AUTO_RELEASED',
]);

test('allows exactly the specified transitions and rejects every other pair', () => {
  for (const from of ['NEW', ...STATUSES] as const) {
    for (const to of STATUSES) {
      assert.equal(canTransition(from, to), SPEC.has(`${from}>${to}`), `${from} -> ${to}`);
    }
  }
});

test('accepts only verified odoo.com Google Workspace accounts', () => {
  const valid = { email: 'Ada@odoo.com', email_verified: true, hd: 'odoo.com' };
  assert.equal(assertCompanyAccount(valid), 'ada@odoo.com');

  const invalid = [
    { ...valid, email_verified: false },
    { ...valid, email_verified: 'true' }, // must be a real boolean
    { ...valid, hd: undefined }, // personal Gmail accounts carry no hd claim
    { ...valid, hd: 'example.com' },
    { ...valid, email: 'ada@example.com' },
    { ...valid, email: 'ada@odoo.com.example.com' },
    { ...valid, email: 'ada@sub.odoo.com' },
    { ...valid, email: undefined },
  ];
  for (const claims of invalid) assert.throws(() => assertCompanyAccount(claims), NotCompanyAccount, JSON.stringify(claims));
});
