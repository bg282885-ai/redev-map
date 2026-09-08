/* ------------------------------------------------------------------ */
/*  진행단계 분류 — 앱(lib/zones.ts)·설명 도구(scripts/explain.mjs)·회귀 검사(scripts/audit.mjs)가 함께 쓰는 단일 규칙   */
/*  순수 JS(의존 없음)로 두어 Node 스크립트에서도 그대로 import 한다. 규칙을 바꾸면 여기 한 곳만 고친다.              */
/*                                                                                                                    */
/*  흐름: 원자료 단계(정보몽땅·경기·인천) → 보정(CORRECTIONS: 건축물대장·건물 자료·서울시 착공 현황·옛 기록·착공·이주)   */
/*        → 표시 문자열 "원자료 · 보정" (decorateStage) → 세부 단계 묶음(stageGroup) → 국면(phaseOf)                  */
/* ------------------------------------------------------------------ */

/** @typedef {"계획"|"추진위"|"조합"|"시행"|"관리처분"|"공사"|"완료"|"기타"} StageGroup */
/** @typedef {"초기"|"중기"|"후기"|"완공"} Phase */
/** @typedef {"진행"|"완공"|"과거"|"미상"} ZoneStatus */

/** 원자료 단계 자체가 완료를 뜻하는 표현 */
export const DONE_RAW = /준공|이전고시|해산|청산|입주/;

/**
 * 세부 단계 규칙 — 위에서부터 먼저 맞는 것이 결정한다.
 * 2026-09-08: 앱이 보정해 붙인 " · 준공…"/" · 옛 기록…" 표시는 원자료 '착공' 보다 우선해야 한다
 *   (전에는 /^착공|철거/ 가 먼저 걸려 동작1·개포주공1·반포3주구 등 15건이 공사(후기)로 남았다)
 * @type {{ id: string; re: RegExp; group: StageGroup; desc: string }[]}
 */
export const STAGE_RULES = [
  { id: "correction-done", re: / · (준공|옛 기록)/, group: "완료", desc: "앱 보정 표시(준공·옛 기록)가 원자료 단계보다 우선" },
  { id: "cancelled", re: /취소|해제/, group: "완료", desc: "대상지 취소·구역 해제 — 사업이 끝난 것으로 보고 완공과 같이 기본 숨김 (모아타운 취소구역, 서울플랜+)" },
  { id: "newtown-early", re: /선도지구|예비사업시행자|특별정비구역/, group: "계획", desc: "1기 신도시: 선도지구 → 예비사업시행자 → 특별정비구역 (조합 이전 초기)" },
  { id: "moatown-early", re: /대상지|관리계획/, group: "계획", desc: "모아타운: 대상지 선정 → 관리계획 공람·승인 (개별 조합 이전 초기)" },
  { id: "construction-lead", re: /^착공|철거/, group: "공사", desc: "'착공…'으로 시작(착공(부분준공) 포함)하거나 철거 = 공사 중" },
  { id: "done-keyword", re: DONE_RAW, group: "완료", desc: "준공·이전고시·해산·청산·입주" },
  { id: "construction", re: /착공|분양/, group: "공사", desc: "착공·분양" },
  { id: "disposal", re: /관리처분/, group: "관리처분", desc: "관리처분인가" },
  { id: "implementation", re: /사업시행|사업계획승인|심의|지구단위계획수립/, group: "시행", desc: "사업시행인가·심의" },
  { id: "union", re: /조합설립|창립총회|규약/, group: "조합", desc: "조합설립인가" },
  { id: "committee", re: /추진위|모집신고/, group: "추진위", desc: "추진위원회 승인·조합원 모집" },
  { id: "planning", re: /정비계획|구역지정|정비구역|안전진단|예정|후보|선정/, group: "계획", desc: "정비계획·구역지정·안전진단·예정·후보" },
];
const OTHER_RULE = { id: "other", re: /(?:)/, group: /** @type {StageGroup} */ ("기타"), desc: "단계 미기재·미분류" };

/** 어느 규칙이 세부 단계를 결정했는가 */
export function stageRule(stage) {
  const s = stage ?? "";
  for (const r of STAGE_RULES) if (r.re.test(s)) return r;
  return OTHER_RULE;
}
/** @returns {StageGroup} */
export function stageGroup(stage) {
  return stageRule(stage).group;
}
/** @returns {Phase} */
export function phaseOf(stage) {
  const g = stageGroup(stage);
  if (g === "완료") return "완공";
  if (g === "시행") return "중기";
  if (g === "관리처분" || g === "공사") return "후기";
  return "초기";
}
export const isDoneStage = (stage) => stageGroup(stage) === "완료";

/** 표시 문자열 "원자료 · 보정" 에서 원자료 단계만 */
export const rawStage = (stage) => (stage ?? "").split(" · ")[0];

/**
 * 보정 규칙 (우선순위 순). 원자료 단계가 완료가 아닐 때만 적용한다.
 *  - done: true 인 보정은 앱에서 완공(국면)으로 분류된다
 *  - when 은 원자료 단계(raw)를 받는다 — 표시 문자열에 이미 붙은 " · 착공 …" 에 다시 걸리지 않도록
 * @type {{ id: string; done: boolean; src: string; when: (p: any, raw: string) => boolean; suffix: (p: any) => string; short: (p: any) => string }[]}
 */
export const CORRECTIONS = [
  {
    id: "useApr", done: true, src: "건축물대장 총괄표제부(국토부 건축HUB) 사용승인",
    when: (p) => !!p.useApr,
    suffix: (p) => `준공(사용승인 ${p.useApr.date.slice(0, 7)})`,
    short: (p) => `준공 ${p.useApr.date.slice(0, 7)}`,
  },
  {
    id: "built", done: true, src: "구역 안 신축 고층 건물(V-World 건물통합정보)",
    when: (p) => !!p.built,
    suffix: () => "준공(건물 확인)",
    short: () => "준공(건물 확인)",
  },
  {
    id: "doneBy", done: true, src: "정보몽땅 '착공'인데 서울주택정보마당 착공 중·이주완료 목록에 없음",
    when: (p) => p.doneBy === "정보마당",
    suffix: () => "준공 추정(서울시 착공 현황에 없음)",
    short: () => "준공 추정",
  },
  {
    id: "stale", done: true, src: "같은 현장의 완료 기록이 따로 있는 통합 전 옛 기록",
    when: (p) => !!p.stale,
    suffix: () => "옛 기록(통합 후 해산)",
    short: () => "옛 기록",
  },
  {
    id: "cons", done: false, src: "서울주택정보마당 착공 중 구역 목록",
    when: (p, raw) => !!p.cons && !/착공|분양/.test(raw),
    suffix: (p) => `착공 ${p.cons.date.slice(0, 7)}(서울시)`,
    short: (p) => `착공 ${p.cons.date.slice(0, 7)}`,
  },
  {
    id: "moved", done: false, src: "서울주택정보마당 이주완료 구역 목록",
    when: (p, raw) => !!p.moved && !/이주|철거|착공|분양/.test(raw),
    suffix: () => "이주완료(서울시)",
    short: () => "이주완료",
  },
];

/** 이 기록에 적용되는 보정 (없으면 null). 원자료가 이미 완료면 보정하지 않는다 */
export function correctionOf(p) {
  const raw = rawStage(p?.stage);
  if (DONE_RAW.test(raw)) return null;
  for (const c of CORRECTIONS) if (c.when(p, raw)) return c;
  return null;
}

/** 앱이 로드 시 쓰는 표시 문자열: 보정이 있으면 "원자료 · 보정", 없으면 원자료 그대로 */
export function decorateStage(p) {
  const raw = rawStage(p.stage);
  const c = correctionOf(p);
  if (!c) return raw;
  return `${raw || "단계 미기재"} · ${c.suffix(p)}`;
}

/** 라벨·배지용 짧은 단계: 보정 결과를 먼저("준공 2026-03"), 없으면 원자료 단계 */
export function stageLabel(p) {
  const c = correctionOf(p);
  return c ? c.short(p) : rawStage(p.stage) || "단계 미기재";
}

/** 한 기록의 분류 경로 전체 — 설명 도구·감사용 */
export function explainStage(p) {
  const raw = rawStage(p.stage);
  const c = correctionOf(p);
  const decorated = decorateStage(p);
  const rule = stageRule(decorated);
  return {
    raw,
    rawDone: DONE_RAW.test(raw),
    correction: c ? { id: c.id, done: c.done, src: c.src, text: c.suffix(p) } : null,
    decorated,
    group: rule.group,
    rule: { id: rule.id, desc: rule.desc },
    phase: phaseOf(decorated),
    label: stageLabel(p),
  };
}

/* ---------------- 구역 상태 ---------------- */
/** 이 해 이전에 결정고시된 구역은 연결된 사업장이 없으면 "과거 구역"으로 보고 기본 숨김 (의제처리구역 자료는 1973년부터 들어 있다) */
export const OLD_ZONE_YEAR = 2010;
export function zoneYear(ntfc) {
  const m = (ntfc ?? "").match(/NTC(\d{4})/);
  return m ? +m[1] : null;
}
/**
 * 진행 = 진행 중 사업장 연결, 완공 = 연결 사업장 모두 완료 또는 (미연결인데) 구역 안 신축 고층 건물로 준공 판별(built),
 * 과거 = 연결 없고 옛 고시(또는 고시일 미상), 미상 = 연결 없는 최근 고시.
 * linked 의 stage 는 앱 표시 문자열(decorateStage 적용 후)이어야 한다.
 * @returns {ZoneStatus}
 */
export function zoneStatus(zp, linked) {
  if (linked && linked.length) return linked.every((p) => isDoneStage(p.stage)) ? "완공" : "진행";
  if (zp.built) return "완공";
  const y = zoneYear(zp.ntfc);
  return y == null || y < OLD_ZONE_YEAR ? "과거" : "미상";
}
