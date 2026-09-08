"use client";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChangeLog, DataMeta, Project, RecentItem, Selection, Sido, ZoneCollection, ZoneFeature } from "@/lib/types";
import UpdatesPanel from "./UpdatesPanel";
import {
  CATEGORY_COLOR, CATEGORY_ORDER, KIND_LIST, OLD_ZONE_YEAR, PHASE_COLOR, PHASE_DESC, PHASE_ORDER, PHASE_STAGES, SIDO_LIST, STAGE_COLOR, STAGE_DESC,
  TAG_LIST, kindMatches, kindShort, normName, phaseOf, projectTags, stageGroup, zoneCategory, zoneStatus, zoneYear,
  type Phase, type StageGroup, type Tag, type ZoneCategory, type ZoneStatus,
} from "@/lib/zones";
import DetailPanel from "./DetailPanel";
import type { BaseKey, Focus } from "./MapView";

/** HAENGLIM 허브(홈) 주소 — 로컬은 .env.local 의 NEXT_PUBLIC_HUB_URL 로 바꿈 */
const HUB_URL = process.env.NEXT_PUBLIC_HUB_URL || "https://haenglim-hub.vercel.app";

const MapView = dynamic(() => import("./MapView"), {
  ssr: false,
  loading: () => <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-500">지도 불러오는 중…</div>,
});

const LIST_LIMIT = 300;

export default function MapApp() {
  const [zones, setZones] = useState<ZoneCollection | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [meta, setMeta] = useState<DataMeta | null>(null);
  const [loadErr, setLoadErr] = useState("");

  const [q, setQ] = useState("");
  const [sido, setSido] = useState<Sido | "">("");
  const [gu, setGu] = useState("");
  const [kinds, setKinds] = useState<Set<string>>(() => new Set());
  /* 진행 국면(초기·중기·후기·완공). 비어 있으면 완공을 뺀 전부 — 완공은 칩을 눌러야 보인다 */
  const [phases, setPhases] = useState<Set<Phase>>(() => new Set());
  /* 세부 단계(계획·추진위·…)를 고르면 국면 필터 대신 그것을 따른다 */
  const [stages, setStages] = useState<Set<StageGroup>>(() => new Set());
  const [stagesOpen, setStagesOpen] = useState(false);
  const [tags, setTags] = useState<Set<Tag>>(() => new Set());
  const [cats, setCats] = useState<Set<ZoneCategory>>(() => new Set());
  const [showZones, setShowZones] = useState(true);
  const [showMarkers, setShowMarkers] = useState(true);
  const [base, setBase] = useState<BaseKey>("vBase");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [listLimit, setListLimit] = useState(LIST_LIMIT);

  const [sel, setSel] = useState<Selection | null>(null);
  const [focus, setFocus] = useState<Focus | null>(null);

  /* ---------- 업데이트 알림 ---------- */
  const [updatesOpen, setUpdatesOpen] = useState(false);
  const [changes, setChanges] = useState<ChangeLog | null>(null);
  const [recent, setRecent] = useState<RecentItem[]>([]);
  const [recentLoaded, setRecentLoaded] = useState(false);
  const [seenAt, setSeenAt] = useState(""); // 마지막으로 알림을 연 시각 (localStorage)
  useEffect(() => {
    let alive = true;
    // localStorage 는 서버 렌더에 없으므로 마운트 뒤 비동기로 읽는다
    Promise.resolve().then(() => {
      try {
        if (alive) setSeenAt(localStorage.getItem("rm_updates_seen") ?? "");
      } catch {}
    });
    fetch("/data/changes.json")
      .then((r) => (r.ok ? (r.json() as Promise<ChangeLog>) : null))
      .then((c) => alive && setChanges(c))
      .catch(() => {});
    fetch("/api/recent?days=60")
      .then((r) => r.json())
      .then((j: { items?: RecentItem[] }) => {
        if (!alive) return;
        setRecent(j.items ?? []);
        setRecentLoaded(true);
      })
      .catch(() => alive && setRecentLoaded(true));
    return () => {
      alive = false;
    };
  }, []);
  const badge = useMemo(() => {
    const a = (changes?.entries ?? []).filter((e) => e.ts > seenAt).length;
    const b = recent.filter((n) => n.date > seenAt.slice(0, 10)).length;
    return a + b;
  }, [changes, recent, seenAt]);
  const openUpdates = () => {
    setUpdatesOpen(true);
    setSel(null);
  };
  const closeUpdates = () => {
    setUpdatesOpen(false);
    const now = new Date().toISOString();
    setSeenAt(now);
    try {
      localStorage.setItem("rm_updates_seen", now);
    } catch {}
  };

  /* ---------- 데이터 ---------- */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [z, p, m] = await Promise.all([
          fetch("/data/zones.geojson").then((r) => r.json() as Promise<ZoneCollection>),
          fetch("/data/projects.json").then((r) => r.json() as Promise<Project[]>),
          fetch("/data/meta.json").then((r) => r.json() as Promise<DataMeta>).catch(() => null),
        ]);
        if (!alive) return;
        setZones(z);
        setProjects(p);
        setMeta(m);
        // 공유 링크 (?p=사업장 / ?z=구역) 복원
        const sp = new URLSearchParams(window.location.search);
        const pno = Number(sp.get("p"));
        const zf = sp.get("z");
        const pr = pno ? p.find((x) => x.no === pno) : undefined;
        if (pr) {
          setSel({ type: "project", no: pr.no });
          const zone = pr.zoneFid ? z.features.find((f) => f.properties.fid === pr.zoneFid) : undefined;
          if (zone) setFocus({ key: Date.now(), bounds: zone.properties.bbox });
          else if (pr.lat != null && pr.lng != null) setFocus({ key: Date.now(), center: [pr.lat, pr.lng], zoom: 16 });
        } else if (zf) {
          const zone = z.features.find((f) => f.properties.fid === zf);
          if (zone) {
            setSel({ type: "zone", fid: zf });
            setFocus({ key: Date.now(), bounds: zone.properties.bbox });
          }
        }
      } catch (e) {
        if (alive) setLoadErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const zoneByFid = useMemo(() => new Map((zones?.features ?? []).map((f) => [f.properties.fid, f])), [zones]);
  const projectByNo = useMemo(() => new Map(projects.map((p) => [p.no, p])), [projects]);
  /* 구역(도형번호) → 사업장. 관리코드(id)는 옛 구역끼리 공유하는 자리표시 값이 있어 도형번호로 묶는다 */
  const projectsByZoneFid = useMemo(() => {
    const m = new Map<string, Project[]>();
    for (const p of projects) {
      if (!p.zoneFid) continue;
      if (!m.has(p.zoneFid)) m.set(p.zoneFid, []);
      m.get(p.zoneFid)!.push(p);
    }
    return m;
  }, [projects]);

  /* 시군구 목록: 자료에 있는 시군구만, 시도 선택에 따라 */
  const guOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of projects) {
      if (sido && (p.sido ?? "서울") !== sido) continue;
      if (p.guCode && p.gu) m.set(p.guCode, sido ? p.gu : `${p.sido ?? "서울"} ${p.gu}`);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [projects, sido]);
  const sidoCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const p of projects) c[p.sido ?? "서울"] = (c[p.sido ?? "서울"] ?? 0) + 1;
    return c;
  }, [projects]);

  /* ---------- 필터 ---------- */
  const qraw = q.trim();
  const qn = normName(qraw);
  const phaseActive = useCallback((ph: Phase) => (phases.size ? phases.has(ph) : ph !== "완공"), [phases]);

  /* 국면·세부단계를 뺀 나머지 조건 (지역·구분·방식·검색어) */
  const baseMatch = useCallback(
    (p: Project) =>
      (!sido || (p.sido ?? "서울") === sido) &&
      (!gu || p.guCode === gu) &&
      (!kinds.size || [...kinds].some((k) => kindMatches(k, p.kind))) &&
      (!tags.size || projectTags(p.name, p.kind).some((t) => tags.has(t))) &&
      (!qraw || p.name.includes(qraw) || p.jibun.includes(qraw) || (qn.length >= 2 && normName(p.name).includes(qn))),
    [sido, gu, kinds, tags, qraw, qn],
  );
  const filteredProjects = useMemo(
    () => projects.filter((p) => baseMatch(p) && (stages.size ? stages.has(stageGroup(p.stage)) : phaseActive(phaseOf(p.stage)))),
    [projects, baseMatch, stages, phaseActive],
  );
  /* 완공이라서 숨겨진 사업장 수 (안내용) */
  const hiddenDone = useMemo(
    () => (stages.size || phaseActive("완공") ? 0 : projects.filter((p) => phaseOf(p.stage) === "완공" && baseMatch(p)).length),
    [projects, baseMatch, stages.size, phaseActive],
  );
  const filteredNoSet = useMemo(() => new Set(filteredProjects.map((p) => p.no)), [filteredProjects]);

  const matchedZones = useMemo(() => {
    if (!zones || !qraw) return [] as ZoneFeature[];
    return zones.features.filter((f) => f.properties.name.includes(qraw) || (qn.length >= 2 && normName(f.properties.name).includes(qn)));
  }, [zones, qraw, qn]);

  /* 구역 상태: 연결 사업장이 모두 완료면 완공, 연결이 없고 OLD_ZONE_YEAR 이전(또는 고시일 미상) 지정이면 과거 */
  const zoneStatusByFid = useMemo(() => {
    const m = new Map<string, ZoneStatus>();
    for (const f of zones?.features ?? []) m.set(f.properties.fid, zoneStatus(f.properties, projectsByZoneFid.get(f.properties.fid)));
    return m;
  }, [zones, projectsByZoneFid]);

  const visibleFids = useMemo<Set<string> | null>(() => {
    if (!zones) return null;
    const set = new Set<string>();
    // 조건에 맞는 사업장에 연결된 구역 (+ 검색어와 이름이 맞는 구역)
    for (const p of filteredProjects) if (p.zoneFid) set.add(p.zoneFid);
    if (qraw) for (const f of matchedZones) if (!sido || (f.properties.sido ?? "서울") === sido) set.add(f.properties.fid);
    // 사업장에 연결되지 않은 구역은 사업장 속성 필터(구분·방식·세부단계·검색어)가 없을 때만:
    // 최근 지정(미상)은 초기·중기·후기 중 하나라도 보일 때, 과거 구역은 완공을 켰을 때
    const attrFilter = kinds.size > 0 || tags.size > 0 || stages.size > 0 || !!qraw;
    if (!attrFilter) {
      const showRecent = PHASE_ORDER.some((ph) => ph !== "완공" && phaseActive(ph));
      const showOld = phaseActive("완공");
      for (const f of zones.features) {
        const fp = f.properties;
        const st = zoneStatusByFid.get(fp.fid);
        if (st !== "미상" && st !== "과거") continue; // 연결된 구역은 위에서 사업장 필터를 따른다
        if (st === "미상" ? !showRecent : !showOld) continue;
        if (sido && (fp.sido ?? "서울") !== sido) continue;
        if (gu && fp.gu !== gu) continue; // 시 본청(11000 등) 코드 구역은 시군구를 고르면 빠진다
        set.add(fp.fid);
      }
    }
    if (cats.size) for (const fid of [...set]) if (!cats.has(zoneCategory(zoneByFid.get(fid)!.properties.code))) set.delete(fid);
    // 선택된 구역(공유 링크 ?z= / ?p= 포함)은 완공·과거라 숨겨져 있어도 그린다
    const selFid = sel?.type === "zone" ? sel.fid : sel?.type === "project" ? projectByNo.get(sel.no)?.zoneFid : null;
    if (selFid && zoneByFid.has(selFid)) set.add(selFid);
    return set;
  }, [zones, filteredProjects, qraw, matchedZones, sido, gu, kinds.size, tags.size, stages.size, phaseActive, zoneStatusByFid, cats, zoneByFid, sel, projectByNo]);

  /* 완공·과거 구역은 흐리게 */
  const dimFids = useMemo(() => {
    const s = new Set<string>();
    for (const [fid, st] of zoneStatusByFid) if (st === "완공" || st === "과거") s.add(fid);
    return s;
  }, [zoneStatusByFid]);
  /* 폴리곤 툴팁 둘째 줄: 연결 사업장의 구분·단계, 없으면 결정고시 연도 */
  const zoneSub = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of zones?.features ?? []) {
      const fp = f.properties;
      const linked = projectsByZoneFid.get(fp.fid) ?? [];
      const shown = linked.filter((p) => filteredNoSet.has(p.no));
      const pick = shown[0] ?? linked[0];
      const y = zoneYear(fp.ntfc);
      if (pick) m.set(fp.fid, `${kindShort(pick.kind)} · ${pick.stage || "단계 미기재"}${linked.length > 1 ? ` 외 ${linked.length - 1}건` : ""}`);
      else if (fp.built) m.set(fp.fid, `${y ? `결정고시 ${y} · ` : ""}준공 추정 (신축 고층 ${fp.builtN ?? ""}동)`);
      else m.set(fp.fid, `${y ? `결정고시 ${y}` : "고시일 미상"}${zoneStatusByFid.get(fp.fid) === "과거" ? " · 과거 구역" : " · 사업장 미연결"}`);
    }
    return m;
  }, [zones, projectsByZoneFid, filteredNoSet, zoneStatusByFid]);

  const listProjects = useMemo(() => {
    const arr = [...filteredProjects];
    arr.sort((a, b) => a.gu.localeCompare(b.gu, "ko") || a.name.localeCompare(b.name, "ko"));
    return arr;
  }, [filteredProjects]);

  /* ---------- 선택 ---------- */
  const selProject = sel?.type === "project" ? (projectByNo.get(sel.no) ?? null) : null;
  const selZone: ZoneFeature | null =
    sel?.type === "zone" ? (zoneByFid.get(sel.fid) ?? null) : selProject?.zoneFid ? (zoneByFid.get(selProject.zoneFid) ?? null) : null;
  const zoneProjects = selZone ? (projectsByZoneFid.get(selZone.properties.fid) ?? []) : [];

  const focusOn = useCallback(
    (project: Project | null, zone: ZoneFeature | null) => {
      if (zone) setFocus({ key: Date.now(), bounds: zone.properties.bbox });
      else if (project && project.lat != null && project.lng != null) setFocus({ key: Date.now(), center: [project.lat, project.lng], zoom: 16 });
    },
    [],
  );

  const selectZone = useCallback(
    (fid: string, fly: boolean) => {
      setSel({ type: "zone", fid });
      setUpdatesOpen(false);
      if (fly) focusOn(null, zoneByFid.get(fid) ?? null);
      setListOpen(false);
    },
    [zoneByFid, focusOn],
  );
  const selectProject = useCallback(
    (no: number, fly: boolean) => {
      setSel({ type: "project", no });
      setUpdatesOpen(false);
      const p = projectByNo.get(no) ?? null;
      if (fly) focusOn(p, p?.zoneFid ? (zoneByFid.get(p.zoneFid) ?? null) : null);
      setListOpen(false);
    },
    [projectByNo, zoneByFid, focusOn],
  );
  /* 지도에서 폴리곤을 누르면: 연결된 사업장이 하나면 그 사업장(원 마커를 누른 것과 같은 화면), 여럿이거나 없으면 구역 */
  const selectZoneFromMap = useCallback(
    (fid: string) => {
      const linked = projectsByZoneFid.get(fid) ?? [];
      const shown = linked.filter((p) => filteredNoSet.has(p.no));
      const pick = shown.length === 1 ? shown[0] : shown.length === 0 && linked.length === 1 ? linked[0] : null;
      if (pick) selectProject(pick.no, false);
      else selectZone(fid, false);
    },
    [projectsByZoneFid, filteredNoSet, selectProject, selectZone],
  );

  /* 선택 → URL */
  useEffect(() => {
    if (!zones) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("z");
    url.searchParams.delete("p");
    if (sel?.type === "zone") url.searchParams.set("z", sel.fid);
    if (sel?.type === "project") url.searchParams.set("p", String(sel.no));
    window.history.replaceState(null, "", url.toString());
  }, [sel, zones]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSel(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggle = <T,>(set: Set<T>, v: T, setter: (s: Set<T>) => void) => {
    const n = new Set(set);
    if (n.has(v)) n.delete(v);
    else n.add(v);
    setter(n);
  };
  const resetFilters = () => {
    setQ("");
    setSido("");
    setGu("");
    setKinds(new Set());
    setPhases(new Set());
    setStages(new Set());
    setStagesOpen(false);
    setTags(new Set());
    setCats(new Set());
  };
  const filterCount = (sido ? 1 : 0) + (gu ? 1 : 0) + kinds.size + phases.size + stages.size + tags.size + cats.size;
  const changeSido = (v: string) => {
    setSido(v as Sido | "");
    setGu("");
  };
  /* 시도·시군구 선택 (컴포넌트가 아니라 렌더 함수 — 렌더 중 컴포넌트 생성 금지 규칙) */
  const renderRegionSelects = (cls: string) => (
    <>
      <select value={sido} onChange={(e) => changeSido(e.target.value)} className={cls} aria-label="시도">
        <option value="">수도권 전체</option>
        {SIDO_LIST.map((s) => (
          <option key={s} value={s}>
            {s}
            {sidoCounts[s] ? ` (${sidoCounts[s].toLocaleString()})` : ""}
          </option>
        ))}
      </select>
      <select value={gu} onChange={(e) => setGu(e.target.value)} className={cls} aria-label="시군구">
        <option value="">시군구 전체</option>
        {guOptions.map(([c, n]) => (
          <option key={c} value={c}>
            {n}
          </option>
        ))}
      </select>
    </>
  );
  const zoneCount = visibleFids ? visibleFids.size : (zones?.features.length ?? 0);

  return (
    <div className="flex h-full flex-col">
      {/* ---------- 상단 ---------- */}
      <header className="z-30 border-b border-gray-200 bg-white px-3 py-2 lg:px-4">
        <div className="flex flex-wrap items-center gap-2 lg:gap-3">
          <button type="button" className="flex flex-none items-baseline gap-1.5 whitespace-nowrap" onClick={() => { resetFilters(); setSel(null); }} title="처음으로">
            <span className="text-[17px] font-black tracking-tight text-brand">HAENGLIM</span>
            <span className="text-[14px] font-bold text-gray-900">정비사업 지도</span>
            <span className="hidden text-[11px] text-gray-400 lg:inline">서울·경기·인천 재개발·재건축 구역 · 고시</span>
          </button>
          <div className="relative order-last min-w-0 basis-full sm:order-none sm:basis-auto sm:flex-1 lg:max-w-md">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="구역명·사업장명·지번 검색 (예: 개포주공, 한남3, 아현동)"
              className="w-full rounded-lg border border-gray-300 bg-gray-50 py-1.5 pl-3 pr-8 text-[13px] outline-none focus:border-brand focus:bg-white"
              aria-label="검색"
            />
            {q && (
              <button onClick={() => setQ("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700" aria-label="검색어 지우기">
                ✕
              </button>
            )}
          </div>
          <div className="hidden items-center gap-1.5 sm:flex">
            {renderRegionSelects("rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-[13px]")}
          </div>
          <div className="ml-auto flex flex-none items-center gap-1.5">
            <a href={HUB_URL} className="chip" title="HAENGLIM 허브로" aria-label="HAENGLIM 홈">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 11 12 3l9 8" /><path d="M5 10v10h14V10" /></svg>
              <span className="hidden sm:inline">HAENGLIM 홈</span>
            </a>
            <select value={base} onChange={(e) => setBase(e.target.value as BaseKey)} className="hidden rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-[12px] md:block" aria-label="배경지도">
              <option value="vBase">V-World 기본</option>
              <option value="vSat">V-World 위성</option>
              <option value="osm">OpenStreetMap</option>
            </select>
            <button className={`chip hidden md:inline-flex ${showZones ? "on" : ""}`} onClick={() => setShowZones(!showZones)}>
              구역
            </button>
            <button className={`chip hidden md:inline-flex ${showMarkers ? "on" : ""}`} onClick={() => setShowMarkers(!showMarkers)}>
              사업장
            </button>
            <button
              className={`chip relative ${updatesOpen ? "on" : ""}`}
              onClick={() => (updatesOpen ? closeUpdates() : openUpdates())}
              title="자료 변경·최근 정비 고시"
              aria-label="업데이트"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
                <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
              </svg>
              <span className="hidden sm:inline">업데이트</span>
              {badge > 0 && (
                <span className="absolute -right-1.5 -top-1.5 min-w-[18px] rounded-full bg-red-500 px-1 text-center text-[10px] font-bold leading-[18px] text-white">
                  {badge > 99 ? "99+" : badge}
                </span>
              )}
            </button>
            <button className={`chip lg:hidden ${listOpen ? "on" : ""}`} onClick={() => { setListOpen(!listOpen); setFiltersOpen(false); }}>
              목록 {filteredProjects.length}
            </button>
            <button className={`chip lg:hidden ${filtersOpen || filterCount ? "on" : ""}`} onClick={() => { setFiltersOpen(!filtersOpen); setListOpen(false); }}>
              필터{filterCount ? ` ${filterCount}` : ""}
            </button>
          </div>
        </div>

        <div className={`${filtersOpen ? "flex" : "hidden"} mt-2 flex-col gap-1.5 lg:flex`}>
          <div className="flex flex-wrap items-center gap-1.5 sm:hidden">
            {renderRegionSelects("rounded-lg border border-gray-300 bg-white px-2 py-1 text-[12px]")}
            <select value={base} onChange={(e) => setBase(e.target.value as BaseKey)} className="rounded-lg border border-gray-300 bg-white px-2 py-1 text-[12px]" aria-label="배경지도">
              <option value="vBase">V-World 기본</option>
              <option value="vSat">V-World 위성</option>
              <option value="osm">OpenStreetMap</option>
            </select>
            <button className={`chip ${showZones ? "on" : ""}`} onClick={() => setShowZones(!showZones)}>구역</button>
            <button className={`chip ${showMarkers ? "on" : ""}`} onClick={() => setShowMarkers(!showMarkers)}>사업장</button>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="w-14 text-[11px] font-bold text-gray-400">진행단계</span>
            {PHASE_ORDER.map((ph) => (
              <button
                key={ph}
                className={`chip ${phases.has(ph) ? "on" : ""} ${ph === "완공" ? "ml-1 !border-emerald-300" : ""}`}
                onClick={() => toggle(phases, ph, setPhases)}
                title={PHASE_DESC[ph]}
              >
                <span className="dot" style={{ background: PHASE_COLOR[ph] }} />
                {ph}
                {ph === "완공" && hiddenDone > 0 && <span className="text-[10px] opacity-70">+{hiddenDone.toLocaleString()}</span>}
              </button>
            ))}
            <button className={`chip !border-dashed ${stagesOpen || stages.size ? "on" : ""}`} onClick={() => setStagesOpen(!stagesOpen)} title="계획·추진위·조합·시행… 세부 단계로 고르기">
              세부단계{stages.size ? ` ${stages.size}` : ""} {stagesOpen ? "▴" : "▾"}
            </button>
            <span className="hidden text-[11px] text-gray-400 xl:inline">
              {stages.size ? "세부 단계를 골라 국면 대신 적용 중" : phases.size ? PHASE_DESC[[...phases][0]] : `완공(준공·청산)된 곳은 숨김 — 보려면 '완공' 칩`}
            </span>
          </div>
          {stagesOpen && (
            <div className="flex flex-wrap items-center gap-1.5 pl-14">
              {PHASE_ORDER.map((ph) => (
                <span key={ph} className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-gray-200 px-1.5 py-0.5">
                  <span className="text-[10px] font-bold text-gray-400">{ph}</span>
                  {PHASE_STAGES[ph].map((s) => (
                    <button key={s} className={`chip ${stages.has(s) ? "on" : ""}`} onClick={() => toggle(stages, s, setStages)} title={STAGE_DESC[s]}>
                      <span className="dot" style={{ background: STAGE_COLOR[s] }} />
                      {s}
                    </button>
                  ))}
                </span>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="w-14 text-[11px] font-bold text-gray-400">사업구분</span>
            {KIND_LIST.map((k) => (
              <button key={k} className={`chip ${kinds.has(k) ? "on" : ""}`} onClick={() => toggle(kinds, k, setKinds)}>
                {kindShort(k)}
              </button>
            ))}
            <span className="mx-1 h-4 w-px bg-gray-200" aria-hidden="true" />
            <span className="text-[11px] font-bold text-gray-400" title="사업장 이름·구분에 표기된 방식만 잡힙니다">방식</span>
            {TAG_LIST.map((t) => (
              <button key={t} className={`chip ${tags.has(t) ? "on" : "text-brand"}`} onClick={() => toggle(tags, t, setTags)} title="사업장 이름에 이 방식이 표기된 곳">
                {t}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="w-14 text-[11px] font-bold text-gray-400">구역유형</span>
            {CATEGORY_ORDER.map((c) => (
              <button key={c} className={`chip ${cats.has(c) ? "on" : ""}`} onClick={() => toggle(cats, c, setCats)}>
                <span className="sq" style={{ background: CATEGORY_COLOR[c] }} />
                {c}
              </button>
            ))}
            {filterCount + (qraw ? 1 : 0) > 0 && (
              <button className="chip !border-dashed" onClick={resetFilters}>
                초기화 ✕
              </button>
            )}
            <span className="ml-auto hidden text-[11px] text-gray-400 lg:inline">
              구역 {zoneCount.toLocaleString()} · 사업장 {filteredProjects.length.toLocaleString()}
              {hiddenDone > 0 ? ` (완공 ${hiddenDone.toLocaleString()} 숨김)` : ""}
              {meta?.builtAt ? ` · 자료 ${meta.builtAt.slice(0, 10)}` : ""}
            </span>
          </div>
        </div>
      </header>

      {/* ---------- 지도 영역 ---------- */}
      <div className="relative min-h-0 flex-1">
        <MapView
          zones={zones}
          visibleFids={visibleFids}
          showZones={showZones}
          projects={filteredProjects}
          showMarkers={showMarkers}
          dimFids={dimFids}
          zoneSub={zoneSub}
          selected={sel}
          selectedZoneFid={selZone?.properties.fid ?? null}
          base={base}
          focus={focus}
          panelOpen={!!sel}
          onSelectZone={selectZoneFromMap}
          onSelectProject={(no) => selectProject(no, false)}
          onBaseFail={() => setBase("osm")}
        />

        {!zones && !loadErr && (
          <div className="absolute left-1/2 top-3 z-20 -translate-x-1/2 rounded-full bg-white/95 px-4 py-1.5 text-xs text-gray-600 shadow">
            구역 자료 불러오는 중…
          </div>
        )}
        {loadErr && (
          <div className="absolute left-1/2 top-3 z-20 -translate-x-1/2 rounded-full bg-red-50 px-4 py-1.5 text-xs text-red-700 shadow">
            자료를 불러오지 못했습니다: {loadErr}
          </div>
        )}

        {/* ---------- 목록 ---------- */}
        <aside
          className={`${listOpen ? "flex" : "hidden"} absolute inset-x-0 top-0 bottom-0 z-20 flex-col bg-white lg:inset-auto lg:left-3 lg:top-3 lg:bottom-3 lg:flex lg:w-[320px] lg:rounded-xl lg:border lg:border-gray-200 lg:bg-white/95 lg:shadow-lg`}
          aria-label="사업장 목록"
        >
          <div className="flex items-center justify-between border-b border-gray-100 px-3 py-2">
            <div className="text-[12px] font-bold text-gray-600">
              사업장 {filteredProjects.length.toLocaleString()}건
              {matchedZones.length > 0 && <span className="ml-1 font-normal text-gray-400">· 구역 {matchedZones.length}건</span>}
            </div>
            <button className="chip lg:hidden" onClick={() => setListOpen(false)}>
              닫기
            </button>
          </div>
          <div className="rm-scroll min-h-0 flex-1 overflow-y-auto">
            {matchedZones.length > 0 && (
              <div className="border-b border-gray-100">
                <div className="px-3 pt-2 text-[11px] font-bold text-gray-400">정비구역 (이름 일치)</div>
                <ul>
                  {matchedZones.slice(0, 40).map((f) => {
                    const c = zoneCategory(f.properties.code);
                    const linked = projectsByZoneFid.get(f.properties.fid)?.length ?? 0;
                    return (
                      <li key={f.properties.fid}>
                        <button
                          onClick={() => selectZone(f.properties.fid, true)}
                          className={`flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-gray-50 ${sel?.type === "zone" && sel.fid === f.properties.fid ? "bg-orange-50" : ""}`}
                        >
                          <span className="mt-1 inline-block h-2.5 w-2.5 flex-none rounded-[2px]" style={{ background: CATEGORY_COLOR[c] }} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] font-semibold text-gray-800">{f.properties.name || "(이름 없음)"}</span>
                            <span className="block text-[11px] text-gray-500">
                              {c} · {Math.round(f.properties.area).toLocaleString()}㎡{linked ? ` · 사업장 ${linked}` : ""}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            {listProjects.length === 0 && zones && (
              <p className="px-3 py-6 text-center text-xs text-gray-400">
                조건에 맞는 사업장이 없습니다.
                {hiddenDone > 0 && (
                  <>
                    <br />
                    완공된 사업장 {hiddenDone.toLocaleString()}건은 숨겨져 있습니다 —{" "}
                    <button className="text-brand underline" onClick={() => setPhases(new Set(PHASE_ORDER))}>
                      완공 포함해서 보기
                    </button>
                  </>
                )}
              </p>
            )}
            <ul>
              {listProjects.slice(0, listLimit).map((p) => (
                <li key={p.no}>
                  <button
                    onClick={() => selectProject(p.no, true)}
                    className={`flex w-full items-start gap-2 px-3 py-1.5 text-left hover:bg-gray-50 ${sel?.type === "project" && sel.no === p.no ? "bg-orange-50" : ""}`}
                  >
                    <span className="mt-1 inline-block h-2.5 w-2.5 flex-none rounded-full" style={{ background: STAGE_COLOR[stageGroup(p.stage)] }} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-semibold text-gray-800">{p.name}</span>
                      <span className="block truncate text-[11px] text-gray-500">
                        {p.sido && p.sido !== "서울" ? `${p.sido} ` : ""}
                        {p.gu} · {kindShort(p.kind)} · {p.stage || "단계 미기재"}
                        {p.zoneFid ? "" : " · 구역 미연결"}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            {listProjects.length > listLimit && (
              <button className="w-full py-2 text-center text-xs text-brand hover:underline" onClick={() => setListLimit(listLimit + LIST_LIMIT)}>
                더 보기 ({listProjects.length - listLimit}건 남음)
              </button>
            )}
          </div>
          <Legend />
        </aside>

        {updatesOpen && (
          <UpdatesPanel
            meta={meta}
            changes={changes}
            recent={recent}
            recentLoading={!recentLoaded}
            seenAt={seenAt}
            onClose={closeUpdates}
            onSelectProject={(no) => {
              closeUpdates();
              selectProject(no, true);
            }}
            onSelectZone={(fid) => {
              closeUpdates();
              selectZone(fid, true);
            }}
            hasProject={(no) => projectByNo.has(no)}
            hasZone={(fid) => zoneByFid.has(fid)}
          />
        )}

        {sel && !updatesOpen && (
          <DetailPanel
            sel={sel}
            zone={selZone}
            project={selProject}
            zoneProjects={zoneProjects}
            onClose={() => setSel(null)}
            onSelectProject={(no) => selectProject(no, true)}
            onSelectZone={(fid) => selectZone(fid, true)}
            onFocus={() => focusOn(selProject, selZone)}
          />
        )}
      </div>
    </div>
  );
}

function Legend() {
  return (
    <div className="border-t border-gray-100 px-3 py-2 text-[11px] text-gray-600">
      <div className="mb-1 flex flex-wrap gap-x-2.5 gap-y-1">
        {CATEGORY_ORDER.map((c) => (
          <span key={c} className="inline-flex items-center gap-1">
            <span className="inline-block h-2.5 w-2.5 rounded-[2px]" style={{ background: CATEGORY_COLOR[c], opacity: 0.85 }} />
            {c}
          </span>
        ))}
      </div>
      <div className="flex flex-wrap gap-x-2.5 gap-y-1">
        {PHASE_ORDER.map((ph) => (
          <span key={ph} className="inline-flex items-center gap-1" title={PHASE_DESC[ph]}>
            <span className="font-bold text-gray-400">{ph}</span>
            {PHASE_STAGES[ph]
              .filter((s) => s !== "기타")
              .map((s) => (
                <span key={s} className="inline-flex items-center gap-0.5" title={STAGE_DESC[s]}>
                  <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: STAGE_COLOR[s] }} />
                  {s}
                </span>
              ))}
          </span>
        ))}
      </div>
      <p className="mt-1 text-[10px] leading-snug text-gray-400">
        원 마커 = 사업장 위치(확대하면 경계가 있는 곳은 경계만 보임) · 실선 면 = 정비구역 경계 · 점선 면 = 정비구역 미지정 재건축 단지의 대표지번 필지. 완공·{OLD_ZONE_YEAR}년 이전 과거 구역은 흐리게, 기본은 숨김.
      </p>
    </div>
  );
}
