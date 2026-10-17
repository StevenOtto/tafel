import React from "react";
import ReactDOM from "react-dom/client";
import { ControlApp } from "./app/ControlApp";
import { platformFromUserAgent } from "./core/platform";
import "./styles.css";

document.documentElement.dataset.platform = platformFromUserAgent(
  navigator.userAgent,
);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ControlApp />
  </React.StrictMode>,
);
