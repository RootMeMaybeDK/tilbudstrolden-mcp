import { NavLink, Outlet } from "react-router-dom";
import { ErrorState, LoadingState } from "../components/States";
import { useApiHealth } from "../hooks/useApiHealth";

export const pages = [
  { path: "/", title: "Overblik" },
  { path: "/plan", title: "Madplan" },
  { path: "/shopping", title: "Indkøb" },
  { path: "/deals", title: "Tilbud" },
  { path: "/recipes", title: "Opskrifter" },
  { path: "/pantry", title: "Basislager" },
  { path: "/history", title: "Historik" },
  { path: "/settings", title: "Indstillinger" },
];

export function AppShell() {
  const health = useApiHealth();
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Spring til indhold
      </a>
      <aside className="sidebar">
        <header className="brand">
          Tilbudstrolden<span>Din hverdag, samlet</span>
        </header>
        <nav aria-label="Hovednavigation">
          <ul>
            {pages.map(({ path, title }) => (
              <li key={path}>
                <NavLink to={path} end={path === "/"}>
                  {title}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
        <div className="connection">
          {health === "loading" && <LoadingState message="Kontakter backend…" />}
          {health === "connected" && <p role="status">Backend forbundet</p>}
          {health === "unavailable" && <ErrorState message="Backend utilgængelig" />}
        </div>
      </aside>
      <main id="main-content" tabIndex={-1}>
        <Outlet />
      </main>
    </div>
  );
}
