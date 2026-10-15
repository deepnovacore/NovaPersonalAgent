/**
 * Narrow port the personal-agent host uses to revoke device grants when a task is
 * stopped. Implementations must be idempotent; resolving means the revocation is durable.
 */
export interface StopRevoker { revokeForStop(taskId: string): Promise<void> }
