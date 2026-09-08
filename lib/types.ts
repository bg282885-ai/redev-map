export type BBox = [number, number, number, number];

/** public/data/zones.geojson 의 feature.properties */
export type ZoneProps = {
  /** 도형번호 (고유) */
  fid: string;
  /** 결정고시(조서) 관리코드 — 정보몽땅 지도 코드와 같은 체계 */
  id: string;
  name: string;
  /** 최종 분류코드 (UQ1221 주택정비형 재개발구역 …) */
  code: string;
  /** 시군구코드 (11000 = 서울시 본청) */
  gu: string;
  /** 면적 ㎡ */
  area: number;
  /** 고시번호 코드 (11000NTC + yyyymmdd + 순번) */
  ntfc: string;
  bbox: BBox;
  /** 시도 (서울·경기·인천). 없으면 서울 */
  sido?: Sido;
  /** 자료 출처: seoul = 서울시 의제처리구역 SHP, vworld = V-World 지구단위계획(UPIS) 레이어, parcel = 대표지번 필지(정비구역 미지정 재건축 단지, V-World 지적도) */
  src?: "seoul" | "vworld" | "parcel" | "special";
  /** parcel 일 때 필지 PNU·주소 */
  pnu?: string | null;
  jibun?: string;
  /** 사업장 미연결 구역의 완공 판별(V-World 건물통합정보: 구역 안 신축 고층 건물). true 면 앱에서 완공으로 취급 */
  built?: boolean;
  /** 판별에 쓴 신축 고층 건물 동수 */
  builtN?: number;
};

export type Sido = "서울" | "경기" | "인천";

export type ZoneGeometry =
  | { type: "Polygon"; coordinates: number[][][] }
  | { type: "MultiPolygon"; coordinates: number[][][][] };

export type ZoneFeature = { type: "Feature"; geometry: ZoneGeometry; properties: ZoneProps };
export type ZoneCollection = { type: "FeatureCollection"; features: ZoneFeature[] };

/** public/data/projects.json 항목 (정비사업 정보몽땅 사업장) */
export type Project = {
  no: number;
  /** 시도 (서울·경기·인천). 없으면 서울 */
  sido?: Sido;
  /** 시군구 이름 (서울 자치구, 경기 시군, 인천 군구) */
  gu: string;
  /** 시군구 코드 5자리 */
  guCode: string | null;
  /** 자료 출처: 정보몽땅 / 경기도 / 인천시 */
  source?: "정보몽땅" | "경기도" | "인천시";
  /** 원문 위치 표기 (경기·인천 자료의 '위치' 열) */
  loc?: string;
  /** 구역 면적 ㎡ (경기·인천 자료) */
  area?: number | null;
  /** 출처 자료의 추가 항목 (표시용 라벨·값) */
  extra?: [string, string][];
  /** 법정동 코드 10자리 (대표지번 기준) */
  emdCode?: string | null;
  /** 대표지번 PNU 19자리 */
  pnu?: string | null;
  kind: string;
  name: string;
  jibun: string;
  stage: string;
  docs: string;
  /** 정보몽땅 사업장 페이지 id (cafeUrl) */
  cafe: string | null;
  /** 정보몽땅 지도 팝업 코드 = 결정고시 관리코드 */
  map: string | null;
  lat: number | null;
  lng: number | null;
  /** geocode=대표지번 지오코딩, place=단지명 장소 검색(지번 없음·합병), zone=구역 중심, emd=법정동 중심(준공 후 지번 합병) */
  locSrc: "geocode" | "place" | "zone" | "emd" | null;
  zoneId: string | null;
  zoneFid: string | null;
  /** map=정보몽땅 고시코드, point=대표지번이 구역 안, name=구역명 유사, parcel=정비구역 없어 대표지번 필지 경계를 씀 */
  zoneHow: "map" | "point" | "name" | "parcel" | "special" | null;
  /** 최근 동향 한 줄 (빌드 시 정보몽땅 고시·공고 제목 / 경기 자료의 최신 인가일에서 뽑음) — 지도 라벨·패널 표시용 */
  note?: { date: string; kw: string; title?: string; url?: string; src: "정보몽땅" | "경기도" } | null;
};

export type DataMeta = {
  builtAt: string;
  zones: number;
  projects: number;
  shp: string;
  /** 출처별 자료 기준 (파일명·수집일) */
  sources?: { seoulShp?: string; cleanup?: string; gyeonggi?: string; incheon?: string; vworld?: string };
  /** 이번 빌드에서 기록된 변경 건수 */
  changes?: number;
};

export type ChangeType =
  | "project-new" | "project-removed" | "stage-changed" | "kind-changed" | "zone-linked"
  | "zone-new" | "zone-changed" | "zone-removed";
export type ChangeEntry = {
  ts: string;
  type: ChangeType;
  sido?: Sido;
  gu?: string;
  name: string;
  no?: number;
  fid?: string;
  from?: string;
  to?: string;
};
export type ChangeLog = { updatedAt: string; baseline?: string; entries: ChangeEntry[] };

export type GosiSource = "정보몽땅" | "토지이음" | "도시계획포털";

export type GosiItem = {
  date: string;
  no?: string;
  title: string;
  org: string;
  url: string;
  source: GosiSource;
  /** 도시계획포털 고시번호 코드 (원문 PDF 조회용) */
  code?: string;
  /** 매칭 근거 (구역명 / 동) */
  hit: string;
  score: number;
};

/** 최근 정비 관련 고시 (알림 패널) */
export type RecentItem = {
  date: string;
  title: string;
  org: string;
  url: string;
  source: GosiSource;
  code?: string;
  sido: Sido;
};

export type ProjectSummary = {
  cafeId: string | null;
  fields: [string, string][];
  images: { loc?: string; sce?: string; pos?: string };
  fetchedAt: string;
};

export type Selection = { type: "zone"; fid: string } | { type: "project"; no: number };
