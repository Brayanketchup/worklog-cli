/** Expected, user-facing failure. Rendered without a stack trace. */
export class WorklogError extends Error {
  constructor(
    message: string,
    /** Optional follow-up shown under the error, e.g. how to recover. */
    public readonly hint?: string,
  ) {
    super(message);
    this.name = 'WorklogError';
  }
}
