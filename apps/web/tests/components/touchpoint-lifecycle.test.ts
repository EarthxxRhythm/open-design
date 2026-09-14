// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@open-design/host", () => ({
	getOpenDesignHost: () => ({ client: { type: "desktop", osLocale: "en-US" } }),
}));
import {
	mountTouchpoint,
	startTouchpointRefresh,
} from "../../src/components/touchpoint-lifecycle";
import * as host from "../../src/components/touchpoint-component";

const content: host.WebTouchpointContent = {
	id: "content-1",
	placementKey: "opend.home.campaign-modal",
	locale: "en-US",
	manifestHash: "sha256:manifest",
	entryPath: "entry.js",
	entryDigest: "sha256:entry",
	entryModule: "",
	resources: [],
	buildIdentity: { fingerprint: "test" },
	runtime: {
		kind: "web-component",
		apiVersion: 1,
		wrapperVersion: "vela-touchpoint-wrapper-v1",
		sdkVersion: "vela-touchpoint-sdk-v1",
	},
	manifest: {
		formatVersion: 2,
		runtimeKind: "web-component",
		runtimeApiVersion: 1,
		platformWrapperVersion: "vela-touchpoint-wrapper-v1",
		sdkVersion: "vela-touchpoint-sdk-v1",
		contentLine: "test",
		resources: ["entry.js"],
		images: [],
		placements: [
			{
				key: "opend.home.campaign-modal",
				entry: "entry.js",
				resources: [],
				locales: ["en-US"],
				requiredCapabilities: [],
				staticActions: [],
			},
		],
	},
};
let releases: Array<() => void>;
beforeEach(() => {
	vi.useFakeTimers();
	releases = [];
	vi.spyOn(document, "hidden", "get").mockReturnValue(false);
	vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue(
		Object.assign([], { item: () => null }),
	);
});
afterEach(() => {
	releases.forEach((release) => release());
	document.body.replaceChildren();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

// Both delivery adapters cross exactly the same lifecycle interface. Transport,
// authorization and receipt differences do not select a second DOM implementation.
describe.each(["test", "production"] as const)(
	"shared %s lifecycle",
	(mode) => {
		const setup = () => {
			const container = document.createElement("div");
			document.body.append(container);
			const resources = {
				entryUrl: "blob:content",
				resourceUrls: new Map<string, string>(),
				dispose: vi.fn(),
			};
			const verify = vi
				.spyOn(host, "verifyWebTouchpoint")
				.mockResolvedValue(resources);
			const dispose = vi
				.spyOn(host.OpenDesignTouchpointElement.prototype, "dispose")
				.mockResolvedValue();
			const mount = vi
				.spyOn(host.OpenDesignTouchpointElement.prototype, "mount")
				.mockImplementation(async function (
					this: host.OpenDesignTouchpointElement,
				) {
					this.shadowRoot?.replaceChildren(document.createTextNode("campaign"));
				});
			const onVisible = vi.fn(),
				dispatchAction = vi.fn(async () => {}),
				requestClose = vi.fn();
			let authorized = true;
			const start = () => {
				const release = mountTouchpoint(container, {
					content,
					placementKey: content.placementKey,
					staticActions: [],
					mode,
					locale: "en-US",
					isCurrent: () => authorized,
					dispatchAction,
					requestClose,
					onVisible,
				});
				releases.push(release);
				return release;
			};
			return {
				container,
				resources,
				verify,
				dispose,
				mount,
				onVisible,
				dispatchAction,
				requestClose,
				start,
				revoke: () => {
					authorized = false;
				},
			};
		};
		it("uses the common host and reports visibility only once after it becomes visible", async () => {
			const s = setup();
			let visible = false;
			vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(() =>
				Object.assign(visible ? [new DOMRect()] : [], { item: () => null }),
			);
			s.start();
			await vi.advanceTimersByTimeAsync(16);
			expect(
				s.container.querySelector("opend-touchpoint")?.shadowRoot?.textContent,
			).toBe("campaign");
			expect(s.mount.mock.calls[0]?.[2].mode).toBe(mode);
			expect(s.onVisible).not.toHaveBeenCalled();
			visible = true;
			document.dispatchEvent(new Event("visibilitychange"));
			await vi.advanceTimersByTimeAsync(16);
			expect(s.onVisible).toHaveBeenCalledTimes(1);
			document.dispatchEvent(new Event("visibilitychange"));
			await vi.advanceTimersByTimeAsync(16);
			expect(s.onVisible).toHaveBeenCalledTimes(1);
		});
		it("disposes late verification once and never mounts after cleanup", async () => {
			const s = setup();
			let resolve!: (value: typeof s.resources) => void;
			s.verify.mockReturnValue(
				new Promise((r) => {
					resolve = r;
				}),
			);
			const release = s.start();
			release();
			resolve(s.resources);
			await vi.advanceTimersByTimeAsync(0);
			expect(s.mount).not.toHaveBeenCalled();
			expect(s.resources.dispose).toHaveBeenCalledTimes(1);
			expect(s.dispose).toHaveBeenCalledTimes(1);
			expect(s.container.childNodes.length).toBe(0);
		});
		it("does not report or authorize actions after a pending mount is released", async () => {
			const s = setup();
			let finish!: () => void;
			s.mount.mockImplementation(
				() =>
					new Promise<void>((resolve) => {
						finish = resolve;
					}),
			);
			const release = s.start();
			await vi.advanceTimersByTimeAsync(0);
			release();
			finish();
			await vi.advanceTimersByTimeAsync(16);
			const callbacks = s.mount.mock.calls[0]?.[5];
			await callbacks?.dispatchAction?.("learn");
			callbacks?.requestClose?.();
			expect(s.dispatchAction).not.toHaveBeenCalled();
			expect(s.requestClose).not.toHaveBeenCalled();
			expect(s.onVisible).not.toHaveBeenCalled();
			expect(s.resources.dispose).toHaveBeenCalledTimes(1);
		});
		it("consults the adapter's live authorization for actions and visibility", async () => {
			const s = setup();
			s.start();
			await vi.advanceTimersByTimeAsync(0);
			const callbacks = s.mount.mock.calls[0]?.[5];
			await callbacks?.dispatchAction?.("learn");
			expect(s.dispatchAction).toHaveBeenCalledOnce();
			s.revoke();
			await callbacks?.dispatchAction?.("learn");
			callbacks?.requestClose?.();
			await vi.advanceTimersByTimeAsync(16);
			expect(s.dispatchAction).toHaveBeenCalledOnce();
			expect(s.requestClose).not.toHaveBeenCalled();
			expect(s.onVisible).not.toHaveBeenCalled();
		});
		it("rejects action identities not declared by the content manifest", async () => {
			const s = setup();
			const onError = vi.fn();
			releases.push(
				mountTouchpoint(s.container, {
					content,
					placementKey: content.placementKey,
					staticActions: [
						{
							id: "unexpected",
							target: { kind: "https", url: "https://example.com" },
						},
					],
					mode,
					locale: "en-US",
					isCurrent: () => true,
					dispatchAction: s.dispatchAction,
					onError,
				}),
			);
			await vi.advanceTimersByTimeAsync(0);
			expect(onError).toHaveBeenCalledWith("touchpoint_decision_mismatch");
			expect(s.mount).not.toHaveBeenCalled();
			expect(s.resources.dispose).toHaveBeenCalledOnce();
		});
	},
);

describe("shared refresh schedule", () => {
	it("shares the 30 second boundary, all wake events, hidden pause and cleanup", async () => {
		const refresh = vi.fn(async () => {});
		const stop = startTouchpointRefresh(refresh);
		releases.push(stop);
		expect(refresh).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(29999);
		expect(refresh).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(refresh).toHaveBeenCalledTimes(2);
		const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
		await vi.advanceTimersByTimeAsync(60000);
		window.dispatchEvent(new Event("focus"));
		expect(refresh).toHaveBeenCalledTimes(2);
		hidden.mockReturnValue(false);
		document.dispatchEvent(new Event("visibilitychange"));
		window.dispatchEvent(new Event("focus"));
		window.dispatchEvent(new Event("online"));
		expect(refresh).toHaveBeenCalledTimes(5);
		stop();
		await vi.advanceTimersByTimeAsync(60000);
		document.dispatchEvent(new Event("visibilitychange"));
		window.dispatchEvent(new Event("focus"));
		window.dispatchEvent(new Event("online"));
		expect(refresh).toHaveBeenCalledTimes(5);
	});
});
