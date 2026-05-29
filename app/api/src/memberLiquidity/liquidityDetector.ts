/**
 * Canonical home of the treasury-push action-type union.
 *
 * Historically this file housed `detectLiquidityOpportunities()`, the
 * cluster-data-driven detector that fed the treasury-push recommendation
 * surface. It was retired alongside the cluster rebalance v1 engine
 * (specs/2026-05-28-dormant-subsystems-removal.md, D2): the detector's
 * only caller was the deleted `rebalance/rebalanceScheduler.ts`, and its
 * input (`ClusterState[]`) came from the deleted `clusterState.ts`.
 *
 * The `MemberLiquidityActionType` union is preserved here because it is
 * the type shared by `liquidityAdvisor.ts` and `liquidityExecutor.ts`,
 * which together implement the operator-approved treasury-push execution
 * path. Keeping the type in its original module preserves the existing
 * import graph (advisor + executor both import from this file).
 */

export type MemberLiquidityActionType = "treasury_push_topup";
