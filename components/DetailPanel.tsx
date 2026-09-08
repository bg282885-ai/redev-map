"use client";
import { useEffect, useState } from "react";
import type { GosiItem, Project, ProjectSummary, Selection, ZoneFeature } from "@/lib/types";
import {
  CATEGORY_COLOR, STAGE_COLOR, codeLabel, correctionOf, dongOf, fmtArea, guName, kindShort, ntfcDate, rawStage, stageGroup, stageLabel, zoneCategory,
} from "@/lib/zones";
import * as links from "@/lib/links";

type Props = {
  sel: Selection;
  zone: ZoneFeature | null;
  project: Project | null;
  /** project 가 통합 전 옛 기록(stale)일 때 같은 현장의 현재(완료) 기록 */
  successor?: Project | null;
  zoneProjects: Project[];
  onClose: () => void;
  onSelectProject: (no: number) => void;
  onSelectZone: (fid: string) => void;
  onFocus: () => void;
};

type NtfcDetail = {
  code: string; title: string; no: string; date: string; org: string; phone: string; location: string; content: string;
  fileUrl?: string; fileName?: string; drawings: { name: string; url: string }[]; pageUrl: string;
};

/* 비동기 조회 결과는 "어떤 키로 조회했는지"를 함께 들고 있어, 키가 바뀌면 자동으로 로딩 상태가 된다 */
type GosiState = { key: string; items: GosiItem[]; errors: string[] };
type SumState = { key: string; data: ProjectSummary | null; error: string };
type NtfcState = { key: string; data: NtfcDetail | null; error: string };

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export default function DetailPanel({ sel, zone, project, successor, zoneProjects, onClose, onSelectProject, onSelectZone, onFocus }: Props) {
  const [gosi, setGosi] = useState<GosiState>({ key: "", items: [], errors: [] });
  const [sum, setSum] = useState<SumState>({ key: "", data: null, error: "" });
  const [ntfc, setNtfc] = useState<NtfcState>({ key: "", data: null, error: "" });
  const [copied, setCopied] = useState(false);

  const zp = zone?.properties ?? null;
  const cat = zp ? zoneCategory(zp.code) : null;
  const title = project?.name ?? zp?.name ?? "";
  const sido = project?.sido ?? zp?.sido ?? "서울";
  const dong = dongOf(project?.jibun || project?.loc);
  const guCode = project?.guCode ?? (zp && !zp.gu.endsWith("000") ? zp.gu : null);
  const guNm = project?.gu ?? (zp ? guName(zp.gu) : "");
  const gosiKey = `${project?.no ?? ""}|${zp?.fid ?? ""}`;
  const cafe = project?.cafe ?? "";

  const gosiLoading = gosi.key !== gosiKey;
  const gosiItems = gosiLoading ? [] : gosi.items;
  const gosiErrors = gosiLoading ? [] : gosi.errors;
  /* 최신 고시: 구역명이 맞는(score≥2) 항목 중 가장 최근 것 */
  const latest = gosiItems.filter((x) => x.score >= 2).sort((a, b) => b.date.localeCompare(a.date))[0] ?? null;
  /* 결정고시 원문은 서울 도시계획포털만 제공 — 검색된 최신 포털 고시 코드가 있으면 그것, 없으면 경계 자료의 고시 코드 */
  const latestPortalCode = gosiItems.filter((x) => x.code && x.score >= 2).sort((a, b) => b.date.localeCompare(a.date))[0]?.code ?? "";
  const shpCode = zp?.ntfc && /^11\d{3}NTC\d{12}$/.test(zp.ntfc) ? zp.ntfc : "";
  const ntfcCode = gosiLoading ? "" : latestPortalCode || shpCode;

  /* 관련 고시·공고 */
  useEffect(() => {
    const names = [project?.name, zp?.name].filter((s): s is string => !!s);
    if (!names.length) return;
    const ac = new AbortController();
    const sp = new URLSearchParams();
    names.forEach((n) => sp.append("n", n));
    if (dong) sp.set("dong", dong);
    if (guCode) sp.set("gu", guCode);
    sp.set("sido", sido);
    fetch(`/api/gosi?${sp}`, { signal: ac.signal })
      .then((r) => r.json())
      .then((j: { items?: GosiItem[]; errors?: string[] }) => setGosi({ key: gosiKey, items: j.items ?? [], errors: j.errors ?? [] }))
      .catch((e) => {
        if (!ac.signal.aborted) setGosi({ key: gosiKey, items: [], errors: [errMsg(e)] });
      });
    return () => ac.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gosiKey]);

  /* 정보몽땅 사업개요 */
  useEffect(() => {
    if (!cafe) return;
    const ac = new AbortController();
    fetch(`/api/project?cafe=${encodeURIComponent(cafe)}`, { signal: ac.signal })
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        return j as ProjectSummary;
      })
      .then((d) => setSum({ key: cafe, data: d, error: "" }))
      .catch((e) => {
        if (!ac.signal.aborted) setSum({ key: cafe, data: null, error: errMsg(e) });
      });
    return () => ac.abort();
  }, [cafe]);

  /* 결정고시 상세 (도시계획포털) */
  useEffect(() => {
    if (!ntfcCode) return;
    const ac = new AbortController();
    fetch(`/api/ntfc?code=${ntfcCode}`, { signal: ac.signal })
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
        return j as NtfcDetail;
      })
      .then((d) => setNtfc({ key: ntfcCode, data: d, error: "" }))
      .catch((e) => {
        if (!ac.signal.aborted) setNtfc({ key: ntfcCode, data: null, error: errMsg(e) });
      });
    return () => ac.abort();
  }, [ntfcCode]);

  const sumLoading = !!cafe && sum.key !== cafe;
  const sumData = !sumLoading && cafe ? sum.data : null;
  const sumError = !sumLoading && cafe ? sum.error : "";
  const ntfcLoading = !!ntfcCode && ntfc.key !== ntfcCode;
  const ntfcData = !ntfcLoading && ntfcCode ? ntfc.data : null;
  const ntfcError = !ntfcLoading && ntfcCode ? ntfc.error : "";

  const share = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  };

  /* 도시계획포털 지도 팝업은 서울 결정고시 코드(11xxxAGZ…)만 */
  const mapCodeRaw = project?.map ?? zp?.id ?? null;
  const mapCode = mapCodeRaw && /^11\d{3}AGZ/.test(mapCodeRaw) ? mapCodeRaw : null;
  const searchName = project?.name ?? zp?.name ?? "";
  const strong = gosiItems.filter((x) => x.score >= 2);
  const weak = gosiItems.filter((x) => x.score < 2);

  return (
    <section
      className="rm-scroll absolute inset-x-0 bottom-0 z-20 flex max-h-[62vh] flex-col overflow-hidden rounded-t-2xl border border-gray-200 bg-white shadow-[0_-4px_24px_rgba(0,0,0,.12)] lg:inset-auto lg:right-3 lg:top-3 lg:bottom-3 lg:max-h-none lg:w-[430px] lg:rounded-xl lg:shadow-lg"
      aria-label="상세 정보"
    >
      {/* 헤더 */}
      <div className="flex items-start gap-2 border-b border-gray-100 px-4 pt-3 pb-2">
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            {project && (
              <span className="badge" style={{ background: "#111", color: "#fff" }}>
                {kindShort(project.kind)}
              </span>
            )}
            {zp && cat && (
              <span className="badge" style={{ background: CATEGORY_COLOR[cat], color: "#fff" }}>
                {codeLabel(zp.code)}
              </span>
            )}
            {project?.stage && (
              // 보정이 있으면 배지는 보정 결과("준공 2026-03")를 먼저, 원자료 단계는 옆 회색 배지로 (2026-09-08 라벨·배지 정리)
              <>
                <span className="badge" style={{ background: STAGE_COLOR[stageGroup(project.stage)], color: "#fff" }} title={project.stage}>
                  {stageLabel(project)}
                </span>
                {correctionOf(project) && (
                  <span className="badge bg-gray-100 text-gray-500" title={`${project.source ?? "원자료"} 진행단계: ${rawStage(project.stage) || "미기재"} — ${correctionOf(project)?.src ?? ""}`}>
                    원자료 {rawStage(project.stage) || "미기재"}
                  </span>
                )}
              </>
            )}
          </div>
          <h2 className="text-[15px] font-bold leading-snug text-gray-900">{title || "(이름 없음)"}</h2>
          <p className="mt-0.5 text-xs text-gray-500">
            {project
              ? /^(서울특별시|경기도|인천광역시)/.test(project.loc ?? "")
                ? project.loc
                : `${sido !== "서울" ? `${sido} ` : ""}${project.gu} ${project.loc || project.jibun}`
              : zp
                ? `${zp.sido && zp.sido !== "서울" ? `${zp.sido} ` : ""}${guName(zp.gu)} · 결정고시 ${ntfcDate(zp.ntfc) || "-"}`
                : ""}
            {project && zp && project.zoneHow && (
              <span className="ml-1 text-gray-400">
                · {project.zoneHow === "parcel" ? "경계: 대표지번 필지 (정비구역 미지정)" : project.zoneHow === "special" ? "경계: 지구단위계획 특별계획구역 (정비구역 미지정)" : project.zoneHow === "seoulplan" ? "경계: 서울플랜+ 모아타운 대상지·관리지역" : `구역 연결: ${project.zoneHow === "map" ? "고시코드" : project.zoneHow === "point" ? "지번 위치" : "구역명"}`}
              </span>
            )}
          </p>
          {project?.note && (
            <p className="mt-0.5 text-xs text-emerald-700" title={project.note.title ?? ""}>
              최근 동향: <span className="font-semibold">{project.note.kw}</span> · {project.note.date.slice(0, 7)}
              {project.note.url ? (
                <a href={project.note.url} target="_blank" rel="noreferrer" className="ml-1 text-gray-400 underline hover:text-brand">
                  {project.note.src} 공고
                </a>
              ) : (
                <span className="ml-1 text-gray-400">({project.note.src} 추진현황)</span>
              )}
            </p>
          )}
          {project?.stale && (
            <p className="mt-1 rounded bg-amber-50 px-2 py-1 text-[11.5px] leading-snug text-amber-800">
              통합 전 옛 기록입니다. 이 현장은{" "}
              {successor ? (
                <>
                  <button onClick={() => onSelectProject(successor.no)} className="font-semibold underline hover:text-brand">
                    {successor.name}
                  </button>
                  ({successor.stage})
                </>
              ) : (
                "다른 기록"
              )}
              으로 사업이 끝났는데 정보몽땅에 이 기록이 갱신되지 않고 남아 있어 완공으로 분류했습니다.
            </p>
          )}
          {project?.useApr && (
            <p className="mt-1 rounded bg-emerald-50 px-2 py-1 text-[11.5px] leading-snug text-emerald-800">
              건축물대장에서 준공이 확인됐습니다: <span className="font-semibold">{project.useApr.name || "새 공동주택"}</span> 사용승인 {project.useApr.date}
              {project.useApr.units ? ` · ${project.useApr.units.toLocaleString()}세대` : ""}
              {project.useApr.dongs ? ` ${project.useApr.dongs}동` : ""}. 정보몽땅 단계는 &apos;{project.stage.split(" · ")[0]}&apos;에 머물러 있어 완공으로 분류했습니다.
              <span className="ml-1 text-emerald-600">(국토부 건축HUB 총괄표제부)</span>
            </p>
          )}
          {project?.built && !project.useApr && (
            <p className="mt-1 rounded bg-emerald-50 px-2 py-1 text-[11.5px] leading-snug text-emerald-800">
              구역 안에 신축 고층 건물이 확인되어(GIS건물통합정보) 준공된 것으로 보고 완공으로 분류했습니다. 원자료 단계는 &apos;{rawStage(project.stage)}&apos;에 머물러 있습니다.
            </p>
          )}
          {project?.doneBy === "정보마당" && !project.useApr && (
            <p className="mt-1 rounded bg-amber-50 px-2 py-1 text-[11.5px] leading-snug text-amber-800">
              정보몽땅 단계는 &apos;{project.stage.split(" · ")[0]}&apos;이지만, 서울시가 반기마다 내는 착공 중 구역 목록(서울주택정보마당 관리처분-착공 현황)과 이주완료 목록에 이 구역이 없어
              준공된 것으로 보고 완공으로 분류했습니다.
            </p>
          )}
          {project?.cons && (
            <p className="mt-0.5 text-xs text-gray-500">
              서울시 착공 현황: <span className="font-semibold text-gray-700">{project.cons.date} 착공</span>
              {project.cons.type ? ` · ${project.cons.type}` : ""}
              {project.cons.units ? ` · 공급 ${project.cons.units}세대` : ""}
              <span className="ml-1 text-gray-400">(서울주택정보마당)</span>
            </p>
          )}
          {project?.moved && !project.cons && <p className="mt-0.5 text-xs text-gray-500">서울시 이주완료 구역 목록에 있습니다 (서울주택정보마당, 착공 전).</p>}
        </div>
        <button onClick={onFocus} className="btn !px-2" title="지도에서 보기" aria-label="지도에서 보기">
          ◎
        </button>
        <button onClick={onClose} className="btn !px-2" title="닫기 (Esc)" aria-label="닫기">
          ✕
        </button>
      </div>

      <div className="rm-scroll min-h-0 flex-1 overflow-y-auto px-4 pb-6">
        {/* 바로가기 */}
        <div className="mt-3 flex flex-wrap gap-1.5">
          {project?.cafe && (
            <a className="btn primary" href={links.cleanupCafe(project.cafe)} target="_blank" rel="noreferrer">
              정보몽땅 사업장
            </a>
          )}
          {mapCode && (
            <a className="btn" href={links.urbanMap(mapCode)} target="_blank" rel="noreferrer">
              도시계획포털 지도
            </a>
          )}
          {project?.source === "경기도" && (
            <a className="btn primary" href={links.ggOnnuri()} target="_blank" rel="noreferrer">
              경기도 정비사업 온누리
            </a>
          )}
          {project?.source === "인천시" && (
            <a className="btn primary" href={links.icRenewal()} target="_blank" rel="noreferrer">
              인천 정비사업 정보시스템
            </a>
          )}
          {project && (project.jibun || project.loc) && (
            <a className="btn" href={links.siteLaw({ ...project, jibun: project.jibun || project.loc || "" })} target="_blank" rel="noreferrer">
              대지 법령 검토
            </a>
          )}
          {project?.lat != null && project.lng != null && (
            <a className="btn" href={links.naverMap(project.lat, project.lng, project.name)} target="_blank" rel="noreferrer">
              네이버지도
            </a>
          )}
          <a className="btn" href={links.newsSearch(searchName)} target="_blank" rel="noreferrer">
            뉴스
          </a>
          <button className="btn" onClick={share}>
            {copied ? "복사됨 ✓" : "링크 복사"}
          </button>
        </div>

        {/* 구역 정보 */}
        {project && project.source !== "정보몽땅" && (
          <Card title={`사업 현황 (${project.source})`}>
            <Row k="구역명" v={project.name} />
            <Row k="위치" v={project.loc || "-"} />
            {project.area ? <Row k="구역면적" v={fmtArea(project.area)} /> : null}
            <Row k="사업유형" v={project.kind || "-"} />
            <Row k="진행단계" v={project.stage || "-"} />
            {project.docs ? <Row k="세대수" v={project.docs} /> : null}
            {(project.extra ?? []).map(([k, v]) => (
              <Row key={k} k={k} v={v} />
            ))}
            <p className="mt-1 text-[11px] text-gray-400">
              {project.source === "경기도"
                ? "경기도 일반 정비사업 추진현황(공공데이터포털)"
                : project.source === "1기신도시"
                  ? "국토교통부 1기 신도시 선도지구 선정(2024-11-27)과 각 시의 특별정비구역 지정 고시·발표를 정리한 목록(노후계획도시정비특별법). 경계는 구성 단지의 대표지번 필지를 합친 것"
                  : project.source === "모아타운"
                    ? "서울플랜+(도시계획포털 도시계획사업 현황)의 모아타운 대상지·관리지역 도형과 추진단계, 소규모주택정비 관리계획(모아타운 관리계획) 승인 고시, 서울시 모아타운 대상지 현황을 합친 것. 서울플랜+에 아직 없는 최근 대상지는 대표지번 점만 표시하며, 법적 경계는 고시 원문의 지형도면"
                    : "인천광역시 도시 및 주거환경 정비사업 추진현황(공공데이터포털, 월간)"}{" "}
              기준.
              {project.locSrc === "geocode" ? " 마커는 위치 열의 첫 지번을 지오코딩한 지점입니다." : ""}
              {project.locSrc === "place" ? " 원자료에 위치(지번)가 없어 마커는 단지명으로 검색한 지점입니다." : ""}
              {project.locSrc === "emd" ? " 준공 후 지번이 합병되어 옛 지번을 찾을 수 없어, 마커는 법정동 중심에 표시한 대략 위치입니다." : ""}
            </p>
          </Card>
        )}

        {zp && zp.src === "parcel" && (
          <Card title="단지 경계 (대표지번 필지)">
            <Row k="필지" v={zp.jibun || "-"} />
            <Row k="대지면적" v={fmtArea(zp.area)} />
            {zp.pnu && <Row k="PNU" v={zp.pnu} mono />}
            <p className="mt-1 text-[11px] text-gray-400">
              정비구역이 아직 지정되지 않았거나 서울시 구역 자료에 없는 단지입니다. 표시한 경계는 V-World 연속지적도의 대표지번 필지(대지)이며, 정비구역 경계가 아닙니다.
            </p>
          </Card>
        )}
        {zp && zp.src === "special" && (
          <Card title="특별계획구역 경계 (지구단위계획)">
            <Row k="구역명" v={zp.name || "-"} />
            <Row k="면적" v={fmtArea(zp.area)} />
            <Row k="결정고시" v={ntfcDate(zp.ntfc) ? `${ntfcDate(zp.ntfc)} (${zp.ntfc})` : zp.ntfc || "-"} />
            <p className="mt-1 text-[11px] text-gray-400">
              정비구역이 아직 지정되지 않은 단지입니다. 표시한 경계는 서울시 지구단위계획구역(특별계획구역) 공간정보(열린데이터광장 OA-21164)의 특별계획구역이며, 앞으로 결정될 정비구역과 다를 수 있습니다.
            </p>
          </Card>
        )}
        {zp && zp.src === "seoulplan" && (
          <Card title="모아타운 구역 (서울플랜+)" onTitleClick={sel.type === "project" ? () => onSelectZone(zp.fid) : undefined}>
            <Row k="구역명" v={zp.name || "-"} />
            <Row k="면적" v={fmtArea(zp.area)} />
            <Row k="도형 코드" v={zp.fid} mono />
            <p className="mt-1 text-[11px] text-gray-400">
              서울시 도시계획포털 서울플랜+ &apos;도시계획사업 현황&apos;의 모아타운 도형입니다. 관리계획이 승인(관리지역 지정)된 곳은 고시된 관리지역 경계이고, 대상지 선정·자문·심의 단계인 곳은
              검토 범위라 승인 때 경계가 바뀔 수 있습니다. 법적 경계는 고시문의 지형도면이 기준입니다.{" "}
              <a href={links.seoulPlanMoatown()} target="_blank" rel="noreferrer" className="underline hover:text-brand">
                서울플랜+ 모아타운
              </a>
            </p>
            {zoneProjects.length > 1 && sel.type === "project" && (
              <p className="mt-1 text-[11px] text-gray-500">이 구역에 사업장 {zoneProjects.length}건이 연결되어 있습니다.</p>
            )}
          </Card>
        )}
        {zp && zp.src !== "parcel" && zp.src !== "special" && zp.src !== "seoulplan" && (
          <Card title="정비구역" onTitleClick={sel.type === "project" ? () => onSelectZone(zp.fid) : undefined}>
            <Row k="구역명" v={zp.name || "-"} />
            <Row k="유형" v={codeLabel(zp.code)} />
            <Row k="면적" v={fmtArea(zp.area)} />
            <Row k="결정고시" v={ntfcDate(zp.ntfc) ? `${ntfcDate(zp.ntfc)} (${zp.ntfc})` : zp.ntfc || "-"} />
            <Row k="관리코드" v={zp.id} mono />
            {zp.dups?.length ? (
              <p className="mt-1 text-[11px] text-gray-400">
                서울시 구역 자료에 같은 경계의 도형이 고시 차수별로 {zp.dups.length + 1}개 있어 최신 고시 도형만 표시합니다. 이전 고시:{" "}
                {zp.dups.map((n) => ntfcDate(n) || "일자 미상").join(", ")}
              </p>
            ) : null}
            {zp.src === "vworld" && (
              <p className="mt-1 text-[11px] text-gray-400">V-World 지구단위계획구역(UPIS) 레이어에서 정비구역 이름으로 찾은 경계입니다. 정비구역 지정 시 함께 결정된 지구단위계획구역 경계라 정비구역과 다를 수 있습니다.</p>
            )}
            {zp.built && zoneProjects.length === 0 && (
              <p className="mt-1 text-[11px] text-emerald-700">
                구역 안에 신축 고층 건물 {zp.builtN ?? 0}동이 있어(GIS건물통합정보) 준공된 것으로 보고 &apos;완공&apos;으로 분류했습니다. 연결된 사업장 정보는 없습니다.
              </p>
            )}
            {zp.built === false && zoneProjects.length === 0 && (
              <p className="mt-1 text-[11px] text-gray-400">정보몽땅·경기·인천 사업장 목록에 연결된 사업장이 없고, 구역 안에 신축 고층 건물도 확인되지 않아 진행 중(또는 정체)으로 봅니다.</p>
            )}
            {zoneProjects.length > 1 && sel.type === "project" && (
              <p className="mt-1 text-[11px] text-gray-500">이 구역에 사업장 {zoneProjects.length}건이 연결되어 있습니다.</p>
            )}
          </Card>
        )}
        {!zp && project && (
          <Card title="정비구역">
            <p className="text-xs text-gray-500">
              {sido === "서울"
                ? "서울시 의제처리구역 자료에서 대응하는 구역 폴리곤을 찾지 못했습니다. 정비구역 지정 전(정비계획 수립·안전진단 단계)이거나 가로주택·소규모 사업일 수 있습니다."
                : `${sido} 정비구역 경계는 공개 파일이 없어, V-World 지구단위계획 레이어에 정비구역 이름으로 올라온 곳만 표시됩니다. 경계는 토지이음(토지이용계획 열람)에서 지번으로 확인할 수 있습니다.`}
              {project.locSrc === "geocode" ? " 마커는 대표지번 위치입니다." : project.locSrc === "place" ? " 마커는 단지명으로 검색한 위치입니다." : project.locSrc === "emd" ? " 마커는 법정동 중심의 대략 위치입니다(옛 지번 합병)." : ""}
            </p>
          </Card>
        )}

        {/* 최신 고시 한 줄 */}
        {!gosiLoading && latest && (
          <div className="mt-3 rounded-lg border border-orange-200 bg-orange-50/60 p-3">
            <div className="mb-1 flex items-center gap-1.5 text-[11px] text-gray-500">
              <span className="badge bg-brand text-white">최신 고시</span>
              <span className="font-semibold text-gray-700">{latest.date}</span>
              <span>· {latest.source}</span>
              {latest.org && <span className="truncate">· {latest.org}</span>}
            </div>
            <a href={latest.url} target="_blank" rel="noreferrer" className="text-[13px] font-semibold leading-snug text-gray-900 hover:text-brand hover:underline">
              {latest.title}
            </a>
            {zp?.ntfc && ntfcDate(zp.ntfc) && ntfcDate(zp.ntfc) < latest.date && (
              <p className="mt-1 text-[11px] text-gray-500">경계 자료의 결정고시({ntfcDate(zp.ntfc)}) 이후에 나온 고시입니다. 경계·계획이 바뀌었을 수 있습니다.</p>
            )}
          </div>
        )}

        {/* 결정고시 원문 */}
        {(ntfcCode || (gosiLoading && shpCode)) && (
          <Card title={`${latestPortalCode && latestPortalCode !== shpCode ? "최신 " : ""}결정고시 원문 (서울 도시계획포털)`}>
            {(ntfcLoading || (gosiLoading && shpCode)) && (
              <div className="space-y-1.5">
                <div className="skel h-3.5 w-full" />
                <div className="skel h-3.5 w-2/3" />
              </div>
            )}
            {ntfcError && <p className="text-xs text-gray-500">고시 상세를 불러오지 못했습니다 ({ntfcError}).</p>}
            {ntfcData && (
              <>
                <p className="text-[13px] font-semibold leading-snug text-gray-800">{ntfcData.title || "(제목 없음)"}</p>
                <p className="mt-0.5 text-[12px] text-gray-500">
                  {ntfcData.no ? `서울특별시고시 제${ntfcData.no}호` : ""}
                  {ntfcData.date ? ` · ${ntfcData.date}` : ""}
                  {ntfcData.org ? ` · ${ntfcData.org}` : ""}
                </p>
                {ntfcData.content && <p className="mt-1.5 line-clamp-4 text-[12px] leading-relaxed text-gray-600">{ntfcData.content}</p>}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {ntfcData.fileUrl && (
                    <a className="btn primary" href={ntfcData.fileUrl} target="_blank" rel="noreferrer" title={ntfcData.fileName}>
                      고시문 열기 ({(ntfcData.fileName ?? "").split(".").pop()?.toUpperCase()})
                    </a>
                  )}
                  <a className="btn" href={ntfcData.pageUrl} target="_blank" rel="noreferrer">
                    포털 상세
                  </a>
                </div>
                {ntfcData.drawings.length > 0 && (
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-gray-500">고시 도면 {ntfcData.drawings.length}장</summary>
                    <ul className="mt-1 space-y-0.5">
                      {ntfcData.drawings.map((d) => (
                        <li key={d.url}>
                          <a href={d.url} target="_blank" rel="noreferrer" className="text-[12px] text-blue-700 hover:underline">
                            {d.name}
                          </a>
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </>
            )}
          </Card>
        )}

        {/* 구역에 연결된 사업장 (구역 선택 시) */}
        {sel.type === "zone" && (
          <Card title={`사업장 (정보몽땅) ${zoneProjects.length}건`}>
            {zoneProjects.length === 0 ? (
              <p className="text-xs text-gray-500">정보몽땅에 연결된 사업장이 없습니다. 아래 고시·공고와 검색 링크로 확인하세요.</p>
            ) : (
              <ul className="divide-y divide-gray-100">
                {zoneProjects.map((p) => (
                  <li key={p.no}>
                    <button onClick={() => onSelectProject(p.no)} className="flex w-full items-start gap-2 py-1.5 text-left hover:bg-gray-50">
                      <span className="mt-1 inline-block h-2.5 w-2.5 flex-none rounded-full" style={{ background: STAGE_COLOR[stageGroup(p.stage)] }} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-semibold text-gray-800">{p.name}</span>
                        <span className="block text-[11px] text-gray-500">
                          {kindShort(p.kind)} · {stageLabel(p)}
                          {correctionOf(p) ? ` (원자료 ${rawStage(p.stage) || "미기재"})` : ""} · {p.jibun}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}

        {/* 사업 개요 */}
        {cafe && (
          <Card title="사업 개요 (정보몽땅)">
            {sumLoading && (
              <div className="space-y-1.5">
                <div className="skel h-3.5 w-3/4" />
                <div className="skel h-3.5 w-2/3" />
                <div className="skel h-3.5 w-1/2" />
              </div>
            )}
            {sumError && <p className="text-xs text-red-600">불러오지 못했습니다: {sumError}</p>}
            {sumData && (
              <>
                {sumData.fields.length === 0 ? (
                  <p className="text-xs text-gray-500">공개된 사업개요가 없습니다.</p>
                ) : (
                  sumData.fields.map(([k, v]) => <Row key={k} k={k} v={v} />)
                )}
                {(sumData.images.loc || sumData.images.sce) && (
                  <div className="mt-2 flex gap-2">
                    {sumData.images.loc && <Thumb src={sumData.images.loc} label="위치도" />}
                    {sumData.images.sce && <Thumb src={sumData.images.sce} label="조감도" />}
                  </div>
                )}
              </>
            )}
          </Card>
        )}

        {/* 관련 고시·공고 */}
        <Card title={`관련 고시·공고${gosiLoading ? "" : ` ${strong.length}건`}`}>
          {gosiLoading && (
            <div className="space-y-1.5">
              <div className="skel h-3.5 w-full" />
              <div className="skel h-3.5 w-5/6" />
              <div className="skel h-3.5 w-4/6" />
              <p className="pt-1 text-[11px] text-gray-400">정보몽땅 게시판과 토지이음 고시정보를 읽는 중… (첫 조회는 수 초)</p>
            </div>
          )}
          {!gosiLoading && strong.length === 0 && (
            <p className="text-xs text-gray-500">최근 목록에서 구역명이 들어간 고시·공고를 찾지 못했습니다. 아래 검색 링크를 이용하세요.</p>
          )}
          {!gosiLoading && strong.length > 0 && <GosiList items={strong} />}
          {!gosiLoading && weak.length > 0 && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs text-gray-500">{dong || "같은 동"} 관련 최근 고시 {weak.length}건</summary>
              <GosiList items={weak} />
            </details>
          )}
          {gosiErrors.length > 0 && <p className="mt-1 text-[11px] text-amber-600">일부 출처 조회 실패: {gosiErrors.join(" / ")}</p>}
          <div className="mt-3 flex flex-wrap gap-1.5">
            {sido === "서울" && (
              <a className="chip" href={links.cleanupBoard(guCode)} target="_blank" rel="noreferrer">
                정보몽땅 고시/공고
              </a>
            )}
            {sido === "서울" && (
              <a className="chip" href={links.urbanGosiSearch()} target="_blank" rel="noreferrer">
                도시계획포털 결정고시
              </a>
            )}
            <a className="chip" href={links.eumGosiList()} target="_blank" rel="noreferrer">
              토지이음 고시정보
            </a>
            <a className="chip" href={links.sidoGosiSearch(sido, searchName)} target="_blank" rel="noreferrer">
              {sido === "서울" ? "서울시" : sido === "경기" ? "경기도" : "인천시"} 고시 검색
            </a>
            {guNm && !/^(서울시|경기도|인천시)$/.test(guNm) && (
              <a className="chip" href={links.guGosiSearch(guNm, searchName)} target="_blank" rel="noreferrer">
                {guNm} 고시 검색
              </a>
            )}
            <a className="chip" href={links.lawSearch(searchName)} target="_blank" rel="noreferrer">
              법제처 검색
            </a>
          </div>
        </Card>

        <p className="mt-4 text-[11px] leading-relaxed text-gray-400">
          출처: 서울시 의제처리구역 위치정보(열린데이터광장, 연 2회 갱신) · 정비사업 정보몽땅 · 서울 도시계획포털 · 경기도·인천시 정비사업 추진현황(공공데이터포털) ·
          V-World UPIS · 토지이음. 구역 경계와 정보는 참고용이며 법적 효력이 없습니다. 정확한 내용은 각 고시문과 사업장 공개자료를 확인하세요.
        </p>
      </div>
    </section>
  );
}

function Card({ title, children, onTitleClick }: { title: string; children: React.ReactNode; onTitleClick?: () => void }) {
  return (
    <div className="mt-3 rounded-lg border border-gray-200 p-3">
      <h3 className="mb-1.5 flex items-center text-[12px] font-bold tracking-wide text-gray-500">
        {onTitleClick ? (
          <button onClick={onTitleClick} className="hover:text-brand hover:underline">
            {title} ›
          </button>
        ) : (
          title
        )}
      </h3>
      {children}
    </div>
  );
}

function Row({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex gap-2 py-[3px] text-[12.5px] leading-snug">
      <span className="w-[86px] flex-none text-gray-500">{k}</span>
      <span className={`min-w-0 flex-1 break-words text-gray-800 ${mono ? "font-mono text-[11.5px]" : ""}`}>{v}</span>
    </div>
  );
}

function Thumb({ src, label }: { src: string; label: string }) {
  return (
    <a href={src} target="_blank" rel="noreferrer" className="block w-1/2 overflow-hidden rounded-md border border-gray-200">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={label} className="h-28 w-full object-cover" loading="lazy" />
      <span className="block bg-gray-50 px-2 py-1 text-center text-[11px] text-gray-600">{label} · 크게 보기</span>
    </a>
  );
}

function GosiList({ items }: { items: GosiItem[] }) {
  return (
    <ul className="divide-y divide-gray-100">
      {items.map((g) => (
        <li key={g.url} className="py-1.5">
          <a href={g.url} target="_blank" rel="noreferrer" className="group block">
            <span className="mb-0.5 flex items-center gap-1.5 text-[11px] text-gray-500">
              <span className={`badge ${g.source === "정보몽땅" ? "bg-orange-50 text-orange-700" : g.source === "도시계획포털" ? "bg-purple-50 text-purple-700" : "bg-blue-50 text-blue-700"}`}>
                {g.source}
              </span>
              <span>{g.date}</span>
              {g.org && <span>· {g.org}</span>}
              {g.no && g.source === "토지이음" && <span className="truncate">· {g.no}</span>}
            </span>
            <span className="text-[13px] leading-snug text-gray-800 group-hover:text-brand group-hover:underline">{g.title}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}
