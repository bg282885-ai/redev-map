"use client";
import { useState } from "react";
import type { ChangeEntry, ChangeLog, DataMeta, RecentItem } from "@/lib/types";
import { guName } from "@/lib/zones";

type Props = {
  meta: DataMeta | null;
  changes: ChangeLog | null;
  recent: RecentItem[];
  recentLoading: boolean;
  seenAt: string;
  onClose: () => void;
  onSelectProject: (no: number) => void;
  onSelectZone: (fid: string) => void;
  hasProject: (no: number) => boolean;
  hasZone: (fid: string) => boolean;
};

const TYPE_LABEL: Record<ChangeEntry["type"], { label: string; color: string }> = {
  "project-new": { label: "신규 사업장", color: "#EC6C1E" },
  "zone-new": { label: "신규 구역", color: "#E5484D" },
  "stage-changed": { label: "단계 변경", color: "#2F6FED" },
  "kind-changed": { label: "유형 변경", color: "#8B5CF6" },
  "zone-changed": { label: "구역 고시 변경", color: "#8B5CF6" },
  "zone-linked": { label: "구역 연결", color: "#2AA36B" },
  "project-removed": { label: "목록 제외", color: "#9CA3AF" },
  "zone-removed": { label: "구역 제외", color: "#9CA3AF" },
};

export default function UpdatesPanel(p: Props) {
  /* 사용자가 고르기 전에는 변경 내역이 있으면 그 탭, 없으면 최근 고시 탭 */
  const [tabChoice, setTab] = useState<"changes" | "notices" | null>(null);
  const entries = p.changes?.entries ?? [];
  const tab = tabChoice ?? (entries.length ? "changes" : "notices");
  const isNew = (ts: string) => ts > p.seenAt;
  const groups = groupByDate(entries);
  const src = p.meta?.sources;

  return (
    <section
      className="absolute inset-x-0 bottom-0 z-30 flex max-h-[70vh] flex-col overflow-hidden rounded-t-2xl border border-gray-200 bg-white shadow-[0_-4px_24px_rgba(0,0,0,.12)] lg:inset-auto lg:right-3 lg:top-3 lg:bottom-3 lg:max-h-none lg:w-[400px] lg:rounded-xl lg:shadow-lg"
      aria-label="업데이트"
    >
      <div className="flex items-center gap-2 border-b border-gray-100 px-4 pt-3 pb-2">
        <h2 className="text-[15px] font-bold text-gray-900">업데이트</h2>
        <span className="text-[11px] text-gray-400">자료 갱신 {p.meta?.builtAt ? p.meta.builtAt.slice(0, 10) : "-"}</span>
        <button onClick={p.onClose} className="btn ml-auto !px-2" aria-label="닫기">
          ✕
        </button>
      </div>
      <div className="flex gap-1 border-b border-gray-100 px-3 py-2">
        <button className={`chip ${tab === "changes" ? "on" : ""}`} onClick={() => setTab("changes")}>
          자료 변경 {entries.length ? entries.length : ""}
        </button>
        <button className={`chip ${tab === "notices" ? "on" : ""}`} onClick={() => setTab("notices")}>
          최근 정비 고시 {p.recent.length ? p.recent.length : ""}
        </button>
      </div>

      <div className="rm-scroll min-h-0 flex-1 overflow-y-auto px-3 pb-5">
        {tab === "changes" && (
          <>
            {entries.length === 0 && (
              <p className="px-1 py-6 text-center text-xs text-gray-500">
                아직 기록된 변경이 없습니다. 자료를 다시 수집하면(주 1회 자동) 신규 지정 구역·새 사업장·단계 변경이 여기에 쌓입니다.
                {p.changes?.baseline ? ` 기준선: ${p.changes.baseline.slice(0, 10)}` : ""}
              </p>
            )}
            {groups.map(([date, list]) => (
              <div key={date} className="mt-3">
                <div className="px-1 text-[11px] font-bold text-gray-400">{date}</div>
                <ul className="divide-y divide-gray-100">
                  {list.map((e, i) => {
                    const t = TYPE_LABEL[e.type];
                    const clickable = (e.no != null && p.hasProject(e.no)) || (e.fid && p.hasZone(e.fid));
                    const body = (
                      <>
                        <span className="badge flex-none" style={{ background: t.color, color: "#fff" }}>
                          {t.label}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-semibold text-gray-800">
                            {isNew(e.ts) && <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-brand align-middle" />}
                            {e.name}
                          </span>
                          <span className="block text-[11px] text-gray-500">
                            {e.sido && e.sido !== "서울" ? `${e.sido} ` : ""}
                            {e.gu ? (/^\d{5}$/.test(e.gu) ? guName(e.gu) : e.gu) : ""}
                            {e.type === "stage-changed" || e.type === "kind-changed" ? ` · ${e.from || "-"} → ${e.to || "-"}` : ""}
                            {e.type === "project-new" && e.to ? ` · ${e.to}` : ""}
                            {e.type === "zone-new" && e.to ? ` · 고시 ${ntfcDateOf(e.to)}` : ""}
                          </span>
                        </span>
                      </>
                    );
                    return (
                      <li key={`${e.ts}-${i}`}>
                        {clickable ? (
                          <button
                            onClick={() => (e.no != null && p.hasProject(e.no) ? p.onSelectProject(e.no) : e.fid && p.onSelectZone(e.fid))}
                            className="flex w-full items-start gap-2 px-1 py-1.5 text-left hover:bg-gray-50"
                          >
                            {body}
                          </button>
                        ) : (
                          <div className="flex items-start gap-2 px-1 py-1.5">{body}</div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </>
        )}

        {tab === "notices" && (
          <>
            {p.recentLoading && (
              <div className="mt-3 space-y-1.5">
                <div className="skel h-3.5 w-full" />
                <div className="skel h-3.5 w-5/6" />
                <div className="skel h-3.5 w-4/6" />
              </div>
            )}
            {!p.recentLoading && p.recent.length === 0 && <p className="px-1 py-6 text-center text-xs text-gray-500">최근 60일 안의 정비 관련 고시를 찾지 못했습니다.</p>}
            <ul className="divide-y divide-gray-100">
              {p.recent.map((n) => (
                <li key={n.url} className="py-1.5">
                  <a href={n.url} target="_blank" rel="noreferrer" className="group block px-1">
                    <span className="mb-0.5 flex items-center gap-1.5 text-[11px] text-gray-500">
                      {n.date > p.seenAt.slice(0, 10) && <span className="inline-block h-1.5 w-1.5 rounded-full bg-brand" />}
                      <span className={`badge ${n.source === "정보몽땅" ? "bg-orange-50 text-orange-700" : n.source === "도시계획포털" ? "bg-purple-50 text-purple-700" : "bg-blue-50 text-blue-700"}`}>
                        {n.source}
                      </span>
                      <span>{n.date}</span>
                      {n.org && <span className="truncate">· {n.org}</span>}
                      {n.sido !== "서울" && <span className="badge bg-gray-100 text-gray-600">{n.sido}</span>}
                    </span>
                    <span className="text-[13px] leading-snug text-gray-800 group-hover:text-brand group-hover:underline">{n.title}</span>
                  </a>
                </li>
              ))}
            </ul>
          </>
        )}

        <div className="mt-4 rounded-lg bg-gray-50 p-3 text-[11px] leading-relaxed text-gray-500">
          <div className="font-bold text-gray-600">자료 기준</div>
          <div>서울 구역 경계: {src?.seoulShp || "-"} (서울시, 연 2회)</div>
          <div>서울 사업장: 정보몽땅 {src?.cleanup || "-"} 수집</div>
          <div>경기 사업장: 경기데이터드림 {src?.gyeonggi || "-"} 수집</div>
          <div>인천 사업장: 인천시 자료 {src?.incheon || "-"} 기준</div>
          <div className="mt-1">최근 고시는 열 때마다 도시계획포털·정보몽땅·토지이음에서 새로 읽습니다. 자료 변경은 수집 스크립트가 돌 때(주 1회 자동 예정) 이전 자료와 비교해 기록합니다.</div>
        </div>
      </div>
    </section>
  );
}

function groupByDate(entries: ChangeEntry[]): [string, ChangeEntry[]][] {
  const m = new Map<string, ChangeEntry[]>();
  for (const e of entries) {
    const d = e.ts.slice(0, 10);
    if (!m.has(d)) m.set(d, []);
    m.get(d)!.push(e);
  }
  return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]));
}

function ntfcDateOf(code: string) {
  const m = code.match(/NTC(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : code;
}
