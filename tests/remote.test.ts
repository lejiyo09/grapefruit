import { describe, it, expect } from 'vitest';
import { googleSheetCsvUrls, looksLikeHtml } from '../src/core/remote';

describe('google sheets url', () => {
  const id = '1QfDr38bN_lAHCcPhSB74UQWBB2YdY6BFFTuR-GFbFUY';
  it('converts edit links', () => {
    expect(googleSheetCsvUrls(`https://docs.google.com/spreadsheets/d/${id}/edit`)).toEqual([
      `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv`,
      `https://docs.google.com/spreadsheets/d/${id}/export?format=csv`,
    ]);
  });
  it('keeps the sheet tab (gid)', () => {
    expect(googleSheetCsvUrls(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=12345`)![0]).toContain('&gid=12345');
    expect(googleSheetCsvUrls(`https://docs.google.com/spreadsheets/d/${id}/edit?usp=sharing&gid=7`)![1]).toContain('&gid=7');
  });
  it('handles published sheets and ignores other urls', () => {
    expect(googleSheetCsvUrls('https://docs.google.com/spreadsheets/d/e/2PACX-abc/pubhtml')).toEqual(['https://docs.google.com/spreadsheets/d/e/2PACX-abc/pub?output=csv']);
    expect(googleSheetCsvUrls('https://example.com/data.csv')).toBeNull();
    expect(googleSheetCsvUrls('not a url')).toBeNull();
  });
  it('detects html pages', () => {
    expect(looksLikeHtml('<!DOCTYPE html><html lang="ko"><head>')).toBe(true);
    expect(looksLikeHtml('a,b\n1,2\n')).toBe(false);
  });
});
