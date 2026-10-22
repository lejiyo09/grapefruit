import type { ExecContext, ExecResult } from '../engine/types';
import { type Table, isTable } from '../core/table';

export function waiting(ctx: ExecContext, msg = '입력 데이터를 연결하세요.'): ExecResult {
  ctx.info(msg);
  return { outputs: {}, view: null };
}

export function tableInput(v: unknown): Table | null {
  return isTable(v) ? v : null;
}

/** 큰 데이터에서 동작을 제한할 때 쓰는 기본 정책(저사양 크롬북 기준) */
export const LIMITS = {
  /** 산점도에 그릴 최대 점 수(초과 시 표본 추출) */
  scatterPoints: 20000,
  /** 실루엣 계산 최대 행 수 (Orange도 5000행 제한) */
  silhouette: 5000,
  /** 거리 행렬 경고/차단 기준 (바이트) */
  distanceWarnBytes: 64 * 1024 * 1024,
  distanceMaxBytes: 256 * 1024 * 1024,
  /** 히트맵에서 군집 정렬을 허용하는 최대 행 수 */
  heatmapCluster: 1000,
};
