/** 예제 워크플로 */
import type { ProjectFile } from '../engine/types';

const P = (title: string, nodes: ProjectFile['nodes'], edges: Array<[string, string, string, string]>): ProjectFile => ({
  schemaVersion: 1, app: 'grapefruit', title, nodes,
  edges: edges.map(([a, ap, b, bp], i) => ({ id: `e${i}`, from: { node: a, port: ap }, to: { node: b, port: bp } })),
});

export const EXAMPLES: Array<{ id: string; title: string; description: string; project: ProjectFile }> = [
  {
    id: 'basic', title: '데이터 살펴보기', description: 'File → Data Table, Scatter Plot, Distributions',
    project: P('데이터 살펴보기', [
      { id: 'file', type: 'data.file', title: 'File', x: 140, y: 220, settings: { source: 'builtin', dataset: 'iris' } },
      { id: 'table', type: 'data.table', title: 'Data Table', x: 360, y: 100, settings: {} },
      { id: 'scatter', type: 'visualize.scatter', title: 'Scatter Plot', x: 360, y: 240, settings: { x: 'petal length', y: 'petal width' } },
      { id: 'dist', type: 'visualize.distributions', title: 'Distributions', x: 360, y: 380, settings: { variable: 'petal length' } },
      { id: 'table2', type: 'data.table', title: 'Selected Data', x: 580, y: 240, settings: {} },
    ], [['file', 'data', 'table', 'data'], ['file', 'data', 'scatter', 'data'], ['file', 'data', 'dist', 'data'], ['scatter', 'selected', 'table2', 'data']]),
  },
  {
    id: 'classification', title: '분류 모델 비교', description: 'Tree · kNN · Logistic Regression · Naive Bayes → Test and Score → Confusion Matrix, ROC',
    project: P('분류 모델 비교', [
      { id: 'file', type: 'data.file', title: 'File', x: 120, y: 260, settings: { source: 'builtin', dataset: 'heart_disease' } },
      { id: 'tree', type: 'model.tree', title: 'Tree', x: 340, y: 100, settings: {} },
      { id: 'knn', type: 'model.knn', title: 'kNN', x: 340, y: 210, settings: {} },
      { id: 'lr', type: 'model.logreg', title: 'Logistic Regression', x: 340, y: 320, settings: {} },
      { id: 'nb', type: 'model.naivebayes', title: 'Naive Bayes', x: 340, y: 430, settings: {} },
      { id: 'ts', type: 'evaluate.testandscore', title: 'Test and Score', x: 580, y: 260, settings: {} },
      { id: 'cm', type: 'evaluate.confusionmatrix', title: 'Confusion Matrix', x: 800, y: 190, settings: {} },
      { id: 'roc', type: 'evaluate.roc', title: 'ROC Analysis', x: 800, y: 330, settings: {} },
    ], [
      ['file', 'data', 'ts', 'data'], ['tree', 'learner', 'ts', 'learners'], ['knn', 'learner', 'ts', 'learners'],
      ['lr', 'learner', 'ts', 'learners'], ['nb', 'learner', 'ts', 'learners'], ['ts', 'results', 'cm', 'results'], ['ts', 'results', 'roc', 'results'],
    ]),
  },
  {
    id: 'tree', title: '의사결정나무 보기', description: 'File → Tree → Tree Viewer, Predictions',
    project: P('의사결정나무 보기', [
      { id: 'file', type: 'data.file', title: 'File', x: 120, y: 200, settings: { source: 'builtin', dataset: 'titanic' } },
      { id: 'tree', type: 'model.tree', title: 'Tree', x: 340, y: 120, settings: {} },
      { id: 'tv', type: 'visualize.treeviewer', title: 'Tree Viewer', x: 560, y: 120, settings: {} },
      { id: 'pred', type: 'evaluate.predictions', title: 'Predictions', x: 560, y: 280, settings: {} },
    ], [['file', 'data', 'tree', 'data'], ['tree', 'model', 'tv', 'tree'], ['tree', 'model', 'pred', 'predictors'], ['file', 'data', 'pred', 'data']]),
  },
  {
    id: 'regression', title: '회귀 분석', description: 'Housing → Linear Regression · Random Forest → Test and Score',
    project: P('회귀 분석', [
      { id: 'file', type: 'data.file', title: 'File', x: 120, y: 220, settings: { source: 'builtin', dataset: 'housing' } },
      { id: 'lin', type: 'model.linreg', title: 'Linear Regression', x: 340, y: 130, settings: {} },
      { id: 'rf', type: 'model.forest', title: 'Random Forest', x: 340, y: 310, settings: {} },
      { id: 'ts', type: 'evaluate.testandscore', title: 'Test and Score', x: 580, y: 220, settings: {} },
      { id: 'cor', type: 'visualize.correlations', title: 'Correlations', x: 340, y: 450, settings: {} },
    ], [['file', 'data', 'ts', 'data'], ['lin', 'learner', 'ts', 'learners'], ['rf', 'learner', 'ts', 'learners'], ['file', 'data', 'cor', 'data']]),
  },
  {
    id: 'clustering', title: '군집 분석', description: 'k-Means → Scatter Plot, PCA, Distances → Hierarchical Clustering',
    project: P('군집 분석', [
      { id: 'file', type: 'data.file', title: 'File', x: 120, y: 240, settings: { source: 'builtin', dataset: 'iris' } },
      { id: 'km', type: 'unsupervised.kmeans', title: 'k-Means', x: 340, y: 110, settings: {} },
      { id: 'sc', type: 'visualize.scatter', title: 'Scatter Plot', x: 560, y: 110, settings: { x: 'petal length', y: 'petal width', color: 'Cluster' } },
      { id: 'pca', type: 'unsupervised.pca', title: 'PCA', x: 340, y: 250, settings: {} },
      { id: 'sc2', type: 'visualize.scatter', title: 'Scatter Plot (PCA)', x: 560, y: 250, settings: { x: 'PC1', y: 'PC2' } },
      { id: 'dist', type: 'unsupervised.distances', title: 'Distances', x: 340, y: 390, settings: {} },
      { id: 'hc', type: 'unsupervised.hierarchical', title: 'Hierarchical Clustering', x: 560, y: 390, settings: { selectionMethod: 'topn', topN: 3 } },
    ], [['file', 'data', 'km', 'data'], ['km', 'data', 'sc', 'data'], ['file', 'data', 'pca', 'data'], ['pca', 'transformed', 'sc2', 'data'], ['file', 'data', 'dist', 'data'], ['dist', 'distances', 'hc', 'distances']]),
  },
];
