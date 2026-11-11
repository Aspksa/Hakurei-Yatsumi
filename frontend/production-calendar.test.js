import test from 'node:test';
import assert from 'node:assert/strict';
import { dayInfo, monthStats, yearStats, nextHoliday, monthNotes } from './public/production-calendar.js';

test('2026 totals match the official calendar (247 working / 118 off / 1972 h)', () => {
  assert.deepEqual(yearStats(2026), { work: 247, off: 118, short: 4, hours: 1972, total: 365 });
  assert.equal(monthStats(2026, 0).work, 15);
});
test('2027 totals match the official calendar (247 working / 118 off / 1972 h)', () => {
  assert.deepEqual(yearStats(2027), { work: 247, off: 118, short: 4, hours: 1972, total: 365 });
  assert.deepEqual([monthStats(2027, 0).work, monthStats(2027, 0).hours], [15, 120]);
  assert.deepEqual([monthStats(2027, 1).work, monthStats(2027, 1).hours], [19, 151]);
  const quarter = months => months.reduce((sum, m) => sum + monthStats(2027, m).hours, 0);
  assert.equal(quarter([0, 1, 2]), 447);
  assert.equal(quarter([3, 4, 5]), 494);
});
test('transfers and working Saturdays', () => {
  assert.equal(dayInfo('2026-01-09').kind, 'transfer');
  assert.equal(dayInfo('2026-12-31').off, true);
  assert.equal(dayInfo('2026-03-09').off, true);
  assert.equal(dayInfo('2027-02-20').kind, 'extra-work');
  assert.equal(dayInfo('2027-02-20').off, false);
  assert.equal(dayInfo('2027-02-20').short, true);
  assert.equal(dayInfo('2027-11-05').off, true);
  assert.equal(dayInfo('2026-11-03').short, true);
  assert.equal(dayInfo('2026-05-08').short, true);
});
test('holidays, weekends and years without data', () => {
  assert.equal(dayInfo('2026-11-04').name, 'День народного единства');
  assert.equal(dayInfo('2026-11-07').kind, 'weekend');
  assert.equal(dayInfo('2026-11-09').kind, 'work');
  const later = dayInfo('2028-05-02');
  assert.equal(later.known, false);
  assert.equal(monthStats(2028, 4), null);
});
test('next holiday and month notes', () => {
  assert.deepEqual(nextHoliday('2026-11-11'), { key: '2026-12-31', days: 50, name: 'Перенос выходного с воскресенья 4 января', kind: 'transfer' });
  assert.equal(nextHoliday('2026-11-04').days, 0);
  const jan = monthNotes(2026, 0);
  assert.equal(jan[0].to, 6, 'January holidays are grouped');
});
