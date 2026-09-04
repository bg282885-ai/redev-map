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
  }
} catch (e) {
  /* sessionStorage 를 못 쓰는 환경이면 인트로 생략 */
}
