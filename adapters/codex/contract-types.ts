// Output types of contracts schemas that contracts/ does not export as types yet (reported to the main
// session). Remove once contracts exports them.
import type { z } from 'zod';
import type {
  Attachment as AttachmentSchema,
  DeliveryEvidence as DeliveryEvidenceSchema,
  MessageOrigin as MessageOriginSchema,
  PermissionDecision as PermissionDecisionSchema,
  PermissionHold as PermissionHoldSchema,
  TokenCounts as TokenCountsSchema,
} from '../../contracts';

export type Attachment = z.infer<typeof AttachmentSchema>;
export type DeliveryEvidence = z.infer<typeof DeliveryEvidenceSchema>;
export type MessageOrigin = z.infer<typeof MessageOriginSchema>;
export type PermissionDecision = z.infer<typeof PermissionDecisionSchema>;
export type PermissionHold = z.infer<typeof PermissionHoldSchema>;
export type TokenCounts = z.infer<typeof TokenCountsSchema>;
