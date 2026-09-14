import { recordVisibleTestTouchpoint, useTestRuntime } from "./TestCampaignModal";
import { useI18n } from "../i18n";
import { useCallback } from "react";
import { getOpenDesignHost } from "@open-design/host";
import { emitWebTouchpointDiagnostic, supportsWebTouchpointCapabilities, type WebTouchpointContent } from "./touchpoint-component";
import { HoverTouchpointOverlay } from "./HoverTouchpointOverlay";
import { dispatchProductionCampaignAction } from "./ProductionCampaignModal";
import { touchpointStaticActionsMatch, type TouchpointStaticAction } from "./touchpoint-static-actions";
import { emitProductionTouchpointLoadDiagnostic, loadProductionTouchpointDecision } from "./production-touchpoint-loader";
import { resolveAuthorizationDeadline, type TouchpointLifecycleLoad, useTouchpointLifecycle } from "./touchpoint-lifecycle";
import type { TestCampaignPlacement, TestDecision } from "./TestCampaignModal";

const ENTRY_PLACEMENT = "opend.home.hover-entry";
const LAYER_PLACEMENT = "opend.home.hover-layer";
const MAX_LEASE_MS = 5 * 60_000;
const supportedCapabilities = new Set(["hover", "static-action"]);
type RuntimeDecision = Readonly<{ activityId: string; authorizationExpiresAt: string; touchpointDecisionId: string; deploymentId: string; endsAt: string; placementKey: string; serverTime: string; requiredCapabilities: string[]; content: WebTouchpointContent; staticActions: TouchpointStaticAction[] }>;
type ValidDecision = Readonly<{ decision: RuntimeDecision; actionIds: ReadonlySet<string> }>;
type ActiveHover = Readonly<{ entry: ValidDecision; layer: ValidDecision; sessionSubject: string }>;

function validDecision(value: unknown, placementKey: string): { valid: ValidDecision; validForMs: number } | null {
	if (!value || typeof value !== "object") return null;
	const decision = value as RuntimeDecision;
	const deadline = resolveAuthorizationDeadline(decision, MAX_LEASE_MS);
	if (!decision.activityId || !decision.touchpointDecisionId || !decision.deploymentId || !decision.content?.id || decision.placementKey !== placementKey || decision.content?.placementKey !== placementKey || deadline === null || !Number.isFinite(deadline)) return null;
	const placement = decision.content.manifest.placements.find((candidate) => candidate.key === placementKey);
	if (!placement || !supportsWebTouchpointCapabilities(decision.content, decision.requiredCapabilities, supportedCapabilities) || !touchpointStaticActionsMatch(decision.staticActions, placement.staticActions)) return null;
	return { valid: { decision, actionIds: new Set(placement.staticActions.map((action) => action.id)) }, validForMs: deadline - Date.parse(decision.serverTime) };
}

export function ProductionCampaignHover({ authenticated, sessionSubject }: { authenticated: boolean; sessionSubject: string | null }) {
	const testRuntime = useTestRuntime();
	const { locale } = useI18n();
	const testEntry = testRuntime?.decisions.get(ENTRY_PLACEMENT);
	const testLayer = testRuntime?.decisions.get(LAYER_PLACEMENT);
	const enabled = !testRuntime && authenticated && Boolean(sessionSubject) && getOpenDesignHost()?.client.type === "desktop" && Boolean(locale);
	const load = useCallback(async (signal: AbortSignal, active: ActiveHover | null): Promise<TouchpointLifecycleLoad<ActiveHover>> => {
		if (!locale || !sessionSubject) return { kind: "clear" };
		const [entryLoaded, layerLoaded] = await Promise.all([
			loadProductionTouchpointDecision(ENTRY_PLACEMENT, locale, signal, active?.entry.decision.touchpointDecisionId),
			loadProductionTouchpointDecision(LAYER_PLACEMENT, locale, signal, active?.layer.decision.touchpointDecisionId),
		]);
		const matches = (loaded: typeof entryLoaded, decision: RuntimeDecision | undefined) => loaded.kind === "revoked" && decision && loaded.receipt.touchpointDecisionId === decision.touchpointDecisionId && loaded.receipt.deploymentId === decision.deploymentId && loaded.receipt.activityId === decision.activityId && loaded.receipt.contentVersionId === decision.content.id;
		if (matches(entryLoaded, active?.entry.decision) || matches(layerLoaded, active?.layer.decision)) return { kind: "clear" };
		if (entryLoaded.kind === "revoked" || layerLoaded.kind === "revoked") return { kind: "retain" };
		if (entryLoaded.kind === "no-decision" || layerLoaded.kind === "no-decision") return active ? { kind: "retain" } : { kind: "clear" };
		if (entryLoaded.kind !== "decision" || layerLoaded.kind !== "decision") return { kind: "retain" };
		const entry = validDecision(entryLoaded.value, ENTRY_PLACEMENT);
		const layer = validDecision(layerLoaded.value, LAYER_PLACEMENT);
		if (!entry || !layer || entry.valid.decision.activityId !== layer.valid.decision.activityId || entry.valid.decision.deploymentId !== layer.valid.decision.deploymentId) return { kind: "clear" };
		return { kind: "decision", value: { entry: entry.valid, layer: layer.valid, sessionSubject }, key: `${entry.valid.decision.activityId}:${entry.valid.decision.deploymentId}:${entry.valid.decision.content.id}:${entry.valid.decision.touchpointDecisionId}:${layer.valid.decision.touchpointDecisionId}`, validForMs: Math.min(entry.validForMs, layer.validForMs) };
	}, [locale, sessionSubject]);
	const onError = useCallback((error: unknown) => {
		const diagnostic = emitProductionTouchpointLoadDiagnostic(error);
		if (diagnostic) emitWebTouchpointDiagnostic(diagnostic);
	}, []);
	const lifecycle = useTouchpointLifecycle({ enabled, identity: enabled ? JSON.stringify([sessionSubject, locale]) : null, load, onError });
	const active = lifecycle.current;
	const onTestVisible = useCallback((decision: TestDecision, placementKey: TestCampaignPlacement) => {
		if (testRuntime) recordVisibleTestTouchpoint(testRuntime, decision, placementKey);
	}, [testRuntime]);
	const onEntryVisible = useCallback(() => { if (testEntry) onTestVisible(testEntry, ENTRY_PLACEMENT); }, [onTestVisible, testEntry]);
	const onLayerVisible = useCallback(() => { if (testLayer) onTestVisible(testLayer, LAYER_PLACEMENT); }, [onTestVisible, testLayer]);
	const onDiagnostic = useCallback((code: string) => emitWebTouchpointDiagnostic({ code }), []);
	const dispatchEntryAction = useCallback((actionId: string) => {
		if (!active) return Promise.resolve();
		const generation = lifecycle.generation;
		return dispatchProductionCampaignAction(active.entry.decision, actionId, generation, () => lifecycle.isCurrent(generation) ? generation : -1, lifecycle.deadline).then(() => undefined);
	}, [active, lifecycle.generation, lifecycle.isCurrent]);
	const dispatchLayerAction = useCallback((actionId: string) => {
		if (!active) return Promise.resolve();
		const generation = lifecycle.generation;
		return dispatchProductionCampaignAction(active.layer.decision, actionId, generation, () => lifecycle.isCurrent(generation) ? generation : -1, lifecycle.deadline).then(() => undefined);
	}, [active, lifecycle.generation, lifecycle.isCurrent]);
	if (authenticated && testRuntime && testEntry && testLayer) return <HoverTouchpointOverlay entry={testEntry.content} layer={testLayer.content} isAuthorized={() => testRuntime.isAuthorized()} mode="test" onEntryVisible={onEntryVisible} onLayerVisible={onLayerVisible} onDiagnostic={onDiagnostic} />;
	return authenticated && active?.sessionSubject === sessionSubject ? <HoverTouchpointOverlay entry={active.entry.decision.content} layer={active.layer.decision.content} isAuthorized={() => lifecycle.isCurrent(lifecycle.generation)} entryActionIds={active.entry.actionIds} layerActionIds={active.layer.actionIds} onDiagnostic={onDiagnostic} dispatchEntryAction={dispatchEntryAction} dispatchLayerAction={dispatchLayerAction} /> : null;
}
