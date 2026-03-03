import { createRoot } from "react-dom/client";
import "./index.css";
import "./styles/overlays.css";
import { RegionCapture } from "./screens/RegionCapture";

document.documentElement.dataset.stellaWindow = "region";

createRoot(document.getElementById("root")!).render(
  <div className="app window-region">
    <RegionCapture />
  </div>,
);
