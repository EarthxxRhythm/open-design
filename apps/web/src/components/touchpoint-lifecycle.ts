import { useCallback, useEffect, useRef, useState } from "react";

export type AuthorizationTiming = Readonly<{
	serverTime: string;
	endsAt: string;
	authorizationExpiresAt: string;
}>;

/** The server grants display authority; clients may only shorten it. */
export function resolveAuthorizationDeadline(timing: AuthorizationTiming, maximumLeaseMs: number, rejectOversizedAuthorization = false): number | null {
	const serverTime = Date.parse(timing.serverTime);
	const endsAt = Date.parse(timing.endsAt);
	const authorizationExpiresAt = Date.parse(timing.authorizationExpiresAt);
	if (!Number.isFinite(serverTime) || !Number.isFinite(endsAt) || !Number.isFinite(authorizationExpiresAt) || endsAt <= serverTime || (rejectOversizedAuthorization && (authorizationExpiresAt > serverTime + maximumLeaseMs || authorizationExpiresAt > endsAt))) return null;
	return Math.min(authorizationExpiresAt, endsAt, serverTime + maximumLeaseMs);
}

export type TouchpointLifecycleLoad<T> =
	| Readonly<{ kind: "decision"; value: T; key: string; validForMs: number }>
	| Readonly<{ kind: "waiting"; retryAfterMs: number }>
	| Readonly<{ kind: "retain" }>
	| Readonly<{ kind: "clear"; ended?: boolean }>;

type LifecycleStatus = "loading" | "before" | "active" | "ended" | "error" | null;
export type TouchpointLifecycleOptions<T> = Readonly<{
	enabled: boolean;
	identity: string | null;
	load: (signal: AbortSignal, active: T | null) => Promise<TouchpointLifecycleLoad<T>>;
	onError?: (error: unknown) => void;
}>;

type Clock = { monotonic: number; wall: number };
const clock = (): Clock => ({ monotonic: performance.now(), wall: Date.now() });
// A backwards wall-clock adjustment cannot grant time; a forward jump can only shorten it.
const elapsed = (start: Clock) => Math.max(0, performance.now() - start.monotonic, Date.now() - start.wall);
const POLL_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_TIMER_MS = 2_147_483_647;

/**
 * One scheduling implementation for both runtime adapters. A response supplies
 * server-relative authority, never a client activation time. Renewing the same
 * immutable decision keeps its mount identity while replacing its lease.
 */
export function useTouchpointLifecycle<T>({ enabled, identity, load, onError }: TouchpointLifecycleOptions<T>) {
	const [state, setState] = useState<{ identity: string | null; current: T | null; generation: number; status: LifecycleStatus }>({ identity: null, current: null, generation: 0, status: null });
	const generation = useRef(0);
	const lease = useRef<{ identity: string; key: string; value: T; generation: number; start: Clock; validForMs: number } | null>(null);
	const inputs = useRef({ enabled, identity, onError });
	inputs.current = { enabled, identity, onError };
	const clearRef = useRef<() => void>(() => {});
	const clear = useCallback(() => clearRef.current(), []);
	const isCurrent = useCallback((expected: number) => {
		const current = lease.current;
		return Boolean(current && inputs.current.enabled && current.identity === inputs.current.identity && current.generation === expected && elapsed(current.start) < current.validForMs && !document.hidden);
	}, []);

	useEffect(() => {
		let stopped = false;
		let ended = false;
		// Suspend display during recovery; a no-decision reply may retain only the original, unextended lease.
		let revalidationLease: typeof lease.current = null;
		let request: AbortController | null = null;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let expiryTimer: ReturnType<typeof setTimeout> | undefined;
		let boundaryTimer: ReturnType<typeof setTimeout> | undefined;
		let status: LifecycleStatus = enabled && identity ? "loading" : null;
		const publish = () => {
			if (stopped) return;
			const next = { identity, current: lease.current?.value ?? null, generation: generation.current, status };
			setState(previous => previous.identity === next.identity && previous.current === next.current && previous.generation === next.generation && previous.status === next.status ? previous : next);
		};
		const cancelRequest = () => {
			request?.abort();
			request = null;
			clearTimeout(timeout);
		};
		const revoke = () => {
			cancelRequest();
			clearTimeout(expiryTimer);
			clearTimeout(boundaryTimer);
			lease.current = null;
			++generation.current;
			publish();
		};
		clearRef.current = () => { revalidationLease = null; revoke(); };
		revoke();
		if (!enabled || !identity) return () => { stopped = true; revoke(); };

		const armExpiry = () => {
			clearTimeout(expiryTimer);
			const tick = () => {
				const current = lease.current;
				if (stopped || !current) return;
				const remaining = current.validForMs - elapsed(current.start);
				if (remaining <= 0) revoke();
				else expiryTimer = setTimeout(tick, Math.min(remaining, MAX_TIMER_MS));
			};
			tick();
		};
		const refresh = async () => {
			if (stopped || ended || request || document.hidden) return;
			const controller = new AbortController();
			const started = clock();
			request = controller;
			const ownsRequest = () => !stopped && request === controller && !controller.signal.aborted;
			timeout = setTimeout(() => {
				if (!ownsRequest()) return;
				status = "error";
				revalidationLease = null;
				revoke();
				inputs.current.onError?.(new Error("touchpoint_request_timeout"));
			}, REQUEST_TIMEOUT_MS);
			try {
				const result = await load(controller.signal, lease.current?.value ?? revalidationLease?.value ?? null);
				if (!ownsRequest()) return;
				clearTimeout(timeout);
				request = null;
				if (result.kind === "retain") {
					if (!lease.current && revalidationLease && elapsed(revalidationLease.start) < revalidationLease.validForMs) {
						lease.current = { ...revalidationLease, generation: generation.current };
						status = "active";
						publish();
						armExpiry();
					}
					revalidationLease = null;
					return;
				}
				revalidationLease = null;
				if (result.kind === "clear") {
					ended = result.ended === true;
					status = ended ? "ended" : null;
					revoke();
					return;
				}
				if (result.kind === "waiting") {
					if (!Number.isFinite(result.retryAfterMs)) throw new Error("touchpoint_invalid_timing");
					status = "before";
					revoke();
					const retry = () => {
						if (stopped) return;
						const remaining = result.retryAfterMs - elapsed(started);
						if (remaining > MAX_TIMER_MS) boundaryTimer = setTimeout(retry, MAX_TIMER_MS);
						else boundaryTimer = setTimeout(() => void refresh(), Math.max(100, remaining));
					};
					retry();
					return;
				}
				status = "active";
				clearTimeout(boundaryTimer);
				if (!Number.isFinite(result.validForMs) || result.validForMs <= elapsed(started)) {
					revoke();
					return;
				}
				const previous = lease.current;
				const same = previous?.key === result.key && previous.identity === identity && elapsed(previous.start) < previous.validForMs;
				if (!same) ++generation.current;
				lease.current = { identity, key: result.key, value: same ? previous.value : result.value, generation: generation.current, start: started, validForMs: result.validForMs };
				publish();
				armExpiry();
			} catch (error) {
				if (stopped || controller.signal.aborted) return;
				status = "error";
				revalidationLease = null;
				revoke();
				inputs.current.onError?.(error);
			} finally {
				if (request === controller) {
					request = null;
					clearTimeout(timeout);
				}
			}
		};
		const wake = () => {
			if (stopped || ended) return;
			revalidationLease = lease.current ?? revalidationLease;
			status = document.hidden ? status : "loading";
			revoke();
			if (!document.hidden) void refresh();
		};
		const offline = () => cancelRequest();
		void refresh();
		const interval = setInterval(() => void refresh(), POLL_MS);
		window.addEventListener("focus", wake);
		window.addEventListener("online", wake);
		window.addEventListener("pageshow", wake);
		window.addEventListener("offline", offline);
		document.addEventListener("visibilitychange", wake);
		return () => {
			stopped = true;
			revoke();
			clearInterval(interval);
			window.removeEventListener("focus", wake);
			window.removeEventListener("online", wake);
			window.removeEventListener("pageshow", wake);
			window.removeEventListener("offline", offline);
			document.removeEventListener("visibilitychange", wake);
		};
	}, [enabled, identity, load]);

	return {
		current: enabled && state.identity === identity ? state.current : null,
		status: enabled && state.identity === identity ? state.status : null,
		generation: state.generation,
		clear,
		isCurrent,
		get deadline() {
			const current = lease.current;
			return current && inputs.current.enabled && current.identity === inputs.current.identity ? Date.now() + Math.max(0, current.validForMs - elapsed(current.start)) : 0;
		},
	};
}
