export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'ApiError';
  }
}
