/* ------------------------------------------------------------------ */
/*  구역 분류코드·진행단계 → 라벨/색상                                    */
/*  (서울시 의제처리구역 레이어표 UQ181 기준)                              */
/* ------------------------------------------------------------------ */

export const CODE_LABEL: Record<string, string> = {
  UQ1100: "도시개발구역",
  UQ1200: "정비구역",
  UQ1206: "주택재건축사업",
  UQ1210: "주거환경개선사업구역",
  UQ1211: "주거환경개선사업",
  UQ1212: "주거환경관리사업",
  UQ1220: "재개발사업구역",
  UQ1221: "주택정비형 재개발구역",
  UQ1222: "도시정비형 재개발구역",
  UQ1230: "재개발사업지구",
  UQ1231: "주택정비형 재개발지구",
  UQ1232: "도시정비형 재개발지구",
  UQ1240: "재건축사업구역",
  UQ1250: "결합정비구역",
  UQ1260: "자율주택정비사업구역",
  UQ1270: "가로주택정비사업구역",
  UQ1280: "소규모재건축사업구역",
  UQ1290: "정비구역(도시및주거환경정비)",
  UQ5100: "재정비촉진지구",
  UQ5110: "주거지형 재정비촉진지구",
  UQ5120: "중심지형 재정비촉진지구",
  UQ5130: "고밀복합형 재정비촉진지구",
  UQ5140: "존치정비구역",
  UQ5150: "존치관리구역",
};

export type ZoneCategory = "재개발" | "재건축" | "주거환경" | "촉진지구" | "도시개발" | "소규모" | "기타";

export function zoneCategory(code: string): ZoneCategory {
  if (/^UQ12(2|3)/.test(code)) return "재개발";
  if (code === "UQ1240" || code === "UQ1206") return "재건축";
  if (/^UQ121/.test(code)) return "주거환경";
  if (/^UQ51/.test(code)) return "촉진지구";
  if (/^UQ11/.test(code)) return "도시개발";
  if (/^UQ12(6|7|8)/.test(code)) return "소규모";
  return "기타";
}

export const CATEGORY_COLOR: Record<ZoneCategory, string> = {
  재개발: "#E5484D",
  재건축: "#2F6FED",
  주거환경: "#2AA36B",
  촉진지구: "#8B5CF6",
  도시개발: "#6B7280",
  소규모: "#D97706",
  기타: "#9CA3AF",
};

export const CATEGORY_ORDER: ZoneCategory[] = ["재개발", "재건축", "주거환경", "소규모", "촉진지구", "도시개발", "기타"];

export function codeLabel(code: string) {
  return CODE_LABEL[code] ?? code;
}

/* ---------------- 진행단계 (정보몽땅) ---------------- */
export type StageGroup = "계획" | "추진위" | "조합" | "시행" | "관리처분" | "공사" | "완료" | "기타";

export function stageGroup(stage: string): StageGroup {
  const s = stage ?? "";
  if (/^착공|철거/.test(s)) return "공사"; // "착공(부분준공)" 은 공사 중
  if (/준공|이전고시|해산|청산|입주/.test(s)) return "완료";
  if (/착공|분양/.test(s)) return "공사";
  if (/관리처분/.test(s)) return "관리처분";
  if (/사업시행|사업계획승인|심의|지구단위계획수립/.test(s)) return "시행";
  if (/조합설립|창립총회|규약/.test(s)) return "조합";
  if (/추진위|모집신고/.test(s)) return "추진위";
  if (/정비계획|구역지정|정비구역|안전진단|예정|후보|선정/.test(s)) return "계획";
  return "기타";
}

/** 사업구분의 바탕 유형 — "재개발(주택정비형)"·"재개발" 처럼 시도마다 표기가 달라 괄호를 뗀 값으로 비교 */
export function kindBase(kind: string) {
  const k = (kind ?? "").replace(/\([^)]*\)/g, "").replace(/\s+/g, "");
  if (/소규모재건축/.test(k)) return "소규모재건축";
  if (/소규모재개발/.test(k)) return "소규모재개발";
  if (/가로주택/.test(k)) return "가로주택정비";
  if (/지역주택/.test(k)) return "지역주택";
  if (/리모델링/.test(k)) return "리모델링";
  if (/주거환경/.test(k)) return "주거환경개선";
  if (/재건축/.test(k)) return "재건축";
  if (/도시환경|도시정비형/.test(k)) return "재개발(도시정비형)";
  if (/재개발/.test(k)) return "재개발";
  return k;
}
/** 필터 칩 값이 사업장 유형과 맞는가 */
export function kindMatches(chip: string, kind: string) {
  if (chip === kind) return true;
  const cb = kindBase(chip), kb = kindBase(kind);
  if (cb === kb) return true;
  // "재개발(주택정비형)" 칩은 시도 자료의 단순 "재개발"도 포함
  return cb === "재개발" && kb === "재개발";
}

export const STAGE_ORDER: StageGroup[] = ["계획", "추진위", "조합", "시행", "관리처분", "공사", "완료", "기타"];

export const STAGE_COLOR: Record<StageGroup, string> = {
  계획: "#9CA3AF",
  추진위: "#F59E0B",
  조합: "#EC6C1E",
  시행: "#E5484D",
  관리처분: "#8B5CF6",
  공사: "#2F6FED",
  완료: "#2AA36B",
  기타: "#6B7280",
};

export const STAGE_DESC: Record<StageGroup, string> = {
  계획: "정비계획 수립 · 구역지정 · 안전진단",
  추진위: "추진위원회 승인 · 조합원 모집",
  조합: "조합설립인가",
  시행: "사업시행인가 · 심의",
  관리처분: "관리처분인가",
  공사: "철거 · 착공 · 분양",
  완료: "준공 · 이전고시 · 조합해산·청산",
  기타: "단계 미기재",
};

/* ---------------- 진행 국면 (아실 '재재' 식 초기·중기·후기 + 완공) ---------------- */
/*  2026-09-08 부팀장 의견: 완공된 곳은 기본 숨김, 완공 칩을 눌러야 보이게                */
export type Phase = "초기" | "중기" | "후기" | "완공";
export const PHASE_ORDER: Phase[] = ["초기", "중기", "후기", "완공"];
export const PHASE_COLOR: Record<Phase, string> = { 초기: "#F59E0B", 중기: "#E5484D", 후기: "#2F6FED", 완공: "#2AA36B" };
export const PHASE_DESC: Record<Phase, string> = {
  초기: "정비계획·구역지정 → 추진위원회 → 조합설립인가 (단계 미기재 포함)",
  중기: "사업시행인가 · 심의",
  후기: "관리처분인가 → 철거·착공·분양",
  완공: "준공 · 이전고시 · 조합해산·청산 — 기본 숨김",
};
export const PHASE_STAGES: Record<Phase, StageGroup[]> = {
  초기: ["계획", "추진위", "조합", "기타"],
  중기: ["시행"],
  후기: ["관리처분", "공사"],
  완공: ["완료"],
};
export function phaseOf(stage: string): Phase {
  const g = stageGroup(stage);
  if (g === "완료") return "완공";
  if (g === "시행") return "중기";
  if (g === "관리처분" || g === "공사") return "후기";
  return "초기";
}
export const isDoneStage = (stage: string) => stageGroup(stage) === "완료";

/* ---------------- 사업 방식 태그 (사업장 이름·구분에 표기된 것만) ---------------- */
export const TAG_LIST = ["신속통합기획", "공공재개발·재건축", "모아타운", "역세권", "도심공공복합"] as const;
export type Tag = (typeof TAG_LIST)[number];
const TAG_RE: Record<Tag, RegExp> = {
  신속통합기획: /신속통합|신통기획/,
  "공공재개발·재건축": /공공재개발|공공재건축|공공정비|공공\s*시행|공공참여/,
  모아타운: /모아타운|모아주택/,
  역세권: /역세권/,
  도심공공복합: /도심\s*공공|3080/,
};
export function projectTags(name: string, kind: string): Tag[] {
  const s = `${name ?? ""} ${kind ?? ""}`;
  return TAG_LIST.filter((t) => TAG_RE[t].test(s));
}

/* ---------------- 구역 상태 ---------------- */
/** 이 해 이전에 결정고시된 구역은 연결된 사업장이 없으면 "과거 구역"으로 보고 기본 숨김 (의제처리구역 자료는 1973년부터 들어 있다) */
export const OLD_ZONE_YEAR = 2010;
export function zoneYear(ntfc: string | undefined | null) {
  const m = (ntfc ?? "").match(/NTC(\d{4})/);
  return m ? +m[1] : null;
}
/**
 * 진행 = 진행 중 사업장 연결, 완공 = 연결 사업장 모두 완료 또는 (미연결인데) 구역 안 신축 고층 건물로 준공 판별(built),
 * 과거 = 연결 없고 옛 고시(또는 고시일 미상), 미상 = 연결 없는 최근 고시
 */
export type ZoneStatus = "진행" | "완공" | "과거" | "미상";
export function zoneStatus(zp: Pick<ZoneProps, "ntfc" | "built">, linked: Project[] | undefined): ZoneStatus {
  if (linked && linked.length) return linked.every((p) => isDoneStage(p.stage)) ? "완공" : "진행";
  if (zp.built) return "완공";
  const y = zoneYear(zp.ntfc);
  return y == null || y < OLD_ZONE_YEAR ? "과거" : "미상";
}

/* ---------------- 자치구 ---------------- */
export const GU: Record<string, string> = {
  "11110": "종로구", "11140": "중구", "11170": "용산구", "11200": "성동구", "11215": "광진구",
  "11230": "동대문구", "11260": "중랑구", "11290": "성북구", "11305": "강북구", "11320": "도봉구",
  "11350": "노원구", "11380": "은평구", "11410": "서대문구", "11440": "마포구", "11470": "양천구",
  "11500": "강서구", "11530": "구로구", "11545": "금천구", "11560": "영등포구", "11590": "동작구",
  "11620": "관악구", "11650": "서초구", "11680": "강남구", "11710": "송파구", "11740": "강동구",
};
export const GU_LIST = Object.entries(GU).sort((a, b) => a[1].localeCompare(b[1], "ko"));

/* ---------------- 시도·시군구 (경기·인천 포함) ---------------- */
import type { Project, Sido, ZoneProps } from "./types";
import sggRaw from "./bjd-sgg.json";

export const SIDO_LIST: Sido[] = ["서울", "경기", "인천"];
export const SIDO_FULL: Record<Sido, string> = { 서울: "서울특별시", 경기: "경기도", 인천: "인천광역시" };
export const SIDO_CODE: Record<Sido, string> = { 서울: "11", 경기: "41", 인천: "28" };

/** 시군구 코드(5자리) → 이름. 법정동코드 사전(시군구 단위) 기준 */
export const SGG: Record<string, string> = (() => {
  const m: Record<string, string> = { ...GU, "11000": "서울시", "41000": "경기도", "28000": "인천시" };
  for (const line of sggRaw as string[]) {
    const [code, full] = line.split("|");
    const parts = full.split(" ");
    // "경기도 성남시 수정구" → 성남시 수정구, "인천광역시 부평구" → 부평구
    m[code.slice(0, 5)] = parts.slice(1).join(" ");
  }
  return m;
})();

export function guName(code: string) {
  return SGG[code] ?? GU[code] ?? code;
}

export function sidoOfCode(code: string | null | undefined): Sido {
  const p = (code ?? "").slice(0, 2);
  return p === "41" ? "경기" : p === "28" ? "인천" : "서울";
}

/** 사업구분 (정보몽땅) */
export const KIND_LIST = [
  "재개발(주택정비형)",
  "재개발(도시정비형)",
  "재건축",
  "주거환경개선",
  "소규모재건축",
  "소규모재개발",
  "가로주택정비",
  "지역주택",
  "리모델링",
];

export function kindShort(kind: string) {
  return kind.replace("(주택정비형)", "·주택").replace("(도시정비형)", "·도시");
}

/** 고시번호 코드(11000NTC20170608xxxx)에서 고시일 */
export function ntfcDate(ntfc: string | undefined | null) {
  const m = (ntfc ?? "").match(/NTC(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "";
}

export function fmtArea(m2: number) {
  if (!m2) return "-";
  return `${Math.round(m2).toLocaleString()}㎡ · ${Math.round(m2 / 3.3058).toLocaleString()}평`;
}

/** 이름 정규화 (빌드 스크립트 normName 과 동일 규칙) */
const STRIP =
  /주택재건축정비사업조합|재건축정비사업조합|재개발정비사업조합|정비사업조합|정비사업|정비구역|재정비촉진구역|촉진구역|재개발사업|재건축사업|주택재건축|주택재개발|도시환경정비|도시정비형|주택정비형|공공재개발|공공재건축|재건축|재개발|추진위원회|조합|아파트|사업|구역|지구|정비|공공|일대|일원|번지|주택|제(?=\d)/g;

const CIRCLED = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";
export function normName(s: string | null | undefined) {
  return (s ?? "")
    .replace(/[①-⑳]/g, (c) => String(CIRCLED.indexOf(c) + 1))
    .replace(/\([^)]*\)/g, " ")
    .replace(STRIP, "")
    .replace(/[\s·ㆍ,\-_.~'’"“”]/g, "")
    .toLowerCase();
}

/** 고시 검색용 키워드: 정규화 이름 + "단지/차" 를 뗀 짧은 형태 */
export function nameKeywords(...names: (string | null | undefined)[]) {
  const out = new Set<string>();
  for (const n of names) {
    const a = normName(n);
    if (a.length >= 2) out.add(a);
    const b = a.replace(/(단지|차|번지|일대)$/g, "");
    if (b.length >= 2 && b !== a) out.add(b);
  }
  return [...out];
}

/** "개포동 138" → "개포동" */
export function dongOf(jibun: string | null | undefined) {
  const m = (jibun ?? "").match(/^(\S+?(?:동|가|읍|면|리))\b/);
  return m ? m[1] : "";
}
