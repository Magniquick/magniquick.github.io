import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

// Blog posts live as markdown/mdx under src/content/blog.
// Zod schema = typed, validated frontmatter (build fails on a bad post).
const blog = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    tags: z.array(z.string()).default([]),
    draft: z.boolean().default(false),
  }),
});

export const collections = { blog };
