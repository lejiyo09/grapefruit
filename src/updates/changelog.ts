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
    version: '0.3.1',
    date: '2026-10-26',
    title: '서버 임베더 지원 (Inception v3 등)',
    summary: 'Image Embedding에서 Inception v3, VGG-16, VGG-19, Painters, DeepLoc, openface를 쓸 수 있습니다. Orange와 같은 임베딩 서버로 이미지를 보내 계산하며, 보내기 전에 동의를 받습니다.',
    added: [
      'Orange 임베딩 서버(api.garaza.io)와 같은 방식으로 요청: 모델 입력 크기(299·256·224·64px)로 LANCZOS 축소한 JPEG',
      'Image Embedding 기본 임베더를 Orange처럼 Inception v3(2048개 특징)로',
      '이미지 전송 동의 체크, 다른 서버 주소 지정(고급)',
      '연결 순서: 지정한 서버 → 이 앱 주소의 /embed-api/ 프록시 → Orange 서버 직접',
    ],
    improved: [
      'Import Images가 서버 임베더용 크기의 이미지도 함께 저장(이전 버전에서 불러온 폴더는 다시 선택 필요)',
      '서버 임베딩 결과도 이미지별로 캐시',
    ],
  },
  {
    version: '0.3.0',
    date: '2026-10-26',
    title: '이미지 분류 · Neural Network',
    summary: 'Orange의 이미지 분류 수업 흐름(Import Images → Image Embedding → Neural Network → Test and Score · Confusion Matrix · Predictions → Image Viewer)을 그대로 할 수 있습니다. [애드온]에서 Image Analytics를 설치하고, [예제 ▾] → "이미지 분류"로 시작하세요.',
    added: [
      'Neural Network 위젯: 은닉층 뉴런 수, 활성화 함수(Identity·Logistic·tanh·ReLu), Solver(L-BFGS-B·SGD·Adam), 정규화 α, 최대 반복 — Orange 기본값과 같음',
      'Image Analytics 애드온: Import Images(폴더째 불러오기, 하위 폴더 = 분류), Image Viewer, Image Embedding',
      'Image Embedding의 SqueezeNet: Orange 로컬 SqueezeNet과 같은 모델·가중치·전처리로 이 기기에서 1000개 특징(n0~n999) 계산, 한 번 계산한 이미지는 저장해 재사용',
      'Predictions: Selected Predictions 출력(표에서 행 선택), Orange처럼 "확률 : … → 예측 클래스"와 error 열 표시',
      '예제: 이미지 분류 모델(수업 자료와 같은 배치)',
    ],
    improved: [
      'Test and Score · Predictions 점수를 Orange처럼 소수 셋째 자리로 표시',
      '표 열 너비를 내용 길이에 맞춤',
      '저장소: 큰 데이터(이미지)를 메모리에 중복 보관하지 않도록 개선',
    ],
  },
  {
    version: '0.2.0',
    date: '2026-10-22',
    title: '애드온 · Geo 애드온',
    summary: 'Orange처럼 필요한 위젯 묶음을 골라 내려받아 쓰는 애드온 기능이 생겼습니다. 첫 애드온은 지도 분석을 위한 Geo입니다. 상단의 [애드온] 버튼에서 설치하세요.',
    added: [
      '애드온 관리자: 설치·제거, 설치한 애드온은 이 브라우저에 저장되어 오프라인에서도 사용',
      'Geo Map: 위도·경도 데이터를 지도에 점으로 표시, 영역 선택 → Selected Data',
      'Choropleth Map: 국가·시·도·시·군·구별로 값을 집계(행 수, 합계, 평균, 중앙값, 최빈값 등)해 색칠',
      'Geocoding: 지역 이름 ↔ 위도·경도 변환, 찾지 못한 이름은 직접 지정',
      '배경 지도: OpenStreetMap, 흑백, 다크, 지형도, 오프라인 경계선',
      '애드온 위젯이 들어 있는 프로젝트를 열면 설치 안내',
    ],
    improved: [
      '그래프 크기가 위젯 창 안쪽 여백을 고려하도록 수정(오른쪽이 잘리던 문제)',
    ],
  },
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
  { title: 'SVM · Gradient Boosting', detail: '추가 학습기와 Performance Curve, Calibration Plot', status: 'next' },
  { title: '신경망 놀이터', detail: 'TensorFlow Playground처럼 2차원 데이터로 은닉층·활성화 함수에 따른 결정 경계를 바로 보기', status: 'planned' },
  { title: 'Image Grid · Save Images', detail: 'Image Analytics 추가 위젯', status: 'planned' },
  { title: 'MDS · t-SNE · Silhouette Plot · DBSCAN', detail: '샘플링 우선 정책을 적용한 고비용 비지도 학습 위젯', status: 'planned' },
  { title: 'Line Plot · Bar Plot · Mosaic Display · Violin Plot · Linear Projection', detail: '추가 시각화 위젯', status: 'planned' },
  { title: '.ows 가져오기', detail: 'Orange 워크플로 파일(.ows)을 Grapefruit 프로젝트로 변환', status: 'planned' },
  { title: 'Geo 애드온 확장', detail: '세계 시·도(admin 1) 경계, 최신 행정구역 경계, 주소 → 좌표 변환', status: 'planned' },
  { title: 'DuckDB-Wasm (선택형)', detail: 'SQL Table · Parquet 지원. 필요할 때만 내려받는 선택형 엔진', status: 'later' },
  { title: 'Text · Time Series · Image Analytics 애드온', detail: 'Word Cloud, Bag of Words, Topic Modelling, 시계열 등 확장 위젯', status: 'later' },
];
