import { createFarmApp } from "./viewer/createFarmApp.ts";

export type ViewerPageHandle = {
  dispose(): void;
};

export function mountViewerPage(): ViewerPageHandle {
  const root = document.getElementById("app");
  const hud = document.getElementById("hud");
  if (!root || !hud) throw new Error("Missing #app or #hud");

  root.textContent = "";
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "width:100%;height:100%;display:block";
  root.appendChild(canvas);

  const app = createFarmApp({
    canvas,
    hud,
    model: {
      kind: "gltf",
      url: "/greenhouse_main.glb",
      normalize: "centerGround"
    },
    extras: [
      {
        kind: "gltf",
        url: "/crops_area.glb"
      },
      {
        kind: "gltf",
        url: "/trees.glb"
      }
    ],
    socketUrl: "ws://localhost:8080"
  });

  app.start();

  return {
    dispose() {
      app.dispose();
      root.textContent = "";
    }
  };
}