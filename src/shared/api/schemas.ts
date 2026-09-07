import { z } from "zod";

/** Envelope used by all JSON API responses. */
export const ApiResultSchema = z.object({
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
  message: z.string().optional(),
});

export const TagInfoSchema = z.object({
  tag: z.string(),
  tags: z.array(z.string()).optional(),
  displayName: z.string().optional(),
  userName: z.string().optional(),
  userEmail: z.string().optional(),
  projectPath: z.string().optional(),
  projectName: z.string().optional(),
  gitRepoUrl: z.string().optional(),
});

export const MemoryItemSchema = z.object({
  id: z.string(),
  type: z.enum(["memory", "prompt"]),
  content: z.string(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  displayName: z.string().optional(),
  projectPath: z.string().optional(),
  projectName: z.string().optional(),
  gitRepoUrl: z.string().optional(),
  userName: z.string().optional(),
  userEmail: z.string().optional(),
  memoryType: z.string().optional(),
  tags: z.array(z.string()).optional(),
  isPinned: z.boolean().optional(),
  linkedPromptId: z.string().optional(),
  linkedMemoryId: z.string().optional(),
  sessionId: z.string().optional(),
  similarity: z.number().optional(),
  isContext: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const PaginatedMemoriesSchema = z.object({
  items: z.array(MemoryItemSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
  totalPages: z.number(),
});

export const ProfileItemSchema = z.object({
  category: z.string().optional(),
  description: z.string().optional(),
  confidence: z.number().optional(),
  frequency: z.number().optional(),
  evidence: z.union([z.array(z.string()), z.string()]).optional(),
  steps: z.array(z.string()).optional(),
});

export const ProfileDataSchema = z.object({
  preferences: z.array(ProfileItemSchema).optional(),
  patterns: z.array(ProfileItemSchema).optional(),
  workflows: z.array(ProfileItemSchema).optional(),
});

export const UserProfileSchema = z.object({
  exists: z.boolean(),
  message: z.string().optional(),
  id: z.string().optional(),
  userId: z.string().optional(),
  displayName: z.string().optional(),
  userName: z.string().optional(),
  userEmail: z.string().optional(),
  version: z.number().optional(),
  totalPromptsAnalyzed: z.number().optional(),
  lastAnalyzedAt: z.string().optional(),
  createdAt: z.string().optional(),
  profileData: ProfileDataSchema.optional(),
});

export const CleanupChangesSchema = z.object({
  merged: z
    .array(
      z.object({
        ids: z.array(z.string()),
        result: z.string().optional(),
      })
    )
    .optional(),
  removed: z
    .array(
      z.object({
        id: z.string(),
        reason: z.string(),
      })
    )
    .optional(),
  kept: z.array(z.string()).optional(),
});

export const PendingCleanupSchema = z.object({
  old: ProfileDataSchema.optional(),
  new: ProfileDataSchema.optional(),
  changes: CleanupChangesSchema,
});

export const AICleanupRequestSchema = z.object({
  userId: z.string().optional(),
  includeIds: z.array(z.string()).optional(),
  profileVersion: z.number().int().nonnegative().optional(),
});

export const ApplyCleanupRequestSchema = z.object({
  userId: z.string().optional(),
  profile: ProfileDataSchema.optional(),
  acceptedMerged: z.array(z.array(z.string())).optional(),
  acceptedRemoved: z.array(z.string()).optional(),
});

export const UpdateProfileItemRequestSchema = z.object({
  type: z.enum(["preferences", "patterns", "workflows"]),
  index: z.number().int().nonnegative(),
  action: z.enum(["edit", "delete"]),
  category: z.string().optional(),
  description: z.string().optional(),
  steps: z.array(z.string()).optional(),
});

export const AddMemoryRequestSchema = z.object({
  content: z.string().min(1),
  containerTag: z.string().min(1),
  type: z.string().optional(),
  tags: z.array(z.string()).optional(),
  displayName: z.string().optional(),
  userName: z.string().optional(),
  userEmail: z.string().optional(),
  projectPath: z.string().optional(),
  projectName: z.string().optional(),
  gitRepoUrl: z.string().optional(),
});

export const UpdateMemoryRequestSchema = z.object({
  content: z.string().optional(),
  type: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

export const BulkIdsRequestSchema = z.object({
  ids: z.array(z.string()).min(1),
  cascade: z.boolean().optional(),
});
