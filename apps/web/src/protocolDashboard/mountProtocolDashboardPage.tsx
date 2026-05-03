import React from "react";
import ReactDOM from "react-dom/client";
import { ProtocolDashboardApp } from "./protocolDashboardApp.tsx";

export type ProtocolDashboardPageHandle = {
  dispose(): void;
};

export function mountProtocolDashboardPage(): ProtocolDashboardPageHandle {
  const host = document.getElementById("app");
  if (!host) throw new Error("Missing #app");

  host.textContent = "";
  const rootEl = document.createElement("div");
  rootEl.id = "protocol-dashboard-root";
  host.appendChild(rootEl);

  const root = ReactDOM.createRoot(rootEl);
  root.render(
    <React.StrictMode>
      <ProtocolDashboardApp />
    </React.StrictMode>
  );

  return {
    dispose() {
      root.unmount();
      host.textContent = "";
    }
  };
}

