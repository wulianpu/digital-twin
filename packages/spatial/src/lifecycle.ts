/** Minimal lifecycle primitive shared across Foundation contracts. */
export interface Disposable {
  dispose(): void | Promise<void>
}
