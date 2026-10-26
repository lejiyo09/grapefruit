# Grapefruit 🍊

**Orange Data Mining 스타일의 브라우저 기반 시각적 데이터 분석·머신러닝 도구.**
위젯을 캔버스에 놓고 선으로 연결하면 데이터가 흘러가며 실제로 계산됩니다. 설치 없이 크롬북 브라우저에서 바로 실행되고, 모든 계산은 내 브라우저 안(Web Worker)에서 이루어집니다.

> Orange의 화면·워크플로 경험과 위젯 이름·기본값을 최대한 원본에 맞춰(고증) 다시 구현한 별도 프로그램입니다. Orange의 Python 코드를 실행하지 않으며, Orange `.ows` 파일과는 형식이 다릅니다.

## 빠른 시작

```bash
npm install
npm run dev        # 개발 서버 (http://localhost:5173)
npm test           # 단위 테스트 (vitest)
npm run build      # 타입 검사 + dist/ 빌드
```

## 배포 (Render Static Site)

| 항목 | 값 |
| --- | --- |
| Build Command | `npm ci && npm run build` |
| Publish Directory | `dist` |

**Web Service로 만들었다면**: Build Command `npm ci && npm run build`, Start Command `npm start` (의존성 없는 `server.mjs`가 `dist/`를 서빙).

`render.yaml`(Blueprint)에 같은 설정과 캐시 헤더가 들어 있습니다. `main` 브랜치에 푸시하면 Render가 다시 빌드합니다.
빌드할 때 `dist/version.json`이 만들어지고(커밋 해시 포함), 열려 있는 앱이 이를 확인해 **새 버전 배포 알림**을 띄웁니다.
`vite.config.ts`의 `base: './'` 덕분에 GitHub Pages 같은 하위 경로 배포에서도 그대로 동작합니다.

## 업데이트 센터 (업데이트 위젯)

상단 오른쪽 **🔔 업데이트** 버튼.

- **새 소식**: 버전별 변경 내역(새 기능 / 개선 / 버그 수정). 읽지 않은 소식이 있으면 배지 표시.
- **업데이트 직후 자동 표시**: 이전 버전을 쓰던 사용자가 새 버전을 처음 열면 노트 앱의 "What's new"처럼 새 소식 창이 자동으로 열립니다.
- **새 배포 감지**: 10분마다, 그리고 창으로 돌아올 때 `version.json`을 확인해 새 빌드가 올라오면 `NEW` 배지와 "지금 업데이트" 알림을 띄웁니다. 누르면 워크플로를 저장하고 캐시를 비운 뒤 새로고침합니다.
- **로드맵 / 앱 정보**: 다음 계획, 현재 버전·빌드, 자동 확인 켜기/끄기.

### 새 버전 내는 법

1. `package.json`의 `version`을 올립니다(예: `0.2.0`).
2. `src/updates/changelog.ts`의 `CHANGELOG` 맨 앞에 항목을 추가합니다.
3. 커밋 후 `main`에 푸시 → Render 배포 → 사용자 화면에 업데이트 알림과 새 소식이 표시됩니다.

## 애드온

상단 **[애드온]** 버튼에서 위젯 묶음을 골라 설치합니다(Orange의 Options → Add-ons). 설치할 때 코드와 데이터를 내려받아 브라우저에 저장하므로 이후에는 오프라인에서도 쓸 수 있습니다.

| 애드온 | 위젯 | 원본 |
| --- | --- | --- |
| **Geo** | Geo Map, Choropleth Map, Geocoding | orange3-geo (카테고리 색 `#a0eaa0`, `find_lat_lon` 규칙, Choropleth 집계 함수·기본값 동일) |
| **Image Analytics** | Import Images, Image Viewer, Image Embedding | orange3-imageanalytics (카테고리 색 `#F7F5A8`, 출력 열 구성·이름 동일) |

**Image Embedding (SqueezeNet)** — Orange의 로컬 SqueezeNet 임베더와 같은 계산을 브라우저에서 합니다.
- 모델·가중치: Orange가 쓰는 `ndf` 0.1.4 패키지의 SqueezeNet(MIT). `scripts/extract-squeezenet-weights.py`로 pickle을 안전하게(numpy 배열만 허용) float32 바이너리로 변환
- 전처리: Pillow `resize((227, 227), LANCZOS)`를 고정소수점까지 그대로 옮긴 구현(`src/ml/resample.ts`, Pillow와 픽셀 단위 일치 테스트), `SqueezenetModel.preprocess`의 동작(가로 0열↔2열 교환 후 평균 빼기)까지 재현
- 검증: 독립 NumPy 참조 구현(`scripts/ref-squeezenet.py`)과 최대 오차 1.3e-5
- Inception v3, VGG-16/19, Painters, DeepLoc, openface는 Orange도 바이오랩 서버로 이미지를 보내 계산하므로 지원하지 않습니다.
- 이미지는 원본 대신 미리보기와 227×227 축소본만 IndexedDB에 저장하고, 계산한 임베딩은 이미지별로 캐시합니다.

- 경계 데이터: Natural Earth 1:110m 국가(퍼블릭 도메인), 통계청 2013 시·도/시·군·구(southkorea/southkorea-maps). 다시 만들려면 `scripts/build-geo-data.py`
- 배경 지도: OpenStreetMap 등 타일 서버(인터넷 필요, 저작권 표시 포함). 타일을 못 받으면 내장 경계선으로 자동 전환
- 시·군·구 경계는 2013년 기준이라 이후 바뀐 행정구역(예: 군위군 대구 편입)은 반영되어 있지 않습니다.
- 새 애드온은 `src/addons/manager.ts`의 `ADDONS`에 항목을 추가하고, `register()`에서 위젯을 등록하는 모듈을 만들면 됩니다.

## 위젯 (기본 31개)

| 카테고리 | 위젯 |
| --- | --- |
| Data | File(CSV/TSV/.tab/URL, 열 타입·역할 편집), Datasets, Data Table, Data Info, Feature Statistics, Save Data |
| Transform | Select Columns, Select Rows, Data Sampler, Impute, Continuize, Discretize, Unique, Randomize, Transpose, Concatenate, Merge Data |
| Visualize | Scatter Plot, Distributions, Box Plot, Correlations, Heat Map, Tree Viewer |
| Model | Constant, kNN, Tree, Random Forest, Logistic Regression, Linear Regression, Naive Bayes, Neural Network |
| Evaluate | Test and Score, Predictions, Confusion Matrix, ROC Analysis |
| Unsupervised | k-Means, PCA, Distances, Distance Matrix, Hierarchical Clustering |

### 원본(Orange 3)과 맞춘 부분

Orange 소스(`biolab/orange3`)의 설정 기본값과 알고리즘 규칙을 확인해 반영했습니다.

- **타입 추론**: `is_discrete_values` 규칙(수치 열은 {0,1}/{1,2}일 때만 범주형, 문자열 열은 고유값 ≤ n^0.7), 결측 토큰 `? nan . NA ~` 및 빈 칸, `.tab` 3줄 헤더와 `cD#name` 접두어
- **카테고리 색**: Data `#FFD39F`, Transform `#FF9D5E`, Visualize `#FFB7B1`, Model `#FAC1D9`, Evaluate `#C3F3F3`, Unsupervised `#CAE1EF`
- **kNN**: 이웃 5, Euclidean, Uniform, 정규화 없음 / **Tree**: 이진, 잎 ≥ 2, 분할 ≥ 5, 깊이 ≤ 100, 다수 클래스 95%에서 중단
- **Neural Network**: scikit-learn MLP 방식, 은닉층 `100,`, ReLu, Adam, α 0.0001, 반복 200, random_state 1, 입력 표준화
- **Random Forest**: 트리 10, 분할 ≥ 5, 특징 √p / **Logistic Regression**: Ridge(L2), C = 1 / **Linear Regression**: OLS, α = 0.0001
- **Naive Bayes**: 수치형은 EqualFreq(n=4, `split_eq_freq`) 이산화, 라플라스 보정 공식 동일
- **Test and Score**: 5-fold 층화 교차검증, 무작위 표본 10회 × 66%, 지표 AUC·CA·F1·Prec·Recall·MCC / MSE·RMSE·MAE·R2
- **k-Means**: k = 3(최적화 2–8), k-means++, 재시도 10, 반복 300, 정규화, 실루엣(5,000행 이하) / **PCA**: 성분 2, 정규화
- **Distances**: Euclidean(정규화) / **Hierarchical Clustering**: Ward, 수동 선택, 높이 75%, Top N 3
- **Scatter Plot**: 점 크기 10, 불투명도 128, 범주형 팔레트 Orange `DefaultRGBColors`
- 기본 데이터셋 `iris`, `titanic`, `heart_disease`, `housing`, `zoo`는 Orange 원본 `.tab` 파일

교차검증 폴드 분할과 난수는 scikit-learn과 다르므로 점수는 Orange와 소수점 수준에서 다를 수 있습니다.

## 저사양 크롬북(RAM 4GB) 대응

- 계산은 **Web Worker 1개**에서 순서대로 실행(메모리 피크 억제). 취소하면 Worker를 종료해 즉시 메모리 해제
- 열 단위 `Float64Array` 저장, 변환 시 바뀌지 않은 열은 복사하지 않고 공유
- Data Table은 **가상 스크롤**(보이는 행만 DOM 생성), 그래프는 Canvas 렌더링
- Scatter Plot 2만 점 초과 시 표본 그리기, Heat Map은 픽셀 단위 평균
- Distances는 실행 전에 **메모리를 계산**(n(n−1)/2 × 8바이트)해 기본 2,000행 초과 시 자동 표본 추출, 256MB 이상 차단
- Leave-one-out 2,000행 제한, 실루엣 5,000행 제한, Transpose 5,000행 제한
- 서비스 워커로 앱과 기본 데이터셋을 캐시해 **오프라인 실행**

## 구조

```
src/
├── app/          앱 셸(상단 막대·팔레트·자동 저장), 예제 워크플로
├── engine/       워크플로 엔진(그래프·스케줄러·취소·직렬화), 위젯 레지스트리, Worker 클라이언트
├── core/         Table(열 단위 데이터), CSV/.tab 파서, 통계·분포 함수
├── ml/           학습기·예측, 트리, 최적화(L-BFGS·고유분해), 평가, k-Means·PCA·거리·계층 군집
├── widgets/      카테고리별 위젯 정의
├── ui/           캔버스, 위젯 창, 컨트롤, 가상 스크롤 표, Canvas 플롯
├── updates/      업데이트 센터, 체인지로그·로드맵
├── storage/      IndexedDB(자동 저장, 불러온 파일)
└── workers/      계산 Worker와 작업 목록
```

새 위젯은 `registerWidget({ type, name, category, inputs, outputs, defaultSettings, execute, render })` 하나로 추가합니다. 캔버스·엔진은 수정할 필요가 없습니다.

프로젝트 파일(`*.grapefruit.json`)에는 위젯 설정과 연결만 저장됩니다. 내 컴퓨터에서 연 데이터 파일은 이 브라우저의 IndexedDB에만 보관되므로 다른 기기에서는 다시 선택해야 합니다.
