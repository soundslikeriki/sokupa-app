export type Snapshot = { parsed: import("../../types").ParsedMemoPayload; editorState: Record<string, unknown>; context: Record<string, unknown> };
export type Token = { generation: number; operationId: string };
export type Saved = { token: Token; revision: number; snapshot: Snapshot; updatedAt: string };
export type RecoveryResult = { status: string; code?: string; token?: Token; latest?: Saved | null; pending?: Token | null };
export function createLatestResultRecovery(input: { ownerId: string; storage: Pick<Storage,"getItem"|"setItem">; locks: { request(name: string, options: {mode: string}, callback: () => unknown): Promise<unknown> }; allowEmptySnapshots?: boolean; maxBytes?: number }): { key: string; restore(): Promise<RecoveryResult>; begin(id: string): Promise<RecoveryResult>; complete(token: Token, snapshot: Snapshot): Promise<RecoveryResult>; edit(token: Token, revision: number, snapshot: Snapshot): Promise<RecoveryResult>; fail(token: Token): Promise<RecoveryResult> };
