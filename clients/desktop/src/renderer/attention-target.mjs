/**
 * Where a tray click should land. The tray count is unread messages plus
 * pending approvals and confirmations, so approvals come first: they block a
 * task, an unread reply does not.
 */
export function attentionTarget(snapshot) {
  const pending = [...(snapshot?.pending_approvals ?? []), ...(snapshot?.pending_confirmations ?? [])]
  const decision = pending.find(item => item.task_id || item.conversation_id)
  if (decision?.task_id) return {taskId: decision.task_id}
  if (decision) return {conversationId: decision.conversation_id}
  const unread = (snapshot?.conversations?.items ?? []).find(item => item.unread_count > 0)
  if (unread) return {conversationId: unread.id}
  return null
}
