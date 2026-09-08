/* ------------------------------------------------------------------ */
/*  설명 도구 — 사업장 하나가 왜 그렇게 분류됐는지 모든 근거 층을 한 번에 보여준다                                      */
/*                                                                                                                    */
/*  실행: node scripts/explain.mjs 11590048          (사업장 no)                                                        */
/*        node scripts/explain.mjs 동작1              (이름 일부 — 여럿이면 목록만, --all 이면 전부 설명)                  */
/*        … --fetch                                   지오코딩·건축물대장 캐시가 없을 때 조회 허용 (기본은 캐시만, 네트워크 없음) */
/*                                                                                                                    */
/*  출력 층: ① 원자료 ② 위치 ③ 구역 연결(방법·검증·다른 후보) ④ 서울주택정보마당 착공·이주 매칭 ⑤ 건축물대장 총괄표제부     */
/*          후보 행과 걸러진 조건 ⑥ V-World 건물 신호 ⑦ 옛 기록 ⑧ 최근 동향 ⑨ 최종 분류(어느 규칙이 결정했는지) ⑩ 정답 비교  */
/*  규칙 함수는 빌드 스크립트(scripts/build-data.mjs)와 앱(lib/stage.mjs)의 것을 그대로 import 하므로 여기 결과 = 빌드·화면 결과 */
/* ------------------------------------------------------------------ */
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as B from "./build-data.mjs";
import { DONE_RAW, decorateStage, explainStage, zoneStatus, zoneYear } from "../lib/stage.mjs";
import { appVerdict } from "./audit.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const FETCH = args.includes("--fetch");
const ALL = args.includes("--all");
const query = args.filter((a) => !a.startsWith("--")).join(" ").trim();
if (!query) {
  console.log("사용법: node scripts/explain.mjs <사업장 no | 이름 일부> [--fetch] [--all]");
  process.exit(1);
}

const readJson = B.readJson;
const projects = readJson(path.join(B.OUT, "projects.json")) ?? [];
const zonesFC = readJson(path.join(B.OUT, "zones.geojson")) ?? { features: [] };
const zoneByFid = new Map(zonesFC.features.map((z) => [z.properties.fid, z]));
const linkedByFid = new Map();
for (const p of projects) if (p.zoneFid) (linkedByFid.get(p.zoneFid) ?? linkedByFid.set(p.zoneFid, []).get(p.zoneFid)).push(p);
const truth = readJson(path.join(ROOT, "data", "truth.json"))?.items ?? [];
const housing = readJson(path.join(B.RAW, "housinginfo.json"));
const builtCache = readJson(B.builtCachePath) ?? {};
const bldrgst = readJson(B.bldrgstCachePath) ?? { recap: {} };
bldrgst.recap ??= {};
const cleanupList = readJson(path.join(B.RAW, "cleanup-list.json")) ?? [];
const seoulProjects = projects.filter((p) => p.source === "정보몽땅");

/* ---------- 대상 찾기 ---------- */
let targets;
if (/^\d+$/.test(query)) {
  const p = projects.find((x) => x.no === +query);
  targets = p ? [p] : [];
} else {
  const qn = B.normName(query);
  targets = projects.filter((x) => x.name.replace(/\s/g, "").includes(query.replace(/\s/g, "")) || (qn.length >= 2 && B.normName(x.name).includes(qn)));
}
if (!targets.length) {
  console.log(`'${query}' 에 맞는 사업장이 없습니다 (projects.json ${projects.length}건).`);
  process.exit(1);
}
if (targets.length > 1) {
  console.log(`'${query}' 에 맞는 사업장 ${targets.length}건:`);
  for (const p of targets) console.log(`  ${p.no}  ${p.sido} ${p.gu}  ${p.name}  [${p.stage}]`);
  if (!ALL && targets.length > 3) {
    console.log("\n번호로 다시 실행하거나 --all 을 붙이세요.");
    process.exit(0);
  }
  console.log("");
}

/* ---------- 출력 도우미 ---------- */
const H = (t) => console.log(`\n${t}\n${"─".repeat(Math.min(72, t.length * 2 + 4))}`);
const L = (k, v) => console.log(`  ${String(k).padEnd(14, " ")} ${v ?? "-"}`);
const yes = (b) => (b ? "예" : "아니오");
const dateOf = (ntfc) => {
  const m = (ntfc ?? "").match(/NTC(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : "-";
};
const fmtArea = (a) => (a ? `${Math.round(a).toLocaleString()}㎡` : "-");
const corrTag = (p) => {
  const ex = explainStage(p);
  return ex.correction ? `${ex.raw} + ${ex.correction.id}` : ex.raw;
};
const section = (title, fn) => {
  H(title);
  try {
    fn();
  } catch (e) {
    console.log(`  (이 층을 설명하는 중 오류: ${e.message})`);
  }
};

/* ---------- 설명 ---------- */
async function explain(p) {
  const z = p.zoneFid ? zoneByFid.get(p.zoneFid) : null;
  const zp = z?.properties ?? null;
  const pt = p.lat != null && p.lng != null ? [p.lng, p.lat] : null;
  const pn = B.normName(p.name);

  console.log(`\n${"═".repeat(72)}\n ${p.no}  ${p.name}\n${"═".repeat(72)}`);

  section("① 원자료", () => {
    L("출처", `${p.source} · ${p.sido} ${p.gu}${p.guCode ? ` (${p.guCode})` : ""}`);
    L("사업구분", p.kind);
    L("대표지번/위치", p.loc || p.jibun || "-");
    L("진행단계(원자료)", `'${p.stage}'${DONE_RAW.test(p.stage ?? "") ? " — 원자료 자체가 완료" : ""}`);
    if (p.docs) L("게시물/세대", p.docs);
    if (p.cafe) L("정보몽땅 페이지", `cafeOpenPopup('${p.cafe}')`);
    if (p.map) L("정보몽땅 지도코드", `${p.map}${p.map === B.PLACEHOLDER_AGZ ? " (옛 구역 128개가 공유하는 자리표시 값 → 연결에 쓰지 않음)" : ""}`);
    if (p.extra?.length) for (const [k, v] of p.extra.slice(0, 8)) L(`  ${k}`, v);
    if (p.source === "정보몽땅") {
      const raw = cleanupList.find((r) => r.no === p.no);
      if (raw && raw.stage !== p.stage) L("캐시 목록 단계", `'${raw.stage}' — projects.json 과 다름(빌드 뒤 목록이 갱신됐거나 이전 자료 유지). build:data 다시 실행 필요`);
      else if (raw) L("캐시 목록", `data/raw/cleanup-list.json 과 일치`);
    }
  });

  section("② 위치", () => {
    if (!pt) {
      L("좌표", "없음 → 지도에 안 뜸");
      return;
    }
    const how = { geocode: "대표지번 지오코딩(V-World getcoord)", place: "단지명 장소 검색(지번 없음·합병)", zone: "구역 폴리곤 중심", emd: "법정동 중심 — 대략 위치(준공 후 지번 합병)" }[p.locSrc] ?? p.locSrc;
    L("좌표", `${p.lat}, ${p.lng}  (${how})`);
    if (p.emdCode) L("법정동 코드/PNU", `${p.emdCode} / ${p.pnu ?? "-"}`);
    const cands = p.sido === "서울" ? B.addressCandidates(p.gu, p.jibun).map((address) => ({ address, type: "PARCEL" })) : B.locCandidates(B.SIDO_FULL[p.sido], p.gu, p.loc);
    if (cands.length) {
      const c = cands[0];
      const ck = c.type === "ROAD" ? `ROAD:${c.address}` : c.address;
      L("지오코딩 질의", `${c.address} → 캐시 ${ck in B.geoCache ? (B.geoCache[ck] ? "있음" : "NOT_FOUND") : "없음"}${cands.length > 1 ? ` (후보 ${cands.length}개)` : ""}`);
    }
    if (p.source === "모아타운") L("표시", "모아타운은 관리지역 경계 벡터가 없어 대표지번 한 점만 — 옆 정비구역 경계에 걸쳐 보여도 별개 사업");
  });

  section("③ 구역 연결", () => {
    const kc = B.kindClass(p.kind);
    if (kc === "none") L("연결 규칙", "지역주택·리모델링·모아타운은 정비구역 폴리곤과 묶지 않음(kindClass none)");
    if (zp) {
      const howText = { map: "정보몽땅 지도코드 = 결정고시 관리코드", point: "대표지번 좌표가 폴리곤 안(유형 호환·이름 숫자 일치)", name: "구역명 유사도(같은 시도, 1~3km)", parcel: "정비구역 없어 대표지번 필지 경계(V-World 지적도)", special: "정비구역 없어 좌표가 든 지구단위계획 특별계획구역", seoulplan: "서울플랜+ 모아타운 도형(출처가 도형을 함께 줌)" }[p.zoneHow] ?? p.zoneHow;
      L("방법", `${p.zoneHow} — ${howText}`);
      L("구역", `${zp.name}  [${zp.code}] fid ${zp.fid}`);
      L("고시/면적/출처", `${dateOf(zp.ntfc)} (${zp.ntfc || "-"}) · ${fmtArea(zp.area)} · src ${zp.src ?? "seoul"}${zp.id ? ` · 관리코드 ${zp.id}` : ""}`);
      if (zp.dupOf) L("중복 도형", `dupOf ${zp.dupOf} — 앱은 대표 도형만 그림 (연결이 대표로 안 옮겨졌다면 빌드 문제)`);
      if (zp.dups?.length) L("숨긴 이전 고시", zp.dups.join(", "));
      if (zp.built != null) L("구역 건물 판별", `built ${zp.built} (신축 고층 ${zp.builtN ?? 0}동)`);
      const zn = B.normName(zp.name);
      L("검증", `좌표가 폴리곤 안 ${pt ? yes(B.pointInGeom(pt, z.geometry)) : "좌표 없음"} · 이름 점수 ${B.nameScore(pn, zn).toFixed(2)} (${pn} ↔ ${zn}) · 유형 호환 ${yes(B.compatible(p.kind, zp.code))} · 숫자 충돌 ${yes(B.digitsConflict(pn, zn))}`);
      const sib = (linkedByFid.get(zp.fid) ?? []).filter((q) => q.no !== p.no);
      if (sib.length) {
        L("같은 구역 기록", `${sib.length}건`);
        for (const q of sib) console.log(`     - ${q.no} ${q.name} [${corrTag(q)}] ${q.zoneHow}`);
      }
    } else {
      L("연결", `없음${p.source === "모아타운" ? " (모아타운은 마커만)" : ""}`);
    }
    if (pt && kc !== "none") {
      const inside = zonesFC.features.filter((f) => {
        const b = f.properties.bbox;
        return f.properties.fid !== zp?.fid && pt[0] >= b[0] && pt[0] <= b[2] && pt[1] >= b[1] && pt[1] <= b[3] && (f.properties.sido ?? "서울") === (p.sido ?? "서울") && B.pointInGeom(pt, f.geometry);
      });
      if (inside.length) {
        L("좌표가 든 다른 폴리곤", `${inside.length}개 — 연결 안 된 이유`);
        for (const f of inside.slice(0, 8)) {
          const q = f.properties;
          const qn = B.normName(q.name);
          const s = B.nameScore(pn, qn);
          let why = "";
          if (q.dupOf) why = `중복 도형(dupOf ${q.dupOf})`;
          else if (q.src === "parcel" || q.src === "special" || q.src === "seoulplan") why = "필지·특별계획·모아타운 도형(다른 사업장의 것)";
          else if (!B.compatible(p.kind, q.code)) why = `유형 불일치 (${p.kind} ↔ ${q.code})`;
          else if (B.digitsConflict(pn, qn)) why = `이름 숫자 충돌 (${pn} ↔ ${qn})`;
          else if (/^UQ51[012]/.test(q.code) && s < 0.8) why = `울타리(촉진지구)라 이름 점수 ${s.toFixed(2)} < 0.8 필요`;
          else if ((B.UMBRELLA_CODE.test(q.code) || q.code === B.MANAGED_CODE) && s < 0.5) why = `울타리·관리형이라 이름 점수 ${s.toFixed(2)} < 0.5 필요`;
          else why = zp ? `후보였으나 pickBest 에서 밀림 (이름 점수 ${s.toFixed(2)})` : `후보 조건은 통과 — 지도코드 연결이 우선했거나 빌드 시 좌표가 달랐음 (점수 ${s.toFixed(2)})`;
          console.log(`     - ${q.name} [${q.code}] ${dateOf(q.ntfc)} ${fmtArea(q.area)} → ${why}`);
        }
      }
      if (!zp && pn.length >= 3) {
        const cands = zonesFC.features
          .filter((f) => !f.properties.dupOf && (f.properties.sido ?? "서울") === (p.sido ?? "서울") && B.compatible(p.kind, f.properties.code))
          .map((f) => ({ f, s: B.nameScore(pn, B.normName(f.properties.name)), d: B.distKm({ lng: pt[0], lat: pt[1] }, B.centerOf(f.properties.bbox)) }))
          .filter((x) => x.s >= 0.5)
          .sort((a, b) => b.s - a.s)
          .slice(0, 5);
        if (cands.length) {
          L("이름 유사 구역", "점수 ≥ 0.5 (거리 조건: ≥0.8 이면 3km, 아니면 1km)");
          for (const x of cands) console.log(`     - ${x.f.properties.name} [${x.f.properties.code}] 점수 ${x.s.toFixed(2)} 거리 ${x.d.toFixed(2)}km → ${x.d <= (x.s >= 0.8 ? 3 : 1) ? "거리 통과 (동률·차이<0.15 로 미채택?)" : "거리 초과"}`);
        }
      }
    }
  });

  section("④ 서울주택정보마당 착공·이주완료 목록", () => {
    if (p.source !== "정보몽땅") {
      L("대상", "서울 정보몽땅 기록만 (서울시 목록)");
      return;
    }
    if (!housing) {
      L("캐시", "data/raw/housinginfo.json 없음");
      return;
    }
    L("자료 기준", `${housing.fetchedAt} · 착공 중 ${housing.cons.length}곳 · 이주완료 ${housing.moved?.length ?? 0}곳`);
    const show = (rows, label) => {
      const hits = rows.map((r) => ({ r, s: B.housingScore(r, p) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
      if (!hits.length) {
        L(label, "이름 점수 ≥ 0.5 인 행 없음");
        return;
      }
      for (const { r, s } of hits) {
        const best = B.bestHousingMatch(r, seoulProjects);
        const mine = best?.no === p.no;
        console.log(`  ${label.padEnd(8)} '${r.name}'${r.date ? ` ${r.date}` : ""}${r.type ? ` ${r.type}` : ""}${r.units ? ` ${r.units}세대` : ""} → 점수 ${s.toFixed(2)} ${mine ? "✓ 이 사업장에 매칭" : `✗ ${best ? `${best.no} ${best.name} 이 더 높음` : "매칭 없음"}`}`);
      }
    };
    show(housing.cons, "착공 목록");
    show(housing.moved ?? [], "이주완료");
    L("결과", `cons ${p.cons ? `${p.cons.date}${p.cons.type ? ` ${p.cons.type}` : ""}${p.cons.units ? ` ${p.cons.units}세대` : ""}` : "-"} · moved ${yes(p.moved)} · doneBy ${p.doneBy ?? "-"}`);
    const el = B.doneByHousingEligible({ ...p, doneBy: undefined, built: undefined, useApr: undefined });
    L("준공 추정 조건", `${el.ok ? "충족" : "불충족"} — ${el.reason}`);
  });

  await (async () => {
    H("⑤ 건축물대장 총괄표제부 (국토부 건축HUB)");
    try {
      const el = B.registryEligible(p);
      L("대상", `${el.ok ? "예" : "아니오"} — ${el.reason}`);
      if (!el.ok) return;
      const code = B.emdCodeForProject(p);
      L("법정동 코드", code ?? "없음 → 조회 불가 (경기·인천은 위치 문구에서 동 이름을 못 찾은 경우)");
      if (!code) return;
      let rows = bldrgst.recap[code]?.rows ?? null;
      let at = bldrgst.recap[code]?.at;
      if (!rows && FETCH) {
        rows = await B.fetchRecapTitles(code, bldrgst);
        at = "지금 조회";
      }
      if (!rows) {
        L("캐시", `없음 (${FETCH ? "조회 실패 — DATA_GO_KR_KEY 확인" : "--fetch 로 조회 가능"})`);
        return;
      }
      const { minDay, why } = B.registryMinDay(p);
      L("법정동 총괄표제부", `${rows.length}행 (캐시 ${at})`);
      L("사용승인 하한", `${minDay} ← ${why.join(" / ")}`);
      const dated = rows.filter((r) => /^\d{8}$/.test(r.use));
      const after = dated.filter((r) => r.use > minDay);
      L("행 분포", `사용승인일 있음 ${dated.length} · 하한 이후 ${after.length} · 하한 이전 ${dated.length - after.length} · 날짜 없음 ${rows.length - dated.length}`);
      if (after.length) {
        console.log("  하한 이후 행마다 판정:");
        for (const r of after.sort((a, b) => b.hh - a.hh)) {
          const v = await B.registryRowCheck(p, z, r, minDay, { cacheOnly: !FETCH });
          console.log(`   ${v.ok ? "✓" : "✗"} ${r.plat.replace(/^서울특별시 |^경기도 |^인천광역시 /, "")} ${r.nm || "(이름 없음)"} 승인 ${r.use} ${r.hh}세대 ${r.dong ? `${r.dong}동 ` : ""}대지 ${fmtArea(r.pa)} → ${v.reason}`);
        }
      }
      L("결과", p.useApr ? `useApr ${p.useApr.date} ${p.useApr.name ?? ""} ${p.useApr.units ?? ""}세대` : "없음");
      if (!p.useApr && after.length === 0) L("해석", "이 법정동 대장에 하한 이후 사용승인 건이 없음 — 준공했다면 대장 생성·공개 지연(2024~25 준공 단지가 빠져 있는 사례 다수)");
    } catch (e) {
      console.log(`  (이 층을 설명하는 중 오류: ${e.message})`);
    }
  })();

  section("⑥ V-World 건물통합정보 신호", () => {
    if (!zp) {
      L("대상", "구역 도형이 없어 검사 안 함");
      return;
    }
    if (zp.src === "parcel") L("주의", "필지 도형은 건물 판별 뒤에 만들어져 실제로는 검사 대상이 아님 (옛 고층 단지 오판 위험으로 유지)");
    const linked = linkedByFid.get(zp.fid) ?? [];
    const cand = B.builtCandidacy(zp, linked.length ? linked.map((q) => ({ ...q, built: undefined })) : undefined);
    L("후보 조건", `${cand.ok ? "충족" : "불충족"} — ${cand.reason}`);
    const key = `${zp.fid}|${zp.ntfc}`;
    const r = builtCache[key];
    if (!r) {
      L("캐시", `없음 (키 ${key}) — 검사되지 않았거나 조회 실패`);
    } else {
      L("건물 동수", `구역 안 건물 ${r.n}동, 신축 고층(10층↑·대장 미결합 또는 고시+1년 이후 승인) ${r.tall}동`);
      L("판정", `${yes(B.builtVerdict(r.tall, zp.area))} (tall≥3 또는 tall≥1 & 면적<1만㎡) · 구역 built ${zp.built ?? "-"} · 사업장 built ${yes(p.built)}`);
      if (!B.builtVerdict(r.tall, zp.area) && r.n > 0) L("해석", "구역 안 건물이 옛 것뿐 — V-World 건물 자료는 수년 늦어 최근(2022~) 준공 단지는 아직 없음");
    }
  });

  section("⑦ 통합 전 옛 기록(stale)", () => {
    if (p.stale) {
      const s = projects.find((q) => q.no === p.stale);
      L("옛 기록", `→ 후속 기록 ${p.stale} ${s?.name ?? "?"} [${s?.stage ?? "?"}]`);
      return;
    }
    if (p.source !== "정보몽땅") {
      L("대상", "정보몽땅 기록만");
      return;
    }
    if (!B.EARLY_STAGE(p.stage)) {
      L("대상", "초기 단계(시행 이전) 기록만 검사 — 해당 없음");
      return;
    }
    const done = seoulProjects.filter((q) => q.no !== p.no && B.kindClass(q.kind) === B.kindClass(p.kind) && (B.DONE_STAGE(q.stage) || q.built || q.doneBy || q.useApr));
    const groupKey = (fid) => zoneByFid.get(fid)?.properties.dupOf ?? fid;
    const near = done.filter((q) => (p.zoneFid && q.zoneFid && groupKey(p.zoneFid) === groupKey(q.zoneFid)) || (p.lat != null && q.lat != null && B.distKm(p, q) <= 0.5));
    if (!near.length) {
      L("후속 후보", "같은 구역 그룹·500 m 안에 같은 유형의 완료 기록 없음");
      return;
    }
    for (const q of near) console.log(`   - ${q.no} ${q.name} [${q.stage}] 이름 관계 ${yes(B.staleNameRelation(p, q))} (${B.lightName(p.name)} ↔ ${B.lightName(q.name)})`);
  });

  section("⑦-2 서울플랜+ 추진단계(plan)", () => {
    if (!p.plan) {
      L("서울플랜+", p.source === "서울플랜+" ? "(이 기록 자체가 서울플랜+ 출처)" : "같은 사업으로 묶인 서울플랜+ 기록 없음 (도형 IoU≥0.5 또는 좌표 포함 + 유형 호환)");
      return;
    }
    L("사업유형", `${p.plan.type}${p.plan.code ? ` (${p.plan.code})` : ""}`);
    L("현재 단계", `${p.plan.stage}${p.plan.date ? ` · ${p.plan.date}` : ""}${p.plan.ended ? "  ← 취소·해제·중단 → 보정 planEnd 로 완공 처리" : ""}`);
    L("도형 코드", p.plan.sn);
    for (const h of p.plan.history ?? []) console.log(`     - ${h.date} ${h.stage}`);
  });

  section("⑧ 최근 동향(note)", () => {
    if (!p.note) {
      L("동향", "없음 (정보몽땅 고시/공고 최근 글에 구역명 없음 / 경기 인가일 없음)");
      return;
    }
    L("동향", `${p.note.kw} · ${p.note.date} (${p.note.src})${p.note.title ? ` — ${p.note.title}` : ""}`);
  });

  section("⑨ 최종 분류 (앱)", () => {
    const ex = explainStage(p);
    L("원자료", `'${ex.raw}'${ex.rawDone ? " (완료)" : ""}`);
    L("보정", ex.correction ? `${ex.correction.id} — ${ex.correction.text}  ← ${ex.correction.src}` : "없음");
    L("표시 문자열", `'${ex.decorated}'`);
    L("세부 단계", `${ex.group}  ← 규칙 ${ex.rule.id}: ${ex.rule.desc}`);
    L("국면", `${ex.phase}${ex.phase === "완공" ? " (기본 숨김 — '완공' 칩)" : ""}`);
    L("라벨·배지", `'${ex.label}'${ex.correction ? ` (원자료 ${ex.raw})` : ""}`);
    if (zp) {
      const linked = linkedByFid.get(zp.fid) ?? [];
      const dec = linked.map((q) => ({ ...q, stage: decorateStage(q) }));
      const st = zoneStatus(zp, dec);
      L("구역 상태", `${st} ← 연결 ${dec.length}건 ${dec.map((q) => `[${explainStage(q).phase}]`).join("")}${zp.built ? " · built" : ""} · 고시 ${zoneYear(zp.ntfc) ?? "미상"}`);
    }
  });

  section("⑩ 정답 비교 (data/truth.json)", () => {
    const t = truth.find((x) => x.no === p.no);
    if (!t) {
      L("정답", "등록 안 됨 — 확인했다면 truth.json 에 { no, name, truth, note, checkedAt } 추가");
      return;
    }
    const v = appVerdict(p);
    L("정답", `${t.truth} (${t.checkedAt}) ${t.note ? `— ${t.note}` : ""}`);
    L("앱", `${v} → ${v === t.truth ? "일치 ✓" : "불일치 ✗"}`);
  });
}

for (const p of targets) await explain(p);
console.log("");
