/**
 * JSON schemas for every structured answer Kurultay asks for. Sent as
 * response_format = json_schema so servers with constrained decoding (vLLM
 * guided decoding, llama.cpp grammars, SGLang, LM Studio) can only produce
 * valid JSON – small local models stop returning broken plans and reviews.
 * Servers without support fall back to json_object automatically.
 */
export interface JsonSchemaSpec {
  name: string;
  schema: Record<string, unknown>;
}

const str = { type: 'string' };
const strArr = { type: 'array', items: str };

export const PLAN_SCHEMA: JsonSchemaSpec = {
  name: 'kurultay_plan',
  schema: {
    type: 'object',
    properties: {
      understanding: str,
      acceptance_criteria: strArr,
      subtasks: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          properties: { id: str, title: str, description: str, files: strArr, depends_on: strArr, critical: { type: 'boolean' }, skills: strArr },
          required: ['id', 'title', 'description'],
        },
      },
    },
    required: ['understanding', 'acceptance_criteria', 'subtasks'],
  },
};

export const REVIEW_SCHEMA: JsonSchemaSpec = {
  name: 'kurultay_review',
  schema: {
    type: 'object',
    properties: {
      ranking: strArr,
      scores: { type: 'object', additionalProperties: { type: 'number' } },
      issues: {
        type: 'object',
        additionalProperties: {
          type: 'array',
          items: { type: 'object', properties: { text: str, priority: { type: 'integer', minimum: 0, maximum: 3 }, confidence: { type: 'number' } }, required: ['text', 'priority'] },
        },
      },
    },
    required: ['ranking'],
  },
};

export const JUDGE_SCHEMA: JsonSchemaSpec = {
  name: 'kurultay_acceptance',
  schema: { type: 'object', properties: { complete: { type: 'boolean' }, missing: strArr }, required: ['complete', 'missing'] },
};

export const FILE_SUMMARY_SCHEMA: JsonSchemaSpec = {
  name: 'kurultay_file_summaries',
  schema: {
    type: 'object',
    properties: { files: { type: 'array', items: { type: 'object', properties: { path: str, summary: str, tags: strArr }, required: ['path', 'summary'] } } },
    required: ['files'],
  },
};

export const FLOWS_SCHEMA: JsonSchemaSpec = {
  name: 'kurultay_flows',
  schema: {
    type: 'object',
    properties: { flows: { type: 'array', items: { type: 'object', properties: { title: str, description: str, files: strArr, importance: str }, required: ['title', 'files'] } } },
    required: ['flows'],
  },
};

export const TOOLSHIM_SCHEMA: JsonSchemaSpec = {
  name: 'kurultay_tool_calls',
  schema: {
    type: 'object',
    properties: { calls: { type: 'array', items: { type: 'object', properties: { name: str, arguments: { type: 'object' } }, required: ['name', 'arguments'] } } },
    required: ['calls'],
  },
};
