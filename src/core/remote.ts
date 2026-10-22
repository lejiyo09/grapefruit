/**
 * URL로 데이터 불러오기 도우미.
 * 구글 스프레드시트 주소(…/edit, …/view, …/pubhtml)는 웹페이지(HTML)라서 그대로 받으면 표가 아니다.
 * 같은 시트를 CSV로 내려주는 주소로 바꿔서 받는다.
 */

/** 구글 시트 주소면 CSV를 받을 수 있는 후보 주소들(우선순위 순), 아니면 null */
export function googleSheetCsvUrls(input: string): string[] | null {
  let u: URL;
  try { u = new URL(input.trim()); } catch { return null; }
  if (u.hostname !== 'docs.google.com') return null;
  // 웹에 게시된 시트: /spreadsheets/d/e/<pubId>/pubhtml
  const pub = /^\/spreadsheets\/d\/e\/([\w-]+)/.exec(u.pathname);
  const gid = u.searchParams.get('gid') ?? /(?:^|[#&])gid=(\d+)/.exec(u.hash)?.[1] ?? null;
  if (pub) {
    const q = `output=csv${gid ? `&gid=${gid}` : ''}`;
    return [`https://docs.google.com/spreadsheets/d/e/${pub[1]}/pub?${q}`];
  }
  const m = /^\/spreadsheets\/d\/([\w-]+)/.exec(u.pathname);
  if (!m) return null;
  const id = m[1];
  const g = gid ? `&gid=${gid}` : '';
  return [
    `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv${g}`,
    `https://docs.google.com/spreadsheets/d/${id}/export?format=csv${g}`,
  ];
}

/** 받은 내용이 데이터가 아니라 웹페이지(HTML)인지 */
export function looksLikeHtml(text: string): boolean {
  const head = text.slice(0, 600).trimStart().toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html') || /^<\?xml[^>]*>\s*<html/.test(head) || (head.startsWith('<') && head.includes('<head'));
}

export const NOT_DATA_MESSAGE =
  '받은 내용이 표 데이터가 아니라 웹페이지(HTML)입니다. CSV/TSV 파일로 바로 연결되는 주소를 넣어 주세요.';

export const SHEET_ACCESS_MESSAGE =
  '구글 시트를 불러오지 못했습니다. 시트의 [공유] → 일반 액세스를 "링크가 있는 모든 사용자(뷰어)"로 바꾸거나, ' +
  '[파일] → [공유] → [웹에 게시]에서 CSV로 게시한 뒤 그 주소를 넣어 주세요.';
