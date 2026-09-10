/**
 * Whether a secret row hides its input. A stored key renders as a badge with
 * 更换/清除 actions, because an empty password box beside a 已设置 badge reads
 * as "not configured"; 更换 reveals the input for that key only, and the
 * reveal is dropped once a save round-trip confirms the new value.
 */
export function secretRowCollapsed(present, revealed) {
  return present === true && revealed !== true
}
