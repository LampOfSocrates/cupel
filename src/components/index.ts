// Shared components, build once (feature-spec.md:133-134): ConversationPicker
// (turn-expandable), RunConfigPanel (diff-from-baseline, optional judge
// section), ComparisonView (pluggable annotation), TaskQueue, RunsList.
export { ConversationPicker } from "./ConversationPicker";
export { RunConfigPanel } from "./RunConfigPanel";
export { ComparisonView, type CellContext } from "./ComparisonView";
export { TaskQueue, formatElapsed } from "./TaskQueue";
export { RunsList } from "./RunsList";
export { TreeNode, TreeBranch, type TreeNodeKind } from "./TreeNode";
export { EnvelopeChip, envelopeSummary } from "./EnvelopeChip";
export { ForkModal } from "./ForkModal";
export { ScoreChip, scoreColor } from "./ScoreChip";
export { JudgmentDrawer } from "./JudgmentDrawer";
// The one ⊞ picker behind every collect entry point (Chat's turn
// action row, the Inspector's reader).
export { CollectModal } from "./CollectModal";
export { STATUS_COLOR, type LifecycleStatus } from "./status";
// The machine-readable half of an ApiError — the fields it rejected and the
// correlation id a support ticket quotes.
export { ApiErrorNote, errorMessage } from "./ApiErrorNote";
