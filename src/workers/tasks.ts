/**
 * Worker에서 실행되는 계산 작업 목록. 메인 스레드 폴백에서도 같은 함수를 사용한다.
 */
import type { Table } from '../core/table';
import { parseTable, type ColumnSpec } from '../core/io';
import { fit, predict, type LearnerSpec, type Model } from '../ml/models';
import { crossValidate, type Sampling } from '../ml/evaluate';
import { encode, fitEncoder } from '../ml/encode';
import { kmeans, silhouette, pca, computeDistances, hierarchical, type Metric, type Linkage, type DistMatrix } from '../ml/unsupervised';

export type Progress = (p: number) => void;
type Signal = { aborted: boolean };

export const TASKS: Record<string, (payload: any, progress: Progress, signal: Signal) => unknown> = {
  parse: (p: { text: string; name: string; overrides?: Record<string, Partial<ColumnSpec>> }) => parseTable(p.text, p.name, p.overrides),
  fit: (p: { learner: LearnerSpec; data: Table }, _pr, signal) => fit(p.learner, p.data, { signal }),
  predict: (p: { model: Model; data: Table }) => predict(p.model, p.data),
  crossValidate: (p: { data: Table; learners: LearnerSpec[]; sampling: Sampling; testData?: Table | null }, progress, signal) =>
    crossValidate(p.data, p.learners, p.sampling, p.testData, progress, signal),
  kmeans: (p: { data: Table; k: number | [number, number]; normalize: boolean; nInit: number; maxIter: number; init: 'kmeans++' | 'random'; silhouetteLimit: number }, progress, signal) => {
    const m = encode(fitEncoder(p.data, p.normalize), p.data);
    if (!m.p) throw new Error('군집화할 수 있는 변수가 없습니다.');
    const kr = p.k;
    const ks = Array.isArray(kr) ? Array.from({ length: kr[1] - kr[0] + 1 }, (_, i) => kr[0] + i) : [kr];
    const runs = ks.map((k, i) => {
      const r = kmeans(m, k, { nInit: p.nInit, maxIter: p.maxIter, init: p.init, signal });
      const sil = m.n <= p.silhouetteLimit ? silhouette(m, r.labels, k) : null;
      progress((i + 1) / ks.length);
      return { k, labels: r.labels, inertia: r.inertia, silhouette: sil, meanSilhouette: sil ? sil.reduce((a, b) => a + b, 0) / sil.length : NaN };
    });
    return { runs };
  },
  pca: (p: { data: Table; normalize: boolean }) => {
    const { result, scores, n } = pca(p.data, p.normalize);
    return { result, scores, n };
  },
  distances: (p: { data: Table; metric: Metric; normalize: boolean; labels: string[] }, _pr, signal): DistMatrix => {
    const m = encode(fitEncoder(p.data, p.normalize), p.data);
    return computeDistances(m, p.metric, p.labels, signal);
  },
  hierarchical: (p: { dm: DistMatrix; linkage: Linkage }, _pr, signal) => hierarchical(p.dm, p.linkage, signal),
};
