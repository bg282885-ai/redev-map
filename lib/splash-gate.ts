/**
 * 진입 인트로 게이트 — app/layout.tsx 의 <head> 에 인라인 동기 <script> 로 넣는다.
 * (next/script 의 beforeInteractive 는 App Router 에서 런타임이 나중에 불러와 본문이 먼저 그려지므로 쓰지 않음)
 */
export const SPLASH_GATE = String.raw`
// 진입 인트로 게이트: 첫 방문 세션(또는 허브에서 ?intro=1 로 들어온 경우)이고 모션 축소 설정이 아니면
// 그리기 전에 <html class="hl-splash"> 를 붙인다. intro 파라미터는 새로고침 때 다시 뜨지 않도록 주소에서 지운다
try {
  var params = new URLSearchParams(location.search);
  var force = params.get("intro") === "1";
  if (force) {
    params.delete("intro");
    var qs = params.toString();
    history.replaceState(history.state, "", location.pathname + (qs ? "?" + qs : "") + location.hash);
  }
  if ((force || !sessionStorage.getItem("rm_splash_seen")) && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    document.documentElement.classList.add("hl-splash");
    // 앱 CSS 가 도착하기 전에 본문이 잠깐 보이는 것을 막는 흰색 덮개. 인트로(z 100) 아래, 본문 위.
    // 인트로가 걷히기 시작하면(.splash-out) 덮개도 같이 사라져 페이드가 본문으로 이어진다
    var st = document.createElement("style");
    st.textContent =
      "html.hl-splash::before{content:'';position:fixed;inset:0;z-index:99;background:#fff}" +
      "html.hl-splash:has(.splash-out)::before{display:none}";
    (document.head || document.documentElement).appendChild(st);
  }
} catch (e) {
  /* sessionStorage 를 못 쓰는 환경이면 인트로 생략 */
}
`;
