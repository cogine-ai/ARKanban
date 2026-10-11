import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { CollectorProvider } from "./state/collector-context";
import "./styles.css";

// Modal scroll-lock styles use get-nonce's browser global. Set it before
// React mounts so the injected style receives this document's CSP nonce.
const styleNonce = document.querySelector<HTMLMetaElement>('meta[name="collector-style-nonce"]')?.content;
if (styleNonce) {
  (window as Window & { __webpack_nonce__?: string }).__webpack_nonce__ = styleNonce;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <CollectorProvider>
      <App />
    </CollectorProvider>
  </StrictMode>,
);
