import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseTable } from '../src/core/io';
import { crossValidate, scoreResults } from '../src/ml/evaluate';
import { parseHidden } from '../src/ml/mlp';

const load = (n: string) => parseTable(readFileSync(`static/datasets/${n}.tab`, 'utf8'), n).table;
const nn = (params: Record<string, unknown> = {}) => ({ type: 'mlp' as const, name: 'Neural Network', params: { hidden: '100,', activation: 'relu', solver: 'adam', alpha: 0.0001, maxIter: 200, replicable: true, ...params } });

describe('Neural Network (sklearn MLP 방식)', () => {
  it('parses hidden layer text like Orange', () => {
    expect(parseHidden('100,')).toEqual([100]);
    expect(parseHidden('64, 32')).toEqual([64, 32]);
  });
  it('classifies iris well (adam, relu)', () => {
    const r = crossValidate(load('iris'), [nn()], { method: 'cv', folds: 5, stratified: true });
    expect(r.errors[0]).toBeNull();
    expect(scoreResults(r, 0).CA).toBeGreaterThan(0.93);
  });
  it('other solvers and activations run', () => {
    const r = crossValidate(load('iris'), [nn({ solver: 'lbfgs', activation: 'tanh' }), nn({ solver: 'sgd', activation: 'logistic', maxIter: 300 })], { method: 'cv', folds: 3, stratified: true });
    expect(scoreResults(r, 0).CA).toBeGreaterThan(0.9);
    expect(r.errors[1]).toBeNull();
  });
  it('regression on housing', () => {
    const r = crossValidate(load('housing'), [nn({ maxIter: 300 })], { method: 'cv', folds: 3, stratified: false });
    expect(scoreResults(r, 0).R2).toBeGreaterThan(0.6);
  });
});
