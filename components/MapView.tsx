"use client";
import L from "leaflet";
import { useEffect, useRef, useState } from "react";
import type { Project, Selection, ZoneCollection, ZoneFeature } from "@/lib/types";
import { CATEGORY_COLOR, STAGE_COLOR, stageGroup, zoneCategory } from "@/lib/zones";

export type BaseKey = "vBase" | "vSat" | "osm";
export type Focus = { key: number; bounds?: [number, number, number, number]; center?: [number, number]; zoom?: number };

type Props = {
  zones: ZoneCollection | null;
  visibleFids: Set<string> | null;
  showZones: boolean;
  projects: Project[];
  showMarkers: boolean;
  /** 완공·과거 구역 (흐리게) */
  dimFids: Set<string> | null;
  /** 폴리곤 툴팁 둘째 줄 (연결 사업장 구분·단계 / 고시 연도) */
  zoneSub: Map<string, string>;
  /** 확대 시 항상 보이는 라벨 — 구역(fid) / 폴리곤 없는 사업장(no): [짧은 이름, 동향·단계] */
  zoneLabel: Map<string, [string, string]>;
  projectLabel: Map<number, [string, string]>;
  selected: Selection | null;
  selectedZoneFid: string | null;
  base: BaseKey;
  focus: Focus | null;
  panelOpen: boolean;
  onSelectZone: (fid: string) => void;
  onSelectProject: (no: number) => void;
  onBaseFail: () => void;
};

/* 수도권 전체(서울·경기·인천)가 보이는 초기 화면 */
const SEOUL: L.LatLngExpression = [37.52, 126.95];
/* 이 줌 이상에서는 경계 폴리곤이 있는 사업장의 원 마커를 숨긴다 — 원과 면이 겹쳐 무엇을 눌러야 하는지 헷갈리던 문제(2026-09-08).
   폴리곤을 누르면 연결 사업장이 하나일 때 그 사업장이 열린다(MapApp.selectZoneFromMap) */
const LINKED_MARKER_MAX_ZOOM = 14;
/* 라벨(짧은 이름 + 동향)은 줌 15 이상, 3만㎡ 이상 큰 구역은 14 부터, 폴리곤 없는 사업장은 16 부터 (아실 '재재' 라벨 방식, 2026-09-08) */
const LABEL_ZOOM = 15;
const LABEL_ZOOM_BIG = 14;
const LABEL_BIG_AREA = 30000;
const LABEL_ZOOM_POINT = 16;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function labelIcon(text: [string, string], color: string, point: boolean) {
  return L.divIcon({
    className: `rm-label${point ? " rm-label-pt" : ""}`,
    html: `<span style="border-color:${color}">${esc(text[0])}${text[1] ? ` <b>${esc(text[1])}</b>` : ""}</span>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  });
}

function applyFocus(map: L.Map, focus: Focus, panelOpen: boolean, animate: boolean) {
  const wide = window.innerWidth >= 1024;
  // 데스크톱: 왼쪽 목록(320px)·오른쪽 상세(430px)를 피한다. 모바일: 아래 바텀시트(62vh)를 피한다
  const padBR: L.PointExpression = wide
    ? panelOpen ? [460, 40] : [30, 30]
    : panelOpen ? [24, Math.round(window.innerHeight * 0.62) + 16] : [24, 24];
  const padTL: L.PointExpression = wide ? [340, 90] : [24, 24];
  if (focus.bounds) {
    const b = focus.bounds;
    map.fitBounds(
      [
        [b[1], b[0]],
        [b[3], b[2]],
      ],
      { paddingTopLeft: padTL, paddingBottomRight: padBR, maxZoom: 17, animate },
    );
  } else if (focus.center) {
    const z = focus.zoom ?? 16;
    const target = map.project(focus.center, z);
    // 패널·목록을 피해 보이도록 중심을 살짝 옮긴다
    const offX = (padTL[0] - padBR[0]) / 2;
    const offY = (padTL[1] - padBR[1]) / 2;
    map.setView(map.unproject(target.add([-offX, -offY]), z), z, { animate });
  }
}

function zoneStyle(f: ZoneFeature, dim: boolean): L.PathOptions {
  const cat = zoneCategory(f.properties.code);
  const color = CATEGORY_COLOR[cat];
  if (cat === "촉진지구") return { color, weight: 2, dashArray: "6 4", fillColor: color, fillOpacity: dim ? 0.02 : 0.05, opacity: dim ? 0.5 : 0.9 };
  // 완공·과거 구역(dim)은 옅은 회색 테두리에 연한 채움으로 진행 중 구역과 구분
  if (dim) return { color: "#9CA3AF", weight: 1, dashArray: "3 3", fillColor: color, fillOpacity: 0.08, opacity: 0.7 };
  // 대표지번 필지 경계(정비구역 미지정 단지)는 점선으로 — 정비구역과 구분
  if (f.properties.src === "parcel") return { color, weight: 1.6, dashArray: "5 3", fillColor: color, fillOpacity: 0.18, opacity: 0.95 };
  // 지구단위계획 특별계획구역 경계(정비구역 미지정)는 긴 점선
  if (f.properties.src === "special") return { color, weight: 1.8, dashArray: "9 4", fillColor: color, fillOpacity: 0.16, opacity: 0.95 };
  return { color, weight: 1.4, fillColor: color, fillOpacity: 0.28, opacity: 0.95 };
}

export default function MapView(p: Props) {
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  /* 지도가 만들어진 뒤에야 레이어 효과가 돌도록 하는 신호 (컨테이너 크기가 잡힌 뒤 생성) */
  const [ready, setReady] = useState(0);
  const baseRef = useRef<L.Layer[]>([]);
  const zoneLayerRef = useRef<L.GeoJSON | null>(null);
  const zoneByFid = useRef(new Map<string, L.Path>());
  /* 마커 두 묶음: 경계 폴리곤이 없는 사업장(항상) / 있는 사업장(LINKED_MARKER_MAX_ZOOM 미만에서만) */
  const freeMarkersRef = useRef<L.LayerGroup | null>(null);
  const linkedMarkersRef = useRef<L.LayerGroup | null>(null);
  const markerByNo = useRef(new Map<number, L.CircleMarker>());
  /* 콜백·패널 상태는 ref 로 들고 다닌다 (지도 이벤트 핸들러가 최신 값을 보도록). 아래 sync 함수들이 참조하므로 먼저 선언 */
  const panelOpenRef = useRef(p.panelOpen);
  const cb = useRef({ onSelectZone: p.onSelectZone, onSelectProject: p.onSelectProject, onBaseFail: p.onBaseFail });
  useEffect(() => {
    cb.current = { onSelectZone: p.onSelectZone, onSelectProject: p.onSelectProject, onBaseFail: p.onBaseFail };
  });
  useEffect(() => {
    panelOpenRef.current = p.panelOpen;
  }, [p.panelOpen]);
  const dimRef = useRef<Set<string> | null>(p.dimFids);
  useEffect(() => {
    dimRef.current = p.dimFids;
  }, [p.dimFids]);
  /* 줌에 따라 폴리곤이 있는 사업장의 마커를 넣고 뺀다 */
  const syncLinkedMarkers = () => {
    const map = mapRef.current;
    const g = linkedMarkersRef.current;
    if (!map || !g) return;
    const hide = map.getZoom() >= LINKED_MARKER_MAX_ZOOM;
    if (hide && map.hasLayer(g)) map.removeLayer(g);
    if (!hide && !map.hasLayer(g)) g.addTo(map);
  };
  /* 라벨 — 화면 안·줌 조건에 맞는 것만 그때그때 다시 만든다 (moveend 마다) */
  const labelLayerRef = useRef<L.LayerGroup | null>(null);
  const labelData = useRef({ zones: p.zones, visibleFids: p.visibleFids, showZones: p.showZones, projects: p.projects, showMarkers: p.showMarkers, zoneLabel: p.zoneLabel, projectLabel: p.projectLabel });
  const syncLabels = () => {
    const map = mapRef.current;
    if (!map) return;
    if (labelLayerRef.current) {
      map.removeLayer(labelLayerRef.current);
      labelLayerRef.current = null;
    }
    const d = labelData.current;
    const z = map.getZoom();
    const bounds = map.getBounds().pad(0.05);
    const group = L.layerGroup();
    if (d.showZones && d.zones && z >= LABEL_ZOOM_BIG) {
      for (const f of d.zones.features) {
        const fp = f.properties;
        if (d.visibleFids && !d.visibleFids.has(fp.fid)) continue;
        if (z < LABEL_ZOOM && (fp.area ?? 0) < LABEL_BIG_AREA) continue;
        const bb = fp.bbox;
        const c = L.latLng((bb[1] + bb[3]) / 2, (bb[0] + bb[2]) / 2);
        if (!bounds.contains(c)) continue;
        const text = d.zoneLabel.get(fp.fid);
        if (!text) continue;
        const m = L.marker(c, { icon: labelIcon(text, CATEGORY_COLOR[zoneCategory(fp.code)], false), keyboard: false });
        m.on("click", (e) => {
          L.DomEvent.stopPropagation(e);
          cb.current.onSelectZone(fp.fid);
        });
        group.addLayer(m);
      }
    }
    if (d.showMarkers && z >= LABEL_ZOOM_POINT) {
      for (const pr of d.projects) {
        if (pr.lat == null || pr.lng == null) continue;
        if (pr.zoneFid && d.showZones && zoneByFid.current.has(pr.zoneFid)) continue; // 폴리곤이 있으면 구역 라벨로
        const c = L.latLng(pr.lat, pr.lng);
        if (!bounds.contains(c)) continue;
        const text = d.projectLabel.get(pr.no);
        if (!text) continue;
        const m = L.marker(c, { icon: labelIcon(text, STAGE_COLOR[stageGroup(pr.stage)], true), keyboard: false });
        m.on("click", (e) => {
          L.DomEvent.stopPropagation(e);
          cb.current.onSelectProject(pr.no);
        });
        group.addLayer(m);
      }
    }
    group.addTo(map);
    labelLayerRef.current = group;
  };
  useEffect(() => {
    labelData.current = { zones: p.zones, visibleFids: p.visibleFids, showZones: p.showZones, projects: p.projects, showMarkers: p.showMarkers, zoneLabel: p.zoneLabel, projectLabel: p.projectLabel };
    syncLabels();
  }, [p.zones, p.visibleFids, p.showZones, p.projects, p.showMarkers, p.zoneLabel, p.projectLabel, ready]);
  const highlighted = useRef<{ zone?: string; no?: number }>({});
  const pendingFocus = useRef<Focus | null>(null);
  /* 최근 실행한 이동 — 직후에 컨테이너 크기가 바뀌면(CSS·폰트 늦게 적용, 패널 열림) 같은 이동을 다시 맞춘다 */
  const lastFocus = useRef<{ f: Focus; t: number } | null>(null);
  const createdAt = useRef(0);

  /* 지도 생성 — 컨테이너가 0×0 인 상태(CSS 적용 전)에서 만들면 화면이 어긋나므로 크기가 잡힌 뒤 만든다 */
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    let map: L.Map | null = null;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === 0 || el.clientHeight === 0) return;
      if (!map) {
        map = L.map(el, { preferCanvas: true, zoomControl: false, attributionControl: true, minZoom: 9, maxZoom: 19 });
        map.attributionControl.setPrefix(false);
        map.setView(SEOUL, 10);
        L.control.zoom({ position: "bottomright" }).addTo(map);
        L.control.scale({ imperial: false, position: "bottomright" }).addTo(map);
        map.on("zoomend", syncLinkedMarkers);
        map.on("moveend", syncLabels);
        mapRef.current = map;
        createdAt.current = Date.now();
        (window as unknown as { __rmMap?: L.Map }).__rmMap = map; // 디버깅용
        setReady((n) => n + 1);
        return;
      }
      // 크기가 바뀌면(패널 열림·창 크기) 다시 재고, 미뤄 둔 이동이 있으면 실행
      map.invalidateSize({ animate: false });
      const f = pendingFocus.current;
      // 크기 변경 중에는 줌 애니메이션이 끊겨 화면이 어긋날 수 있어 즉시 이동한다
      if (f) {
        pendingFocus.current = null;
        lastFocus.current = { f, t: Date.now() };
        applyFocus(map, f, panelOpenRef.current, false);
      } else if (lastFocus.current && Date.now() - lastFocus.current.t < 2500) {
        applyFocus(map, lastFocus.current.f, panelOpenRef.current, false);
      }
    });
    ro.observe(el);
    const zb = zoneByFid.current;
    const mb = markerByNo.current;
    return () => {
      ro.disconnect();
      map?.remove();
      mapRef.current = null;
      baseRef.current = [];
      zoneLayerRef.current = null;
      zb.clear();
      freeMarkersRef.current = null;
      linkedMarkersRef.current = null;
      labelLayerRef.current = null;
      mb.clear();
    };
  }, []);

  /* 배경지도 */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    for (const l of baseRef.current) map.removeLayer(l);
    baseRef.current = [];
    const add = (l: L.Layer) => {
      l.addTo(map);
      baseRef.current.push(l);
    };
    if (p.base === "osm") {
      add(L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }));
      return;
    }
    let errors = 0;
    let loads = 0;
    const watch = (l: L.TileLayer) => {
      l.on("tileerror", () => {
        errors++;
        if (errors >= 4 && loads === 0) cb.current.onBaseFail();
      });
      l.on("tileload", () => loads++);
      return l;
    };
    if (p.base === "vSat") {
      add(watch(L.tileLayer("/api/tile/Satellite/{z}/{y}/{x}", { maxZoom: 19, attribution: "© V-World" })));
      add(L.tileLayer("/api/tile/Hybrid/{z}/{y}/{x}", { maxZoom: 19 }));
    } else {
      add(watch(L.tileLayer("/api/tile/Base/{z}/{y}/{x}", { maxZoom: 19, attribution: "© V-World 국토교통부" })));
    }
  }, [p.base, ready]);

  /* 구역 폴리곤 */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (zoneLayerRef.current) {
      map.removeLayer(zoneLayerRef.current);
      zoneLayerRef.current = null;
      zoneByFid.current.clear();
    }
    if (!p.zones || !p.showZones) return;
    const vis = p.visibleFids;
    const dim = p.dimFids;
    const layer = L.geoJSON(p.zones as unknown as GeoJSON.FeatureCollection, {
      filter: (f) => !vis || vis.has((f as unknown as ZoneFeature).properties.fid),
      style: (f) => {
        const zf = f as unknown as ZoneFeature;
        return zoneStyle(zf, !!dim?.has(zf.properties.fid));
      },
      onEachFeature: (f, lyr) => {
        const zf = f as unknown as ZoneFeature;
        zoneByFid.current.set(zf.properties.fid, lyr as L.Path);
        lyr.on("click", (e) => {
          L.DomEvent.stopPropagation(e);
          cb.current.onSelectZone(zf.properties.fid);
        });
        const sub = p.zoneSub.get(zf.properties.fid);
        lyr.bindTooltip(
          `${zf.properties.name || "(이름 없음)"}${sub ? `<br><span style="font-weight:400;color:#666">${sub}</span>` : ""}`,
          { sticky: true, direction: "top", className: "rm-tip", opacity: 1 },
        );
      },
    });
    layer.addTo(map);
    zoneLayerRef.current = layer;
    highlighted.current.zone = undefined;
    freeMarkersRef.current?.eachLayer((m) => (m as L.CircleMarker).bringToFront());
    linkedMarkersRef.current?.eachLayer((m) => (m as L.CircleMarker).bringToFront());
  }, [p.zones, p.visibleFids, p.showZones, p.dimFids, p.zoneSub, ready]);

  /* 사업장 마커 */
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    for (const ref of [freeMarkersRef, linkedMarkersRef]) {
      if (ref.current) {
        if (map.hasLayer(ref.current)) map.removeLayer(ref.current);
        ref.current = null;
      }
    }
    markerByNo.current.clear();
    if (!p.showMarkers) return;
    const free = L.layerGroup();
    const linked = L.layerGroup();
    for (const pr of p.projects) {
      if (pr.lat == null || pr.lng == null) continue;
      const color = STAGE_COLOR[stageGroup(pr.stage)];
      const m = L.circleMarker([pr.lat, pr.lng], { radius: 6, color: "#fff", weight: 1.5, fillColor: color, fillOpacity: 0.95 });
      m.on("click", (e) => {
        L.DomEvent.stopPropagation(e);
        cb.current.onSelectProject(pr.no);
      });
      m.bindTooltip(`${pr.name}<br><span style="font-weight:400;color:#666">${pr.stage || "단계 미기재"}</span>`, {
        direction: "top",
        offset: [0, -6],
        className: "rm-tip",
        opacity: 1,
      });
      markerByNo.current.set(pr.no, m);
      // 경계 폴리곤이 지도에 그려진 사업장이면 확대 시 숨기는 묶음으로
      const hasPoly = p.showZones && !!pr.zoneFid && zoneByFid.current.has(pr.zoneFid);
      (hasPoly ? linked : free).addLayer(m);
    }
    free.addTo(map);
    freeMarkersRef.current = free;
    linkedMarkersRef.current = linked;
    syncLinkedMarkers();
    highlighted.current.no = undefined;
  }, [p.projects, p.showMarkers, p.showZones, p.visibleFids, p.zones, ready]);

  /* 선택 강조 */
  useEffect(() => {
    if (!mapRef.current) return;
    const zones = p.zones;
    const prevZ = highlighted.current.zone;
    if (prevZ) {
      const lyr = zoneByFid.current.get(prevZ);
      const f = zones?.features.find((x) => x.properties.fid === prevZ);
      if (lyr && f) lyr.setStyle(zoneStyle(f, !!dimRef.current?.has(prevZ)));
    }
    const prevNo = highlighted.current.no;
    if (prevNo != null) {
      const m = markerByNo.current.get(prevNo);
      const pr = p.projects.find((x) => x.no === prevNo);
      if (m && pr) m.setStyle({ radius: 6, weight: 1.5, color: "#fff", fillColor: STAGE_COLOR[stageGroup(pr.stage)] });
    }
    highlighted.current = {};
    if (p.selectedZoneFid) {
      const lyr = zoneByFid.current.get(p.selectedZoneFid);
      if (lyr) {
        lyr.setStyle({ weight: 3.5, color: "#111", fillOpacity: 0.45, dashArray: undefined });
        lyr.bringToFront();
        highlighted.current.zone = p.selectedZoneFid;
      }
    }
    if (p.selected?.type === "project") {
      const m = markerByNo.current.get(p.selected.no);
      if (m) {
        m.setStyle({ radius: 10, weight: 3, color: "#111" });
        m.bringToFront();
        highlighted.current.no = p.selected.no;
      }
    }
  }, [p.selected, p.selectedZoneFid, p.zones, p.projects, p.visibleFids, p.showZones, p.showMarkers, ready]);

  /* 이동 — 지도가 아직 없으면(크기 잡히기 전) 만들어진 뒤 실행한다 */
  useEffect(() => {
    if (!p.focus) return;
    const map = mapRef.current;
    if (!map) {
      pendingFocus.current = p.focus;
      return;
    }
    pendingFocus.current = null;
    lastFocus.current = { f: p.focus, t: Date.now() };
    // 첫 로드 직후(레이아웃이 아직 움직일 수 있음)에는 애니메이션 없이, 이후 사용자 조작은 부드럽게
    applyFocus(map, p.focus, p.panelOpen, Date.now() - createdAt.current > 3000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.focus, ready]);

  return <div ref={elRef} className="absolute inset-0 z-0" />;
}
