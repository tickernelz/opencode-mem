import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "zod";

const docs = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/docs" }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    editUrl: z.string().optional(),
    lastUpdated: z.union([z.string(), z.date()]).optional(),
    sidebar: z
      .object({
        order: z.number(),
      })
      .optional(),
  }),
});

export const collections = { docs };
