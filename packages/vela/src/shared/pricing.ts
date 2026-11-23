/** Price in $ / 1M tokens (pi's `cost`); models get it from the built-in catalog or models.json. */
export interface ModelPricing {
  input: number // $ / 1M input tokens (cache miss)
  output: number // $ / 1M output tokens
  cacheWrite: number // $ / 1M tokens written to cache
  cacheRead: number // $ / 1M tokens read from cache (hit)
}
