/* ------------------------------------------------------------------ */
/*  외부 자료 바로가기 링크                                               */
/* ------------------------------------------------------------------ */
import { GU } from "./zones";

const enc = encodeURIComponent;

export const CLEANUP = "https://cleanup.seoul.go.kr";
export const URBAN = "https://urban.seoul.go.kr";

/** 정보몽땅 사업장 페이지 */
export const cleanupCafe = (cafe: string) => `${CLEANUP}/cafe/mainIndx.do?cafeUrl=${enc(cafe)}`;

/** 정보몽땅 사업장 검색(자치구·사업장명) */
export const cleanupSearch = (guCode?: string | null) =>
  `${CLEANUP}/cleanup/bsnssttus/lscrMainIndx.do${guCode ? `?scupBsnsSttus.signguCode=${guCode}` : ""}`;

/** 정보몽땅 고시/공고 게시판 (등록기관=자치구) */
export const cleanupBoard = (guCode?: string | null) =>
  `${CLEANUP}/cleanup/bbs/lscr.do?bbsClCode=100${guCode ? `&signguCode=${guCode}` : ""}`;

/** 정보몽땅 고시/공고 글 */
export const cleanupPost = (sn: string) => `${CLEANUP}/cleanup/bbs/vscr.do?cpage=1&bbsClCode=100&bbs.bbsSn=${sn}`;

/** 서울 도시계획포털 지도 팝업 (결정고시 관리코드) */
export const urbanMap = (recordCode: string) => `${URBAN}/view/map/mapPopup.html?recordCode=${enc(recordCode)}`;

/** 서울플랜+ (도시계획포털 도시계획사업 현황) 모아타운 목록·지도 */
export const seoulPlanMoatown = () => `${URBAN}/view/html/PMNU1100000001?bsnsCd=BZ201`;

/** 서울 도시계획포털 결정고시 조회 */
export const urbanGosiSearch = () => `${URBAN}/view/html/PMNU4030100001`;

/** 토지이음 고시정보 목록 */
export const eumGosiList = () => "https://www.eum.go.kr/web/gs/gv/gvGosiList.jsp";

/** 시도 고시·공고 (정부 도메인 한정 검색) */
const SIDO_DOMAIN: Record<string, string> = { 서울: "seoul.go.kr", 경기: "gg.go.kr", 인천: "incheon.go.kr" };
export const sidoGosiSearch = (sido: string, q: string) =>
  `https://www.google.com/search?q=${enc(`site:${SIDO_DOMAIN[sido] ?? "go.kr"} 고시 "${q}"`)}`;
/** @deprecated 서울 전용 — sidoGosiSearch 사용 */
export const seoulGosiSearch = (q: string) => sidoGosiSearch("서울", q);

/** 시군구 고시·공고 검색 (서울 자치구 · 경기 시군 · 인천 군구 도메인) */
const GU_DOMAIN: Record<string, string> = {
  // 서울
  종로구: "jongno.go.kr", 중구: "junggu.seoul.kr", 용산구: "yongsan.go.kr", 성동구: "sd.go.kr", 광진구: "gwangjin.go.kr",
  동대문구: "ddm.go.kr", 중랑구: "jungnang.go.kr", 성북구: "sb.go.kr", 강북구: "gangbuk.go.kr", 도봉구: "dobong.go.kr",
  노원구: "nowon.kr", 은평구: "ep.go.kr", 서대문구: "sdm.go.kr", 마포구: "mapo.go.kr", 양천구: "yangcheon.go.kr",
  강서구: "gangseo.seoul.kr", 구로구: "guro.go.kr", 금천구: "geumcheon.go.kr", 영등포구: "ydp.go.kr", 동작구: "dongjak.go.kr",
  관악구: "gwanak.go.kr", 서초구: "seocho.go.kr", 강남구: "gangnam.go.kr", 송파구: "songpa.go.kr", 강동구: "gangdong.go.kr",
  // 경기
  과천시: "gccity.go.kr", 성남시: "seongnam.go.kr", 수원시: "suwon.go.kr", 고양시: "goyang.go.kr", 용인시: "yongin.go.kr",
  안양시: "anyang.go.kr", 부천시: "bucheon.go.kr", 안산시: "ansan.go.kr", 화성시: "hscity.go.kr", 남양주시: "nyj.go.kr",
  의정부시: "ui4u.go.kr", 광명시: "gm.go.kr", 하남시: "hanam.go.kr", 구리시: "guri.go.kr", 군포시: "gunpo.go.kr",
  의왕시: "uiwang.go.kr", 시흥시: "siheung.go.kr", 김포시: "gimpo.go.kr", 파주시: "paju.go.kr", 광주시: "gjcity.go.kr",
  평택시: "pyeongtaek.go.kr", 오산시: "osan.go.kr", 안성시: "anseong.go.kr", 이천시: "icheon.go.kr", 양주시: "yangju.go.kr",
  포천시: "pocheon.go.kr", 동두천시: "ddc.go.kr", 여주시: "yeoju.go.kr",
  // 인천
  미추홀구: "michuhol.go.kr", 연수구: "yeonsu.go.kr", 남동구: "namdong.go.kr", 부평구: "icbp.go.kr", 계양구: "gyeyang.go.kr",
  강화군: "ganghwa.go.kr", 옹진군: "ongjin.go.kr",
};
export const guGosiSearch = (gu: string, q: string) => {
  const key = gu.split(" ")[0]; // "성남시 수정구" → 성남시
  const d = GU_DOMAIN[gu] ?? GU_DOMAIN[key];
  return `https://www.google.com/search?q=${enc(`${d ? `site:${d}` : "site:go.kr"} 고시 "${q}"`)}`;
};

/** 경기도 정비사업 온누리 (추진현황) */
export const ggOnnuri = () => "https://www.gg.go.kr/onnuri/view.do?no=113";
/** 인천 정비사업 정보시스템 (사업 검색) */
export const icRenewal = () => "https://renewal.incheon.go.kr/ires/program/0000-0011-0025/program/business/search.do";

/** 국가법령정보센터 통합검색 (자치법규·고시) */
export const lawSearch = (q: string) =>
  `https://www.law.go.kr/lsSc.do?section=&menuId=1&subMenuId=15&tabMenuId=81&query=${enc(q)}`;

/** 네이버 뉴스 검색 */
export const newsSearch = (q: string) => `https://search.naver.com/search.naver?where=news&sort=1&query=${enc(q)}`;

/** 네이버 지도 (좌표) */
export const naverMap = (lat: number, lng: number, name: string) =>
  `https://map.naver.com/p/search/${enc(name)}?c=${lng},${lat},16,0,0,0,dh`;

/** 대지 법령 내비게이터 (site-law) — 법정동 코드·지번·PNU 로 바로 조회 */
const SIDO_FULL_NM: Record<string, string> = { 서울: "서울특별시", 경기: "경기도", 인천: "인천광역시" };
export const siteLaw = (p: { gu: string; jibun: string; kind: string; emdCode?: string | null; pnu?: string | null; sido?: string }) => {
  const redev = /재개발/.test(p.kind) ? "redevelopment" : /재건축/.test(p.kind) ? "reconstruction" : /소규모|가로주택/.test(p.kind) ? "small" : "";
  const dong = (p.jibun.match(/^(\S+?(?:동|가|읍|면|리))\b/) ?? [])[1] ?? "";
  const sp = new URLSearchParams({ sido: SIDO_FULL_NM[p.sido ?? "서울"] ?? "서울특별시", sgg: p.gu.split(" ")[0] });
  if (p.emdCode) sp.set("code", p.emdCode);
  else sp.set("manual", "1");
  if (dong) sp.set("emd", dong);
  sp.set("jibun", p.jibun.replace(/^\S+?(?:동|가|읍|면|리)\s*/, ""));
  if (p.pnu) sp.set("pnu", p.pnu);
  if (redev) sp.set("redev", redev);
  return `https://site-law.vercel.app/?${sp.toString()}`;
};

/** 정비사업 사업성 검토 (redev-calc) */
export const redevCalc = () => "https://redev-calc.vercel.app/";

export function guCodeOf(name: string) {
  return Object.entries(GU).find(([, n]) => n === name)?.[0] ?? null;
}
