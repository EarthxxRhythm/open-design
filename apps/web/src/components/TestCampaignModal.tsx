import { mountTouchpoint, startTouchpointRefresh } from "./touchpoint-lifecycle";
import { navigateCampaignTarget, resolveCampaignTarget, requireCampaignAction } from "./touchpoint-navigation";
import {
	TOUCHPOINT_COMPONENT_V2_RUNTIME_API_VERSION,
	TOUCHPOINT_COMPONENT_V2_SDK_VERSION,
	TOUCHPOINT_COMPONENT_V2_WRAPPER_VERSION,
} from "@open-design/contracts";
import { getOpenDesignHost, OPEN_DESIGN_HOST_VERSION } from "@open-design/host";
import {
	useCallback,
	useEffect,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import styles from "./TestCampaignModal.module.css";
import {
	emitWebTouchpointDiagnostic,
	ensureWebTouchpointElement,
	supportsWebTouchpointCapabilities,
	type WebTouchpointContent,
} from "./touchpoint-component";
import {
	type TouchpointStaticAction,
	touchpointStaticActionsMatch,
} from "./touchpoint-static-actions";

export const TEST_CAMPAIGN_MODAL_PLACEMENT =
	"opend.home.campaign-modal" as const;
export const TEST_CAMPAIGN_MODAL_CAPABILITIES = [
	"close",
	"static-action",
] as const;
export const TEST_CAMPAIGN_PLACEMENTS = [
	"opend.home.account-badge",
	"opend.home.campaign-modal",
	"opend.home.hover-entry",
	"opend.home.hover-layer",
] as const;
export type TestCampaignPlacement = (typeof TEST_CAMPAIGN_PLACEMENTS)[number];
const supportedCapabilities = new Set<string>(TEST_CAMPAIGN_MODAL_CAPABILITIES);
const placementCapabilities = new Set(["hover", "static-action"]);
type Scenario = "before" | "active" | "after" | "wake";

/** The list response is the selected deployment snapshot, not a presentation fixture. */
export type TestDeployment = {
	id: string;
	activityId: string;
	snapshot: {
		contentVersionId?: string;
		manifestHash?: string;
		artifactHash?: string;
		placementKeys: string[];
		placements?: Array<{
			key: string;
			requiredCapabilities: string[];
			staticActions: TouchpointStaticAction[];
		}>;
	};
	snapshotHash?: string;
};
export type TestContext = {
	deploymentId: string;
	testerMemberId?: string;
	scenario: Scenario;
	simulatedAt: string;
	updatedAt: string;
};
export type TestDecision = {
	deploymentId: string;
	activityId?: string;
	snapshotHash?: string;
	artifactHash?: string;
	manifestHash?: string;
	placementKey: string;
	requiredCapabilities: string[];
	staticActions: TouchpointStaticAction[];
	testContext: TestContext & {
		scheduleState: "before" | "active" | "ended";
	};
	content: WebTouchpointContent;
};
export type TestRuntimeSession = Readonly<{
	selectionKey: string;
	deployment: TestDeployment;
	context: TestContext;
	decisions: ReadonlyMap<TestCampaignPlacement, TestDecision>;
}>;

let currentTestSession: TestRuntimeSession | null = null;
const testRuntimeListeners = new Set<() => void>();
const acceptanceState = new Map<string, "in-flight" | "accepted">();
function subscribeTestRuntime(listener: () => void): () => void {
	testRuntimeListeners.add(listener);
	return () => testRuntimeListeners.delete(listener);
}
function getTestRuntimeSnapshot(): TestRuntimeSession | null {
	return currentTestSession;
}
export function useTestRuntime(): TestRuntimeSession | null {
	return useSyncExternalStore(
		subscribeTestRuntime,
		getTestRuntimeSnapshot,
		getTestRuntimeSnapshot,
	);
}
export function setTestRuntimeSession(
	session: TestRuntimeSession | null,
): void {
	currentTestSession = session;
	acceptanceState.clear();
	for (const listener of testRuntimeListeners) listener();
}
export function clearTestRuntimeSession(): void {
	if (!currentTestSession) return;
	currentTestSession = null;
	acceptanceState.clear();
	for (const listener of testRuntimeListeners) listener();
}

/** Test decisions are valid only for the exact selected deployment and clock snapshot. */
export function isSelectedTestCampaignDecision(
	next: TestDecision,
	context: TestContext,
	placementKey: string = TEST_CAMPAIGN_MODAL_PLACEMENT,
): boolean {
	return (
		next.deploymentId === context.deploymentId &&
		next.placementKey === placementKey &&
		next.content?.placementKey === placementKey &&
		next.testContext?.deploymentId === context.deploymentId &&
		next.testContext?.scenario === context.scenario &&
		next.testContext?.simulatedAt === context.simulatedAt &&
		next.testContext?.updatedAt === context.updatedAt
	);
}

/** Only the current verified Test snapshot can authorize a real user's registered action. */
export async function dispatchTestCampaignAction(decision: TestDecision, actionId: string): Promise<boolean> {
  const session = currentTestSession;
  const placement = TEST_CAMPAIGN_PLACEMENTS.find(key => key === decision.placementKey);
  const target = resolveCampaignTarget(decision.staticActions, actionId);
  if (session && placement && session.decisions.get(placement) === decision &&
      decision.testContext.scheduleState === "active" &&
      decisionMatchesSelection(decision, session.context, session.deployment, placement) &&
      navigator.userActivation?.isActive && target) {
    try {
      if (await navigateCampaignTarget(target)) return true;
    } catch { /* Report host navigation failure through the same action contract. */ }
  }
  emitWebTouchpointDiagnostic({ code: "touchpoint_action_denied", detail: actionId });
  return false;
}

function supportsHost(authenticated: boolean): boolean {
	const host = getOpenDesignHost();
	return (
		authenticated &&
		host?.version === OPEN_DESIGN_HOST_VERSION &&
		host.client.type === "desktop"
	);
}

export function readCampaignHostLocale(): string {
	return (
		document.documentElement.lang.trim() ||
		getOpenDesignHost()?.client.osLocale?.trim() ||
		"en-US"
	);
}

function testPlacementIds(deployment: TestDeployment): TestCampaignPlacement[] {
	return TEST_CAMPAIGN_PLACEMENTS.filter((key) =>
		deployment.snapshot.placementKeys.includes(key),
	);
}

function expectedSnapshotMatches(
	decision: TestDecision,
	deployment: TestDeployment,
): boolean {
	const snapshot = deployment.snapshot;
	// Missing identities are not a compatible snapshot and must never authorize
	// a mount. Fixtures follow the same complete payload as the real API.
	return (
		Boolean(deployment.snapshotHash) &&
		decision.snapshotHash === deployment.snapshotHash &&
		Boolean(snapshot.contentVersionId) &&
		decision.content?.id === snapshot.contentVersionId &&
		Boolean(snapshot.manifestHash) &&
		decision.manifestHash === snapshot.manifestHash &&
		Boolean(snapshot.artifactHash) &&
		decision.artifactHash === snapshot.artifactHash
	);
}

function decisionMatchesSelection(
	decision: TestDecision,
	context: TestContext,
	deployment: TestDeployment,
	placementKey: TestCampaignPlacement,
): boolean {
	return (
		isSelectedTestCampaignDecision(decision, context, placementKey) &&
		decision.activityId === deployment.activityId &&
		decision.testContext.testerMemberId === context.testerMemberId &&
		["before", "active", "ended"].includes(
			decision.testContext.scheduleState,
		) &&
		expectedSnapshotMatches(decision, deployment) &&
		touchpointStaticActionsMatch(
			decision.staticActions,
			decision.content.manifest.placements.find(
				(placement) => placement.key === placementKey,
			)?.staticActions ?? [],
		) &&
		decision.content.id.length > 0
	);
}

function acceptanceEvidence(
	input: Readonly<{
		deploymentId: string;
		snapshotHash: string;
		placementKey: string;
		locale: string;
		scenario: string;
	}>,
	href = typeof window === "undefined"
		? "http://127.0.0.1/"
		: window.location.href,
): string {
	let url: URL;
	try {
		url = new URL(href);
		url.username = "";
		url.password = "";
		url.search = "";
		url.hash = "";
	} catch {
		url = new URL("http://127.0.0.1/");
	}
	url.searchParams.set("cmsTestDeployment", input.deploymentId);
	url.searchParams.set("cmsTestSnapshot", input.snapshotHash);
	url.searchParams.set("cmsTestPlacement", input.placementKey);
	url.searchParams.set("cmsTestLocale", input.locale);
	url.searchParams.set("cmsTestScenario", input.scenario);
	return url.toString();
}

/**
 * Records the server-side Test acceptance produced by a real mounted host.
 * The URL is an evidence pointer to the current local host and identity; it is
 * never presented as a screenshot or written as a success receipt by the client.
 */
export async function recordTestAcceptance(
	input: Readonly<{
		deploymentId: string;
		snapshotHash: string;
		placementKey: TestCampaignPlacement;
		locale: string;
		scenario: Scenario;
		hostVersion?: string;
	}>,
): Promise<unknown> {
	const response = await fetch(
		`/api/touchpoints/test-runtime/test-deployments/${encodeURIComponent(input.deploymentId)}/acceptances`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				placementKey: input.placementKey,
				hostVersion: input.hostVersion ?? String(OPEN_DESIGN_HOST_VERSION),
				locale: input.locale,
				scenario: input.scenario,
				evidence: acceptanceEvidence(input),
				hostCompatibility: process.env.NEXT_PUBLIC_CMS_HOST_RELEASE
					? {
							version: 1,
							snapshotHash: input.snapshotHash,
							hostFamily: "open-design-desktop",
							platform: "desktop",
							hostRelease: process.env.NEXT_PUBLIC_CMS_HOST_RELEASE,
							runtime: {
								kind: "web-component",
								apiVersion: TOUCHPOINT_COMPONENT_V2_RUNTIME_API_VERSION,
								wrapperVersion: TOUCHPOINT_COMPONENT_V2_WRAPPER_VERSION,
								sdkVersion: TOUCHPOINT_COMPONENT_V2_SDK_VERSION,
							},
							capabilities:
								input.placementKey === TEST_CAMPAIGN_MODAL_PLACEMENT
									? [...TEST_CAMPAIGN_MODAL_CAPABILITIES]
									: input.placementKey === "opend.home.account-badge"
										? ["static-action"]
										: [...placementCapabilities],
						}
					: undefined,
			}),
		},
	);
	if (!response.ok)
		throw new Error(`touchpoint_test_acceptance_http_${response.status}`);
	return response.json().catch(() => undefined);
}

/** Called only after a current Test placement has mounted and become visible. */
export function recordVisibleTestTouchpoint(
	session: TestRuntimeSession,
	decision: TestDecision,
	placementKey: TestCampaignPlacement,
): void {
	if (currentTestSession !== session || session.context.scenario !== "active")
		return;
	const key = `${session.selectionKey}:${placementKey}`;
	if (acceptanceState.has(key)) return;
	acceptanceState.set(key, "in-flight");
	void recordTestAcceptance({
		deploymentId: session.deployment.id,
		snapshotHash:
			session.deployment.snapshotHash ?? decision.snapshotHash ?? "",
		placementKey,
		locale: decision.content.locale,
		scenario: session.context.scenario,
	})
		.then(() => acceptanceState.set(key, "accepted"))
		.catch((error) => {
			acceptanceState.delete(key);
			emitWebTouchpointDiagnostic({
				code:
					error instanceof Error
						? error.message
						: "touchpoint_test_acceptance_failed",
			});
		});
}

export type TestTouchpointMountProps = Readonly<{
	decision: TestDecision;
	placementKey: TestCampaignPlacement;
	testId: string;
	className?: string;
	onVisible: (
		decision: TestDecision,
		placementKey: TestCampaignPlacement,
	) => void;
	requestClose?: () => void;
	onCloseControlChange?: (available: boolean | null) => void;
}>;

/** Mounts one immutable v2 placement in the real OpenDesign Shadow DOM host. */
export function TestTouchpointMount({
	decision,
	placementKey,
	testId,
	className,
	onVisible,
	requestClose,
	onCloseControlChange,
}: TestTouchpointMountProps) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const [ready, setReady] = useState(false);
	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;
		setReady(false);
		return mountTouchpoint(container, {
			content: decision.content,
			placementKey,
			staticActions: decision.staticActions,
			mode: "test",
			locale: readCampaignHostLocale(),
			isCurrent: () => true,
			dispatchAction: async (id) => {
				requireCampaignAction(await dispatchTestCampaignAction(decision, id));
			},
			requestClose,
			onCloseControlChange,
			onReady: () => setReady(true),
			onVisible: () => onVisible(decision, placementKey),
		});
	}, [decision, onCloseControlChange, onVisible, placementKey, requestClose]);
	return (
		<div
			ref={containerRef}
			className={className}
			data-testid={testId}
			hidden={!ready}
		/>
	);
}

/** Real Electron Test harness for all enabled OpenDesign placements. */
export function TestCampaignModal({
	authenticated,
	sessionSubject,
}: {
	authenticated: boolean;
	sessionSubject?: string | null;
}) {
	const compatible = supportsHost(authenticated);
	const [showControls] = useState(
		() =>
			typeof window !== "undefined" &&
			new URLSearchParams(window.location.search).get("cmsTestControls") ===
				"1",
	);
	const deploymentsRef = useRef<TestDeployment[]>([]);
	const selectionController = useRef<AbortController | null>(null);
	const [deployments, setDeployments] = useState<TestDeployment[]>([]);
	const [deployment, setDeployment] = useState<TestDeployment | null>(null);
	const [context, setContext] = useState<TestContext | null>(null);
	const [decisions, setDecisions] = useState<
		Map<TestCampaignPlacement, TestDecision>
	>(new Map());
	const testSessionRef = useRef<TestRuntimeSession | null>(null);
	const selectionGeneration = useRef(0);
	const selectionKeyRef = useRef("");

	const clear = useCallback(() => {
		selectionController.current?.abort();
		++selectionGeneration.current;
		selectionKeyRef.current = "";
		testSessionRef.current = null;
		clearTestRuntimeSession();
		setDecisions(new Map());
		setDeployment(null);
		setContext(null);
	}, []);

	useEffect(() => {
		ensureWebTouchpointElement();
	}, []);

	const select = useCallback(
		async (deploymentId: string, scenario: Scenario) => {
			const selected = deploymentsRef.current.find(
				(candidate) => candidate.id === deploymentId,
			);
			const generation = ++selectionGeneration.current;
			selectionController.current?.abort();
			const controller = new AbortController();
			selectionController.current = controller;
			selectionKeyRef.current = "";
			setDeployment(null);
			setDecisions(new Map());
			setContext(null);
			if (!selected) {
				clear();
				return;
			}
			setDeployment(selected);
			const previousContext = testSessionRef.current?.context;
			const pendingSession: TestRuntimeSession = Object.freeze({
				selectionKey: [
					selected.id,
					selected.snapshotHash ?? "",
					"pending",
					String(generation),
				].join(":"),
				deployment: selected,
				context: previousContext ?? {
					deploymentId,
					scenario,
					simulatedAt: "",
					updatedAt: "",
				},
				decisions: new Map(),
			});
			testSessionRef.current = pendingSession;
			setTestRuntimeSession(pendingSession);
			try {
				const response = await fetch("/api/touchpoints/test-runtime/context", {
					method: "POST",
					signal: controller.signal,
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ deploymentId, scenario }),
				});
				if (generation !== selectionGeneration.current) return;
				if (!response.ok) {
					emitWebTouchpointDiagnostic({
						code: `touchpoint_test_context_http_${response.status}`,
					});
					return;
				}
				const nextContext = (await response.json()) as TestContext;
				if (generation !== selectionGeneration.current) return;
				if (
					nextContext.deploymentId !== deploymentId ||
					nextContext.scenario !== scenario
				) {
					emitWebTouchpointDiagnostic({ code: "touchpoint_decision_mismatch" });
					return;
				}
				setDeployment(selected);
				setContext(nextContext);
				const available = testPlacementIds(selected);
				const pendingSession: TestRuntimeSession = Object.freeze({
					selectionKey: `${selected.id}:${selected.snapshotHash ?? ""}:${nextContext.scenario}:${nextContext.simulatedAt}:${nextContext.updatedAt}`,
					deployment: selected,
					context: nextContext,
					decisions: new Map(),
				});
				testSessionRef.current = pendingSession;
				setTestRuntimeSession(pendingSession);
				const loaded = await Promise.all(
					available.map(async (placementKey) => {
						const query = new URLSearchParams({
							deploymentId,
							placementKey,
							locale: readCampaignHostLocale(),
						});
						const runtimeResponse = await fetch(
							`/api/touchpoints/test-runtime?${query.toString()}`,
							{ cache: "no-store", signal: controller.signal },
						);
						if (!runtimeResponse.ok) return null;
						return {
							placementKey,
							decision: (await runtimeResponse.json()) as TestDecision,
						};
					}),
				);
				if (generation !== selectionGeneration.current) return;
				const nextDecisions = new Map<TestCampaignPlacement, TestDecision>();
				let inactiveDecisions = 0;
				for (const item of loaded) {
					if (!item) continue;
					const identityMatches = decisionMatchesSelection(
						item.decision,
						nextContext,
						selected,
						item.placementKey,
					);
					if (
						identityMatches &&
						item.decision.testContext.scheduleState !== "active"
					) {
						inactiveDecisions += 1;
						continue;
					}
					const capabilitiesMatch = supportsWebTouchpointCapabilities(
						item.decision.content,
						item.decision.requiredCapabilities,
						item.placementKey === TEST_CAMPAIGN_MODAL_PLACEMENT
							? supportedCapabilities
							: placementCapabilities,
					);
					if (identityMatches && capabilitiesMatch) {
						nextDecisions.set(item.placementKey, item.decision);
					} else if (identityMatches && !capabilitiesMatch) {
						emitWebTouchpointDiagnostic({
							code: "touchpoint_capability_unsupported",
							detail: Array.isArray(item.decision.requiredCapabilities)
								? item.decision.requiredCapabilities.join(",")
								: undefined,
						});
					} else {
						emitWebTouchpointDiagnostic({
							code: "touchpoint_decision_mismatch",
						});
					}
				}
				if (nextDecisions.size + inactiveDecisions !== available.length) {
					selectionKeyRef.current = "";
					// Keep the empty Test session as a fence: failed Test content must
					// never fall back to production while the selector stays selected.
					setDecisions(new Map());
					return;
				}
				selectionKeyRef.current = `${selected.id}:${selected.snapshotHash ?? ""}:${nextContext.scenario}:${nextContext.simulatedAt}:${nextContext.updatedAt}`;
				const session: TestRuntimeSession = Object.freeze({
					selectionKey: selectionKeyRef.current,
					deployment: selected,
					context: nextContext,
					decisions: nextDecisions,
				});
				testSessionRef.current = session;
				setTestRuntimeSession(session);
				setDecisions(nextDecisions);
			} catch (error) {
				if (generation !== selectionGeneration.current) return;
				emitWebTouchpointDiagnostic({
					code:
						error instanceof Error
							? error.message
							: "touchpoint_test_load_failed",
				});
			}
		},
		[clear],
	);

	useEffect(() => {
		clear();
		deploymentsRef.current = [];
		setDeployments([]);
		if (!compatible) return;
		let disposed = false;
		let requestGeneration = 0;
		let controller: AbortController | undefined;

		// One refresh owner for every Test placement. Successful, unchanged
		// snapshots retain their session, simulated clock, mounts and receipts.
		const refresh = async () => {
			const generation = ++requestGeneration;
			controller?.abort();
			controller = new AbortController();
			const current = () => !disposed && generation === requestGeneration;
			try {
				const response = await fetch(
					"/api/touchpoints/test-runtime/deployments",
					{
						cache: "no-store",
						signal: controller.signal,
					},
				);
				if (!current()) return;
				if (!response.ok)
					throw new Error(
						`touchpoint_test_deployments_http_${response.status}`,
					);
				const value = (await response.json()) as {
					deployments?: TestDeployment[];
				};
				if (!current()) return;
				if (!Array.isArray(value.deployments))
					throw new Error("touchpoint_test_deployments_invalid");
				const next = value.deployments.filter(
					(candidate) =>
						candidate &&
						typeof candidate.id === "string" &&
						testPlacementIds(candidate).length > 0,
				);
				deploymentsRef.current = next;
				setDeployments(next);
				const previous = testSessionRef.current;
				// Debug selection stays manual; normal clients follow the newest Test.
				const selected = showControls
					? next.find((candidate) => candidate.id === previous?.deployment.id)
					: next[0];
				if (!selected) {
					if (previous) clear();
					return;
				}
				if (
					selectionKeyRef.current &&
					previous &&
					selected.id === previous.deployment.id &&
					selected.snapshotHash === previous.deployment.snapshotHash &&
					JSON.stringify(selected.snapshot) ===
						JSON.stringify(previous.deployment.snapshot)
				)
					return;
				await select(
					selected.id,
					showControls ? (previous?.context.scenario ?? "active") : "active",
				);
			} catch (error) {
				if (
					!current() ||
					(error instanceof DOMException && error.name === "AbortError")
				)
					return;
				// A failed fetch is not evidence of withdrawal. Keep Test isolation
				// until a successful list response confirms removal; retry on the next tick.
				emitWebTouchpointDiagnostic({
					code:
						error instanceof Error
							? error.message
							: "touchpoint_test_deployments_failed",
				});
			}
		};
		const stopRefresh = startTouchpointRefresh(refresh);
		return () => {
			disposed = true;
			controller?.abort();
			stopRefresh();
			clear();
		};
	}, [clear, compatible, select, sessionSubject, showControls]);

	if (!showControls || !compatible || deployments.length === 0) return null;
	const active = decisions.size > 0;
	return (
		<div className={styles.control} data-testid="touchpoint-test-selector">
			<label>
				Test activity
				<select
					aria-label="Test activity"
					value={deployment?.id ?? ""}
					onChange={(event) => {
						if (event.target.value)
							void select(event.target.value, context?.scenario ?? "active");
						else clear();
					}}
				>
					<option value="">Select a Test activity</option>
					{deployments.map((candidate) => (
						<option key={candidate.id} value={candidate.id}>
							{candidate.activityId}
						</option>
					))}
				</select>
			</label>
			<label>
				Test time
				<select
					aria-label="Test time"
					disabled={!deployment}
					value={context?.scenario ?? "active"}
					onChange={(event) => {
						if (deployment)
							void select(deployment.id, event.target.value as Scenario);
					}}
				>
					<option value="before">Before start</option>
					<option value="active">During schedule</option>
					<option value="after">After end</option>
					<option value="wake">Wake check</option>
				</select>
			</label>
			{context ? (
				<output data-testid="touchpoint-test-clock">
					Test clock: {context.scenario} / {active ? "active" : ""} /{" "}
					{context.simulatedAt}
				</output>
			) : null}
		</div>
	);
}
