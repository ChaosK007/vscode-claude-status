import * as assert from 'assert';
import { formatDuration } from '../../webview/formatDuration';

// English i18n strings matching the runtime bundle
const EN = {
  unitM:  '__N__m',
  unitH:  '__N__h',
  unitHM: '__N__h __N2__m',
  unitD:  '__N__d',
  unitDH: '__N__d __N2__h',
};

suite('formatDuration', () => {

  // --- minutes branch ---

  test('fmt(0) returns "0m"', () => {
    assert.strictEqual(formatDuration(0, EN), '0m');
  });

  test('fmt(59) rounds up to "1m" (59/60 rounds to 1)', () => {
    assert.strictEqual(formatDuration(59, EN), '1m');
  });

  test('fmt(3599) promotes to "1h" — minutes branch rollover when round yields 60', () => {
    // Math.round(3599/60) === 60 — must not render "60m"
    assert.strictEqual(formatDuration(3599, EN), '1h');
  });

  // --- hours branch ---

  test('fmt(3600) returns "1h" (exact hour)', () => {
    assert.strictEqual(formatDuration(3600, EN), '1h');
  });

  test('fmt(7170) returns "2h" — the screenshot case (1h 60m rollover)', () => {
    // 7170 = 1h 59m 30s: Math.round(1770/60) = 60 → must normalise to 2h 0m → "2h"
    assert.strictEqual(formatDuration(7170, EN), '2h');
  });

  test('fmt(7200) returns "2h" (exact two hours)', () => {
    assert.strictEqual(formatDuration(7200, EN), '2h');
  });

  test('fmt(9000) returns "2h 30m" (no rollover needed)', () => {
    // 9000 = 2h 30m exactly
    assert.strictEqual(formatDuration(9000, EN), '2h 30m');
  });

  // --- hours/days boundary ---

  test('fmt(86370) returns "1d" — 23h 59m 30s rounds up to 24h, then promotes to 1d', () => {
    // Math.round(86370/3600) would be 24 in the days branch — must normalise to 1d 0h → "1d"
    // But 86370 < 86400 so it's in the hours branch:
    //   h = Math.floor(86370/3600) = 23
    //   m = Math.round((86370 % 3600) / 60) = Math.round(3570/60) = Math.round(59.5) = 60
    //   → m===60: m=0, h=24 → h===24: promote to days → "1d"
    assert.strictEqual(formatDuration(86370, EN), '1d');
  });

  test('fmt(86400) returns "1d" (exact day)', () => {
    assert.strictEqual(formatDuration(86400, EN), '1d');
  });

  test('fmt(90000) returns "1d 1h" (no rollover)', () => {
    // 90000 = 86400 + 3600 → 1d 1h
    assert.strictEqual(formatDuration(90000, EN), '1d 1h');
  });

  // --- days branch rollover ---

  test('fmt(172770) returns "2d" — 1d 23h 59m 30s rolls h=24 to 2d 0h', () => {
    // 172770 = 86400 + 86370
    // d = Math.floor(172770/86400) = 1
    // h = Math.round((172770 % 86400)/3600) = Math.round(86370/3600) = Math.round(23.99) = 24
    // → h===24: h=0, d=2 → "2d"
    assert.strictEqual(formatDuration(172770, EN), '2d');
  });

  test('fmt(90060) returns "1d 1h" — no false rollover on clean values', () => {
    // 90060 = 86400 + 3660 = 1d 1h 1m (h=Math.round(3660/3600)=1)
    assert.strictEqual(formatDuration(90060, EN), '1d 1h');
  });

});
