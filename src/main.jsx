import React from "react";
import { createRoot } from "react-dom/client";
import PortfolioTracker from "../portfolio-tracker.jsx";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <PortfolioTracker />
  </React.StrictMode>,
);
