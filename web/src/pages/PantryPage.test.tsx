import { act, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { PantryHttpResponse } from "../../../src/contracts/http";
import { PantryPage } from "./PantryPage";

// Synthetic fixtures only: no backend or datastore access.
function respond(data: PantryHttpResponse) {
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url) => {
    if (url !== "/api/pantry") throw new Error(`Unexpected request: ${url}`);
    return Response.json(data);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("read-only pantry", () => {
  it("announces loading, sets the title and does not invent empty data", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {})),
    );
    render(<PantryPage />);
    expect(screen.getByRole("status")).toHaveTextContent("Henter pantry…");
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(document.title).toBe("Pantry · Tilbudstrolden");
    expect(screen.queryByText("Ingen varer i pantry.")).not.toBeInTheDocument();
    expect(screen.queryByText("0 varer")).not.toBeInTheDocument();
  });

  it("preserves order, casing, whitespace and duplicates through one relative GET", async () => {
    const items = ["Peber", "salt", "Salt", "  Olie  ", "Peber", "LangtNavn".repeat(50)];
    const fetchMock = respond({ items });
    render(<PantryPage />);
    await screen.findByRole("list");
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual(items);
    expect(screen.getByText("6 varer")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "/api/pantry",
      expect.objectContaining({ method: "GET", body: undefined, signal: expect.any(AbortSignal) }),
    );
  });

  it("shows an explicit empty pantry with no fake items", async () => {
    respond({ items: [] });
    render(<PantryPage />);
    expect(await screen.findByText("Ingen varer i pantry.")).toBeInTheDocument();
    expect(screen.getByText("0 varer")).toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
  });

  it("uses a presentation-only fallback for blank entries without dropping them", async () => {
    respond({ items: ["", " \t\n", "  Salt  "] });
    render(<PantryPage />);
    await screen.findByRole("list");
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Ikke angivet",
      "Ikke angivet",
      "  Salt  ",
    ]);
    expect(screen.getByText("3 varer")).toBeInTheDocument();
  });

  it("uses singular count for one item", async () => {
    respond({ items: ["Salt"] });
    render(<PantryPage />);
    expect(await screen.findByText("1 vare")).toBeInTheDocument();
  });

  it("announces API errors without exposing internal objects or retrying", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          error: { code: "DATASTORE_BUSY", message: "Data er midlertidigt optaget." },
          result: { internal: "private result" },
          stack: "private stack",
        },
        { status: 503 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<PantryPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Data er midlertidigt optaget.");
    expect(screen.queryByText(/private/)).not.toBeInTheDocument();
    expect(screen.queryByRole("list")).not.toBeInTheDocument();
    expect(screen.queryByText("0 varer")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shows a neutral network error without retrying", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("private detail"));
    vi.stubGlobal("fetch", fetchMock);
    render(<PantryPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Kunne ikke kontakte backend.");
    expect(screen.queryByText(/private/)).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts the pending GET on unmount and handles its rejection", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { unmount } = render(<PantryPage />);
    await act(async () => unmount());
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ignores a late response after effect cleanup even when fetch ignores abort", async () => {
    let finishOldRequest: ((response: Response) => void) | undefined;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOldRequest = resolve;
          }),
      )
      .mockImplementationOnce(async () =>
        Response.json({ items: ["Fresh"] } satisfies PantryHttpResponse),
      );
    vi.stubGlobal("fetch", fetchMock);
    // StrictMode replays the effect while preserving state: the stale setter could overwrite Fresh.
    // Production does not use StrictMode; this tests cleanup, not a retry policy.
    render(
      <StrictMode>
        <PantryPage />
      </StrictMode>,
    );
    await screen.findByText("Fresh");
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    await act(async () => finishOldRequest?.(Response.json({ items: ["Stale"] })));
    expect(screen.getByText("Fresh")).toBeInTheDocument();
    expect(screen.queryByText("Stale")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
