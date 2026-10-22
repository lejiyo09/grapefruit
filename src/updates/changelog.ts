/**
 * 업데이트 소식 데이터. 새 버전을 배포할 때 package.json의 version을 올리고 맨 앞에 항목을 추가한다.
 * 앱은 사용자가 마지막으로 본 버전보다 새 항목이 있으면 배지와 "새 소식" 창을 띄운다.
 */
export interface ChangelogEntry {
  version: string;
  date: string;
  title: string;
  summary: string;
  added?: string[];
  improved?: string[];
  fixed?: string[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    version: '0.1.2',
    date: '2026-10-22',
    title: '구글 스프레드시트 불러오기',
    summary: 'File 위젯의 URL에 구글 스프레드시트 링크를 그대로 붙여 넣으면 시트의 표를 데이터로 불러옵니다.',
    added: [
      '구글 시트 링크(…/edit, #gid=탭, 웹에 게시한 …/pubhtml)를 CSV 주소로 자동 변환',
    ],
    fixed: [
      'URL이 웹페이지(HTML)를 가리킬 때 HTML 코드가 데이터로 읽히던 문제 → 안내 메시지 표시',
      '외부 URL 데이터가 메모리에 캐시되어, 원본을 고친 뒤 다시 실행해도 예전 값이 나오던 문제',
    ],
  },
  {
    version: '0.1.1',
    date: '2026-10-22',
    title: '앱으로 설치하기 (PWA)',
    summary: '크롬북과 PC에 Grapefruit를 앱으로 설치할 수 있습니다. 설치하면 런처에서 별도 창으로 열리고 인터넷 없이도 동작합니다.',
    added: [
      '상단의 [앱 설치] 버튼 (브라우저 주소창의 설치 아이콘으로도 설치 가능)',
      '설치한 앱을 CSV · TSV · .tab 파일의 "연결 프로그램"으로 선택하면 File → Data Table로 바로 열기',
      '설치 직후부터 기본 데이터셋 5종을 오프라인에서 사용 가능',
    ],
    improved: [
      '크롬북 런처·작업 표시줄용 고해상도 아이콘(192/512px, 마스크형)',
      'Render Static Site / Web Service 어느 방식으로 배포해도 동작',
    ],
  },
  {
    version: '0.1.0',
    date: '2026-10-22',
    title: 'Grapefruit 첫 공개',
    summary: 'Orange Data Mining처럼 위젯을 연결해 데이터를 분석하는 브라우저 앱의 첫 버전입니다. 설치 없이 크롬북에서 바로 실행되고, 모든 계산은 내 브라우저 안에서 이루어집니다.',
    added: [
      '워크플로 캔버스: 위젯 추가·이동·연결·삭제, 자동 채널 선택, 순환 연결 방지, 확대/축소',
      '실행 엔진: 바뀐 위젯과 하위 위젯만 다시 계산, 계산 취소, 위젯별 오류 격리',
      'Data: File(CSV/TSV/.tab, URL), Datasets, Data Table, Data Info, Feature Statistics, Save Data',
      'Transform: Select Columns, Select Rows, Data Sampler, Impute, Continuize, Discretize, Unique, Randomize, Transpose, Concatenate, Merge Data',
      'Visualize: Scatter Plot(영역 선택), Distributions, Box Plot(t-검정/ANOVA/χ²), Correlations, Heat Map, Tree Viewer',
      'Model: Constant, kNN, Tree, Random Forest, Logistic Regression, Linear Regression, Naive Bayes',
      'Evaluate: Test and Score, Predictions, Confusion Matrix, ROC Analysis',
      'Unsupervised: k-Means, PCA, Distances, Distance Matrix, Hierarchical Clustering',
      '프로젝트 저장/불러오기(.json), 브라우저 자동 저장, 예제 워크플로',
      '업데이트 센터: 새 소식, 로드맵, 새 버전 배포 알림',
    ],
    improved: [
      '저사양 기기 보호: 계산은 Web Worker 1개에서 순차 실행, 표는 가상 스크롤, 큰 산점도는 표본 추출, 거리 행렬은 메모리 사전 계산',
      '오프라인 동작: 한 번 열면 서비스 워커가 앱과 기본 데이터셋을 캐시',
    ],
  },
];

export type RoadmapStatus = 'next' | 'planned' | 'later';

export interface RoadmapItem { title: string; detail: string; status: RoadmapStatus }

export const ROADMAP: RoadmapItem[] = [
  { title: 'Formula · Create Class · Pivot Table', detail: '수식으로 새 열 만들기, 문자열 패턴으로 클래스 만들기, 피벗 표', status: 'next' },
  { title: 'SVM · Gradient Boosting · Neural Network', detail: '추가 학습기와 Performance Curve, Calibration Plot', status: 'next' },
  { title: 'MDS · t-SNE · Silhouette Plot · DBSCAN', detail: '샘플링 우선 정책을 적용한 고비용 비지도 학습 위젯', status: 'planned' },
  { title: 'Line Plot · Bar Plot · Mosaic Display · Violin Plot · Linear Projection', detail: '추가 시각화 위젯', status: 'planned' },
  { title: '.ows 가져오기', detail: 'Orange 워크플로 파일(.ows)을 Grapefruit 프로젝트로 변환', status: 'planned' },
  { title: 'DuckDB-Wasm (선택형)', detail: 'SQL Table · Parquet 지원. 필요할 때만 내려받는 선택형 엔진', status: 'later' },
  { title: 'Text · Time Series · Image Analytics 애드온', detail: 'Word Cloud, Bag of Words, Topic Modelling, 시계열 등 확장 위젯', status: 'later' },
];
