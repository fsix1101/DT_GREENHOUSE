import { mountProtocolDashboardPage, type ProtocolDashboardPageHandle } from "./protocolDashboard/mountProtocolDashboardPage.tsx";
import { mountViewerPage, type ViewerPageHandle } from "./startApp.ts";

type Route = "viewer" | "protocol";

function getRouteFromHash(): Route {
  const h = window.location.hash || "";
  if (h.startsWith("#/protocol")) return "protocol";
  return "viewer";
}

function setDisplay(el: HTMLElement | null, visible: boolean): void {
  if (!el) return;
  el.style.display = visible ? "" : "none";
}

export function startAppShell(): void {
  const nav = document.getElementById("nav");
  const hud = document.getElementById("hud");
  const controls = document.getElementById("controls");

  if (!nav) throw new Error("Missing #nav");
  
  // 为导航栏添加内联样式，确保首次加载时位置正确
  nav.style.position = "fixed";
  nav.style.right = "12px";
  nav.style.top = "12px";
  nav.style.zIndex = "30";
  nav.style.display = "flex";
  nav.style.gap = "8px";
  nav.style.pointerEvents = "auto";
  
  if (controls) controls.style.display = "none";

  let viewerHandle: ViewerPageHandle | null = null;
  let protocolHandle: ProtocolDashboardPageHandle | null = null;

  const go = (route: Route): void => {
    window.location.hash = route === "viewer" ? "#/viewer" : "#/protocol";
  };

  const btnViewer = document.createElement("button");
  btnViewer.type = "button";
  btnViewer.textContent = "主界面";
  btnViewer.addEventListener("click", () => go("viewer"));

  const btnProtocol = document.createElement("button");
  btnProtocol.type = "button";
  btnProtocol.textContent = "协议仪表盘";
  btnProtocol.addEventListener("click", () => go("protocol"));

  nav.replaceChildren(btnViewer, btnProtocol);

  const applyNavStyle = (active: Route): void => {
    const base = "px-3 py-2 rounded-lg text-xs font-bold shadow-sm border transition-colors";
    btnViewer.className =
      base +
      " " +
      (active === "viewer" ? "bg-blue-600 text-white border-blue-700" : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50");
    btnProtocol.className =
      base +
      " " +
      (active === "protocol" ? "bg-blue-600 text-white border-blue-700" : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50");
  };

  const mount = (route: Route): void => {
    viewerHandle?.dispose();
    viewerHandle = null;
    protocolHandle?.dispose();
    protocolHandle = null;

    const greenhouseIntroPanel = document.querySelector('div[style*="智能工业温室系统介绍"]') || document.querySelector('div[style*="科技风面板背景.png"]');
    const topControls = document.getElementById('top-controls');
    const functionPanels = document.getElementById('function-panels');

    if (route === "viewer") {
      setDisplay(hud, true);
      setDisplay(nav, true);
      if (greenhouseIntroPanel) {
        (greenhouseIntroPanel as HTMLElement).style.display = "";
      }
      if (topControls) {
        topControls.style.display = "";
      }
      if (functionPanels) {
        functionPanels.style.display = "";
      }
      viewerHandle = mountViewerPage();
    } else {
      setDisplay(hud, false);
      setDisplay(controls, false);
      setDisplay(nav, false);
      if (greenhouseIntroPanel) {
        (greenhouseIntroPanel as HTMLElement).style.display = "none";
      }
      if (topControls) {
        topControls.style.display = "none";
      }
      if (functionPanels) {
        functionPanels.style.display = "none";
      }
      protocolHandle = mountProtocolDashboardPage();
    }

    applyNavStyle(route);
  };

  const onHashChange = (): void => {
    mount(getRouteFromHash());
  };

  window.addEventListener("hashchange", onHashChange);
  if (!window.location.hash) {
    window.location.hash = "#/viewer";
    mount("viewer");
    return;
  }

  mount(getRouteFromHash());
}
