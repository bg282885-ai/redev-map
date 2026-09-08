/* ------------------------------------------------------------------ */
/*  분류 회귀 검사 — data/truth.json(사용자가 확인한 현실)과 앱 분류를 비교한다                                        */
/*                                                                                                                    */
/*  실행: npm run audit            위반 목록 + 보정 규칙별 집계 (종료 코드 0)                                           */
/*        npm run audit -- --strict 위반이 있으면 종료 코드 1 (CI 용)                                                    */
/*        npm run audit -- --sample 20 [--seed 7]  후기 단계(서울) 표본을 뽑아 사람이 확인할 점검표(markdown) 출력        */
/*  빌드(scripts/build-data.mjs) 끝에서도 runAudit() 을 호출해 출력만 한다(빌드는 실패시키지 않음).                        */
/*  분류 규칙은 앱과 같은 lib/stage.mjs 를 쓰므로, 여기서 통과하면 화면도 같은 결과다.                                    */
/* ------------------------------------------------------------------ */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CORRECTIONS, DONE_RAW, correctionOf, decorateStage, explainStage, rawStage } from "../lib/stage.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TRUTH_PATH = path.join(ROOT, "data", "truth.json");

const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};

/** 앱이 이 기록을 어떻게 분류하는가: 옛기록 / 완공 / 진행 (truth 와 같은 어휘) */
export function appVerdict(p) {
  if (p.stale) return "옛기록";
  return explainStage(p).phase === "완공" ? "완공" : "진행";
}

/**
 * 정답 목록과 비교. projects 를 주지 않으면 public/data/projects.json 을 읽는다.
 * @returns {{ total: number, violations: any[], missing: any[] }}
 */
export function runAudit({ projects, strict = false, quiet = false } = {}) {
  const truth = readJson(TRUTH_PATH);
  const items = truth?.items ?? [];
  projects ??= readJson(path.join(ROOT, "public", "data", "projects.json")) ?? [];
  const byNo = new Map(projects.map((p) => [p.no, p]));
  const log = quiet ? () => {} : (...a) => console.log(...a);

  const violations = [], missing = [], renamed = [];
  for (const t of items) {
    const p = byNo.get(t.no);
    if (!p) {
      missing.push(t);
      continue;
    }
    if (t.name && p.name.replace(/\s/g, "") !== t.name.replace(/\s/g, "")) renamed.push({ t, p });
    const v = appVerdict(p);
    if (v !== t.truth) violations.push({ t, p, app: v, ex: explainStage(p) });
  }

  log(`· 회귀 검사 (data/truth.json ${items.length}건): 위반 ${violations.length}${missing.length ? `, 자료에 없음 ${missing.length}` : ""}${renamed.length ? `, 이름 바뀜 ${renamed.length}` : ""}`);
  for (const v of violations) {
    const c = v.ex.correction;
    log(`  ✗ ${v.t.no} ${v.p.name} — 정답 ${v.t.truth} / 앱 ${v.app} [${v.ex.phase}] 원자료 '${v.ex.raw}'${c ? ` + 보정 ${c.id}(${c.text})` : " (보정 없음)"} ← 규칙 ${v.ex.rule.id}`);
    if (v.t.note) log(`      메모: ${v.t.note}`);
  }
  for (const m of missing) log(`  ? ${m.no} ${m.name} — projects.json 에 없음 (출처에서 사라졌거나 번호가 바뀜)`);
  for (const r of renamed) log(`  ~ ${r.t.no} 이름 바뀜: '${r.t.name}' → '${r.p.name}'`);

  /* 보정 규칙별 집계 + 정답 대비 적중 */
  if (!quiet) {
    const stat = {};
    for (const p of projects) {
      const c = correctionOf(p);
      if (!c) continue;
      const k = c.id;
      stat[k] ??= { n: 0, seoul: 0, tp: 0, fp: 0 };
      stat[k].n++;
      if (p.sido === "서울") stat[k].seoul++;
    }
    for (const t of items) {
      const p = byNo.get(t.no);
      const c = p && correctionOf(p);
      if (!c || !stat[c.id]) continue;
      if (!c.done) continue;
      if (t.truth === "완공" || t.truth === "옛기록") stat[c.id].tp++;
      else stat[c.id].fp++;
    }
    const rows = CORRECTIONS.filter((c) => stat[c.id]).map((c) => `${c.id} ${stat[c.id].n}건(서울 ${stat[c.id].seoul})${c.done ? ` 정답 적중 ${stat[c.id].tp}/오탐 ${stat[c.id].fp}` : ""}`);
    log(`  보정 적용: ${rows.join(" · ") || "없음"}`);
    // 정답이 완공인데 원자료도 보정도 완료가 아닌 것(놓친 준공) — 위반 목록과 같지만 원인 유형으로 따로 센다
    const missed = items.filter((t) => t.truth === "완공" && byNo.has(t.no) && !DONE_RAW.test(rawStage(byNo.get(t.no).stage)) && !correctionOf(byNo.get(t.no))?.done);
    if (missed.length) log(`  놓친 준공(어느 근거에도 안 잡힘): ${missed.map((t) => `${t.no} ${t.name}`).join(", ")}`);
  }
  if (strict && violations.length) process.exit(1);
  return { total: items.length, violations, missing };
}

/** 후기 단계(관리처분~분양, 서울) 중 아직 완공으로 보정되지 않은 기록에서 표본을 뽑는다 — 사람이 확인해 truth.json 에 넣는 용도 */
export function sampleLate({ projects, n = 20, seed = 1, sido = "서울" } = {}) {
  projects ??= readJson(path.join(ROOT, "public", "data", "projects.json")) ?? [];
  const truthNos = new Set((readJson(TRUTH_PATH)?.items ?? []).map((t) => t.no));
  const pool = projects.filter((p) => p.sido === sido && explainStage(p).phase === "후기" && !truthNos.has(p.no));
  // 재현 가능한 난수 (mulberry32)
  let s = seed >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const arr = [...pool];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return { pool: pool.length, sample: arr.slice(0, n) };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const opt = (k, d) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] ?? d : d;
  };
  if (args.includes("--sample")) {
    const n = +opt("--sample", 20) || 20;
    const seed = +opt("--seed", 1) || 1;
    const { pool, sample } = sampleLate({ n, seed });
    console.log(`후기 단계(서울) 표본 ${sample.length}/${pool}건 (seed ${seed}). 확인 후 truth.json 에 { no, truth } 로 추가:\n`);
    console.log("| no | 자치구 | 이름 | 원자료 단계 | 보정 | 구역 연결 | 최근 동향 | 현실(기입) |");
    console.log("|---|---|---|---|---|---|---|---|");
    for (const p of sample) {
      const ex = explainStage(p);
      const c = ex.correction ? `${ex.correction.id}: ${ex.correction.text}` : "-";
      console.log(`| ${p.no} | ${p.gu} | ${p.name} | ${ex.raw} | ${c} | ${p.zoneHow ?? "미연결"} | ${p.note ? `${p.note.kw} ${p.note.date}` : "-"} |  |`);
    }
  } else {
    runAudit({ strict: args.includes("--strict") });
  }
}

// decorateStage 는 다른 스크립트가 이 모듈을 통해 쓰기도 한다
export { decorateStage };
