import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import "./styles/base.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root.");
// One startup health request; no StrictMode effect replay or polling in this foundation.
createRoot(root).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>,
);
