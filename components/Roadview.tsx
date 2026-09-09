"use client";
import { useEffect, useRef, useState } from "react";

/**
 * 카카오맵 로드뷰 창 (2026-09-09, 사용자 "지도에서 로드뷰처럼 볼 수 있게").
 *  - NEXT_PUBLIC_KAKAO_JS_KEY(카카오 developers JavaScript 키, 플랫폼 Web 에 localhost:3007·배포 도메인 등록, 카카오맵 API 활성화)가 있을 때만 쓴다.
 *    키가 없으면 MapApp 이 카카오맵 로드뷰 링크를 새 창으로 연다.
 *  - 지점(pos) 반경 100 m 안의 가장 가까운 파노라마를 찾아 보이고, 대상 사업장(target)이 있으면 그쪽을 바라보게 시점을 맞추고 마커를 세운다.
 *  - "지점 선택" 을 누르면 MapApp 이 지도 클릭을 로드뷰 지점으로 넘긴다(MapView picking).
 */
type LatLng = { lat: number; lng: number };
type Props = {
  pos: LatLng;
  target: (LatLng & { name: string }) | null;
  picking: boolean;
  onTogglePick: () => void;
  onClose: () => void;
  /** 카카오맵 사이트의 같은 지점 로드뷰 */
  openUrl: string;
  /** 오른쪽 상세 패널이 열려 있으면 그 왼쪽에 놓는다 */
  panelOpen: boolean;
};

const KEY = process.env.NEXT_PUBLIC_KAKAO_JS_KEY ?? "";
export const ROADVIEW_EMBEDDED = !!KEY;

/* 카카오맵 SDK 중 쓰는 부분만 타입으로 */
type KLatLng = { getLat(): number; getLng(): number };
type KRoadview = {
  setPanoId(id: number, pos: KLatLng): void;
  setViewpoint(v: { pan: number; tilt: number; zoom: number }): void;
  getPosition(): KLatLng;
  relayout(): void;
};
type KMarker = { setMap(m: unknown): void };
type KMaps = {
  load(cb: () => void): void;
  LatLng: new (lat: number, lng: number) => KLatLng;
  Roadview: new (el: HTMLElement, opts?: { panoId?: number }) => KRoadview;
  RoadviewClient: new () => { getNearestPanoId(pos: KLatLng, radius: number, cb: (id: number | null) => void): void };
  Marker: new (opts: { position: KLatLng; map?: unknown; title?: string }) => KMarker;
  event: { addListener(target: unknown, type: string, cb: () => void): void };
};
declare global {
  interface Window {
    kakao?: { maps: KMaps };
  }
}

let sdkPromise: Promise<KMaps> | null = null;
function loadSdk(): Promise<KMaps> {
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise<KMaps>((resolve, reject) => {
    const k = window.kakao;
    if (k?.maps?.load) {
      k.maps.load(() => resolve(k.maps));
      return;
    }
    const s = document.createElement("script");
    s.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(KEY)}&autoload=false`;
    s.async = true;
    const timer = setTimeout(() => reject(new Error("카카오맵 SDK 로드 시간 초과 — 키와 도메인 등록을 확인하세요")), 12000);
    s.onload = () => {
      const kk = window.kakao;
      if (!kk?.maps?.load) {
        clearTimeout(timer);
        reject(new Error("카카오맵 SDK 를 불러왔지만 maps 객체가 없습니다"));
        return;
      }
      kk.maps.load(() => {
        clearTimeout(timer);
        resolve(kk.maps);
      });
    };
    s.onerror = () => {
      clearTimeout(timer);
      reject(new Error("카카오맵 SDK 를 불러오지 못했습니다 (JavaScript 키·사이트 도메인 등록 확인)"));
    };
    document.head.appendChild(s);
  });
  sdkPromise.catch(() => {
    sdkPromise = null; // 다음에 다시 시도할 수 있게
  });
  return sdkPromise;
}

/** a 에서 b 를 바라보는 방위각(도, 북 0·시계 방향) — 로드뷰 pan 값 */
function bearing(a: LatLng, b: LatLng) {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const φ1 = toRad(a.lat), φ2 = toRad(b.lat), Δλ = toRad(b.lng - a.lng);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

export default function Roadview({ pos, target, picking, onTogglePick, onClose, openUrl, panelOpen }: Props) {
  const elRef = useRef<HTMLDivElement>(null);
  const mapsRef = useRef<KMaps | null>(null);
  const rvRef = useRef<KRoadview | null>(null);
  const clientRef = useRef<{ getNearestPanoId(pos: KLatLng, radius: number, cb: (id: number | null) => void): void } | null>(null);
  const markerRef = useRef<KMarker | null>(null);
  const targetRef = useRef(target);
  const aimPending = useRef(false);
  const [state, setState] = useState<"loading" | "ok" | "empty" | "error">("loading");
  const [err, setErr] = useState("");
  const [panoDist, setPanoDist] = useState<number | null>(null);
  useEffect(() => {
    targetRef.current = target;
  }, [target]);

  /* 파노라마가 바뀐 뒤: 대상 사업장 쪽으로 시점을 돌리고 마커를 세운다 */
  const aim = () => {
    const rv = rvRef.current, maps = mapsRef.current;
    if (!rv || !maps) return;
    const here = { lat: rv.getPosition().getLat(), lng: rv.getPosition().getLng() };
    const t = targetRef.current;
    if (markerRef.current) {
      markerRef.current.setMap(null);
      markerRef.current = null;
    }
    const dist = t ? Math.round(Math.hypot((here.lng - t.lng) * 88800, (here.lat - t.lat) * 111000)) : null;
    // 헤더 로드뷰 버튼으로 임의 지점을 찍었을 때 선택된 사업장이 멀리(400 m 밖) 있으면 그쪽으로 돌리거나 마커를 세우지 않는다
    if (t && dist != null && dist <= 400) {
      rv.setViewpoint({ pan: bearing(here, t), tilt: 0, zoom: 0 });
      markerRef.current = new maps.Marker({ position: new maps.LatLng(t.lat, t.lng), map: rv, title: t.name });
      setPanoDist(dist);
    } else setPanoDist(null);
  };
  const showAt = (p: LatLng) => {
    const rv = rvRef.current, maps = mapsRef.current, client = clientRef.current;
    if (!rv || !maps || !client) return;
    setState("loading");
    const ll = new maps.LatLng(p.lat, p.lng);
    client.getNearestPanoId(ll, 100, (id) => {
      if (!id) {
        setState("empty");
        return;
      }
      aimPending.current = true;
      rv.setPanoId(id, ll);
      setState("ok");
    });
  };

  /* SDK 로드 + 로드뷰 만들기 (한 번) */
  useEffect(() => {
    let cancelled = false;
    loadSdk()
      .then((maps) => {
        if (cancelled || !elRef.current) return;
        mapsRef.current = maps;
        const rv = new maps.Roadview(elRef.current);
        rvRef.current = rv;
        clientRef.current = new maps.RoadviewClient();
        const onPano = () => {
          if (!aimPending.current) return;
          aimPending.current = false;
          aim();
        };
        maps.event.addListener(rv, "init", onPano);
        maps.event.addListener(rv, "panoid_changed", onPano);
        showAt(pos);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setState("error");
        setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 지점이 바뀌면 그 자리로 */
  useEffect(() => {
    if (rvRef.current) showAt(pos);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos.lat, pos.lng]);

  /* 창 크기가 바뀌면 다시 그리기 */
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => rvRef.current?.relayout());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <section
      className={`absolute inset-x-0 bottom-0 z-[25] flex h-[46vh] flex-col overflow-hidden rounded-t-2xl border border-line bg-surface shadow-[0_-4px_24px_rgba(0,0,0,.18)] lg:inset-auto lg:bottom-3 lg:h-[360px] lg:w-[560px] lg:rounded-xl lg:shadow-lg ${panelOpen ? "lg:right-[446px]" : "lg:right-3"}`}
      aria-label="로드뷰"
    >
      <div className="flex items-center gap-2 border-b border-line-2 px-3 py-1.5">
        <span className="text-[13px] font-bold text-ink">로드뷰</span>
        <span className="min-w-0 truncate text-[11px] text-muted">
          {state === "ok" && panoDist != null && target ? `${target.name} · 촬영 지점에서 ${panoDist} m` : target && panoDist == null && state === "ok" ? "선택 지점" : (target?.name ?? "")}
        </span>
        <div className="ml-auto flex flex-none items-center gap-1">
          <button className={`btn !px-2 !py-0.5 ${picking ? "primary" : ""}`} onClick={onTogglePick} title="지도를 클릭해 로드뷰 지점을 바꿉니다">
            {picking ? "지도에서 지점을 클릭…" : "지점 선택"}
          </button>
          <a className="btn !px-2 !py-0.5" href={openUrl} target="_blank" rel="noreferrer" title="카카오맵 사이트에서 같은 지점 로드뷰">
            카카오맵
          </a>
          <button className="btn !px-2 !py-0.5" onClick={onClose} aria-label="로드뷰 닫기" title="닫기">
            ✕
          </button>
        </div>
      </div>
      <div className="relative min-h-0 flex-1 bg-surface-2">
        <div ref={elRef} className="absolute inset-0" />
        {state !== "ok" && (
          <div className="absolute inset-0 flex items-center justify-center bg-surface/85 p-4 text-center text-xs text-muted">
            {state === "loading" && "로드뷰 불러오는 중…"}
            {state === "empty" && (
              <span>
                이 지점 반경 100 m 안에 로드뷰가 없습니다. <b>지점 선택</b>을 누르고 가까운 도로를 클릭해 보세요.
              </span>
            )}
            {state === "error" && (
              <span>
                {err}
                <br />
                <a className="underline" href={openUrl} target="_blank" rel="noreferrer">
                  카카오맵 사이트에서 로드뷰 열기
                </a>
              </span>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
