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
  UQ1260: "가로주택정비사업구역",
  UQ1270: "소규모재건축사업구역",
  UQ1280: "정비구역(도시및주거환경정비)",
  UQ1290: "재정비촉진지구",
  UQ5100: "재정비촉진지구",
  UQ5110: "주거지형 재정비촉진지구",
  UQ5120: "중심지형 재정비촉진지구",
  UQ5130: "고밀복합형 재정비촉진지구",
  UQ5140: "존치정비구역",
  UQ5150: "존치관리구역",
  /** 서울플랜+(도시계획포털 도시계획사업 현황) 모아타운 도형 — 소규모주택정비 관리지역·대상지 */
  BZ201: "모아타운(소규모주택정비 관리지역)",
};

export type ZoneCategory = "재개발" | "재건축" | "주거환경" | "촉진지구" | "도시개발" | "소규모" | "모아타운" | "기타";

export function zoneCategory(code: string): ZoneCategory {
  if (code === "BZ201") return "모아타운";
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
  모아타운: "#0D9488",
  기타: "#9CA3AF",
};

export const CATEGORY_ORDER: ZoneCategory[] = ["재개발", "재건축", "주거환경", "소규모", "모아타운", "촉진지구", "도시개발", "기타"];

export function codeLabel(code: string) {
  return CODE_LABEL[code] ?? code;
}

/* ---------------- 진행단계 (정보몽땅) ---------------- */
/*  규칙 본문은 lib/stage.mjs (앱·설명 도구 scripts/explain.mjs·회귀 검사 scripts/audit.mjs 공용). 여기서는 타입만 입힌다 */
export type StageGroup = "계획" | "추진위" | "조합" | "시행" | "관리처분" | "공사" | "완료" | "기타";

export function stageGroup(stage: string): StageGroup {
  return S.stageGroup(stage) as StageGroup;
}
/** 어느 규칙이 세부 단계를 결정했는가 (설명용) */
export const stageRule = S.stageRule as (stage: string) => { id: string; group: StageGroup; desc: string };
/** 표시 문자열 "원자료 · 보정" 에서 원자료 단계만 */
export const rawStage = S.rawStage as (stage: string | null | undefined) => string;
/** 보정 규칙 항목 (lib/stage.mjs CORRECTIONS) */
export type Correction = { id: "useApr" | "built" | "doneBy" | "stale" | "cons" | "moved"; done: boolean; src: string; suffix: (p: Project) => string; short: (p: Project) => string };
/** 이 기록에 적용되는 보정(건축물대장·건물 자료·서울시 착공 현황·옛 기록·착공·이주). 없으면 null */
export const correctionOf = S.correctionOf as (p: Project) => Correction | null;
/** 로드 시 표시 문자열: 보정이 있으면 "원자료 · 보정", 없으면 원자료 그대로 */
export const decorateStage = S.decorateStage as (p: Project) => string;
/** 라벨·배지용 짧은 단계: 보정 결과 먼저("준공 2026-03"), 없으면 원자료 단계 */
export const stageLabel = S.stageLabel as (p: Project) => string;

/** 사업구분의 바탕 유형 — "재개발(주택정비형)"·"재개발" 처럼 시도마다 표기가 달라 괄호를 뗀 값으로 비교 */
export function kindBase(kind: string) {
  const k = (kind ?? "").replace(/\([^)]*\)/g, "").replace(/\s+/g, "");
  if (/소규모재건축/.test(k)) return "소규모재건축";
  if (/소규모재개발/.test(k)) return "소규모재개발";
  if (/가로주택/.test(k)) return "가로주택정비";
  if (/모아타운/.test(k)) return "모아타운";
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
  완료: "준공 · 이전고시 · 조합해산·청산 · 대상지 취소·구역 해제",
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
  완공: "준공 · 이전고시 · 조합해산·청산 · 취소·해제 — 기본 숨김",
};
export const PHASE_STAGES: Record<Phase, StageGroup[]> = {
  초기: ["계획", "추진위", "조합", "기타"],
  중기: ["시행"],
  후기: ["관리처분", "공사"],
  완공: ["완료"],
};
export function phaseOf(stage: string): Phase {
  return S.phaseOf(stage) as Phase;
}
export const isDoneStage = (stage: string): boolean => S.isDoneStage(stage);

/* ---------------- 사업 방식 태그 (사업장 이름·구분에 표기된 것만) ---------------- */
export const TAG_LIST = ["1기 신도시", "신속통합기획", "공공재개발·재건축", "모아타운", "역세권", "도심공공복합"] as const;
export type Tag = (typeof TAG_LIST)[number];
const TAG_RE: Record<Tag, RegExp> = {
  "1기 신도시": /노후계획도시|1기\s*신도시|선도지구/,
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

/* ---------------- 구역 상태 (규칙은 lib/stage.mjs) ---------------- */
/** 이 해 이전에 결정고시된 구역은 연결된 사업장이 없으면 "과거 구역"으로 보고 기본 숨김 (의제처리구역 자료는 1973년부터 들어 있다) */
export const OLD_ZONE_YEAR: number = S.OLD_ZONE_YEAR;
export function zoneYear(ntfc: string | undefined | null): number | null {
  return S.zoneYear(ntfc);
}
/**
 * 진행 = 진행 중 사업장 연결, 완공 = 연결 사업장 모두 완료 또는 (미연결인데) 구역 안 신축 고층 건물로 준공 판별(built),
 * 과거 = 연결 없고 옛 고시(또는 고시일 미상), 미상 = 연결 없는 최근 고시
 */
export type ZoneStatus = "진행" | "완공" | "과거" | "미상";
export function zoneStatus(zp: Pick<ZoneProps, "ntfc" | "built">, linked: Project[] | undefined): ZoneStatus {
  return S.zoneStatus(zp, linked) as ZoneStatus;
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
import * as S from "./stage.mjs";
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
  "모아타운",
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

/**
 * 지도 라벨용 짧은 이름 (아실 'sTitle' 방식): "한남 제3재정비촉진구역 주택재개발정비사업 조합" → "한남3",
 * "압구정아파트지구 특별계획구역③ 재건축정비사업 조합" → "압구정 특별계획3", "개포주공4단지아파트 재건축정비사업 조합" → "개포주공4단지"
 */
const LABEL_STRIP =
  /주택재건축정비사업조합설립추진위원회|조합설립추진위원회|조합설립추진위|추진위원회|정비사업조합|정비사업|재건축사업|재개발사업|주택재건축|주택재개발|재정비촉진구역|재정비촉진지구|촉진구역|도시환경정비|도시정비형|주택정비형|재개발정비|재건축정비|정비구역|정비계획|정비예정구역|예정구역|공공재개발|공공재건축|장기전세주택|역세권|재건축|재개발|사업|조합|일대|일원|번지|아파트지구|아파트|구역|지구/g;
export function shortLabel(name: string | null | undefined, max = 14) {
  let s = (name ?? "")
    .replace(/[①-⑳]/g, (c) => String(CIRCLED.indexOf(c) + 1))
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(/^\s*\d+\.\s*/, "")
    .replace(/신속통합기획/g, "신통")
    .replace(/제(?=\d)/g, "")
    .replace(LABEL_STRIP, " ")
    .replace(/\s+/g, " ")
    .replace(/(\S) (\d)/g, "$1$2")
    .replace(/[·,]\s*$/, "")
    .trim();
  if (!s) s = (name ?? "").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
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
