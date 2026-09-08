import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { HouseholdHttpResponse } from "../../src/contracts/http";
import { App } from "./App";
import { pages } from "./layout/AppShell";

function start(path = "/") {
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url) => {
    if (url === "/api/health") return Response.json({ status: "ok", service: "tilbudstrolden" });
    if (url === "/api/household")
      return Response.json({
        country: "DK",
        defaultServings: 2,
        people: [],
        stores: [],
      } satisfies HouseholdHttpResponse);
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
  return fetchMock;
}

describe("application foundation", () => {
  it("renders dashboard, semantic navigation and connected health", async () => {
    const fetchMock = start();
    expect(screen.getByRole("heading", { name: "Overblik", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Hovednavigation" })).toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
    expect(await screen.findByText("Backend forbundet")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("navigates between routes with active indication without re-fetching health", async () => {
    const user = userEvent.setup();
    const fetchMock = start();
    await screen.findByText("Backend forbundet");
    expect(screen.getByRole("link", { name: "Overblik" })).toHaveAttribute("aria-current", "page");
    await user.click(screen.getByRole("link", { name: "Madplan" }));
    expect(screen.getByRole("heading", { name: "Madplan" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Madplan" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Overblik" })).not.toHaveAttribute("aria-current");
    await user.click(screen.getByRole("link", { name: "Indkøb" }));
    expect(screen.getByRole("heading", { name: "Indkøb" })).toBeInTheDocument();
    expect(document.title).toBe("Indkøb · Tilbudstrolden");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(pages)("supports direct navigation to $path", async ({ path, title }) => {
    const fetchMock = start(path);
    expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
    await screen.findByText("Backend forbundet");
    if (path === "/settings") await screen.findByText("Ingen personer angivet.");
    else expect(screen.getByText(/Denne side er endnu ikke bygget/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(path === "/settings" ? 2 : 1);
  });

  it("loads household on settings navigation and remount without repeating health", async () => {
    const user = userEvent.setup();
    const fetchMock = start();
    await screen.findByText("Backend forbundet");
    await user.click(screen.getByRole("link", { name: "Indstillinger" }));
    await screen.findByText("Ingen personer angivet.");
    expect(screen.getByRole("link", { name: "Indstillinger" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(document.title).toBe("Indstillinger · Tilbudstrolden");
    await user.click(screen.getByRole("link", { name: "Overblik" }));
    expect(document.title).toBe("Overblik · Tilbudstrolden");
    await user.click(screen.getByRole("link", { name: "Indstillinger" }));
    await screen.findByText("Ingen personer angivet.");
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/health",
      "/api/household",
      "/api/household",
    ]);
  });

  it("offers a home link for unknown routes", async () => {
    start("/missing");
    expect(screen.getByRole("heading", { name: "Siden findes ikke" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Tilbage til overblik" })).toHaveAttribute("href", "/");
    await screen.findByText("Backend forbundet");
  });

  it("shows loading and then unavailable without hiding navigation or retrying", async () => {
    let fail: ((reason: Error) => void) | undefined;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Kontakter backend…");
    fail?.(new Error("Offline"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Backend utilgængelig");
    expect(screen.getByRole("navigation")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps keyboard navigation and a skip-to-content link", async () => {
    const user = userEvent.setup();
    start();
    await user.tab();
    expect(screen.getByRole("link", { name: "Spring til indhold" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("link", { name: "Overblik" })).toHaveFocus();
    await screen.findByText("Backend forbundet");
  });

  it("aborts startup health on unmount", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    const { unmount } = render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );
    unmount();
    await waitFor(() => expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true));
  });
});
