import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseTable, isDiscreteValues, serializeTable } from '../src/core/io';
import { fit, predict, type LearnerSpec } from '../src/ml/models';
import { crossValidate, scoreResults, aucBinary, mcc } from '../src/ml/evaluate';
import { kmeans, pca, computeDistances, hierarchical, cutTopN } from '../src/ml/unsupervised';
import { encode, fitEncoder } from '../src/ml/encode';

const load = (n: string) => parseTable(readFileSync(`static/datasets/${n}.tab`, 'utf8'), n).table;

describe('io', () => {
  it('parses Orange .tab headers', () => {
    const iris = load('iris');
    expect(iris.nRows).toBe(150);
    expect(iris.attributes.length).toBe(4);
    expect(iris.classVar?.variable.values).toEqual(['Iris-setosa', 'Iris-versicolor', 'Iris-virginica']);
    const zoo = load('zoo');
    expect(zoo.metas[0].variable.kind).toBe('string');
    expect(zoo.classVar?.variable.name).toBe('type');
    const heart = load('heart_disease');
    expect(heart.attributes.find((c) => c.variable.name === 'rest ECG')!.variable.values).toEqual(['normal', 'left vent hypertrophy', 'ST-T abnormal']);
  });
  it('guesses types like Orange', () => {
    expect(isDiscreteValues(['0', '1', '1', '0'])).toBeTruthy();
    expect(isDiscreteValues(['1', '2', '3', '1'])).toBe(false);
    const t = parseTable('a,b,c\n1,x,hello\n2,y,world\n3,x,foo\n4,y,bar\n', 'csv').table;
    expect(t.attributes.map((c) => c.variable.kind)).toEqual(['continuous', 'discrete']);
    expect(t.metas[0].variable.kind).toBe('string');
  });
  it('round-trips .tab', () => {
    const iris = load('iris');
    const back = parseTable(serializeTable(iris, 'tab'), 'x').table;
    expect(back.nRows).toBe(150);
    expect(back.classVar?.variable.name).toBe('iris');
  });
});

const L = (type: LearnerSpec['type'], params: Record<string, unknown> = {}): LearnerSpec => ({ type, name: type, params });
const treeParams = { limitMinLeaf: true, minLeaf: 2, limitMinInternal: true, minInternal: 5, limitDepth: true, maxDepth: 100, limitMajority: true, sufficientMajority: 95 };

describe('learners on iris (5-fold CV)', () => {
  const iris = load('iris');
  const learners = [L('constant'), L('knn', { nNeighbors: 5 }), L('tree', treeParams), L('forest', { nEstimators: 10, useRandomState: true, minSamplesSplit: 5, useMinSamplesSplit: true }), L('logreg', { C: 1, penalty: 'l2' }), L('naivebayes')];
  const r = crossValidate(iris, learners, { method: 'cv', folds: 5, stratified: true });
  it('scores are sensible', () => {
    const ca = learners.map((_, i) => scoreResults(r, i).CA);
    expect(r.errors.every((e) => e === null)).toBe(true);
    expect(ca[0]).toBeCloseTo(1 / 3, 2);
    for (const v of ca.slice(1)) expect(v).toBeGreaterThan(0.85);
    expect(scoreResults(r, 1).AUC).toBeGreaterThan(0.95);
  });
});

describe('regression on housing', () => {
  const h = load('housing');
  it('linear regression R2 ~ 0.74 on train', () => {
    const m = fit(L('linreg', { reg: 'ols' }), h);
    const p = predict(m, h);
    const y = h.classVar!.data as Float64Array;
    let se = 0, st = 0; const ym = y.reduce((a, b) => a + b) / y.length;
    for (let i = 0; i < y.length; i++) { se += (y[i] - p.values[i]) ** 2; st += (y[i] - ym) ** 2; }
    expect(1 - se / st).toBeCloseTo(0.7406, 3);
  });
  it('lasso and tree run', () => {
    const r = crossValidate(h, [L('linreg', { reg: 'lasso', alpha: 0.1 }), L('tree', treeParams), L('knn', { nNeighbors: 5 })], { method: 'cv', folds: 5, stratified: false });
    expect(scoreResults(r, 0).R2).toBeGreaterThan(0.6);
    expect(scoreResults(r, 1).R2).toBeGreaterThan(0.6);
  });
});

describe('metrics', () => {
  it('auc', () => { expect(aucBinary([0.1, 0.4, 0.35, 0.8], [false, false, true, true])).toBeCloseTo(0.75); });
  it('mcc', () => { expect(mcc([[5, 0], [0, 5]])).toBe(1); });
});

describe('unsupervised', () => {
  const iris = load('iris');
  it('kmeans finds 3 clusters', () => {
    const m = encode(fitEncoder(iris, true), iris);
    const r = kmeans(m, 3);
    expect(new Set(r.labels).size).toBe(3);
  });
  it('pca variance', () => {
    const { result } = pca(iris, true);
    expect(result.ratio[0]).toBeGreaterThan(0.72); expect(result.ratio[0]).toBeLessThan(0.74);
  });
  it('hierarchical', () => {
    const m = encode(fitEncoder(iris, true), iris);
    const dm = computeDistances(m, 'euclidean', []);
    const Z = hierarchical(dm, 'ward');
    expect(Z.length).toBe(149);
    expect(Z[148][3]).toBe(150);
    const lab = cutTopN(Z, 150, 3);
    expect(new Set(lab).size).toBe(3);
  });
});

import { tTestP, fTestP, chi2P } from '../src/core/stats';
describe('distributions', () => {
  it('p-values match scipy', () => {
    expect(tTestP(2.0, 10)).toBeCloseTo(0.07339, 4);
    expect(fTestP(3.5, 2, 20)).toBeCloseTo(0.04975, 4);
    expect(chi2P(5.99, 2)).toBeCloseTo(0.05003, 4);
  });
});
