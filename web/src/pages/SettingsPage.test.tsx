import { act, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { HouseholdHttpResponse } from "../../../src/contracts/http";
import { SettingsPage } from "./SettingsPage";

// Synthetic fixtures only; no backend or authoritative datastore is used by these tests.
const household: HouseholdHttpResponse = {
  country: "DK",
  defaultServings: 3,
  people: [
    {
      name: "Testperson A",
      dietaryRestrictions: ["vegetarian", "no nuts"],
      defaultSchedule: { monday: true, tuesday: false },
    },
    { name: "Testperson B", dietaryRestrictions: [], defaultSchedule: {} },
  ],
  stores: [
    { name: "foetex", dealerId: "bdf5A", priority: 5 },
    { name: "365discount", dealerId: "DWZE1w", priority: 1 },
    { name: "foetex", dealerId: "bdf5A", priority: 5 },
  ],
};

function respond(data: HouseholdHttpResponse = household) {
  const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url) => {
    if (url !== "/api/household") throw new Error(`Unexpected request: ${url}`);
    return Response.json(data);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("read-only settings", () => {
  it("announces loading without premature empty data", () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    render(<SettingsPage />);
    expect(screen.getByRole("status")).toHaveTextContent("Henter husstand…");
    expect(screen.queryByText("Ingen personer angivet.")).not.toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(document.title).toBe("Indstillinger · Tilbudstrolden");
  });

  it("renders the shared household DTO through one relative read, with no mutation controls", async () => {
    const fetchMock = respond();
    render(<SettingsPage />);
    const defaults = await screen.findByRole("region", { name: "Standarder" });
    expect(within(defaults).getByText("DK")).toBeInTheDocument();
    expect(within(defaults).getByText("3")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      "/api/household",
      expect.objectContaining({
        method: "GET",
        body: undefined,
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("renders each person's restrictions and true, false and unspecified days separately", async () => {
    respond();
    render(<SettingsPage />);
    const people = await screen.findByRole("region", { name: "Personer" });
    const first = within(people).getByRole("heading", { name: "Testperson A" }).closest("li");
    if (!first) throw new Error("Missing person list item");
    expect(within(first).getByText("vegetarian")).toBeInTheDocument();
    expect(within(first).getByText("no nuts")).toBeInTheDocument();
    expect(within(first).getByText("Mandag").parentElement).toHaveTextContent("MandagHjemme");
    expect(within(first).getByText("Tirsdag").parentElement).toHaveTextContent(
      "TirsdagIkke hjemme",
    );
    expect(within(first).getByText("Onsdag").parentElement).toHaveTextContent("OnsdagIkke angivet");
    expect(within(people).getByRole("heading", { name: "Testperson B" })).toBeInTheDocument();
    expect(within(people).getByText("Ingen restriktioner angivet.")).toBeInTheDocument();
    expect(within(people).getByText("Ingen ugeplan angivet.")).toBeInTheDocument();
  });

  it("preserves store names, IDs, duplicate entries and backend order rather than sorting priority", async () => {
    respond();
    render(<SettingsPage />);
    const stores = await screen.findByRole("region", { name: "Foretrukne butikker" });
    expect(
      within(stores)
        .getAllByRole("heading", { level: 3 })
        .map((el) => el.textContent),
    ).toEqual(["foetex", "365discount", "foetex"]);
    expect(within(stores).getAllByText("bdf5A")).toHaveLength(2);
    expect(within(stores).getByText("DWZE1w")).toBeInTheDocument();
    expect(within(stores).getAllByText("5")).toHaveLength(2);
    expect(within(stores).getByText("1")).toBeInTheDocument();
    expect(within(stores).queryByText("Føtex")).not.toBeInTheDocument();
  });

  it("handles empty people and stores without inventing defaults", async () => {
    respond({ country: "", defaultServings: 0, people: [], stores: [] });
    render(<SettingsPage />);
    expect(await screen.findByText("Ingen personer angivet.")).toBeInTheDocument();
    expect(screen.getByText("Ingen butikker angivet.")).toBeInTheDocument();
    expect(screen.getByText("Ikke angivet")).toBeInTheDocument();
    expect(screen.getByText("0")).toBeInTheDocument();
  });

  it("keeps unknown schedule keys and duplicate names instead of losing contract data", async () => {
    const person = {
      name: "Same",
      dietaryRestrictions: [],
      defaultSchedule: { specialDay: false },
    };
    respond({ ...household, people: [person, person] });
    render(<SettingsPage />);
    expect(await screen.findAllByRole("heading", { name: "Same" })).toHaveLength(2);
    for (const day of screen.getAllByText("specialDay")) {
      expect(day.parentElement).toHaveTextContent("specialDayIkke hjemme");
    }
  });

  it("announces a structured API error without internal objects or automatic retry", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json(
        {
          error: { code: "DATASTORE_BUSY", message: "Data er midlertidigt optaget." },
          stack: "private stack detail",
          result: { internal: "private result" },
        },
        { status: 503 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    render(<SettingsPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Data er midlertidigt optaget.");
    expect(screen.queryByText(/private/)).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Standarder" })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shows a friendly network error without leaking transport details or retrying", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("private network detail"));
    vi.stubGlobal("fetch", fetchMock);
    render(<SettingsPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Kunne ikke kontakte backend.");
    expect(screen.queryByText(/private/)).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aborts an in-flight request on unmount without an unhandled rejection or retry", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { unmount } = render(<SettingsPage />);
    await act(async () => unmount());
    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ignores a late response from a prior mount even if the transport ignores abort", async () => {
    let finishOldRequest: ((response: Response) => void) | undefined;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOldRequest = resolve;
          }),
      )
      .mockImplementationOnce(async () => Response.json(household));
    vi.stubGlobal("fetch", fetchMock);
    const first = render(<SettingsPage />);
    first.unmount();
    render(<SettingsPage />);
    await screen.findByText("Testperson A");
    await act(async () => finishOldRequest?.(Response.json({ ...household, country: "OLD" })));
    expect(screen.getByText("DK")).toBeInTheDocument();
    expect(screen.queryByText("OLD")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
