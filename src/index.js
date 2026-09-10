import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import "./App.css";
import App from "./App";
import { applyConnectTheme } from "@amazon-connect/theme";
import { API_CONFIGURATION_ERROR } from "./config";

applyConnectTheme();

const root = ReactDOM.createRoot(document.getElementById("root"));

if (API_CONFIGURATION_ERROR) {
  root.render(
    <main className="ConfigurationError">
      <h2>Application configuration required</h2>
      <p>Missing setting: {API_CONFIGURATION_ERROR}.</p>
    </main>
  );
} else {
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
