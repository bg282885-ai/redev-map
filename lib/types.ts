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
  /** 자료 출처: seoul = 서울시 의제처리구역 SHP, vworld = V-World 지구단위계획(UPIS) 레이어, parcel = 대표지번 필지(정비구역 미지정 재건축 단지, V-World 지적도),
   *  special = 특별계획구역(OA-21164), seoulplan = 서울플랜+ 모아타운 대상지·관리지역 도형(도시계획포털 도시계획사업 현황, code BZ201) */
  src?: "seoul" | "vworld" | "parcel" | "special" | "seoulplan";
  /** parcel 일 때 필지 PNU·주소 */
  pnu?: string | null;
  jibun?: string;
  /** 사업장 미연결 구역의 완공 판별(V-World 건물통합정보: 구역 안 신축 고층 건물). true 면 앱에서 완공으로 취급 */
  built?: boolean;
  /** 판별에 쓴 신축 고층 건물 동수 */
  builtN?: number;
  /** 같은 구역의 고시 차수별 중복 도형이면 최신 고시 도형(대표)의 fid — 앱은 대표만 그린다 */
  dupOf?: string;
  /** 대표 도형일 때, 숨긴 이전 차수 도형들의 고시번호 코드 */
  dups?: string[];
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
  /** 자료 출처: 정보몽땅 / 경기도 / 인천시 / 1기신도시(data/newtown1.json — 국토부 선도지구·시 지정 고시 정리) / 모아타운 / 서울플랜+(도시계획포털 도시계획사업 현황, 정보몽땅에 없는 사업) / 지자체포털(자치구 정비사업 포털 — 안전진단·기본계획 등 정보몽땅·서울플랜+ 이전 단계) */
  source?: "정보몽땅" | "경기도" | "인천시" | "1기신도시" | "모아타운" | "서울플랜+" | "지자체포털";
  /** 지자체포털 기록의 출처 포털 (서초구 공동주택 & 재건축 정보포털 등) */
  portal?: { gu: string; site: string; url: string; id?: string };
  /** 서울플랜+(서울시 도시계획사업 현황)의 같은 사업 추진단계 — 정보몽땅 기록에도 붙는다. ended = 취소·해제·중단(앱은 완공처럼 숨김) */
  plan?: { sn: string; code?: string; type: string; stage: string; date?: string; history?: { stage: string; date: string }[]; ended?: boolean };
  /** 1기 신도시 선도지구의 구성 단지 (장소 검색어·단지명) */
  complexes?: { q: string; core: string }[];
  /** 자료의 단계는 후기(관리처분~분양)인데 구역 안 신축 고층 건물로 준공이 확인된 사업장 — 앱은 단계 뒤에 "준공(건물 확인)" 을 붙여 완공으로 다룬다 */
  built?: boolean;
  /** 통합 재건축 등으로 다른 기록에 흡수된 뒤 정보몽땅에 갱신되지 않고 남은 옛 기록 — 값은 같은 현장의 완료 기록 no. 앱은 완공으로 다룬다 */
  stale?: number;
  /** 서울주택정보마당 '관리처분-착공 현황'의 착공 목록에 있는 구역 — 착공일·사업유형·공급세대 (반기 갱신) */
  cons?: { date: string; type?: string; units?: string };
  /** 서울주택정보마당 이주완료 구역 목록에 있음 (아직 착공 전) */
  moved?: boolean;
  /** 정보몽땅 단계는 착공인데 서울시 착공 중 목록(정보마당)에도 이주완료 목록에도 없어 준공된 것으로 추정 — 앱은 완공으로 다룬다 */
  doneBy?: "정보마당";
  /** 건축물대장 총괄표제부(국토부 건축HUB)에서 구역 안 새 공동주택의 사용승인이 확인됨 — 준공 확정. 앱은 완공으로 다루고 날짜·단지명·세대수를 보인다 */
  useApr?: { date: string; name?: string; units?: number; dongs?: number };
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
  /** seoulplan = 서울플랜+ 모아타운 도형(출처가 도형을 함께 줌) */
  zoneHow: "map" | "point" | "name" | "parcel" | "special" | "seoulplan" | null;
  /** 최근 동향 한 줄 (빌드 시 정보몽땅 고시·공고 제목 / 경기 자료의 최신 인가일에서 뽑음) — 지도 라벨·패널 표시용 */
  note?: { date: string; kw: string; title?: string; url?: string; src: "정보몽땅" | "경기도" | "국토부·시 발표" | "도시계획포털" | "서울플랜+" | "지자체포털" } | null;
};

export type DataMeta = {
  builtAt: string;
  zones: number;
  projects: number;
  shp: string;
  /** 출처별 자료 기준 (파일명·수집일) */
  sources?: { seoulShp?: string; cleanup?: string; gyeonggi?: string; incheon?: string; vworld?: string; housinginfo?: string; bldrgst?: string; seoulplan?: string; portal?: string };
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
  /** 사업장 출처 (일괄 추가 요약용) */
  source?: string;
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
