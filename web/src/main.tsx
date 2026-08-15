import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { CollectorProvider } from "./state/collector-context";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <CollectorProvider>
      <App />
    </CollectorProvider>
  </StrictMode>,
);
