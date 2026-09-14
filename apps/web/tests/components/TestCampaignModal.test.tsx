// @vitest-environment jsdom
import { createHash } from "node:crypto";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type CampaignHostGlobal = typeof globalThis & {
	__openDesignCampaignTestHost?: unknown;
};
vi.mock("@open-design/host", () => ({
	OPEN_DESIGN_HOST_VERSION: 2,
	getOpenDesignHost: () =>
		(globalThis as CampaignHostGlobal).__openDesignCampaignTestHost,
}));

import { ProductionCampaignModal } from "../../src/components/ProductionCampaignModal";
import type { TestDecision, TestDeployment, TestRuntimeSession } from "../../src/components/TestCampaignModal";
import {
	TestCampaignModal,
	TestTouchpointMount,
	setTestRuntimeSession,
	useTestRuntime,
	recordVisibleTestTouchpoint,
} from "../../src/components/TestCampaignModal";
import * as touchpointComponent from "../../src/components/touchpoint-component";
import { OpenDesignTouchpointElement } from "../../src/components/touchpoint-component";

const digest = (value: string) =>
	`sha256:${createHash("sha256").update(value).digest("hex")}`;
const openExternalUrlMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../../src/providers/registry", () => ({ openExternalUrl: openExternalUrlMock }));

const entryModule =
	"export function mount(root) { root.textContent = 'Verified campaign'; return root; }";
const manifest = {
	formatVersion: 2 as const,
	runtimeKind: "web-component" as const,
	runtimeApiVersion: 1 as const,
	platformWrapperVersion: "vela-touchpoint-wrapper-v1" as const,
	sdkVersion: "vela-touchpoint-sdk-v1" as const,
	contentLine: "test",
	placements: [
		{
			key: "opend.home.campaign-modal" as const,
			entry: "component.js",
			resources: [],
			locales: ["en-US"],
			requiredCapabilities: ["close"],
			staticActions: [],
		},
	],
	resources: ["component.js"],
	images: [],
};
const content = {
	id: "version-1",
	placementKey: "opend.home.campaign-modal",
	locale: "en-US",
	manifestHash: digest(JSON.stringify(manifest)),
	entryPath: "component.js",
	entryDigest: digest(entryModule),
	entryModule,
	resources: [
		{
			path: "component.js",
			digest: digest(entryModule),
			bytes: btoa(entryModule),
		},
	],
	runtime: {
		kind: "web-component" as const,
		apiVersion: 1 as const,
		wrapperVersion: "vela-touchpoint-wrapper-v1" as const,
		sdkVersion: "vela-touchpoint-sdk-v1" as const,
	},
	buildIdentity: { fingerprint: "fixed" },
	manifest,
};
function runtime(contentValue: unknown = content) {
	const context = {
		deploymentId: "deployment-1",
		scenario: "active" as const,
		simulatedAt: "2030-01-01T00:00:00.000Z",
		updatedAt: "2030-01-01T00:00:00.000Z",
	};
	return {
		activityId: "activity-1",
		snapshotHash: "sha256:test-snapshot",
		artifactHash: "sha256:test-artifact",
		manifestHash: content.manifestHash,
		deploymentId: "deployment-1",
		placementKey: "opend.home.campaign-modal",
		requiredCapabilities: ["close"],
		staticActions: [],
		context,
		testContext: { ...context, scheduleState: "active" as const },
		content: contentValue,
	};
}
function fetches(response: Record<string, unknown> = runtime()) {
	return vi.fn(
		async (url: string) =>
			new Response(
				JSON.stringify(
					url.includes("deployments")
						? {
								deployments: [
									{
										id: "deployment-1",
										activityId: "activity-1",
										snapshotHash: "sha256:test-snapshot",
										snapshot: {
											contentVersionId: content.id,
											manifestHash: content.manifestHash,
											artifactHash: "sha256:test-artifact",
											placementKeys: ["opend.home.campaign-modal"],
										},
									},
								],
							}
						: url.includes("context")
							? response.context
							: response,
				),
				{ status: 200 },
			),
	);
}

const allTestPlacements = [
	"opend.home.account-badge",
	"opend.home.campaign-modal",
	"opend.home.hover-entry",
	"opend.home.hover-layer",
] as const;
const allTestManifest = {
	formatVersion: 2 as const,
	runtimeKind: "web-component" as const,
	runtimeApiVersion: 1 as const,
	platformWrapperVersion: "vela-touchpoint-wrapper-v1" as const,
	sdkVersion: "vela-touchpoint-sdk-v1" as const,
	contentLine: "four-placement-test",
	placements: allTestPlacements.map((key) => ({
		key,
		entry: `${key.split(".").at(-1)}.js`,
		resources: [],
		locales: ["zh-CN"],
		requiredCapabilities:
			key === "opend.home.campaign-modal"
				? ["close", "static-action"]
				: key === "opend.home.account-badge"
					? ["static-action"]
					: ["hover", "static-action"],
		staticActions: [],
	})),
	resources: allTestPlacements.map((key) => `${key.split(".").at(-1)}.js`),
	images: [],
};
function fourPlacementContent(
	placementKey: (typeof allTestPlacements)[number],
) {
	const entryPath = `${placementKey.split(".").at(-1)}.js`;
	const module =
		"export function mount(root) { root.textContent = 'Verified campaign'; return root; }";
	return {
		...content,
		id: "version-four-placement",
		placementKey,
		locale: "zh-CN",
		manifest: allTestManifest,
		manifestHash: digest(JSON.stringify(allTestManifest)),
		entryPath,
		entryDigest: digest(module),
		entryModule: module,
		resources: [
			{ path: entryPath, digest: digest(module), bytes: btoa(module) },
		],
	};
}
function TestRuntimeProbe() {
	const runtime = useTestRuntime();
	return (
		<output
			data-testid="test-runtime-decision-count"
			data-selected={runtime?.deployment.id ?? ""}
		>
			{runtime?.decisions.size ?? 0}
		</output>
	);
}
function TestCampaignHarness({
	authenticated,
	sessionSubject = "account-a",
}: {
	authenticated: boolean;
	sessionSubject?: string | null;
}) {
	return (
		<>
			<TestCampaignModal
				authenticated={authenticated}
				sessionSubject={sessionSubject}
			/>
			<ProductionCampaignModal
				authenticated={authenticated}
				sessionSubject={sessionSubject ?? null}
			/>
		</>
	);
}
beforeEach(() => {
	window.history.replaceState(null, "", "/?cmsTestControls=1");
	(globalThis as CampaignHostGlobal).__openDesignCampaignTestHost = {
		version: 2,
		client: { type: "desktop" },
	};
});
afterEach(() => {
  setTestRuntimeSession(null);
  openExternalUrlMock.mockClear();
	window.history.replaceState(null, "", "/");
	delete (globalThis as CampaignHostGlobal).__openDesignCampaignTestHost;
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});
describe("Test campaign live refresh", () => {
	let observed: TestRuntimeSession | null = null;
	function Observe() {
		observed = useTestRuntime();
		return <TestRuntimeProbe />;
	}
	const currentSession = () => observed;
	const deployment = (id = "deployment-1"): TestDeployment => ({
		id,
		activityId: `activity-${id}`,
		snapshotHash: `sha256:${id}`,
		snapshot: {
			contentVersionId: content.id,
			manifestHash: content.manifestHash,
			artifactHash: "sha256:test-artifact",
			placementKeys: ["opend.home.campaign-modal"],
		},
	});
	function fixture() {
		const state = {
			deployments: [deployment()],
			listStatus: 200,
			contextStatus: 200,
		};
		const fetchMock = vi.fn(
			async (url: string, init?: RequestInit): Promise<Response> => {
				if (url.endsWith("/deployments"))
					return Response.json(
						{ deployments: state.deployments },
						{ status: state.listStatus },
					);
				if (url.endsWith("/acceptances")) return Response.json({});
				if (!url.startsWith("/api/touchpoints/test-runtime"))
					return Response.json({}, { status: 404 });
				const id = url.endsWith("/context")
					? JSON.parse(String(init?.body)).deploymentId
					: new URL(url, "http://localhost").searchParams.get("deploymentId");
				const selected = state.deployments.find(
					(candidate) => candidate.id === id,
				);
				if (!selected) return Response.json({}, { status: 404 });
				const context = { ...runtime().context, deploymentId: selected.id };
				if (url.endsWith("/context"))
					return Response.json(context, { status: state.contextStatus });
				return Response.json({
					...runtime(),
					activityId: selected.activityId,
					deploymentId: selected.id,
					snapshotHash: selected.snapshotHash,
					testContext: { ...context, scheduleState: "active" },
				});
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		return { state, fetchMock };
	}
	async function open() {
		return await act(async () =>
			render(
				<>
					<TestCampaignModal authenticated sessionSubject="account-a" />
					<Observe />
				</>,
			),
		);
	}
	async function tick() {
		await act(async () => {
			await vi.advanceTimersByTimeAsync(30_000);
		});
	}
	beforeEach(() => {
		vi.useFakeTimers();
		window.history.replaceState(null, "", "/");
		observed = null;
	});
	afterEach(() => {
		cleanup();
		vi.useRealTimers();
	});
	it("discovers a Test published after the client opened within 30 seconds", async () => {
		vi.useFakeTimers();
		window.history.replaceState(null, "", "/");
		let published = false;
		const baseline = fetches();
		const fetchMock = vi.fn(async (url: string) =>
			url.endsWith("/deployments") && !published
				? Response.json({ deployments: [] })
				: baseline(url),
		);
		vi.stubGlobal("fetch", fetchMock);
		try {
			await act(async () => {
				render(
					<>
						<TestCampaignModal authenticated sessionSubject="account-a" />
						<TestRuntimeProbe />
					</>,
				);
			});
			expect(
				screen.getByTestId("test-runtime-decision-count").textContent,
			).toBe("0");
			published = true;
			await act(async () => {
				await vi.advanceTimersByTimeAsync(29_999);
			});
			expect(
				screen.getByTestId("test-runtime-decision-count").textContent,
			).toBe("0");
			await act(async () => {
				await vi.advanceTimersByTimeAsync(1);
			});
			expect(
				screen.getByTestId("test-runtime-decision-count").textContent,
			).toBe("1");
		} finally {
			cleanup();
			vi.useRealTimers();
		}
	});
	it.each(["focus", "online", "visibilitychange"])(
		"refreshes immediately on %s",
		async (event) => {
			const { state } = fixture();
			state.deployments = [];
			await open();
			state.deployments = [deployment()];
			await act(async () => {
				(event === "visibilitychange" ? document : window).dispatchEvent(
					new Event(event),
				);
			});
			expect(currentSession()?.decisions.size).toBe(1);
		},
	);

	it("preserves the session, simulated clock and acceptance dedup on unchanged polls", async () => {
		const { fetchMock } = fixture();
		await open();
		const session = currentSession();
		const decision = session?.decisions.get("opend.home.campaign-modal");
		if (!session || !decision) throw new Error("Test session did not load");
		await act(async () =>
			recordVisibleTestTouchpoint(
				session,
				decision,
				"opend.home.campaign-modal",
			),
		);
		await tick();
		expect(currentSession()).toBe(session);
		await act(async () =>
			recordVisibleTestTouchpoint(
				session,
				decision,
				"opend.home.campaign-modal",
			),
		);
		expect(
			fetchMock.mock.calls.filter(([url]) => url.endsWith("/context")),
		).toHaveLength(1);
		expect(
			fetchMock.mock.calls.filter(([url]) => url.endsWith("/acceptances")),
		).toHaveLength(1);
	});

	it("keeps mounted content stable and does not reopen a dismissed modal on polling", async () => {
		fixture();
		vi.spyOn(touchpointComponent, "verifyWebTouchpoint").mockResolvedValue({
			entryUrl: "blob:live-test",
			resourceUrls: new Map(),
			dispose: vi.fn(),
		});
		const mount = vi
			.spyOn(OpenDesignTouchpointElement.prototype, "mount")
			.mockResolvedValue();
		await act(async () => render(<TestCampaignHarness authenticated />));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(50);
		});
		expect(screen.queryByRole("dialog")).not.toBeNull();
		expect(mount).toHaveBeenCalledTimes(1);
		await tick();
		expect(mount).toHaveBeenCalledTimes(1);
		fireEvent.keyDown(document, { key: "Escape" });
		expect(screen.queryByRole("dialog")).toBeNull();
		await tick();
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(mount).toHaveBeenCalledTimes(1);
	});

	it("resumes Production requests only after Test withdrawal is confirmed", async () => {
		const { state, fetchMock } = fixture();
		state.contextStatus = 503;
		await act(async () => render(<TestCampaignHarness authenticated />));
		const productionCalls = () =>
			fetchMock.mock.calls.filter(([url]) =>
				url.startsWith("/api/touchpoints/production-runtime"),
			).length;
		const before = productionCalls();
		await tick();
		expect(productionCalls()).toBe(before);
		state.deployments = [];
		await tick();
		expect(productionCalls()).toBeGreaterThan(before);
	});

	it("replaces the snapshot and clears Test on confirmed withdrawal", async () => {
		const { state } = fixture();
		await open();
		state.deployments = [deployment("deployment-2")];
		await tick();
		expect(currentSession()?.deployment.id).toBe("deployment-2");
		expect(
			currentSession()?.decisions.get("opend.home.campaign-modal")
				?.deploymentId,
		).toBe("deployment-2");
		state.deployments = [];
		await tick();
		expect(currentSession()).toBeNull();
	});

	it("keeps Test isolation on list failure and retries on the next tick", async () => {
		const { state } = fixture();
		await open();
		const session = currentSession();
		state.listStatus = 503;
		state.deployments = [];
		await tick();
		expect(currentSession()).toBe(session);
		state.listStatus = 200;
		await tick();
		expect(currentSession()).toBeNull();
	});

	it("retries a failed context without requiring remount or allowing Production", async () => {
		const { state } = fixture();
		state.contextStatus = 503;
		await open();
		expect(currentSession()?.deployment.id).toBe("deployment-1");
		expect(currentSession()?.decisions.size).toBe(0);
		state.contextStatus = 200;
		await tick();
		expect(currentSession()?.decisions.size).toBe(1);
	});

	it("ignores a stale deployment response even when fetch ignores cancellation", async () => {
		const { fetchMock } = fixture();
		let resolveOld!: (response: Response) => void;
		fetchMock.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveOld = resolve;
				}),
		);
		await open();
		await act(async () => window.dispatchEvent(new Event("focus")));
		const current = currentSession();
		expect(current?.decisions.size).toBe(1);
		await act(async () => resolveOld(Response.json({ deployments: [] })));
		expect(currentSession()).toBe(current);
		expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
	});

	it("ignores an old context after a replacement selection completes", async () => {
		const { state, fetchMock } = fixture();
		const normal = fetchMock.getMockImplementation()!;
		let resolveOld!: (response: Response) => void;
		let deferred = false;
		fetchMock.mockImplementation((url, init) => {
			if (url.endsWith("/context") && !deferred) {
				deferred = true;
				return new Promise((resolve) => {
					resolveOld = resolve;
				});
			}
			return normal(url, init);
		});
		await open();
		state.deployments = [deployment("deployment-2")];
		await tick();
		const current = currentSession();
		expect(current?.deployment.id).toBe("deployment-2");
		expect(current?.decisions.size).toBe(1);
		await act(async () => resolveOld(Response.json(runtime().context)));
		expect(currentSession()).toBe(current);
	});

	it("stops background polling while hidden and refreshes on becoming visible", async () => {
		const { fetchMock } = fixture();
		await open();
		const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
		const count = fetchMock.mock.calls.length;
		await tick();
		expect(fetchMock).toHaveBeenCalledTimes(count);
		hidden.mockReturnValue(false);
		await act(async () =>
			document.dispatchEvent(new Event("visibilitychange")),
		);
		expect(fetchMock).toHaveBeenCalledTimes(count + 1);
	});

	it("cancels pending work on logout and removes timers/listeners on unmount", async () => {
		const { fetchMock } = fixture();
		let resolveOld!: (response: Response) => void;
		fetchMock.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveOld = resolve;
				}),
		);
		const view = await open();
		await act(async () =>
			view.rerender(
				<>
					<TestCampaignModal authenticated={false} sessionSubject={null} />
					<Observe />
				</>,
			),
		);
		expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
		await act(async () =>
			resolveOld(Response.json({ deployments: [deployment()] })),
		);
		expect(currentSession()).toBeNull();
		view.unmount();
		const count = fetchMock.mock.calls.length;
		await act(async () => {
			window.dispatchEvent(new Event("focus"));
			window.dispatchEvent(new Event("online"));
			document.dispatchEvent(new Event("visibilitychange"));
			await vi.advanceTimersByTimeAsync(60_000);
		});
		expect(fetchMock).toHaveBeenCalledTimes(count);
	});
});

describe("TestCampaignModal", () => {
	it("is default-deny without the real desktop host", () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		render(<TestCampaignModal authenticated={false} />);
		expect(screen.queryByTestId("touchpoint-test-selector")).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});
	it("automatically presents the Test campaign without client debug controls", async () => {
		window.history.replaceState(null, "", "/");
		const fetchMock = fetches();
		vi.stubGlobal("fetch", fetchMock);
		render(<TestCampaignHarness authenticated />);
		await screen.findByRole("dialog");
		expect(screen.queryByTestId("touchpoint-test-selector")).toBeNull();
		expect(screen.queryByTestId("touchpoint-test-clock")).toBeNull();
		expect(fetchMock).toHaveBeenCalledWith(
			"/api/touchpoints/test-runtime/context",
			expect.objectContaining({
				body: JSON.stringify({
					deploymentId: "deployment-1",
					scenario: "active",
				}),
			}),
		);
	});

	it("uses the selected Test decision to create a v2 ShadowRoot custom element, never iframe or webview", async () => {
		vi.stubGlobal("fetch", fetches());
		render(<TestCampaignHarness authenticated />);
		await screen.findByTestId("touchpoint-test-selector");
		fireEvent.change(screen.getByLabelText("Test activity"), {
			target: { value: "deployment-1" },
		});
		await screen.findByRole("dialog");
		expect(
			screen
				.getByTestId("campaign-custom-element")
				.querySelector("opend-touchpoint")?.shadowRoot,
		).not.toBeNull();
		expect(document.querySelector("iframe,webview")).toBeNull();
	});
	it("cleans host scroll lock and restores focus after Escape", async () => {
		const trigger = document.createElement("button");
		document.body.append(trigger);
		trigger.focus();
		vi.spyOn(touchpointComponent, "verifyWebTouchpoint").mockResolvedValue({
			entryUrl: "blob:test-campaign",
			resourceUrls: new Map(),
			dispose: vi.fn(),
		} as never);
		vi.spyOn(
			OpenDesignTouchpointElement.prototype,
			"mount",
		).mockResolvedValue();
		vi.stubGlobal("fetch", fetches());
		render(<TestCampaignHarness authenticated />);
		await screen.findByTestId("touchpoint-test-selector");
		fireEvent.change(screen.getByLabelText("Test activity"), {
			target: { value: "deployment-1" },
		});
		await screen.findByRole("dialog");
		await waitFor(() => expect(document.body.style.overflow).toBe("hidden"));
		fireEvent.keyDown(document, { key: "Escape" });
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(document.body.style.overflow).toBe("");
		expect(document.activeElement).toBe(trigger);
		trigger.remove();
	});
	it("SDK requestClose clears the active decision and disposes its custom element", async () => {
		const { OpenDesignTouchpointElement } = await import(
			"../../src/components/touchpoint-component"
		);
		let requestClose: (() => void) | undefined;
		const mount = vi
			.spyOn(OpenDesignTouchpointElement.prototype, "mount")
			.mockImplementation(
				async (_entry, _digest, _context, _resources, _actions, options) => {
					requestClose = options?.requestClose;
				},
			);
		const dispose = vi.spyOn(OpenDesignTouchpointElement.prototype, "dispose");
		vi.stubGlobal("fetch", fetches());
		render(<TestCampaignHarness authenticated />);
		await screen.findByTestId("touchpoint-test-selector");
		fireEvent.change(screen.getByLabelText("Test activity"), {
			target: { value: "deployment-1" },
		});
		await screen.findByRole("dialog");
		await waitFor(() => expect(requestClose).toBeTypeOf("function"));
		requestClose?.();
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(document.body.style.overflow).toBe("");
		expect(dispose).toHaveBeenCalled();
		mount.mockRestore();
		dispose.mockRestore();
	});
});

describe("CMS modal host cleanup", () => {
	it("holds the host scroll lock until every concurrent CMS modal releases it", async () => {
		const { lockWebTouchpointModalScroll } = await import(
			"../../src/components/touchpoint-component"
		);
		const releaseFirst = lockWebTouchpointModalScroll();
		const releaseSecond = lockWebTouchpointModalScroll();
		expect(document.body.style.overflow).toBe("hidden");
		releaseFirst();
		expect(document.body.style.overflow).toBe("hidden");
		releaseSecond();
		expect(document.body.style.overflow).toBe("");
	});
});

describe("TestCampaignModal host guards", () => {
	it("refreshes close-control availability when a shadow control becomes enabled", async () => {
		let closeControl!: HTMLButtonElement;
		vi.spyOn(touchpointComponent, "verifyWebTouchpoint").mockResolvedValue({
			entryUrl: "blob:test-campaign",
			resourceUrls: new Map(),
			dispose: vi.fn(),
		} as never);
		vi.spyOn(OpenDesignTouchpointElement.prototype, "mount").mockImplementation(
			async function (this: OpenDesignTouchpointElement) {
				closeControl = document.createElement("button");
				closeControl.dataset.touchpointClose = "true";
				closeControl.disabled = true;
				this.shadowRoot?.replaceChildren(closeControl);
			},
		);
		const onCloseControlChange = vi.fn();
		render(
			<TestTouchpointMount
				decision={runtime() as TestDecision}
				placementKey="opend.home.campaign-modal"
				testId="test-touchpoint-mount"
				onVisible={vi.fn()}
				onCloseControlChange={onCloseControlChange}
			/>,
		);
		await waitFor(() =>
			expect(onCloseControlChange).toHaveBeenCalledWith(false),
		);
		closeControl.disabled = false;
		await waitFor(() =>
			expect(onCloseControlChange).toHaveBeenCalledWith(true),
		);
	});

	it("does not let a rejected stale Test mount overwrite a replacement close control", async () => {
		let rejectOldMount!: (reason?: unknown) => void;
		let mountCount = 0;
		vi.spyOn(touchpointComponent, "verifyWebTouchpoint").mockResolvedValue({
			entryUrl: "blob:test-campaign",
			resourceUrls: new Map(),
			dispose: vi.fn(),
		} as never);
		vi.spyOn(OpenDesignTouchpointElement.prototype, "mount").mockImplementation(
			async function (this: OpenDesignTouchpointElement) {
				mountCount += 1;
				if (mountCount === 1) {
					await new Promise<never>((_, reject) => {
						rejectOldMount = reject;
					});
					return;
				}
				const close = document.createElement("button");
				close.dataset.touchpointClose = "true";
				this.shadowRoot?.replaceChildren(close);
			},
		);
		const onCloseControlChange = vi.fn();
		touchpointComponent.ensureWebTouchpointElement();
		const firstDecision = runtime() as TestDecision;
		const replacementDecision = {
			...firstDecision,
			content: { ...firstDecision.content, id: "replacement-version" },
		} as TestDecision;
		const { rerender } = render(
			<div role="dialog">
				<TestTouchpointMount
					decision={firstDecision}
					placementKey="opend.home.campaign-modal"
					testId="test-touchpoint-mount"
					onVisible={vi.fn()}
					onCloseControlChange={onCloseControlChange}
				/>
			</div>,
		);
		await waitFor(() => expect(mountCount).toBe(1));
		rerender(
			<div role="dialog">
				<TestTouchpointMount
					decision={replacementDecision}
					placementKey="opend.home.campaign-modal"
					testId="test-touchpoint-mount"
					onVisible={vi.fn()}
					onCloseControlChange={onCloseControlChange}
				/>
			</div>,
		);
		await waitFor(() => expect(mountCount).toBe(2));
		await waitFor(() =>
			expect(onCloseControlChange).toHaveBeenLastCalledWith(true),
		);
		rejectOldMount(new Error("stale Test mount failed"));
		await Promise.resolve();
		expect(onCloseControlChange).toHaveBeenLastCalledWith(true);
	});

	it("skips a decision whose required capabilities drift from its immutable manifest and emits a diagnostic", async () => {
		const diagnostics: string[] = [];
		document.addEventListener(
			"touchpointdiagnostic",
			(event) => diagnostics.push((event as CustomEvent).detail.code),
			{ once: true },
		);
		vi.stubGlobal(
			"fetch",
			fetches({ ...runtime(), requiredCapabilities: ["unknown"] }),
		);
		render(<TestCampaignHarness authenticated />);
		await screen.findByTestId("touchpoint-test-selector");
		fireEvent.change(screen.getByLabelText("Test activity"), {
			target: { value: "deployment-1" },
		});
		await waitFor(() =>
			expect(diagnostics).toEqual(["touchpoint_capability_unsupported"]),
		);
		expect(screen.queryByRole("dialog")).toBeNull();
	});
	it("contains Tab focus with the host helper", async () => {
		const { trapWebTouchpointModalFocus } = await import(
			"../../src/components/touchpoint-component"
		);
		const modal = document.createElement("div");
		const first = document.createElement("button");
		const last = document.createElement("button");
		modal.append(first, last);
		document.body.append(modal);
		last.focus();
		const tab = new KeyboardEvent("keydown", {
			key: "Tab",
			bubbles: true,
			cancelable: true,
		});
		trapWebTouchpointModalFocus(tab, modal);
		expect(tab.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(first);
		modal.remove();
	});
});

describe("Test campaign decision and lifecycle guards", () => {
	it("rejects a response from another selected deployment or content placement before mounting", async () => {
		const diagnostics: string[] = [];
		document.addEventListener(
			"touchpointdiagnostic",
			(event) => diagnostics.push((event as CustomEvent).detail.code),
			{ once: true },
		);
		vi.stubGlobal(
			"fetch",
			fetches({ ...runtime(), deploymentId: "deployment-other" }),
		);
		render(<TestCampaignHarness authenticated />);
		await screen.findByTestId("touchpoint-test-selector");
		fireEvent.change(screen.getByLabelText("Test activity"), {
			target: { value: "deployment-1" },
		});
		await waitFor(() =>
			expect(diagnostics).toEqual(["touchpoint_decision_mismatch"]),
		);
		expect(screen.queryByRole("dialog")).toBeNull();
	});
	it("refuses a selected deployment whose immutable snapshot identity is missing", async () => {
		const base = fetches();
		vi.stubGlobal("fetch", async (url: string) => {
			const response = await base(url);
			if (!url.endsWith("/deployments")) return response;
			const body = await response.json();
			delete body.deployments[0].snapshotHash;
			return new Response(JSON.stringify(body));
		});
		const diagnostics: string[] = [];
		document.addEventListener(
			"touchpointdiagnostic",
			(event) => diagnostics.push((event as CustomEvent).detail.code),
			{ once: true },
		);
		render(
			<>
				<TestCampaignHarness authenticated />
				<TestRuntimeProbe />
			</>,
		);
		await screen.findByTestId("touchpoint-test-selector");
		fireEvent.change(screen.getByLabelText("Test activity"), {
			target: { value: "deployment-1" },
		});
		await waitFor(() =>
			expect(diagnostics).toContain("touchpoint_decision_mismatch"),
		);
		expect(screen.queryByRole("dialog")).toBeNull();
		expect(screen.getByTestId("test-runtime-decision-count")).toHaveAttribute(
			"data-selected",
			"deployment-1",
		);
	});
	it.each(["activity", "tester", "actions"])(
		"rejects mismatched %s identity before mounting",
		async (kind) => {
			const value = runtime();
			const response = {
				...value,
				...(kind === "activity" ? { activityId: "other-activity" } : {}),
				...(kind === "tester"
					? {
							testContext: {
								...value.testContext,
								testerMemberId: "other-tester",
							},
						}
					: {}),
				...(kind === "actions"
					? {
							staticActions: [
								{
									id: "forged",
									target: { kind: "https", url: "https://example.com" },
								},
							],
						}
					: {}),
			};
			const diagnostics: string[] = [];
			document.addEventListener(
				"touchpointdiagnostic",
				(event) => diagnostics.push((event as CustomEvent).detail.code),
				{ once: true },
			);
			vi.stubGlobal("fetch", fetches(response));
			render(<TestCampaignHarness authenticated />);
			await screen.findByTestId("touchpoint-test-selector");
			fireEvent.change(screen.getByLabelText("Test activity"), {
				target: { value: "deployment-1" },
			});
			await waitFor(() =>
				expect(diagnostics).toContain("touchpoint_decision_mismatch"),
			);
			expect(screen.queryByRole("dialog")).toBeNull();
		},
	);
	it("clears selected Test content when the authenticated account changes", async () => {
		vi.stubGlobal("fetch", fetches());
		const { rerender } = render(
			<TestCampaignHarness authenticated sessionSubject="account-a" />,
		);
		await screen.findByTestId("touchpoint-test-selector");
		fireEvent.change(screen.getByLabelText("Test activity"), {
			target: { value: "deployment-1" },
		});
		await screen.findByRole("dialog");
		rerender(<TestCampaignHarness authenticated sessionSubject="account-b" />);
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		expect(screen.getByLabelText("Test activity")).toHaveValue("");
	});
	it("does not let a late failed context request clear a newer selection", async () => {
		let failFirst!: (value: Response) => void;
		const firstContext = new Promise<Response>((resolve) => {
			failFirst = resolve;
		});
		const base = fetches();
		vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
			if (url.endsWith("/deployments")) {
				const body = await (await base(url)).json();
				body.deployments.push({
					...body.deployments[0],
					id: "deployment-2",
					activityId: "activity-2",
				});
				return new Response(JSON.stringify(body));
			}
			if (url.endsWith("/context")) {
				const selected = JSON.parse(String(init?.body)).deploymentId;
				if (selected === "deployment-1") return firstContext;
				return new Response(
					JSON.stringify({ ...runtime().context, deploymentId: selected }),
				);
			}
			const value = runtime();
			return new Response(
				JSON.stringify({
					...value,
					activityId: "activity-2",
					deploymentId: "deployment-2",
					testContext: { ...value.testContext, deploymentId: "deployment-2" },
				}),
			);
		});
		render(<TestCampaignHarness authenticated />);
		await screen.findByTestId("touchpoint-test-selector");
		fireEvent.change(screen.getByLabelText("Test activity"), {
			target: { value: "deployment-1" },
		});
		fireEvent.change(screen.getByLabelText("Test activity"), {
			target: { value: "deployment-2" },
		});
		await screen.findByRole("dialog");
		await act(async () => {
			failFirst(
				new Response(JSON.stringify({ error: "failed" }), { status: 500 }),
			);
			await firstContext;
		});
		await waitFor(() =>
			expect(screen.getByLabelText("Test activity")).toHaveValue(
				"deployment-2",
			),
		);
		expect(screen.getByRole("dialog")).toBeInTheDocument();
	});
	it("diagnoses immutable byte integrity failure and revokes every created Blob URL", async () => {
		const { verifyWebTouchpoint } =
			await import("../../src/components/touchpoint-component");
		const revoked: string[] = [];
		const create = vi
			.spyOn(URL, "createObjectURL")
			.mockReturnValue("blob:verified");
		const revoke = vi
			.spyOn(URL, "revokeObjectURL")
			.mockImplementation((url) => {
				revoked.push(url);
			});
		await expect(
			verifyWebTouchpoint({ ...content, entryModule: "tampered" } as any),
		).rejects.toThrow("touchpoint_integrity_failed");
		expect(create).toHaveBeenCalledOnce();
		expect(revoke).toHaveBeenCalledWith("blob:verified");
		create.mockRestore();
		revoke.mockRestore();
	});
	it("traps both directions across the mounted open ShadowRoot boundary", async () => {
		const { trapWebTouchpointModalFocus } =
			await import("../../src/components/touchpoint-component");
		const modal = document.createElement("div");
		const close = document.createElement("button");
		const component = document.createElement("opend-touchpoint");
		const shadow =
			component.shadowRoot ?? component.attachShadow({ mode: "open" });
		const action = document.createElement("button");
		shadow.append(action);
		modal.append(close, component);
		document.body.append(modal);
		close.focus();
		const forward = new KeyboardEvent("keydown", {
			key: "Tab",
			bubbles: true,
			cancelable: true,
		});
		trapWebTouchpointModalFocus(forward, modal);
		expect(forward.defaultPrevented).toBe(false);
		action.focus();
		const wrapForward = new KeyboardEvent("keydown", {
			key: "Tab",
			bubbles: true,
			cancelable: true,
		});
		trapWebTouchpointModalFocus(wrapForward, modal);
		expect(wrapForward.defaultPrevented).toBe(true);
		expect(document.activeElement).toBe(close);
		close.focus();
		const wrapReverse = new KeyboardEvent("keydown", {
			key: "Tab",
			shiftKey: true,
			bubbles: true,
			cancelable: true,
		});
		trapWebTouchpointModalFocus(wrapReverse, modal);
		expect(wrapReverse.defaultPrevented).toBe(true);
		expect(shadow.activeElement).toBe(action);
		modal.remove();
	});
	function activeActionDecision(
		target: unknown,
		scenario: "active" | "wake" = "active",
	) {
		const staticActions = [{ id: "learn", target }] as any;
		const actionManifest = {
			...manifest,
			placements: [
				{
					...manifest.placements[0]!,
					requiredCapabilities: ["close", "static-action"],
					staticActions,
				},
			],
		};
		const actionContent = {
			...content,
			manifest: actionManifest,
			manifestHash: digest(JSON.stringify(actionManifest)),
		};
		const base = runtime(actionContent);
		const value = {
			...base,
			context: { ...base.context, scenario },
			testContext: { ...base.testContext, scenario },
			manifestHash: actionContent.manifestHash,
			requiredCapabilities: ["close", "static-action"],
			staticActions,
		};
		setTestRuntimeSession({
			selectionKey: "active-action",
			deployment: {
				id: value.deploymentId,
				activityId: value.activityId,
				snapshotHash: value.snapshotHash,
				snapshot: {
					contentVersionId: actionContent.id,
					manifestHash: actionContent.manifestHash,
					artifactHash: value.artifactHash,
					placementKeys: [value.placementKey],
				},
			},
			context: value.context,
			decisions: new Map([[value.placementKey, value]]),
		} as any);
		return value;
	}

	it.each(["active", "wake"] as const)(
		"navigates a live selected Test HTTPS action in %s without production telemetry",
		async (scenario) => {
			const { dispatchTestCampaignAction } =
				await import("../../src/components/TestCampaignModal");
			const fetchMock = vi.fn();
			vi.stubGlobal("fetch", fetchMock);
			Object.defineProperty(navigator, "userActivation", {
				configurable: true,
				value: { isActive: true },
			});
			const accepted = await dispatchTestCampaignAction(
				activeActionDecision(
					{
						kind: "https",
						url: "https://open-design.ai/cloud/dashboard?from=test#overview",
					},
					scenario,
				) as any,
				"learn",
			);
		expect(accepted).toBe(true);
		expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it.each([
		[
			"unregistered",
			"other",
			{ kind: "https", url: "https://open-design.ai/cloud/dashboard" },
		],
		[
			"credential-bearing",
			"learn",
			{
				kind: "https",
				url: "https://user:secret@open-design.ai/cloud/dashboard",
			},
		],
		["scripted", "learn", { kind: "https", url: "javascript:alert(1)" }],
	])(
		"rejects %s Test actions with host feedback and no production fetch",
		async (_kind, actionId, target) => {
			const { dispatchTestCampaignAction } =
				await import("../../src/components/TestCampaignModal");
			const diagnostics: string[] = [];
			document.addEventListener(
				"touchpointdiagnostic",
				(event) => diagnostics.push((event as CustomEvent).detail.code),
				{ once: true },
			);
			const fetchMock = vi.fn();
			vi.stubGlobal("fetch", fetchMock);
			Object.defineProperty(navigator, "userActivation", {
				configurable: true,
				value: { isActive: true },
			});
			expect(
				await dispatchTestCampaignAction(
					activeActionDecision(target) as any,
					actionId,
				),
			).toBe(false);
			expect(diagnostics).toEqual(["touchpoint_action_denied"]);
			expect(openExternalUrlMock).not.toHaveBeenCalled();
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it.each(["before", "ended"] as const)(
		"rejects %s Test schedule state",
		async (scheduleState) => {
			const { dispatchTestCampaignAction } =
				await import("../../src/components/TestCampaignModal");
			const value = activeActionDecision({
				kind: "https",
				url: "https://example.com",
			});
			Object.assign(value.testContext, { scheduleState });
			Object.defineProperty(navigator, "userActivation", {
				configurable: true,
				value: { isActive: true },
			});
			expect(await dispatchTestCampaignAction(value as any, "learn")).toBe(
				false,
			);
			expect(openExternalUrlMock).not.toHaveBeenCalled();
		},
	);

	it("reports failed host navigation instead of claiming success", async () => {
		const { dispatchTestCampaignAction } =
			await import("../../src/components/TestCampaignModal");
		const value = activeActionDecision({
			kind: "https",
			url: "https://example.com",
		});
		Object.defineProperty(navigator, "userActivation", {
			configurable: true,
			value: { isActive: true },
		});
		openExternalUrlMock.mockResolvedValueOnce(false);
		expect(await dispatchTestCampaignAction(value as any, "learn")).toBe(false);
	});

	it("requires user activation for a selected Test action", async () => {
		const { dispatchTestCampaignAction } =
			await import("../../src/components/TestCampaignModal");
		const value = activeActionDecision({
			kind: "https",
			url: "https://example.com",
		});
		Object.defineProperty(navigator, "userActivation", {
			configurable: true,
			value: { isActive: false },
		});
		expect(await dispatchTestCampaignAction(value as any, "learn")).toBe(false);
		expect(openExternalUrlMock).not.toHaveBeenCalled();
	});

	it("rejects revoked Test snapshot actions with host feedback", async () => {
		const { dispatchTestCampaignAction } =
			await import("../../src/components/TestCampaignModal");
		const value = activeActionDecision({
			kind: "internal",
			path: "/projects?view=active#recent",
		});
		setTestRuntimeSession(null);
		Object.defineProperty(navigator, "userActivation", {
			configurable: true,
			value: { isActive: true },
		});
		expect(await dispatchTestCampaignAction(value as any, "learn")).toBe(false);
		expect(openExternalUrlMock).not.toHaveBeenCalled();
	});
});

describe("Test campaign four-placement contract", () => {
	it("loads the real context shape, mounts every enabled placement, and records one server acceptance per visible host", async () => {
		const context = {
			deploymentId: "deployment-four",
			testerMemberId: "member-four",
			scenario: "active" as const,
			simulatedAt: "2030-01-01T00:00:00.000Z",
			updatedAt: "2030-01-01T00:00:00.000Z",
		};
		const deployment = {
			id: "deployment-four",
			activityId: "activity-four",
			snapshotHash: "sha256:four-snapshot",
			snapshot: {
				contentVersionId: "version-four-placement",
				manifestHash: digest(JSON.stringify(allTestManifest)),
				artifactHash: "sha256:four-artifact",
				placementKeys: [...allTestPlacements],
			},
		};
		const responses = new Map(
			allTestPlacements.map((placementKey) => [
				placementKey,
				{
					...runtime(fourPlacementContent(placementKey)),
					deploymentId: deployment.id,
					placementKey,
					snapshotHash: deployment.snapshotHash,
					artifactHash: deployment.snapshot.artifactHash,
					manifestHash: deployment.snapshot.manifestHash,
					requiredCapabilities:
						placementKey === "opend.home.campaign-modal"
							? ["close", "static-action"]
							: placementKey === "opend.home.account-badge"
								? ["static-action"]
								: ["hover", "static-action"],
					activityId: deployment.activityId,
					testContext: { ...context, scheduleState: "active" as const },
				},
			]),
		);
		(
			(globalThis as CampaignHostGlobal).__openDesignCampaignTestHost as {
				client: { osLocale: string };
			}
		).client.osLocale = "zh-CN";
		const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			if (init?.method === "POST" && url.includes("acceptances"))
				return new Response(JSON.stringify({ id: "acceptance" }), {
					status: 201,
				});
			if (init?.method === "POST")
				return new Response(JSON.stringify(context), { status: 201 });
			if (url.includes("/deployments"))
				return new Response(JSON.stringify({ deployments: [deployment] }), {
					status: 200,
				});
			const placementKey = new URL(url, "http://127.0.0.1").searchParams.get(
				"placementKey",
			);
			return new Response(
				JSON.stringify(
					responses.get(placementKey as (typeof allTestPlacements)[number]),
				),
				{ status: 200 },
			);
		});
		vi.stubGlobal("fetch", fetchMock);
		const mount = vi
			.spyOn(OpenDesignTouchpointElement.prototype, "mount")
			.mockImplementation(async function (this: OpenDesignTouchpointElement) {
				this.shadowRoot?.replaceChildren(
					document.createTextNode("Verified campaign"),
				);
			});
		vi.spyOn(touchpointComponent, "verifyWebTouchpoint").mockResolvedValue({
			entryUrl: "blob:test-four-placement",
			resourceUrls: new Map(),
			dispose: vi.fn(),
		} as never);
		vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue({
			length: 1,
			item: () => null,
		} as unknown as DOMRectList);
		render(
			<>
				<TestRuntimeProbe />
				<TestCampaignHarness authenticated />
			</>,
		);
		await screen.findByTestId("touchpoint-test-selector");
		fireEvent.change(screen.getByLabelText("Test activity"), {
			target: { value: deployment.id },
		});
		await screen.findByRole("dialog");
		await waitFor(() =>
			expect(
				screen.getByTestId("test-runtime-decision-count"),
			).toHaveTextContent("4"),
		);
		await waitFor(() => expect(mount).toHaveBeenCalledTimes(1));
		const acceptanceCalls = () =>
			fetchMock.mock.calls.filter(
				([url, init]) => init?.method === "POST" && url.includes("acceptances"),
			);
		await waitFor(() => expect(acceptanceCalls()).toHaveLength(1));
		expect(
			acceptanceCalls().map(
				([, init]) => JSON.parse(String(init?.body)).placementKey,
			),
		).toEqual(["opend.home.campaign-modal"]);
		for (const placementKey of allTestPlacements) {
			expect(
				fetchMock.mock.calls.some(
					([url, init]) =>
						init?.method !== "POST" &&
						new URL(url, "http://127.0.0.1").searchParams.get(
							"placementKey",
						) === placementKey,
				),
			).toBe(true);
		}
	});
});
