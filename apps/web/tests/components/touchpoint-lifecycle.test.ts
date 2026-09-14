// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAuthorizationDeadline, useTouchpointLifecycle, type TouchpointLifecycleLoad, type TouchpointLifecycleOptions } from "../../src/components/touchpoint-lifecycle";

const timing = {
	serverTime: "2030-01-01T00:00:00.000Z",
	endsAt: "2030-01-01T00:05:00.000Z",
	authorizationExpiresAt: "2030-01-01T01:00:00.000Z",
};

describe("resolveAuthorizationDeadline", () => {
	it("keeps production's five-minute safety bound without treating it as a server rejection", () => {
		expect(resolveAuthorizationDeadline(timing, 5 * 60_000)).toBe(Date.parse(timing.endsAt));
	});
	it("rejects Test authorization beyond its sixty-second contract or activity window", () => {
		expect(resolveAuthorizationDeadline(timing, 60_000, true)).toBeNull();
		expect(resolveAuthorizationDeadline({ ...timing, endsAt: "2030-01-01T00:00:10.000Z", authorizationExpiresAt: "2030-01-01T00:00:30.000Z" }, 60_000, true)).toBeNull();
	});
	it("expires at a valid authorization before the activity end", () => {
		expect(resolveAuthorizationDeadline({ ...timing, authorizationExpiresAt: "2030-01-01T00:00:30.000Z" }, 60_000, true)).toBe(Date.parse("2030-01-01T00:00:30.000Z"));
	});
});

type Content = { text: string };
type Load = TouchpointLifecycleOptions<Content>["load"];
// Match the web suite's deferred-I/O helper: its TypeScript lib predates Promise.withResolvers.
function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>(next => { resolve = next; });
	return { promise, resolve };
}
const first = { text: "campaign" };

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
	vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("shared display lifecycle", () => {
	it("renews authority without replacing a visible decision, then expires even after no-decision polls", async () => {
		const load = vi.fn<Load>()
			.mockResolvedValueOnce({ kind: "decision", value: first, key: "same", validForMs: 60_000 })
			.mockResolvedValueOnce({ kind: "decision", value: { text: "campaign" }, key: "same", validForMs: 60_000 })
			.mockResolvedValue({ kind: "retain" });
		const { result } = renderHook(() => useTouchpointLifecycle({ enabled: true, identity: "production", load }));
		await act(async () => { await vi.advanceTimersByTimeAsync(0); });
		const generation = result.current.generation;
		await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
		expect(result.current.current).toBe(first);
		expect(result.current.generation).toBe(generation);
		expect(result.current.isCurrent(generation)).toBe(true);
		await act(async () => { await vi.advanceTimersByTimeAsync(29_999); });
		expect(result.current.current).toBe(first);
		await act(async () => { await vi.advanceTimersByTimeAsync(1); });
		expect(result.current.current).toBeNull();
		expect(result.current.isCurrent(generation)).toBe(false);
		expect(result.current.status).toBe("active");
	});

	it("refetches at the start boundary but cannot activate until the server grants authority", async () => {
		const grant = deferred<TouchpointLifecycleLoad<Content>>();
		const load = vi.fn<Load>().mockResolvedValueOnce({ kind: "waiting", retryAfterMs: 500 }).mockReturnValue(grant.promise);
		const { result } = renderHook(() => useTouchpointLifecycle({ enabled: true, identity: "test", load }));
		await act(async () => { await vi.advanceTimersByTimeAsync(499); });
		expect(result.current.current).toBeNull();
		expect(result.current.status).toBe("before");
		await act(async () => { await vi.advanceTimersByTimeAsync(1); });
		expect(result.current.current).toBeNull();
		await act(async () => { grant.resolve({ kind: "decision", value: first, key: "first", validForMs: 1000 }); });
		expect(result.current.current).toBe(first);
	});

	it("ignores an old environment response after selection changes", async () => {
		const old = deferred<TouchpointLifecycleLoad<Content>>();
		const oldLoad: Load = () => old.promise;
		const nextLoad: Load = async () => ({ kind: "decision", value: first, key: "next", validForMs: 60_000 });
		const { result, rerender } = renderHook(({ identity, load }) => useTouchpointLifecycle({ enabled: true, identity, load }), { initialProps: { identity: "old", load: oldLoad } });
		rerender({ identity: "next", load: nextLoad });
		await act(async () => { await vi.advanceTimersByTimeAsync(0); });
		await act(async () => { old.resolve({ kind: "decision", value: { text: "stale" }, key: "old", validForMs: 60_000 }); });
		expect(result.current.current).toBe(first);
	});

	it("expiry fences a renewal response still in flight", async () => {
		const late = deferred<TouchpointLifecycleLoad<Content>>();
		const load = vi.fn<Load>().mockResolvedValueOnce({ kind: "decision", value: first, key: "same", validForMs: 31_000 }).mockReturnValue(late.promise);
		const { result } = renderHook(() => useTouchpointLifecycle({ enabled: true, identity: "production", load }));
		await act(async () => { await vi.advanceTimersByTimeAsync(31_000); });
		expect(result.current.current).toBeNull();
		await act(async () => { late.resolve({ kind: "decision", value: first, key: "same", validForMs: 60_000 }); });
		expect(result.current.current).toBeNull();
	});

	it("subtracts response latency and does not extend leases when the local clock moves backwards", async () => {
		const response = deferred<TouchpointLifecycleLoad<Content>>();
		const load: Load = () => response.promise;
		const { result } = renderHook(() => useTouchpointLifecycle({ enabled: true, identity: "test", load }));
		await act(async () => { await vi.advanceTimersByTimeAsync(400); response.resolve({ kind: "decision", value: first, key: "same", validForMs: 1000 }); });
		expect(result.current.current).toBe(first);
		vi.setSystemTime(new Date("2020-01-01T00:00:00Z"));
		await act(async () => { await vi.advanceTimersByTimeAsync(599); });
		expect(result.current.current).toBe(first);
		await act(async () => { await vi.advanceTimersByTimeAsync(1); });
		expect(result.current.current).toBeNull();
	});

	it("withdraws old authority synchronously on wake and rejects a timed-out revalidation", async () => {
		const pending = deferred<TouchpointLifecycleLoad<Content>>();
		const load = vi.fn<Load>().mockResolvedValueOnce({ kind: "decision", value: first, key: "same", validForMs: 60_000 }).mockReturnValue(pending.promise);
		const { result } = renderHook(() => useTouchpointLifecycle({ enabled: true, identity: "production", load }));
		await act(async () => { await vi.advanceTimersByTimeAsync(0); });
		const generation = result.current.generation;
		act(() => { window.dispatchEvent(new Event("online")); expect(result.current.isCurrent(generation)).toBe(false); });
		expect(result.current.current).toBeNull();
		await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
		expect(result.current.status).toBe("error");
		await act(async () => { pending.resolve({ kind: "decision", value: first, key: "same", validForMs: 60_000 }); });
		expect(result.current.current).toBeNull();
	});
	it("cannot restore an original lease that expires while a wake request is pending", async () => {
		const pending = deferred<TouchpointLifecycleLoad<Content>>();
		const load = vi.fn<Load>().mockResolvedValueOnce({ kind: "decision", value: first, key: "same", validForMs: 3000 }).mockReturnValue(pending.promise);
		const { result } = renderHook(() => useTouchpointLifecycle({ enabled: true, identity: "production", load }));
		await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
		act(() => { window.dispatchEvent(new Event("focus")); });
		expect(result.current.current).toBeNull();
		await act(async () => { await vi.advanceTimersByTimeAsync(2000); pending.resolve({ kind: "retain" }); });
		expect(result.current.current).toBeNull();
	});
});
