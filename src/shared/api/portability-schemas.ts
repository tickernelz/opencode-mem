import { z } from "zod";

export const PORTABILITY_SCHEMA_VERSION = 1 as const;

export const ExportedMemorySchema = z.object({
  id: z.string().min(1),
  content: z.string().min(1),
  type: z.string().optional(),
  tags: z.array(z.string()).optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative().optional(),
  isPinned: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  displayName: z.string().optional(),
  userName: z.string().optional(),
  userEmail: z.string().optional(),
  projectPath: z.string().optional(),
  projectName: z.string().optional(),
  gitRepoUrl: z.string().optional(),
});

export const MemoryExportDocumentSchema = z.object({
  schemaVersion: z.literal(PORTABILITY_SCHEMA_VERSION),
  exportedAt: z.string().min(1),
  plugin: z.object({
    package: z.string(),
    version: z.string(),
  }),
  source: z.object({
    containerTag: z.string().min(1),
    scope: z.literal("project"),
    scopeHash: z.string().regex(/^[a-f0-9]{16}$/),
    projectPath: z.string().optional(),
    projectName: z.string().optional(),
    gitRepoUrl: z.string().optional(),
  }),
  embedding: z.object({
    model: z.string(),
    dimensions: z.number().int().positive(),
  }),
  memories: z.array(ExportedMemorySchema),
});

export type ExportedMemory = z.infer<typeof ExportedMemorySchema>;
export type MemoryExportDocument = z.infer<typeof MemoryExportDocumentSchema>;
