import { mountTouchpoint, startTouchpointRefresh } from "./touchpoint-lifecycle";
import { readCampaignHostLocale } from "./TestCampaignModal";
import { useCallback, useEffect, useRef, useState } from "react";
import { getOpenDesignHost } from "@open-design/host";
import { navigateCampaignTarget, resolveCampaignTarget, requireCampaignAction } from "./touchpoint-navigation";
import {
	type TouchpointStaticAction,
} from "./touchpoint-static-actions";
import {
	emitWebTouchpointDiagnostic,
	ensureWebTouchpointElement,
	lockWebTouchpointModalScroll,
	supportsWebTouchpointCapabilities,
	trapWebTouchpointModalFocus,
	type WebTouchpointContent,
} from "./touchpoint-component";
import {
	emitProductionTouchpointLoadDiagnostic,
	loadProductionTouchpointDecision,
} from "./production-touchpoint-loader";
import {
	TestTouchpointMount,
	recordVisibleTestTouchpoint,
	useTestRuntime,
} from "./TestCampaignModal";
import type { TestCampaignPlacement, TestDecision } from "./TestCampaignModal";
import styles from "./TestCampaignModal.module.css";
const PLACEMENT = "opend.home.campaign-modal";
const MAX_LEASE_MS = 5 * 60_000;
export const PRODUCTION_ACTION_TELEMETRY_TIMEOUT_MS = 3_000;
const supportedCapabilities = new Set(["close", "static-action"]);

type Decision = {
	activityId: string;
	authorizationExpiresAt: string;
	touchpointDecisionId: string;
	deploymentId: string;
	endsAt: string;
	placementKey: string;
	serverTime: string;
	requiredCapabilities: string[];
	staticActions: TouchpointStaticAction[];
	content: WebTouchpointContent;
};
const displayedKey = (subject: string, activity: string) =>
	`touchpoint-displayed:v1:${encodeURIComponent(subject)}:${encodeURIComponent(activity)}`;

/** Local impressions gate automatic presentation only, independently of publication. */
function wasDisplayed(subject: string, activity: string): boolean {
	try {
		return localStorage.getItem(displayedKey(subject, activity)) === "1";
	} catch {
		return false;
	}
}

function recordDisplayed(subject: string, activity: string): void {
	try {
		localStorage.setItem(displayedKey(subject, activity), "1");
	} catch {
		// Storage may be unavailable or full; presentation and dismissal still work.
	}
}

/** Performs a server-validated click before the host consumes a static target. */
export async function dispatchProductionCampaignAction(
	decision: Decision,
	actionId: string,
	generation: number,
	currentGeneration: () => number,
	expiresAt: number,
): Promise<boolean> {
	const action = resolveCampaignTarget(decision.staticActions, actionId);
	if (
		!action ||
		generation !== currentGeneration() ||
		expiresAt <= Date.now() ||
		!navigator.userActivation?.isActive
	) {
		emitWebTouchpointDiagnostic({
			code: "touchpoint_action_denied",
			detail: actionId,
		});
		return false;
	}
	let response: Response | undefined;
	const telemetryController = new AbortController();
	const telemetryTimeout = setTimeout(
		() => telemetryController.abort(),
		PRODUCTION_ACTION_TELEMETRY_TIMEOUT_MS,
	);
	try {
		response = await fetch("/api/touchpoints/production-runtime/events", {
			method: "POST",
			headers: { "content-type": "application/json" },
			signal: telemetryController.signal,
			body: JSON.stringify({
				touchpointDecisionId: decision.touchpointDecisionId,
				activityId: decision.activityId,
				placementKey: decision.placementKey,
				eventId: crypto.randomUUID(),
				kind: "click",
			}),
		});
	} catch {
		emitWebTouchpointDiagnostic({
			code: "touchpoint_action_telemetry_failed",
			detail: "network",
		});
	} finally {
		clearTimeout(telemetryTimeout);
	}
	if (response && !response.ok && response.status < 500) {
		emitWebTouchpointDiagnostic({
			code: "touchpoint_action_denied",
			detail: actionId,
		});
		return false;
	}
	if (response && !response.ok && response.status >= 500) {
		emitWebTouchpointDiagnostic({
			code: "touchpoint_action_telemetry_failed",
			detail: `http_${response.status}`,
		});
	}
	if (generation !== currentGeneration() || expiresAt <= Date.now()) {
		emitWebTouchpointDiagnostic({
			code: "touchpoint_action_denied",
			detail: actionId,
		});
		return false;
	}
	try {
		return await navigateCampaignTarget(action);
	} catch {
		emitWebTouchpointDiagnostic({
			code: "touchpoint_action_denied",
			detail: actionId,
		});
		return false;
	}
}
/** Production v2 modal shares the Test adapter; it does not fall back to a frame when bytes or runtime identity fail. */
type AuthorizedDecision = Decision & {
	authorizationDeadline: number;
	sessionSubject: string;
};
export function ProductionCampaignModal({
	authenticated,
	sessionSubject,
}: {
	authenticated: boolean;
	sessionSubject: string | null;
}) {
	const [decision, setDecision] = useState<AuthorizedDecision | null>(null);
	const testRuntime = useTestRuntime();
	const testDecision = testRuntime?.decisions.get(PLACEMENT);
	const [testClosed, setTestClosed] = useState(false);
	const decisionRef = useRef<AuthorizedDecision | null>(null);
	const [closed, setClosed] = useState(false);
	const elementRef = useRef<HTMLDivElement | null>(null);
	const modalRef = useRef<HTMLDivElement | null>(null);
	const expiry = useRef(0);
	const requestGeneration = useRef(0);
	const authorizationGeneration = useRef(0);
	const leaseGeneration = useRef(0);
	const restoreFocus = useRef<HTMLElement | null>(null);
	const clear = useCallback(() => {
		expiry.current = 0;
		++requestGeneration.current;
		++authorizationGeneration.current;
		++leaseGeneration.current;
		decisionRef.current = null;
		setDecision(null);
	}, []);
	useEffect(() => {
		ensureWebTouchpointElement();
	}, []);
	useEffect(() => {
		const locale = readCampaignHostLocale();
		if (testRuntime) {
			clear();
			return;
		}
		if (
			!authenticated ||
			!sessionSubject ||
			getOpenDesignHost()?.client.type !== "desktop" ||
			!locale
		) {
			clear();
			return;
		}
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const controller = new AbortController();
		const subject = sessionSubject;
		const requestGenerationRef = requestGeneration;
		const current = (requestGeneration: number) =>
			!cancelled &&
			requestGeneration === requestGenerationRef.current &&
			authenticated &&
			sessionSubject === subject;
		const decide = async () => {
			const nextRequestGeneration = ++requestGeneration.current;
			try {
				const loaded = await loadProductionTouchpointDecision(
					PLACEMENT,
					locale,
					controller.signal,
					decisionRef.current?.touchpointDecisionId,
				);
				if (!current(nextRequestGeneration)) return;
				if (loaded.kind === "revoked") {
					const active = decisionRef.current;
					if (
						active &&
						loaded.receipt.touchpointDecisionId ===
							active.touchpointDecisionId &&
						loaded.receipt.deploymentId === active.deploymentId &&
						loaded.receipt.activityId === active.activityId &&
						loaded.receipt.contentVersionId === active.content.id
					)
						clear();
					return;
				}
				if (loaded.kind === "no-decision") {
					if (!decisionRef.current) clear();
					return;
				}
				const next = loaded.value as Decision;
				if (!current(nextRequestGeneration)) return;
				const deadline = Math.min(
					Date.parse(next.authorizationExpiresAt),
					Date.parse(next.endsAt),
					Date.parse(next.serverTime) + MAX_LEASE_MS,
				);
				if (
					!next.activityId ||
					next.placementKey !== PLACEMENT ||
					next.content?.placementKey !== PLACEMENT ||
					!Number.isFinite(deadline) ||
					deadline <= Date.now()
				) {
					if (
						next.placementKey !== PLACEMENT ||
						next.content?.placementKey !== PLACEMENT
					)
						emitWebTouchpointDiagnostic({
							code: "touchpoint_decision_mismatch",
						});
					clear();
					return;
				}
				if (
					!supportsWebTouchpointCapabilities(
						next.content,
						next.requiredCapabilities,
						supportedCapabilities,
					)
				) {
					emitWebTouchpointDiagnostic({
						code: "touchpoint_capability_unsupported",
						detail: next.requiredCapabilities?.join(","),
					});
					clear();
					return;
				}
				if (expiry.current > Date.now()) return;
				// Keep an already-open activity authorized; the marker only prevents a new automatic opening.
				if (
					decisionRef.current?.activityId !== next.activityId &&
					wasDisplayed(subject, next.activityId)
				)
					return;
				// Revoke the old mount and cancel its lease timer before scheduling React's replacement cleanup.
				++authorizationGeneration.current;
				const nextLeaseGeneration = ++leaseGeneration.current;
				if (timer) clearTimeout(timer);
				expiry.current = deadline;
				const authorized = {
					...next,
					authorizationDeadline: deadline,
					sessionSubject: subject,
				} as AuthorizedDecision;
				decisionRef.current = authorized;
				setDecision(authorized);
				timer = setTimeout(
					() => {
						if (leaseGeneration.current === nextLeaseGeneration) clear();
					},
					Math.max(0, deadline - Date.now()),
				);
			} catch (error) {
				if (
					!current(nextRequestGeneration) ||
					(error instanceof DOMException && error.name === "AbortError")
				)
					return;
				const diagnostic = emitProductionTouchpointLoadDiagnostic(error);
				if (diagnostic) emitWebTouchpointDiagnostic(diagnostic);
				clear();
			}
		};
		const stopRefresh = startTouchpointRefresh(decide);
		return () => {
			cancelled = true;
			controller.abort();
			if (timer) clearTimeout(timer);
			stopRefresh();
			clear();
		};
	}, [authenticated, sessionSubject, testRuntime]);
	useEffect(() => {
		const container = elementRef.current;
		if (
			!container ||
			!decision ||
			!authenticated ||
			decision.sessionSubject !== sessionSubject
		)
			return;
		const generation = ++authorizationGeneration.current;
		const dispose = mountTouchpoint(container, {
			content: decision.content,
			placementKey: PLACEMENT,
			staticActions: decision.staticActions,
			mode: "production",
			locale: decision.content.locale,
			isCurrent: () =>
				generation === authorizationGeneration.current &&
				decision.authorizationDeadline > Date.now(),
			requestClose: () => setClosed(true),
			dispatchAction: async (id) => {
				requireCampaignAction(
					await dispatchProductionCampaignAction(
						decision,
						id,
						generation,
						() => authorizationGeneration.current,
						decision.authorizationDeadline,
					),
				);
			},
			onVisible: () =>
				recordDisplayed(decision.sessionSubject, decision.activityId),
			onError: (code) => {
				if (code === "touchpoint_decision_mismatch") clear();
			},
		});
		return () => {
			++authorizationGeneration.current;
			dispose();
		};
	}, [authenticated, decision, sessionSubject, clear]);
	useEffect(() => {
		if (!decision) return;
		restoreFocus.current =
			document.activeElement instanceof HTMLElement
				? document.activeElement
				: null;
		const releaseScrollLock = lockWebTouchpointModalScroll();
		const key = (event: KeyboardEvent) => {
			if (event.key === "Escape") setClosed(true);
			else trapWebTouchpointModalFocus(event, modalRef.current);
		};
		document.addEventListener("keydown", key);
		queueMicrotask(() =>
			(
				modalRef.current?.querySelector<HTMLElement>("button") ??
				modalRef.current
			)?.focus(),
		);
		return () => {
			document.removeEventListener("keydown", key);
			releaseScrollLock();
			restoreFocus.current?.focus();
		};
	}, [decision]);
	useEffect(() => {
		if (!closed || !decision || !sessionSubject) return;
		clear();
		setClosed(false);
	}, [closed, decision, sessionSubject]);
	useEffect(() => {
		if (!testDecision || testClosed || !authenticated) return;
		const previous =
			document.activeElement instanceof HTMLElement
				? document.activeElement
				: null;
		const releaseScrollLock = lockWebTouchpointModalScroll();
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setTestClosed(true);
			else trapWebTouchpointModalFocus(event, modalRef.current);
		};
		document.addEventListener("keydown", onKeyDown);
		queueMicrotask(() =>
			(
				modalRef.current?.querySelector<HTMLElement>("button") ??
				modalRef.current
			)?.focus(),
		);
		return () => {
			document.removeEventListener("keydown", onKeyDown);
			releaseScrollLock();
			previous?.focus();
		};
	}, [authenticated, testClosed, testDecision]);
	useEffect(() => {
		if (!testDecision) setTestClosed(false);
	}, [testDecision]);
	const closeTestModal = useCallback(() => setTestClosed(true), []);
	const onTestVisible = useCallback(
		(next: TestDecision, placementKey: TestCampaignPlacement) => {
			if (testRuntime)
				recordVisibleTestTouchpoint(testRuntime, next, placementKey);
		},
		[testRuntime],
	);
	if (authenticated && testRuntime && testDecision && !testClosed) {
		return (
			<div
				className={styles.backdrop}
				role="dialog"
				aria-label="Test campaign"
				aria-modal="true"
			>
				<div className={styles.modal} ref={modalRef} tabIndex={-1}>
					<TestTouchpointMount
						decision={testDecision}
						placementKey={PLACEMENT}
						testId="campaign-custom-element"
						onVisible={onTestVisible}
						requestClose={closeTestModal}
					/>
				</div>
			</div>
		);
	}
	return authenticated && decision?.sessionSubject === sessionSubject ? (
		<div
			className={styles.backdrop}
			role="dialog"
			aria-label="Campaign"
			aria-modal="true"
		>
			<div className={styles.modal} ref={modalRef} tabIndex={-1}>
				<div ref={elementRef} data-testid="campaign-custom-element" />
			</div>
		</div>
	) : null;
}
