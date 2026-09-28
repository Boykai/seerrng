export class InterventionError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}
