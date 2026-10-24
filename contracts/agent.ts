// Agent definitions and model selection.
import { z } from 'zod';
import { AgentId, Revision, Runtime, Timestamp } from './common';

/**
 * Reusable role definition (AG-01, AG-02, COM-01). Deliberately has no model / defaultModel field:
 * the schema is strict, so a stray `model` key is rejected (HC-01).
 */
export const AgentDefinition = z.strictObject({
  id: AgentId,
  revision: Revision,
  name: z.string().min(1),
  description: z.string(),
  instructions: z.string().min(1),
  updatedAt: Timestamp,
});
export type AgentDefinition = z.infer<typeof AgentDefinition>;

/** What the user asked for on a session or workflow node (R-12). */
export const ModelSelection = z.strictObject({
  runtime: Runtime,
  model: z.string().min(1),
  effort: z.string().min(1).optional(),
});
export type ModelSelection = z.infer<typeof ModelSelection>;

/**
 * What the runtime actually reported (R-12): Claude reports the model per assistant message;
 * Codex only reports the configured model (plus reroute notices), so the UI must not call it "actual".
 */
export const ObservedModel = z.discriminatedUnion('source', [
  z.strictObject({ source: z.literal('per-message'), model: z.string().min(1), observedAt: Timestamp }),
  z.strictObject({ source: z.literal('configured'), model: z.string().min(1), observedAt: Timestamp }),
  z.strictObject({ source: z.literal('rerouted'), from: z.string().min(1), to: z.string().min(1), reason: z.string(), observedAt: Timestamp }),
  z.strictObject({ source: z.literal('unknown') }),
]);
export type ObservedModel = z.infer<typeof ObservedModel>;

/** One entry of the model picker, filled from `supportedModels()` / `model/list` (R-12, HC-02). */
export const ModelOption = z.strictObject({
  runtime: Runtime,
  model: z.string().min(1),
  displayName: z.string().min(1),
  efforts: z.array(z.string().min(1)),
  defaultEffort: z.string().min(1).optional(),
});
export type ModelOption = z.infer<typeof ModelOption>;
