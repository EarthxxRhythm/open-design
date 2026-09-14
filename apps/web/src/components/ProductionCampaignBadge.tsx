import { mountTouchpoint, startTouchpointRefresh } from "./touchpoint-lifecycle";
import { requireCampaignAction } from "./touchpoint-navigation";
import { readCampaignHostLocale } from "./TestCampaignModal";
import { useCallback, useEffect, useRef, useState } from "react";
import { getOpenDesignHost } from "@open-design/host";
import {
	emitWebTouchpointDiagnostic,
	ensureWebTouchpointElement,
	supportsWebTouchpointCapabilities,
	type WebTouchpointContent,
} from "./touchpoint-component";
import {
	type TouchpointStaticAction,
} from "./touchpoint-static-actions";
import { dispatchProductionCampaignAction } from "./ProductionCampaignModal";
import { emitProductionTouchpointLoadDiagnostic, loadProductionTouchpointDecision } from "./production-touchpoint-loader";
import {
	TestTouchpointMount,
	recordVisibleTestTouchpoint,
	useTestRuntime,
} from "./TestCampaignModal";
import type { TestCampaignPlacement, TestDecision } from "./TestCampaignModal";
import styles from "./ProductionCampaignBadge.module.css";

const PLACEMENT = "opend.home.account-badge";
const MAX_LEASE_MS = 5 * 60_000;
const supportedCapabilities = new Set(["static-action"]);
type Decision = {
	activityId: string;
	authorizationExpiresAt: string;
	content: WebTouchpointContent;
	deploymentId: string;
	endsAt: string;
	placementKey: string;
	requiredCapabilities: string[];
	serverTime: string;
	staticActions: TouchpointStaticAction[];
	touchpointDecisionId: string;
};
type AuthorizedDecision = Decision & {
	authorizationDeadline: number;
	sessionSubject: string;
};

export function canRenderProductionCampaignBadge(
	authenticated: boolean,
	sessionSubject: string | null,
) {
	const host = getOpenDesignHost();
	return (
		authenticated &&
		Boolean(sessionSubject) &&
		host?.client.type === "desktop" &&
		Boolean(host.client.osLocale?.trim())
	);
}

/** Production account-badge host. Unlike modals, this placement never exposes close. */
export function ProductionCampaignBadge({
	authenticated,
	sessionSubject,
}: {
	authenticated: boolean;
	sessionSubject: string | null;
}) {
	const [decision, setDecision] = useState<AuthorizedDecision | null>(null);
	const testRuntime = useTestRuntime();
	const testDecision = testRuntime?.decisions.get(PLACEMENT);
	const decisionRef = useRef<AuthorizedDecision | null>(null);
	const containerRef = useRef<HTMLDivElement | null>(null);
	const expiry = useRef(0);
	const requestGeneration = useRef(0);
	const authorizationGeneration = useRef(0);
	const leaseGeneration = useRef(0);
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
			!canRenderProductionCampaignBadge(authenticated, sessionSubject) ||
			!sessionSubject
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
					PLACEMENT, locale, controller.signal, decisionRef.current?.touchpointDecisionId,
				);
				if (!current(nextRequestGeneration)) return;
				if (loaded.kind === "revoked") {
					const active = decisionRef.current;
					if (active && loaded.receipt.touchpointDecisionId === active.touchpointDecisionId && loaded.receipt.deploymentId === active.deploymentId && loaded.receipt.activityId === active.activityId && loaded.receipt.contentVersionId === active.content.id) clear();
					return;
				}
				if (loaded.kind === "no-decision") { if (!decisionRef.current) clear(); return; }
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
				if (!current(nextRequestGeneration) || (error instanceof DOMException && error.name === "AbortError")) return;
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
	}, [authenticated, sessionSubject, clear, testRuntime]);

	useEffect(() => {
		const container = containerRef.current;
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
			onError: () => clear(),
		});
		return () => {
			++authorizationGeneration.current;
			dispose();
		};
	}, [authenticated, decision, sessionSubject, clear]);

	const onTestVisible = useCallback(
		(next: TestDecision, placementKey: TestCampaignPlacement) => {
			if (testRuntime) recordVisibleTestTouchpoint(testRuntime, next, placementKey);
		},
		[testRuntime],
	);
	if (authenticated && testRuntime && testDecision) {
		return (
			<div className={styles.badge} data-testid="production-campaign-badge">
				<TestTouchpointMount
					decision={testDecision}
					placementKey={PLACEMENT}
					testId="production-campaign-badge-element"
					onVisible={onTestVisible}
				/>
			</div>
		);
	}
	return authenticated && decision?.sessionSubject === sessionSubject ? (
		<div
			className={styles.badge}
			ref={containerRef}
			data-testid="production-campaign-badge"
		/>
	) : null;
}
