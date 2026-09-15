// @vitest-environment jsdom
import {
	act,
	cleanup,
	fireEvent,
	render,
	waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import type { WebTouchpointContent } from "../../src/components/touchpoint-component";

const mounts = vi.fn(async () => undefined);
const disposes = vi.fn(async () => undefined);
const updates = vi.fn(async () => undefined);
const verify = vi.fn();
vi.mock("../../src/components/touchpoint-component", async () => ({
	ensureWebTouchpointElement: () => {
		if (!customElements.get("opend-touchpoint")) {
			customElements.define(
				"opend-touchpoint",
				class extends HTMLElement {
					mount = mounts;
					dispose = disposes;
					update = updates;
				},
			);
		}
		return customElements.get("opend-touchpoint");
	},
	verifyWebTouchpoint: verify,
	webTouchpointContext: vi.fn(() => ({
		instanceId: "instance",
		contentVersionId: "version",
		placementKey: "opend.home.hover-entry",
		locale: "en-US",
		theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
		fontFamily: "sans",
		cssVariables: {},
		mode: "production",
	})),
}));

const { HoverTouchpointOverlay } = await import(
	"../../src/components/HoverTouchpointOverlay"
);
const content = (placementKey: string): WebTouchpointContent => ({
	id: placementKey,
	placementKey,
	locale: "en-US",
	manifestHash: "sha256:x",
	entryPath: "component.js",
	entryDigest: "sha256:y",
	entryModule: "",
	resources: [],
	manifest: {
		formatVersion: 2,
		runtimeKind: "web-component",
		runtimeApiVersion: 1,
		platformWrapperVersion: "vela-touchpoint-wrapper-v1",
		sdkVersion: "vela-touchpoint-sdk-v1",
		contentLine: "test",
		placements: [
			{
				key: placementKey as never,
				entry: "component.js",
				resources: [],
				locales: ["en-US"],
				requiredCapabilities: [],
				staticActions: [],
			},
		],
		resources: [],
		images: [],
	},
	runtime: {
		kind: "web-component",
		apiVersion: 1,
		wrapperVersion: "vela-touchpoint-wrapper-v1",
		sdkVersion: "vela-touchpoint-sdk-v1",
	},
	buildIdentity: { fingerprint: "test" },
});
const verified = (dispose = vi.fn()) => ({
	entryUrl: "blob:entry",
	resourceUrls: new Map(),
	dispose,
});

beforeEach(() => {
	mounts.mockReset();
	mounts.mockResolvedValue(undefined);
	disposes.mockReset();
	disposes.mockResolvedValue(undefined);
	updates.mockReset();
	updates.mockResolvedValue(undefined);
	verify.mockReset();
	verify.mockResolvedValue(verified());
});
afterEach(() => cleanup());

describe("HoverTouchpointOverlay interaction boundary", () => {
	beforeAll(() => {
		(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
			observe() {}
			disconnect() {}
		};
	});
	it("keeps default action sets stable and handles pointer focus before click without reopening after Escape", async () => {
		const { container } = render(
			createElement(HoverTouchpointOverlay, {
				entry: content("opend.home.hover-entry"),
				layer: content("opend.home.hover-layer"),
			}),
		);
		const [entry, layer] = Array.from(
			container.querySelectorAll<HTMLElement>("opend-touchpoint"),
		);
		await waitFor(() => expect(entry).not.toHaveAttribute("hidden"));
		expect(entry).toHaveAttribute("class");
		expect(entry).not.toHaveAttribute("classname");
		fireEvent.pointerDown(entry!);
		act(() => entry!.focus());
		fireEvent.click(entry!);
		expect(layer!.parentElement).not.toHaveAttribute("hidden");
		const action = document.createElement("button");
		layer!.appendChild(action);
		act(() => action.focus());
		fireEvent.keyDown(window, { key: "Escape" });
		expect(layer!.parentElement).toHaveAttribute("hidden");
		expect(document.activeElement).toBe(entry);
		expect(mounts).toHaveBeenCalledTimes(2);
	});
	it.each(["test", "production"] as const)(
		"keeps %s hover elements and their expanded state through callback refreshes",
		async (mode) => {
			const firstEntryAction = vi.fn(async () => undefined);
			const nextEntryAction = vi.fn(async () => undefined);
			const view = render(
				createElement(HoverTouchpointOverlay, {
					entry: content("opend.home.hover-entry"),
					layer: content("opend.home.hover-layer"),
					mode,
					entryActionIds: new Set(["entry-action"]),
					layerActionIds: new Set(["layer-action"]),
					dispatchEntryAction: firstEntryAction,
					dispatchLayerAction: vi.fn(async () => undefined),
					onDiagnostic: vi.fn(),
					onEntryVisible: vi.fn(),
					onLayerVisible: vi.fn(),
				}),
			);
			await waitFor(() => expect(mounts).toHaveBeenCalledTimes(2));
			const [entry, layer] = Array.from(
				view.container.querySelectorAll<HTMLElement>("opend-touchpoint"),
			);
			if (!entry || !layer) throw new Error("expected mounted hover elements");
			fireEvent.pointerEnter(entry);
			expect(entry).toHaveAttribute("aria-expanded", "true");
			view.rerender(
				createElement(HoverTouchpointOverlay, {
					entry: content("opend.home.hover-entry"),
					layer: content("opend.home.hover-layer"),
					mode,
					entryActionIds: new Set(["entry-action"]),
					layerActionIds: new Set(["layer-action"]),
					dispatchEntryAction: nextEntryAction,
					dispatchLayerAction: vi.fn(async () => undefined),
					onDiagnostic: vi.fn(),
					onEntryVisible: vi.fn(),
					onLayerVisible: vi.fn(),
				}),
			);
			await act(async () => {});
			expect(
				Array.from(view.container.querySelectorAll("opend-touchpoint")),
			).toEqual([entry, layer]);
			expect(entry).toHaveAttribute("aria-expanded", "true");
			const entryMount = (
				mounts.mock.calls as unknown as Array<Array<unknown>>
			)[0]?.[5] as {
				dispatchAction: (actionId: string) => Promise<void>;
			};
			await entryMount.dispatchAction("entry-action");
			expect(nextEntryAction).toHaveBeenCalledWith("entry-action");
			expect(firstEntryAction).not.toHaveBeenCalled();
			expect(mounts).toHaveBeenCalledTimes(2);
			expect(disposes).not.toHaveBeenCalled();
		},
	);

	it("releases the current pair exactly once when the deployment identity changes with identical bytes", async () => {
		const view = render(
			createElement(HoverTouchpointOverlay, {
				entry: content("opend.home.hover-entry"),
				layer: content("opend.home.hover-layer"),
				mountIdentity: "deployment-a",
			}),
		);
		await waitFor(() => expect(mounts).toHaveBeenCalledTimes(2));
		view.rerender(
			createElement(HoverTouchpointOverlay, {
				entry: content("opend.home.hover-entry"),
				layer: content("opend.home.hover-layer"),
				mountIdentity: "deployment-b",
			}),
		);
		await waitFor(() => expect(mounts).toHaveBeenCalledTimes(4));
		expect(disposes).toHaveBeenCalledTimes(2);
	});

	it("updates the mounted host context when the theme changes", async () => {
		const view = render(
			createElement(HoverTouchpointOverlay, {
				entry: content("opend.home.hover-entry"),
				layer: content("opend.home.hover-layer"),
			}),
		);
		await waitFor(() => expect(mounts).toHaveBeenCalledTimes(2));
		updates.mockClear();
		document.documentElement.classList.add("dark");
		view.rerender(
			createElement(HoverTouchpointOverlay, {
				entry: content("opend.home.hover-entry"),
				layer: content("opend.home.hover-layer"),
			}),
		);
		await waitFor(() => expect(updates).toHaveBeenCalledTimes(2));
		expect(updates).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ theme: "dark" }),
			expect.any(Map),
		);
		document.documentElement.classList.remove("dark");
	});

	it("keeps the entry/layer pointer-focus union open, supports touch click and Escape, then disposes both adapter instances", async () => {
		const dispatchEntryAction = vi.fn(async () => undefined);
		const dispatchLayerAction = vi.fn(async () => undefined);
		const { container, unmount } = render(
			createElement(HoverTouchpointOverlay, {
				entry: content("opend.home.hover-entry"),
				layer: content("opend.home.hover-layer"),
				entryActionIds: new Set(["entry-action"]),
				layerActionIds: new Set(["layer-action"]),
				dispatchEntryAction,
				dispatchLayerAction,
			}),
		);
		const [entry, layer] = Array.from(
			container.querySelectorAll("opend-touchpoint"),
		) as HTMLElement[];
		expect(entry).toHaveAttribute("hidden");
		expect(layer).toHaveAttribute("hidden");
		await waitFor(() => expect(mounts).toHaveBeenCalledTimes(2));
		const [entryMount, layerMount] = mounts.mock.calls as unknown as Array<
			[
				string,
				string,
				unknown,
				unknown,
				ReadonlySet<string>,
				{ dispatchAction: (id: string) => Promise<void> },
			]
		>;
		expect([...entryMount![4]]).toEqual(["entry-action"]);
		expect([...layerMount![4]]).toEqual(["layer-action"]);
		await entryMount![5].dispatchAction("entry-action");
		await layerMount![5].dispatchAction("layer-action");
		expect(dispatchEntryAction).toHaveBeenCalledWith("entry-action");
		expect(dispatchLayerAction).toHaveBeenCalledWith("layer-action");
		await waitFor(() => expect(entry).not.toHaveAttribute("hidden"));
		fireEvent.pointerEnter(entry!);
		expect(layer!.parentElement).not.toHaveAttribute("hidden");
		fireEvent.pointerLeave(entry!, { relatedTarget: layer });
		expect(layer!.parentElement).not.toHaveAttribute("hidden");
		fireEvent.click(entry!);
		expect(layer!.parentElement).not.toHaveAttribute("hidden");
		fireEvent.click(entry!);
		fireEvent.keyDown(window, { key: "Escape" });
		expect(layer!.parentElement).toHaveAttribute("hidden");
		unmount();
		await waitFor(() => expect(disposes).toHaveBeenCalledTimes(2));
	});

	it("disposes a resource acquired after unmount during first verification", async () => {
		let resolveEntry!: (value: ReturnType<typeof verified>) => void;
		const entryDispose = vi.fn();
		verify.mockImplementationOnce(
			() =>
				new Promise<ReturnType<typeof verified>>((resolve) => {
					resolveEntry = resolve;
				}),
		);
		const { unmount } = render(
			createElement(HoverTouchpointOverlay, {
				entry: content("opend.home.hover-entry"),
				layer: content("opend.home.hover-layer"),
			}),
		);
		unmount();
		resolveEntry(verified(entryDispose));
		await waitFor(() => expect(entryDispose).toHaveBeenCalledOnce());
		expect(disposes).not.toHaveBeenCalled();
		expect(verify).toHaveBeenCalledOnce();
	});

	it("disposes every resource acquired after unmount during second verification", async () => {
		let resolveLayer!: (value: ReturnType<typeof verified>) => void;
		const entryDispose = vi.fn();
		const layerDispose = vi.fn();
		verify.mockResolvedValueOnce(verified(entryDispose)).mockImplementationOnce(
			() =>
				new Promise<ReturnType<typeof verified>>((resolve) => {
					resolveLayer = resolve;
				}),
		);
		const { unmount } = render(
			createElement(HoverTouchpointOverlay, {
				entry: content("opend.home.hover-entry"),
				layer: content("opend.home.hover-layer"),
			}),
		);
		await waitFor(() => expect(verify).toHaveBeenCalledTimes(2));
		unmount();
		resolveLayer(verified(layerDispose));
		await waitFor(() => expect(layerDispose).toHaveBeenCalledOnce());
		expect(entryDispose).toHaveBeenCalledOnce();
		expect(disposes).not.toHaveBeenCalled();
	});

	it("disposes acquired element and verified Blob resources when unmounted during a deferred mount", async () => {
		let resolveEntryMount!: (value: undefined) => void;
		mounts.mockImplementationOnce(
			() =>
				new Promise<undefined>((resolve) => {
					resolveEntryMount = resolve;
				}),
		);
		const entryDispose = vi.fn();
		const layerDispose = vi.fn();
		verify
			.mockResolvedValueOnce(verified(entryDispose))
			.mockResolvedValueOnce(verified(layerDispose));
		const { unmount } = render(
			createElement(HoverTouchpointOverlay, {
				entry: content("opend.home.hover-entry"),
				layer: content("opend.home.hover-layer"),
			}),
		);
		await waitFor(() => expect(mounts).toHaveBeenCalledTimes(1));
		unmount();
		resolveEntryMount(undefined);
		await waitFor(() => expect(disposes).toHaveBeenCalledTimes(2));
		expect(entryDispose).toHaveBeenCalledOnce();
		expect(layerDispose).toHaveBeenCalledOnce();
		expect(mounts).toHaveBeenCalledTimes(1);
	});

	it("disposes both verified Blob resources and both elements when the second mount fails", async () => {
		const entryDispose = vi.fn();
		const layerDispose = vi.fn();
		verify
			.mockResolvedValueOnce(verified(entryDispose))
			.mockResolvedValueOnce(verified(layerDispose));
		mounts
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error("layer_mount_failed"));
		render(
			createElement(HoverTouchpointOverlay, {
				entry: content("opend.home.hover-entry"),
				layer: content("opend.home.hover-layer"),
			}),
		);
		await waitFor(() => expect(disposes).toHaveBeenCalledTimes(2));
		expect(entryDispose).toHaveBeenCalledOnce();
		expect(layerDispose).toHaveBeenCalledOnce();
	});
});
