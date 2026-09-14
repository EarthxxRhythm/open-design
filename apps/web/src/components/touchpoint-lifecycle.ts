import type { TouchpointStaticAction } from "./touchpoint-static-actions";
import { touchpointStaticActionsMatch } from "./touchpoint-static-actions";
import {
	ensureWebTouchpointElement,
	emitWebTouchpointDiagnostic,
	hasWebTouchpointCloseControl,
	readWebTouchpointHostContext,
	verifyWebTouchpoint,
	webTouchpointContext,
	type WebTouchpointContent,
	type OpenDesignTouchpointElement,
} from "./touchpoint-component";

/** One refresh schedule for Test discovery and Production decisions. Owners retain
 * their request/authorization fences and dispose them before stopping this schedule. */
export function startTouchpointRefresh(
	refresh: () => Promise<void>,
): () => void {
	const wake = () => {
		if (!document.hidden) void refresh();
	};
	void refresh();
	const timer = window.setInterval(wake, 30_000);
	window.addEventListener("focus", wake);
	window.addEventListener("online", wake);
	document.addEventListener("visibilitychange", wake);
	return () => {
		window.clearInterval(timer);
		window.removeEventListener("focus", wake);
		window.removeEventListener("online", wake);
		document.removeEventListener("visibilitychange", wake);
	};
}

type MountAdapter = Readonly<{
	content: WebTouchpointContent;
	placementKey: string;
	staticActions: readonly TouchpointStaticAction[];
	mode: "test" | "production";
	locale: string;
	isCurrent: () => boolean;
	dispatchAction: (id: string) => Promise<void>;
	requestClose?: () => void;
	onReady?: () => void;
	onVisible?: () => void;
	onCloseControlChange?: (available: boolean | null) => void;
	onError?: (code: string) => void;
}>;

/** Shared Test/Production host lifecycle. Late verification and mount completion
 * cannot resurrect a released host; each resource is disposed once. Adapters own
 * authorization, action transport and receipts, never the DOM lifecycle. */
export function mountTouchpoint(
	container: HTMLElement,
	adapter: MountAdapter,
): () => void {
	ensureWebTouchpointElement();
	const element = document.createElement(
		"opend-touchpoint",
	) as OpenDesignTouchpointElement;
	let cancelled = false,
		elementDisposed = false,
		verifiedDisposed = false;
	let verified: Awaited<ReturnType<typeof verifyWebTouchpoint>> | undefined;
	let frame: number | undefined;
	let mounted = false,
		recorded = false;
	let observer: MutationObserver | undefined;
	const current = () => !cancelled && adapter.isCurrent();
	const dispose = () => {
		if (!elementDisposed) {
			elementDisposed = true;
			void element.dispose(verified?.resourceUrls).catch(() => undefined);
		}
		if (verified && !verifiedDisposed) {
			verifiedDisposed = true;
			verified.dispose();
		}
	};
	const recordWhenVisible = () => {
		if (!mounted || recorded || frame !== undefined || !adapter.onVisible)
			return;
		frame = requestAnimationFrame(() => {
			frame = undefined;
			if (
				!current() ||
				document.hidden ||
				!element.isConnected ||
				element.hidden ||
				element.getClientRects().length === 0
			)
				return;
			recorded = true;
			adapter.onVisible?.();
		});
	};
	const fail = (code: string) => {
		emitWebTouchpointDiagnostic({ code });
		adapter.onCloseControlChange?.(false);
		adapter.onError?.(code);
	};
	adapter.onCloseControlChange?.(null);
	container.replaceChildren(element);
	document.addEventListener("visibilitychange", recordWhenVisible);
	void (async () => {
		try {
			verified = await verifyWebTouchpoint(adapter.content);
			if (!current()) {
				dispose();
				return;
			}
			const placement = adapter.content.manifest.placements.find(
				(p) => p.key === adapter.placementKey,
			);
			if (
				!placement ||
				adapter.content.placementKey !== adapter.placementKey ||
				!touchpointStaticActionsMatch(
					adapter.staticActions,
					placement.staticActions,
				)
			) {
				fail("touchpoint_decision_mismatch");
				dispose();
				return;
			}
			const context = webTouchpointContext(
				adapter.content,
				readWebTouchpointHostContext(
					adapter.locale,
					document.documentElement.classList.contains("dark")
						? "dark"
						: "light",
				),
			);
			if (!context) {
				fail("touchpoint_locale_unsupported");
				dispose();
				return;
			}
			await element.mount(
				verified.entryUrl,
				adapter.content.entryDigest,
				{ ...context, mode: adapter.mode },
				verified.resourceUrls,
				new Set(adapter.staticActions.map((a) => a.id)),
				{
					requestClose: adapter.requestClose
						? () => {
								if (current()) adapter.requestClose?.();
							}
						: undefined,
					dispatchAction: async (id) => {
						if (current()) await adapter.dispatchAction(id);
					},
					onDiagnostic: emitWebTouchpointDiagnostic,
				},
			);
			if (!current()) {
				dispose();
				return;
			}
			mounted = true;
			if (adapter.onCloseControlChange) {
				const update = () => {
					if (current())
						adapter.onCloseControlChange?.(
							hasWebTouchpointCloseControl(element),
						);
				};
				update();
				observer = new MutationObserver(update);
				const options: MutationObserverInit = {
					attributes: true,
					attributeFilter: [
						"aria-label",
						"aria-disabled",
						"aria-hidden",
						"class",
						"disabled",
						"hidden",
						"style",
						"title",
					],
					childList: true,
					characterData: true,
					subtree: true,
				};
				if (element.shadowRoot) observer.observe(element.shadowRoot, options);
				const dialog = element.closest('[role="dialog"]');
				if (dialog) observer.observe(dialog, options);
			}
			adapter.onReady?.();
			recordWhenVisible();
		} catch (error) {
			if (current())
				fail(error instanceof Error ? error.message : "touchpoint_load_failed");
			dispose();
		}
	})();
	return () => {
		cancelled = true;
		observer?.disconnect();
		document.removeEventListener("visibilitychange", recordWhenVisible);
		if (frame !== undefined) cancelAnimationFrame(frame);
		adapter.onCloseControlChange?.(null);
		dispose();
		if (element.parentNode === container) container.replaceChildren();
	};
}
