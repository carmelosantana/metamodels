import { z } from 'zod'
import type { ParamSpec, WorkflowTemplate } from '@metamodels/connectors'

const targetSchema = z.object({ node: z.string().min(1), input: z.string().min(1) })

/** Node graph in ComfyUI workflow-API form. Mirrors the connector's stored graph shape. */
export const graphSchema: z.ZodType<WorkflowTemplate['graph']> = z.record(
  z.object({ class_type: z.string().min(1), inputs: z.record(z.unknown()) }),
) as z.ZodType<WorkflowTemplate['graph']>

/** The operator's declared params. Identical in shape to the connector's ParamSpec union. */
export const paramSpecSchema: z.ZodType<ParamSpec> = z.discriminatedUnion('type', [
  z.object({ name: z.string().min(1), type: z.literal('text'), target: targetSchema }),
  z.object({ name: z.string().min(1), type: z.literal('seed'), targets: z.array(targetSchema).min(1) }),
  z.object({
    name: z.string().min(1), type: z.literal('number'), target: targetSchema,
    min: z.number().optional(), max: z.number().optional(),
  }),
  z.object({ name: z.string().min(1), type: z.literal('image'), target: targetSchema }),
]) as z.ZodType<ParamSpec>

/** The editor's working draft: the graph as pasted text plus the declared params and cost. */
export const templateDraftSchema = z.object({
  id: z.string().min(1),
  graphText: z.string(),
  params: z.array(paramSpecSchema),
  cost: z.number().nonnegative(),
})
export type TemplateDraft = z.infer<typeof templateDraftSchema>
