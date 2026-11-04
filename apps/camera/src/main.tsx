import { StrictMode, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";

import { App, cameraCommands } from "./App";
import { CameraCloudBootstrap } from "./camera-cloud-bootstrap";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root が無い（index.html）");

const commands = cameraCommands();
const cloud = new CameraCloudBootstrap({ commands });

function CameraRoot() {
  const snapshot = useSyncExternalStore(
    (listener) => cloud.subscribe(listener),
    () => cloud.getSnapshot(),
    () => cloud.getSnapshot(),
  );
  return <App commands={commands} cloudBinding={snapshot.binding} />;
}

globalThis.addEventListener("beforeunload", () => cloud.dispose(), { once: true });
createRoot(root).render(
  <StrictMode>
    <CameraRoot />
  </StrictMode>,
);
void cloud.start();
